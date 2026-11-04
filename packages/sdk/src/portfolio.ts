// Runs the fold over a wallet's priced legs, and adds up what can honestly be added up.

import { applyLeg, emptyPosition, worth, valuePosition, type Method, type PositionState, type PositionValues } from "./fold.ts"
import { answerToMicros, type PricedLeg, type Reference } from "./legs.ts"
import { decimalsOf, estimateHeld, reconcile, type Onchain, type Reconciliation } from "./reconcile.ts"
import { TOKENS } from "./tokens.ts"

export type Head = { blockNum: number; timestamp: string }

export type LatestPrice = {
  micros: string
  source: "oracle" | "swap" | "market"
  blockNum: number
  /** What `micros` was before converting, when it isn't already in USD. */
  usdMicros?: string
}
export type LatestPrices = Record<string, LatestPrice | undefined>

export type LegEffect = {
  leg: PricedLeg
  before: PositionState
  after: PositionState
}

/** Which of a position's numbers rest on an estimate, so they can look different from exact ones. */
export type Estimates = { cost: boolean; value: boolean; realized: boolean; unrealized: boolean }

export type Position = {
  asset: string
  decimals: number
  state: PositionState
  values: PositionValues
  price: LatestPrice | null
  effects: LegEffect[]
  /** Null when there's nothing to compare against, as in a fold without onchain balances. */
  reconciliation: Reconciliation | null
  /** No price, in any form, at any block. Often spam. It's listed apart, and can't affect PnL. */
  noMarket: boolean
  estimates: Estimates
}

export type Exclusion = { asset: string; reason: "unknown cost" | "no current price" | "sold at an unknown cost" | "incomplete history" | "doesn't match its actual balance" | "not checked against its actual balance" | "balance couldn't be read" }

/** What a sum is made of. A sum with something missing and nothing known has no answer, which isn't the same as $0. */
export type Coverage = { known: number; missing: number }

export const hasAnswer = ({ known, missing }: Coverage) => known > 0 || missing === 0

export type Totals = {
  /** Each sums only what's known, and is null when nothing is. `excluded` says what isn't in it. */
  valueMicros: string | null
  realizedMicros: string | null
  unrealizedMicros: string | null
  gasMicros: string | null
  pnlMicros: string | null
  excluded: Exclusion[]
  /** Some gas had no price at its block, so it's not in `gasMicros`. */
  unpricedGas: boolean
  coverage: Record<"value" | "realized" | "unrealized" | "pnl", Coverage>
  /** What's held with an unknown cost, at today's price. It's not in any PnL. */
  unresolvedMicros: string
  /** How much of what these sums are made of is an estimate. */
  estimatedMicros: string
  /** Which sums rest on one. */
  estimated: Pick<Estimates, "value" | "realized" | "unrealized">
  /** Assets with no market, which aren't in any of this. */
  noMarket: string[]
}

/**
 * A position the chain hasn't confirmed. Anything about cost comes from legs that are incomplete, or may be, so it's
 * unavailable rather than wrong. PnL only ever shows for a position that matches: otherwise a failed read would bring
 * back a number we already knew was wrong. What it holds and what that's worth come from the chain whenever it's been read.
 */
function unconfirmedValues(values: PositionValues, qty: string, priceMicros: string | null, decimals: number): PositionValues {
  return {
    ...values,
    qty,
    unknownCostQty: qty,
    costMicros: null,
    averageCostMicros: null,
    valueMicros: priceMicros === null ? null : worth(BigInt(qty), BigInt(priceMicros), decimals).toString(),
    realizedMicros: null,
    unrealizedMicros: null,
  }
}

export const isUnconfirmed = ({ reconciliation }: Pick<Position, "reconciliation">) => reconciliation !== null && reconciliation.status !== "reconciled"

/**
 * Assets with no balance read and nothing else to go on, so they have no position. They might still hold something, so
 * they're missing from totals and the chart, rather than zero.
 */
export function unreadAssets(positions: readonly Position[], { unreadBalances }: Pick<Onchain, "unreadBalances">): string[] {
  const shown = new Set(positions.map((p) => p.asset))
  return (unreadBalances ?? []).filter((asset) => !shown.has(asset))
}

/** The assets `pnlOverTime` has to leave out. */
export const unconfirmedAssets = (positions: readonly Position[], unread: readonly string[] = []) => new Set([...positions.filter(isUnconfirmed).map((p) => p.asset), ...unread])

