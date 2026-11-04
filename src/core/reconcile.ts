// Checks what a position's legs add up to against what the chain says the wallet holds, at the same block.
// This is what catches what we can't see without traces, like internal ETH transfers.

import type { PricedLeg } from "./legs.ts"
import { TOKENS } from "./tokens.ts"

/** Onchain balances at a block, by asset, in smallest units. An asset whose read failed isn't in `amounts`. */
export type BalanceSnapshot = { blockNum: number; amounts: Record<string, string> }

export type Onchain = {
  /** At the last block the legs cover. Null when it couldn't be read. */
  balances: BalanceSnapshot | null
  /** Transactions whose L1 fee couldn't be read yet, so computed ETH is too high by an unknown amount. */
  l1FeeUnknownTxs: readonly string[]
}

export type Reconciliation =
  | {
      status: "reconciled" | "incomplete"
      blockNum: number
      computedQty: string
      actualQty: string
      /** Actual minus computed. Above 0: more is onchain than the legs explain. */
      differenceQty: string
    }
  | { status: "unchecked"; reason: string }

export function reconcile(asset: string, computed: bigint, shortfall: bigint, { balances, l1FeeUnknownTxs }: Onchain): Reconciliation {
  const actual = balances?.amounts[asset]
  if (!balances || actual === undefined) return { status: "unchecked", reason: "The onchain balance couldn't be read." }
  // This clears on its own when the receipts can be read, so it isn't a reason to call the history incomplete.
  if (asset === "ETH" && l1FeeUnknownTxs.length > 0) {
    return { status: "unchecked", reason: `The L1 fee of ${l1FeeUnknownTxs.length === 1 ? "1 transaction" : `${l1FeeUnknownTxs.length} transactions`} couldn't be read yet.` }
  }
  const difference = BigInt(actual) - computed
  return {
    // Units left that never arrived, so something is missing even if the end balance happens to match.
    status: difference === 0n && shortfall === 0n ? "reconciled" : "incomplete",
    blockNum: balances.blockNum,
    computedQty: computed.toString(),
    actualQty: actual,
    differenceQty: difference.toString(),
  }
}

export const decimalsOf = (asset: string) => TOKENS.find((t) => t.symbol === asset)?.decimals ?? 18

/**
 * What the wallet already held before the first block read, as one leg per asset. What it paid for those units
 * happened before anything we can read, so their cost is unknown.
 */
export function openingLegs(opening: BalanceSnapshot, timestamp: string): PricedLeg[] {
  const firstBlock = opening.blockNum + 1
  return Object.entries(opening.amounts)
    .filter(([, amount]) => BigInt(amount) > 0n)
    .map(([asset, amount]) => ({
      id: `opening:${asset}`,
      opening: true,
      asset,
      delta: amount,
      decimals: decimalsOf(asset),
      kind: "transfer" as const,
      blockNum: opening.blockNum,
      timestamp,
      txHash: "",
      txIndex: -1,
      priceUsdMicros: null,
      priceSource: null,
      priceNote: `Already in this wallet before block ${firstBlock.toLocaleString("en-US")}, the first block read.`,
      costUsdMicros: null,
      proceedsUsdMicros: null,
      costLabel: "unknown" as const,
      parts: [],
    }))
}
