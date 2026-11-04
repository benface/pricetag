// The portfolio a wallet's legs fold into, for clients that don't run the fold themselves.
// One source of PnL logic: this calls what the browser calls, and adds nothing to the math.

import { TOKENS, answerToMicros, foldWallet, worth, viewWallet, type CurrencyCode, type WalletView, type LegEffect, type Method, type Position, type PricedLeg, type Reference, type Totals } from "@pricetag/sdk/core"
import { hasStarted, isBehind, type ExplanationLeg, type ExplanationResponse, type PortfolioExchange, type PortfolioPosition, type PortfolioResponse, type WalletResponse } from "../src/core/api.ts"
import { inheritCosts } from "../src/core/linked.ts"
import { describeConversion, describeEffect, describeNetting, explainContext, explainTarget, missingRatesLine, rateSource, type ExplainTarget, type Metric, type TotalMetric } from "../src/core/explain.ts"
import { differenceOf, whySentence, type PricingRule, type RuleComparison, type RuleRow, type RuleTransaction } from "../src/core/rules.ts"
import { ETH_NOTE, UNPRICED_FEES, excludedSentence, feesUnknownSentence, networkFeeUnknownSentence } from "../src/core/wording.ts"

/** Matches the web panel: a busy wallet has thousands of legs, and the newest are the ones anyone reads. */
const MAX_LEGS = 200

const ASSET_METRICS: readonly string[] = ["amount", "average", "value", "realized", "unrealized", "onchain"] satisfies Metric[]
const TOTAL_METRICS: readonly string[] = ["pnl", "value", "realized", "unrealized", "gas"] satisfies TotalMetric[]

export function parseExplainTarget(params: URLSearchParams): ExplainTarget | null {
  const tx = params.get("tx")
  if (tx) return { kind: "tx", txHash: tx.toLowerCase() }
  const metric = params.get("metric") ?? ""
  const asset = params.get("asset")
  if (asset) return ASSET_METRICS.includes(metric) ? { kind: "asset", asset, metric: metric as Metric } : null
  return TOTAL_METRICS.includes(metric) ? { kind: "total", metric: metric as TotalMetric } : null
}

function positionOf({ asset, decimals, price, values, state, effects, reconciliation }: Position): PortfolioPosition {
  const held = BigInt(values.qty) > 0n
  const { realizedMicros: realized, unrealizedMicros: unrealized } = values
  const pnl = (() => {
    // Units left that we never saw arrive, so whatever this position shows isn't all of it. Totals leave it out for the same reason.
    if (realized === null || BigInt(state.shortfallQty) > 0n) return null
    if (!held) return realized
    return unrealized === null ? null : (BigInt(realized) + BigInt(unrealized)).toString()
  })()
  return { asset, decimals, note: asset === "ETH" ? ETH_NOTE : null, price, values, pnlMicros: pnl, shortfallQty: state.shortfallQty, legCount: effects.length, reconciliation }
}

function exchangeOf(view: WalletView): PortfolioExchange | null {
  if (view.currency === "USD") return null
  return { source: rateSource(view.currency), latestRateMicros: view.latestRate?.rateMicros ?? null, missingRateTxs: view.missingRateTxs }
}

function outgoingTxsOf(wallet: WalletResponse): string[] {
  return [...new Set([...wallet.legs.filter((leg) => BigInt(leg.delta) < 0n).map((leg) => leg.txHash), ...wallet.gasUnknownTxs])]
}

/**
 * The wallet in its currency, with costs carried over from the user's other wallets. Each wallet converts at its own blocks'
 * rates first, so what's inherited keeps the rate from when it was bought, not from when it moved.
 */
function viewWithLinkedCosts(wallet: WalletResponse, linked: readonly WalletResponse[], method: Method): WalletView {
  const view = viewWallet(wallet)
  if (linked.length === 0) return view
  const wallets = new Map([[wallet.address, view.legs], ...linked.map((other): [string, PricedLeg[]] => [other.address, viewWallet(other).legs])])
  return { ...view, legs: inheritCosts(wallets, method).get(wallet.address) ?? view.legs }
}

export function portfolioOf(wallet: WalletResponse, method: Method, linked: readonly WalletResponse[] = []): PortfolioResponse {
  const { view, positions, unreadAssets, totals, pnlStatus, points } = foldWallet(wallet, method, viewWithLinkedCosts(wallet, linked, method))
  return {
    address: wallet.address,
    mode: wallet.mode,
    method,
    rule: wallet.rule ?? null,
    currency: view.currency,
    exchange: exchangeOf(view),
    coverage: wallet.coverage,
    // ETH is the allowlist's first entry, and everything else is a token.
    trackedTokens: TOKENS.length - 1,
    latest: wallet.latest,
    progress: { started: hasStarted(wallet), behindBlocks: isBehind(wallet) ? wallet.latest.blockNum - wallet.coverage.toBlock : 0 },
    gasUnknownTxs: wallet.gasUnknownTxs,
    outgoingTxs: outgoingTxsOf(wallet),
    unlisted: wallet.unlisted,
    l1FeeUnknownTxs: wallet.l1FeeUnknownTxs,
    openingUnread: wallet.openingUnread,
    unreadAssets,
    positions: positions.map(positionOf),
    totals,
    pnlStatus,
    points,
  }
}

