// What a click on a number explains: a sentence for how it's worked out, and the legs behind it.

import { TOKENS, foldPositions, pnlOverTime, sumTotals, tokenByAddress, unconfirmedAssets, unreadAssets, type LegEffect, type Method, type PnlPoint, type Position, type PricedLeg, type Totals } from "@pricetag/sdk/core"
import type { WalletResponse } from "./api.ts"
import { CURRENCIES, usdView, type CurrencyCode, type WalletView } from "./currency.ts"
import { formatAmount, formatMoney, formatPrice, formatRate, formatSignedMoney, shortHash } from "./format.ts"
import { AVERAGE_PRICE_PAID, BALANCE_CHECK, CHECK_LABELS, METHOD_LABELS, NETWORK_FEES, currentPriceSource, tokenLabel } from "./wording.ts"

export type Metric = "amount" | "average" | "value" | "realized" | "unrealized" | "onchain"

export type Explanation = {
  /** What `value` and the effects' amounts are in. */
  currency: CurrencyCode
  title: string
  value: string | null
  /** The same number in USD, when that isn't what `value` is in. */
  sourceValue: string | null
  lines: string[]
  effects: LegEffect[]
}

const METRIC_TITLES: Record<Metric, string> = {
  amount: "Amount",
  average: AVERAGE_PRICE_PAID,
  value: "Value",
  realized: "Realized PnL",
  unrealized: "Unrealized PnL",
  onchain: BALANCE_CHECK,
}

function diff(after: string, before: string): bigint {
  return BigInt(after) - BigInt(before)
}

/** Where a wallet's numbers are explained from: what's on screen, and its USD facts to show beside them. */
export type ExplainContext = {
  view: Pick<WalletView, "currency" | "latestRate" | "missingRateTxs">
  source: { positions: Position[]; totals: Totals; points: PnlPoint[] } | null
}

/** Explaining a USD number: there's nothing to convert, and nothing to say about rates. */
export const USD_CONTEXT: ExplainContext = { view: { currency: "USD", latestRate: null, missingRateTxs: [] }, source: null }

export function explainContext(wallet: WalletResponse, view: WalletView, method: Method): ExplainContext {
  if (view.currency === "USD") return { view, source: null }
  const usd = usdView(wallet)
  const positions = foldPositions(usd.legs, method, usd.prices, wallet)
  const unread = unreadAssets(positions, wallet)
  return { view, source: { positions, totals: sumTotals(positions, unread), points: pnlOverTime(usd.legs, method, usd.prices, usd.markPrice, wallet.latest, unconfirmedAssets(positions, unread)) } }
}

/** Where a currency's rates come from, in words. It's said wherever a rate is used, since it isn't the source of the prices. */
export function rateSource(currency: CurrencyCode): string {
  return `Chainlink's ${CURRENCIES[currency].feed?.pair} price on Base`
}

const inUsd = (value: string | null | undefined) => (value ? `${value} USD` : null)

/** What a leg was in USD and the rate that converted it, or null when it's in USD. */
export function describeConversion(leg: PricedLeg, currency: CurrencyCode): string | null {
  const { conversion } = leg
  if (!conversion) return null
  const amounts = [
    conversion.priceUsdMicros !== null ? `${formatPrice(conversion.priceUsdMicros, "USD")} each` : null,
    conversion.costUsdMicros !== null ? `${formatMoney(conversion.costUsdMicros, "USD")} paid` : null,
    conversion.proceedsUsdMicros !== null ? `${formatMoney(conversion.proceedsUsdMicros, "USD")} received` : null,
  ].filter((part) => part !== null)
  const usd = amounts.length > 0 ? `In USD: ${amounts.join(", ")}.` : ""
  if (conversion.rateMicros === null) return `⚠ No USD to ${currency} rate for this transaction, so it has no ${currency} value. ${usd}`.trim()
  return `${usd} 1 USD = ${formatRate(conversion.rateMicros, currency)} ${currency} at this block, from ${rateSource(currency)}.`.trim()
}

