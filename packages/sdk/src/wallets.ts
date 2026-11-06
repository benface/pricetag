// Reads what a wallet is: its legs, what it held before them, what the chain says it holds now, and its L1 fees.
// Keeps each wallet's rows in memory: one full read, then only new blocks, because a wallet read scans the whole range.

import { describeError, type Logger } from "./amp.ts"
import { LAST_2S_BLOCK, blockBefore, msBetweenBlocks, timestampOfBlock } from "./chain.ts"
import { answerToMicros, buildPricedLegs, creditUnseenEth, derivePricedRows, isUnwrapClaim, oneWaySendBalanceBlocks, payerOf, settleUnwraps, unseenEthSearchBlocks, unwrapBalanceBlocks, type EthPayer, type GasUnknownTx, type LegRow, type PayoutTx, type PricedRow, type Reference } from "./legs.ts"
import { MARKET_MAX_AGE_MS, markNeeds, marketPrice, type MarketMarks, type MarketPrice, type MarketTrade } from "./market.ts"
import type { CostNote } from "./notes.ts"
import { feedPrice, foldPositions, latestPrices, type FeedRound, type Head, type LatestPrices } from "./portfolio.ts"
import type { ReadL1Fees } from "./receipts.ts"
import { openingLegs, type BalanceSnapshot } from "./reconcile.ts"
import { ASSETS, TOKENS, TOKEN_FEEDS, tokenByAddress } from "./tokens.ts"
import type { Mode, UnlistedToken, WalletData } from "./wallet.ts"

export type WindowRows = { rows: LegRow[]; priced: PricedRow[] | null; gasUnknown: GasUnknownTx[] }

/** Where a wallet's rows come from. Everything after this doesn't care which one it was. */
export type Source = {
  mode: Mode
  /** The first block a wallet's history can start from, or null to count back from the head. */
  startBlock: number | null
  /** Where counting back from the head lands. */
  historyFrom: ((head: number) => number) | null
  head(after: number | null): Promise<Head | null>
  /**
   * The newest block, in `after`..`head`, that every table a wallet read needs has processed, or null if none has.
   * Reads never go past this. A derived table can lag the chain, and a block read before it's processed looks empty.
   */
  processedThrough(after: number, head: number): Promise<number | null>
  readWindow(address: string, from: number, to: number): Promise<WindowRows>
  readReferences(blocks: readonly number[]): Promise<Reference[]>
  /** The newest oracle read at or just before `head`, or null if there's none recent enough to call current. */
  readLatestReference(head: number): Promise<Reference | null>
  /** What the chain says this wallet holds at `block`, or null when the read gave nothing usable. */
  readBalances(address: string, block: number): Promise<BalanceSnapshot | null>
  /** This wallet's plain ETH at the end of each block, not counting WETH. A block whose read failed isn't in it. */
  readEthBalances(address: string, blocks: readonly number[]): Promise<Map<number, string>>
  /** The successful transactions in these blocks that name this wallet in their calldata, or that it sent. */
  readPayoutTxs?(address: string, blocks: readonly number[]): Promise<PayoutTx[]>
  /** The cost notes this wallet published in these blocks: zero-value transactions from itself to itself. */
  readNotes?(address: string, blocks: readonly number[]): Promise<CostNote[]>
  /** Whether `readMarketTrades` can be trusted. An older dataset's `priced_legs` has wrong rows, so it can't. */
  marketReady?(): Promise<boolean>
  /** An asset's latest trades in a block range, newest first. Only a dataset's `priced_legs` has them. */
  readMarketTrades?(asset: string, from: number, to: number): Promise<MarketTrade[]>
  /** What these assets' `TOKEN_FEEDS` answer at `block`. A feed whose read failed isn't in it. */
  readFeedRounds?(assets: readonly string[], block: number): Promise<Record<string, FeedRound>>
}

/** Blocks to read, inclusive, where the source's defaults aren't wanted. `to` reads the wallet as of that block. */
export type WalletRange = { from?: number | undefined; to?: number | undefined }

/** Re-read this much of the chain on each refresh, so a reorg near the tip replaces what it changed. */
const REORG_MS = 60_000
/** The newest block past any reorg, seen from `tip`. */
export const settledThrough = (tip: number) => blockBefore(tip, REORG_MS)
const MAX_WALLETS = 20
/** A busy wallet catches up over a few refreshes, and until then the swaps left say they aren't confirmed. */
const MAX_ETH_BALANCES_PER_READ = 400
/** Each block costs a scan of its transactions' calldata, so a wallet with many of these learns who to ask about them over a few refreshes. */
const MAX_PAYER_BLOCKS_PER_READ = 40

type Cached = {
  fromBlock: number
  coveredTo: number
  rows: LegRow[]
  priced: PricedRow[]
  references: Map<number, Reference>
  prices: LatestPrices
  latest: Head
  /** Transactions whose gas couldn't be worked out, with their blocks, as the last read of each block says. */
  gasUnknown: Map<string, number>
  /** Before `fromBlock`. Fixed once its block is past any reorg, which `openingReadAt` says. */
  opening: BalanceSnapshot | null
  /** The chain's head at each asset's last successful read. Reads can fail for one asset, so `opening` can come from several. */
  openingReadAt: Record<string, number>
  /** The chain's head at the last refresh, which a wallet read as of a fixed block can't tell from `latest`. */
  readAtHead: number
  /**
   * How far the tables had got, which is `coveredTo` unless this is a wallet read as of a fixed block. Its coverage stops
   * there, and the chain's head can't speak for tables still serving a reorg's old blocks, so this is what says they've moved on.
   */
  tablesReached: number
  /** At `coveredTo`, the same block the rows reach, or the check would fail whenever a dataset is slightly behind. */
  closing: BalanceSnapshot | null
  /** Every asset's last successful read, because a failed read mustn't look like an empty wallet. */
  lastBalances: Record<string, { blockNum: number; amount: string }>
  /** The last ETH balance read with everything up to it known, every fee and claim. */
  lastCheckableEth: { blockNum: number; amount: string } | null
  /** L1 fees by transaction. See `isL1FeeSettled`. */
  l1Fees: Map<string, L1Fee>
  notes: CostNote[]
  /** Blocks already checked for notes, so each is only read once it's past the part of the chain re-read for reorgs. */
  notesReadTo: number
  /** Market prices were all read this time, and no token's price is missing because of its feed. */
  marketChecked: boolean
  /** Transactions whose fee is older than the balance read of their block. See `isL1FeeCurrent`. */
  staleFeeTxs: string[]
  /** Plain ETH at the end of the blocks `settleUnwraps` reads, when they've been worth reading. */
  ethBalances: Map<number, string>
  /** Who's behind ETH that arrived with no row, by block. Null when no transaction can be named. A block whose read failed isn't in it. */
  ethPayers: Map<number, EthPayer | null>
}