function legOf(effect: LegEffect, currency: CurrencyCode): ExplanationLeg {
  const { leg } = effect
  return {
    id: leg.id,
    asset: leg.asset,
    delta: leg.delta,
    decimals: leg.decimals,
    kind: leg.kind,
    priceMicros: leg.priceMicros,
    priceSource: leg.priceSource,
    priceNote: leg.priceNote,
    costLabel: leg.costLabel,
    blockNum: leg.blockNum,
    timestamp: leg.timestamp,
    txHash: leg.txHash,
    opening: leg.opening === true,
    effect: describeEffect(effect, currency),
    netting: describeNetting(leg),
    conversion: describeConversion(leg, currency),
  }
}

/** The same explanation the web panel shows for a click on this number. null when the wallet has no such asset or transaction. */
export function explainPortfolio(wallet: WalletResponse, method: Method, target: ExplainTarget, linked: readonly WalletResponse[] = []): ExplanationResponse | null {
  const { view, positions, totals, points } = foldWallet(wallet, method, viewWithLinkedCosts(wallet, linked, method))
  const explanation = explainTarget(target, { positions, totals, points }, explainContext(wallet, view, method))
  if (!explanation) return null
  return {
    currency: explanation.currency,
    title: explanation.title,
    value: explanation.value,
    sourceValue: explanation.sourceValue,
    lines: explanation.lines,
    legCount: explanation.effects.length,
    legs: explanation.effects.slice(0, MAX_LEGS).map((effect) => legOf(effect, explanation.currency)),
  }
}

/** How many changed transactions a comparison lists. The count covers them all. */
const MAX_COMPARED_TXS = 20

type ComparedAmount = Pick<RuleTransaction, "txHash" | "blockNum" | "timestamp" | "asset" | "label"> & { parts: (string | null)[] }

/**
 * Each transaction's cost, sale value and network fee per asset. A leg can be split, as when a transfer between linked
 * wallets carries several purchases, but people read one amount for one transaction.
 */
function comparedAmounts(legs: readonly PricedLeg[]): Map<string, ComparedAmount> {
  const amounts = new Map<string, ComparedAmount>()
  const add = (leg: PricedLeg, label: RuleTransaction["label"], value: string | null) => {
    const key = `${leg.txHash}:${leg.asset}:${label}`
    const known = amounts.get(key)
    if (known) known.parts.push(value)
    else amounts.set(key, { txHash: leg.txHash, blockNum: leg.blockNum, timestamp: leg.timestamp, asset: leg.asset, label, parts: [value] })
  }
  for (const leg of legs) {
    // A fee has no cost or sale value. It's spent at the price of its block, the same way the fold counts it.
    if (leg.kind === "gas") add(leg, "Network fee", leg.priceMicros === null ? null : worth(BigInt(leg.delta.replace("-", "")), BigInt(leg.priceMicros), leg.decimals).toString())
    else {
      add(leg, "Cost", leg.costMicros)
      add(leg, "Sold for", leg.proceedsMicros)
    }
  }
  return amounts
}

/** One part unknown leaves the whole unknown. It's never added up as if that part were zero. */
const sumOf = (parts: readonly (string | null)[]) => (parts.includes(null) ? null : parts.reduce((sum, part) => sum + BigInt(part as string), 0n).toString())

/** What came out differently by the other rule. A known part can change inside an amount that stays unknown, and that still counts. */
function changedAmounts(a: readonly PricedLeg[], b: readonly PricedLeg[]): RuleTransaction[] {
  const theirs = comparedAmounts(b)
  const changed: RuleTransaction[] = []
  for (const [key, { parts, ...base }] of comparedAmounts(a)) {
    const other = theirs.get(key)?.parts ?? [null]
    if (JSON.stringify(parts) === JSON.stringify(other)) continue
    const [x, y] = [sumOf(parts), sumOf(other)]
    changed.push({ ...base, a: x, b: y, difference: differenceOf(x, y) })
  }
  return changed.sort((x, y) => y.blockNum - x.blockNum)
}

