p='src/core/fold.ts'; s=open(p).read()
s=s.replace('''label: lot.costUsdMicros === null || lot.label === "mixed" ? (lot.costUsdMicros === null ? "unknown" : "inherited") : lot.label,''','''label: lot.costUsdMicros === null ? "unknown" : lot.label === "mixed" ? "inherited" : lot.label,''')
open(p,'w').write(s)

p='src/core/api.ts'; s=open(p).read()
s=s.replace('''import type { LatestPrice, LatestPrices, PnlPoint, Totals } from "./portfolio.ts"
import type { BalanceSnapshot, Reconciliation } from "./reconcile.ts"
''','''import type { CostNote } from "./notes.ts"
import type { Estimates, LatestPrice, LatestPrices, PnlPoint, PnlStatus, Totals } from "./portfolio.ts"
import type { BalanceSnapshot, Reconciliation } from "./reconcile.ts"
import type { Meter, Question } from "./resolve.ts"
''')
s=s.replace('''  /** Assets with no balance read at `coverage.toBlock`, which isn't the same as holding none. Empty until reads start. */
  unreadBalances: string[]
}''','''  /** Assets with no balance read at `coverage.toBlock`, which isn't the same as holding none. Empty until reads start. */
  unreadBalances: string[]
  /** Costs this wallet published itself, from its own zero-value transactions to itself. */
  notes: CostNote[]
  /** Whether market prices were read successfully, so a token without one really has no market. */
  marketChecked: boolean
  /** Tokens off the allowlist that moved here, which have no position or price. */
  unlistedTokens: string[]
}''')
s=s.replace('''  legCount: number
  reconciliation: Reconciliation | null
}

/**
 * Whether `totals.pnlUsdMicros` can be read as the wallet's PnL.
 * partial: it leaves something out, and `totals.excluded` says what. unavailable: it's null, because nothing in it is known.
 */
export type PnlStatus = "complete" | "partial" | "unavailable"
''','''  legCount: number
  reconciliation: Reconciliation | null
  /** No price, in any form, at any block. Often spam. It's listed apart, and can't affect PnL. */
  noMarket: boolean
  estimates: Estimates
  /** Its cost is unknown, and answering a question could change that. */
  resolvable: boolean
}
''')
s=s.replace('''  pnlStatus: PnlStatus
  points: PnlPoint[]
}
''','''  pnlStatus: PnlStatus
  points: PnlPoint[]
  /** What's left to ask, most useful first. */
  questions: Question[]
  meter: Meter
  /** Linked wallets that aren't read yet, so what came from them shows as unresolved for now. */
  linkedReading: string[]
  unlistedTokens: number
  marketChecked: boolean
}

/** What the headline would say with a different set of answers, before any of them is final. */
export type BookPreview = {
  pnlUsdMicros: string | null
  pnlStatus: PnlStatus
  estimatedUsdMicros: string
  unresolvedUsdMicros: string
  open: number
  /** A wallet these answers link hasn't been read yet, so this can't say yet. */
  pending: boolean
}
''')
s=s.replace('''  costLabel: PricedLeg["costLabel"]
  blockNum: number''','''  costLabel: PricedLeg["costLabel"]
  /** Its cost or proceeds rest on an estimate. */
  estimated: boolean
  /** Some of what arrived has a known cost and some doesn't. */
  partlyUnknown: boolean
  blockNum: number''')
open(p,'w').write(s)

p='src/core/reconcile.ts'; s=open(p).read()
s=s.replace('''  /** Assets missing from `balances`. Without a read, we can't say they're zero. */
  unreadBalances?: readonly string[]
}''','''  /** Assets missing from `balances`. Without a read, we can't say they're zero. */
  unreadBalances?: readonly string[]
  /** Market prices were read, so a token without one really has no market. */
  marketChecked?: boolean
}''')
open(p,'w').write(s)

p='src/core/portfolio.ts'; s=open(p).read()
s=s.replace('''import { applyLeg, emptyPosition, usdOf, valuePosition, type Method, type PositionState, type PositionValues } from "./fold.ts"
import { answerToMicros, type PricedLeg, type ReferenceRow } from "./legs.ts"
import { decimalsOf, estimateHeld, reconcile, type Onchain, type Reconciliation } from "./reconcile.ts"
''','''import type { BookPreview, WalletResponse } from "./api.ts"
import { linkedWallets, type Book } from "./book.ts"
import { applyLeg, emptyPosition, usdOf, valuePosition, type Method, type PositionState, type PositionValues } from "./fold.ts"
import { answerToMicros, type PricedLeg, type ReferenceRow } from "./legs.ts"
import { decimalsOf, estimateHeld, reconcile, type Onchain, type Reconciliation } from "./reconcile.ts"
import { meterOf, questionsOf, resolveLegs, type Meter, type Question } from "./resolve.ts"
import { TOKENS, normalizeAddress } from "./tokens.ts"
''')
s=s.replace('''export type Position = {
  asset: string''','''/** Which of a position's numbers rest on an estimate, so they can look different from exact ones. */
export type Estimates = { cost: boolean; value: boolean; realized: boolean; unrealized: boolean }

export type Position = {
  asset: string''')
