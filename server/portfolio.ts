// The portfolio a wallet's legs fold into, for clients that don't run the fold themselves.
// One source of PnL logic: this calls what the browser calls, and adds nothing to the math.

import type { ExplanationLeg, ExplanationResponse, PnlStatus, PortfolioPosition, PortfolioResponse, WalletResponse } from "../src/core/api.ts"
import { describeEffect, describeNetting, explainMetric, explainPoint, explainTotal, type Explanation, type Metric, type TotalMetric } from "../src/core/explain.ts"
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
  const { realizedUsdMicros: realized, unrealizedUsdMicros: unrealized } = values
  const pnl = realized === null ? null : !held ? realized : unrealized === null ? null : (BigInt(realized) + BigInt(unrealized)).toString()
  return { asset, decimals, note: asset === "ETH" ? "incl. WETH" : null, price, values, pnlUsdMicros: pnl, shortfallQty: state.shortfallQty, legCount: effects.length }
}

function pnlStatusOf(totals: Totals, gasUnknownTxs: readonly string[]): PnlStatus {
  if (totals.excluded.length === 0 && !totals.unpricedGas && gasUnknownTxs.length === 0) return "complete"
  const anythingKnown = totals.coverage.unrealized.known > 0 || BigInt(totals.realizedUsdMicros) !== 0n || BigInt(totals.gasUsdMicros) !== 0n
  return anythingKnown ? "partial" : "unavailable"
}

export function portfolioOf(wallet: WalletResponse, method: Method): PortfolioResponse {
  const positions = foldPositions(wallet.legs, method, wallet.prices)
  const totals = sumTotals(positions)
  return {
    address: wallet.address,
    mode: wallet.mode,
    method,
    coverage: wallet.coverage,
    // ETH is the allowlist's first entry, and everything else is a token.
    trackedTokens: TOKENS.length - 1,
    latest: wallet.latest,
    gasUnknownTxs: wallet.gasUnknownTxs,
    positions: positions.map(positionOf),
    totals,
    pnlStatus: pnlStatusOf(totals, wallet.gasUnknownTxs),
    points: pnlOverTime(wallet.legs, method, wallet.prices, wallet.references, wallet.latest),
  }
}

function legOf(effect: LegEffect): ExplanationLeg {
  const { leg } = effect
  return {
    id: leg.id,
    asset: leg.asset,
    delta: leg.delta,
    decimals: leg.decimals,
    kind: leg.kind,
    priceUsdMicros: leg.priceUsdMicros,
    priceSource: leg.priceSource,
    priceNote: leg.priceNote,
    costLabel: leg.costLabel,
    blockNum: leg.blockNum,
    timestamp: leg.timestamp,
    txHash: leg.txHash,
    effect: describeEffect(effect),
    netting: describeNetting(leg),
  }
}

/** The same explanation the web panel shows for a click on this number. null when the wallet has no such asset or transaction. */
export function explainPortfolio(wallet: WalletResponse, method: Method, target: ExplainTarget): ExplanationResponse | null {
  const positions = foldPositions(wallet.legs, method, wallet.prices)
  const explanation = ((): Explanation | null => {
    if (target.kind === "total") return explainTotal(positions, sumTotals(positions), target.metric)
    if (target.kind === "asset") {
      const position = positions.find((p) => p.asset === target.asset)
      return position ? explainMetric(position, target.metric) : null
    }
    const point = pnlOverTime(wallet.legs, method, wallet.prices, wallet.references, wallet.latest).find((p) => p.txHash === target.txHash)
    return point ? explainPoint(positions, point) : null
  })()
  if (!explanation) return null
  return {
    title: explanation.title,
    value: explanation.value,
    lines: explanation.lines,
    legCount: explanation.effects.length,
    legs: explanation.effects.slice(0, MAX_LEGS).map(legOf),
  }
}
