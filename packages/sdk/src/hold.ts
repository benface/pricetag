// What a wallet would have made by simply holding ETH: the same money in and out, at the same moments, and nothing in between.
//
// Put in: whatever arrived from outside the wallet, at what it cost, at the moment that cost was paid. A transfer from a
// linked wallet carries its cost and dates with it. An exchange inside the wallet isn't put in, and neither is its fee.
// Each amount buys ETH at that moment's price. What left the wallet leaves the ETH too, at its value when it left.
//
// Only what came from an amount in that ETH can leave it. So a second fold follows those amounts through the wallet, by
// the same method, across exchanges too. To it, everything else has an unknown cost, whatever the wallet paid for it.
//
// So both sides count what left at its value when it left. Total PnL counts it at the cost it carried, because a transfer
// isn't a sale, so the wallet's side adds the gain that left with it, for whatever total PnL includes. Otherwise a wallet
// that only ever held ETH and sent some would lose to itself. When nothing else is missing, the difference is exactly
// what's held now, less what that ETH would be worth now.

import { applyLegTaking, emptyPosition, worth, type CostPiece, type FoldLeg, type PositionState } from "./fold.ts"
import type { PricedLeg } from "./legs.ts"
import { isUnconfirmed, type LatestPrices, type LegEffect, type MarkPrice, type PnlStatus, type Position, type Totals } from "./portfolio.ts"

const ETH_DECIMALS = 18

/**
 * complete: the two cover the same money, so they can be set against each other.
 * partial: each is true of what it covers, but they don't cover the same money, so there's no difference to show.
 * unavailable: what holding would have made can't be worked out.
 */
export type HoldStatus = "complete" | "partial" | "unavailable"

export type HoldUnavailable = "no current eth price" | "nothing known put in" | "left with no known value"

export type HoldComparison = {
  status: HoldStatus
  /** Why it's unavailable, and null otherwise. */
  unavailable: HoldUnavailable | null
  /** The wallet's total PnL, after network fees, plus `gainThatLeftMicros`. Null when nothing in it is known. */
  walletMicros: string | null
  /** What left the wallet was worth this much more than the cost it carried, which total PnL doesn't count. */
  gainThatLeftMicros: string
  /** The wallet's total PnL leaves something out. */
  walletLeavesOut: boolean
  /** `walletMicros` rests on a market price. */
  walletEstimated: boolean
  /** What holding ETH would have made. Null when it's unavailable. */
  holdMicros: string | null
  /** `walletMicros` less `holdMicros`. Only when complete. */
  differenceMicros: string | null
  /** What's known to have been put in. An amount with no known value isn't in it, and isn't counted as $0. */
  putInMicros: string
  /** What left the wallet, of what's known to have been put in, at its value when it left. */
  takenOutMicros: string
  /** The ETH holding would have left today, in its smallest unit. */
  ethQty: string
  /** What that ETH is worth today. Null when it's unavailable. */
  ethValueMicros: string | null
  /** Today's ETH price. */
  ethPriceMicros: string | null
  /** Movements in with no known value, or no ETH price at their moment. Never counted as $0. */
  unknownAmounts: number
  /** More left the wallet than holding would have had left to give. */
  ranOut: boolean
  /** `holdMicros` rests on a market price. */
  estimated: boolean
}

type AmountIn = { qty: bigint; micros: string | null; blockNum: number; estimated: boolean }

/** The parts of a cost and the units each one paid for. They add up to exactly the piece's units. */
function amountsOf(piece: CostPiece, blockNum: number): AmountIn[] {
  const estimated = BigInt(piece.estimatedCostMicros) > 0n
  const micros = piece.label === "unknown" ? null : piece.costMicros
  const total = micros === null ? 0n : BigInt(micros)
  if (!piece.paidAt || total === 0n) return [{ qty: BigInt(piece.qty), micros, blockNum, estimated }]
  let sum = 0n
  let given = 0n
  return piece.paidAt.flatMap((part) => {
    sum += BigInt(part.costMicros)
    const upTo = (sum * BigInt(piece.qty)) / total
    const qty = upTo - given
    given = upTo
    return BigInt(part.costMicros) > 0n ? [{ qty, micros: part.costMicros, blockNum: part.blockNum, estimated }] : []
  })
}

/**
 * What a credit puts in. An opening balance has no moment to convert at: all we know is that it was already there,
 * so even with a cost someone entered, it has no known value at any known time.
 */
