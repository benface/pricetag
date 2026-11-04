// The portfolio a wallet's legs fold into, for clients that don't run the fold themselves.
// One source of PnL logic: this calls what the browser calls, and adds nothing to the math.

import { TOKENS, type LegEffect, type Method, type Position } from "@pricetag/sdk/core"
import { hasStarted, isBehind, type ExplanationLeg, type ExplanationResponse, type PortfolioExchange, type PortfolioPosition, type PortfolioResponse, type WalletResponse } from "../src/core/api.ts"
import { emptyBook, linkedWallets, type Book } from "../src/core/book.ts"
import type { CurrencyCode, WalletView } from "../src/core/currency.ts"
import { describeConversion, describeEffect, describeNetting, explainTarget, rateSource, type ExplainContext, type ExplainTarget, type Metric, type TotalMetric } from "../src/core/explain.ts"
import { foldBook, missingWallets, type Question } from "../src/core/resolve.ts"
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
  const missing = missingWallets(book, wallet.address, others)
  const linkedFailed = linkedWallets(book).filter((address) => failed.includes(address))
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
  if (view.currency === "USD") return { view, source: null }
  const { positions, totals, points } = foldBook(wallet, others, method, book, { usd: true })
  return { view, source: { positions, totals, points } }
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
