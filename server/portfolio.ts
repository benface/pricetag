// The portfolio a wallet's legs fold into, for clients that don't run the fold themselves.
// One source of PnL logic: this calls what the browser calls, and adds nothing to the math.

import { TOKENS, answerToMicros, worth, type CurrencyCode, type WalletView, type LegEffect, type Method, type Position, type PricedLeg, type Reference } from "@pricetag/sdk/core"
import { hasStarted, isBehind, type ExplanationLeg, type ExplanationResponse, type PortfolioExchange, type PortfolioPosition, type PortfolioResponse, type WalletResponse } from "../src/core/api.ts"
import { emptyBook, linkedWallets, type Book } from "../src/core/book.ts"
import { describeConversion, describeEffect, describeNetting, explainTarget, missingRatesLine, rateSource, type ExplainContext, type ExplainTarget, type Metric, type TotalMetric } from "../src/core/explain.ts"
import { foldBook, missingWallets, type Question } from "../src/core/resolve.ts"
import { differenceOf, whySentence, type PricingRule, type RuleComparison, type RuleRow, type RuleTransaction } from "../src/core/rules.ts"
import { ETH_NOTE, UNPRICED_FEES, estimatedSentence, excludedSentence, feesUnknownSentence, networkFeeUnknownSentence } from "../src/core/wording.ts"

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

function positionOf({ asset, decimals, price, values, state, effects, reconciliation, noMarket, estimates }: Position, questions: readonly Question[]): PortfolioPosition {
  const held = BigInt(values.qty) > 0n
  const { realizedMicros: realized, unrealizedMicros: unrealized } = values
  const pnl = (() => {
    // Units left that we never saw arrive, so whatever this position shows isn't all of it. Totals leave it out for the same reason.
    if (realized === null || BigInt(state.shortfallQty) > 0n) return null
    if (!held) return realized
    return unrealized === null ? null : (BigInt(realized) + BigInt(unrealized)).toString()
  })()
  return { asset, decimals, note: asset === "ETH" ? ETH_NOTE : null, price, values, pnlMicros: pnl, shortfallQty: state.shortfallQty, legCount: effects.length, reconciliation, noMarket, estimates, resolvable: BigInt(values.unknownCostQty) > 0n && questions.some((q) => q.arrivals.some((a) => a.asset === asset)) }
}

function exchangeOf(view: WalletView): PortfolioExchange | null {
  if (view.currency === "USD") return null
  return { source: rateSource(view.currency), latestRateMicros: view.latestRate?.rateMicros ?? null, missingRateTxs: view.missingRateTxs }
}

function outgoingTxsOf(wallet: WalletResponse): string[] {
  return [...new Set([...wallet.legs.filter((leg) => BigInt(leg.delta) < 0n).map((leg) => leg.txHash), ...wallet.gasUnknownTxs])]
}

/** What a portfolio goes by without any answers: the wallets it's read with are the user's own, and that's all it knows. */
const linkingTo = (others: readonly WalletResponse[]): Book => ({ ...emptyBook(), linked: others.map((other) => other.address.toLowerCase()) })

export function portfolioOf(wallet: WalletResponse, method: Method, others: readonly WalletResponse[] = [], book: Book = linkingTo(others), failed: readonly string[] = []): PortfolioResponse {
  const { view, positions, unread, totals, pnlStatus, points, questions, meter } = foldBook(wallet, others, method, book)
  const missing = missingWallets(book, wallet, others)
  const linkedFailed = linkedWallets(book).filter((address) => failed.includes(address))
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
    unreadAssets: unread,
    positions: positions.map((position) => positionOf(position, questions)),
    totals,
    pnlStatus,
    points,
    questions,
    // A wallet that fails on a later read leaves what it sent out of date, so nothing's balanced until it's back.
    meter: { ...meter, waiting: new Set([...missing, ...linkedFailed]).size },
    linkedReading: missing.filter((address) => !linkedFailed.includes(address)),
    linkedFailed,
    marketChecked: wallet.marketChecked,
  }
}