/** What's special about reading a number in this currency, or nothing in USD. */
function exchangeLines({ currency, latestRate, missingRateTxs }: ExplainContext["view"], uses: "past" | "current" | "both"): string[] {
  if (currency === "USD") return []
  const lines: string[] = []
  if (uses !== "current") lines.push(`Each transaction is converted at the USD to ${currency} rate when it happened, from ${rateSource(currency)}.`)
  if (uses !== "past") {
    if (latestRate) lines.push(`Current values use the current rate: 1 USD = ${formatRate(latestRate.rateMicros, currency)} ${currency} at block ${latestRate.blockNum.toLocaleString("en-US")}, from ${rateSource(currency)}.`)
    else lines.push(`There's no current USD to ${currency} rate, so what's held has no current value. An old rate would quietly be wrong.`)
  }
  if (uses !== "current" && missingRateTxs.length > 0) lines.push(missingRatesLine(missingRateTxs.length, currency))
  return lines
}

export function missingRatesLine(count: number, currency: CurrencyCode): string {
  return `${count === 1 ? "1 transaction has" : `${count.toLocaleString("en-US")} transactions have`} no USD to ${currency} rate, so what depends on ${count === 1 ? "it" : "them"} is unavailable in ${currency}.`
}

/** What a leg did to its position, in words. */
export function describeEffect({ leg, before, after }: LegEffect, currency: CurrencyCode): string {
  const money = (micros: string | bigint) => formatMoney(micros, currency)
  const signed = (micros: string | bigint) => formatSignedMoney(micros, currency)
  const amount = `${formatAmount(leg.delta.replace("-", ""), leg.decimals)} ${leg.asset}`
  const parts: string[] = []
  if (BigInt(leg.delta) > 0n) {
    if (leg.costLabel === "unknown") parts.push(`Adds ${amount} at an unknown cost`)
    else parts.push(`Adds ${amount} for ${money(leg.costMicros as string)}`)
    return parts.join(". ")
  }
  const realized = diff(after.realizedMicros, before.realizedMicros)
  const unresolved = diff(after.unresolvedDisposedQty, before.unresolvedDisposedQty)
  const shortfall = diff(after.shortfallQty, before.shortfallQty)
  if (leg.kind === "gas") parts.push(leg.priceMicros === null ? "Network fee, with no price at this block" : `Network fee: ${money(diff(after.gasMicros, before.gasMicros))} spent`)
  if (leg.kind === "swap") parts.push(leg.proceedsMicros === null ? "Sold, but what you received has no usable value" : `Sold for ${money(leg.proceedsMicros)}`)
  if (leg.kind === "transfer") {
    const carried = diff(after.transferredOutCostMicros, before.transferredOutCostMicros)
    parts.push(`Sent out with ${money(carried)} of known cost, so no gain or loss`)
  }
  if (leg.kind !== "transfer") {
    if (realized !== 0n) parts.push(`realized ${signed(realized)}`)
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
      : "This wallet holds less ETH than its transactions explain. Most likely a contract turned wrapped ETH into ETH and sent it elsewhere, while we counted it as coming here."
  }
  return `This balance changed in a way ${asset}'s transfers don't show, as with a token whose balance adjusts by itself.`
}

