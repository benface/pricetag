// What a click on a number explains: a sentence for how it's worked out, and the legs behind it.

import { TOKENS, tokenByAddress, valuePosition, type LegEffect, type PnlPoint, type Position, type PricedLeg, type Totals } from "@pricetag/sdk/core"
import { formatAmount, formatPrice, formatSignedUsd, formatUsd, shortHash } from "./format.ts"

export type Metric = "amount" | "average" | "value" | "realized" | "unrealized" | "onchain"

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
  onchain: "Onchain check",
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
    else parts.push(`Adds ${amount} for ${formatUsd(leg.costUsdMicros as string)}`)
    return parts.join(". ")
  }
  const realized = diff(after.realizedUsdMicros, before.realizedUsdMicros)
  const unresolved = diff(after.unresolvedDisposedQty, before.unresolvedDisposedQty)
  const shortfall = diff(after.shortfallQty, before.shortfallQty)
  if (leg.kind === "gas") parts.push(leg.priceUsdMicros === null ? "Gas, with no price at this block" : `Gas: ${formatUsd(diff(after.gasUsdMicros, before.gasUsdMicros))} spent`)
  if (leg.kind === "swap") parts.push(leg.proceedsUsdMicros === null ? "Sold, but the proceeds have no usable value" : `Sold for ${formatUsd(leg.proceedsUsdMicros)}`)
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

/** Why what we saw and the chain might disagree, by which way they do. */
export function mismatchCause(asset: string, differenceQty: string): string {
  const difference = BigInt(differenceQty)
  if (difference === 0n) return "The end balance matches, but more left than arrived, so something moved that we can't see."
  if (asset === "ETH") {
    return difference > 0n
      ? "This wallet holds more ETH than its transactions explain. Most likely a contract sent it some, which we can't see yet."
      : "This wallet holds less ETH than its transactions explain. Most likely a contract turned WETH into ETH and sent it elsewhere, while we counted it as coming here."
  }
  return `This balance changed in a way ${asset}'s transfers don't show, as with a token whose balance adjusts by itself.`
}

/** The whole comparison, in words. */
function onchainLines({ asset, decimals, reconciliation, effects }: Position): string[] {
  if (reconciliation === null) return ["There's no onchain balance to compare this with."]
  if (reconciliation.status === "unchecked") {
    const held = reconciliation.heldIsCurrent || reconciliation.heldQty === null ? [] : ["The amount is the last balance read, plus what's moved since."]
    return [`Not checked. ${reconciliation.reason} PnL is unavailable until this balance is confirmed, which happens by itself.`, ...held]
  }
  const amount = (qty: string) => `${formatAmount(qty, decimals)} ${asset}`
  const block = reconciliation.blockNum.toLocaleString("en-US")
  if (reconciliation.status === "reconciled") {
    const opening = effects.some(({ leg }) => leg.opening) ? "what it already held, plus every transaction since," : "its transactions"
    return [`Matches the chain exactly: ${opening} add up to ${amount(reconciliation.actualQty)} at block ${block}.`]
  }
  const unconfirmed = effects.filter(({ leg }) => leg.unsettledCredit).map(({ leg }) => shortHash(leg.txHash))
  return [
    `Worked out from its transactions: ${amount(reconciliation.computedQty)}.`,
    `Onchain at block ${block}: ${amount(reconciliation.actualQty)}.`,
    `Difference: ${BigInt(reconciliation.differenceQty) > 0n ? "+" : ""}${amount(reconciliation.differenceQty)}.`,
    mismatchCause(asset, reconciliation.differenceQty),
    ...(unconfirmed.length > 0 ? [`We couldn't confirm how much ETH reached this wallet in: ${[...new Set(unconfirmed)].join(", ")}.`] : []),
    "Value uses the onchain balance. PnL is unavailable, because we know some of this wallet's activity is missing.",
  ]
}

/** The rows a leg nets together, or null when it's just one. */
export function describeNetting(leg: PricedLeg): string | null {
  if (leg.parts.length < 2) return null
  const rows = leg.parts.map((p) => {
    const token = tokenByAddress(p.token)
    const fee = p.kind === "gas" ? " gas" : p.kind === "l1_fee" ? " data fee" : ""
    return `${p.side === "credit" ? "+" : "−"}${formatAmount(p.amount, token?.decimals ?? 18)} ${token?.symbol ?? p.token}${fee}`
  })
  return `Nets ${leg.parts.length} rows: ${rows.join(", ")}`
}

