// Runs the fold over a wallet's priced legs, and adds up what can honestly be added up.

import { applyLeg, emptyPosition, valuePosition, type Method, type PositionState, type PositionValues } from "./fold.ts"
import { answerToMicros, type PricedLeg, type ReferenceRow } from "./legs.ts"

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

export type Exclusion = { asset: string; reason: "unknown cost" | "no current price" | "sold at an unknown cost" }

export type Totals = {
  /** Sums only what's known. `excluded` says what isn't in it. */
  valueUsdMicros: string
  realizedUsdMicros: string
  unrealizedUsdMicros: string
  gasUsdMicros: string
  pnlUsdMicros: string
  excluded: Exclusion[]
  /** Some gas had no price at its block, so it's not in `gasUsdMicros`. */
  unpricedGas: boolean
  /** How many positions each sum leaves out, and how many it has, so a bare $0.00 can't pass for an answer. */
  coverage: Record<"value" | "realized" | "unrealized", { known: number; missing: number }>
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

export function sumTotals(positions: readonly Position[]): Totals {
  let value = 0n
  let realized = 0n
  let unrealized = 0n
  let gas = 0n
  let unpricedGas = false
  const excluded: Exclusion[] = []
  const coverage = { value: { known: 0, missing: 0 }, realized: { known: 0, missing: 0 }, unrealized: { known: 0, missing: 0 } }
  for (const { asset, values, state } of positions) {
    gas += BigInt(state.gasUsdMicros)
    if (BigInt(state.unpricedGasQty) > 0n) unpricedGas = true
    const held = BigInt(values.qty) > 0n
    if (values.valueUsdMicros !== null) {
      value += BigInt(values.valueUsdMicros)
      if (held) coverage.value.known++
    } else if (held) {
      coverage.value.missing++
      excluded.push({ asset, reason: "no current price" })
    }
    if (values.realizedUsdMicros !== null) {
      realized += BigInt(values.realizedUsdMicros)
      coverage.realized.known++
    } else {
      coverage.realized.missing++
      excluded.push({ asset, reason: "sold at an unknown cost" })
    }
    if (values.unrealizedUsdMicros !== null) {
      unrealized += BigInt(values.unrealizedUsdMicros)
      if (held) coverage.unrealized.known++
    } else if (held) {
      coverage.unrealized.missing++
      if (BigInt(values.unknownCostQty) > 0n) excluded.push({ asset, reason: "unknown cost" })
    }
  }
  return {
    valueUsdMicros: value.toString(),
    realizedUsdMicros: realized.toString(),
    unrealizedUsdMicros: unrealized.toString(),
    gasUsdMicros: gas.toString(),
    pnlUsdMicros: (realized + unrealized - gas).toString(),
    excluded,
    unpricedGas,
    coverage,
  }
}

export type PnlPoint = {
  blockNum: number
  timestamp: string
  txHash: string | null
  /** Realized, plus unrealized at that moment's prices, less gas. Only what's known. */
  pnlUsdMicros: string
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
    let pnl = 0n
    let excludedCount = 0
    for (const [asset, state] of states) {
      const v = valuePosition(state, priceOf(asset))
      pnl -= BigInt(state.gasUsdMicros)
      if (v.realizedUsdMicros === null) excludedCount++
      else pnl += BigInt(v.realizedUsdMicros)
      if (v.unrealizedUsdMicros !== null) pnl += BigInt(v.unrealizedUsdMicros)
      else if (BigInt(v.qty) > 0n) excludedCount++
    }
    return { pnlUsdMicros: pnl.toString(), excludedCount }
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
