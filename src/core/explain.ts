// What a click on a number explains: a sentence for how it's worked out, and the legs behind it.

import { CURRENCIES, TOKENS, TOKEN_FEEDS, formatAmount, formatMoney, formatPaid, formatPrice, formatRate, formatReturn, returnBps, orderMatters, formatSignedMoney, holdEffects, lotSplitBy, shortHash, tokenByAddress, worth, type CostLabel, type CurrencyCode, type HoldComparison, type LegEffect, type PnlPoint, type Position, type PricedLeg, type Totals, type WalletView } from "@pricetag/sdk/core"
import { COST_WORDS, AVERAGE_PRICE_PAID, BALANCE_CHECK, CHECK_LABELS, ESTIMATE_LINE, HOLD_ETH, HOLD_PAST, METHOD_LABELS, NETWORK_FEES, currentPriceSource, est, holdCaveatSentence, holdDifferenceSentence, tokenLabel, unrecordedSentence, unseenEthCause } from "./wording.ts"

export type Metric = "amount" | "average" | "price" | "value" | "return" | "realized" | "unrealized" | "onchain"

export type Explanation = {
  /** What `value` and the effects' amounts are in. */
  currency: CurrencyCode
  title: string
  value: string | null
  /** The same number in USD, when that isn't what `value` is in. */
  sourceValue: string | null
  lines: string[]
  effects: LegEffect[]
  /** The asset and current USD price this number rests on, when that price comes from Chainlink, so it has a proof of its own. */
  priceProof?: { asset: string; price: string }
}

/** A different one for anything a current price's proof or its result depends on, so neither outlives it. */
export function priceProofKey(address: string, { currency, priceProof }: Explanation, rule: string | null): string {
  return `${address}:${currency}:${rule}:${priceProof?.asset}:${priceProof?.price}`
}

const METRIC_TITLES: Record<Metric, string> = {
  amount: "Amount",
  average: AVERAGE_PRICE_PAID,
  price: "Price",
  value: "Value",
  return: "Return",
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
  source: { positions: Position[]; totals: Totals; points: PnlPoint[]; holdComparison?: HoldComparison } | null
  /** Said on every explanation when a pricing rule other than the default is on. */
  ruleNote?: string | null
}

/** Explaining a USD number: there's nothing to convert, and nothing to say about rates. */
export const USD_CONTEXT: ExplainContext = { view: { currency: "USD", latestRate: null, missingRateTxs: [] }, source: null }

/** Where a currency's rates come from, in words. It's said wherever a rate is used, since it isn't the source of the prices. */
export function rateSource(currency: CurrencyCode): string {
  return `Chainlink's ${CURRENCIES[currency].feed?.pair} price on Base`
}

const inUsd = (value: string | null | undefined) => (value ? `${value} USD` : null)