/** What the wallet holds off the allowlist. An ID or an unreadable amount can't be netted, so those count as held. */
export function unlistedTokens(rows: readonly LegRow[], account: string): UnlistedToken[] {
  const tokens = new Map<string, { net: bigint; transfers: number; unreadable: boolean }>()
  for (const row of rows) {
    if (row.account !== account || (row.kind !== "unlisted" && row.kind !== "unlisted_nft")) continue
    const token = tokens.get(row.token) ?? { net: 0n, transfers: 0, unreadable: false }
    token.transfers += 1
    if (row.kind === "unlisted_nft") token.unreadable = true
    else if (/^\d+$/.test(row.amount)) token.net += row.side === "credit" ? BigInt(row.amount) : -BigInt(row.amount)
    else token.unreadable = true
    tokens.set(row.token, token)
  }
  return [...tokens].filter(([, { net, unreadable }]) => net > 0n || unreadable).map(([token, { transfers }]) => ({ token, transfers }))
}

type L1Fee = { blockNum: number; fee: string; readAtTip: number }

/**
 * A reorg, and the old chain's tip, which the tables have to get well past before a read is sure to have what replaced it.
 * Saying a reorg happened doesn't mean the tables have rewritten those blocks, and until they do a read gets the old ones
 * back, looking like any other read. A table builds on what's before it, so one past that tip has rewritten everything behind it.
 */
type Reorg = { from: number; oldTip: number }

/**
 * What happened to a wallet up to one block, without what any of it was worth. Two pricing rules read through the same
 * facts can only differ by the rule, because what's held, what moved and what fees came to are all the same object.
 */
export type WalletFacts = Pick<Cached, "fromBlock" | "coveredTo" | "rows" | "latest" | "gasUnknown" | "opening" | "closing" | "lastBalances" | "lastCheckableEth" | "l1Fees" | "staleFeeTxs" | "ethBalances" | "ethPayers" | "notes" | "notesReadTo" | "marketChecked"> & {
  /** What the feeds in `TOKEN_FEEDS` answered at or just before `coveredTo`, which is the chain's whatever rule prices the rest. */
  feedRounds: Record<string, FeedRound>
  /** What the feeds answered for its chart so far, so what two rules mark a token at can only differ by their ETH. */
  markRounds: MarkRounds
}

/** The market prices one set of facts can use, by `<asset>:<bucket>`, and whether every one it needs was read. */
export type MarketOn = { priced: ReadonlySet<string>; checked: boolean }

/** What two rules can both say. A price only one of them has would be a difference that isn't the rule. */
export function sharedMarket(a: MarketOn, b: MarketOn): MarketOn {
  const priced = new Set([...a.priced].filter((key) => b.priced.has(key)))
  return { priced, checked: a.checked && b.checked && priced.size === a.priced.size && priced.size === b.priced.size }
}

/** Everything about a row but its price. A transaction that moved to another block isn't the same fact, even with the same amounts. */
const rowKey = (r: LegRow) => `${r.block_num}:${r.timestamp}:${r.tx_index}:${r.tx_hash}:${r.log_index}:${r.account}:${r.side}:${r.kind}:${r.token}:${r.amount}`
const rowKeys = (rows: readonly LegRow[]) => rows.map(rowKey).sort().join()

/**
 * A reorg can keep a transaction at the same height and still change its fee, because the block's L1 inputs changed.
 * So a fee is read when it's first seen, then once more when its block has left the part of the chain that's re-read
 * for reorgs. A transaction that moved to another block is read again straight away. `tip` is what that part of the
 * chain is measured from: see `tipOf`.
 */
function isL1FeeSettled(fee: L1Fee | undefined, blockNum: number, tip: number): boolean {
  if (fee?.blockNum !== blockNum) return false
  return blockNum <= settledThrough(fee.readAtTip) || blockNum > settledThrough(tip)
}

/**
 * Whether a fee can explain a block's balance. Inside the part of the chain that's re-read, the balance is read again each
 * time, so a fee read earlier could be from before a reorg, and that difference would pass for ETH that never arrived.
 */
function isL1FeeCurrent(fee: L1Fee | undefined, blockNum: number, tip: number): boolean {
  if (fee?.blockNum !== blockNum) return false
  return fee.readAtTip === tip || blockNum <= settledThrough(fee.readAtTip)
}

const isComplete = (snapshot: BalanceSnapshot | null) => snapshot !== null && ASSETS.every((asset) => snapshot.amounts[asset] !== undefined)

/** A read can fail for one asset and work for the rest. What it didn't get stays as it was known. */
function mergeOpening(known: BalanceSnapshot | null, read: BalanceSnapshot | null): BalanceSnapshot | null {
  if (!read) return known
  return { blockNum: read.blockNum, amounts: { ...known?.amounts, ...read.amounts } }
}

/** Rows that aren't a trade with a price of its own, so a market price is what would price them. */
export function marketNeeds(rows: readonly LegRow[], priced: readonly PricedRow[]): { asset: string; block: number }[] {
  const swapped = new Set(priced.filter((p) => p.priced.source === "swap").map((p) => p.tx_hash))
  return rows.flatMap((row) => {
    const token = tokenByAddress(row.token)
    return !token || token.oracle || swapped.has(row.tx_hash) ? [] : [{ asset: token.asset, block: row.block_num }]
  })
}