export function foldPositions(legs: readonly PricedLeg[], method: Method, prices: LatestPrices, onchain?: Onchain): Position[] {
  const positions = new Map<string, { state: PositionState; effects: LegEffect[]; decimals: number }>()
  for (const leg of legs) {
    const position = positions.get(leg.asset) ?? { state: emptyPosition(method, leg.decimals), effects: [], decimals: leg.decimals }
    const after = applyLeg(position.state, leg)
    position.effects.push({ leg, before: position.state, after })
    position.state = after
    positions.set(leg.asset, position)
  }
  // Whether something's held is a separate question from whether it can be checked. The chain says it's here, or said so
  // at its last read, and no leg explains it. A fresh wallet funded by an internal transfer looks like this.
  const discover = (asset: string, held: bigint) => {
    if (held > 0n && !positions.has(asset)) positions.set(asset, { state: emptyPosition(method, decimalsOf(asset)), effects: [], decimals: decimalsOf(asset) })
  }
  for (const [asset, amount] of Object.entries(onchain?.balances?.amounts ?? {})) discover(asset, BigInt(amount))
  for (const [asset, last] of Object.entries(onchain?.lastBalances ?? {})) discover(asset, BigInt(last.amount))
  return [...positions.entries()].map(([asset, { state, effects, decimals }]) => {
    const price = prices[asset] ?? null
    const values = valuePosition(state, price?.micros ?? null)
    const reconciliation = onchain ? reconcile(asset, effects.map((e) => e.leg), BigInt(state.shortfallQty), onchain) : null
    const confirmed = reconciliation === null || reconciliation.status === "reconciled"
    const cost = confirmed && BigInt(values.estimatedCostMicros) > 0n
    const value = price?.source === "market"
    const hasPrice =
      price !== null ||
      onchain?.prices?.[asset] !== undefined ||
      effects.some(({ leg }) => leg.priceMicros !== null || leg.costMicros !== null || leg.proceedsMicros !== null || leg.pieces?.some((piece) => piece.costMicros !== null) || leg.conversion?.priceUsdMicros != null || leg.conversion?.costUsdMicros != null || leg.conversion?.proceedsUsdMicros != null)
    return {
      asset,
      decimals,
      state,
      effects,
      price,
      reconciliation,
      noMarket: onchain?.marketChecked === true && !hasPrice && !TOKENS.some((t) => t.symbol === asset && t.oracle),
      estimates: { cost, value, realized: confirmed && BigInt(values.estimatedRealizedMicros) > 0n, unrealized: confirmed && (cost || value) },
      values:
        reconciliation === null || reconciliation.status === "reconciled"
          ? values
          : unconfirmedValues(values, reconciliation.status === "unchecked" ? (reconciliation.heldQty ?? values.qty) : reconciliation.actualQty, price?.micros ?? null, decimals),
    }
  })
}

/** Without a recent read, the price is gone rather than old: an old one would quietly mark the position wrong. */
export function latestPrices(reference: Reference | null): LatestPrices {
  const prices: LatestPrices = {}
  const eth = answerToMicros(reference?.ethUsd)
  const usdc = answerToMicros(reference?.usdcUsd)
  if (reference && eth) prices.ETH = { micros: eth, source: "oracle", blockNum: reference.blockNum }
  if (reference && usdc) prices.USDC = { micros: usdc, source: "oracle", blockNum: reference.blockNum }
  return prices
}

const answer = (sum: bigint, coverage: Coverage) => (hasAnswer(coverage) ? sum.toString() : null)

