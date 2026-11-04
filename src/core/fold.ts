// The cost fold: cost = fold(pricedLegs, method), one state per account and token.
//
// This file has no imports, clock or randomness, so it can move unchanged into a stateful table.
// State and legs are plain JSON with amounts as decimal strings. All math runs in BigInt.
//
// Price and cost stay separate. A leg's price is a shared fact. Its cost is personal, and when it's
// unknown it stays unknown: it never becomes $0, and anything that depends on it becomes null.

export type Method = "average" | "fifo"
export type CostLabel = "paid" | "inherited" | "received at market" | "self-reported" | "unknown"

export type FoldLeg = {
  id: string
  /** Signed, in the token's smallest unit. */
  delta: string
  decimals: number
  /**
   * swap: a debit is a sale at `priceUsdMicros`.
   * transfer: a debit carries its cost away with no gain or loss.
   * gas: a debit is a sale at `priceUsdMicros`, and that value is then spent as a fee.
   */
  kind: "swap" | "transfer" | "gas"
  /** USD price of one whole token at this leg's block, or null when there's no usable price. */
  priceUsdMicros: string | null
  /** Credits only: what one whole token cost this wallet. Ignored when `costLabel` is "unknown". */
  unitCostUsdMicros: string | null
  costLabel: CostLabel
}

export type Lot = {
  qty: string
  /** Total cost of this lot, or null when it's unknown. */
  costUsdMicros: string | null
  label: CostLabel | "mixed"
  legId: string
}

export type PositionState = {
  method: Method
  decimals: number
  /** Known-cost and unknown-cost units held. Average cost keeps at most one lot of each. */
  lots: Lot[]
  /** From disposals whose cost and proceeds are both known. */
  realizedUsdMicros: string
  /** Units disposed of with an unknown cost or unknown proceeds. Realized PnL is unavailable while this is above 0. */
  unresolvedDisposedQty: string
  gasUsdMicros: string
  /** Units spent on gas with no price at that block, so their USD value isn't in `gasUsdMicros`. */
  unpricedGasQty: string
  /** Units that left beyond what we saw arrive, so this wallet's history is incomplete. */
  shortfallQty: string
  /** Cost carried away by outgoing transfers. It's not a loss, so it's not in any PnL. */
  transferredOutCostUsdMicros: string
}

export function emptyPosition(method: Method, decimals: number): PositionState {
  return {
    method,
    decimals,
    lots: [],
    realizedUsdMicros: "0",
    unresolvedDisposedQty: "0",
    gasUsdMicros: "0",
    unpricedGasQty: "0",
    shortfallQty: "0",
    transferredOutCostUsdMicros: "0",
  }
}

function usdOf(qty: bigint, unitUsdMicros: bigint, decimals: number): bigint {
  return (qty * unitUsdMicros) / 10n ** BigInt(decimals)
}

function credit(state: PositionState, leg: FoldLeg, qty: bigint): Lot[] {
  const known = leg.costLabel !== "unknown" && leg.unitCostUsdMicros !== null
  const lot: Lot = {
    qty: qty.toString(),
    costUsdMicros: known ? usdOf(qty, BigInt(leg.unitCostUsdMicros as string), leg.decimals).toString() : null,
    label: known ? leg.costLabel : "unknown",
    legId: leg.id,
  }
  if (state.method === "fifo") return [...state.lots, lot]

  const pool = state.lots.find((l) => (l.costUsdMicros === null) === !known)
  if (!pool) return [...state.lots, lot]
  const merged: Lot = {
    qty: (BigInt(pool.qty) + qty).toString(),
    costUsdMicros: known ? (BigInt(pool.costUsdMicros as string) + BigInt(lot.costUsdMicros as string)).toString() : null,
    label: pool.label === lot.label ? pool.label : "mixed",
    legId: pool.legId,
  }
  return state.lots.map((l) => (l === pool ? merged : l))
}

type Taken = { lots: Lot[]; knownQty: bigint; knownCost: bigint; unknownQty: bigint; shortfall: bigint }

function shrink(lot: Lot, qty: bigint): { rest: Lot | null; cost: bigint } {
  const lotQty = BigInt(lot.qty)
  const lotCost = lot.costUsdMicros === null ? null : BigInt(lot.costUsdMicros)
  // Taking a whole lot takes all of its cost, so rounding never leaves dust behind.
  if (qty === lotQty) return { rest: null, cost: lotCost ?? 0n }
  const cost = lotCost === null ? 0n : (lotCost * qty) / lotQty
  const rest: Lot = {
    ...lot,
    qty: (lotQty - qty).toString(),
    costUsdMicros: lotCost === null ? null : (lotCost - cost).toString(),
  }
  return { rest, cost }
}

