// What a click on a number explains: a sentence for how it's worked out, and the legs behind it.

import { CURRENCIES, TOKENS, TOKEN_FEEDS, foldPositions, formatAmount, formatMoney, formatPrice, formatRate, formatSignedMoney, holdEffects, pnlOverTime, shortHash, sumTotals, tokenByAddress, unconfirmedAssets, unreadAssets, usdView, type CostLabel, type CurrencyCode, type HoldComparison, type LegEffect, type Method, type PnlPoint, type Position, type PricedLeg, type Totals, type WalletView } from "@pricetag/sdk/core"
import type { WalletResponse } from "./api.ts"
import { COST_WORDS, AVERAGE_PRICE_PAID, BALANCE_CHECK, CHECK_LABELS, HOLD_ETH, HOLD_PAST, METHOD_LABELS, NETWORK_FEES, currentPriceSource, holdCaveatSentence, holdDifferenceSentence, tokenLabel, unseenEthCause } from "./wording.ts"

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
  source: { positions: Position[]; totals: Totals; points: PnlPoint[]; holdComparison?: HoldComparison } | null
  /** Said on every explanation when a pricing rule other than the default is on. */
  ruleNote?: string | null
}

/** Explaining a USD number: there's nothing to convert, and nothing to say about rates. */
export const USD_CONTEXT: ExplainContext = { view: { currency: "USD", latestRate: null, missingRateTxs: [] }, source: null }

export function explainContext(wallet: WalletResponse, view: WalletView, method: Method): ExplainContext {
  const ruleNote = wallet.ruleNote ?? null
  if (view.currency === "USD") return { view, source: null, ruleNote }
  const usd = usdView(wallet)
  const positions = foldPositions(usd.legs, method, usd.prices, wallet)
  const unread = unreadAssets(positions, wallet)
  return { view, ruleNote, source: { positions, totals: sumTotals(positions, unread), points: pnlOverTime(usd.legs, method, usd.prices, usd.markPrice, wallet.latest, unconfirmedAssets(positions, unread)) } }
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
    if (leg.pieces?.some((p) => p.costMicros !== null) && leg.costMicros === null) {
      const known = leg.pieces.filter((p) => p.costMicros !== null).reduce((sum, p) => sum + BigInt(p.costMicros as string), 0n)
      const unknown = leg.pieces.filter((p) => p.costMicros === null).reduce((sum, p) => sum + BigInt(p.qty), 0n)
      parts.push(`Adds ${amount}: ${money(known)} of it from ${COST_WORDS[leg.costLabel]}, and ${formatAmount(unknown, leg.decimals)} ${leg.asset} at an unknown cost`)
    } else if (leg.costLabel === "unknown") parts.push(`Adds ${amount} at an unknown cost`)
    else parts.push(`Adds ${amount} for ${leg.estimated ? "about " : ""}${money(leg.costMicros as string)}${leg.costLabel === "paid" ? "" : `, from ${COST_WORDS[leg.costLabel]}`}`)
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
      if (costSources) lines.push(costSources)
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
        const soldAt = (units: string, what: string) => (BigInt(units) > 0n ? [`${formatAmount(units, decimals)} ${asset} was sold or spent at ${what}`] : [])
        const unknowns = [...soldAt(state.unknownCostDisposedQty, "an unknown cost"), ...soldAt(state.unknownProceedsQty, "an unknown price")]
        lines.push(`${unknowns.join(", and ")}, so its gain can't be known.${known}`)
      } else lines.push("What you received minus what it cost, on what was sold or spent on network fees. The fees themselves are a separate cost in the total.")
      break
    case "unrealized":
      value = values.unrealizedMicros && signed(values.unrealizedMicros)
      lines.push(priceLine)
      if (unknown) lines.push(`${unknownQty} of ${qty} has an unknown cost, so PnL is unavailable. It's never counted as zero.`)
      else if (values.costMicros && values.valueMicros) lines.push(`${money(values.valueMicros)} value − ${money(values.costMicros)} cost.`)
      if (costSources) lines.push(costSources)
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
    if (metric === "realized") return reason === "sold at an unknown cost" || reason === "sold or spent at an unknown price" || reason === "doesn't match its actual balance" || reason === "not checked against its actual balance"
    if (metric === "unrealized") return reason !== "sold at an unknown cost" && reason !== "sold or spent at an unknown price"
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

export function explainHold(positions: readonly Position[], comparison: HoldComparison, { view, source }: ExplainContext): Explanation {
  const { currency } = view
  const money = (micros: string) => formatMoney(micros, currency)
  const signed = (micros: string | null) => (micros === null ? "unavailable" : formatSignedMoney(micros, currency))
  const { holdMicros, ethValueMicros, ethPriceMicros, ethQty, putInMicros, takenOutMicros, walletMicros, gainThatLeftMicros, differenceMicros, ranOut } = comparison
  const caveat = holdCaveatSentence(comparison, currency)
  const lines = [
    "Takes each amount put in this wallet, turns it into ETH at that moment's price, and values that ETH at today's price.",
    "Put in means whatever arrived from outside this wallet, at what it cost you, or at its price when it arrived if that's all that's known. Exchanges inside the wallet aren't put in.",
    ...(BigInt(takenOutMicros) > 0n ? [`${money(takenOutMicros)} left this wallet, so it leaves the ETH too, at its price when it left.${ranOut ? " Holding ETH would have run out before all of it could leave." : ""}`] : []),
    ...(ethValueMicros !== null && ethPriceMicros !== null ? [`${money(putInMicros)} put in leaves ${formatAmount(ethQty, 18)} ETH, worth ${money(ethValueMicros)} at today's ${formatPrice(ethPriceMicros, currency)}.`] : []),
    `This wallet: ${signed(walletMicros)}. That's its total PnL after network fees${BigInt(gainThatLeftMicros) === 0n ? "" : `, and ${signed(gainThatLeftMicros)} on what left it, which total PnL doesn't count because a transfer isn't a sale`}. Holding ETH pays no fees.`,
    `${HOLD_ETH}: ${signed(holdMicros)}.`,
    ...(differenceMicros !== null ? [holdDifferenceSentence(differenceMicros, currency)] : []),
    ...(caveat ? [caveat] : []),
    ...exchangeLines(view, "both"),
    HOLD_PAST,
  ]
  return {
    currency,
    title: HOLD_ETH,
    value: holdMicros && formatSignedMoney(holdMicros, currency),
    sourceValue: source?.holdComparison?.holdMicros ? inUsd(formatSignedMoney(source.holdComparison.holdMicros, "USD")) : null,
    lines,
    effects: holdEffects(positions).reverse(),
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
