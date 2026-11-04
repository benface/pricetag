// The portfolio a wallet's legs fold into, for clients that don't run the fold themselves.
// One source of PnL logic: this calls what the browser calls, and adds nothing to the math.

import { TOKENS, answerToMicros, foldPositions, pnlOverTime, pnlStatus, sumTotals, unconfirmedAssets, unreadAssets, type LegEffect, type Method, type Position, type PricedLeg, type ReferenceRow, type Totals } from "@pricetag/sdk/core"
import { hasStarted, isBehind, type ExplanationLeg, type ExplanationResponse, type PortfolioExchange, type PortfolioPosition, type PortfolioResponse, type WalletResponse } from "../src/core/api.ts"
import { viewWallet, type CurrencyCode, type WalletView } from "../src/core/currency.ts"
import { inheritCosts } from "../src/core/linked.ts"
import { describeConversion, describeEffect, describeNetting, explainContext, explainTarget, rateSource, type ExplainTarget, type Metric, type TotalMetric } from "../src/core/explain.ts"
import { differenceOf, whySentence, type PricingRule, type RuleComparison, type RuleRow, type RuleTransaction } from "../src/core/rules.ts"
import { ETH_NOTE } from "../src/core/wording.ts"

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
  const view = viewWithLinkedCosts(wallet, linked, method)
  const positions = foldPositions(view.legs, method, view.prices, wallet)
  const unread = unreadAssets(positions, wallet)
  const totals = sumTotals(positions, unread)
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
    positions: positions.map(positionOf),
    totals,
    pnlStatus: pnlStatus(totals, wallet.gasUnknownTxs),
    points: pnlOverTime(view.legs, method, view.prices, view.markPrice, wallet.latest, unconfirmedAssets(positions, unread)),
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
  const view = viewWithLinkedCosts(wallet, linked, method)
  const positions = foldPositions(view.legs, method, view.prices, wallet)
  const unread = unreadAssets(positions, wallet)
  const totals = sumTotals(positions, unread)
  const points = pnlOverTime(view.legs, method, view.prices, view.markPrice, wallet.latest, unconfirmedAssets(positions, unread))
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

/** Each leg's cost and sale value by the other rule, for what came out differently. */
function changedLegs(a: readonly PricedLeg[], b: readonly PricedLeg[]): RuleTransaction[] {
  const other = new Map(b.map((leg) => [leg.id, leg]))
  const changed: RuleTransaction[] = []
  for (const leg of a) {
    const theirs = other.get(leg.id)
    if (!theirs) continue
    const base = { txHash: leg.txHash, blockNum: leg.blockNum, timestamp: leg.timestamp, asset: leg.asset }
    if (leg.costMicros !== theirs.costMicros) changed.push({ ...base, label: "Cost", a: leg.costMicros, b: theirs.costMicros, difference: differenceOf(leg.costMicros, theirs.costMicros) })
    if (leg.proceedsMicros !== theirs.proceedsMicros) changed.push({ ...base, label: "Sold for", a: leg.proceedsMicros, b: theirs.proceedsMicros, difference: differenceOf(leg.proceedsMicros, theirs.proceedsMicros) })
  }
  return changed.sort((x, y) => y.blockNum - x.blockNum)
}

type Compared = { rule: PricingRule; wallet: WalletResponse; reference: ReferenceRow | null; linked?: readonly WalletResponse[] }

/** One wallet by two rules, both folded by the same code, so the rule is all that can differ. */
export function compareRules(a: Compared, b: Compared, method: Method, blockNum: number): RuleComparison {
  const [left, right] = [portfolioOf(a.wallet, method, a.linked), portfolioOf(b.wallet, method, b.linked)]
  const rowOf = (label: string, format: RuleRow["format"], x: string | null, y: string | null): RuleRow => ({ label, format, a: x, b: y, difference: differenceOf(x, y) })
  const totals = (key: "pnlMicros" | "realizedMicros" | "unrealizedMicros" | "valueMicros", label: string, format: RuleRow["format"]) => rowOf(label, format, left.totals[key], right.totals[key])
  const rows: RuleRow[] = [
    rowOf("ETH price", "usdPrice", answerToMicros(a.reference?.eth_usd), answerToMicros(b.reference?.eth_usd)),
    totals("pnlMicros", "Total PnL", "signed"),
    totals("realizedMicros", "Realized", "signed"),
    totals("unrealizedMicros", "Unrealized", "signed"),
    totals("valueMicros", "Value", "money"),
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
  const changed = changedLegs(viewWithLinkedCosts(a.wallet, a.linked ?? [], method).legs, viewWithLinkedCosts(b.wallet, b.linked ?? [], method).legs)
  const changedTxs = new Set(changed.map((c) => c.txHash)).size
  return {
    address: a.wallet.address,
    currency: left.currency,
    blockNum,
    a: a.rule,
    b: b.rule,
    why: whySentence(changedTxs),
    rows,
    transactions: changed.slice(0, MAX_COMPARED_TXS),
    changedTxs,
  }
}
