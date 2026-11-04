// Reads what a wallet is: its legs, what it held before them, what the chain says it holds now, and its L1 fees.
// Keeps each wallet's rows in memory: one full read, then only new blocks, because a wallet read scans the whole range.

import { describeError, type Logger } from "./amp.ts"
import { LAST_2S_BLOCK, blockBefore, timestampOfBlock } from "./chain.ts"
import { buildPricedLegs, derivePricedRows, oneWaySendBalanceBlocks, settleUnwraps, unwrapBalanceBlocks, type GasUnknownTx, type LegRow, type PricedRow, type Reference } from "./legs.ts"
import { MARKET_MAX_AGE_MS, marketPrice, type MarketPrice, type MarketTrade } from "./market.ts"
import type { CostNote } from "./notes.ts"
import { foldPositions, latestPrices, type Head, type LatestPrices } from "./portfolio.ts"
import type { ReadL1Fees } from "./receipts.ts"
import { openingLegs, type BalanceSnapshot } from "./reconcile.ts"
import { ASSETS, TOKENS, tokenByAddress } from "./tokens.ts"
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
  /** The cost notes this wallet published in these blocks: zero-value transactions from itself to itself. */
  readNotes?(address: string, blocks: readonly number[]): Promise<CostNote[]>
  /** Whether `readMarketTrades` can be trusted. An older dataset's `priced_legs` has wrong rows, so it can't. */
  marketReady?(): Promise<boolean>
  /** An asset's latest trades in a block range, newest first. Only a dataset's `priced_legs` has them. */
  readMarketTrades?(asset: string, from: number, to: number): Promise<MarketTrade[]>
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
  /** At `coveredTo`, the same block the rows reach, or the check would fail whenever a dataset is slightly behind. */
  closing: BalanceSnapshot | null
  /** Every asset's last successful read, because a failed read mustn't look like an empty wallet. */
  lastBalances: Record<string, { blockNum: number; amount: string }>
  /** L1 fees by transaction. See `isL1FeeSettled`. */
  l1Fees: Map<string, L1Fee>
  notes: CostNote[]
  /** Blocks already checked for notes, so each is only read once it's past the part of the chain re-read for reorgs. */
  notesReadTo: number
  /** Market prices were all read this time. */
  marketChecked: boolean
  /** Transactions whose fee is older than the balance read of their block. See `isL1FeeCurrent`. */
  staleFeeTxs: string[]
  /** Plain ETH at the end of the blocks `settleUnwraps` reads, when they've been worth reading. */
  ethBalances: Map<number, string>
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
 * What happened to a wallet up to one block, without what any of it was worth. Two pricing rules read through the same
 * facts can only differ by the rule, because what's held, what moved and what fees came to are all the same object.
 */
export type WalletFacts = Pick<Cached, "fromBlock" | "coveredTo" | "rows" | "latest" | "gasUnknown" | "opening" | "closing" | "lastBalances" | "l1Fees" | "staleFeeTxs" | "ethBalances" | "notes" | "notesReadTo" | "marketChecked">

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

