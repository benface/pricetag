// What a click on a number explains: a sentence for how it's worked out, and the legs behind it.

import { valuePosition } from "../core/fold.ts"
import type { LegEffect, Position, Totals } from "../core/portfolio.ts"
import { formatAmount, formatPrice, formatSignedUsd, formatUsd } from "./format.ts"

export type Metric = "amount" | "average" | "value" | "realized" | "unrealized"

export type Explanation = {
  title: string
  value: string | null
  lines: string[]
  effects: LegEffect[]
}

const METRIC_TITLES: Record<Metric, string> = {
  amount: "Amount",
  average: "Average cost",
  value: "Value",
  realized: "Realized PnL",
  unrealized: "Unrealized PnL",
}

function diff(after: string, before: string): bigint {
  return BigInt(after) - BigInt(before)
}

/** What a leg did to its position, in words. */
export function describeEffect({ leg, before, after }: LegEffect): string {
  const amount = `${formatAmount(leg.delta.replace("-", ""), leg.decimals)} ${leg.asset}`
  const parts: string[] = []
  if (BigInt(leg.delta) > 0n) {
    if (leg.costLabel === "unknown") parts.push(`Adds ${amount} at an unknown cost`)
    else parts.push(`Adds ${amount} at ${formatPrice(leg.unitCostUsdMicros as string)} each`)
    return parts.join(". ")
  }
  const realized = diff(after.realizedUsdMicros, before.realizedUsdMicros)
  const unresolved = diff(after.unresolvedDisposedQty, before.unresolvedDisposedQty)
  const shortfall = diff(after.shortfallQty, before.shortfallQty)
  if (leg.kind === "gas") parts.push(leg.priceUsdMicros === null ? "Gas, with no price at this block" : `Gas: ${formatUsd(diff(after.gasUsdMicros, before.gasUsdMicros))} spent`)
  if (leg.kind === "swap") parts.push(leg.priceUsdMicros === null ? "Sold, but the proceeds have no price" : `Sold at ${formatPrice(leg.priceUsdMicros)}`)
  if (leg.kind === "transfer") {
    const carried = diff(after.transferredOutCostUsdMicros, before.transferredOutCostUsdMicros)
    parts.push(`Sent out, carrying ${formatUsd(carried)} of known cost, with no gain or loss`)
  }
  if (leg.kind !== "transfer") {
    if (realized !== 0n) parts.push(`realized ${formatSignedUsd(realized)}`)
    if (unresolved > 0n) parts.push(`PnL unavailable on ${formatAmount(unresolved, leg.decimals)} ${leg.asset}`)
  }
  if (shortfall > 0n) parts.push(`${formatAmount(shortfall, leg.decimals)} ${leg.asset} more than we saw arrive`)
  return parts.join(", ")
}