export function explainMetric(position: Position, metric: Metric): Explanation {
  const { asset, decimals, values, state, price, effects, reconciliation } = position
  const unknown = BigInt(values.unknownCostQty) > 0n
  const qty = `${formatAmount(values.qty, decimals)} ${asset}`
  const unknownQty = `${formatAmount(values.unknownCostQty, decimals)} ${asset}`
  const priceLine = price
    ? `Current price: ${formatPrice(price.usdMicros)}, from the ${price.source} at block ${price.blockNum.toLocaleString("en-US")}.`
    : TOKENS.some((t) => t.symbol === asset && t.oracle)
      ? `There's no current price for ${asset}, because the latest oracle read failed or is too old. An old price would quietly be wrong.`
      : `There's no current price for ${asset}. Only ETH and USDC have an oracle so far.`
  const lines: string[] = []
  let value: string | null = null

  const incomplete = reconciliation?.status === "incomplete"
  const unconfirmed = reconciliation !== null && reconciliation.status !== "reconciled"
  if (unconfirmed && (metric === "average" || metric === "realized" || metric === "unrealized")) {
    return { title: `${asset}: ${METRIC_TITLES[metric]}`, value: null, lines: onchainLines(position), effects: [...effects].reverse() }
  }

  switch (metric) {
    case "onchain":
      value = reconciliation?.status === "reconciled" ? "✓ Reconciled" : incomplete ? "⚠ Incomplete" : "Not checked"
      lines.push(...onchainLines(position))
      break
    case "amount":
      value = qty
      lines.push(...onchainLines(position))
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
      if (values.valueUsdMicros) lines.push(`${qty} × that price.${incomplete ? " That's the onchain balance, because its transactions don't add up to it." : ""}`)
      break
    case "realized":
      value = values.realizedUsdMicros && formatSignedUsd(values.realizedUsdMicros)
      if (values.realizedUsdMicros === null) {
        const known = BigInt(state.resolvedDisposedQty) > 0n ? ` ${formatSignedUsd(state.realizedUsdMicros)} is the part that is known.` : ""
        lines.push(`${formatAmount(state.unresolvedDisposedQty, decimals)} ${asset} was sold or spent with an unknown cost or no price, so its gain can't be known.${known}`)
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

const showSigned = (micros: string | null) => (micros === null ? "unavailable" : formatSignedUsd(micros))

export function explainTotal(positions: readonly Position[], totals: Totals, metric: TotalMetric): Explanation {
  const value: string | null = {
    pnl: totals.pnlUsdMicros && formatSignedUsd(totals.pnlUsdMicros),
    value: totals.valueUsdMicros && formatUsd(totals.valueUsdMicros),
    realized: totals.realizedUsdMicros && formatSignedUsd(totals.realizedUsdMicros),
    unrealized: totals.unrealizedUsdMicros && formatSignedUsd(totals.unrealizedUsdMicros),
    gas: totals.gasUsdMicros && formatUsd(totals.gasUsdMicros),
  }[metric]
  const lines: string[] = []
  if (metric === "pnl") {
    if (value === null) lines.push("Everything here depends on an unknown cost or price, so there's no PnL to show. It isn't $0.")
    else lines.push(`Realized ${showSigned(totals.realizedUsdMicros)}, unrealized ${showSigned(totals.unrealizedUsdMicros)}, less ${totals.gasUsdMicros === null ? "gas that's unavailable" : `${formatUsd(totals.gasUsdMicros)} of gas`}.`)
  }
  for (const position of positions) {
    const v = position.values
    const part = {
      pnl: null,
      value: v.valueUsdMicros && BigInt(v.qty) > 0n ? formatUsd(v.valueUsdMicros) : null,
      realized: v.realizedUsdMicros && BigInt(position.state.resolvedDisposedQty) > 0n ? formatSignedUsd(v.realizedUsdMicros) : null,
      unrealized: v.unrealizedUsdMicros && BigInt(v.qty) > 0n ? formatSignedUsd(v.unrealizedUsdMicros) : null,
      gas: BigInt(position.state.gasUsdMicros) > 0n ? formatUsd(position.state.gasUsdMicros) : null,
    }[metric]
    if (part) lines.push(`${position.asset}: ${part}`)
  }
  if (metric === "gas") lines.push("Gas, plus the data fee each transaction pays to be posted to Ethereum.")
  if (totals.unpricedGas && (metric === "gas" || metric === "pnl")) lines.push("Some gas had no price at its block, so it isn't included.")
  const relevant = totals.excluded.filter(({ reason }) => {
    if (metric === "value") return reason === "no current price" || reason === "incomplete history" || reason === "balance couldn't be read"
    if (metric === "realized") return reason === "sold at an unknown cost" || reason === "doesn't match its onchain balance" || reason === "not checked against its onchain balance"
    if (metric === "unrealized") return reason !== "sold at an unknown cost"
    return metric === "pnl"
  })
  for (const { asset, reason } of relevant) lines.push(`Not included: ${asset} (${reason}).`)
  if (metric === "value") {
    for (const { asset, reconciliation } of positions) {
      if (reconciliation?.status === "unchecked" && !reconciliation.heldIsCurrent) lines.push(`${asset}'s value is an estimate, because its balance couldn't be read.`)
    }
  }
  return {
    title: TOTAL_TITLES[metric],
    value,
    lines,
    effects: positions
      .flatMap((p) => p.effects)
      .filter((e) => metric !== "gas" || e.leg.kind === "gas")
      .sort((a, b) => b.leg.blockNum - a.leg.blockNum || b.leg.txIndex - a.leg.txIndex),
  }
}

export function explainPoint(positions: readonly Position[], point: PnlPoint): Explanation {
  return {
    title: `Transaction ${shortHash(point.txHash as string)}`,
    value: point.pnlUsdMicros && formatSignedUsd(point.pnlUsdMicros),
    lines: [`Total PnL after this transaction.${point.excludedCount > 0 ? ` Leaves out ${point.excludedCount} unknown ${point.excludedCount === 1 ? "amount" : "amounts"}.` : ""}`],
    effects: positions.flatMap((p) => p.effects).filter((e) => e.leg.txHash === point.txHash),
  }
}