/** A price for each block in a bucket, so a thousand transfers don't make a thousand queries. Always at or before the block. In 2 s blocks. */
const MARKET_BUCKET_BLOCKS = 150
/** A current price moves on faster. */
const MARKET_HEAD_BUCKET_BLOCKS = 30
/** Each read is a query, and they run one at a time. What's left waits for the next refresh, and has no price until then. */
const MARKET_READS_PER_REFRESH = 20
function bucketOf(block: number, slowSize = MARKET_BUCKET_BLOCKS): number {
  const size = block > LAST_2S_BLOCK ? slowSize * 10 : slowSize
  return block - (block % size)
}
const MARKET_ASSETS = TOKENS.filter((t) => !t.oracle).map((t) => t.asset)
type MarketRead = { asset: string; bucket: number }
const marketKey = ({ asset, bucket }: MarketRead) => `${asset}:${bucket}`
type MarkRead = MarketRead & { block: number }
/** What's held at each point on a wallet's chart. */
const chartReads = (address: string, rows: readonly LegRow[], opening: BalanceSnapshot | null): MarkRead[] => markNeeds(address, rows, opening).map(({ asset, block }) => ({ asset, block, bucket: bucketOf(block) }))

/** By `<asset>:<bucket>`. */
type MarkRounds = ReadonlyMap<string, FeedRound>

/** Grouped by bucket, because one query covers every feed in one. */
function assetsByBucket(reads: readonly MarketRead[]): Map<number, string[]> {
  const buckets = new Map<number, string[]>()
  for (const read of new Map(reads.map((read) => [marketKey(read), read])).values()) buckets.set(read.bucket, [...(buckets.get(read.bucket) ?? []), read.asset])
  return buckets
}

/**
 * A feed's call can fail inside a query that worked, which looks just like a feed that can't answer there. So it's asked
 * again this long later, twice as long each time, and then left to the market, or one that can't would cost queries forever.
 */
const NO_ANSWER_WAIT_MS = 60_000
const NO_ANSWER_TRIES = 6

/** What a feed makes a chart point's token worth, with ETH's price at that point, or null when it has no usable answer there. */
function feedMark(mark: MarkRead, rounds: MarkRounds, references: Cached["references"]): string | null {
  const round = rounds.get(marketKey(mark))
  return round ? feedPrice(mark.asset, round, answerToMicros(references.get(mark.block)?.ethUsd)) : null
}

/** What a wallet needs a current price for, of the tokens the dataset has no oracle reads for. */
function assetsHeld({ rows, opening, closing, lastBalances }: Pick<Cached, "rows" | "opening" | "closing" | "lastBalances">): string[] {
  return MARKET_ASSETS.filter((asset) => rows.some((r) => tokenByAddress(r.token)?.asset === asset) || [opening?.amounts[asset], closing?.amounts[asset], lastBalances[asset]?.amount].some((amount) => BigInt(amount ?? "0") > 0n))
}

/** A price at `through`, for what's held and has no price in `current`, and one for each movement a trade doesn't already price. */
function marketWanted(wallet: Pick<Cached, "rows" | "opening" | "closing" | "lastBalances">, priced: readonly PricedRow[], through: number, current: LatestPrices) {
  const headBucket = bucketOf(through, MARKET_HEAD_BUCKET_BLOCKS)
  const unpriced = assetsHeld(wallet).filter((asset) => !current[asset])
  return { headBucket, unpriced, wanted: [...unpriced.map((asset) => ({ asset, bucket: headBucket })), ...marketNeeds(wallet.rows, priced).map(({ asset, block }) => ({ asset, bucket: bucketOf(block) }))] }
}

/** The feeds' prices, given what ETH's worth. Each rule has its own ETH price, so this isn't part of a wallet's facts. */
export function feedPrices(rounds: Record<string, FeedRound>, prices: LatestPrices): LatestPrices {
  return Object.fromEntries(Object.entries(rounds).flatMap(([asset, round]) => {
    const micros = feedPrice(asset, round, prices.ETH?.micros ?? null)
    return micros ? [[asset, { micros, source: "oracle" as const, blockNum: round.blockNum }]] : []
  }))
}

/** Whether a reorg could have changed any opening balance since it was read. */
function openingMayChange(wallet: Cached | undefined, chain: Head): boolean {
  if (!wallet) return false
  return Object.values(wallet.openingReadAt).some((readAt) => chain.blockNum > readAt && wallet.fromBlock - 1 > settledThrough(readAt))
}

/**
 * Whether a wallet read as of a fixed block could have changed since its last refresh. It could until a refresh happens
 * with its last block past any reorg, and that one is the last. Its coverage stops moving, so a new block is the only sign.
 */
const fixedMayChange = (wallet: Cached, chain: Head) => chain.blockNum > wallet.readAtHead && wallet.coveredTo > settledThrough(wallet.readAtHead)

/** A live read's re-reads follow its coverage, which can lag. A fixed read's coverage stops, so only the chain says what's settled. */
const tipOf = (range: WalletRange, coveredTo: number, chain: Head) => (range.to === undefined ? coveredTo : chain.blockNum)

/** A wallet as it was before `block`, so the next refresh reads everything from there on as new. */
function rewound(wallet: Cached, block: number): Cached {
  const kept = <K, V>(entries: Map<K, V>, blockOf: (value: V, key: K) => number) => new Map([...entries].filter(([key, value]) => blockOf(value, key) < block))
  const last = block - 1
  return {
    ...wallet,
    coveredTo: Math.min(wallet.coveredTo, last),
    tablesReached: Math.min(wallet.tablesReached, last),
    rows: wallet.rows.filter((r) => r.block_num < block),
    priced: wallet.priced.filter((p) => p.block_num < block),
    references: kept(wallet.references, (reference) => reference.blockNum),
    latest: wallet.latest.blockNum < block ? wallet.latest : { blockNum: last, timestamp: timestampOfBlock(last, wallet.latest) },
    gasUnknown: kept(wallet.gasUnknown, (at) => at),
    closing: wallet.closing && wallet.closing.blockNum < block ? wallet.closing : null,
    lastBalances: Object.fromEntries(Object.entries(wallet.lastBalances).filter(([, balance]) => balance.blockNum < block)),
    lastCheckableEth: wallet.lastCheckableEth && wallet.lastCheckableEth.blockNum < block ? wallet.lastCheckableEth : null,
    l1Fees: kept(wallet.l1Fees, (fee) => fee.blockNum),
    ethBalances: kept(wallet.ethBalances, (_, at) => at),
    ethPayers: kept(wallet.ethPayers, (_, at) => at),
    notes: wallet.notes.filter((note) => note.blockNum < block),
    notesReadTo: Math.min(wallet.notesReadTo, last),
  }
}

