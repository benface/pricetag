// Every wallet that's the user's, as one. Each is folded the way it is on its own, with the others linked so costs carry
// between them, and then the results are added up.
//
// A move from one of these wallets to another isn't a gain, a loss or a new cost: the debit carries its cost away with no
// gain, and the credit takes it as `inherited`. So adding up already nets a move out, and its network fee still counts,
// once, in the wallet that paid it. Only what counts money in and out of the user's wallets, like the comparison with
// holding ETH, has to leave moves out by name.

import { CHECK_LABELS } from "./wording.ts"
import { NO_FACTS, combinedFacts, type TransactionFacts } from "./activity.ts"
import { compareWithHoldingEth, formatAmount, formatMoney, formatPrice, formatReturn, formatSignedMoney, hasStarted, pnlOverTime, pnlStatus as statusOf, returnBps, sumTotals, unconfirmedAssets, type CurrencyCode, type Exclusion, type HoldComparison, type LatestPrices, type LegEffect, type MarkPrice, type Method, type PnlPoint, type Position, type PricedLeg, type Reconciliation, type Totals } from "@pricetag/sdk/core"
import type { BookPoint, BookPreview, ExplanationLeg, ExplanationResponse, PortfolioPosition, PortfolioResponse, WalletResponse } from "./api.ts"
import type { Book } from "./book.ts"
import { explainHold, explainPoint, explainTarget, explainTotal, type ExplainTarget, type Explanation, type Metric } from "./explain.ts"
import { exportCsv } from "./export.ts"
import { foldBook, meterOf, type BookFold, type Question } from "./resolve.ts"
import { isMove, movesBetween } from "./tax.ts"
import { describeTransaction, movedBetweenSentence } from "./wording.ts"
import { MAX_LEGS, bookContext, legOf, responseOf } from "./portfolio.ts"

/** What a client asks for in place of an address, for all of its user's wallets at once. */
export const ALL_YOURS = "all"

/** How far each wallet's read has got. One that's still reading or failed isn't in the numbers yet. */
export type CombinedWallet = { address: string; state: "read" | "reading" | "failed" }

/** One wallet's share of a holding, so an unknown can say where it is. */
export type PositionPart = Pick<PortfolioPosition["values"], "qty" | "unknownCostQty" | "costMicros" | "valueMicros"> & { wallet: string; pnlMicros: string | null; resolvable: boolean; reconciliation: Reconciliation["status"] | null }

export type CombinedPosition = PortfolioPosition & { wallets: PositionPart[] }

export type CombinedPoint = BookPoint & { wallets: string[] }

export type CombinedPortfolioResponse = Omit<PortfolioResponse, "positions" | "points" | "totals"> & {
  positions: CombinedPosition[]
  totals: Omit<Totals, "excluded"> & { excluded: (Exclusion & { wallet: string })[] }
  points: CombinedPoint[]
  wallets: CombinedWallet[]
}

/** Which wallets aren't in the numbers yet. */
export type Unread = { reading: readonly string[]; failed: readonly string[] }

/** Every wallet that could be read, all at one block so a move between them is in both or neither, for a client that runs the fold itself. */
export type AllYoursRead = { wallets: WalletResponse[]; unread: Unread }

type Folded = { address: string; wallet: WalletResponse; others: WalletResponse[]; fold: BookFold }

/** Every wallet asked about is the user's, which is what asking for them together says, so costs carry between all of them. */
function linkingAll(book: Book, addresses: readonly string[]): Book {
  return { ...book, linked: [...new Set([...(book.linked ?? []), ...addresses.map((address) => address.toLowerCase())])] }
}

function foldAll(read: readonly WalletResponse[], method: Method, book: Book): Folded[] {
  return read.map((wallet) => {
    const others = read.filter((other) => other !== wallet)
    return { address: wallet.address.toLowerCase(), wallet, others, fold: foldBook(wallet, others, method, book) }
  })
}

const unique = <T>(values: Iterable<T>) => [...new Set(values)]

/** The first that has a price, since each wallet's reads only have the blocks it was read at. */
const markOf =
  (folded: readonly Folded[]): MarkPrice =>
  (blockNum, asset) =>
    folded.map(({ fold }) => fold.view.markPrice(blockNum, asset)).find((price) => price !== null) ?? null

const noTotals = (): Totals => ({ ...sumTotals([]), valueMicros: null, realizedMicros: null, unrealizedMicros: null, gasMicros: null, pnlMicros: null })