/** The whole comparison, in words. */
function onchainLines({ asset, decimals, reconciliation, effects }: Position): string[] {
  if (reconciliation === null) return ["There's no actual balance to compare this with."]
  if (reconciliation.status === "unchecked") {
    const held = reconciliation.heldIsCurrent || reconciliation.heldQty === null ? [] : ["The amount is the last balance read, plus what's moved since."]
    return [`Not checked. ${reconciliation.reason} PnL is unavailable until this balance is confirmed, which happens by itself.`, ...held]
  }
  const amount = (qty: string) => `${formatAmount(qty, decimals)} ${asset}`
  const block = reconciliation.blockNum.toLocaleString("en-US")
  if (reconciliation.status === "reconciled") {
    const opening = effects.some(({ leg }) => leg.opening) ? "what it already held, plus every transaction since," : "its transactions"
    return [`Matches the actual balance exactly: ${opening} add up to ${amount(reconciliation.actualQty)} at block ${block}.`]
  }
  const unconfirmed = effects.filter(({ leg }) => leg.unsettledCredit).map(({ leg }) => shortHash(leg.txHash))
  return [
    `Worked out from its transactions: ${amount(reconciliation.computedQty)}.`,
    `Actual balance at block ${block}: ${amount(reconciliation.actualQty)}.`,
    `Difference: ${BigInt(reconciliation.differenceQty) > 0n ? "+" : ""}${amount(reconciliation.differenceQty)}.`,
    mismatchCause(asset, reconciliation.differenceQty),
    ...(unconfirmed.length > 0 ? [`We couldn't confirm how much ETH reached this wallet in: ${[...new Set(unconfirmed)].join(", ")}.`] : []),
    "Value uses the actual balance. PnL is unavailable, because we know some of this wallet's activity is missing.",
  ]
}

/** The rows a leg nets together, or null when it's just one. */
export function describeNetting(leg: PricedLeg): string | null {
  if (leg.parts.length < 2) return null
  const rows = leg.parts.map((p) => {
    const token = tokenByAddress(p.token)
    const fee = p.kind === "gas" ? " network fee" : p.kind === "l1_fee" ? " Ethereum fee" : ""
    return `${p.side === "credit" ? "+" : "−"}${formatAmount(p.amount, token?.decimals ?? 18)} ${tokenLabel(token?.symbol ?? p.token)}${fee}`
  })
  return `Combines ${leg.parts.length} movements: ${rows.join(", ")}`
}

