// Reads what a wallet is: its legs, what it held before them, what the chain says it holds now, and its L1 fees.
// Keeps each wallet's rows in memory: one full read, then only new blocks, because a wallet read scans the whole range.
// What a read keeps is in `wallet-state.ts`, the prices it needs beyond the dataset's in `wallet-prices.ts`, and how its ETH is
// checked against the balance in `wallet-eth.ts`.

import { describeError, type Logger } from "./amp.ts"
import { priceSampleBlocks, timestampOfBlock } from "./chain.ts"
import { buildPricedLegs, derivePricedRows, isUnwrapClaim, signedAmount, unwrapBalanceBlocks, type GasUnknownTx, type LegRow, type PayoutTx, type PricedRow, type Reference } from "./legs.ts"
import { WalletTooBigError, createRowBudget, rowsThatFit, type RowBudget } from "./memory.ts"
import type { FeedMarks, MarketMarks, MarketTrade } from "./market.ts"
import type { TokenActivity } from "./token-market.ts"
import type { CostNote } from "./notes.ts"
import { NO_OTHER_TOKENS, createOtherTokens, type OtherTokensReader, type ReadTokenFacts } from "./other-tokens.ts"
import { latestPrices, type FeedRound, type Head, type LatestPrices } from "./portfolio.ts"
import type { ReadL1Fees } from "./receipts.ts"
import { openingLegs, type BalanceSnapshot } from "./reconcile.ts"
import { ASSETS } from "./tokens.ts"
import type { Mode, UnlistedToken, WalletData } from "./wallet-data.ts"
import { createEthChecks, settle, withUnseenEth, type CurrentResponse } from "./wallet-eth.ts"
import { MARKET_HEAD_BUCKET_BLOCKS, assetsHeld, bucketOf, chartReads, createPriceCache, feedMark, feedPrices, marketKey, marketWanted, pricesUsedBy, type ChartRounds, type MarketOn } from "./wallet-prices.ts"
import { isComplete, isL1FeeCurrent, isL1FeeSettled, l1FeeRows, settledThrough, type Cached, type L1Fee, type Reorg } from "./wallet-state.ts"

export { settledThrough } from "./wallet-state.ts"
export { MARKET_BUCKET_BLOCKS, feedPrices, sharedMarket, unpricedMoves, type MarketOn } from "./wallet-prices.ts"

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
  /**
   * Trades of these tokens off the allowlist in a block range, with `from` and `to` on the edges of a pricing bucket. Rows have to be grouped
   * by those buckets, with `bin` their last block, so a wider read gives the same rows for what it shares. Only a dataset with `token_trades`
   * has them. Leaving this or `tokenActivityThrough` out changes nothing about any wallet.
   */
  readTokenActivity?(tokens: readonly string[], from: number, to: number): Promise<TokenActivity[]>
  /** The newest block, in `after`..`head`, that `token_trades` has processed, or null if it hasn't reached `after`. A read past this looks like no trading, not a dataset that's behind. */
  tokenActivityThrough?(after: number, head: number): Promise<number | null>
  /** What these assets' `TOKEN_FEEDS` answer at each of these blocks. A feed whose read failed isn't in it, and neither is a block with no row. */
  readFeedRounds?(assets: readonly string[], blocks: readonly number[]): Promise<Map<number, Record<string, FeedRound>>>
  /** What tokens off the allowlist say about themselves and this wallet at `block`. Without it, a wallet just has no `otherTokens`. */
  readTokenFacts?: ReadTokenFacts
}

/**
 * Blocks to read, inclusive. Without `from`, it starts at the config's `startBlock`, or the source's first block. Without `to`,
 * it reads up to the chain's head, and with one it's the wallet as of that block.
 */
export type BlockRange = { from?: number | undefined; to?: number | undefined }

const MAX_WALLETS = 20
/** Wallets refused as too big, remembered so asking again costs no reads. */
const MAX_REFUSED = 1_000
/** A busy wallet catches up over a few refreshes, and until then the swaps left say they aren't confirmed. */
const MAX_ETH_BALANCES_PER_READ = 400
/** How long a price or feed answer no read has used is kept, unless a kept wallet uses it. So this is only what's been left behind. */
const UNUSED_MS = 24 * 3600_000
/** How often to look for those, and for reorgs every table is past. */
const SWEEP_EVERY_MS = 10 * 60_000

