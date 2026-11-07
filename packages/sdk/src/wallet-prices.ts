// Prices a wallet read needs beyond the dataset's oracle reads: market prices from recent trades, the feeds in `TOKEN_FEEDS`, and the
// markets of tokens off the allowlist. One cache for every wallet a client reads, since a price at a block is the same for all of them.

import { describeError, type Logger } from "./amp.ts"
import { LAST_2S_BLOCK, blockBefore, msBetweenBlocks, timestampOfBlock } from "./chain.ts"
import { answerToMicros, type LegRow, type PricedRow } from "./legs.ts"
import { MARKET_MAX_AGE_MS, heldAtChartPoints, marketPrice, type MarketPrice } from "./market.ts"
import { feedPrice, type FeedRound, type LatestPrices } from "./portfolio.ts"
import type { BalanceSnapshot } from "./reconcile.ts"
import { TOKEN_MARKET_RULES, tokenMarketPrice, type TokenActivity } from "./token-market.ts"
import { TOKENS, TOKEN_FEEDS, tokenByAddress } from "./tokens.ts"
import { settledThrough, type Cached, type Reorg } from "./wallet-state.ts"
import type { Source } from "./wallets.ts"

/** The market prices one set of facts can use, by `<asset>:<bucket>`, with a token off the list by its address, and whether every one it needs was read. */
export type MarketOn = { priced: ReadonlySet<string>; checked: boolean }

/** What two rules can both say. A price only one of them has would be a difference that isn't the rule. */
export function sharedMarket(a: MarketOn, b: MarketOn): MarketOn {
  const priced = new Set([...a.priced].filter((key) => b.priced.has(key)))
  return { priced, checked: a.checked && b.checked && priced.size === a.priced.size && priced.size === b.priced.size }
}

/** Rows that aren't a trade with a price of its own, so a market price is what would price them. */
export function unpricedMoves(rows: readonly LegRow[], priced: readonly PricedRow[]): { asset: string; block: number }[] {
  const swapped = new Set(priced.filter((p) => p.priced.source === "swap").map((p) => p.tx_hash))
  return rows.flatMap((row) => {
    const token = tokenByAddress(row.token)
    return !token || token.oracle || swapped.has(row.tx_hash) ? [] : [{ asset: token.asset, block: row.block_num }]
  })
}

/** A price for each block in a bucket, so a thousand transfers don't make a thousand queries. Always at or before the block. In 2 s blocks. */
export const MARKET_BUCKET_BLOCKS = 150
/** A current price moves on faster. */
export const MARKET_HEAD_BUCKET_BLOCKS = 30
/**
 * Each read asks about one bucket. A market read is a query, and buckets wanting the same feeds share one, though each still
 * costs the RPC its own calls. They run one at a time. What's left waits for the next refresh, and has no price until then.
 */
const MARKET_READS_PER_REFRESH = 20
export function bucketOf(block: number, slowSize = MARKET_BUCKET_BLOCKS): number {
  const size = block > LAST_2S_BLOCK ? slowSize * 10 : slowSize
  return block - (block % size)
}
const MARKET_ASSETS = TOKENS.filter((t) => !t.oracle).map((t) => t.asset)
export type MarketRead = { asset: string; bucket: number }
export const marketKey = ({ asset, bucket }: MarketRead) => `${asset}:${bucket}`
export type MarkRead = MarketRead & { block: number }
/** What's held at each point on a wallet's chart. */
export const chartReads = (address: string, rows: readonly LegRow[], opening: BalanceSnapshot | null): MarkRead[] => heldAtChartPoints(address, rows, opening).map(({ asset, block }) => ({ asset, block, bucket: bucketOf(block) }))

/** What the feeds answered for a chart's points, by `<asset>:<bucket>`. */
export type ChartRounds = { get(key: string): FeedRound | undefined }

/** Grouped by bucket, because one query covers every feed in one. Sorted, so buckets wanting the same feeds can tell. */
function assetsByBucket(reads: readonly MarketRead[]): Map<number, string[]> {
  const buckets = new Map<number, string[]>()
  for (const read of new Map(reads.map((read) => [marketKey(read), read])).values()) buckets.set(read.bucket, [...(buckets.get(read.bucket) ?? []), read.asset].sort())
  return buckets
}