s=s.replace('''  /** Null when there's nothing to compare against, as in a fold without onchain balances. */
  reconciliation: Reconciliation | null
}
''','''  /** Null when there's nothing to compare against, as in a fold without onchain balances. */
  reconciliation: Reconciliation | null
  /** No price, in any form, at any block. Often spam. It's listed apart, and can't affect PnL. */
  noMarket: boolean
  estimates: Estimates
}
''')
s=s.replace('''  /** Some gas had no price at its block, so it's not in `gasUsdMicros`. */
  unpricedGas: boolean
  coverage: Record<"value" | "realized" | "unrealized" | "pnl", Coverage>
}
''','''  /** Some gas had no price at its block, so it's not in `gasUsdMicros`. */
  unpricedGas: boolean
  coverage: Record<"value" | "realized" | "unrealized" | "pnl", Coverage>
  /** What's held with an unknown cost, at today's price. It's not in any PnL. */
  unresolvedUsdMicros: string
  /** How much of what these sums are made of is an estimate. */
  estimatedUsdMicros: string
  /** Which sums rest on one. */
  estimated: Pick<Estimates, "value" | "realized" | "unrealized">
  /** Assets with no market, which aren't in any of this. */
  noMarket: string[]
}

/**
 * Whether `totals.pnlUsdMicros` can be read as the wallet's PnL.
 * partial: it leaves something out, and `totals.excluded` says what. unavailable: it's null, because nothing in it is known.
 */
export type PnlStatus = "complete" | "partial" | "unavailable"

export function pnlStatusOf(totals: Totals, gasUnknownTxs: readonly string[]): PnlStatus {
  if (totals.pnlUsdMicros === null) return "unavailable"
  return totals.excluded.length === 0 && !totals.unpricedGas && gasUnknownTxs.length === 0 ? "complete" : "partial"
}
''')
s=s.replace('''    const reconciliation = onchain ? reconcile(asset, effects.map((e) => e.leg), BigInt(state.shortfallQty), onchain) : null
    return {
      asset,
      decimals,
      state,
      effects,
      price,
      reconciliation,
      values:''','''    const reconciliation = onchain ? reconcile(asset, effects.map((e) => e.leg), BigInt(state.shortfallQty), onchain) : null
    const confirmed = reconciliation === null || reconciliation.status === "reconciled"
    const cost = confirmed && BigInt(values.estimatedCostUsdMicros) > 0n
    const value = price?.source === "market"
    const hasPrice = price !== null || effects.some(({ leg }) => leg.priceUsdMicros !== null || leg.costUsdMicros !== null || leg.proceedsUsdMicros !== null || leg.pieces !== undefined)
    return {
      asset,
      decimals,
      state,
      effects,
      price,
      reconciliation,
      noMarket: onchain?.marketChecked === true && !hasPrice && !TOKENS.some((t) => t.symbol === asset && t.oracle),
      estimates: { cost, value, realized: confirmed && BigInt(values.estimatedRealizedUsdMicros) > 0n, unrealized: confirmed && (cost || value) },
      values:''')
s=s.replace('''  const excluded: Exclusion[] = []
  const coverage = {''','''  let unresolved = 0n
  let estimatedTotal = 0n
  const estimated = { value: false, realized: false, unrealized: false }
  const noMarket: string[] = []
  const excluded: Exclusion[] = []
  const coverage = {''')
s=s.replace('''    const { asset, values, state, reconciliation } = position
    gas += BigInt(state.gasUsdMicros)''','''    const { asset, values, state, reconciliation, estimates, price, decimals } = position
    if (position.noMarket) {
      noMarket.push(asset)
      continue
    }
    if (price !== null) unresolved += usdOf(BigInt(values.unknownCostQty), BigInt(price.usdMicros), decimals)
    const marketValue = estimates.value && values.valueUsdMicros !== null ? BigInt(values.valueUsdMicros) : 0n
    const heldEstimate = estimates.cost && BigInt(values.estimatedCostUsdMicros) > marketValue ? BigInt(values.estimatedCostUsdMicros) : marketValue
    if (estimates.value && values.valueUsdMicros !== null && BigInt(values.qty) > 0n) estimated.value = true
    if (estimates.realized) estimated.realized = true
    if (estimates.unrealized && values.unrealizedUsdMicros !== null) estimated.unrealized = true
    // Only what's in the PnL counts as resting on an estimate. A position that's left out adds nothing to it.
    if (estimates.unrealized && values.unrealizedUsdMicros !== null) estimatedTotal += heldEstimate
    if (estimates.realized && values.realizedUsdMicros !== null) estimatedTotal += BigInt(values.estimatedRealizedUsdMicros)
    gas += BigInt(state.gasUsdMicros)''')
