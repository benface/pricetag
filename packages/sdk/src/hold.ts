// What a wallet would have made by simply holding ETH: the same money in and out, at the same moments, and nothing in between.
//
// Put in: whatever arrived from outside the wallet, at what it cost, at the moment that cost was paid. A transfer from a
// linked wallet carries its cost and date with it. An exchange inside the wallet isn't put in, and neither is its fee.
// Each amount buys ETH at that moment's price. What left the wallet leaves the ETH too, at its value when it left.
//
// So both sides count what left at its value when it left. Total PnL counts it at the cost it carried, because a transfer
// isn't a sale, so the wallet's side adds the gain that left with it. Otherwise a wallet that only ever held ETH and sent
// some would lose to itself. When nothing else is missing, the difference is exactly what's held now, less what that ETH
// would be worth now.

import { worth } from "./fold.ts"
import type { PricedLeg } from "./legs.ts"
import type { LatestPrices, LegEffect, MarkPrice, PnlStatus, Position, Totals } from "./portfolio.ts"

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

type AmountIn = { micros: string | null; blockNum: number; estimated: boolean }

/**
 * What a credit puts in. An opening balance has no moment to convert at: all we know is that it was already there,
 * so even with a cost someone entered, it has no known value at any known time.
 */
function amountsIn(leg: PricedLeg): AmountIn[] {
  if (leg.opening) return [{ micros: null, blockNum: leg.blockNum, estimated: false }]
  if (leg.pieces) return leg.pieces.map((p) => ({ micros: p.label === "unknown" ? null : p.costMicros, blockNum: p.acquiredBlock ?? leg.blockNum, estimated: BigInt(p.estimatedCostMicros) > 0n }))
  return [{ micros: leg.costLabel === "unknown" ? null : leg.costMicros, blockNum: leg.blockNum, estimated: leg.estimated === true || leg.costLabel === "received at market" }]
}

/** What the comparison is made from, oldest first: everything that arrived or left, other than by an exchange or as a fee. */
export function holdEffects(positions: readonly Position[]): LegEffect[] {
  return positions
    .filter((p) => !p.noMarket)
    .flatMap((p) => p.effects)
    .filter(({ leg }) => leg.kind === "transfer")
    .sort((a, b) => a.leg.blockNum - b.leg.blockNum || a.leg.txIndex - b.leg.txIndex)
}

/** `prices` and `markPrice` are in the currency the positions were folded in, and so is everything this returns. */
export function compareWithHoldingEth(positions: readonly Position[], totals: Totals, pnlStatus: PnlStatus, prices: LatestPrices, markPrice: MarkPrice): HoldComparison {
  const ethPrice = prices.ETH?.micros ?? null
  const ethAt = (blockNum: number) => {
    const price = markPrice(blockNum, "ETH")
    return price !== null && BigInt(price) > 0n ? BigInt(price) : null
  }
  let eth = 0n
  let putIn = 0n
  let knownAmounts = 0
  let unknownAmounts = 0
  let takenOut = 0n
  let carried = 0n
  let beyond = 0n
  let unvalued = false
  let estimated = false

  for (const { leg, before, after } of holdEffects(positions)) {
    const delta = BigInt(leg.delta)
    if (delta > 0n) {
      let unknown = false
      for (const { micros, blockNum, estimated: isEstimate } of amountsIn(leg)) {
        const price = ethAt(blockNum)
        if (micros === null || price === null) {
          unknown = true
          continue
        }
        eth += (BigInt(micros) * 10n ** BigInt(ETH_DECIMALS)) / price
        putIn += BigInt(micros)
        knownAmounts++
        estimated ||= isEstimate
      }
      if (unknown) unknownAmounts++
      continue
    }
    // Only the part with a known cost came out of what's known to have been put in.
    const known = -delta - (BigInt(after.transferredOutUnknownQty) - BigInt(before.transferredOutUnknownQty))
    if (known === 0n) continue
    carried += BigInt(after.transferredOutCostMicros) - BigInt(before.transferredOutCostMicros)
    const price = ethAt(leg.blockNum)
    if (leg.priceMicros === null || price === null) {
      unvalued = true
      continue
    }
    const value = worth(known, BigInt(leg.priceMicros), leg.decimals)
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
  const facts = { walletLeavesOut, putInMicros: putIn.toString(), takenOutMicros: takenOut.toString(), ethPriceMicros: ethPrice, unknownAmounts, ranOut: beyond > 0n }
  if (unavailable !== null || ethPrice === null) return { ...facts, status: "unavailable", unavailable, walletMicros: totals.pnlMicros, gainThatLeftMicros: "0", holdMicros: null, differenceMicros: null, ethQty: "0", ethValueMicros: null, estimated: false }

  const value = worth(eth, BigInt(ethPrice), ETH_DECIMALS)
  const gainThatLeft = takenOut - carried
  const wallet = totals.pnlMicros === null ? null : BigInt(totals.pnlMicros) + gainThatLeft
  const hold = value + takenOut - beyond - putIn
  const complete = !walletLeavesOut && unknownAmounts === 0 && wallet !== null
  return {
    ...facts,
    status: complete ? "complete" : "partial",
    unavailable: null,
    walletMicros: wallet === null ? null : wallet.toString(),
    gainThatLeftMicros: gainThatLeft.toString(),
    holdMicros: hold.toString(),
    differenceMicros: complete ? (wallet - hold).toString() : null,
    ethQty: eth.toString(),
    ethValueMicros: value.toString(),
    estimated,
  }
}