const sum = (values: readonly string[]) => values.reduce((total, value) => total + BigInt(value), 0n).toString()
/** One unknown part leaves the whole unknown. It's never added up as if that part were zero. */
const sumKnown = (values: readonly (string | null)[]) => (values.includes(null) ? null : sum(values as string[]))
const isPositive = (units: string) => BigInt(units) > 0n

const WORST: Reconciliation["status"][] = ["incomplete", "unchecked", "reconciled"]

/** Every wallet's check of one asset as one: what the worst one says, with amounts added up where they mean the same thing. */
function combinedCheck(checks: readonly (Reconciliation | null)[]): Reconciliation | null {
  const known = checks.filter((check) => check !== null)
  if (known.length === 0) return null
  const worst = WORST.find((status) => known.some((check) => check.status === status)) as Reconciliation["status"]
  if (worst === "unchecked") {
    const unchecked = known.filter((check) => check.status === "unchecked")
    const held = known.map((check) => (check.status === "unchecked" ? check.heldQty : check.actualQty))
    return { status: "unchecked", reason: unchecked[0]!.reason, heldQty: sumKnown(held), heldIsCurrent: unchecked.every((check) => check.heldIsCurrent) }
  }
  const counted = known.filter((check) => check.status !== "unchecked")
  return {
    status: worst,
    blockNum: Math.min(...counted.map((check) => check.blockNum)),
    computedQty: sum(counted.map((check) => check.computedQty)),
    actualQty: sum(counted.map((check) => check.actualQty)),
    differenceQty: sum(counted.map((check) => check.differenceQty)),
    ...(counted.some((check) => check.unseenEth) ? { unseenEth: counted.flatMap((check) => check.unseenEth ?? []) } : {}),
  }
}

/** One holding across wallets, in the order each asset first appears. */
function combinedPositions(parts: readonly { wallet: string; position: PortfolioPosition }[]): CombinedPosition[] {
  const byAsset = new Map<string, { wallet: string; position: PortfolioPosition }[]>()
  for (const part of parts) byAsset.set(part.position.asset, [...(byAsset.get(part.position.asset) ?? []), part])
  return [...byAsset.values()].map((group) => {
    const positions = group.map(({ position }) => position)
    const first = positions[0] as PortfolioPosition
    const values = positions.map((p) => p.values)
    const qty = BigInt(sum(values.map((v) => v.qty)))
    const cost = sumKnown(values.map((v) => v.costMicros))
    const heldWithoutValue = values.some((v) => isPositive(v.qty) && v.valueMicros === null)
    const priced = values.map((v) => v.valueMicros).filter((v) => v !== null)
    const unrealized = sumKnown(values.map((v) => v.unrealizedMicros))
    return {
      asset: first.asset,
      decimals: first.decimals,
      note: positions.find((p) => p.note !== null)?.note ?? null,
      price: positions.find((p) => p.price !== null)?.price ?? null,
      values: {
        qty: qty.toString(),
        unknownCostQty: sum(values.map((v) => v.unknownCostQty)),
        costMicros: cost,
        averageCostMicros: cost !== null && qty > 0n ? ((BigInt(cost) * 10n ** BigInt(first.decimals)) / qty).toString() : null,
        valueMicros: heldWithoutValue || priced.length === 0 ? null : sum(priced),
        realizedMicros: sumKnown(values.map((v) => v.realizedMicros)),
        unrealizedMicros: unrealized,
        estimatedCostMicros: sum(values.map((v) => v.estimatedCostMicros)),
        estimatedRealizedMicros: sum(values.map((v) => v.estimatedRealizedMicros)),
      },
      pnlMicros: sumKnown(positions.map((p) => p.pnlMicros)),
      returnBps: returnBps({ costMicros: cost, unrealizedMicros: unrealized }),
      shortfallQty: sum(positions.map((p) => p.shortfallQty)),
      legCount: positions.reduce((total, p) => total + p.legCount, 0),
      reconciliation: combinedCheck(positions.map((p) => p.reconciliation)),
      noMarket: positions.every((p) => p.noMarket),
      estimates: {
        cost: positions.some((p) => p.estimates.cost),
        value: positions.some((p) => p.estimates.value),
        realized: positions.some((p) => p.estimates.realized),
        unrealized: positions.some((p) => p.estimates.unrealized),
      },
      resolvable: positions.some((p) => p.resolvable),
      wallets: group.map(({ wallet, position: { values: v, pnlMicros, resolvable, reconciliation } }) => ({ wallet, qty: v.qty, unknownCostQty: v.unknownCostQty, costMicros: v.costMicros, valueMicros: v.valueMicros, pnlMicros, resolvable, reconciliation: reconciliation?.status ?? null })),
    }
  })
}

