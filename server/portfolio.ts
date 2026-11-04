// The portfolio a wallet's legs fold into, for clients that don't run the fold themselves.
// One source of PnL logic: this calls what the browser calls, and adds nothing to the math.

import { hasStarted, isBehind, type ExplanationLeg, type ExplanationResponse, type PortfolioPosition, type PortfolioResponse, type WalletResponse } from "../src/core/api.ts"
import { emptyBook, type Book } from "../src/core/book.ts"
import { describeEffect, describeNetting, explainMetric, explainPoint, explainTotal, type Explanation, type Metric, type TotalMetric } from "../src/core/explain.ts"
import type { Method } from "../src/core/fold.ts"
import { foldBook, missingWallets, type LegEffect, type Position } from "../src/core/portfolio.ts"
import type { Question } from "../src/core/resolve.ts"
import { TOKENS } from "../src/core/tokens.ts"

/** Matches the web panel: a busy wallet has thousands of legs, and the newest are the ones anyone reads. */
const MAX_LEGS = 200

const ASSET_METRICS: readonly string[] = ["amount", "average", "value", "realized", "unrealized", "onchain"] satisfies Metric[]
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

function positionOf({ asset, decimals, price, values, state, effects, reconciliation, noMarket, estimates }: Position, questions: readonly Question[]): PortfolioPosition {
  const held = BigInt(values.qty) > 0n
  const { realizedUsdMicros: realized, unrealizedUsdMicros: unrealized } = values
  const pnl = (() => {
    // Units left that we never saw arrive, so whatever this position shows isn't all of it. Totals leave it out for the same reason.
    if (realized === null || BigInt(state.shortfallQty) > 0n) return null
    if (!held) return realized
    return unrealized === null ? null : (BigInt(realized) + BigInt(unrealized)).toString()
  })()
  return { asset, decimals, note: asset === "ETH" ? "incl. WETH" : null, price, values, pnlUsdMicros: pnl, shortfallQty: state.shortfallQty, legCount: effects.length, reconciliation, noMarket, estimates, resolvable: BigInt(values.unknownCostQty) > 0n && questions.some((q) => q.arrivals.some((a) => a.asset === asset)) }
}

export function portfolioOf(wallet: WalletResponse, method: Method, others: readonly WalletResponse[] = [], book: Book = emptyBook()): PortfolioResponse {
  const { positions, unread, totals, pnlStatus, points, questions, meter } = foldBook(wallet, others, method, book)
  return {
    address: wallet.address,
    mode: wallet.mode,
    method,
    coverage: wallet.coverage,
    // ETH is the allowlist's first entry, and everything else is a token.
    trackedTokens: TOKENS.length - 1,
    latest: wallet.latest,
    progress: { started: hasStarted(wallet), behindBlocks: isBehind(wallet) ? wallet.latest.blockNum - wallet.coverage.toBlock : 0 },
    gasUnknownTxs: wallet.gasUnknownTxs,
    l1FeeUnknownTxs: wallet.l1FeeUnknownTxs,
    openingUnread: wallet.openingUnread,
    unreadAssets: unread,
    positions: positions.map((position) => positionOf(position, questions)),
    totals,
    pnlStatus,
    points,
    questions,
    meter,
    linkedReading: missingWallets(book, wallet.address, others),
    unlistedTokens: wallet.unlistedTokens.length,
    marketChecked: wallet.marketChecked,
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
    estimated: leg.estimated === true,
    partlyUnknown: leg.pieces !== undefined && leg.pieces.some((p) => p.costUsdMicros === null) && leg.pieces.some((p) => p.costUsdMicros !== null),
    blockNum: leg.blockNum,
    timestamp: leg.timestamp,
    txHash: leg.txHash,
    opening: leg.opening === true,
    effect: describeEffect(effect),
    netting: describeNetting(leg),
  }
}

/** The same explanation the web panel shows for a click on this number. null when the wallet has no such asset or transaction. */
export function explainPortfolio(wallet: WalletResponse, method: Method, target: ExplainTarget, others: readonly WalletResponse[] = [], book: Book = emptyBook()): ExplanationResponse | null {
  const { positions, totals, points } = foldBook(wallet, others, method, book)
  const explanation = ((): Explanation | null => {
    if (target.kind === "total") return explainTotal(positions, totals, target.metric)
    if (target.kind === "asset") {
      const position = positions.find((p) => p.asset === target.asset)
      return position ? explainMetric(position, target.metric) : null
    }
    const point = points.find((p) => p.txHash === target.txHash)
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