/**
 * A feed's call can fail inside a query that worked, which looks just like a feed that can't answer there. So it's asked
 * again this long later, twice as long each time, and then left to the market, or one that can't would cost queries forever.
 */
const NO_ANSWER_WAIT_MS = 60_000
const NO_ANSWER_TRIES = 6

/** What a feed makes a chart point's token worth, with ETH's price at that point, or null when it has no usable answer there. */
export function feedMark(mark: MarkRead, rounds: ChartRounds, references: Cached["references"]): string | null {
  const round = rounds.get(marketKey(mark))
  return round ? feedPrice(mark.asset, round, answerToMicros(references.get(mark.block)?.ethUsd)) : null
}

/** What a wallet needs a current price for, of the tokens the dataset has no oracle reads for. */
export function assetsHeld({ rows, opening, closing, lastBalances }: Pick<Cached, "rows" | "opening" | "closing" | "lastBalances">): string[] {
  const moved = new Set(rows.map((r) => tokenByAddress(r.token)?.asset))
  return MARKET_ASSETS.filter((asset) => moved.has(asset) || [opening?.amounts[asset], closing?.amounts[asset], lastBalances[asset]?.amount].some((amount) => BigInt(amount ?? "0") > 0n))
}

/** A price at `through`, for what's held and has no price in `current`, and one for each movement a trade doesn't already price. */
export function marketWanted(wallet: Pick<Cached, "rows" | "opening" | "closing" | "lastBalances">, priced: readonly PricedRow[], through: number, current: LatestPrices) {
  const headBucket = bucketOf(through, MARKET_HEAD_BUCKET_BLOCKS)
  const unpriced = assetsHeld(wallet).filter((asset) => !current[asset])
  return { headBucket, unpriced, wanted: [...unpriced.map((asset) => ({ asset, bucket: headBucket })), ...unpricedMoves(wallet.rows, priced).map(({ asset, block }) => ({ asset, bucket: bucketOf(block) }))] }
}

/** The feeds' prices, given what ETH's worth. Each rule has its own ETH price, so this isn't part of a wallet's facts. */
export function feedPrices(rounds: Record<string, FeedRound>, prices: LatestPrices): LatestPrices {
  return Object.fromEntries(Object.entries(rounds).flatMap(([asset, round]) => {
    const micros = feedPrice(asset, round, prices.ETH?.micros ?? null)
    return micros ? [[asset, { micros, source: "oracle" as const, blockNum: round.blockNum }]] : []
  }))
}

/**
 * A cache that remembers when each entry was last used, so a long-lived server can let go of what no read has needed in a while.
 * Reading an entry counts as using it. Iterating doesn't, so copying one keeps what it has without keeping it alive.
 */