/** What a portfolio's numbers leave out or can't vouch for, as the main screen says it. */
function warningsOf({ totals, currency, exchange, gasUnknownTxs, l1FeeUnknownTxs }: PortfolioResponse): string[] {
  return [
    excludedSentence(totals.excluded),
    totals.unpricedGas ? UNPRICED_FEES : null,
    gasUnknownTxs.length > 0 ? feesUnknownSentence(gasUnknownTxs.length) : null,
    l1FeeUnknownTxs.length > 0 ? networkFeeUnknownSentence(l1FeeUnknownTxs.length) : null,
    exchange && exchange.missingRateTxs.length > 0 ? missingRatesLine(exchange.missingRateTxs.length, currency) : null,
    exchange && exchange.latestRateMicros === null ? `There's no current USD to ${currency} rate, so what's held has no current value.` : null,
  ].filter((warning) => warning !== null)
}

/** Once when both sides say it, and otherwise saying which side. */
function combinedWarnings(a: PricingRule, left: readonly string[], b: PricingRule, right: readonly string[]): string[] {
  const only = (rule: PricingRule, mine: readonly string[], theirs: readonly string[]) => mine.filter((w) => !theirs.includes(w)).map((w) => `${rule.name}: ${w}`)
  return [...left.filter((w) => right.includes(w)), ...only(a, left, right), ...only(b, right, left)]
}

type Compared = { rule: PricingRule; wallet: WalletResponse; reference: Reference | null; linked?: readonly WalletResponse[] }

/** One wallet by two rules, both folded by the same code, so the rule is all that can differ. */
export function compareRules(a: Compared, b: Compared, method: Method, blockNum: number): RuleComparison {
  const [left, right] = [portfolioOf(a.wallet, method, a.linked), portfolioOf(b.wallet, method, b.linked)]
  // A sum that leaves out something else on the other side isn't a difference between rules.
  const sameMakeup = JSON.stringify([left.totals.excluded, left.totals.unpricedGas]) === JSON.stringify([right.totals.excluded, right.totals.unpricedGas])
  const rowOf = (label: string, format: RuleRow["format"], x: string | null, y: string | null, partial: [boolean, boolean] = [false, false], comparable = true): RuleRow => ({
    label,
    format,
    a: x,
    b: y,
    difference: comparable ? differenceOf(x, y) : null,
    aPartial: x !== null && partial[0],
    bPartial: y !== null && partial[1],
  })
  const totals = (key: "pnlMicros" | "realizedMicros" | "unrealizedMicros" | "valueMicros", part: "pnl" | "realized" | "unrealized" | "value", label: string, format: RuleRow["format"]) => {
    const [x, y] = [left.totals.coverage[part], right.totals.coverage[part]]
    return rowOf(label, format, left.totals[key], right.totals[key], [x.missing > 0, y.missing > 0], sameMakeup && x.known === y.known && x.missing === y.missing)
  }
  const rows: RuleRow[] = [
    rowOf("ETH price", "usdPrice", answerToMicros(a.reference?.ethUsd), answerToMicros(b.reference?.ethUsd)),
    totals("pnlMicros", "pnl", "Total PnL", "signed"),
    totals("realizedMicros", "realized", "Realized", "signed"),
    totals("unrealizedMicros", "unrealized", "Unrealized", "signed"),
    totals("valueMicros", "value", "Value", "money"),
    rowOf("Network fees", "money", left.totals.gasMicros, right.totals.gasMicros, [left.totals.unpricedGas, right.totals.unpricedGas], left.totals.unpricedGas === right.totals.unpricedGas),
  ]
  for (const position of left.positions) {
    const theirs = right.positions.find((p) => p.asset === position.asset)
    if (!theirs) continue
    const row = (label: string, format: RuleRow["format"], x: string | null, y: string | null) => {
      if (x !== y) rows.push(rowOf(`${position.asset} ${label}`, format, x, y))
    }
    row("PnL", "signed", position.pnlMicros, theirs.pnlMicros)
    row("cost", "money", position.values.costMicros, theirs.values.costMicros)
    row("value", "money", position.values.valueMicros, theirs.values.valueMicros)
  }
  const changed = changedAmounts(viewWithLinkedCosts(a.wallet, a.linked ?? [], method).legs, viewWithLinkedCosts(b.wallet, b.linked ?? [], method).legs)
  const changedTxs = new Set(changed.map((c) => c.txHash)).size
  return {
    address: a.wallet.address,
    currency: left.currency,
    blockNum,
    a: a.rule,
    b: b.rule,
    why: whySentence(changedTxs),
    warnings: combinedWarnings(a.rule, warningsOf(left), b.rule, warningsOf(right)),
    rows,
    transactions: changed.slice(0, MAX_COMPARED_TXS),
    changedTxs,
  }
}