s=s.replace('''    unpricedGas,
    coverage,
  }
}
''','''    unpricedGas,
    coverage,
    unresolvedUsdMicros: unresolved.toString(),
    estimatedUsdMicros: estimatedTotal.toString(),
    estimated,
    noMarket,
  }
}
''')
s=s.replace('''  /** Assets the chain hasn't confirmed. We can't tell when that started, so their PnL is left out of every point. */
  unconfirmed: ReadonlySet<string> = new Set(),
): PnlPoint[] {''','''  /** Assets the chain hasn't confirmed. We can't tell when that started, so their PnL is left out of every point. */
  unconfirmed: ReadonlySet<string> = new Set(),
  /** Assets with no market, which can't affect PnL. */
  noMarket: ReadonlySet<string> = new Set(),
): PnlPoint[] {''')
s=s.replace('''    for (const [asset, state] of states) {
      const v = valuePosition(state, priceOf(asset))''','''    for (const [asset, state] of states) {
      if (noMarket.has(asset)) continue
      const v = valuePosition(state, priceOf(asset))''')
s=s.rstrip()+'''

export type BookFold = {
  legs: PricedLeg[]
  positions: Position[]
  unread: string[]
  totals: Totals
  pnlStatus: PnlStatus
  points: PnlPoint[]
  questions: Question[]
  meter: Meter
}

/** Everything a wallet's numbers come from: the chain, plus what the user has said. Both the browser and the server run this. */
export function foldBook(focus: WalletResponse, others: readonly WalletResponse[], method: Method, book: Book): BookFold {
  const address = normalizeAddress(focus.address)
  const linked = new Set(linkedWallets(book))
  const wallets = [focus, ...others.filter((w) => normalizeAddress(w.address) !== address && linked.has(normalizeAddress(w.address)))]
  const { legs: resolved, open } = resolveLegs(wallets, method, book)
  const legs = resolved.get(address) as PricedLeg[]
  const positions = foldPositions(legs, method, focus.prices, focus)
  const unread = unreadAssets(positions, focus)
  const totals = sumTotals(positions, unread)
  const questions = questionsOf(open, wallets, book)
  return {
    legs,
    positions,
    unread,
    totals,
    pnlStatus: pnlStatusOf(totals, focus.gasUnknownTxs),
    points: pnlOverTime(legs, method, focus.prices, focus.references, focus.latest, unconfirmedAssets(positions, unread), new Set(totals.noMarket)),
    questions,
    meter: meterOf(questions, book, address),
  }
}

/** The linked wallets a book needs that aren't in `read`. */
export const missingWallets = (book: Book, focus: string, read: readonly WalletResponse[]) => {
  const have = new Set([normalizeAddress(focus), ...read.map((w) => normalizeAddress(w.address))])
  return linkedWallets(book).filter((address) => !have.has(address))
}

export function previewBook(focus: WalletResponse, others: readonly WalletResponse[], method: Method, book: Book): BookPreview {
  const { totals, pnlStatus, questions } = foldBook(focus, others, method, book)
  return { pnlUsdMicros: totals.pnlUsdMicros, pnlStatus, estimatedUsdMicros: totals.estimatedUsdMicros, unresolvedUsdMicros: totals.unresolvedUsdMicros, open: questions.length, pending: missingWallets(book, focus.address, others).length > 0 }
}
'''
open(p,'w').write(s)

p='src/core/explain.ts'; s=open(p).read()
s=s.replace('''  if (BigInt(leg.delta) > 0n) {
    if (leg.costLabel === "unknown") parts.push(`Adds ${amount} at an unknown cost`)
    else parts.push(`Adds ${amount} for ${formatUsd(leg.costUsdMicros as string)}`)
    return parts.join(". ")
  }''','''  if (BigInt(leg.delta) > 0n) {
    if (leg.pieces?.some((p) => p.costUsdMicros !== null) && leg.costUsdMicros === null) {
      const known = leg.pieces.filter((p) => p.costUsdMicros !== null)
      const unknown = leg.pieces.filter((p) => p.costUsdMicros === null).reduce((sum, p) => sum + BigInt(p.qty), 0n)
      parts.push(`Adds ${amount}: ${formatUsd(known.reduce((sum, p) => sum + BigInt(p.costUsdMicros as string), 0n))} of it from ${COST_WORDS[leg.costLabel]}, and ${formatAmount(unknown, leg.decimals)} ${leg.asset} at an unknown cost`)
    } else if (leg.costLabel === "unknown") parts.push(`Adds ${amount} at an unknown cost`)
    else parts.push(`Adds ${amount} for ${leg.estimated ? "about " : ""}${formatUsd(leg.costUsdMicros as string)}, ${COST_WORDS[leg.costLabel]}`)
    return parts.join(". ")
  }''')