function amountsIn(leg: PricedLeg): AmountIn[] {
  if (leg.opening) return [{ qty: BigInt(leg.delta), micros: null, blockNum: leg.blockNum, estimated: false }]
  if (leg.pieces) return leg.pieces.flatMap((piece) => amountsOf(piece, piece.acquiredBlock ?? leg.blockNum))
  return [{ qty: BigInt(leg.delta), micros: leg.costLabel === "unknown" ? null : leg.costMicros, blockNum: leg.blockNum, estimated: leg.estimated === true || leg.costLabel === "received at market" }]
}

/** What the comparison is made from, oldest first: everything that arrived or left, other than by an exchange or as a fee. */
export function holdEffects(positions: readonly Position[]): LegEffect[] {
  return positions
    .filter((p) => !p.noMarket)
    .flatMap((p) => p.effects)
    .filter(({ leg }) => leg.kind === "transfer")
    .sort((a, b) => a.leg.blockNum - b.leg.blockNum || a.leg.txIndex - b.leg.txIndex)
}

/** Whether total PnL includes this position. Any other's history can't be trusted, or isn't all there. */
const isInTotal = (position: Position) => {
  const { values, state, noMarket } = position
  return !noMarket && !isUnconfirmed(position) && values.realizedMicros !== null && BigInt(state.shortfallQty) === 0n && (BigInt(values.qty) === 0n || values.unrealizedMicros !== null)
}

/** The gain that left with what the wallet sent out, on what total PnL includes, and whether a market price says so. */
function gainThatLeft(positions: readonly Position[]): { micros: bigint; estimated: boolean } {
  let micros = 0n
  let estimated = false
  for (const position of positions.filter(isInTotal)) {
    for (const { leg, before, after } of position.effects) {
      const delta = BigInt(leg.delta)
      if (leg.kind !== "transfer" || delta >= 0n || leg.priceMicros === null) continue
      const known = -delta - (BigInt(after.transferredOutUnknownQty) - BigInt(before.transferredOutUnknownQty))
      if (known === 0n) continue
      micros += worth(known, BigInt(leg.priceMicros), leg.decimals) - (BigInt(after.transferredOutCostMicros) - BigInt(before.transferredOutCostMicros))
      estimated ||= leg.priceSource === "market"
    }
  }
  return { micros, estimated }
}

/** A leg for the second fold, where a known cost only means "this came from an amount in the ETH". */
const followed = (leg: PricedLeg, pieces?: CostPiece[]): FoldLeg => ({ id: leg.id, delta: leg.delta, decimals: leg.decimals, kind: "transfer", priceMicros: null, costMicros: null, proceedsMicros: null, costLabel: "unknown", blockNum: leg.blockNum, timestamp: leg.timestamp, ...(pieces ? { pieces } : {}) })

const followedPiece = (qty: bigint, inEth: boolean, acquiredBlock: number): CostPiece => ({ qty: qty.toString(), costMicros: inEth ? "0" : null, label: inEth ? "paid" : "unknown", estimatedCostMicros: "0", acquiredBlock, acquiredAt: "" })