/**
 * Total PnL after each transaction in any of the wallets, each wallet's holdings kept apart the way its own chart keeps them,
 * and all of them marked at that moment's prices. Adding up each wallet's own points wouldn't do: they're marked at the prices
 * of their own transactions, not each other's.
 */
function combinedPoints(started: readonly Folded[], mark: MarkPrice, latest: { blockNum: number; timestamp: string }, method: Method): PnlPoint[] {
  const key = (address: string, asset: string) => `${address}|${asset}`
  const assetOf = (keyed: string) => keyed.slice(keyed.indexOf("|") + 1)
  // Sorting is stable, so each wallet's order holds inside a transaction, and one transaction's legs stay together.
  const legs = started.flatMap(({ address, fold }) => fold.legs.map((leg) => ({ ...leg, asset: key(address, leg.asset) }))).sort((a, b) => a.blockNum - b.blockNum || a.txIndex - b.txIndex)
  const prices: LatestPrices = {}
  for (const { address, fold } of started) for (const position of fold.positions) prices[key(address, position.asset)] = fold.view.prices[position.asset]
  const unconfirmed = new Set(started.flatMap(({ address, fold }) => [...unconfirmedAssets(fold.positions, fold.unread)].map((asset) => key(address, asset))))
  const noMarket = new Set(started.flatMap(({ address, fold }) => fold.totals.noMarket.map((asset) => key(address, asset))))
  return pnlOverTime(legs, method, prices, (blockNum, keyed) => mark(blockNum, assetOf(keyed)), latest, unconfirmed, noMarket)
}

/** What a transaction did across the wallets. A move between them says so, rather than that one sent and another received. */
function summaryOf(legs: readonly PricedLeg[], moves: ReadonlySet<string>, currency: CurrencyCode): string | null {
  const arrived = legs.filter((leg) => isMove(leg, moves) && BigInt(leg.delta) > 0n)
  if (arrived.length === 0) return describeTransaction(legs, currency)
  const move = movedBetweenSentence(arrived)
  const rest = legs.filter((leg) => !isMove(leg, moves) && leg.kind !== "gas")
  const said = rest.length > 0 ? describeTransaction(rest, currency) : null
  return said ? `${said}, ${move[0]!.toLowerCase()}${move.slice(1)}` : move
}

type Combined = {
  folded: Folded[]
  started: Folded[]
  responses: PortfolioResponse[]
  positions: CombinedPosition[]
  /** Each wallet's own positions, whose effects say what happened to each holding in it. */
  walletPositions: Position[]
  totals: CombinedPortfolioResponse["totals"]
  points: CombinedPoint[]
  /** Moves between the wallets, by `txHash:asset`. */
  moves: Set<string>
  /** Each wallet's positions without moves between the wallets, which are neither money put in nor taken out. */
  holdPositions: Position[]
  holdComparison: HoldComparison
  questions: Question[]
  walletOf: Map<PricedLeg, string>
  mark: MarkPrice
}