/** What the wallet holds off the allowlist. An ID or an unreadable amount can't be netted, so those count as held. */
export function unlistedTokens(rows: readonly LegRow[], account: string): UnlistedToken[] {
  const tokens = new Map<string, { net: bigint; transfers: number; unreadable: boolean }>()
  for (const row of rows) {
    if (row.account !== account || (row.kind !== "unlisted" && row.kind !== "unlisted_nft")) continue
    const token = tokens.get(row.token) ?? { net: 0n, transfers: 0, unreadable: false }
    token.transfers += 1
    if (row.kind === "unlisted_nft") token.unreadable = true
    else if (/^\d+$/.test(row.amount)) token.net += signedAmount(row)
    else token.unreadable = true
    tokens.set(row.token, token)
  }
  return [...tokens].filter(([, { net, unreadable }]) => net > 0n || unreadable).map(([token, { transfers }]) => ({ token, transfers }))
}

/**
 * What happened to a wallet up to one block, without what any of it was worth. Two pricing rules read through the same
 * facts can only differ by the rule, because what's held, what moved and what fees came to are all the same object.
 */
export type WalletFacts = Pick<Cached, "fromBlock" | "coveredTo" | "rows" | "latest" | "gasUnknown" | "opening" | "closing" | "lastBalances" | "lastCheckableEth" | "l1Fees" | "staleFeeTxs" | "ethBalances" | "ethPayers" | "notes" | "notesReadTo" | "marketChecked"> & {
  /** What the feeds in `TOKEN_FEEDS` answered at or just before `coveredTo`, which is the chain's whatever rule prices the rest. */
  feedRounds: Record<string, FeedRound>
  /** What the feeds answered for its chart so far, so what two rules mark a token at can only differ by their ETH. */
  chartRounds: ChartRounds
}

/** Everything about a row but its price. A transaction that moved to another block isn't the same fact, even with the same amounts. */
const rowKey = (r: LegRow) => `${r.block_num}:${r.timestamp}:${r.tx_index}:${r.tx_hash}:${r.log_index}:${r.account}:${r.side}:${r.kind}:${r.token}:${r.amount}`
const rowKeys = (rows: readonly LegRow[]) => rows.map(rowKey).sort().join()

