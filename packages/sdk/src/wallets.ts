// Reads what a wallet is: its legs, what it held before them, what the chain says it holds now, and its L1 fees.
// Keeps each wallet's rows in memory: one full read, then only new blocks, because a wallet read scans the whole range.

import { describeError, type Logger } from "./amp.ts"
import { buildPricedLegs, derivePricedRows, type LegRow, type PricedRow, type Reference } from "./legs.ts"
import { latestPrices, type Head, type LatestPrices, type Mode, type WalletData } from "./portfolio.ts"
import type { ReadL1Fees } from "./receipts.ts"
import { openingLegs, type BalanceSnapshot } from "./reconcile.ts"
import { ASSETS } from "./tokens.ts"

export type WindowRows = { rows: LegRow[]; priced: PricedRow[] | null; gasUnknownTxs: string[] }

/** Where a wallet's rows come from. Everything after this doesn't care which one it was. */
export type Source = {
  mode: Mode
  /** The first block a wallet's history can start from, or null to count back from the head. */
  startBlock: number | null
  historyBlocks: number | null
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
}

/** Blocks to read, inclusive, where the source's defaults aren't wanted. `to` reads the wallet as of that block. */
export type WalletRange = { from?: number | undefined; to?: number | undefined }

/** Re-read this many blocks on each refresh, so a reorg near the tip replaces what it changed. */
const REORG_BLOCKS = 30
const MAX_WALLETS = 20
/** Base's block time, which is exact. */
const BLOCK_MS = 2000

type Cached = {
  fromBlock: number
  coveredTo: number
  rows: LegRow[]
  priced: PricedRow[]
  references: Map<number, Reference>
  prices: LatestPrices
  latest: Head
  gasUnknownTxs: Set<string>
  /** Before `fromBlock`. Fixed once read. */
  opening: BalanceSnapshot | null
  /** At `coveredTo`, the same block the rows reach, or the check would fail whenever a dataset is slightly behind. */
  closing: BalanceSnapshot | null
  /** Every asset's last successful read, because a failed read mustn't look like an empty wallet. */
  lastBalances: Record<string, { blockNum: number; amount: string }>
  /** L1 fees by transaction. See `isL1FeeSettled`. */
  l1Fees: Map<string, L1Fee>
}

type L1Fee = { blockNum: number; fee: string; readAtCoveredTo: number }

/**
 * A reorg can keep a transaction at the same height and still change its fee, because the block's L1 inputs changed.
 * So a fee is read when it's first seen, then once more when its block has left the part of the chain that's re-read
 * for reorgs. A transaction that moved to another block is read again straight away.
 */
function isL1FeeSettled(fee: L1Fee | undefined, blockNum: number, coveredTo: number): boolean {
  if (fee?.blockNum !== blockNum) return false
  return fee.readAtCoveredTo - blockNum >= REORG_BLOCKS || coveredTo - blockNum < REORG_BLOCKS
}

const isComplete = (snapshot: BalanceSnapshot | null) => snapshot !== null && ASSETS.every((asset) => snapshot.amounts[asset] !== undefined)

