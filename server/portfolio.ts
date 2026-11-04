// The portfolio a wallet's legs fold into, for clients that don't run the fold themselves.
// One source of PnL logic: this calls what the browser calls, and adds nothing to the math.

import { hasStarted, isBehind, type ExplanationLeg, type ExplanationResponse, type PnlStatus, type PortfolioExchange, type PortfolioPosition, type PortfolioResponse, type WalletResponse } from "../src/core/api.ts"
import { viewWallet, type CurrencyCode, type WalletView } from "../src/core/currency.ts"
import { describeConversion, describeEffect, describeNetting, explainContext, explainMetric, explainPoint, explainTotal, rateSource, type Explanation, type Metric, type TotalMetric } from "../src/core/explain.ts"
import type { Method } from "../src/core/fold.ts"
import { foldPositions, pnlOverTime, sumTotals, type LegEffect, type Position, type Totals } from "../src/core/portfolio.ts"
import { TOKENS } from "../src/core/tokens.ts"

/** Matches the web panel: a busy wallet has thousands of legs, and the newest are the ones anyone reads. */
const MAX_LEGS = 200

const ASSET_METRICS: readonly string[] = ["amount", "average", "value", "realized", "unrealized"] satisfies Metric[]
const TOTAL_METRICS: readonly string[] = ["pnl", "value", "realized", "unrealized", "gas"] satisfies TotalMetric[]

export type ExplainTarget =
  | { kind: "total"; metric: TotalMetric }
  | { kind: "asset"; asset: string; metric: Metric }
  | { kind: "tx"; txHash: string }

export function parseExplainTarget(params: URLSearchParams): ExplainTarget | null {
  const tx = params.get("tx")
  if (tx) return { kind: "tx", txHash: tx.toLowerCase() }
  const metric = params.get("metric") ?? ""
  const asset = params.get("asset")
  if (asset) return ASSET_METRICS.includes(metric) ? { kind: "asset", asset, metric: metric as Metric } : null
  return TOTAL_METRICS.includes(metric) ? { kind: "total", metric: metric as TotalMetric } : null
}

function positionOf({ asset, decimals, price, values, state, effects }: Position): PortfolioPosition {
  const held = BigInt(values.qty) > 0n
  const { realizedMicros: realized, unrealizedMicros: unrealized } = values
  const pnl = (() => {
    // Units left that we never saw arrive, so whatever this position shows isn't all of it. Totals leave it out for the same reason.
    if (realized === null || BigInt(state.shortfallQty) > 0n) return null
    if (!held) return realized
    return unrealized === null ? null : (BigInt(realized) + BigInt(unrealized)).toString()
  })()
  return { asset, decimals, note: asset === "ETH" ? "incl. WETH" : null, price, values, pnlMicros: pnl, shortfallQty: state.shortfallQty, legCount: effects.length }
}

function pnlStatusOf(totals: Totals, gasUnknownTxs: readonly string[]): PnlStatus {
  if (totals.pnlMicros === null) return "unavailable"
  return totals.excluded.length === 0 && !totals.unpricedGas && gasUnknownTxs.length === 0 ? "complete" : "partial"
}

function exchangeOf(view: WalletView): PortfolioExchange | null {
  if (view.currency === "USD") return null
  return { source: rateSource(view.currency), latestRateMicros: view.latestRate?.rateMicros ?? null, missingRateTxs: view.missingRateTxs }
}

export function portfolioOf(wallet: WalletResponse, method: Method): PortfolioResponse {
  const view = viewWallet(wallet)
  const positions = foldPositions(view.legs, method, view.prices)
  const totals = sumTotals(positions)
  return {
    address: wallet.address,
    mode: wallet.mode,
    method,
    currency: view.currency,
    exchange: exchangeOf(view),
    coverage: wallet.coverage,
    // ETH is the allowlist's first entry, and everything else is a token.
    trackedTokens: TOKENS.length - 1,
    latest: wallet.latest,
    progress: { started: hasStarted(wallet), behindBlocks: isBehind(wallet) ? wallet.latest.blockNum - wallet.coverage.toBlock : 0 },
    gasUnknownTxs: wallet.gasUnknownTxs,
    positions: positions.map(positionOf),
    totals,
    pnlStatus: pnlStatusOf(totals, wallet.gasUnknownTxs),
    points: pnlOverTime(view.legs, method, view.prices, view.markPrice, wallet.latest),
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
    effect: describeEffect(effect, currency),
    netting: describeNetting(leg),
    conversion: describeConversion(leg, currency),
  }
}

/** The same explanation the web panel shows for a click on this number. null when the wallet has no such asset or transaction. */
export function explainPortfolio(wallet: WalletResponse, method: Method, target: ExplainTarget): ExplanationResponse | null {
  const view = viewWallet(wallet)
  const positions = foldPositions(view.legs, method, view.prices)
  const context = explainContext(wallet, view, method)
  const explanation = ((): Explanation | null => {
    if (target.kind === "total") return explainTotal(positions, sumTotals(positions), target.metric, context)
    if (target.kind === "asset") {
      const position = positions.find((p) => p.asset === target.asset)
      return position ? explainMetric(position, target.metric, context) : null
    }
    const point = pnlOverTime(view.legs, method, view.prices, view.markPrice, wallet.latest).find((p) => p.txHash === target.txHash)
    return point ? explainPoint(positions, point, context) : null
  })()
  if (!explanation) return null
  return {
    currency: view.currency,
    title: explanation.title,
    value: explanation.value,
    sourceValue: explanation.sourceValue,
    lines: explanation.lines,
    legCount: explanation.effects.length,
    legs: explanation.effects.slice(0, MAX_LEGS).map((effect) => legOf(effect, view.currency)),
  }
}
