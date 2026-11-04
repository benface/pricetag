// Runs the fold over a wallet's priced legs, and adds up what can honestly be added up.

import { applyLeg, emptyPosition, valuePosition, type Method, type PositionState, type PositionValues } from "./fold.ts"
import type { PricedLeg } from "./legs.ts"

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

export type Position = {
  asset: string
  decimals: number
  state: PositionState
  values: PositionValues
  price: LatestPrice | null
  effects: LegEffect[]
}

export type Exclusion = { asset: string; reason: "unknown cost" | "no current price" | "sold at an unknown cost" | "incomplete history" }

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
}

export function foldPositions(legs: readonly PricedLeg[], method: Method, prices: LatestPrices): Position[] {
  const positions = new Map<string, { state: PositionState; effects: LegEffect[]; decimals: number }>()
  for (const leg of legs) {
    const position = positions.get(leg.asset) ?? { state: emptyPosition(method, leg.decimals), effects: [], decimals: leg.decimals }
    const after = applyLeg(position.state, leg)
    position.effects.push({ leg, before: position.state, after })
    position.state = after
    positions.set(leg.asset, position)
  }
  return [...positions.entries()].map(([asset, { state, effects, decimals }]) => {
    const price = prices[asset] ?? null
    return { asset, decimals, state, effects, price, values: valuePosition(state, price?.micros ?? null) }
  })
}

const answer = (sum: bigint, coverage: Coverage) => (hasAnswer(coverage) ? sum.toString() : null)

export function sumTotals(positions: readonly Position[]): Totals {
  let value = 0n
  let realized = 0n
  let unrealized = 0n
  let gas = 0n
  let unpricedGas = false
  const excluded: Exclusion[] = []
  const coverage = { value: { known: 0, missing: 0 }, realized: { known: 0, missing: 0 }, unrealized: { known: 0, missing: 0 }, pnl: { known: 0, missing: 0 } }
  for (const { asset, values, state } of positions) {
    gas += BigInt(state.gasMicros)
    if (BigInt(state.gasMicros) > 0n) coverage.pnl.known++
    if (BigInt(state.unpricedGasQty) > 0n) {
      unpricedGas = true
      coverage.pnl.missing++
    }
    const held = BigInt(values.qty) > 0n
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
  }
}

/** A token's price at a block, in the currency being folded, for marking what's held at that moment. */
export type MarkPrice = (blockNum: number, asset: string) => string | null

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
): PnlPoint[] {
  const states = new Map<string, PositionState>()
  const points: PnlPoint[] = []
  const measure = (priceOf: (asset: string) => string | null) => {
    const coverage: Coverage = { known: 0, missing: 0 }
    let pnl = 0n
    let excludedCount = 0
    for (const [asset, state] of states) {
      const v = valuePosition(state, priceOf(asset))
      pnl -= BigInt(state.gasMicros)
      if (BigInt(state.gasMicros) > 0n) coverage.known++
      if (BigInt(state.unpricedGasQty) > 0n) coverage.missing++
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
    return { pnlMicros: answer(pnl, coverage), excludedCount }
  }
  legs.forEach((leg, i) => {
    states.set(leg.asset, applyLeg(states.get(leg.asset) ?? emptyPosition(method, leg.decimals), leg))
    if (legs[i + 1]?.txHash === leg.txHash) return
    points.push({ blockNum: leg.blockNum, timestamp: leg.timestamp, txHash: leg.txHash, ...measure((asset) => markPrice(leg.blockNum, asset)) })
  })
  if (latest && states.size > 0) {
    points.push({ blockNum: latest.blockNum, timestamp: latest.timestamp, txHash: null, ...measure((asset) => prices[asset]?.micros ?? null) })
  }
  return points
}
