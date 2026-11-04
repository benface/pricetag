// Checks what a position's legs add up to against what the chain says the wallet holds, at the same block.
// This is what catches what we can't see without traces, like internal ETH transfers.

import type { PricedLeg } from "./legs.ts"
import { TOKENS } from "./tokens.ts"

/** Onchain balances at a block, by asset, in smallest units. An asset whose read failed isn't in `amounts`. */
export type BalanceSnapshot = { blockNum: number; amounts: Record<string, string> }

export type Onchain = {
  /** As read at the last block the legs cover. Null when the whole read failed. */
  balances: BalanceSnapshot | null
  /** Transactions whose L1 fee couldn't be read yet, so computed ETH is too high by an unknown amount. */
  l1FeeUnknownTxs: readonly string[]
  /** Assets whose balance before the first block couldn't be read, so their legs don't add up to a whole balance. */
  openingUnread?: readonly string[]
  /** The last balance read for each asset missing from `balances`, so a failed read can't make a holding disappear. */
  lastBalances?: Readonly<Record<string, { blockNum: number; amount: string }>>
  /** Assets missing from `balances`. Without a read, we can't say they're zero. */
  unreadBalances?: readonly string[]
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
  | {
      status: "unchecked"
      reason: string
      /** The best known amount, when it doesn't have to come from the legs alone. */
      heldQty: string | null
      /** True when `heldQty` is what the chain says right now, rather than the last read plus what moved since. */
      heldIsCurrent: boolean
    }

/** The last read, plus what's moved since. It can't be below zero, whatever the legs say. */
export function estimateHeld(last: { blockNum: number; amount: string }, legs: readonly PricedLeg[]): bigint {
  const held = legs.filter((leg) => leg.blockNum > last.blockNum).reduce((sum, leg) => sum + BigInt(leg.delta), BigInt(last.amount))
  return held > 0n ? held : 0n
}

export function reconcile(asset: string, legs: readonly PricedLeg[], shortfall: bigint, { balances, l1FeeUnknownTxs, openingUnread, lastBalances }: Onchain): Reconciliation {
  const actual = balances?.amounts[asset]
  if (!balances || actual === undefined) {
    const last = lastBalances?.[asset]
    return { status: "unchecked", reason: "The onchain balance couldn't be read.", heldQty: last ? estimateHeld(last, legs).toString() : null, heldIsCurrent: false }
  }
  if (openingUnread?.includes(asset)) {
    return { status: "unchecked", reason: "What this wallet held before the first block read couldn't be read.", heldQty: actual, heldIsCurrent: true }
  }
  // This clears when the receipts can be read, so it isn't a reason to call the history incomplete. Nor is it a match.
  if (asset === "ETH" && l1FeeUnknownTxs.length > 0) {
    return { status: "unchecked", reason: `The network fee of ${l1FeeUnknownTxs.length === 1 ? "1 transaction" : `${l1FeeUnknownTxs.length} transactions`} couldn't be read yet.`, heldQty: actual, heldIsCurrent: true }
  }
  // The sum of what moved, not the fold's amount: the fold stops at zero, and what left beyond that still happened.
  const computed = legs.reduce((sum, leg) => sum + BigInt(leg.delta), 0n)
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
      priceMicros: null,
      priceSource: null,
      priceNote: `Already in this wallet before block ${firstBlock.toLocaleString("en-US")}, the first block read.`,
      costMicros: null,
      proceedsMicros: null,
      costLabel: "unknown" as const,
      parts: [],
    }))
}