/** A read can fail for one asset and work for the rest. What it didn't get stays as it was known. */
function mergeOpening(known: BalanceSnapshot | null, read: BalanceSnapshot | null): BalanceSnapshot | null {
  if (!read) return known
  return { blockNum: read.blockNum, amounts: { ...known?.amounts, ...read.amounts } }
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
const tipOf = (range: BlockRange, coveredTo: number, chain: Head) => (range.to === undefined ? coveredTo : chain.blockNum)

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
    samples: wallet.samples && kept(wallet.samples, (reference) => reference.blockNum),
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

/** A block in the past, as if it were the head. Base's block times are exact, so its timestamp doesn't need a read. */
function headAsOf(head: Head, to: number | undefined): Head {
  if (to === undefined || to >= head.blockNum) return head
  return { blockNum: to, timestamp: timestampOfBlock(to, head) }
}

/** Where a chart wants a price, from a wallet's first movement to its head, past what's covered if that's behind, since it's as unknown there. */
function sampleBlocksOf({ rows, latest }: Pick<Cached, "rows" | "latest">): number[] {
  if (rows.length === 0) return []
  return priceSampleBlocks(rows.reduce((first, row) => Math.min(first, row.block_num), Number.POSITIVE_INFINITY), latest.blockNum)
}

const keyOf = (address: string, { from, to }: BlockRange) => `${address.toLowerCase()}:${from ?? ""}:${to ?? ""}`
/** The address a wallet's key was made with. */
const addressOfKey = (key: string) => key.split(":")[0] as string
/** The `to` a wallet's key was made with. */
const toOfKey = (key: string) => {
  const to = key.split(":")[2]
  return to ? Number(to) : undefined
}

/** Whether a reorg could still be serving its old blocks to this wallet's reads. */
const isUnsettledFor = ({ from, oldTip }: Reorg, wallet: Pick<Cached, "tablesReached">, { to }: BlockRange) => settledThrough(wallet.tablesReached) < oldTip && (to === undefined || from <= to)

/** How far a wallet's first read has got. `costs` means its facts are in and they're being worked into an answer. */
export type ReadProgress = { stage: "waiting" | "transfers" | "prices" | "checking" | "costs"; transfers: number | null }

const countTransfers = (rows: readonly LegRow[]) => rows.filter((row) => row.kind !== "gas" && row.kind !== "l1_fee").length

/** What a refresh starts from: the last read's facts, copied so a refresh that fails leaves them as they were. */
function draftOf(cached: Cached | undefined) {
  return {
    rows: cached?.rows ?? [],
    priced: cached?.priced ?? [],
    references: new Map(cached?.references ?? []),
    knownSamples: new Map(cached?.samples ?? []),
    gasUnknown: new Map(cached?.gasUnknown ?? []),
    ethBalances: new Map(cached?.ethBalances ?? []),
    ethPayers: new Map(cached?.ethPayers ?? []),
    /** The first block whose rows were read again, if any were. */
    replacedFrom: Number.POSITIVE_INFINITY,
  }
}
type Draft = ReturnType<typeof draftOf>

/** What a refresh has worked out it reads, before reading any of it. */
type Plan = {
  cached: Cached | undefined
  fromBlock: number
  coveredTo: number
  /** See `tipOf`. */
  tip: number
  /** The first block a reorg replaced that the last read can't be sure of, or null. */
  unsettled: number | null
  /** A fixed read that has to read its blocks again. */
  reorgable: boolean
}
/**
 * `maxWallets`: how many reads to keep, the oldest going first. A server that many people share wants more than one Mac does.
 * `priceSamples`: also read prices between a wallet's transactions, for an app's chart, which costs a query for each wallet.
 * `otherTokens`: for sharing what's read about other tokens between pricing rules, since no rule changes it.
 * `budget`: the rows of history that fit in memory, which pricing rules reading the same wallets share.
 * `now`: the time in milliseconds, which only decides when a price nobody has used in a while is let go.
 */
export function createWallets(source: Source, currentHead: () => Promise<Head>, readL1Fees: ReadL1Fees, logger: Logger = console, { maxWallets = MAX_WALLETS, priceSamples = false, otherTokens = source.readTokenFacts && createOtherTokens(source.readTokenFacts, logger), budget = createRowBudget(rowsThatFit()), now = Date.now }: { maxWallets?: number | undefined; priceSamples?: boolean | undefined; otherTokens?: OtherTokensReader | undefined; budget?: RowBudget | undefined; now?: (() => number) | undefined } = {}) {
  const wallets = new Map<string, Cached>()
  const inflight = new Map<string, Promise<Cached>>()
  /** Its history only grows, so a wallet that's too big stays too big, short of a reorg. */
  const refused = new Set<string>()
  budget.join({
    heldRows: () => [...wallets].reduce((sum, [key, wallet]) => sum + (inflight.has(key) ? 0 : wallet.rows.length), 0),
    evictOldest() {
      for (const key of wallets.keys()) if (!inflight.has(key)) return wallets.delete(key)
      return false
    },
  })
  /** First reads in progress, for showing how far along they are. Later reads are quick, and have numbers to show meanwhile. */
  const firstReads = new Map<string, ReadProgress>()
  /** Reorgs some read may still be serving the old blocks of. One goes once every table and every wallet kept is past it. */
  const reorgs: Reorg[] = []
  /** How far the tables a wallet read uses had got, at the newest read since the last reorg. */
  let tablesSeen = -1
  let sweptAt = now()
  const pricing = createPriceCache(source, logger, reorgs, now)
  const eth = createEthChecks(source, logger, currentOf)

  /**
   * The first block a reorg replaced that this wallet's last read can't be sure of, or null when there's none. Until the
   * tables get past it, every read goes back to here, however far that is.
   */
  function unsettledFrom(wallet: Cached, range: BlockRange): number | null {
    const unsettled = reorgs.filter((reorg) => isUnsettledFor(reorg, wallet, range))
    return unsettled.length > 0 ? Math.min(...unsettled.map(({ from }) => from)) : null
  }

  const isPast = (reorg: Reorg, reached: number) => settledThrough(reached) >= reorg.oldTip

  /**
   * Lets go of what's only kept for reads that stopped coming: prices and feed answers no read has used in a day and no kept
   * wallet's response is worked out from, since one shown again with no new read would lose them, and reorgs
   * that the tables, `token_trades` and every wallet kept are all past. Without this, a server that runs for weeks keeps growing.
   */
  function sweep() {
    const time = now()
    if (time - sweptAt < SWEEP_EVERY_MS) return
    sweptAt = time
    pricing.forgetUnusedSince(time - UNUSED_MS, new Set([...wallets].flatMap(([key, wallet]) => pricesUsedBy(addressOfKey(key), wallet))))
    for (let i = reorgs.length - 1; i >= 0; i--) {
      const reorg = reorgs[i] as Reorg
      const tokensPast = !source.readTokenActivity || isPast(reorg, pricing.tokensReached)
      const walletsPast = [...wallets].every(([key, wallet]) => !isUnsettledFor(reorg, wallet, { to: toOfKey(key) }))
      if (isPast(reorg, tablesSeen) && tokensPast && walletsPast) reorgs.splice(i, 1)
    }
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
   * What a wallet's chart still wants, added to what it has. A block with a transaction in it was already read for that. One
   * past what's covered waits, since the tables haven't reached it. A block the table has no row for has no price to find, so
   * it isn't asked about again. A failed read is tried next refresh.
   */
  async function readSamples(wallet: Pick<Cached, "rows" | "latest" | "coveredTo" | "references">, known: Map<number, Reference>): Promise<Map<number, Reference>> {
    const blocks = sampleBlocksOf(wallet)
    const samples = new Map(blocks.flatMap((block) => { const read = wallet.references.get(block) ?? known.get(block); return read ? [[block, read] as const] : [] }))
    const missing = blocks.filter((block) => !samples.has(block) && block <= wallet.coveredTo)
    if (missing.length === 0) return samples
    try {
      const reads = new Map((await source.readReferences(missing)).map((read) => [read.blockNum, read]))
      for (const block of missing) samples.set(block, reads.get(block) ?? { blockNum: block, ethUsd: "", usdcUsd: "" })
    } catch (error) {
      logger.warn(`Couldn't read prices for a chart: ${describeError(error)}`)
    }
    return samples
  }

  /** A wallet read as of a fixed block has no new block coming, so what it's still missing has to be read without one. */
  const isFixedCurrent = (address: string, wallet: Cached, head: Head, chain: Head) =>
    wallet.coveredTo >= head.blockNum &&
    isComplete(wallet.opening) &&
    isComplete(wallet.closing) &&
    (wallet.samples === null || sampleBlocksOf(wallet).every((block) => block > wallet.coveredTo || wallet.samples?.has(block))) &&
    wallet.rows.every((r) => r.kind !== "gas" || isL1FeeSettled(wallet.l1Fees.get(r.tx_hash), r.block_num, chain.blockNum)) &&
    unwrapBalanceBlocks(wallet.rows).every((block) => wallet.ethBalances.has(block)) &&
    !fixedMayChange(wallet, chain) &&
    !openingMayChange(wallet, chain) &&
    eth.unreadSendBlocks(address, wallet).length === 0 &&
    eth.unreadUnseenBlocks(address, wallet).length === 0 &&
    eth.unreadPayerBlocks(address, wallet).length === 0 &&
    !pricing.hasMarketReadsLeft(address, wallet, chain.blockNum) &&
    !pricing.hasNewerFeedPrices(wallet) &&
    !(chain.blockNum > wallet.readAtHead && pricing.unreadTokenPrices(address, wallet.rows).length > 0)

  /** Rows from where the last read can't be sure of, replacing what was there, with the oracle reads and priced rows they need. */
  async function readNewRows(address: string, draft: Draft, { cached, fromBlock, coveredTo, reorgable, unsettled }: Plan, reservation: { release?: () => void }, isAbandoned: () => boolean, reached: (stage: ReadProgress["stage"], transfers: number) => void) {
    if (coveredTo < fromBlock || (cached && coveredTo <= cached.coveredTo && !reorgable)) return
    const readFrom = cached ? Math.max(fromBlock, Math.min(settledThrough(cached.coveredTo) + 1, unsettled ?? Infinity)) : fromBlock
    draft.replacedFrom = readFrom
    // Only a first read can bring in a whole history, and it can't say how much until it has.
    if (!cached) reservation.release = await budget.loading()
    if (isAbandoned()) return
    const window = await source.readWindow(address, readFrom, coveredTo)
    if (isAbandoned()) return
    const rows = [...draft.rows.filter((r) => r.block_num < readFrom), ...window.rows]
    draft.rows = rows
    if (rows.length > budget.maxRows) throw new WalletTooBigError(budget.maxRows)
    reservation.release?.()
    reservation.release = budget.reserve(rows.length)
    reached("prices", countTransfers(rows))
    const { references, knownSamples, ethBalances, ethPayers, gasUnknown } = draft
    for (const block of references.keys()) if (block >= readFrom) references.delete(block)
    for (const block of knownSamples.keys()) if (block >= readFrom) knownSamples.delete(block)
    for (const block of ethBalances.keys()) if (block >= readFrom) ethBalances.delete(block)
    for (const block of ethPayers.keys()) if (block >= readFrom) ethPayers.delete(block)
    const missing = [...new Set(rows.map((r) => r.block_num))].filter((b) => !references.has(b))
    for (const reference of await source.readReferences(missing)) references.set(reference.blockNum, reference)
    draft.priced = window.priced ? [...draft.priced.filter((p) => p.block_num < readFrom), ...window.priced] : derivePricedRows(rows, [...references.values()])
    for (const [tx, block] of gasUnknown) if (block >= readFrom) gasUnknown.delete(tx)
    for (const { tx_hash, block_num } of window.gasUnknown) gasUnknown.set(tx_hash, block_num)
  }

  /** Each gas row's L1 fee, reading the ones that aren't settled, or that a claim's block needs current. */
  async function readNewL1Fees(rows: readonly LegRow[], { cached, unsettled, tip }: Plan): Promise<Map<string, L1Fee>> {
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
    return l1Fees
  }

  /** A transaction with only gas in it is what a note looks like. Anything near the tip could still change, so it's read again. */
  async function readNewNotes(address: string, rows: readonly LegRow[], { cached, fromBlock, coveredTo, unsettled, tip }: Plan): Promise<Pick<Cached, "notes" | "notesReadTo">> {
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
    return { notes, notesReadTo }
  }

  /**
   * Every asset's last good balance, and the last ETH balance that can be checked, which needs every fee and claim up to it known.
   * When the block of that one was just replaced, it's read again.
   */
  async function lastKnownBalances(address: string, draft: Draft, closing: BalanceSnapshot | null, fees: Pick<Cached, "l1Fees" | "staleFeeTxs">, { cached, coveredTo }: Plan): Promise<Pick<Cached, "lastBalances" | "lastCheckableEth">> {
    const lastBalances = { ...cached?.lastBalances }
    let lastCheckableEth = cached?.lastCheckableEth ?? null
    for (const [asset, amount] of Object.entries(closing?.amounts ?? {})) lastBalances[asset] = { blockNum: coveredTo, amount }
    const { rows, gasUnknown } = draft
    if (closing?.amounts.ETH !== undefined && gasUnknown.size === 0 && l1FeeRows(rows, fees.l1Fees).unknownTxs.length === 0 && !(rows.some(isUnwrapClaim) && settle({ ...draft, ...fees }).rows.some(isUnwrapClaim))) {
      lastCheckableEth = { blockNum: coveredTo, amount: closing.amounts.ETH }
    } else if (lastCheckableEth && lastCheckableEth.blockNum >= draft.replacedFrom) {
      // Its block was just replaced, so what it said may be gone. A failed read leaves it as it was, and the next refresh tries again.
      const { blockNum } = lastCheckableEth
      const amount = (await readBalances(address, blockNum))?.amounts.ETH
      if (amount !== undefined) lastCheckableEth = { blockNum, amount }
    }
    return { lastBalances, lastCheckableEth }
  }

  /** Current prices for what's held, from the oracle read, then its feed, then its market, and the market prices its movements need. */
  async function loadPrices(address: string, range: BlockRange, head: Head, chain: Head, wallet: Pick<Cached, "rows" | "opening" | "closing" | "lastBalances" | "priced" | "references" | "coveredTo">, latestReference: Reference | null, { unsettled }: Plan): Promise<Pick<Cached, "prices" | "marketChecked">> {
    const current = latestPrices(latestReference)
    if (unsettled !== null) pricing.forgetPricesFrom(unsettled)
    const heldAssets = assetsHeld(wallet)
    // At the head rather than at what's covered, like ETH's: a table that stops processing can't keep an old answer current.
    const currentBucket = bucketOf(head.blockNum, MARKET_HEAD_BUCKET_BLOCKS)
    Object.assign(current, feedPrices(range.to === undefined ? await pricing.loadFeedRounds(heldAssets, currentBucket) : await pricing.loadFixedFeedRounds(heldAssets, currentBucket, chain.blockNum), current))
    const { headBucket, unpriced, wanted } = marketWanted(wallet, wallet.priced, Math.min(wallet.coveredTo, head.blockNum), current)
    const marketRead = await pricing.loadMarket(wanted, { reads: chartReads(address, wallet.rows, wallet.opening), references: wallet.references, head: chain.blockNum })
    await pricing.loadTokenActivity(address, wallet.rows, chain.blockNum)
    // Once the tables are past a reorg, only `token_trades` can still hold it up, so it's asked even if this wallet needs none of it.
    const tokensBehind = reorgs.filter((reorg) => isPast(reorg, tablesSeen) && !isPast(reorg, pricing.tokensReached))
    if (tokensBehind.length > 0) await pricing.checkTokensPast(Math.min(...tokensBehind.map(({ oldTip }) => oldTip)), chain.blockNum)
    for (const asset of unpriced) {
      const price = pricing.marketAt(`${asset}:${headBucket}`)
      if (price) current[asset] = { micros: price.usdMicros, source: "market", blockNum: price.blockNum }
    }
    return { prices: current, marketChecked: marketRead && pricing.feedsLeftNoGap(heldAssets, current) }
  }

  /** Reads what's new since the last refresh, or the whole history the first time, and keeps it. */
  async function refresh(address: string, key: string, range: BlockRange, reservation: { release?: () => void }): Promise<Cached> {
    const isFirst = !wallets.has(key)
    const reached = (stage: ReadProgress["stage"], transfers: number | null = null) => {
      if (isFirst) firstReads.set(key, { stage, transfers })
    }
    reached("transfers")
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
    const reorgable = range.to !== undefined && cached !== undefined && (fixedMayChange(cached, chain) || unsettled !== null)
    const plan: Plan = { cached, fromBlock, coveredTo, tip: tipOf(range, coveredTo, chain), unsettled, reorgable }
    // Before the rows, so a read that finds the tables far enough along has what they've rewritten. It's a query, so only when there's a reorg to settle.
    const { to } = range
    const looksPast = to !== undefined && (unsettled !== null || (!cached && reorgs.some(({ from }) => from <= to)))
    const tablesReached = (to === undefined ? coveredTo : looksPast ? await source.processedThrough(coveredTo, chain.blockNum) : null) ?? cached?.tablesReached ?? coveredTo
    tablesSeen = Math.max(tablesSeen, tablesReached)

    const draft = draftOf(cached)
    let abandoned = false
    const readsBalances = coveredTo >= fromBlock
    const openingIsOld = readsBalances && (!isComplete(cached?.opening ?? null) || openingMayChange(cached, chain))
    const closingIsOld = readsBalances && (cached?.closing?.blockNum !== coveredTo || !isComplete(cached.closing) || reorgable)
    // None of these needs what another finds, so they're all asked for at once. They're all Amp queries, which take turns
    // (see `createTurns`), so they still run one after another, and this only saves the gaps between them.
    const rowsRead = readNewRows(address, draft, plan, reservation, () => abandoned, reached)
    const [, openingRead, closing, latestReference] = await Promise.all([
      rowsRead,
      openingIsOld ? readBalances(address, fromBlock - 1) : null,
      closingIsOld ? readBalances(address, coveredTo) : (cached?.closing ?? null),
      source.readLatestReference(head.blockNum),
    ]).catch(async (error: unknown) => {
      // The read's reservation is given back when this refresh ends, so it can't end with the rows still taking one.
      abandoned = true
      await rowsRead.catch(() => {})
      throw error
    })
    const { rows, priced, references, ethBalances } = draft

    const l1Fees = await readNewL1Fees(rows, plan)
    const notes = await readNewNotes(address, rows, plan)
    const staleFeeTxs = rows.filter((r) => r.kind === "gas" && !isL1FeeCurrent(l1Fees.get(r.tx_hash), r.block_num, plan.tip)).map((r) => r.tx_hash)
    const unreadEth = unwrapBalanceBlocks(rows).filter((block) => !ethBalances.has(block)).slice(0, MAX_ETH_BALANCES_PER_READ)
    await eth.readEthBalances(address, unreadEth, ethBalances)

    reached("checking", countTransfers(rows))
    const opening = mergeOpening(cached?.opening ?? null, openingRead)
    const openingReadAt = { ...cached?.openingReadAt }
    for (const asset of Object.keys(openingRead?.amounts ?? {})) openingReadAt[asset] = chain.blockNum
    const balances = readsBalances ? await lastKnownBalances(address, draft, closing, { l1Fees, staleFeeTxs }, plan) : { lastBalances: { ...cached?.lastBalances }, lastCheckableEth: cached?.lastCheckableEth ?? null }

    const samples = priceSamples ? await readSamples({ rows, latest: head, coveredTo, references }, draft.knownSamples) : null
    const priceFacts = await loadPrices(address, range, head, chain, { rows, opening, closing, lastBalances: balances.lastBalances, priced, references, coveredTo }, latestReference, plan)

    const next: Cached = { fromBlock, coveredTo, rows, priced, references, samples, ...priceFacts, latest: head, gasUnknown: draft.gasUnknown, opening, openingReadAt, readAtHead: chain.blockNum, tablesReached, closing, ...balances, l1Fees, staleFeeTxs, ethBalances, ethPayers: draft.ethPayers, ...notes }
    // This comes after the claims and the closing balance, because whether ETH adds up depends on both.
    const sendBlocks = eth.unreadSendBlocks(address, next).slice(0, MAX_ETH_BALANCES_PER_READ - unreadEth.length)
    await eth.readEthBalances(address, sendBlocks, ethBalances)
    await eth.findUnseenEth(address, next, MAX_ETH_BALANCES_PER_READ - unreadEth.length - sendBlocks.length)
    wallets.delete(key)
    wallets.set(key, next)
    if (wallets.size > maxWallets) wallets.delete(wallets.keys().next().value as string)
    return next
  }

  /** The last response worked out, with what it depended on that can change after a wallet's read, and what's been worked out from it. */
  let last: (CurrentResponse & { wallet: Cached; stamp: string }) | null = null

  /**
   * A wallet's response, worked out once while nothing it depends on has changed. A read needs it several times, and for a
   * busy wallet each one takes seconds. Only the last one is kept, because it's about as big as the wallet.
   */
  function currentOf(address: string, wallet: Cached) {
    const stamp = `${wallet.ethBalances.size}:${wallet.ethPayers.size}:${wallet.gasUnknown.size}:${wallet.references.size}:${pricing.revision}`
    if (last?.wallet !== wallet || last.stamp !== stamp) last = { wallet, stamp, response: responseOf(address, wallet) }
    return last
  }

  function responseOf(address: string, wallet: Omit<Cached, "openingReadAt" | "readAtHead" | "tablesReached">, use: (key: string) => boolean = () => true, rounds: ChartRounds = pricing.chartRounds): WalletData {
    const references = [...wallet.references.values()]
    const l1 = l1FeeRows(wallet.rows, wallet.l1Fees)
    const { opening, closing } = wallet
    const { rows: settled, priced, unseenEth } = settle(wallet)
    const rows = withUnseenEth(address, wallet, settled)
    const marketAt = (asset: string, block: number) => {
      const key = `${asset}:${bucketOf(block)}`
      return use(key) ? (pricing.marketAt(key)?.usdMicros ?? null) : null
    }
    // What's been read for its chart so far. A feed comes first, as for what's held now, so the last point doesn't jump.
    const marketMarks: MarketMarks = {}
    const feedMarks: FeedMarks = {}
    for (const read of chartReads(address, wallet.rows, opening)) {
      const fromFeed = feedMark(read, rounds, wallet.references)
      const micros = fromFeed ?? marketAt(read.asset, read.block)
      if (micros) (marketMarks[read.block] ??= {})[read.asset] = micros
      if (fromFeed) (feedMarks[read.block] ??= []).push(read.asset)
    }
    const openedAt = timestampOfBlock(wallet.fromBlock - 1, wallet.latest)
    const tokenPriceOf = (rows: readonly LegRow[]) => {
      const times = new Map(rows.map((row) => [row.block_num, row.timestamp]))
      return (token: string, block: number) => (use(marketKey({ asset: token, bucket: bucketOf(block) })) ? pricing.tokenPriceAt(token, block, times.get(block) as string) : null)
    }
    return {
      address,
      mode: source.mode,
      coverage: { fromBlock: wallet.fromBlock, toBlock: wallet.coveredTo },
      legs: [...(opening ? openingLegs(opening, openedAt) : []), ...buildPricedLegs({ account: address, rows, references, priced, market: marketAt, tokenPrice: tokenPriceOf(rows) })],
      references,
      prices: wallet.prices,
      latest: wallet.latest,
      gasUnknownTxs: [...wallet.gasUnknown.keys()],
      gasUnknownBlocks: [...wallet.gasUnknown.values()],
      unlisted: unlistedTokens(wallet.rows, address),
      ...NO_OTHER_TOKENS,
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
      ...(Object.keys(feedMarks).length > 0 ? { feedMarks } : {}),
      ...(wallet.samples ? { priceSamples: sampleBlocksOf(wallet).map((block) => wallet.samples?.get(block) ?? { blockNum: block, ethUsd: "", usdcUsd: "" }) } : {}),
    }
  }

  return {
    async get(address: string, range: BlockRange = {}): Promise<WalletData> {
      const account = address.toLowerCase()
      const key = keyOf(account, range)
      if (refused.has(key)) throw new WalletTooBigError(budget.maxRows)
      sweep()
      let pending = inflight.get(key)
      if (!pending) {
        const reservation: { release?: () => void } = {}
        pending = refresh(account, key, range, reservation)
          .catch((error: unknown) => {
            if (error instanceof WalletTooBigError) {
              wallets.delete(key)
              refused.add(key)
              if (refused.size > MAX_REFUSED) refused.delete(refused.keys().next().value as string)
            }
            throw error
          })
          .finally(() => {
            inflight.delete(key)
            firstReads.delete(key)
            otherTokens?.resume()
            reservation.release?.()
          })
        inflight.set(key, pending)
      }
      const wallet = await pending
      const { response } = currentOf(account, wallet)
      if (range.to !== undefined || !otherTokens) return response
      otherTokens.update(account, wallet.rows, wallet.gasUnknown, wallet.coveredTo, () => inflight.size > 0)
      return { ...response, ...otherTokens.view(account, wallet.rows, wallet.gasUnknown) }
    },

    /** How far this wallet's first read has got. A wallet that's been read has only its costs left, however long ago that was. */
    progress(address: string): ReadProgress {
      const key = keyOf(address.toLowerCase(), {})
      const read = wallets.get(key)
      return firstReads.get(key) ?? (read ? { stage: "costs", transfers: countTransfers(read.rows) } : { stage: "waiting", transfers: null })
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
        feedRounds: await pricing.loadFeedRounds(assetsHeld({ rows, opening: wallet.opening, closing, lastBalances }), bucketOf(through, MARKET_HEAD_BUCKET_BLOCKS)),
        chartRounds: pricing.chartRoundsNow(),
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
      const checked = await pricing.loadMarket(wanted)
      // Each rule reads a token's trades for itself, so one can be a read ahead, and a price only it has isn't the rule either.
      const tokenKeys = pricing.tokenPriceRows(address.toLowerCase(), facts.rows).filter((row) => pricing.tokenPriceAt(row.token, row.block_num, row.timestamp) !== null).map((row) => marketKey({ asset: row.token, bucket: bucketOf(row.block_num) }))
      return { priced: new Set([...wanted.map(({ asset, bucket }) => `${asset}:${bucket}`).filter((key) => pricing.marketAt(key)), ...tokenKeys]), checked }
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
      const current = { ...prices, ...pricing.marketPricesAt(through, using), ...feedPrices(facts.feedRounds, prices) }
      const response = responseOf(
        account,
        {
          ...facts,
          priced: own.priced.filter((p) => p.block_num <= through),
          references: new Map([...own.references].filter(([block]) => block <= through)),
          // Two rules are compared at one block, and a chart isn't part of that.
          samples: null,
          prices: current,
          marketChecked: using.checked && pricing.feedsLeftNoGap(assetsHeld(facts), current),
        },
        (key) => using.priced.has(key),
        facts.chartRounds,
      )
      return otherTokens ? { ...response, ...otherTokens.viewAt(account, own.rows, facts.gasUnknown, through) } : response
    },

    /**
     * A reorg replaced every block from `block` on, so forget them, however far back that is, and keep reading them until
     * the tables are past `tip`, the newest block the old chain is known to have reached, by as long as any reorg is re-read for. A wallet read that started before this finishes first. A wallet that held balances from before `block`
     * is read again from the start if the reorg reached them.
     */
    async rewind(block: number, tip: number): Promise<void> {
      pricing.reorged()
      refused.clear()
      reorgs.push({ from: block, oldTip: Math.max(tip, ...[...wallets.values()].flatMap((wallet) => [wallet.latest.blockNum, wallet.tablesReached]), pricing.tokensReached) })
      // Only a read after this one can say the tables are past it.
      tablesSeen = -1
      while (inflight.size > 0) await Promise.allSettled(inflight.values())
      pricing.forgetPricesFrom(block)
      pricing.forgetTokenTradesFrom(block)
      otherTokens?.forgetFrom(block)
      for (const [key, wallet] of wallets) {
        if (block <= wallet.fromBlock) wallets.delete(key)
        else if (block <= wallet.latest.blockNum) wallets.set(key, rewound(wallet, block))
      }
    },

    /** The first block a reorg replaced that this wallet's numbers can't be sure of yet, or null when they can. */
    unsettledFrom(address: string, range: BlockRange = {}): number | null {
      const wallet = wallets.get(keyOf(address.toLowerCase(), range))
      return wallet ? unsettledFrom(wallet, range) : null
    },

    /** What's already been read, with no query, or null when nothing has been. */
    peek(address: string): WalletData | null {
      const account = address.toLowerCase()
      const wallet = wallets.get(keyOf(account, {}))
      if (!wallet) return null
      const { response } = currentOf(account, wallet)
      return otherTokens ? { ...response, ...otherTokens.view(account, wallet.rows, wallet.gasUnknown) } : response
    },
  }
}