/** A price at `through`, for what's held, and one for each movement a trade doesn't already price. */
function marketWanted({ rows, opening, closing, lastBalances }: Pick<Cached, "rows" | "opening" | "closing" | "lastBalances">, priced: readonly PricedRow[], through: number) {
  const headBucket = bucketOf(through, MARKET_HEAD_BUCKET_BLOCKS)
  const heldAssets = MARKET_ASSETS.filter((asset) => rows.some((r) => tokenByAddress(r.token)?.asset === asset) || [opening?.amounts[asset], closing?.amounts[asset], lastBalances[asset]?.amount].some((amount) => BigInt(amount ?? "0") > 0n))
  return { headBucket, heldAssets, wanted: [...heldAssets.map((asset) => ({ asset, bucket: headBucket })), ...marketNeeds(rows, priced).map(({ asset, block }) => ({ asset, bucket: bucketOf(block) }))] }
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

export function createWallets(source: Source, currentHead: () => Promise<Head>, readL1Fees: ReadL1Fees, logger: Logger = console) {
  const wallets = new Map<string, Cached>()
  const inflight = new Map<string, Promise<Cached>>()
  /** Prices by `<asset>:<bucket>`, null when too little trading backs one. A failed read isn't in here, so it's tried again. */
  const market = new Map<string, MarketPrice | null>()
  let marketReady: boolean | null = null

  /** Reads what's missing, and says whether everything asked for is now known. */
  async function loadMarket(wanted: readonly { asset: string; bucket: number }[]): Promise<boolean> {
    if (!source.readMarketTrades || !source.marketReady) return false
    try {
      marketReady ??= await source.marketReady()
    } catch (error) {
      logger.warn(`Market check failed: ${describeError(error)}`)
      return false
    }
    if (!marketReady) return false
    const missing = [...new Map(wanted.map((w) => [`${w.asset}:${w.bucket}`, w])).entries()].filter(([key]) => !market.has(key))
    for (const [key, { asset, bucket }] of missing.slice(0, MARKET_READS_PER_REFRESH)) {
      try {
        market.set(key, marketPrice(await source.readMarketTrades(asset, blockBefore(bucket, MARKET_MAX_AGE_MS), bucket), asset, bucket))
      } catch (error) {
        logger.warn(`Market read failed: ${describeError(error)}`)
        return false
      }
    }
    return missing.length <= MARKET_READS_PER_REFRESH
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
    unreadSendBlocks(address, wallet).length === 0

  async function refresh(address: string, key: string, range: WalletRange): Promise<Cached> {
    const chain = await currentHead()
    const head = headAsOf(chain, range.to)
    const cached = wallets.get(key)
    if (cached && (range.to === undefined ? cached.latest.blockNum >= head.blockNum : isFixedCurrent(address, cached, head, chain))) return cached

    const fromBlock = cached?.fromBlock ?? range.from ?? source.startBlock ?? Math.max(0, source.historyFrom?.(head.blockNum) ?? head.blockNum)
    // Coverage only moves up to what's been processed. If it followed the chain, a table catching up later would
    // never be read for the blocks it skipped past.
    const processed = await source.processedThrough(cached?.coveredTo ?? fromBlock, head.blockNum)
    const coveredTo = processed ?? cached?.coveredTo ?? fromBlock - 1
    const tip = tipOf(range, coveredTo, chain)
    const reorgable = range.to !== undefined && cached !== undefined && fixedMayChange(cached, chain)

    let rows = cached?.rows ?? []
    let priced = cached?.priced ?? []
    const known = new Map(cached?.references ?? [])
    const gasUnknown = new Map(cached?.gasUnknown ?? [])
    const ethBalances = new Map(cached?.ethBalances ?? [])
    if (coveredTo >= fromBlock && (!cached || coveredTo > cached.coveredTo || reorgable)) {
      const readFrom = cached ? Math.max(fromBlock, settledThrough(cached.coveredTo) + 1) : fromBlock
      const window = await source.readWindow(address, readFrom, coveredTo)
      rows = [...rows.filter((r) => r.block_num < readFrom), ...window.rows]
      for (const block of known.keys()) if (block >= readFrom) known.delete(block)
      for (const block of ethBalances.keys()) if (block >= readFrom) ethBalances.delete(block)
      const missing = [...new Set(rows.map((r) => r.block_num))].filter((b) => !known.has(b))
      for (const reference of await source.readReferences(missing)) known.set(reference.blockNum, reference)
      priced = window.priced ? [...priced.filter((p) => p.block_num < readFrom), ...window.priced] : derivePricedRows(rows, [...known.values()])
      for (const [tx, block] of gasUnknown) if (block >= readFrom) gasUnknown.delete(tx)
      for (const { tx_hash, block_num } of window.gasUnknown) gasUnknown.set(tx_hash, block_num)
    }

    const l1Fees = new Map(cached?.l1Fees ?? [])
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
    let notesReadTo = cached?.notesReadTo ?? fromBlock - 1
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
    if (coveredTo >= fromBlock) {
      if (!isComplete(opening) || openingMayChange(cached, chain)) {
        const read = await readBalances(address, fromBlock - 1)
        opening = mergeOpening(opening, read)
        for (const asset of Object.keys(read?.amounts ?? {})) openingReadAt[asset] = chain.blockNum
      }
      if (closing?.blockNum !== coveredTo || !isComplete(closing) || reorgable) closing = await readBalances(address, coveredTo)
      for (const [asset, amount] of Object.entries(closing?.amounts ?? {})) lastBalances[asset] = { blockNum: coveredTo, amount }
    }

    const prices = latestPrices(await source.readLatestReference(head.blockNum))

    const { headBucket, heldAssets, wanted } = marketWanted({ rows, opening, closing, lastBalances }, priced, Math.min(coveredTo, head.blockNum))
    const marketChecked = await loadMarket(wanted)
    for (const asset of heldAssets) {
      const price = market.get(`${asset}:${headBucket}`)
      if (price) prices[asset] = { micros: price.usdMicros, source: "market", blockNum: price.blockNum }
    }

    const next: Cached = { fromBlock, coveredTo, rows, priced, references: known, prices, latest: head, gasUnknown, opening, openingReadAt, readAtHead: chain.blockNum, closing, lastBalances, l1Fees, staleFeeTxs, ethBalances, notes, notesReadTo, marketChecked }
    // This comes after the claims and the closing balance, because whether ETH adds up depends on both.
    await readEthBalances(address, unreadSendBlocks(address, next).slice(0, MAX_ETH_BALANCES_PER_READ - unreadEth.length), ethBalances)
    wallets.delete(key)
    wallets.set(key, next)
    if (wallets.size > MAX_WALLETS) wallets.delete(wallets.keys().next().value as string)
    return next
  }

  function responseOf(address: string, wallet: Omit<Cached, "openingReadAt" | "readAtHead">, use: (key: string) => boolean = () => true): WalletData {
    const references = [...wallet.references.values()]
    const l1 = l1FeeRows(wallet.rows, wallet.l1Fees)
    const { opening, closing } = wallet
    const { rows, priced, unseenEth } = settleUnwraps({
      rows: [...wallet.rows, ...l1.rows],
      priced: wallet.priced,
      references,
      ethBalances: wallet.ethBalances,
      feeUnknownTxs: [...wallet.gasUnknown.keys(), ...l1.unknownTxs, ...wallet.staleFeeTxs],
      gasUnknownBlocks: [...wallet.gasUnknown.values()],
    })
    const marketAt = (asset: string, block: number) => {
      const key = `${asset}:${bucketOf(block)}`
      return use(key) ? (market.get(key)?.usdMicros ?? null) : null
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
      unlisted: unlistedTokens(wallet.rows, address),
      currency: "USD",
      rates: null,
      l1FeeUnknownTxs: l1.unknownTxs,
      balances: closing,
      openingUnread: ASSETS.filter((asset) => opening?.amounts[asset] === undefined),
      lastBalances: Object.fromEntries(Object.entries(wallet.lastBalances).filter(([asset]) => closing?.amounts[asset] === undefined)),
      unreadBalances: wallet.coveredTo >= wallet.fromBlock ? ASSETS.filter((asset) => closing?.amounts[asset] === undefined) : [],
      unseenEth,
      notes: wallet.notes,
      marketChecked: wallet.marketChecked,
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
      return {
        fromBlock: wallet.fromBlock,
        coveredTo: through,
        rows: wallet.rows.filter((r) => r.block_num <= through),
        latest: { blockNum: through, timestamp: timestampOfBlock(through, wallet.latest) },
        gasUnknown: wallet.gasUnknown,
        opening: wallet.opening,
        closing,
        lastBalances: Object.fromEntries(Object.entries(wallet.lastBalances).filter(([, last]) => last.blockNum <= through)),
        l1Fees: wallet.l1Fees,
        staleFeeTxs: wallet.staleFeeTxs,
        ethBalances: wallet.ethBalances,
        notes: wallet.notes.filter((n) => n.blockNum <= through),
        notesReadTo: Math.min(wallet.notesReadTo, through),
        marketChecked: wallet.marketChecked,
      }
    },

    /**
     * This source's own market prices for those facts, read now if they haven't been. Two rules can read a wallet either
     * side of a bucket, so what each read for itself may not be for the block they're compared at.
     */
    async marketOn(address: string, facts: WalletFacts): Promise<MarketOn> {
      const through = facts.coveredTo
      const priced = wallets.get(keyOf(address.toLowerCase(), {}))?.priced.filter((p) => p.block_num <= through) ?? []
      const { wanted } = marketWanted(facts, priced, through)
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
      return responseOf(
        account,
        {
          ...facts,
          priced: own.priced.filter((p) => p.block_num <= through),
          references: new Map([...own.references].filter(([block]) => block <= through)),
          // Market prices come from this source's own trades, like the rest of what's priced.
          prices: { ...prices, ...marketPricesAt(through, using) },
          marketChecked: using.checked,
        },
        (key) => using.priced.has(key),
      )
    },

    /** What's already been read, with no query, or null when nothing has been. */
    peek(address: string): WalletData | null {
      const account = address.toLowerCase()
      const wallet = wallets.get(keyOf(account, {}))
      return wallet ? responseOf(account, wallet) : null
    },
  }
}