function combine(read: readonly WalletResponse[], method: Method, book: Book, { failed }: Unread): Combined {
  const folded = foldAll(read, method, book)
  const started = folded.filter(({ wallet }) => hasStarted(wallet))
  const responses = folded.map(({ wallet, others, fold }) => responseOf(wallet, method, others, book, failed, fold))
  const positions = combinedPositions(folded.flatMap(({ address }, i) => (hasStarted(folded[i]!.wallet) ? (responses[i] as PortfolioResponse).positions.map((position) => ({ wallet: address, position })) : [])))
  const walletPositions = started.flatMap(({ fold }) => fold.positions)
  const gasUnknownTxs = unique(folded.flatMap(({ wallet }) => wallet.gasUnknownTxs))
  const summed = started.length > 0 ? sumTotals(walletPositions, started.flatMap(({ fold }) => fold.unread)) : noTotals()
  // The same exclusions each wallet's own total makes, saying which wallet each is in.
  const totals = { ...summed, excluded: started.flatMap(({ address, fold }) => fold.totals.excluded.map((exclusion) => ({ ...exclusion, wallet: address }))) }
  const status = statusOf(summed, gasUnknownTxs)
  const moves = movesBetween(started.map(({ wallet, fold }) => ({ wallet, view: { ...fold.view, legs: fold.legs } })))
  const mark = markOf(folded)
  const latest = read.reduce((newest, wallet) => (wallet.latest.blockNum > newest.blockNum ? wallet.latest : newest), (read[0] as WalletResponse).latest)

  const walletOf = new Map<PricedLeg, string>()
  const byTx = new Map<string, { wallet: string; leg: PricedLeg }[]>()
  for (const { address, fold } of started) {
    for (const leg of fold.legs) {
      walletOf.set(leg, address)
      if (!leg.opening) byTx.set(leg.txHash, [...(byTx.get(leg.txHash) ?? []), { wallet: address, leg }])
    }
  }
  const currency = (folded[0] as Folded).fold.view.currency
  const factsIn = new Map<string, TransactionFacts[]>()
  for (const { fold } of started) {
    for (const { txHash, assets, counterparty, amount, gain, unknownCost } of fold.points) {
      if (txHash) factsIn.set(txHash, [...(factsIn.get(txHash) ?? []), { assets, counterparty, amount, gain, unknownCost }])
    }
  }
  const everyWallet = new Set(started.map(({ address }) => address))
  const points = combinedPoints(started, mark, latest, method).map((point): CombinedPoint => {
    const entries = point.txHash ? (byTx.get(point.txHash) ?? []) : []
    const legs = entries.map(({ leg }) => leg)
    const facts = point.txHash ? combinedFacts(legs, factsIn.get(point.txHash) ?? [], everyWallet) : NO_FACTS
    return { ...point, summary: point.txHash ? summaryOf(legs, moves, currency) : null, ...facts, wallets: unique(entries.map(({ wallet }) => wallet)) }
  })

  const holdPositions = walletPositions.map((position) => ({ ...position, effects: position.effects.filter(({ leg }) => !isMove(leg, moves)) }))
  // Each wallet's own latest prices, first one first, for the ETH that holding would have.
  const prices: LatestPrices = Object.assign({}, ...folded.map(({ fold }) => fold.view.prices).reverse())
  const holdComparison = compareWithHoldingEth(holdPositions, summed, status, prices, mark)

  // Each wallet's fold already asks about what arrived in any of them, so this only takes out the repeats.
  const questions = [...new Map(folded.flatMap(({ fold }) => fold.questions).map((question) => [question.id, question])).values()].sort((a, b) => {
    const [x, y] = [BigInt(a.valueMicros ?? "0"), BigInt(b.valueMicros ?? "0")]
    return x === y ? a.id.localeCompare(b.id) : x > y ? -1 : 1
  })
  return { folded, started, responses, positions, walletPositions, totals, points, moves, holdPositions, holdComparison, questions, walletOf, mark }
}

/**
 * The portfolio of every wallet in `read`, as one. `unread` is the wallets asked about that aren't read yet, or failed, which
 * aren't in the numbers, so they're listed apart. `read` needs at least one wallet, all in the same currency and by the same rule.
 */