export function sumTotals(positions: readonly Position[], unread: readonly string[] = []): Totals {
  let value = 0n
  let realized = 0n
  let unrealized = 0n
  let gas = 0n
  let unpricedGas = false
  let unresolved = 0n
  let estimatedTotal = 0n
  const estimated = { value: false, realized: false, unrealized: false }
  const noMarket: string[] = []
  const excluded: Exclusion[] = []
  const coverage = { value: { known: 0, missing: 0 }, realized: { known: 0, missing: 0 }, unrealized: { known: 0, missing: 0 }, pnl: { known: 0, missing: 0 } }
  for (const position of positions) {
    const { asset, values, state, reconciliation, estimates, price, decimals } = position
    if (position.noMarket) {
      noMarket.push(asset)
      continue
    }
    if (price !== null) unresolved += worth(BigInt(values.unknownCostQty), BigInt(price.micros), decimals)
    const marketValue = estimates.value && values.valueMicros !== null ? BigInt(values.valueMicros) : 0n
    const heldEstimate = estimates.cost && BigInt(values.estimatedCostMicros) > marketValue ? BigInt(values.estimatedCostMicros) : marketValue
    if (estimates.value && values.valueMicros !== null && BigInt(values.qty) > 0n) estimated.value = true
    if (estimates.realized) estimated.realized = true
    if (estimates.unrealized && values.unrealizedMicros !== null) estimated.unrealized = true
    // Only what's in the PnL counts as resting on an estimate. A position that's left out adds nothing to it.
    if (estimates.unrealized && values.unrealizedMicros !== null) estimatedTotal += heldEstimate
    if (estimates.realized && values.realizedMicros !== null) estimatedTotal += BigInt(values.estimatedRealizedMicros)
    gas += BigInt(state.gasMicros)
    if (BigInt(state.gasMicros) > 0n) coverage.pnl.known++
    if (BigInt(state.unpricedGasQty) > 0n) {
      unpricedGas = true
      coverage.pnl.missing++
    }
    const held = BigInt(values.qty) > 0n
    if (isUnconfirmed(position)) {
      excluded.push({ asset, reason: reconciliation?.status === "incomplete" ? "doesn't match its actual balance" : "not checked against its actual balance" })
      coverage.realized.missing++
      coverage.unrealized.missing++
      // The chain didn't say what it holds right now, so its value is our best estimate, and that isn't a known value.
      if (reconciliation?.status === "unchecked" && !reconciliation.heldIsCurrent) {
        coverage.value.missing++
        if (BigInt(state.shortfallQty) > 0n) excluded.push({ asset, reason: "incomplete history" })
      }
      if (values.valueMicros !== null) {
        value += BigInt(values.valueMicros)
        if (held) coverage.value.known++
      } else if (held) {
        coverage.value.missing++
        excluded.push({ asset, reason: "no current price" })
      }
      continue
    }
    // More left than we saw arrive, so there are units we can't see. Whatever this position shows, it isn't all of it.
    if (BigInt(state.shortfallQty) > 0n) {
      coverage.value.missing++
      coverage.unrealized.missing++
      excluded.push({ asset, reason: "incomplete history" })
    }
    if (values.valueMicros !== null) {
      value += BigInt(values.valueMicros)
      if (held) coverage.value.known++
    } else if (held) {
      coverage.value.missing++
      excluded.push({ asset, reason: "no current price" })
    }
    if (values.realizedMicros !== null) {
      realized += BigInt(values.realizedMicros)
    } else {
      coverage.realized.missing++
      excluded.push({ asset, reason: "sold at an unknown cost" })
    }
    // Only what the sum actually includes counts as known. A position with an unresolved sale is left out whole.
    if (values.realizedMicros !== null && BigInt(state.resolvedDisposedQty) > 0n) coverage.realized.known++
    if (values.unrealizedMicros !== null) {
      unrealized += BigInt(values.unrealizedMicros)
      if (held) coverage.unrealized.known++
    } else if (held) {
      coverage.unrealized.missing++
      if (BigInt(values.unknownCostQty) > 0n) excluded.push({ asset, reason: "unknown cost" })
    }
  }
  for (const asset of unread) {
    excluded.push({ asset, reason: "balance couldn't be read" })
    coverage.value.missing++
    coverage.unrealized.missing++
  }
  coverage.pnl.known += coverage.realized.known + coverage.unrealized.known
  coverage.pnl.missing += coverage.realized.missing + coverage.unrealized.missing
  return {
    valueMicros: answer(value, coverage.value),
    realizedMicros: answer(realized, coverage.realized),
    unrealizedMicros: answer(unrealized, coverage.unrealized),
    gasMicros: gas === 0n && unpricedGas ? null : gas.toString(),
    pnlMicros: answer(realized + unrealized - gas, coverage.pnl),
    excluded,
    unpricedGas,
    coverage,
    unresolvedMicros: unresolved.toString(),
    estimatedMicros: estimatedTotal.toString(),
    estimated,
    noMarket,
  }
}

/** A token's price at a block, in the currency being folded, for marking what's held at that moment. */
export type MarkPrice = (blockNum: number, asset: string) => string | null

/** Each block's oracle prices, in USD, from the oracle reads that come with a wallet's legs. */
export function referenceMarks(references: readonly Reference[]): MarkPrice {
  const refs = new Map(references.map((r) => [r.blockNum, r]))
  return (blockNum, asset) => {
    const ref = refs.get(blockNum)
    if (asset === "ETH") return answerToMicros(ref?.ethUsd)
    if (asset === "USDC") return answerToMicros(ref?.usdcUsd)
    return null
  }
}
export type Portfolio = { method: Method; positions: Position[]; totals: Totals }