class UsedMap<K, V> {
  readonly #entries = new Map<K, { value: V; usedAt: number }>()
  readonly #now: () => number
  constructor(now: () => number) {
    this.#now = now
  }
  get(key: K): V | undefined {
    const entry = this.#entries.get(key)
    if (entry) entry.usedAt = this.#now()
    return entry?.value
  }
  has(key: K): boolean {
    const entry = this.#entries.get(key)
    if (entry) entry.usedAt = this.#now()
    return entry !== undefined
  }
  set(key: K, value: V): void {
    this.#entries.set(key, { value, usedAt: this.#now() })
  }
  delete(key: K): boolean {
    return this.#entries.delete(key)
  }
  keys(): IterableIterator<K> {
    return this.#entries.keys()
  }
  get size(): number {
    return this.#entries.size
  }
  *[Symbol.iterator](): IterableIterator<[K, V]> {
    for (const [key, { value }] of this.#entries) yield [key, value]
  }
  forgetUnusedSince(time: number): void {
    for (const [key, { usedAt }] of this.#entries) if (usedAt < time) this.#entries.delete(key)
  }
}

/**
 * `reorgs` is the client's list, which this only reads. `now` is only for letting go of prices nobody has used in a while.
 * Each read checks it didn't cross a reorg by `reorged`, which a rewind calls before anything else.
 */
export function createPriceCache(source: Source, logger: Logger, reorgs: readonly Reorg[], now: () => number) {
  /** How many reorgs have been told about. Prices are read outside a wallet's own read too, and one that crossed a reorg isn't kept. */
  let rewinds = 0

  /** Prices by `<asset>:<bucket>`, null when too little trading backs one. A failed read isn't in here, so it's tried again. */
  const market = new UsedMap<string, MarketPrice | null>(now)
  let marketReady: boolean | null = null
  /** Each asset's latest answer, shared by every wallet. A failed read isn't in here, so it's tried again. */
  const latestRounds = new Map<string, FeedRound>()
  /** What the feeds answered at each chart point's bucket. A failed read isn't in here, so it's tried again. */
  const chartRounds = new UsedMap<string, FeedRound>(now)
  /** Where a read worked and a feed gave no answer: how many times, and the chain's head at the last one. */
  const noAnswers = new UsedMap<string, { tries: number; atHead: number }>(now)
  /** Goes up whenever a price a response can use changes. */
  let priceRevision = 0
  /** Each token's trades, and the blocks they're known to be complete for. */
  const tokenReads = new Map<string, { from: number; through: number; activity: TokenActivity[] }>()
  const tokenPrices = new Map<string, number | null>()
  /** How far `token_trades` had got when last asked. */
  let tokensReached = -1

  /** The answers at `block`'s bucket, reading what's missing. A failure leaves those assets out, and it mustn't take the wallet down with it. */
  async function loadFeedRounds(assets: readonly string[], block: number): Promise<Record<string, FeedRound>> {
    if (!source.readFeedRounds) return {}
    const known = (asset: string) => latestRounds.get(asset)?.blockNum === block
    const withFeeds = assets.filter((asset) => TOKEN_FEEDS[asset])
    const missing = withFeeds.filter((asset) => !known(asset))
    if (missing.length > 0) {
      try {
        const startedAt = rewinds
        const rounds = (await source.readFeedRounds(missing, [block])).get(block) ?? {}
        if (startedAt === rewinds) for (const [asset, round] of Object.entries(rounds)) latestRounds.set(asset, round)
      } catch (error) {
        logger.warn(`Feed read failed: ${describeError(error)}`)
      }
    }
    return Object.fromEntries(withFeeds.filter(known).map((asset) => [asset, latestRounds.get(asset) as FeedRound]))
  }

  /** A feed that failed or was rejected says nothing about whether the token trades, so a price missing because of one isn't "no market". */
  const feedsLeftNoGap = (held: readonly string[], prices: LatestPrices) => !source.readFeedRounds || held.every((asset) => prices[asset] || !TOKEN_FEEDS[asset])

  /** A failed check is tried again next time. */
  async function canReadMarket(): Promise<boolean> {
    if (!source.readMarketTrades || !source.marketReady) return false
    try {
      marketReady ??= await source.marketReady()
    } catch (error) {
      logger.warn(`Market check failed: ${describeError(error)}`)
      return false
    }
    return marketReady
  }

  /** False when what's next has to wait: the read failed, or a reorg happened during it. */
  async function readMarket(read: MarketRead): Promise<boolean> {
    if (!source.readMarketTrades) return false
    try {
      const startedAt = rewinds
      const price = marketPrice(await source.readMarketTrades(read.asset, blockBefore(read.bucket, MARKET_MAX_AGE_MS), read.bucket), read.asset, read.bucket)
      if (startedAt !== rewinds) return false
      market.set(marketKey(read), price)
      priceRevision += 1
      return true
    } catch (error) {
      logger.warn(`Market read failed: ${describeError(error)}`)
      return false
    }
  }

  /** One query however many feeds and buckets. False when what's next has to wait: the read failed, or a reorg happened during it. */
  async function readChartRounds(assets: readonly string[], buckets: readonly number[], head: number): Promise<boolean> {
    if (!source.readFeedRounds) return false
    try {
      const startedAt = rewinds
      const rounds = await source.readFeedRounds(assets, buckets)
      if (startedAt !== rewinds) return false
      priceRevision += 1
      for (const bucket of buckets) for (const asset of assets) {
        const key = marketKey({ asset, bucket })
        const round = rounds.get(bucket)?.[asset]
        if (round) {
          chartRounds.set(key, round)
          noAnswers.delete(key)
        } else noAnswers.set(key, { tries: (noAnswers.get(key)?.tries ?? 0) + 1, atHead: head })
      }
      return true
    } catch (error) {
      logger.warn(`Feed read failed: ${describeError(error)}`)
      return false
    }
  }

  /** Whether this feed should be asked about this bucket at this head. */
  function isFeedDue(read: MarketRead, head: number): boolean {
    const key = marketKey(read)
    if (!source.readFeedRounds || !TOKEN_FEEDS[read.asset] || chartRounds.has(key)) return false
    const last = noAnswers.get(key)
    return !last || (last.tries < NO_ANSWER_TRIES && msBetweenBlocks(last.atHead, head) >= NO_ANSWER_WAIT_MS * 2 ** (last.tries - 1))
  }

  /**
   * The answers at a fixed block's bucket, reading what's due. They're kept by bucket because a wallet at the head moves the latest
   * answers along, and a feed that gives none is asked like a chart point's, since no new block will change the question.
   */
  async function loadFixedFeedRounds(assets: readonly string[], bucket: number, head: number): Promise<Record<string, FeedRound>> {
    const due = assets.filter((asset) => isFeedDue({ asset, bucket }, head))
    if (due.length > 0) await readChartRounds(due, [bucket], head)
    return fixedFeedRounds(assets, bucket)
  }

  const fixedFeedRounds = (assets: readonly string[], bucket: number): Record<string, FeedRound> =>
    Object.fromEntries(assets.flatMap((asset) => {
      const round = chartRounds.get(marketKey({ asset, bucket }))
      return round ? [[asset, round]] : []
    }))

  /**
   * Reads what's missing, `wanted` first, and says whether all of `wanted` is now known. `chart` only gets the reads left
   * over, and waiting for them doesn't count against what's known, because all that's missing without them is chart points.
   * A chart point asks its feed first, like what's held now, and only needs the market when that gives no price. Asking a
   * feed again comes last, so a feed that isn't answering can't hold up the rest of the chart.
   */
  async function loadMarket(wanted: readonly MarketRead[], chart?: { reads: readonly MarkRead[]; references: Cached["references"]; head: number }): Promise<boolean> {
    const startedAt = rewinds
    const usable = await canReadMarket()
    let left = MARKET_READS_PER_REFRESH
    // A source that's down stops being asked until the next refresh, and the other can still price what it's asked about.
    let marketUp = usable
    let feedsUp = true
    const readMissingMarket = async (read: MarketRead) => {
      if (left === 0 || !marketUp || market.has(marketKey(read))) return
      left -= 1
      marketUp = await readMarket(read)
    }
    for (const read of wanted) await readMissingMarket(read)
    if (chart) {
      const { reads, references, head } = chart
      /** These feeds at every waiting bucket that wants the same ones, newest first, as far as the limit goes. */
      const readFeeds = async (waiting: Map<number, string[]>, assets: readonly string[]) => {
        if (left === 0 || !feedsUp) return
        const buckets = [...waiting].filter(([, wants]) => wants.join() === assets.join()).slice(0, left).map(([bucket]) => bucket)
        for (const bucket of buckets) waiting.delete(bucket)
        left -= buckets.length
        feedsUp = await readChartRounds(assets, buckets, head)
      }
      const due = reads.filter((read) => isFeedDue(read, head))
      const unasked = assetsByBucket(due.filter((read) => !noAnswers.has(marketKey(read))))
      const askAgain = assetsByBucket(due.filter((read) => noAnswers.has(marketKey(read))))
      for (const read of reads) {
        const feeds = unasked.get(read.bucket)
        if (feeds) await readFeeds(unasked, feeds)
        if (!feedMark(read, chartRounds, references)) await readMissingMarket(read)
      }
      for (const assets of askAgain.values()) await readFeeds(askAgain, assets)
    }
    return usable && startedAt === rewinds && wanted.every((w) => market.has(marketKey(w)))
  }

  /**
   * The blocks a token's price at `block` rests on: its bucket's whole lookback, up to the bucket's start, where it's worked out. A read's
   * rows are grouped by these buckets, so starting at one's first block means it's never part of a group, whichever read it's in.
   */
  function tokenPriceBlocks(block: number): { from: number; to: number } {
    const to = bucketOf(block)
    return { from: bucketOf(blockBefore(to, TOKEN_MARKET_RULES.windowMs) - 1) + 1, to }
  }

  const hasTokenPriceBlocks = (token: string, { from, to }: { from: number; to: number }) => {
    const read = tokenReads.get(token)
    return read !== undefined && read.from <= from && read.through >= to
  }

  /** Where this wallet moved an unlisted token in a transaction that also moved a listed one, which is where a token's price can be used. */
  function tokenPriceRows(address: string, rows: readonly LegRow[]): LegRow[] {
    const listedTxs = new Set(rows.filter((row) => row.account === address && row.kind !== "unlisted" && row.kind !== "unlisted_nft" && !row.kind.includes("gas") && row.kind !== "l1_fee").map((row) => row.tx_hash))
    return rows.filter((row) => row.account === address && row.kind === "unlisted" && listedTxs.has(row.tx_hash))
  }

  /** What's still needed to price every token in `tokenPriceRows`, once per bucket. */
  function unreadTokenPrices(address: string, rows: readonly LegRow[]): { token: string; from: number; to: number }[] {
    if (!source.readTokenActivity || !source.tokenActivityThrough) return []
    const unread = new Map<string, { token: string; from: number; to: number }>()
    for (const row of tokenPriceRows(address, rows)) {
      const blocks = tokenPriceBlocks(row.block_num)
      if (!hasTokenPriceBlocks(row.token, blocks)) unread.set(`${row.token}:${blocks.to}`, { token: row.token, ...blocks })
    }
    return [...unread.values()]
  }

  /**
   * The newest block `token_trades` can be believed for. It's replaying a reorg's blocks until it's well past the old chain's tip, and
   * until then what it has from there on could be what was replaced, even if it says it's got that far.
   */
  function tokensBelievedThrough(reached: number): number {
    const replaying = reorgs.filter(({ oldTip }) => settledThrough(reached) < oldTip)
    return Math.min(reached, ...replaying.map(({ from }) => from - 1))
  }

  /**
   * Trades of the tokens this wallet needs a price for, kept per token. Only what `token_trades` has processed counts as read, so a price
   * that needs more waits until it has, with no price until then. One failed read does the same, like any other price that can't be read.
   */
  async function loadTokenActivity(address: string, rows: readonly LegRow[], head: number): Promise<void> {
    const { readTokenActivity, tokenActivityThrough } = source
    const unread = unreadTokenPrices(address, rows)
    if (!readTokenActivity || !tokenActivityThrough || unread.length === 0) return
    const startedAt = rewinds
    try {
      const reached = await tokenActivityThrough(unread.reduce((first, { to }) => Math.min(first, to), Number.POSITIVE_INFINITY), head)
      if (reached === null || startedAt !== rewinds) return
      tokensReached = Math.max(tokensReached, reached)
      const believed = tokensBelievedThrough(reached)
      const wanted = new Set<string>()
      let from = Number.POSITIVE_INFINITY
      let to = Number.NEGATIVE_INFINITY
      for (const need of unread) {
        if (need.to > believed) continue
        const known = tokenReads.get(need.token)
        wanted.add(need.token)
        // What's been read goes with it: a token's rows get replaced whole, so an earlier block keeps its price.
        from = Math.min(from, need.from, known?.from ?? need.from)
        to = Math.max(to, need.to, Math.min(known?.through ?? need.to, bucketOf(believed)))
      }
      if (wanted.size === 0) return
      const activity = await readTokenActivity([...wanted], from, to)
      if (startedAt !== rewinds) return
      for (const token of wanted) tokenReads.set(token, { from, through: to, activity: [] })
      for (const row of activity) tokenReads.get(row.token)?.activity.push(row)
      tokenPrices.clear()
      priceRevision += 1
    } catch (error) {
      logger.warn(`Token market read failed: ${describeError(error)}`)
    }
  }

  /** A token's price at this block, once per bucket, or null when it has no market or not all of what its price rests on has been read. */
  function tokenPriceAt(token: string, block: number, timestamp: string): number | null {
    const blocks = tokenPriceBlocks(block)
    if (!hasTokenPriceBlocks(token, blocks)) return null
    const key = `${token}:${blocks.to}`
    const known = tokenPrices.get(key)
    if (known !== undefined) return known
    // At the bucket's start, so no block in it is priced by what came after it, and in whole seconds like the trades, so it's the same whichever block asks first.
    // Only its own blocks, by block: a read can go further than this price needs, and past the 200 ms upgrade, a later block can have the same timestamp.
    const activity = tokenReads.get(token)?.activity.filter(({ bin }) => bin >= blocks.from && bin <= blocks.to) ?? []
    const { usdPerRaw } = tokenMarketPrice(activity, Date.parse(timestampOfBlock(blocks.to, { blockNum: block, timestamp })))
    const price = usdPerRaw ?? null
    tokenPrices.set(key, price)
    return price
  }

  /** A price's trades all come before its bucket's start, so only reads that reached a reorg's blocks go, and what's left of them gets read again. */
  function forgetTokenTradesFrom(block: number) {
    for (const [token, read] of tokenReads) if (read.through >= block) tokenReads.delete(token)
    tokenPrices.clear()
  }

  /** Whether a read could still add a price this wallet needs. A failed read or the limit leaves some for the next refresh. */
  function hasMarketReadsLeft(address: string, wallet: Cached, head: number): boolean {
    const usable = source.readMarketTrades !== undefined && source.marketReady !== undefined && marketReady !== false
    const unread = (read: MarketRead) => usable && !market.has(marketKey(read))
    const { wanted } = marketWanted(wallet, wallet.priced, Math.min(wallet.coveredTo, wallet.latest.blockNum), wallet.prices)
    const bucket = bucketOf(wallet.latest.blockNum, MARKET_HEAD_BUCKET_BLOCKS)
    return wanted.some(unread) || assetsHeld(wallet).some((asset) => isFeedDue({ asset, bucket }, head)) || chartReads(address, wallet.rows, wallet.opening).some((read) => isFeedDue(read, head) || (!feedMark(read, chartRounds, wallet.references) && unread(read)))
  }

  /** Whether a feed's kept answer says more than this wallet's current prices do: a chart point or another wallet can read one after this wallet worked out its prices. */
  function hasNewerFeedPrices(wallet: Cached): boolean {
    const rounds = fixedFeedRounds(assetsHeld(wallet), bucketOf(wallet.latest.blockNum, MARKET_HEAD_BUCKET_BLOCKS))
    return Object.entries(feedPrices(rounds, wallet.prices)).some(([asset, price]) => wallet.prices[asset]?.micros !== price?.micros || wallet.prices[asset]?.source !== price?.source)
  }

  /** Prices from a reorg's blocks may be from what it replaced. The trades behind one all come before its bucket's end. */
  function forgetPricesFrom(block: number) {
    priceRevision += 1
    for (const key of market.keys()) if (Number(key.split(":")[1]) >= block) market.delete(key)
    for (const [asset, round] of latestRounds) if (round.blockNum >= block) latestRounds.delete(asset)
    for (const answers of [chartRounds, noAnswers]) for (const key of answers.keys()) if (Number(key.split(":")[1]) >= block) answers.delete(key)
  }

  /** These prices for the end of `through`. An asset without one has no current price, rather than a later one. */
  function marketPricesAt(through: number, { priced }: MarketOn): LatestPrices {
    const bucket = bucketOf(through, MARKET_HEAD_BUCKET_BLOCKS)
    return Object.fromEntries(MARKET_ASSETS.flatMap((asset) => {
      const key = `${asset}:${bucket}`
      const price = priced.has(key) ? market.get(key) : null
      return price ? [[asset, { micros: price.usdMicros, source: "market" as const, blockNum: price.blockNum }]] : []
    }))
  }

  return {
    /** Goes up whenever a price a response can use changes. */
    get revision() {
      return priceRevision
    },
    /** How far `token_trades` had got when last asked. */
    get tokensReached() {
      return tokensReached
    },
    /** A reorg was reported, so a read that started before it isn't kept. */
    reorged() {
      rewinds += 1
    },
    /** The market price at `<asset>:<bucket>`: undefined when it hasn't been read, null when too little trading backs one. */
    marketAt: (key: string) => market.get(key),
    /** What the feeds have answered for chart points so far, as a copy, so what two rules mark a token at can only differ by their ETH. */
    chartRoundsNow: (): ChartRounds => new Map(chartRounds),
    /** The same, kept up to date. */
    chartRounds: chartRounds as ChartRounds,
    loadFeedRounds,
    loadFixedFeedRounds,
    feedsLeftNoGap,
    loadMarket,
    loadTokenActivity,
    tokenPriceAt,
    tokenPriceRows,
    unreadTokenPrices,
    hasMarketReadsLeft,
    hasNewerFeedPrices,
    forgetPricesFrom,
    forgetTokenTradesFrom,
    marketPricesAt,
    /** Lets go of prices and feed answers no read has used since `time`. A read that needs one again reads it again. */
    forgetUnusedSince(time: number) {
      for (const cache of [market, chartRounds, noAnswers]) cache.forgetUnusedSince(time)
    },
  }
}