s=s.replace('''function diff(after: string, before: string): bigint {''','''/** A cost's source, in words. */
const COST_WORDS: Record<CostLabel, string> = {
  paid: "what was paid",
  inherited: "what your other wallet paid",
  "received at market": "the price when it arrived",
  "self-reported": "what you reported",
  unknown: "an unknown cost",
}

/** Where a price came from, in words. */
export const PRICE_WORDS: Record<PriceSource, string> = {
  oracle: "a price feed",
  swap: "a swap in this transaction",
  market: "recent trades",
}

function diff(after: string, before: string): bigint {''')
s=s.replace('''import type { PricedLeg } from "./legs.ts"
''','''import type { CostLabel } from "./fold.ts"
import type { PricedLeg, PriceSource } from "./legs.ts"
''')
s=s.replace('''`Current price: ${formatPrice(price.usdMicros)}, from the ${price.source} at block ${price.blockNum.toLocaleString("en-US")}.`''','''`Current price: ${formatPrice(price.usdMicros)}, from ${PRICE_WORDS[price.source]} at block ${price.blockNum.toLocaleString("en-US")}.${price.source === "market" ? " That makes it an estimate." : ""}`''')
s=s.replace('''      : `There's no current price for ${asset}. Only ETH and USDC have an oracle so far.`''','''      : `There's no current price for ${asset}, because it hasn't traded enough recently for a price to be trusted.`''')
s=s.replace('''  const lines: string[] = []
  let value: string | null = null

  const incomplete =''','''  const lines: string[] = []
  let value: string | null = null
  const costSources = costSourceLine(position)

  const incomplete =''')
s=s.replace('''      else if (values.costUsdMicros) lines.push(`${formatUsd(values.costUsdMicros)} of cost ÷ ${qty}, by ${state.method === "fifo" ? "FIFO" : "average cost"}.`)
      break''','''      else if (values.costUsdMicros) lines.push(`${formatUsd(values.costUsdMicros)} of cost ÷ ${qty}, by ${state.method === "fifo" ? "oldest first" : "average cost"}.`)
      if (costSources) lines.push(costSources)
      break''')
s=s.replace('''      else if (values.costUsdMicros && values.valueUsdMicros) lines.push(`${formatUsd(values.valueUsdMicros)} value − ${formatUsd(values.costUsdMicros)} cost.`)
      break''','''      else if (values.costUsdMicros && values.valueUsdMicros) lines.push(`${formatUsd(values.valueUsdMicros)} value − ${formatUsd(values.costUsdMicros)} cost.`)
      if (costSources) lines.push(costSources)
      break''')
s=s.replace('''export function explainMetric(position: Position, metric: Metric): Explanation {''','''/** What a position's cost is made of, in words, or null when it has none. */
function costSourceLine({ state, asset, decimals }: Position): string | null {
  const known = new Map<string, bigint>()
  let unknown = 0n
  for (const lot of state.lots) {
    if (lot.costUsdMicros === null) unknown += BigInt(lot.qty)
    else if (lot.label !== "mixed") known.set(lot.label, (known.get(lot.label) ?? 0n) + BigInt(lot.costUsdMicros))
    else known.set("mixed", (known.get("mixed") ?? 0n) + BigInt(lot.costUsdMicros))
  }
  const estimated = state.lots.reduce((sum, lot) => sum + BigInt(lot.estimatedCostUsdMicros ?? "0"), 0n)
  const parts = [...known].map(([label, usd]) => `${formatUsd(usd)} from ${label === "mixed" ? "several sources" : COST_WORDS[label as CostLabel]}`)
  if (unknown > 0n) parts.push(`${formatAmount(unknown, decimals)} ${asset} unknown`)
  if (parts.length === 0) return null
  return `Cost: ${parts.join(", ")}.${estimated > 0n ? ` ${formatUsd(estimated)} of that is an estimate.` : ""}`
}

export function explainMetric(position: Position, metric: Metric): Explanation {''')
open(p,'w').write(s)