export function combinedPortfolioOf(read: readonly WalletResponse[], method: Method, book: Book, unread: Unread = { reading: [], failed: [] }): CombinedPortfolioResponse {
  const linking = linkingAll(book, [...read.map((wallet) => wallet.address), ...unread.reading, ...unread.failed])
  const { folded, responses, positions, totals, points, holdComparison, questions } = combine(read, method, linking, unread)
  const [first] = responses as [PortfolioResponse]
  const gasUnknownTxs = unique(responses.flatMap((r) => r.gasUnknownTxs))
  const unlisted = new Map<string, number>()
  for (const { token, transfers } of responses.flatMap((r) => r.unlisted)) unlisted.set(token, (unlisted.get(token) ?? 0) + transfers)
  const withheld = new Map(responses.flatMap((r) => r.withheld).map((w) => [`${w.wallet}:${w.asset}`, w]))
  const waiting = unread.reading.length + unread.failed.length
  return {
    address: ALL_YOURS,
    mode: first.mode,
    method,
    rule: first.rule,
    currency: first.currency,
    exchange: first.exchange && { ...first.exchange, missingRateTxs: unique(responses.flatMap((r) => r.exchange?.missingRateTxs ?? [])) },
    coverage: { fromBlock: Math.min(...responses.map((r) => r.coverage.fromBlock)), toBlock: Math.min(...responses.map((r) => r.coverage.toBlock)) },
    trackedTokens: first.trackedTokens,
    latest: responses.reduce((newest, r) => (r.latest.blockNum > newest.blockNum ? r.latest : newest), first.latest),
    progress: { started: responses.every((r) => r.progress.started), behindBlocks: Math.max(...responses.map((r) => r.progress.behindBlocks)) },
    gasUnknownTxs,
    outgoingTxs: unique(responses.flatMap((r) => r.outgoingTxs)),
    unlisted: [...unlisted].map(([token, transfers]) => ({ token, transfers })),
    l1FeeUnknownTxs: unique(responses.flatMap((r) => r.l1FeeUnknownTxs)),
    openingUnread: unique(responses.flatMap((r) => r.openingUnread)),
    unreadAssets: unique(responses.flatMap((r) => r.unreadAssets)),
    positions,
    totals,
    pnlStatus: statusOf(totals as Totals, gasUnknownTxs),
    points,
    holdComparison,
    questions,
    meter: { ...meterOf(questions, linking, (folded[0] as Folded).wallet, waiting), waiting },
    linkedReading: [...unread.reading],
    linkedFailed: [...unread.failed],
    withheld: [...withheld.values()],
    purchases: first.purchases,
    marketChecked: responses.every((r) => r.marketChecked),
    wallets: [...read.map((wallet) => ({ address: wallet.address.toLowerCase(), state: "read" as const })), ...unread.reading.map((address) => ({ address, state: "reading" as const })), ...unread.failed.map((address) => ({ address, state: "failed" as const }))],
  }
}

/** One wallet's side of a number. */
export type ExplanationPart = { wallet: string; value: string | null; lines: string[] }

/** The same explanation with its legs folded, for a client that shows them itself. `walletOf` says which wallet each is in. */
export type CombinedExplanation = Explanation & { parts: ExplanationPart[]; walletOf: (leg: PricedLeg) => string }

/** What's behind one number across the wallets: the number, each wallet's side of it, and every leg, saying which wallet it's in. */
export type CombinedExplanationResponse = Omit<ExplanationResponse, "legs"> & { parts: ExplanationPart[]; legs: (ExplanationLeg & { wallet: string })[] }

/** A holding's number across the wallets, the same way a wallet's own explanation shows it. */
function assetValue({ asset, decimals, price, values, returnBps: bps, reconciliation }: CombinedPosition, metric: Metric, currency: CurrencyCode): string | null {
  const unconfirmed = reconciliation !== null && reconciliation.status !== "reconciled"
  if (unconfirmed && (metric === "average" || metric === "return" || metric === "realized" || metric === "unrealized")) return null
  switch (metric) {
    case "amount":
      return `${formatAmount(values.qty, decimals)} ${asset}`
    case "average":
      return values.averageCostMicros && formatPrice(values.averageCostMicros, currency)
    case "price":
      return price && formatPrice(price.micros, currency)
    case "value":
      return values.valueMicros && formatMoney(values.valueMicros, currency)
    case "return":
      return bps && formatReturn(bps)
    case "realized":
      return values.realizedMicros && formatSignedMoney(values.realizedMicros, currency)
    case "unrealized":
      return values.unrealizedMicros && formatSignedMoney(values.unrealizedMicros, currency)
    case "onchain":
      return reconciliation?.status === "reconciled" ? `✓ ${CHECK_LABELS.reconciled}` : reconciliation?.status === "incomplete" ? `⚠ ${CHECK_LABELS.incomplete}` : CHECK_LABELS.unchecked
  }
}

