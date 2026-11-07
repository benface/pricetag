// What a wallet's read keeps between refreshes, and the facts about the chain every part of a read shares.

import { blockBefore } from "./chain.ts"
import type { EthPayer, LegRow, PricedRow, Reference } from "./legs.ts"
import type { CostNote } from "./notes.ts"
import type { Head, LatestPrices } from "./portfolio.ts"
import type { BalanceSnapshot } from "./reconcile.ts"
import { ASSETS } from "./tokens.ts"

/** Re-read this much of the chain on each refresh, so a reorg near the tip replaces what it changed. */
const REORG_MS = 60_000
/** The newest block past any reorg, seen from `tip`. */
export const settledThrough = (tip: number) => blockBefore(tip, REORG_MS)

export type Cached = {
  fromBlock: number
  coveredTo: number
  rows: LegRow[]
  priced: PricedRow[]
  references: Map<number, Reference>
  /** Oracle reads a chart can use between transactions, or null for a wallet that isn't asking for them. */
  samples: Map<number, Reference> | null
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

export type L1Fee = { blockNum: number; fee: string; readAtTip: number }

/**
 * A reorg, and the old chain's tip, which the tables have to get well past before a read is sure to have what replaced it.
 * Saying a reorg happened doesn't mean the tables have rewritten those blocks, and until they do a read gets the old ones
 * back, looking like any other read. A table builds on what's before it, so one past that tip has rewritten everything behind it.
 */
export type Reorg = { from: number; oldTip: number }

/**
 * A reorg can keep a transaction at the same height and still change its fee, because the block's L1 inputs changed.
 * So a fee is read when it's first seen, then once more when its block has left the part of the chain that's re-read
 * for reorgs. A transaction that moved to another block is read again straight away. `tip` is what that part of the
 * chain is measured from: see `tipOf`.
 */
export function isL1FeeSettled(fee: L1Fee | undefined, blockNum: number, tip: number): boolean {
  if (fee?.blockNum !== blockNum) return false
  return blockNum <= settledThrough(fee.readAtTip) || blockNum > settledThrough(tip)
}

/**
 * Whether a fee can explain a block's balance. Inside the part of the chain that's re-read, the balance is read again each
 * time, so a fee read earlier could be from before a reorg, and that difference would pass for ETH that never arrived.
 */
export function isL1FeeCurrent(fee: L1Fee | undefined, blockNum: number, tip: number): boolean {
  if (fee?.blockNum !== blockNum) return false
  return fee.readAtTip === tip || blockNum <= settledThrough(fee.readAtTip)
}

export const isComplete = (snapshot: BalanceSnapshot | null) => snapshot !== null && ASSETS.every((asset) => snapshot.amounts[asset] !== undefined)

/** A gas row's L1 fee, as a row of its own beside it. */
export function l1FeeRows(rows: readonly LegRow[], fees: Cached["l1Fees"]): { rows: LegRow[]; unknownTxs: string[] } {
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