/** A read can fail for one asset and work for the rest. What's already known stays, and only what's missing gets filled in. */
function mergeOpening(known: BalanceSnapshot | null, read: BalanceSnapshot | null): BalanceSnapshot | null {
  if (!read) return known
  return { blockNum: read.blockNum, amounts: { ...read.amounts, ...known?.amounts } }
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

/** A block in the past, as if it were the head. Base's block time is exact, so its timestamp doesn't need a read. */
function headAsOf(head: Head, to: number | undefined): Head {
  if (to === undefined || to >= head.blockNum) return head
  return { blockNum: to, timestamp: new Date(new Date(head.timestamp).getTime() - (head.blockNum - to) * BLOCK_MS).toISOString() }
}

const keyOf = (address: string, { from, to }: WalletRange) => `${address.toLowerCase()}:${from ?? ""}:${to ?? ""}`

export function createWallets(source: Source, currentHead: () => Promise<Head>, readL1Fees: ReadL1Fees, logger: Logger = console) {
  const wallets = new Map<string, Cached>()
  const inflight = new Map<string, Promise<Cached>>()

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

  /** A wallet read as of a fixed block has no new block coming, so what it's still missing has to be read without one. */
  const isFinished = (wallet: Cached, head: Head) =>
    wallet.coveredTo >= head.blockNum && isComplete(wallet.opening) && isComplete(wallet.closing) && wallet.rows.every((r) => r.kind !== "gas" || isL1FeeSettled(wallet.l1Fees.get(r.tx_hash), r.block_num, wallet.coveredTo))

  async function refresh(address: string, key: string, range: WalletRange): Promise<Cached> {
    const head = headAsOf(await currentHead(), range.to)
    const cached = wallets.get(key)
    if (cached && cached.latest.blockNum >= head.blockNum && (range.to === undefined || isFinished(cached, head))) return cached

    const fromBlock = cached?.fromBlock ?? range.from ?? source.startBlock ?? Math.max(0, head.blockNum - (source.historyBlocks ?? 0))
    // Coverage only moves up to what's been processed. If it followed the chain, a table catching up later would
    // never be read for the blocks it skipped past.
    const processed = await source.processedThrough(cached?.coveredTo ?? fromBlock, head.blockNum)
    const coveredTo = processed ?? cached?.coveredTo ?? fromBlock - 1

    let rows = cached?.rows ?? []
    let priced = cached?.priced ?? []
    const known = new Map(cached?.references ?? [])
    const gasUnknownTxs = new Set(cached?.gasUnknownTxs ?? [])
    if (coveredTo >= fromBlock && (!cached || coveredTo > cached.coveredTo)) {
      const readFrom = cached ? Math.max(fromBlock, cached.coveredTo - REORG_BLOCKS + 1) : fromBlock
      const window = await source.readWindow(address, readFrom, coveredTo)
      rows = [...rows.filter((r) => r.block_num < readFrom), ...window.rows]
      for (const block of known.keys()) if (block >= readFrom) known.delete(block)
      const missing = [...new Set(rows.map((r) => r.block_num))].filter((b) => !known.has(b))
      for (const reference of await source.readReferences(missing)) known.set(reference.blockNum, reference)
      priced = window.priced ? [...priced.filter((p) => p.block_num < readFrom), ...window.priced] : derivePricedRows(rows, [...known.values()])
      for (const tx of window.gasUnknownTxs) gasUnknownTxs.add(tx)
    }

    const l1Fees = new Map(cached?.l1Fees ?? [])
    const unread = rows.filter((r) => r.kind === "gas" && !isL1FeeSettled(l1Fees.get(r.tx_hash), r.block_num, coveredTo))
    const fees = unread.length > 0 ? await readL1Fees(unread.map((r) => ({ txHash: r.tx_hash, blockNum: r.block_num }))) : new Map<string, string>()
    for (const { tx_hash, block_num } of unread) {
      const fee = fees.get(tx_hash)
      if (fee !== undefined) l1Fees.set(tx_hash, { blockNum: block_num, fee, readAtCoveredTo: coveredTo })
    }

    let opening = cached?.opening ?? null
    let closing = cached?.closing ?? null
    const lastBalances = { ...cached?.lastBalances }
    if (coveredTo >= fromBlock) {
      if (!isComplete(opening)) opening = mergeOpening(opening, await readBalances(address, fromBlock - 1))
      if (closing?.blockNum !== coveredTo || !isComplete(closing)) closing = await readBalances(address, coveredTo)
      for (const [asset, amount] of Object.entries(closing?.amounts ?? {})) lastBalances[asset] = { blockNum: coveredTo, amount }
    }

    const prices = latestPrices(await source.readLatestReference(head.blockNum))

    const next: Cached = { fromBlock, coveredTo, rows, priced, references: known, prices, latest: head, gasUnknownTxs, opening, closing, lastBalances, l1Fees }
    wallets.delete(key)
    wallets.set(key, next)
    if (wallets.size > MAX_WALLETS) wallets.delete(wallets.keys().next().value as string)
    return next
  }

  function responseOf(address: string, wallet: Cached): WalletData {
    const references = [...wallet.references.values()]
    const l1 = l1FeeRows(wallet.rows, wallet.l1Fees)
    const { opening, closing } = wallet
    const openedAt = new Date(new Date(wallet.latest.timestamp).getTime() - (wallet.latest.blockNum - wallet.fromBlock + 1) * BLOCK_MS).toISOString()
    return {
      address,
      mode: source.mode,
      coverage: { fromBlock: wallet.fromBlock, toBlock: wallet.coveredTo },
      legs: [...(opening ? openingLegs(opening, openedAt) : []), ...buildPricedLegs({ account: address, rows: [...wallet.rows, ...l1.rows], references, priced: wallet.priced })],
      references,
      prices: wallet.prices,
      latest: wallet.latest,
      gasUnknownTxs: [...wallet.gasUnknownTxs],
      l1FeeUnknownTxs: l1.unknownTxs,
      balances: closing,
      openingUnread: ASSETS.filter((asset) => opening?.amounts[asset] === undefined),
      lastBalances: Object.fromEntries(Object.entries(wallet.lastBalances).filter(([asset]) => closing?.amounts[asset] === undefined)),
      unreadBalances: wallet.coveredTo >= wallet.fromBlock ? ASSETS.filter((asset) => closing?.amounts[asset] === undefined) : [],
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

    /** What's already been read, with no query, or null when nothing has been. */
    peek(address: string): WalletData | null {
      const account = address.toLowerCase()
      const wallet = wallets.get(keyOf(account, {}))
      return wallet ? responseOf(account, wallet) : null
    },
  }
}
