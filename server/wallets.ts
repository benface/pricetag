// Keeps each wallet's rows in memory: one full read, then only new blocks, because a wallet read scans the whole range.

import type { Head, WalletResponse } from "../src/core/api.ts"
import { buildPricedLegs, derivePricedRows, answerToMicros, type LegRow, type PricedRow, type ReferenceRow } from "../src/core/legs.ts"
import type { LatestPrices } from "../src/core/portfolio.ts"
import { openingLegs, type BalanceSnapshot } from "../src/core/reconcile.ts"
import { describeError } from "./amp.ts"
import type { ReadL1Fees } from "./receipts.ts"
import type { Source } from "./source.ts"

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
  references: Map<number, ReferenceRow>
  prices: LatestPrices
  latest: Head
  gasUnknownTxs: Set<string>
  /** Before `fromBlock`. Fixed once read. */
  opening: BalanceSnapshot | null
  /** At `coveredTo`, the same block the rows reach, or the check would fail whenever a dataset is slightly behind. */
  closing: BalanceSnapshot | null
  /** L1 fees by transaction, each with the block it was read for, so a reorg that moves a transaction reads it again. */
  l1Fees: Map<string, { blockNum: number; fee: string }>
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

export function createWallets(source: Source, currentHead: () => Promise<Head>, readL1Fees: ReadL1Fees) {
  const wallets = new Map<string, Cached>()
  const inflight = new Map<string, Promise<Cached>>()

  // A failed check leaves positions unchecked, and it mustn't take the wallet down with it.
  async function readBalances(address: string, block: number): Promise<BalanceSnapshot | null> {
    if (block < 0) return { blockNum: block, amounts: {} }
    try {
      return await source.readBalances(address, block)
    } catch (error) {
      console.error("Balance read failed:", describeError(error))
      return null
    }
  }

  async function refresh(address: string): Promise<Cached> {
    const head = await currentHead()
    const cached = wallets.get(address)
    if (cached && cached.latest.blockNum >= head.blockNum) return cached

    const fromBlock = cached?.fromBlock ?? source.startBlock ?? Math.max(0, head.blockNum - (source.historyBlocks ?? 0))
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
      for (const reference of await source.readReferences(missing)) known.set(reference.block_num, reference)
      priced = window.priced ? [...priced.filter((p) => p.block_num < readFrom), ...window.priced] : derivePricedRows(rows, [...known.values()])
      for (const tx of window.gasUnknownTxs) gasUnknownTxs.add(tx)
    }

    const l1Fees = new Map(cached?.l1Fees ?? [])
    const unread = rows.filter((r) => r.kind === "gas" && l1Fees.get(r.tx_hash)?.blockNum !== r.block_num)
    const fees = unread.length > 0 ? await readL1Fees(unread.map((r) => ({ txHash: r.tx_hash, blockNum: r.block_num }))) : new Map<string, string>()
    for (const { tx_hash, block_num } of unread) {
      const fee = fees.get(tx_hash)
      if (fee !== undefined) l1Fees.set(tx_hash, { blockNum: block_num, fee })
    }

    let opening = cached?.opening ?? null
    let closing = cached?.closing ?? null
    if (coveredTo >= fromBlock) {
      opening ??= await readBalances(address, fromBlock - 1)
      if (closing?.blockNum !== coveredTo) closing = await readBalances(address, coveredTo)
    }

    // Without a recent read, the price is gone rather than old: an old one would quietly mark the position wrong.
    const latest = await source.readLatestReference(head.blockNum)
    const eth = answerToMicros(latest?.eth_usd)
    const usdc = answerToMicros(latest?.usdc_usd)
    const prices: LatestPrices = {}
    if (latest && eth) prices.ETH = { usdMicros: eth, source: "oracle", blockNum: latest.block_num }
    if (latest && usdc) prices.USDC = { usdMicros: usdc, source: "oracle", blockNum: latest.block_num }

    const next: Cached = { fromBlock, coveredTo, rows, priced, references: known, prices, latest: head, gasUnknownTxs, opening, closing, l1Fees }
    wallets.delete(address)
    wallets.set(address, next)
    if (wallets.size > MAX_WALLETS) wallets.delete(wallets.keys().next().value as string)
    return next
  }

  return {
    async get(address: string): Promise<WalletResponse> {
      const key = address.toLowerCase()
      let pending = inflight.get(key)
      if (!pending) {
        pending = refresh(key).finally(() => inflight.delete(key))
        inflight.set(key, pending)
      }
      const wallet = await pending
      const references = [...wallet.references.values()]
      const l1 = l1FeeRows(wallet.rows, wallet.l1Fees)
      const { opening, closing } = wallet
      const openedAt = new Date(new Date(wallet.latest.timestamp).getTime() - (wallet.latest.blockNum - wallet.fromBlock + 1) * BLOCK_MS).toISOString()
      return {
        address: key,
        mode: source.mode,
        coverage: { fromBlock: wallet.fromBlock, toBlock: wallet.coveredTo },
        legs: [...(opening ? openingLegs(opening, openedAt) : []), ...buildPricedLegs({ account: key, rows: [...wallet.rows, ...l1.rows], references, priced: wallet.priced })],
        references,
        prices: wallet.prices,
        latest: wallet.latest,
        gasUnknownTxs: [...wallet.gasUnknownTxs],
        l1FeeUnknownTxs: l1.unknownTxs,
        // Without the opening balances, the legs don't add up to a whole balance, so there's nothing to compare.
        balances: opening ? closing : null,
      }
    },
  }
}
