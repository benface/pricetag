// Runs the fold over a wallet's priced legs, and adds up what can honestly be added up.

import { applyLeg, emptyPosition, valuePosition, type Method, type PositionState, type PositionValues } from "./fold.ts"
import { answerToMicros, type PricedLeg, type ReferenceRow } from "./legs.ts"

export type Head = { blockNum: number; timestamp: string }

export type LatestPrice = { usdMicros: string; source: "oracle" | "swap" | "market"; blockNum: number }
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
  valueUsdMicros: string | null
  realizedUsdMicros: string | null
  unrealizedUsdMicros: string | null
  gasUsdMicros: string | null
  pnlUsdMicros: string | null
  excluded: Exclusion[]
  /** Some gas had no price at its block, so it's not in `gasUsdMicros`. */
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
    return { asset, decimals, state, effects, price, values: valuePosition(state, price?.usdMicros ?? null) }
  })
}

/** Without a recent read, the price is gone rather than old: an old one would quietly mark the position wrong. */
export function latestPrices(reference: ReferenceRow | null): LatestPrices {
  const prices: LatestPrices = {}
  const eth = answerToMicros(reference?.eth_usd)
  const usdc = answerToMicros(reference?.usdc_usd)
  if (reference && eth) prices.ETH = { usdMicros: eth, source: "oracle", blockNum: reference.block_num }
  if (reference && usdc) prices.USDC = { usdMicros: usdc, source: "oracle", blockNum: reference.block_num }
  return prices
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
    gas += BigInt(state.gasUsdMicros)
    if (BigInt(state.gasUsdMicros) > 0n) coverage.pnl.known++
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
    if (values.valueUsdMicros !== null) {
      value += BigInt(values.valueUsdMicros)
      if (held) coverage.value.known++
    } else if (held) {
      coverage.value.missing++
      excluded.push({ asset, reason: "no current price" })
    }
    if (values.realizedUsdMicros !== null) {
      realized += BigInt(values.realizedUsdMicros)
    } else {
      coverage.realized.missing++
      excluded.push({ asset, reason: "sold at an unknown cost" })
    }
    // Only what the sum actually includes counts as known. A position with an unresolved sale is left out whole.
    if (values.realizedUsdMicros !== null && BigInt(state.resolvedDisposedQty) > 0n) coverage.realized.known++
    if (values.unrealizedUsdMicros !== null) {
      unrealized += BigInt(values.unrealizedUsdMicros)
      if (held) coverage.unrealized.known++
    } else if (held) {
      coverage.unrealized.missing++
      if (BigInt(values.unknownCostQty) > 0n) excluded.push({ asset, reason: "unknown cost" })
    }
  }
  coverage.pnl.known += coverage.realized.known + coverage.unrealized.known
  coverage.pnl.missing += coverage.realized.missing + coverage.unrealized.missing
  return {
    valueUsdMicros: answer(value, coverage.value),
    realizedUsdMicros: answer(realized, coverage.realized),
    unrealizedUsdMicros: answer(unrealized, coverage.unrealized),
    gasUsdMicros: gas === 0n && unpricedGas ? null : gas.toString(),
    pnlUsdMicros: answer(realized + unrealized - gas, coverage.pnl),
    excluded,
    unpricedGas,
    coverage,
  }
}

export type Portfolio = { method: Method; positions: Position[]; totals: Totals }

/** cost = fold(pricedLegs, method). Without `prices`, every position's value and unrealized PnL stay unknown. */
export function buildPortfolio(legs: readonly PricedLeg[], method: Method, prices: LatestPrices = {}): Portfolio {
  const positions = foldPositions(legs, method, prices)
  return { method, positions, totals: sumTotals(positions) }
}

/**
 * Whether `totals.pnlUsdMicros` can be read as the wallet's PnL.
 * partial: it leaves something out. unavailable: it's null, because nothing in it is known.
 */
export type PnlStatus = "complete" | "partial" | "unavailable"

/** `gasUnknownTxs` comes with a wallet's legs. The fold never sees that gas, so `totals` alone can't tell it's missing. */
export function pnlStatus(totals: Totals, gasUnknownTxs: readonly string[] = []): PnlStatus {
  if (totals.pnlUsdMicros === null) return "unavailable"
  return totals.excluded.length === 0 && !totals.unpricedGas && gasUnknownTxs.length === 0 ? "complete" : "partial"
}

export type PnlPoint = {
  blockNum: number
  timestamp: string
  txHash: string | null
  /** Realized, plus unrealized at that moment's prices, less gas. Only what's known, and null when nothing is. */
  pnlUsdMicros: string | null
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
  references: readonly ReferenceRow[],
  latest: { blockNum: number; timestamp: string } | null,
): PnlPoint[] {
  const refs = new Map(references.map((r) => [r.block_num, r]))
  const states = new Map<string, PositionState>()
  const points: PnlPoint[] = []
  const measure = (priceOf: (asset: string) => string | null) => {
    const coverage: Coverage = { known: 0, missing: 0 }
    let pnl = 0n
    let excludedCount = 0
    for (const [asset, state] of states) {
      const v = valuePosition(state, priceOf(asset))
      pnl -= BigInt(state.gasUsdMicros)
      if (BigInt(state.gasUsdMicros) > 0n) coverage.known++
      if (BigInt(state.unpricedGasQty) > 0n) coverage.missing++
      if (BigInt(state.shortfallQty) > 0n) coverage.missing++
      if (v.realizedUsdMicros === null) {
        excludedCount++
        coverage.missing++
      } else {
        pnl += BigInt(v.realizedUsdMicros)
        if (BigInt(state.resolvedDisposedQty) > 0n) coverage.known++
      }
      if (v.unrealizedUsdMicros !== null) {
        pnl += BigInt(v.unrealizedUsdMicros)
        if (BigInt(v.qty) > 0n) coverage.known++
      } else if (BigInt(v.qty) > 0n) {
        excludedCount++
        coverage.missing++
      }
    }
    return { pnlUsdMicros: answer(pnl, coverage), excludedCount }
  }
  legs.forEach((leg, i) => {
    states.set(leg.asset, applyLeg(states.get(leg.asset) ?? emptyPosition(method, leg.decimals), leg))
    if (legs[i + 1]?.txHash === leg.txHash) return
    const ref = refs.get(leg.blockNum)
    const priceOf = (asset: string) => {
      if (asset === "ETH") return answerToMicros(ref?.eth_usd)
      if (asset === "USDC") return answerToMicros(ref?.usdc_usd)
      return null
    }
    points.push({ blockNum: leg.blockNum, timestamp: leg.timestamp, txHash: leg.txHash, ...measure(priceOf) })
  })
  if (latest && states.size > 0) {
    points.push({ blockNum: latest.blockNum, timestamp: latest.timestamp, txHash: null, ...measure((asset) => prices[asset]?.usdMicros ?? null) })
  }
  return points
}