export function explainMetric(position: Position, metric: Metric, context: ExplainContext): Explanation {
  const { view, source } = context
  const { currency } = view
  const money = (micros: string | bigint) => formatMoney(micros, currency)
  const signed = (micros: string | bigint) => formatSignedMoney(micros, currency)
  const { asset, decimals, values, state, price, effects, reconciliation } = position
  const unknown = BigInt(values.unknownCostQty) > 0n
  const qty = `${formatAmount(values.qty, decimals)} ${asset}`
  const unknownQty = `${formatAmount(values.unknownCostQty, decimals)} ${asset}`
  const priceLine = price
    ? `Current price: ${formatPrice(price.micros, currency)}${price.usdMicros ? ` (${formatPrice(price.usdMicros, "USD")} USD)` : ""}, from ${currentPriceSource(price.source)} at block ${price.blockNum.toLocaleString("en-US")}.`
    : currency !== "USD" && !view.latestRate
      ? `There's no current USD to ${currency} rate, so ${asset} has no current value here.`
      : TOKENS.some((t) => t.symbol === asset && t.oracle)
      ? `There's no current price for ${asset}, because the market price feed's latest answer failed or is too old. An old price would quietly be wrong.`
      : `There's no current price for ${asset}. Only ETH and USDC have a market price feed so far.`
  const lines: string[] = []
  let value: string | null = null

  const incomplete = reconciliation?.status === "incomplete"
  const unconfirmed = reconciliation !== null && reconciliation.status !== "reconciled"
  if (unconfirmed && (metric === "average" || metric === "realized" || metric === "unrealized")) {
    return { currency, title: `${asset}: ${METRIC_TITLES[metric]}`, value: null, sourceValue: null, lines: onchainLines(position), effects: [...effects].reverse() }
  }

  switch (metric) {
    case "onchain":
      value = reconciliation?.status === "reconciled" ? `✓ ${CHECK_LABELS.reconciled}` : incomplete ? `⚠ ${CHECK_LABELS.incomplete}` : CHECK_LABELS.unchecked
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
      value = values.averageCostMicros && formatPrice(values.averageCostMicros, currency)
      if (unknown) lines.push(`${unknownQty} of ${qty} has an unknown cost, so there's no average. It's never counted as zero.`)
      else if (values.costMicros) lines.push(`${money(values.costMicros)} of cost ÷ ${qty}, using the ${METHOD_LABELS[state.method]} method.`)
      break
    case "value":
      value = values.valueMicros && money(values.valueMicros)
      lines.push(priceLine)
      if (values.valueMicros) lines.push(`${qty} × that price.${incomplete ? " That's the actual balance, because its transactions don't add up to it." : ""}`)
      break
    case "realized":
      value = values.realizedMicros && signed(values.realizedMicros)
      if (values.realizedMicros === null) {
        const known = BigInt(state.resolvedDisposedQty) > 0n ? ` ${signed(state.realizedMicros)} is the part that is known.` : ""
        lines.push(`${formatAmount(state.unresolvedDisposedQty, decimals)} ${asset} was sold or spent with an unknown cost or no price, so its gain can't be known.${known}`)
      } else lines.push("What you received minus what it cost, on what was sold or spent on network fees. The fees themselves are a separate cost in the total.")
      break
    case "unrealized":
      value = values.unrealizedMicros && signed(values.unrealizedMicros)
      lines.push(priceLine)
      if (unknown) lines.push(`${unknownQty} of ${qty} has an unknown cost, so PnL is unavailable. It's never counted as zero.`)
      else if (values.costMicros && values.valueMicros) lines.push(`${money(values.valueMicros)} value − ${money(values.costMicros)} cost.`)
      break
  }
  const isMoney = metric !== "amount" && metric !== "onchain"
  if (isMoney) lines.push(...exchangeLines(view, metric === "value" ? "current" : metric === "unrealized" ? "both" : "past"))
  const usd = source?.positions.find((p) => p.asset === asset)
  return {
    currency,
    title: `${asset}: ${METRIC_TITLES[metric]}`,
    value,
    sourceValue: usd && isMoney ? inUsd(explainMetric(usd, metric, USD_CONTEXT).value) : null,
    lines,
    effects: [...effects].reverse(),
  }
}

export type TotalMetric = "pnl" | "value" | "realized" | "unrealized" | "gas"

const TOTAL_TITLES: Record<TotalMetric, string> = {
  pnl: "Total PnL",
  value: "Total value",
  realized: "Total realized PnL",
  unrealized: "Total unrealized PnL",
  gas: NETWORK_FEES,
}