export function explainMetric(position: Position, metric: Metric): Explanation {
  const { asset, decimals, values, state, price, effects } = position
  const unknown = BigInt(values.unknownCostQty) > 0n
  const qty = `${formatAmount(values.qty, decimals)} ${asset}`
  const unknownQty = `${formatAmount(values.unknownCostQty, decimals)} ${asset}`
  const priceLine = price
    ? `Current price: ${formatPrice(price.usdMicros)}, from the ${price.source} at block ${price.blockNum.toLocaleString("en-US")}.`
    : `There's no current price for ${asset}. Only ETH and USDC have an oracle so far.`
  const lines: string[] = []
  let value: string | null = null

  switch (metric) {
    case "amount":
      value = qty
      lines.push("What moved in the blocks this app has read. It isn't checked against the onchain balance yet.")
      if (BigInt(state.shortfallQty) > 0n) {
        lines.push(`${formatAmount(state.shortfallQty, decimals)} ${asset} left that we never saw arrive, so this wallet's history is incomplete.`)
      }
      break
    case "average":
      value = values.averageCostUsdMicros && formatPrice(values.averageCostUsdMicros)
      if (unknown) lines.push(`${unknownQty} of ${qty} has an unknown cost, so there's no average. It's never counted as $0.`)
      else if (values.costUsdMicros) lines.push(`${formatUsd(values.costUsdMicros)} of cost ÷ ${qty}, by ${state.method === "fifo" ? "FIFO" : "average cost"}.`)
      break
    case "value":
      value = values.valueUsdMicros && formatUsd(values.valueUsdMicros)
      lines.push(priceLine)
      if (values.valueUsdMicros) lines.push(`${qty} × that price.`)
      break
    case "realized":
      value = values.realizedUsdMicros && formatSignedUsd(values.realizedUsdMicros)
      if (values.realizedUsdMicros === null) {
        lines.push(`${formatAmount(state.unresolvedDisposedQty, decimals)} ${asset} was sold or spent with an unknown cost or no price, so its gain can't be known. ${formatSignedUsd(state.realizedUsdMicros)} is the part that is known.`)
      } else lines.push("Proceeds minus cost, on what was sold or spent on gas. Gas itself is a separate cost in the total.")
      break
    case "unrealized":
      value = values.unrealizedUsdMicros && formatSignedUsd(values.unrealizedUsdMicros)
      lines.push(priceLine)
      if (unknown) lines.push(`${unknownQty} of ${qty} has an unknown cost, so PnL is unavailable. It's never counted as $0.`)
      else if (values.costUsdMicros && values.valueUsdMicros) lines.push(`${formatUsd(values.valueUsdMicros)} value − ${formatUsd(values.costUsdMicros)} cost.`)
      break
  }
  return { title: `${asset}: ${METRIC_TITLES[metric]}`, value, lines, effects: [...effects].reverse() }
}

export type TotalMetric = "pnl" | "value" | "realized" | "unrealized" | "gas"

const TOTAL_TITLES: Record<TotalMetric, string> = {
  pnl: "Total PnL",
  value: "Total value",
  realized: "Total realized PnL",
  unrealized: "Total unrealized PnL",
  gas: "Gas paid",
}

export function explainTotal(positions: readonly Position[], totals: Totals, metric: TotalMetric): Explanation {
  const asUsd: string = {
    pnl: formatSignedUsd(totals.pnlUsdMicros),
    value: formatUsd(totals.valueUsdMicros),
    realized: formatSignedUsd(totals.realizedUsdMicros),
    unrealized: formatSignedUsd(totals.unrealizedUsdMicros),
    gas: formatUsd(totals.gasUsdMicros),
  }[metric]
  const lines: string[] = []
  if (metric === "pnl") lines.push(`${asUsd} = ${formatSignedUsd(totals.realizedUsdMicros)} realized ${BigInt(totals.unrealizedUsdMicros) < 0n ? "−" : "+"} ${formatUsd(BigInt(totals.unrealizedUsdMicros) < 0n ? -BigInt(totals.unrealizedUsdMicros) : totals.unrealizedUsdMicros)} unrealized − ${formatUsd(totals.gasUsdMicros)} gas.`)
  for (const position of positions) {
    const v = valuePosition(position.state, position.price?.usdMicros ?? null)
    const part = {
      pnl: null,
      value: v.valueUsdMicros && formatUsd(v.valueUsdMicros),
      realized: v.realizedUsdMicros && formatSignedUsd(v.realizedUsdMicros),
      unrealized: v.unrealizedUsdMicros && formatSignedUsd(v.unrealizedUsdMicros),
      gas: BigInt(position.state.gasUsdMicros) > 0n ? formatUsd(position.state.gasUsdMicros) : null,
    }[metric]
    if (part) lines.push(`${position.asset}: ${part}`)
  }
  if (metric === "gas") lines.push("L2 gas only. Amp's data doesn't have L1 data fees yet, so this is slightly low.")
  for (const { asset, reason } of totals.excluded) lines.push(`Not included: ${asset} (${reason}).`)
  return {
    title: TOTAL_TITLES[metric],
    value: asUsd,
    lines,
    effects: positions
      .flatMap((p) => p.effects)
      .filter((e) => metric !== "gas" || e.leg.kind === "gas")
      .sort((a, b) => b.leg.blockNum - a.leg.blockNum || b.leg.txIndex - a.leg.txIndex),
  }
}