/** cost = fold(pricedLegs, method). Without `prices`, every position's value and unrealized PnL stay unknown. */
export function buildPortfolio(legs: readonly PricedLeg[], method: Method, prices: LatestPrices = {}): Portfolio {
  const positions = foldPositions(legs, method, prices)
  return { method, positions, totals: sumTotals(positions) }
}

/**
 * Whether `totals.pnlMicros` can be read as the wallet's PnL.
 * partial: it leaves something out. unavailable: it's null, because nothing in it is known.
 */
export type PnlStatus = "complete" | "partial" | "unavailable"

/** `gasUnknownTxs` comes with a wallet's legs. The fold never sees that gas, so `totals` alone can't tell it's missing. */
export function pnlStatus(totals: Totals, gasUnknownTxs: readonly string[] = []): PnlStatus {
  if (totals.pnlMicros === null) return "unavailable"
  return totals.excluded.length === 0 && !totals.unpricedGas && gasUnknownTxs.length === 0 ? "complete" : "partial"
}

export type PnlPoint = {
  blockNum: number
  timestamp: string
  txHash: string | null
  /** Realized, plus unrealized at that moment's prices, less gas. Only what's known, and null when nothing is. */
  pnlMicros: string | null
  excludedCount: number
}

/**
 * Total PnL after each transaction, plus a last point at `latest` and current prices, matching the headline.
 * Oracle tokens are marked to that block's oracle price. Others have no price between their own trades, so like
 * in the headline, they add no unrealized PnL and count in `excludedCount`. This way a trade can't make a spike.
 */
export function pnlOverTime(
  legs: readonly PricedLeg[],
  method: Method,
  prices: LatestPrices,
  markPrice: MarkPrice,
  latest: { blockNum: number; timestamp: string } | null,
  /** Assets the chain hasn't confirmed. We can't tell when that started, so their PnL is left out of every point. */
  unconfirmed: ReadonlySet<string> = new Set(),
  /** Assets with no market, which can't affect PnL. */
  noMarket: ReadonlySet<string> = new Set(),
): PnlPoint[] {
  const states = new Map<string, PositionState>()
  const points: PnlPoint[] = []
  const measure = (priceOf: (asset: string) => string | null) => {
    const coverage: Coverage = { known: 0, missing: 0 }
    let pnl = 0n
    let excludedCount = 0
    for (const [asset, state] of states) {
      if (noMarket.has(asset)) continue
      const v = valuePosition(state, priceOf(asset))
      pnl -= BigInt(state.gasMicros)
      if (BigInt(state.gasMicros) > 0n) coverage.known++
      if (BigInt(state.unpricedGasQty) > 0n) coverage.missing++
      if (unconfirmed.has(asset)) {
        excludedCount++
        coverage.missing++
        continue
      }
      if (BigInt(state.shortfallQty) > 0n) coverage.missing++
      if (v.realizedMicros === null) {
        excludedCount++
        coverage.missing++
      } else {
        pnl += BigInt(v.realizedMicros)
        if (BigInt(state.resolvedDisposedQty) > 0n) coverage.known++
      }
      if (v.unrealizedMicros !== null) {
        pnl += BigInt(v.unrealizedMicros)
        if (BigInt(v.qty) > 0n) coverage.known++
      } else if (BigInt(v.qty) > 0n) {
        excludedCount++
        coverage.missing++
      }
    }
    // One that no leg touches yet, or ever, like a wallet funded only by an internal transfer, still counts.
    for (const asset of unconfirmed) {
      if (states.has(asset)) continue
      excludedCount++
      coverage.missing++
    }
    return { pnlMicros: answer(pnl, coverage), excludedCount }
  }
  legs.forEach((leg, i) => {
    states.set(leg.asset, applyLeg(states.get(leg.asset) ?? emptyPosition(method, leg.decimals), leg))
    if (leg.opening || legs[i + 1]?.txHash === leg.txHash) return
    points.push({ blockNum: leg.blockNum, timestamp: leg.timestamp, txHash: leg.txHash, ...measure((asset) => markPrice(leg.blockNum, asset)) })
  })
  if (latest && (states.size > 0 || unconfirmed.size > 0)) {
    points.push({ blockNum: latest.blockNum, timestamp: latest.timestamp, txHash: null, ...measure((asset) => prices[asset]?.micros ?? null) })
  }
  return points
}