/** A gas row's L1 fee, as a row of its own beside it. */
function l1FeeRows(rows: readonly LegRow[], fees: Cached["l1Fees"]): { rows: LegRow[]; unknownTxs: string[] } {
  const result: LegRow[] = []
  const unknownTxs: string[] = []
  for (const row of rows) {
    if (row.kind !== "gas") continue
    const known = fees.get(row.tx_hash)
    if (known?.blockNum !== row.block_num) unknownTxs.push(row.tx_hash)
    else if (known.fee !== "0") result.push({ ...row, kind: "l1_fee", amount: known.fee })
  }
  return { rows: result, unknownTxs }
}

/** A block in the past, as if it were the head. Base's block times are exact, so its timestamp doesn't need a read. */
function headAsOf(head: Head, to: number | undefined): Head {
  if (to === undefined || to >= head.blockNum) return head
  return { blockNum: to, timestamp: timestampOfBlock(to, head) }
}

const keyOf = (address: string, { from, to }: WalletRange) => `${address.toLowerCase()}:${from ?? ""}:${to ?? ""}`

/** `maxWallets`: how many reads to keep, the oldest going first. A server that many people share wants more than one Mac does. */
export function createWallets(source: Source, currentHead: () => Promise<Head>, readL1Fees: ReadL1Fees, logger: Logger = console, { maxWallets = MAX_WALLETS }: { maxWallets?: number | undefined } = {}) {
  const wallets = new Map<string, Cached>()
  const inflight = new Map<string, Promise<Cached>>()
  const reorgs: Reorg[] = []
  /** How many reorgs have been told about. Prices are read outside a wallet's own read too, and one that crossed a reorg isn't kept. */
  let rewinds = 0

  /**
   * The first block a reorg replaced that this wallet's last read can't be sure of, or null when there's none. Until the
   * tables get past it, every read goes back to here, however far that is.
   */
  function unsettledFrom(wallet: Cached, { to }: WalletRange): number | null {
    const unsettled = reorgs.filter(({ from, oldTip }) => settledThrough(wallet.tablesReached) < oldTip && (to === undefined || from <= to))
    return unsettled.length > 0 ? Math.min(...unsettled.map(({ from }) => from)) : null
  }

  /** Prices by `<asset>:<bucket>`, null when too little trading backs one. A failed read isn't in here, so it's tried again. */
  const market = new Map<string, MarketPrice | null>()
  let marketReady: boolean | null = null
  /** Each asset's latest answer, shared by every wallet. A failed read isn't in here, so it's tried again. */
  const latestRounds = new Map<string, FeedRound>()
  /** What the feeds answered at each chart point's bucket. A failed read isn't in here, so it's tried again. */
  const markRounds = new Map<string, FeedRound>()
  /** Where a read worked and a feed gave no answer: how many times, and the chain's head at the last one. */
  const noAnswers = new Map<string, { tries: number; atHead: number }>()

  /** The answers at `block`'s bucket, reading what's missing. A failure leaves those assets out, and it mustn't take the wallet down with it. */
  async function loadFeedRounds(assets: readonly string[], block: number): Promise<Record<string, FeedRound>> {
    if (!source.readFeedRounds) return {}
    const known = (asset: string) => latestRounds.get(asset)?.blockNum === block
    const withFeeds = assets.filter((asset) => TOKEN_FEEDS[asset])
    const missing = withFeeds.filter((asset) => !known(asset))
    if (missing.length > 0) {
      try {
        const startedAt = rewinds
        const rounds = await source.readFeedRounds(missing, block)
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
      return true
    } catch (error) {
      logger.warn(`Market read failed: ${describeError(error)}`)
      return false
    }
  }

  /** One query however many feeds. False when what's next has to wait: the read failed, or a reorg happened during it. */
  async function readMarkRounds(assets: readonly string[], bucket: number, head: number): Promise<boolean> {
    if (!source.readFeedRounds) return false
    try {
      const startedAt = rewinds
      const rounds = await source.readFeedRounds(assets, bucket)
      if (startedAt !== rewinds) return false
      for (const asset of assets) {
        const key = marketKey({ asset, bucket })
        const round = rounds[asset]
        if (round) {
          markRounds.set(key, round)
          noAnswers.delete(key)
        } else noAnswers.set(key, { tries: (noAnswers.get(key)?.tries ?? 0) + 1, atHead: head })
      }
      return true
    } catch (error) {
      logger.warn(`Feed read failed: ${describeError(error)}`)
      return false
    }
  }

  /** Whether this chart point's feed should be asked at this head. */
  function isFeedDue(read: MarketRead, head: number): boolean {
    const key = marketKey(read)
    if (!source.readFeedRounds || !TOKEN_FEEDS[read.asset] || markRounds.has(key)) return false
    const last = noAnswers.get(key)
    return !last || (last.tries < NO_ANSWER_TRIES && msBetweenBlocks(last.atHead, head) >= NO_ANSWER_WAIT_MS * 2 ** (last.tries - 1))
  }

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
      const readFeeds = async (assets: readonly string[], bucket: number) => {
        left -= 1
        feedsUp = await readMarkRounds(assets, bucket, head)
      }
      const due = reads.filter((read) => isFeedDue(read, head))
      const unasked = assetsByBucket(due.filter((read) => !noAnswers.has(marketKey(read))))
      const askAgain = assetsByBucket(due.filter((read) => noAnswers.has(marketKey(read))))
      for (const read of reads) {
        const feeds = unasked.get(read.bucket)
        if (feeds && left > 0 && feedsUp) {
          await readFeeds(feeds, read.bucket)
          unasked.delete(read.bucket)
        }
        if (!feedMark(read, markRounds, references)) await readMissingMarket(read)
      }
      for (const [bucket, assets] of askAgain) if (left > 0 && feedsUp) await readFeeds(assets, bucket)
    }
    return usable && startedAt === rewinds && wanted.every((w) => market.has(marketKey(w)))
  }

  /** Whether a read could still add a price this wallet needs. A failed read or the limit leaves some for the next refresh. */
  function hasMarketReadsLeft(address: string, wallet: Cached, head: number): boolean {
    const usable = source.readMarketTrades !== undefined && source.marketReady !== undefined && marketReady !== false
    const unread = (read: MarketRead) => usable && !market.has(marketKey(read))
    const { wanted } = marketWanted(wallet, wallet.priced, Math.min(wallet.coveredTo, wallet.latest.blockNum), wallet.prices)
    return wanted.some(unread) || chartReads(address, wallet.rows, wallet.opening).some((read) => isFeedDue(read, head) || (!feedMark(read, markRounds, wallet.references) && unread(read)))
  }

  /** Prices from a reorg's blocks may be from what it replaced. The trades behind one all come before its bucket's end. */
  function forgetPricesFrom(block: number) {
    for (const key of market.keys()) if (Number(key.split(":")[1]) >= block) market.delete(key)
    for (const [asset, round] of latestRounds) if (round.blockNum >= block) latestRounds.delete(asset)
    for (const answers of [markRounds, noAnswers]) for (const key of answers.keys()) if (Number(key.split(":")[1]) >= block) answers.delete(key)
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

  // A failed check leaves positions unchecked, and it mustn't take the wallet down with it.
  async function readBalances(address: string, block: number): Promise<BalanceSnapshot | null> {
    // Before the first block there's nothing to hold.
    if (block < 0) return { blockNum: block, amounts: Object.fromEntries(ASSETS.map((asset) => [asset, "0"])) }
    try {
      return await source.readBalances(address, block)
    } catch (error) {
      logger.warn(`Balance read failed: ${describeError(error)}`)
      return null
    }
  }

  /**
   * The balances a wallet's ETH still needs to say where it went wrong. A wallet whose ETH adds up has nothing unseen to
   * find, so it costs no reads, however many tokens it sends.
   */
  function unreadSendBlocks(address: string, wallet: Cached): number[] {
    const blocks = oneWaySendBalanceBlocks(wallet.rows).filter((block) => !wallet.ethBalances.has(block))
    if (blocks.length === 0) return []
    const data = responseOf(address, wallet)
    // The same check the wallet's position gets, because a balance can match after ETH left that never arrived. Whether it did doesn't depend on the method.
    const eth = foldPositions(data.legs, "average", {}, data).find((position) => position.asset === "ETH")
    return eth?.reconciliation?.status === "incomplete" ? blocks : []
  }

  /** A wallet's rows, with each claim settled wherever its balances and fees can say how much arrived. */
  function settle(wallet: Pick<Cached, "rows" | "priced" | "references" | "ethBalances" | "gasUnknown" | "l1Fees" | "staleFeeTxs">) {
    const l1 = l1FeeRows(wallet.rows, wallet.l1Fees)
    return settleUnwraps({
      rows: [...wallet.rows, ...l1.rows],
      priced: wallet.priced,
      references: [...wallet.references.values()],
      ethBalances: wallet.ethBalances,
      feeUnknownTxs: [...wallet.gasUnknown.keys(), ...l1.unknownTxs, ...wallet.staleFeeTxs],
      gasUnknownBlocks: [...wallet.gasUnknown.values()],
    })
  }

  /** A wallet's settled rows, with the ETH its balance says arrived and no row explains. */
  function withUnseenEth(address: string, wallet: Pick<Cached, "fromBlock" | "coveredTo" | "latest" | "rows" | "ethBalances" | "ethPayers" | "gasUnknown" | "l1Fees" | "staleFeeTxs">, rows: readonly LegRow[]): LegRow[] {
    return creditUnseenEth({
      rows,
      ethBalances: wallet.ethBalances,
      feeUnknownTxs: [...wallet.gasUnknown.keys(), ...l1FeeRows(wallet.rows, wallet.l1Fees).unknownTxs, ...wallet.staleFeeTxs],
      gasUnknownBlocks: [...wallet.gasUnknown.values()],
      account: address,
      fromBlock: wallet.fromBlock,
      through: wallet.coveredTo,
      payers: wallet.ethPayers,
      timestampOf: (block) => timestampOfBlock(block, wallet.latest),
    })
  }

  /** The balances a wallet still needs to find ETH that its rows don't explain. One whose ETH adds up has nothing to find, so it costs no reads. */
  function unreadUnseenBlocks(address: string, wallet: Cached): number[] {
    const data = responseOf(address, wallet)
    const eth = foldPositions(data.legs, "average", {}, data).find((position) => position.asset === "ETH")
    if (eth?.reconciliation?.status !== "incomplete") return []
    return unseenEthSearchBlocks({ rows: settle(wallet).rows, ethBalances: wallet.ethBalances, fromBlock: wallet.fromBlock, through: wallet.coveredTo })
  }

  const unseenCredits = (address: string, wallet: Cached) => withUnseenEth(address, wallet, settle(wallet).rows).filter((row) => row.kind === "unseen_eth")

  const unreadPayerBlocks = (address: string, wallet: Cached) => (source.readPayoutTxs ? unseenCredits(address, wallet).filter((row) => !wallet.ethPayers.has(row.block_num)) : [])

  /** Finds where a wallet's ETH moved without a row to show for it, then what's needed to treat it like any other ETH that arrived. A failed read leaves what's unread as it was. */
  async function findUnseenEth(address: string, wallet: Cached, budget: number) {
    let left = budget
    while (left > 0) {
      const blocks = unreadUnseenBlocks(address, wallet).slice(0, left)
      if (blocks.length === 0) break
      const known = wallet.ethBalances.size
      await readEthBalances(address, blocks, wallet.ethBalances)
      if (wallet.ethBalances.size === known) break
      left -= blocks.length
    }
    const credits = unseenCredits(address, wallet)
    const unpriced = credits.map((row) => row.block_num).filter((block) => !wallet.references.has(block))
    const unread = unreadPayerBlocks(address, wallet).slice(0, MAX_PAYER_BLOCKS_PER_READ)
    try {
      if (unpriced.length > 0) for (const reference of await source.readReferences(unpriced)) wallet.references.set(reference.blockNum, reference)
      if (unread.length > 0 && source.readPayoutTxs) {
        const txs = await source.readPayoutTxs(address, unread.map((row) => row.block_num))
        for (const { block_num, amount } of unread) wallet.ethPayers.set(block_num, payerOf(txs.filter((tx) => tx.blockNum === block_num), address, amount))
      }
    } catch (error) {
      logger.warn(`Couldn't read what's behind ETH that arrived unseen: ${describeError(error)}`)
    }
  }

  /** A failed read leaves what's unread as it was. The next refresh tries again. */
  async function readEthBalances(address: string, blocks: readonly number[], into: Map<number, string>) {
    if (blocks.length === 0) return
    try {
      for (const [block, balance] of await source.readEthBalances(address, blocks)) into.set(block, balance)
    } catch (error) {
      logger.warn(`ETH balance read failed: ${describeError(error)}`)
    }
  }

  /** A wallet read as of a fixed block has no new block coming, so what it's still missing has to be read without one. */
  const isFixedCurrent = (address: string, wallet: Cached, head: Head, chain: Head) =>
    wallet.coveredTo >= head.blockNum &&
    isComplete(wallet.opening) &&
    isComplete(wallet.closing) &&
    wallet.rows.every((r) => r.kind !== "gas" || isL1FeeSettled(wallet.l1Fees.get(r.tx_hash), r.block_num, chain.blockNum)) &&
    unwrapBalanceBlocks(wallet.rows).every((block) => wallet.ethBalances.has(block)) &&
    !fixedMayChange(wallet, chain) &&
    !openingMayChange(wallet, chain) &&
    unreadSendBlocks(address, wallet).length === 0 &&
    unreadUnseenBlocks(address, wallet).length === 0 &&
    unreadPayerBlocks(address, wallet).length === 0 &&
    !hasMarketReadsLeft(address, wallet, chain.blockNum)

  async function refresh(address: string, key: string, range: WalletRange): Promise<Cached> {
    const chain = await currentHead()
    const head = headAsOf(chain, range.to)
    const cached = wallets.get(key)
    const unsettled = cached ? unsettledFrom(cached, range) : null
    // A dataset that's behind can finish more blocks under the same head, so a live read is only current once it's reached the head.
    if (cached && unsettled === null && (range.to === undefined ? cached.latest.blockNum >= head.blockNum && cached.coveredTo >= head.blockNum : isFixedCurrent(address, cached, head, chain))) return cached

    const fromBlock = cached?.fromBlock ?? range.from ?? source.startBlock ?? Math.max(0, source.historyFrom?.(head.blockNum) ?? head.blockNum)
    // Coverage only moves up to what's been processed. If it followed the chain, a table catching up later would
    // never be read for the blocks it skipped past.
    const processed = await source.processedThrough(cached?.coveredTo ?? fromBlock, head.blockNum)
    const coveredTo = processed ?? cached?.coveredTo ?? fromBlock - 1
    const tip = tipOf(range, coveredTo, chain)
    const reorgable = range.to !== undefined && cached !== undefined && (fixedMayChange(cached, chain) || unsettled !== null)
    // Before the rows, so a read that finds the tables far enough along has what they've rewritten. It's a query, so only when there's a reorg to settle.
    const { to } = range
    const looksPast = to !== undefined && (unsettled !== null || (!cached && reorgs.some(({ from }) => from <= to)))
    const tablesReached = (to === undefined ? coveredTo : looksPast ? await source.processedThrough(coveredTo, chain.blockNum) : null) ?? cached?.tablesReached ?? coveredTo

    let rows = cached?.rows ?? []
    let priced = cached?.priced ?? []
    const known = new Map(cached?.references ?? [])
    const gasUnknown = new Map(cached?.gasUnknown ?? [])
    const ethBalances = new Map(cached?.ethBalances ?? [])
    const ethPayers = new Map(cached?.ethPayers ?? [])
    let replacedFrom = Number.POSITIVE_INFINITY
    if (coveredTo >= fromBlock && (!cached || coveredTo > cached.coveredTo || reorgable)) {
      const readFrom = cached ? Math.max(fromBlock, Math.min(settledThrough(cached.coveredTo) + 1, unsettled ?? Infinity)) : fromBlock
      replacedFrom = readFrom
      const window = await source.readWindow(address, readFrom, coveredTo)
      rows = [...rows.filter((r) => r.block_num < readFrom), ...window.rows]
      for (const block of known.keys()) if (block >= readFrom) known.delete(block)
      for (const block of ethBalances.keys()) if (block >= readFrom) ethBalances.delete(block)
      for (const block of ethPayers.keys()) if (block >= readFrom) ethPayers.delete(block)
      const missing = [...new Set(rows.map((r) => r.block_num))].filter((b) => !known.has(b))
      for (const reference of await source.readReferences(missing)) known.set(reference.blockNum, reference)
      priced = window.priced ? [...priced.filter((p) => p.block_num < readFrom), ...window.priced] : derivePricedRows(rows, [...known.values()])
      for (const [tx, block] of gasUnknown) if (block >= readFrom) gasUnknown.delete(tx)
      for (const { tx_hash, block_num } of window.gasUnknown) gasUnknown.set(tx_hash, block_num)
    }

    const l1Fees = new Map([...(cached?.l1Fees ?? [])].filter(([, fee]) => unsettled === null || fee.blockNum < unsettled))
    const claimBlocks = new Set(unwrapBalanceBlocks(rows))
    const unread = rows.filter((r) => {
      if (r.kind !== "gas") return false
      const fee = l1Fees.get(r.tx_hash)
      return !isL1FeeSettled(fee, r.block_num, tip) || (claimBlocks.has(r.block_num) && !isL1FeeCurrent(fee, r.block_num, tip))
    })
    const fees = unread.length > 0 ? await readL1Fees(unread.map((r) => ({ txHash: r.tx_hash, blockNum: r.block_num }))) : new Map<string, string>()
    for (const { tx_hash, block_num } of unread) {
      const fee = fees.get(tx_hash)
      if (fee !== undefined) l1Fees.set(tx_hash, { blockNum: block_num, fee, readAtTip: tip })
    }

    // A transaction with only gas in it is what a note looks like. Anything near the tip could still change, so it's read again.
    let notes = cached?.notes ?? []
    let notesReadTo = Math.min(cached?.notesReadTo ?? fromBlock - 1, unsettled === null ? Infinity : unsettled - 1)
    const settled = Math.min(coveredTo, settledThrough(tip))
    if (source.readNotes && coveredTo >= fromBlock) {
      const movers = new Set(rows.filter((r) => r.kind !== "gas" && r.kind !== "l1_fee").map((r) => r.tx_hash))
      const noteBlocks = [...new Set(rows.filter((r) => r.kind === "gas" && !movers.has(r.tx_hash) && r.block_num > notesReadTo).map((r) => r.block_num))]
      const read = await source.readNotes(address, noteBlocks)
      notes = [...notes.filter((n) => n.blockNum <= notesReadTo), ...read]
      if (settled > notesReadTo) notesReadTo = settled
    }

    const staleFeeTxs = rows.filter((r) => r.kind === "gas" && !isL1FeeCurrent(l1Fees.get(r.tx_hash), r.block_num, tip)).map((r) => r.tx_hash)

    const unreadEth = unwrapBalanceBlocks(rows).filter((block) => !ethBalances.has(block)).slice(0, MAX_ETH_BALANCES_PER_READ)
    await readEthBalances(address, unreadEth, ethBalances)

    let opening = cached?.opening ?? null
    const openingReadAt = { ...cached?.openingReadAt }
    let closing = cached?.closing ?? null
    const lastBalances = { ...cached?.lastBalances }
    let lastCheckableEth = cached?.lastCheckableEth ?? null
    if (coveredTo >= fromBlock) {
      if (!isComplete(opening) || openingMayChange(cached, chain)) {
        const read = await readBalances(address, fromBlock - 1)
        opening = mergeOpening(opening, read)
        for (const asset of Object.keys(read?.amounts ?? {})) openingReadAt[asset] = chain.blockNum
      }
      if (closing?.blockNum !== coveredTo || !isComplete(closing) || reorgable) closing = await readBalances(address, coveredTo)
      for (const [asset, amount] of Object.entries(closing?.amounts ?? {})) lastBalances[asset] = { blockNum: coveredTo, amount }
      if (closing?.amounts.ETH !== undefined && gasUnknown.size === 0 && l1FeeRows(rows, l1Fees).unknownTxs.length === 0 && !settle({ rows, priced, references: known, ethBalances, gasUnknown, l1Fees, staleFeeTxs }).rows.some(isUnwrapClaim)) {
        lastCheckableEth = { blockNum: coveredTo, amount: closing.amounts.ETH }
      } else if (lastCheckableEth && lastCheckableEth.blockNum >= replacedFrom) {
        // Its block was just replaced, so what it said may be gone. A failed read leaves it as it was, and the next refresh tries again.
        const { blockNum } = lastCheckableEth
        const amount = (await readBalances(address, blockNum))?.amounts.ETH
        if (amount !== undefined) lastCheckableEth = { blockNum, amount }
      }
    }

    const prices = latestPrices(await source.readLatestReference(head.blockNum))

    if (unsettled !== null) forgetPricesFrom(unsettled)
    const wallet = { rows, opening, closing, lastBalances }
    const heldAssets = assetsHeld(wallet)
    // At the head rather than at what's covered, like ETH's: a table that stops processing can't keep an old answer current.
    Object.assign(prices, feedPrices(await loadFeedRounds(heldAssets, bucketOf(head.blockNum, MARKET_HEAD_BUCKET_BLOCKS)), prices))
    const { headBucket, unpriced, wanted } = marketWanted(wallet, priced, Math.min(coveredTo, head.blockNum), prices)
    const marketRead = await loadMarket(wanted, { reads: chartReads(address, rows, opening), references: known, head: chain.blockNum })
    for (const asset of unpriced) {
      const price = market.get(`${asset}:${headBucket}`)
      if (price) prices[asset] = { micros: price.usdMicros, source: "market", blockNum: price.blockNum }
    }
    const marketChecked = marketRead && feedsLeftNoGap(heldAssets, prices)

    const next: Cached = { fromBlock, coveredTo, rows, priced, references: known, prices, latest: head, gasUnknown, opening, openingReadAt, readAtHead: chain.blockNum, tablesReached, closing, lastBalances, lastCheckableEth, l1Fees, staleFeeTxs, ethBalances, ethPayers, notes, notesReadTo, marketChecked }
    // This comes after the claims and the closing balance, because whether ETH adds up depends on both.
    const sendBlocks = unreadSendBlocks(address, next).slice(0, MAX_ETH_BALANCES_PER_READ - unreadEth.length)
    await readEthBalances(address, sendBlocks, ethBalances)
    await findUnseenEth(address, next, MAX_ETH_BALANCES_PER_READ - unreadEth.length - sendBlocks.length)
    wallets.delete(key)
    wallets.set(key, next)
    if (wallets.size > maxWallets) wallets.delete(wallets.keys().next().value as string)
    return next
  }

  function responseOf(address: string, wallet: Omit<Cached, "openingReadAt" | "readAtHead" | "tablesReached">, use: (key: string) => boolean = () => true, rounds: MarkRounds = markRounds): WalletData {
    const references = [...wallet.references.values()]
    const l1 = l1FeeRows(wallet.rows, wallet.l1Fees)
    const { opening, closing } = wallet
    const { rows: settled, priced, unseenEth } = settle(wallet)
    const rows = withUnseenEth(address, wallet, settled)
    const marketAt = (asset: string, block: number) => {
      const key = `${asset}:${bucketOf(block)}`
      return use(key) ? (market.get(key)?.usdMicros ?? null) : null
    }
    // What's been read for its chart so far. A feed comes first, as for what's held now, so the last point doesn't jump.
    const marketMarks: MarketMarks = {}
    for (const read of chartReads(address, wallet.rows, opening)) {
      const micros = feedMark(read, rounds, wallet.references) ?? marketAt(read.asset, read.block)
      if (micros) (marketMarks[read.block] ??= {})[read.asset] = micros
    }
    const openedAt = timestampOfBlock(wallet.fromBlock - 1, wallet.latest)
    return {
      address,
      mode: source.mode,
      coverage: { fromBlock: wallet.fromBlock, toBlock: wallet.coveredTo },
      legs: [...(opening ? openingLegs(opening, openedAt) : []), ...buildPricedLegs({ account: address, rows, references, priced, market: marketAt })],
      references,
      prices: wallet.prices,
      latest: wallet.latest,
      gasUnknownTxs: [...wallet.gasUnknown.keys()],
      gasUnknownBlocks: [...wallet.gasUnknown.values()],
      unlisted: unlistedTokens(wallet.rows, address),
      currency: "USD",
      rates: null,
      l1FeeUnknownTxs: l1.unknownTxs,
      balances: closing,
      openingUnread: ASSETS.filter((asset) => opening?.amounts[asset] === undefined),
      lastBalances: Object.fromEntries(Object.entries(wallet.lastBalances).filter(([asset]) => closing?.amounts[asset] === undefined)),
      lastCheckableEth: wallet.lastCheckableEth,
      unreadBalances: wallet.coveredTo >= wallet.fromBlock ? ASSETS.filter((asset) => closing?.amounts[asset] === undefined) : [],
      unseenEth,
      notes: wallet.notes,
      marketChecked: wallet.marketChecked,
      marketMarks,
    }
  }

  return {
    async get(address: string, range: WalletRange = {}): Promise<WalletData> {
      const account = address.toLowerCase()
      const key = keyOf(account, range)
      let pending = inflight.get(key)
      if (!pending) {
        pending = refresh(account, key, range).finally(() => inflight.delete(key))
        inflight.set(key, pending)
      }
      return responseOf(account, await pending)
    },

    /**
     * This wallet's facts at `through`, from what's been read, with its balance at that block when `withBalances`.
     * A failed balance read comes back as no balance, which every rule read through these facts then shares.
     * Null when this wallet hasn't been read as far as `through`.
     */
    async factsAt(address: string, through: number, { withBalances }: { withBalances: boolean }): Promise<WalletFacts | null> {
      const account = address.toLowerCase()
      const wallet = wallets.get(keyOf(account, {}))
      if (!wallet || wallet.coveredTo < through) return null
      const closing = !withBalances ? null : wallet.closing?.blockNum === through ? wallet.closing : await readBalances(account, through)
      const rows = wallet.rows.filter((r) => r.block_num <= through)
      const lastBalances = Object.fromEntries(Object.entries(wallet.lastBalances).filter(([, last]) => last.blockNum <= through))
      return {
        fromBlock: wallet.fromBlock,
        coveredTo: through,
        rows,
        latest: { blockNum: through, timestamp: timestampOfBlock(through, wallet.latest) },
        gasUnknown: wallet.gasUnknown,
        opening: wallet.opening,
        closing,
        lastBalances,
        lastCheckableEth: wallet.lastCheckableEth && wallet.lastCheckableEth.blockNum <= through ? wallet.lastCheckableEth : null,
        l1Fees: wallet.l1Fees,
        staleFeeTxs: wallet.staleFeeTxs,
        ethBalances: wallet.ethBalances,
        ethPayers: wallet.ethPayers,
        notes: wallet.notes.filter((n) => n.blockNum <= through),
        notesReadTo: Math.min(wallet.notesReadTo, through),
        marketChecked: wallet.marketChecked,
        // Read for this block, since what the last refresh read can be from after it.
        feedRounds: await loadFeedRounds(assetsHeld({ rows, opening: wallet.opening, closing, lastBalances }), bucketOf(through, MARKET_HEAD_BUCKET_BLOCKS)),
        markRounds: new Map(markRounds),
      }
    },

    /**
     * This source's own market prices for those facts, with `prices` as what's current, read now if they haven't been. Two rules can read a wallet either
     * side of a bucket, so what each read for itself may not be for the block they're compared at.
     */
    async marketOn(address: string, facts: WalletFacts, prices: LatestPrices): Promise<MarketOn> {
      const through = facts.coveredTo
      const priced = wallets.get(keyOf(address.toLowerCase(), {}))?.priced.filter((p) => p.block_num <= through) ?? []
      const { wanted } = marketWanted(facts, priced, through, { ...prices, ...feedPrices(facts.feedRounds, prices) })
      const checked = await loadMarket(wanted)
      return { priced: new Set(wanted.map(({ asset, bucket }) => `${asset}:${bucket}`).filter((key) => market.get(key))), checked }
    },

    /**
     * Those facts, priced by this source's rows, with `prices` as what's current and `using` as the market prices it can
     * use. Null when this source hasn't read that far, or read different transactions, as after a reorg, so the two can't
     * be said to differ only by price.
     */
    pricedOn(address: string, facts: WalletFacts, prices: LatestPrices, using: MarketOn): WalletData | null {
      const account = address.toLowerCase()
      const own = wallets.get(keyOf(account, {}))
      if (!own || own.coveredTo < facts.coveredTo) return null
      const through = facts.coveredTo
      if (rowKeys(own.rows.filter((r) => r.block_num <= through)) !== rowKeys(facts.rows)) return null
      // Market prices come from this source's own trades, like the rest of what's priced. A feed comes first, as in a refresh.
      const current = { ...prices, ...marketPricesAt(through, using), ...feedPrices(facts.feedRounds, prices) }
      return responseOf(
        account,
        {
          ...facts,
          priced: own.priced.filter((p) => p.block_num <= through),
          references: new Map([...own.references].filter(([block]) => block <= through)),
          prices: current,
          marketChecked: using.checked && feedsLeftNoGap(assetsHeld(facts), current),
        },
        (key) => using.priced.has(key),
        facts.markRounds,
      )
    },

    /**
     * A reorg replaced every block from `block` on, so forget them, however far back that is, and keep reading them until
     * the tables are past `tip`, the newest block the old chain is known to have reached, by as long as any reorg is re-read for. A wallet read that started before this finishes first. A wallet that held balances from before `block`
     * is read again from the start if the reorg reached them.
     */
    async rewind(block: number, tip: number): Promise<void> {
      rewinds += 1
      reorgs.push({ from: block, oldTip: Math.max(tip, ...[...wallets.values()].flatMap((wallet) => [wallet.latest.blockNum, wallet.tablesReached])) })
      while (inflight.size > 0) await Promise.allSettled(inflight.values())
      forgetPricesFrom(block)
      for (const [key, wallet] of wallets) {
        if (block <= wallet.fromBlock) wallets.delete(key)
        else if (block <= wallet.latest.blockNum) wallets.set(key, rewound(wallet, block))
      }
    },

    /** The first block a reorg replaced that this wallet's numbers can't be sure of yet, or null when they can. */
    unsettledFrom(address: string, range: WalletRange = {}): number | null {
      const wallet = wallets.get(keyOf(address.toLowerCase(), range))
      return wallet ? unsettledFrom(wallet, range) : null
    },

    /** What's already been read, with no query, or null when nothing has been. */
    peek(address: string): WalletData | null {
      const account = address.toLowerCase()
      const wallet = wallets.get(keyOf(account, {}))
      return wallet ? responseOf(account, wallet) : null
    },
  }
}