export function explainTotal(positions: readonly Position[], totals: Totals, metric: TotalMetric, context: ExplainContext): Explanation {
  const { view, source } = context
  const { currency } = view
  const money = (micros: string | bigint) => formatMoney(micros, currency)
  const signed = (micros: string | bigint) => formatSignedMoney(micros, currency)
  const showSigned = (micros: string | null) => (micros === null ? "unavailable" : signed(micros))
  const value: string | null = {
    pnl: totals.pnlMicros && signed(totals.pnlMicros),
    value: totals.valueMicros && money(totals.valueMicros),
    realized: totals.realizedMicros && signed(totals.realizedMicros),
    unrealized: totals.unrealizedMicros && signed(totals.unrealizedMicros),
    gas: totals.gasMicros && money(totals.gasMicros),
  }[metric]
  const lines: string[] = []
  if (metric === "pnl") {
    if (value === null) lines.push("Everything here depends on an unknown cost or price, so there's no PnL to show. It isn't zero.")
    else lines.push(`Realized ${showSigned(totals.realizedMicros)}, unrealized ${showSigned(totals.unrealizedMicros)}, less ${totals.gasMicros === null ? "network fees that are unavailable" : `${money(totals.gasMicros)} of network fees`}.`)
  }
  for (const position of positions) {
    const v = position.values
    const part = {
      pnl: null,
      value: v.valueMicros && BigInt(v.qty) > 0n ? money(v.valueMicros) : null,
      realized: v.realizedMicros && BigInt(position.state.resolvedDisposedQty) > 0n ? signed(v.realizedMicros) : null,
      unrealized: v.unrealizedMicros && BigInt(v.qty) > 0n ? signed(v.unrealizedMicros) : null,
      gas: BigInt(position.state.gasMicros) > 0n ? money(position.state.gasMicros) : null,
    }[metric]
    if (part) lines.push(`${position.asset}: ${part}`)
  }
  if (metric === "gas") lines.push("Network fees, including what each transaction pays to be posted to Ethereum.")
  if (totals.unpricedGas && (metric === "gas" || metric === "pnl")) lines.push("Some network fees had no price at the time, so they aren't included.")
  const relevant = totals.excluded.filter(({ reason }) => {
    if (metric === "value") return reason === "no current price" || reason === "incomplete history" || reason === "balance couldn't be read"
    if (metric === "realized") return reason === "sold at an unknown cost" || reason === "doesn't match its actual balance" || reason === "not checked against its actual balance"
    if (metric === "unrealized") return reason !== "sold at an unknown cost"
    return metric === "pnl"
  })
  for (const { asset, reason } of relevant) lines.push(`Not included: ${asset} (${reason}).`)
  if (metric === "value") {
    for (const { asset, reconciliation } of positions) {
      if (reconciliation?.status === "unchecked" && !reconciliation.heldIsCurrent) lines.push(`${asset}'s value is an estimate, because its balance couldn't be read.`)
    }
  }
  lines.push(...exchangeLines(view, metric === "value" ? "current" : metric === "gas" || metric === "realized" ? "past" : "both"))
  return {
    currency,
    title: TOTAL_TITLES[metric],
    value,
    sourceValue: source ? inUsd(explainTotal(source.positions, source.totals, metric, USD_CONTEXT).value) : null,
    lines,
    effects: positions
      .flatMap((p) => p.effects)
      .filter((e) => metric !== "gas" || e.leg.kind === "gas")
      .sort((a, b) => b.leg.blockNum - a.leg.blockNum || b.leg.txIndex - a.leg.txIndex),
  }
}

export function explainPoint(positions: readonly Position[], point: PnlPoint, { view, source }: ExplainContext): Explanation {
  const usd = source?.points.find((p) => p.txHash === point.txHash)
  return {
    currency: view.currency,
    title: `Transaction ${shortHash(point.txHash as string)}`,
    value: point.pnlMicros && formatSignedMoney(point.pnlMicros, view.currency),
    sourceValue: usd?.pnlMicros ? inUsd(formatSignedMoney(usd.pnlMicros, "USD")) : null,
    lines: [`Total PnL after this transaction.${point.excludedCount > 0 ? ` Leaves out ${point.excludedCount} unknown ${point.excludedCount === 1 ? "amount" : "amounts"}.` : ""}`, ...exchangeLines(view, "past")],
    effects: positions.flatMap((p) => p.effects).filter((e) => e.leg.txHash === point.txHash),
  }
}

/** A number someone clicked. Holding this and not its explanation means what's open always describes what's on screen. */
export type ExplainTarget = { kind: "total"; metric: TotalMetric } | { kind: "asset"; asset: string; metric: Metric } | { kind: "tx"; txHash: string }

/** What a target says about these numbers, or null when they have no such asset or transaction. */
export function explainTarget(target: ExplainTarget, { positions, totals, points }: { positions: readonly Position[]; totals: Totals; points: readonly PnlPoint[] }, context: ExplainContext): Explanation | null {
  if (target.kind === "total") return explainTotal(positions, totals, target.metric, context)
  if (target.kind === "asset") {
    const position = positions.find((p) => p.asset === target.asset)
    return position ? explainMetric(position, target.metric, context) : null
  }
  const point = points.find((p) => p.txHash === target.txHash)
  return point ? explainPoint(positions, point, context) : null
}