/** The same explanation a wallet gives for a click on this number, across all of them, newest leg first. null when none of them has it. */
export function explainAcross(read: readonly WalletResponse[], method: Method, target: ExplainTarget, book: Book, unread: Unread = { reading: [], failed: [] }): CombinedExplanation | null {
  const linking = linkingAll(book, [...read.map((wallet) => wallet.address), ...unread.reading, ...unread.failed])
  const combined = combine(read, method, linking, unread)
  const { folded, started, positions, walletPositions, totals, points, holdPositions, holdComparison, walletOf } = combined
  const first = folded[0] as Folded
  const context = bookContext(first.wallet, first.others, method, linking, first.fold.view)
  const { currency } = first.fold.view
  const newestFirst = (effects: readonly LegEffect[]) => [...effects].sort((a, b) => b.leg.blockNum - a.leg.blockNum || b.leg.txIndex - a.leg.txIndex)
  const whose = (leg: PricedLeg) => walletOf.get(leg) ?? ""
  const usdLess = { ...context, source: null }

  if (target.kind === "hold") {
    const { title, value, lines, effects } = explainHold(holdPositions, holdComparison, usdLess, { combined: true })
    return { currency, title, value, sourceValue: null, lines, parts: [], effects: newestFirst(effects), walletOf: whose }
  }

  // Each wallet's own explanation, for the wallets that have this number.
  const parts: { wallet: string; explanation: NonNullable<ReturnType<typeof explainTarget>> }[] = []
  for (const { address, wallet, others, fold } of started) {
    const explanation = explainTarget(target, fold, bookContext(wallet, others, method, linking, fold.view))
    if (explanation && (target.kind !== "total" || explanation.effects.length > 0)) parts.push({ wallet: address, explanation })
  }
  const effects = newestFirst(parts.flatMap(({ explanation }) => explanation.effects))
  const partsOut = parts.map(({ wallet, explanation }) => ({ wallet, value: explanation.value, lines: explanation.lines }))

  if (target.kind === "total") {
    const whole = explainTotal(walletPositions, totals as Totals, target.metric, usdLess)
    return { currency, title: whole.title, value: whole.value, sourceValue: null, lines: target.metric === "pnl" ? whole.lines.slice(0, 1) : [], parts: partsOut, effects, walletOf: whose }
  }
  if (target.kind === "asset") {
    const position = positions.find((p) => p.asset === target.asset)
    if (!position || parts.length === 0) return null
    const { title } = (parts[0] as (typeof parts)[number]).explanation
    const lines = parts.length > 1 ? [`Across ${parts.length} of your wallets.`] : []
    return { currency, title, value: assetValue(position, target.metric, currency), sourceValue: null, lines, parts: partsOut, effects, walletOf: whose }
  }
  const point = points.find((p) => p.txHash === target.txHash)
  if (!point) return null
  const whole = explainPoint(walletPositions, point, usdLess)
  const lines = [`Total PnL across your wallets after this transaction.${point.excludedCount > 0 ? ` Leaves out ${point.excludedCount} unknown ${point.excludedCount === 1 ? "amount" : "amounts"}.` : ""}`]
  return { currency, title: whole.title, value: whole.value, sourceValue: null, lines, parts: partsOut, effects, walletOf: whose }
}

/** The same, as the server sends it to clients that can't run the fold. */
export function explainCombined(read: readonly WalletResponse[], method: Method, target: ExplainTarget, book: Book, unread: Unread = { reading: [], failed: [] }): CombinedExplanationResponse | null {
  const explanation = explainAcross(read, method, target, book, unread)
  if (!explanation) return null
  const { effects, walletOf, ...rest } = explanation
  return { ...rest, legCount: effects.length, legs: effects.slice(0, MAX_LEGS).map((effect) => ({ ...legOf(effect, rest.currency), wallet: walletOf(effect.leg) })) }
}

/** What each set of answers would make the combined headline say. */
export function previewCombined(read: readonly WalletResponse[], method: Method, candidates: readonly Book[], unread: Unread = { reading: [], failed: [] }): BookPreview[] {
  return candidates.map((candidate) => {
    const { totals, pnlStatus, questions } = combinedPortfolioOf(read, method, candidate, unread)
    return { pnlMicros: totals.pnlMicros, pnlStatus, estimatedMicros: totals.estimatedMicros, unresolvedMicros: totals.unresolvedMicros, open: questions.length, pending: unread.reading.length > 0, failed: unread.failed.length > 0 }
  })
}

/** Every movement in every wallet, saying which wallet it's in. A move between them is in both, as it is onchain. */
export function exportCombined(read: readonly WalletResponse[], method: Method, book: Book): string {
  const linking = linkingAll(book, read.map((wallet) => wallet.address))
  const { walletPositions, walletOf, folded } = combine(read, method, linking, { reading: [], failed: [] })
  return exportCsv(walletPositions, (folded[0] as Folded).fold.view.currency, (leg) => walletOf.get(leg) ?? "")
}