/** The USD side of a number, folded with the same answers, so the two can't disagree about what's known. */
export function bookContext(wallet: WalletResponse, others: readonly WalletResponse[], method: Method, book: Book, view: WalletView): ExplainContext {
  const ruleNote = wallet.ruleNote ?? null
  if (view.currency === "USD") return { view, source: null, ruleNote }
  const { positions, totals, points } = foldBook(wallet, others, method, book, { usd: true })
  return { view, ruleNote, source: { positions, totals, points } }
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
    estimated: leg.estimated === true,
    partlyUnknown: leg.pieces !== undefined && leg.pieces.some((p) => p.costMicros === null) && leg.pieces.some((p) => p.costMicros !== null),
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
export function explainPortfolio(wallet: WalletResponse, method: Method, target: ExplainTarget, others: readonly WalletResponse[] = [], book: Book = linkingTo(others)): ExplanationResponse | null {
  const { view, positions, totals, points } = foldBook(wallet, others, method, book)
  const explanation = explainTarget(target, { positions, totals, points }, bookContext(wallet, others, method, book, view))
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

type ComparedAmount = Pick<RuleTransaction, "txHash" | "blockNum" | "timestamp" | "asset" | "label"> & { parts: (string | null)[]; estimated: boolean }

/**
 * Each transaction's cost, sale value and network fee per asset. A transfer between linked wallets can carry several
 * purchases, but people read one amount for one transaction.
 */
function comparedAmounts(legs: readonly PricedLeg[]): Map<string, ComparedAmount> {
  const amounts = new Map<string, ComparedAmount>()
  const add = (leg: PricedLeg, label: RuleTransaction["label"], value: string | null, estimated: boolean) => {
    const key = `${leg.txHash}:${leg.asset}:${label}`
    const known = amounts.get(key)
    if (known) {
      known.parts.push(value)
      known.estimated ||= estimated
    } else amounts.set(key, { txHash: leg.txHash, blockNum: leg.blockNum, timestamp: leg.timestamp, asset: leg.asset, label, parts: [value], estimated })
  }
  for (const leg of legs) {
    // A fee has no cost or sale value. It's spent at the price of its block, the same way the fold counts it.
    if (leg.kind === "gas") add(leg, "Network fee", leg.priceMicros === null ? null : worth(BigInt(leg.delta.replace("-", "")), BigInt(leg.priceMicros), leg.decimals).toString(), false)
    else {
      // What a transfer carried has its own part per purchase, so a change inside an unknown total still shows.
      if (leg.pieces) for (const { costMicros, estimatedCostMicros } of leg.pieces) add(leg, "Cost", costMicros, BigInt(estimatedCostMicros) > 0n)
      else add(leg, "Cost", leg.costMicros, leg.estimated === true && leg.costMicros !== null)
      add(leg, "Sold for", leg.proceedsMicros, leg.estimated === true && leg.proceedsMicros !== null)
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
  for (const [key, { parts, estimated, ...base }] of comparedAmounts(a)) {
    const other = theirs.get(key)
    const otherParts = other?.parts ?? [null]
    if (JSON.stringify(parts) === JSON.stringify(otherParts)) continue
    const [x, y] = [sumOf(parts), sumOf(otherParts)]
    changed.push({ ...base, a: x, b: y, difference: differenceOf(x, y), aEstimated: x !== null && estimated, bEstimated: y !== null && other?.estimated === true })
  }
  return changed.sort((x, y) => y.blockNum - x.blockNum)
}

/** What a portfolio's numbers leave out or can't vouch for, as the main screen says it. */
function warningsOf({ totals, currency, exchange, gasUnknownTxs, l1FeeUnknownTxs }: PortfolioResponse): string[] {
  return [
    estimatedSentence(totals.estimatedMicros, currency),
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
export function compareRules(a: Compared, b: Compared, method: Method, blockNum: number, book: Book = linkingTo(a.linked ?? [])): RuleComparison {
  const [left, right] = [portfolioOf(a.wallet, method, a.linked, book), portfolioOf(b.wallet, method, b.linked, book)]
  // A sum that leaves out something else on the other side isn't a difference between rules.
  const sameMakeup = JSON.stringify([left.totals.excluded, left.totals.unpricedGas]) === JSON.stringify([right.totals.excluded, right.totals.unpricedGas])
  const rowOf = (label: string, format: RuleRow["format"], x: string | null, y: string | null, partial: [boolean, boolean] = [false, false], comparable = true, estimated: [boolean, boolean] = [false, false]): RuleRow => ({
    label,
    format,
    a: x,
    b: y,
    difference: comparable ? differenceOf(x, y) : null,
    aPartial: x !== null && partial[0],
    bPartial: y !== null && partial[1],
    aEstimated: x !== null && estimated[0],
    bEstimated: y !== null && estimated[1],
  })
  const totals = (key: "pnlMicros" | "realizedMicros" | "unrealizedMicros" | "valueMicros", part: "pnl" | "realized" | "unrealized" | "value", label: string, format: RuleRow["format"]) => {
    const [x, y] = [left.totals.coverage[part], right.totals.coverage[part]]
    const isEstimated = ({ totals }: PortfolioResponse) => (part === "pnl" ? BigInt(totals.estimatedMicros) > 0n : totals.estimated[part])
    return rowOf(label, format, left.totals[key], right.totals[key], [x.missing > 0, y.missing > 0], sameMakeup && x.known === y.known && x.missing === y.missing, [isEstimated(left), isEstimated(right)])
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
    const row = (label: string, format: RuleRow["format"], x: string | null, y: string | null, estimated: (p: PortfolioPosition) => boolean) => {
      if (x !== y) rows.push(rowOf(`${position.asset} ${label}`, format, x, y, [false, false], true, [estimated(position), estimated(theirs)]))
    }
    row("PnL", "signed", position.pnlMicros, theirs.pnlMicros, ({ estimates }) => estimates.realized || estimates.unrealized)
    row("cost", "money", position.values.costMicros, theirs.values.costMicros, ({ estimates }) => estimates.cost)
    row("value", "money", position.values.valueMicros, theirs.values.valueMicros, ({ estimates }) => estimates.value)
  }
  const changed = changedAmounts(foldBook(a.wallet, a.linked ?? [], method, book).legs, foldBook(b.wallet, b.linked ?? [], method, book).legs)
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