/** `prices` and `markPrice` are in the currency the positions were folded in, and so is everything this returns. */
export function compareWithHoldingEth(positions: readonly Position[], totals: Totals, pnlStatus: PnlStatus, prices: LatestPrices, markPrice: MarkPrice): HoldComparison {
  const ethPrice = prices.ETH?.micros ?? null
  const ethAt = (blockNum: number) => {
    const price = markPrice(blockNum, "ETH")
    return price !== null && BigInt(price) > 0n ? BigInt(price) : null
  }
  const method = positions[0]?.state.method ?? "average"
  const states = new Map<string, PositionState>()
  /** The share of what each exchange gave up that came from an amount in the ETH, which is the share of what it got. */
  const exchanged = new Map<string, { inEth: bigint; qty: bigint }>()
  let eth = 0n
  let putIn = 0n
  let knownAmounts = 0
  let unknownAmounts = 0
  let takenOut = 0n
  let beyond = 0n
  let unvalued = false
  let estimated = false

  const legs = positions
    .filter((p) => !p.noMarket)
    .flatMap((p) => p.effects.map((e) => e.leg))
    // In chain order, with what left before what arrived, because what an exchange got depends on what it gave up.
    .sort((a, b) => a.blockNum - b.blockNum || a.txIndex - b.txIndex || Number(BigInt(a.delta) > 0n) - Number(BigInt(b.delta) > 0n))

  for (const leg of legs) {
    const state = states.get(leg.asset) ?? emptyPosition(method, leg.decimals)
    const delta = BigInt(leg.delta)
    if (delta > 0n) {
      const pieces: CostPiece[] = []
      if (leg.kind === "transfer") {
        let unknown = false
        for (const { qty, micros, blockNum, estimated: isEstimate } of amountsIn(leg)) {
          const price = ethAt(blockNum)
          const inEth = micros !== null && price !== null
          if (inEth) {
            eth += (BigInt(micros) * 10n ** BigInt(ETH_DECIMALS)) / price
            putIn += BigInt(micros)
            knownAmounts++
            estimated ||= isEstimate
          } else unknown = true
          if (qty > 0n) pieces.push(followedPiece(qty, inEth, blockNum))
        }
        if (unknown) unknownAmounts++
      } else {
        const gave = exchanged.get(leg.txHash)
        const qty = gave && gave.qty > 0n ? (delta * gave.inEth) / gave.qty : 0n
        if (qty > 0n) pieces.push(followedPiece(qty, true, leg.blockNum))
        if (delta > qty) pieces.push(followedPiece(delta - qty, false, leg.blockNum))
      }
      states.set(leg.asset, applyLegTaking(state, followed(leg, pieces)).state)
      continue
    }
    const { state: next, taken } = applyLegTaking(state, followed(leg))
    states.set(leg.asset, next)
    const inEth = taken.reduce((sum, piece) => (piece.costMicros === null ? sum : sum + BigInt(piece.qty)), 0n)
    if (leg.kind === "swap") {
      const qty = -delta
      const gave = exchanged.get(leg.txHash)
      // Different tokens can't be added up, and more than one left, so it goes by whichever has the smallest share.
      if (!gave || inEth * gave.qty < gave.inEth * qty) exchanged.set(leg.txHash, { inEth, qty })
    }
    if (leg.kind !== "transfer" || inEth === 0n) continue
    const price = ethAt(leg.blockNum)
    if (leg.priceMicros === null || price === null) {
      unvalued = true
      continue
    }
    const value = worth(inEth, BigInt(leg.priceMicros), leg.decimals)
    takenOut += value
    estimated ||= leg.priceSource === "market"
    const units = (value * 10n ** BigInt(ETH_DECIMALS)) / price
    if (units > eth) {
      // Holding would have run out here, so the rest couldn't have left, and isn't anything holding made.
      beyond += value - worth(eth, price, ETH_DECIMALS)
      eth = 0n
    } else eth -= units
  }

  const unavailable: HoldUnavailable | null = ethPrice === null ? "no current eth price" : unvalued ? "left with no known value" : knownAmounts === 0 ? "nothing known put in" : null
  const walletLeavesOut = pnlStatus !== "complete"
  const pnlEstimated = BigInt(totals.estimatedMicros) > 0n
  const facts = { walletLeavesOut, putInMicros: putIn.toString(), takenOutMicros: takenOut.toString(), ethPriceMicros: ethPrice, unknownAmounts, ranOut: beyond > 0n }
  if (unavailable !== null || ethPrice === null) return { ...facts, status: "unavailable", unavailable, walletMicros: totals.pnlMicros, gainThatLeftMicros: "0", walletEstimated: pnlEstimated, holdMicros: null, differenceMicros: null, ethQty: "0", ethValueMicros: null, estimated: false }

  const value = worth(eth, BigInt(ethPrice), ETH_DECIMALS)
  const gain = gainThatLeft(positions)
  const wallet = totals.pnlMicros === null ? null : BigInt(totals.pnlMicros) + gain.micros
  const hold = value + takenOut - beyond - putIn
  const complete = !walletLeavesOut && unknownAmounts === 0 && wallet !== null
  return {
    ...facts,
    status: complete ? "complete" : "partial",
    unavailable: null,
    walletMicros: wallet === null ? null : wallet.toString(),
    gainThatLeftMicros: gain.micros.toString(),
    walletEstimated: pnlEstimated || gain.estimated,
    holdMicros: hold.toString(),
    differenceMicros: complete ? (wallet - hold).toString() : null,
    ethQty: eth.toString(),
    ethValueMicros: value.toString(),
    estimated,
  }
}