/** What a leg was in USD and the rate that converted it, or null when it's in USD. */
export function describeConversion(leg: PricedLeg, currency: CurrencyCode): string | null {
  const { conversion, enteredAs } = leg
  if (enteredAs) return `You entered ${formatPaid(enteredAs.micros, enteredAs.currency)}. The day you paid isn't known, so in ${currency} it uses the exchange rate from when this history starts, which makes it an estimate.`
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

/** Why ETH that moved beside ETH nothing shows has an unknown cost. */
const ORDER_UNKNOWN = {
  always: "ETH both arrived and left in this block, and nothing says which came first, so what each one cost can't be worked out, and neither can what's still held",
  fifo: "ETH arrived more than once in this block, and nothing says which came first, so oldest first can't say what each one cost",
}

/** What a leg did to its position, in words. */
export function describeEffect({ leg, before, after }: LegEffect, currency: CurrencyCode): string {
  const money = (micros: string | bigint) => formatMoney(micros, currency)
  const signed = (micros: string | bigint) => formatSignedMoney(micros, currency)
  const amount = `${formatAmount(leg.delta.replace("-", ""), leg.decimals)} ${leg.asset}`
  const parts: string[] = []
  if (BigInt(leg.delta) > 0n) {
    if (leg.pieces?.some((p) => p.costMicros !== null) && leg.costMicros === null) {
      const known = leg.pieces.filter((p) => p.costMicros !== null).reduce((sum, p) => sum + BigInt(p.costMicros as string), 0n)
      const unknown = leg.pieces.filter((p) => p.costMicros === null).reduce((sum, p) => sum + BigInt(p.qty), 0n)
      parts.push(`Adds ${amount}: ${money(known)} of it from ${COST_WORDS[leg.costLabel]}, and ${formatAmount(unknown, leg.decimals)} ${leg.asset} at an unknown cost`)
    } else if (leg.costLabel === "unknown") parts.push(`Adds ${amount} at an unknown cost`)
    else parts.push(`Adds ${amount} for ${leg.estimated ? "about " : ""}${money(leg.costMicros as string)}${leg.purchaseSource ? `, ${leg.costLabel === "inherited" ? `from ${COST_WORDS.inherited}, ` : ""}fees included. ${leg.purchaseSource}` : leg.costLabel === "paid" ? "" : `, from ${COST_WORDS[leg.costLabel]}`}`)
    if (leg.parts.some((p) => p.kind === "unseen_eth")) parts.push("Nothing onchain records this amount directly, so it's how far this wallet's balance rose in this block")
    if (leg.orderUnknown && orderMatters(leg, before.method)) parts.push(ORDER_UNKNOWN[leg.orderUnknown])
    return parts.join(". ")
  }
  const realized = diff(after.realizedMicros, before.realizedMicros)
  const unresolved = diff(after.unresolvedDisposedQty, before.unresolvedDisposedQty)
  const shortfall = diff(after.shortfallQty, before.shortfallQty)
  if (leg.kind === "gas") parts.push(leg.priceMicros === null ? "Network fee, with no price at this block" : `Network fee: ${money(diff(after.gasMicros, before.gasMicros))} spent`)
  if (leg.kind === "swap") parts.push(leg.proceedsMicros === null ? "Sold, but what you received has no usable value" : `Sold for ${leg.estimated ? "about " : ""}${money(leg.proceedsMicros)}`)
  if (leg.kind === "transfer") {
    const carried = `${diff(after.transferredOutEstimatedMicros, before.transferredOutEstimatedMicros) > 0n ? "about " : ""}${money(diff(after.transferredOutCostMicros, before.transferredOutCostMicros))} of known cost`
    const unknownQty = diff(after.transferredOutUnknownQty, before.transferredOutUnknownQty)
    if (unknownQty === 0n) parts.push(`Sent out with ${carried}, so no gain or loss`)
    else if (unknownQty < -BigInt(leg.delta)) parts.push(`Sent out with ${carried}, and ${formatAmount(unknownQty, leg.decimals)} ${leg.asset} at an unknown cost, so no gain or loss`)
    else parts.push("Sent out at an unknown cost, so no gain or loss")
  }
  if (leg.kind !== "transfer") {
    if (realized !== 0n) parts.push(`realized ${diff(after.estimatedRealizedMicros, before.estimatedRealizedMicros) > 0n ? "about " : ""}${signed(realized)}`)
    if (unresolved > 0n) parts.push(`PnL unavailable on ${formatAmount(unresolved, leg.decimals)} ${leg.asset}`)
  }
  if (shortfall > 0n) parts.push(`${formatAmount(shortfall, leg.decimals)} ${leg.asset} more than we saw arrive`)
  if (leg.orderUnknown && orderMatters(leg, before.method)) return `${parts.join(", ")}. ${ORDER_UNKNOWN[leg.orderUnknown]}`
  return parts.join(", ")
}

/** What a leg did, in one plain sentence led by its amount in money, what about it isn't known, and whether answering a question could fix that. `describeEffect` has the rest. */
export function summarizeEffect({ leg, before, after }: LegEffect, currency: CurrencyCode): { summary: string; unknown: string | null; answerable: boolean } {
  const money = (micros: string | bigint) => formatMoney(micros, currency)
  const qty = BigInt(leg.delta.replace("-", ""))
  const amount = (units: bigint) => `${formatAmount(units, leg.decimals)} ${leg.asset}`
  const value = leg.priceMicros === null ? null : worth(qty, BigInt(leg.priceMicros), leg.decimals)
  // Money first, as people count it. Without a price, the amount is all there is to say.
  const what = (micros: bigint | string | null, about = false) => (micros === null ? amount(qty) : `${about ? "about " : ""}${money(micros)} of ${leg.asset}`)
  // What it's worth at a market price is an estimate, and it's only ever that price that says so.
  const atMarket = leg.priceSource === "market"
  // Nobody can answer which came first, or what the chain hasn't confirmed yet.
  const orderUnknown = orderMatters(leg, before.method) || (BigInt(leg.delta) < 0n && lotSplitBy(before, qty) !== null)
  if (BigInt(leg.delta) > 0n) {
    const unknown = leg.costMicros !== null ? null : leg.pieces?.some((p) => p.costMicros !== null) ? "What part of this cost isn't known yet." : "What this cost isn't known yet."
    const facts = { unknown, answerable: unknown !== null && !orderUnknown && !leg.unsettledCredit }
    if (leg.opening) return { summary: `Already held ${what(value, atMarket)} when this history starts.`, ...facts }
    // Bought and then moved here keeps what was paid as its cost, but this movement is the move.
    if (leg.costLabel !== "inherited" && (leg.kind === "swap" || leg.purchaseSource)) {
      // Money after "Bought" reads as what was paid, so a price's worth says so when that's all there is.
      if (leg.costMicros === null) return { summary: `Bought ${amount(qty)}${value === null ? "" : `, worth ${atMarket ? "about " : ""}${money(value)}`}.`, ...facts }
      return { summary: `Bought ${what(leg.costMicros, leg.estimated)}${leg.purchaseSource ? ", fees included" : ""}.`, ...facts }
    }
    return { summary: `Received ${what(value, atMarket)}${leg.costLabel === "inherited" ? " from your other wallet" : ""}.`, ...facts }
  }
  const realized = diff(after.realizedMicros, before.realizedMicros)
  const unresolved = diff(after.unresolvedDisposedQty, before.unresolvedDisposedQty)
  const shortfall = diff(after.shortfallQty, before.shortfallQty)
  if (leg.kind === "transfer") {
    // Its unknown cost is the one it arrived with, which a question can be about. What's short never arrived.
    const missing = diff(after.transferredOutUnknownQty, before.transferredOutUnknownQty) - shortfall
    const unknown = shortfall > 0n ? `${amount(shortfall)} more left than we saw arrive, so what it cost isn't known.` : missing > 0n ? (missing < qty ? "What part of this cost isn't known yet." : "What this cost isn't known yet.") : null
    return { summary: `Sent ${what(value, atMarket)}, with no gain or loss.`, unknown, answerable: missing > 0n && !orderUnknown }
  }
  // A shortfall is also an unknown cost, but it isn't one any question is about, since nothing is known to have arrived.
  const missingCost = diff(after.unknownCostDisposedQty, before.unknownCostDisposedQty) - shortfall
  const causes = [
    ...(shortfall > 0n ? [`${amount(shortfall)} more left than we saw arrive`] : []),
    ...(missingCost > 0n ? [`what ${missingCost < unresolved ? "some of it" : "it"} cost isn't known yet`] : []),
    ...(diff(after.unknownProceedsQty, before.unknownProceedsQty) > 0n ? [leg.kind === "gas" ? "it has no price at this block" : "what you received has no usable value"] : []),
  ]
  const unknown = unresolved > 0n ? `The gain on ${amount(unresolved)} isn't known, because ${causes.join(", and ")}.` : null
  const answerable = missingCost > 0n && !orderUnknown
  if (leg.kind === "gas") {
    const fee = diff(after.gasMicros, before.gasMicros)
    return { summary: leg.priceMicros === null ? `Paid ${amount(qty)} in network fees.` : `Paid ${money(fee)} in network fees.`, unknown, answerable }
  }
  if (leg.proceedsMicros === null) return { summary: `Sold ${amount(qty)}, for something with no usable value.`, unknown, answerable }
  const sold = `Sold ${what(leg.proceedsMicros, leg.estimated)}`
  const gain = `${diff(after.estimatedRealizedMicros, before.estimatedRealizedMicros) > 0n ? "about " : ""}a ${money(realized < 0n ? -realized : realized)} ${realized < 0n ? "loss" : "gain"}`
  if (unknown) return { summary: realized === 0n ? `${sold}.` : `${sold}, ${gain} on part of it.`, unknown, answerable }
  if (realized === 0n) return { summary: `${sold}, with no gain or loss.`, unknown, answerable }
  return { summary: `${sold}, ${gain}.`, unknown, answerable }
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
    return [`Matches the actual balance exactly: ${opening} add up to ${amount(reconciliation.actualQty)} at block ${block}.`, ...(reconciliation.unrecordedQty ? [unrecordedSentence(reconciliation.unrecordedQty, decimals, asset)] : [])]
  }
  const unconfirmed = effects.filter(({ leg }) => leg.unsettledCredit).map(({ leg }) => shortHash(leg.txHash))
  return [
    `Worked out from its transactions: ${amount(reconciliation.computedQty)}.`,
    `Actual balance at block ${block}: ${amount(reconciliation.actualQty)}.`,
    `Difference: ${BigInt(reconciliation.differenceQty) > 0n ? "+" : ""}${amount(reconciliation.differenceQty)}.`,
    mismatchCause(asset, reconciliation.differenceQty),
    ...(reconciliation.unseenEth ? [unseenEthCause(reconciliation.unseenEth)] : []),
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

/** What a position's cost is made of, in words, or null when it has none. */
function costSourceLine({ state, asset, decimals }: Position, money: (micros: bigint) => string): string | null {
  const known = new Map<string, bigint>()
  let unknown = 0n
  for (const lot of state.lots) {
    if (lot.costMicros === null) unknown += BigInt(lot.qty)
    else known.set(lot.label, (known.get(lot.label) ?? 0n) + BigInt(lot.costMicros))
  }
  const estimated = state.lots.reduce((sum, lot) => sum + BigInt(lot.estimatedCostMicros ?? "0"), 0n)
  const parts = [...known].map(([label, amount]) => `${money(amount)} from ${label === "mixed" ? "several sources" : COST_WORDS[label as CostLabel]}`)
  if (unknown > 0n) parts.push(`${formatAmount(unknown, decimals)} ${asset} unknown`)
  if (parts.length === 0) return null
  return `Cost: ${parts.join(", ")}.${estimated > 0n ? ` ${money(estimated)} of that is an estimate.` : ""}`
}

/** Whether the main screen marks this number as an estimate, so its explanation does too. */
export function metricIsEstimate({ estimates }: Pick<Position, "estimates">, metric: Metric): boolean {
  if (metric === "average") return estimates.cost
  if (metric === "price" || metric === "value") return estimates.value
  if (metric === "realized") return estimates.realized
  return (metric === "return" || metric === "unrealized") && estimates.unrealized
}

export function totalIsEstimate(totals: Pick<Totals, "estimated" | "estimatedMicros">, metric: TotalMetric): boolean {
  if (metric === "pnl") return BigInt(totals.estimatedMicros) > 0n
  return metric !== "gas" && totals.estimated[metric]
}

export function explainMetric(position: Position, metric: Metric, context: ExplainContext): Explanation {
  const { view, source } = context
  const { currency } = view
  const money = (micros: string | bigint) => formatMoney(micros, currency)
  const signed = (micros: string | bigint) => formatSignedMoney(micros, currency)
  const { asset, decimals, values, state, price, effects, reconciliation, estimates } = position
  const unknown = BigInt(values.unknownCostQty) > 0n
  const qty = `${formatAmount(values.qty, decimals)} ${asset}`
  const unknownQty = `${formatAmount(values.unknownCostQty, decimals)} ${asset}`
  const priceLine = price
    ? `Current price: ${formatPrice(price.micros, currency)}${price.usdMicros ? ` (${formatPrice(price.usdMicros, "USD")} USD)` : ""}, from ${currentPriceSource(price.source)} at block ${price.blockNum.toLocaleString("en-US")}.${price.source === "market" ? " That makes it an estimate." : ""}`
    : currency !== "USD" && !view.latestRate
      ? `There's no current USD to ${currency} rate, so ${asset} has no current value here.`
      : TOKENS.some((t) => t.symbol === asset && t.oracle) || TOKEN_FEEDS[asset]
      ? `There's no current price for ${asset}, because the market price feed's latest answer failed or is too old. An old price would quietly be wrong.`
      : `There's no current price for ${asset}, because it hasn't traded enough recently for a price to be trusted.`
  const lines: string[] = []
  let value: string | null = null
  const costSources = costSourceLine(position, money)

  const incomplete = reconciliation?.status === "incomplete"
  const unconfirmed = reconciliation !== null && reconciliation.status !== "reconciled"
  if (unconfirmed && (metric === "average" || metric === "return" || metric === "realized" || metric === "unrealized")) {
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
      else if (values.costMicros) lines.push(`${est(money(values.costMicros), estimates.cost)} of cost ÷ ${qty}, using the ${METHOD_LABELS[state.method]} method.`)
      if (costSources) lines.push(costSources)
      break
    case "price":
      value = price && formatPrice(price.micros, currency)
      lines.push(priceLine)
      break
    case "value":
      value = values.valueMicros && money(values.valueMicros)
      lines.push(priceLine)
      if (values.valueMicros) lines.push(`${qty} × that price.${incomplete ? " That's the actual balance, because its transactions don't add up to it." : ""}`)
      break
    case "realized":
      value = values.realizedMicros && signed(values.realizedMicros)
      if (values.realizedMicros === null) {
        const known = BigInt(state.resolvedDisposedQty) > 0n ? ` ${est(signed(state.realizedMicros), estimates.realized)} is the part that is known.` : ""
        const soldAt = (units: string, what: string) => (BigInt(units) > 0n ? [`${formatAmount(units, decimals)} ${asset} was sold or spent at ${what}`] : [])
        const unknowns = [...soldAt(state.unknownCostDisposedQty, "an unknown cost"), ...soldAt(state.unknownProceedsQty, "an unknown price")]
        lines.push(`${unknowns.join(", and ")}, so its gain can't be known.${known}`)
      } else lines.push("What you received minus what it cost, on what was sold or spent on network fees. The fees themselves are a separate cost in the total.")
      break
    case "return": {
      const bps = returnBps(values)
      value = bps && formatReturn(bps)
      lines.push(priceLine)
      if (unknown) lines.push(`${unknownQty} of ${qty} has an unknown cost, so there's no return. It's never counted as zero.`)
      else if (values.costMicros && values.unrealizedMicros && bps === null) lines.push("It cost nothing, so there's no return as a share of what it cost.")
      else if (values.costMicros && values.unrealizedMicros) lines.push(`${est(signed(values.unrealizedMicros), estimates.unrealized)} unrealized ÷ ${est(money(values.costMicros), estimates.cost)} cost.`)
      if (costSources) lines.push(costSources)
      break
    }
    case "unrealized":
      value = values.unrealizedMicros && signed(values.unrealizedMicros)
      lines.push(priceLine)
      if (unknown) lines.push(`${unknownQty} of ${qty} has an unknown cost, so PnL is unavailable. It's never counted as zero.`)
      else if (values.costMicros && values.valueMicros) lines.push(`${est(money(values.valueMicros), estimates.value)} value − ${est(money(values.costMicros), estimates.cost)} cost.`)
      if (costSources) lines.push(costSources)
      break
  }
  const isEstimate = value !== null && metricIsEstimate(position, metric)
  if (isEstimate) value = est(value as string, true)
  // The price or the cost may already say why.
  if (isEstimate && !lines.some((line) => line.includes("estimate"))) lines.push(ESTIMATE_LINE)
  // A return is a share, not an amount, so it has no USD to show beside it. It still depends on the rates.
  const isMoney = metric !== "amount" && metric !== "onchain" && metric !== "return"
  if (isMoney || metric === "return") lines.push(...exchangeLines(view, metric === "value" || metric === "price" ? "current" : metric === "unrealized" || metric === "return" ? "both" : "past"))
  const usd = source?.positions.find((p) => p.asset === asset)
  return {
    currency,
    title: `${asset}: ${METRIC_TITLES[metric]}`,
    value,
    sourceValue: usd && isMoney ? inUsd(explainMetric(usd, metric, USD_CONTEXT).value) : null,
    lines,
    effects: [...effects].reverse(),
    ...(price?.source === "oracle" && (metric === "price" || metric === "value" || metric === "return" || metric === "unrealized") ? { priceProof: { asset, price: price.usdMicros ?? price.micros } } : {}),
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
  const showSigned = (micros: string | null, isEstimate: boolean) => (micros === null ? "unavailable" : est(signed(micros), isEstimate))
  const isEstimate = totalIsEstimate(totals, metric)
  const unmarked: string | null = {
    pnl: totals.pnlMicros && signed(totals.pnlMicros),
    value: totals.valueMicros && money(totals.valueMicros),
    realized: totals.realizedMicros && signed(totals.realizedMicros),
    unrealized: totals.unrealizedMicros && signed(totals.unrealizedMicros),
    gas: totals.gasMicros && money(totals.gasMicros),
  }[metric]
  const value = unmarked && est(unmarked, isEstimate)
  const lines: string[] = []
  if (metric === "pnl") {
    if (value === null) lines.push("Everything here depends on an unknown cost or price, so there's no PnL to show. It isn't zero.")
    else lines.push(`Realized ${showSigned(totals.realizedMicros, totals.estimated.realized)}, unrealized ${showSigned(totals.unrealizedMicros, totals.estimated.unrealized)}, less ${totals.gasMicros === null ? "network fees that are unavailable" : `${money(totals.gasMicros)} of network fees`}.`)
  }
  for (const position of positions) {
    const v = position.values
    const part = {
      pnl: null,
      value: v.valueMicros && BigInt(v.qty) > 0n ? est(money(v.valueMicros), position.estimates.value) : null,
      realized: v.realizedMicros && BigInt(position.state.resolvedDisposedQty) > 0n ? est(signed(v.realizedMicros), position.estimates.realized) : null,
      unrealized: v.unrealizedMicros && BigInt(v.qty) > 0n ? est(signed(v.unrealizedMicros), position.estimates.unrealized) : null,
      gas: BigInt(position.state.gasMicros) > 0n ? money(position.state.gasMicros) : null,
    }[metric]
    if (part) lines.push(`${position.asset}: ${part}`)
  }
  if (metric === "gas") lines.push("Network fees, including what each transaction pays to be posted to Ethereum.")
  if (totals.unpricedGas && (metric === "gas" || metric === "pnl")) lines.push("Some network fees had no price at the time, so they aren't included.")
  const relevant = totals.excluded.filter(({ reason }) => {
    if (metric === "value") return reason === "no current price" || reason === "incomplete history" || reason === "balance couldn't be read"
    if (metric === "realized") return reason === "sold or spent at an unknown cost" || reason === "sold or spent at an unknown price" || reason === "doesn't match its actual balance" || reason === "not checked against its actual balance"
    if (metric === "unrealized") return reason !== "sold or spent at an unknown cost" && reason !== "sold or spent at an unknown price"
    return metric === "pnl"
  })
  for (const { asset, reason } of relevant) lines.push(`Not included: ${asset} (${reason}).`)
  if (metric === "value") {
    for (const { asset, reconciliation } of positions) {
      if (reconciliation?.status === "unchecked" && !reconciliation.heldIsCurrent) lines.push(`${asset}'s value is an estimate, because its balance couldn't be read.`)
    }
  }
  if (value !== null && isEstimate) lines.push(ESTIMATE_LINE)
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

/** `combined` is for several of the user's wallets at once, where moving between them is neither putting in nor taking out. */
export function explainHold(positions: readonly Position[], comparison: HoldComparison, { view, source }: ExplainContext, { combined = false } = {}): Explanation {
  const { currency } = view
  const money = (micros: string) => formatMoney(micros, currency)
  const signed = (micros: string | null, isEstimate: boolean) => (micros === null ? "unavailable" : est(formatSignedMoney(micros, currency), isEstimate))
  const { holdMicros, ethValueMicros, ethPriceMicros, ethQty, putInMicros, takenOutMicros, walletMicros, gainThatLeftMicros, differenceMicros, ranOut, estimated, walletEstimated } = comparison
  const caveat = holdCaveatSentence(comparison, currency, { combined })
  const [here, these] = combined ? ["your wallets", "Your wallets"] : ["this wallet", "This wallet"]
  const lines = [
    `Takes each amount put in ${here}, turns it into ETH at that moment's price, and values that ETH at today's price.`,
    `Put in means whatever arrived from outside ${here}, at what it cost you, or at its price when it arrived if that's all that's known. Exchanges inside ${combined ? "them" : "the wallet"} aren't put in${combined ? ", and neither are moves between them" : ""}.`,
    ...(BigInt(takenOutMicros) > 0n ? [`${est(money(takenOutMicros), estimated)} left ${here}, so it leaves the ETH too, at its price when it left.${ranOut ? " Holding ETH would have run out before all of it could leave." : ""}`] : []),
    ...(ethValueMicros !== null && ethPriceMicros !== null ? [`${est(money(putInMicros), estimated)} put in leaves ${formatAmount(ethQty, 18)} ETH, worth ${est(money(ethValueMicros), estimated)} at today's ${formatPrice(ethPriceMicros, currency)}.`] : []),
    `${these}: ${signed(walletMicros, walletEstimated)}. That's ${combined ? "their" : "its"} total PnL after network fees${BigInt(gainThatLeftMicros) === 0n ? "" : `, and ${signed(gainThatLeftMicros, walletEstimated)} on what left ${combined ? "them" : "it"}, which total PnL doesn't count because a transfer isn't a sale`}. Holding ETH pays no fees.`,
    `${HOLD_ETH}: ${signed(holdMicros, estimated)}.`,
    ...(differenceMicros !== null ? [holdDifferenceSentence(differenceMicros, currency, walletEstimated || estimated)] : []),
    ...(caveat ? [caveat] : []),
    ...(holdMicros !== null && (walletEstimated || estimated) ? [ESTIMATE_LINE] : []),
    ...exchangeLines(view, "both"),
    HOLD_PAST,
  ]
  return {
    currency,
    title: HOLD_ETH,
    value: holdMicros && est(formatSignedMoney(holdMicros, currency), estimated),
    sourceValue: source?.holdComparison?.holdMicros ? inUsd(est(formatSignedMoney(source.holdComparison.holdMicros, "USD"), source.holdComparison.estimated)) : null,
    lines,
    effects: holdEffects(positions).reverse(),
  }
}

export function explainPoint(positions: readonly Position[], point: PnlPoint, { view, source }: ExplainContext): Explanation {
  const usd = source?.points.find((p) => p.txHash === point.txHash)
  return {
    currency: view.currency,
    title: `Transaction ${shortHash(point.txHash as string)}`,
    value: point.pnlMicros && est(formatSignedMoney(point.pnlMicros, view.currency), point.pnlEstimated === true),
    sourceValue: usd?.pnlMicros ? inUsd(est(formatSignedMoney(usd.pnlMicros, "USD"), usd.pnlEstimated === true)) : null,
    lines: [`Total PnL after this transaction.${point.excludedCount > 0 ? ` Leaves out ${point.excludedCount} unknown ${point.excludedCount === 1 ? "amount" : "amounts"}.` : ""}`, ...(point.pnlMicros !== null && point.pnlEstimated ? [ESTIMATE_LINE] : []), ...exchangeLines(view, "past")],
    effects: positions.flatMap((p) => p.effects).filter((e) => e.leg.txHash === point.txHash),
  }
}

type ExplainFacts = { positions: readonly Position[]; totals: Totals; points: readonly PnlPoint[]; holdComparison?: HoldComparison }

/** A number someone clicked. Holding this and not its explanation means what's open always describes what's on screen. */
export type ExplainTarget = { kind: "total"; metric: TotalMetric } | { kind: "asset"; asset: string; metric: Metric } | { kind: "tx"; txHash: string } | { kind: "hold" }

/** What a target says about these numbers, or null when they have no such asset or transaction. */
export function explainTarget(target: ExplainTarget, facts: ExplainFacts, context: ExplainContext = USD_CONTEXT): Explanation | null {
  const explanation = explainNumber(target, facts, context)
  return explanation && context.ruleNote ? { ...explanation, lines: [...explanation.lines, context.ruleNote] } : explanation
}

function explainNumber(target: ExplainTarget, { positions, totals, points, holdComparison }: ExplainFacts, context: ExplainContext): Explanation | null {
  if (target.kind === "hold") return holdComparison ? explainHold(positions, holdComparison, context) : null
  if (target.kind === "total") return explainTotal(positions, totals, target.metric, context)
  if (target.kind === "asset") {
    const position = positions.find((p) => p.asset === target.asset)
    return position ? explainMetric(position, target.metric, context) : null
  }
  const point = points.find((p) => p.txHash === target.txHash)
  return point ? explainPoint(positions, point, context) : null
}