/** FIFO takes the oldest lots first. Average takes from the known and unknown pools in proportion. */
function take(state: PositionState, qty: bigint): Taken {
  const held = state.lots.reduce((sum, l) => sum + BigInt(l.qty), 0n)
  const taking = qty < held ? qty : held
  const result: Taken = { lots: [], knownQty: 0n, knownCost: 0n, unknownQty: 0n, shortfall: qty - taking }

  let remaining = taking
  state.lots.forEach((lot, i) => {
    const lotQty = BigInt(lot.qty)
    let n: bigint
    if (state.method === "fifo") n = remaining < lotQty ? remaining : lotQty
    else n = i === state.lots.length - 1 ? remaining : (taking * lotQty) / held
    remaining -= n
    if (n === 0n) {
      result.lots.push(lot)
      return
    }
    const { rest, cost } = shrink(lot, n)
    if (rest) result.lots.push(rest)
    if (lot.costUsdMicros === null) result.unknownQty += n
    else {
      result.knownQty += n
      result.knownCost += cost
    }
  })
  return result
}

export function applyLeg(state: PositionState, leg: FoldLeg): PositionState {
  const delta = BigInt(leg.delta)
  if (delta === 0n) return state
  if (delta > 0n) return { ...state, lots: credit(state, leg, delta) }

  const qty = -delta
  const taken = take(state, qty)
  const next: PositionState = {
    ...state,
    lots: taken.lots,
    shortfallQty: (BigInt(state.shortfallQty) + taken.shortfall).toString(),
  }

  if (leg.kind === "transfer") {
    next.transferredOutCostUsdMicros = (BigInt(state.transferredOutCostUsdMicros) + taken.knownCost).toString()
    return next
  }

  const price = leg.priceUsdMicros === null ? null : BigInt(leg.priceUsdMicros)
  // What left with no cost we can see: its PnL can't be known, whatever the price was.
  let unresolved = taken.unknownQty + taken.shortfall
  if (price === null) unresolved += taken.knownQty
  else {
    const proceeds = usdOf(taken.knownQty, price, state.decimals)
    next.realizedUsdMicros = (BigInt(state.realizedUsdMicros) + proceeds - taken.knownCost).toString()
  }
  next.unresolvedDisposedQty = (BigInt(state.unresolvedDisposedQty) + unresolved).toString()

  if (leg.kind === "gas") {
    if (price === null) next.unpricedGasQty = (BigInt(state.unpricedGasQty) + qty).toString()
    else next.gasUsdMicros = (BigInt(state.gasUsdMicros) + usdOf(qty, price, state.decimals)).toString()
  }
  return next
}

export type PositionValues = {
  qty: string
  unknownCostQty: string
  /** null whenever part of the position has an unknown cost. */
  costUsdMicros: string | null
  /** Per whole token. null whenever part of the position has an unknown cost. */
  averageCostUsdMicros: string | null
  /** null when there's no current price. */
  valueUsdMicros: string | null
  /** null when something it depends on is unknown. Never 0 in that case. */
  realizedUsdMicros: string | null
  unrealizedUsdMicros: string | null
}

export function valuePosition(state: PositionState, priceUsdMicros: string | null): PositionValues {
  let qty = 0n
  let unknownCostQty = 0n
  let cost = 0n
  for (const lot of state.lots) {
    qty += BigInt(lot.qty)
    if (lot.costUsdMicros === null) unknownCostQty += BigInt(lot.qty)
    else cost += BigInt(lot.costUsdMicros)
  }
  const costKnown = unknownCostQty === 0n
  const value = priceUsdMicros === null ? null : usdOf(qty, BigInt(priceUsdMicros), state.decimals)
  return {
    qty: qty.toString(),
    unknownCostQty: unknownCostQty.toString(),
    costUsdMicros: costKnown ? cost.toString() : null,
    averageCostUsdMicros: costKnown && qty > 0n ? ((cost * 10n ** BigInt(state.decimals)) / qty).toString() : null,
    valueUsdMicros: value === null ? null : value.toString(),
    realizedUsdMicros: BigInt(state.unresolvedDisposedQty) === 0n ? state.realizedUsdMicros : null,
    unrealizedUsdMicros: costKnown && value !== null ? (value - cost).toString() : null,
  }
}
