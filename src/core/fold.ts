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
   * swap: a debit is a sale for `proceedsUsdMicros`.
   * transfer: a debit carries its cost away with no gain or loss.
   * gas: a debit is a sale at `priceUsdMicros`, and that value is then spent as a fee.
   */
  kind: "swap" | "transfer" | "gas"
  /** The shared fact: USD price of one whole token at this leg's block, or null when there's no usable price. */
  priceUsdMicros: string | null
  /** Credits only: what this wallet actually paid for the whole leg. Ignored when `costLabel` is "unknown". */
  costUsdMicros: string | null
  /** Swap debits only: what this wallet actually received for the whole leg, or null when that isn't known. */
  proceedsUsdMicros: string | null
  costLabel: CostLabel
  /** Credits only: what arrived, piece by piece, when it isn't one cost. Takes the place of `costUsdMicros` and `costLabel`. */
  pieces?: CostPiece[]
  /** Its cost or proceeds rest on an estimate, so whatever comes from them does too. */
  estimated?: boolean
  blockNum?: number
  timestamp?: string
}

/** Part of a credit, or what a debit took: how much, what it cost, and when it was first acquired. */
export type CostPiece = {
  qty: string
  costUsdMicros: string | null
  label: CostLabel
  /** The part of `costUsdMicros` that's an estimate. */
  estimatedCostUsdMicros: string
  acquiredBlock?: number
  acquiredAt?: string
}

export type Lot = {
  qty: string
  /** Total cost of this lot, or null when it's unknown. */
  costUsdMicros: string | null
  label: CostLabel | "mixed"
  legId: string
  /** The part of `costUsdMicros` that's an estimate. Missing means none. */
  estimatedCostUsdMicros?: string
  /** When these units were first acquired, which an inherited lot keeps from the wallet that sent it. */
  acquiredBlock?: number
  acquiredAt?: string
}

export type PositionState = {
  method: Method
  decimals: number
  /** Known-cost and unknown-cost units held. Average cost keeps at most one lot of each. */
  lots: Lot[]
  /** From disposals whose cost and proceeds are both known. */
  realizedUsdMicros: string
  /** Units `realizedUsdMicros` comes from, which tells a real $0 from nothing being known. */
  resolvedDisposedQty: string
  /** Units disposed of with an unknown cost or unknown proceeds. Realized PnL is unavailable while this is above 0. */
  unresolvedDisposedQty: string
  gasUsdMicros: string
  /** Units spent on gas with no price at that block, so their USD value isn't in `gasUsdMicros`. */
  unpricedGasQty: string
  /** Units that left beyond what we saw arrive, so this wallet's history is incomplete. */
  shortfallQty: string
  /** Cost carried away by outgoing transfers. It's not a loss, so it's not in any PnL. */
  transferredOutCostUsdMicros: string
  /** How much of what `realizedUsdMicros` comes from, in cost and proceeds, is an estimate. */
  estimatedRealizedUsdMicros: string
}

export function emptyPosition(method: Method, decimals: number): PositionState {
  return {
    method,
    decimals,
    lots: [],
    realizedUsdMicros: "0",
    resolvedDisposedQty: "0",
    unresolvedDisposedQty: "0",
    gasUsdMicros: "0",
    unpricedGasQty: "0",
    shortfallQty: "0",
    transferredOutCostUsdMicros: "0",
    estimatedRealizedUsdMicros: "0",
  }
}

export function usdOf(qty: bigint, unitUsdMicros: bigint, decimals: number): bigint {
  return (qty * unitUsdMicros) / 10n ** BigInt(decimals)
}

function lotOf(piece: CostPiece, legId: string): Lot {
  const known = piece.label !== "unknown" && piece.costUsdMicros !== null
  const estimated = known ? BigInt(piece.estimatedCostUsdMicros) : 0n
  return {
    qty: piece.qty,
    costUsdMicros: known ? piece.costUsdMicros : null,
    label: known ? piece.label : "unknown",
    legId,
    ...(estimated > 0n ? { estimatedCostUsdMicros: estimated.toString() } : {}),
    ...(piece.acquiredBlock === undefined ? {} : { acquiredBlock: piece.acquiredBlock, acquiredAt: piece.acquiredAt as string }),
  }
}

const estimatedOf = (lot: Lot) => BigInt(lot.estimatedCostUsdMicros ?? "0")

/** Oldest first by when it was acquired, so an inherited lot goes where its own date says, not where it arrived. */
function insertByDate(lots: readonly Lot[], lot: Lot): Lot[] {
  const at = lot.acquiredBlock === undefined ? -1 : lots.findIndex((l) => l.acquiredBlock !== undefined && l.acquiredBlock > (lot.acquiredBlock as number))
  return at < 0 ? [...lots, lot] : [...lots.slice(0, at), lot, ...lots.slice(at)]
}

function addLot(method: Method, lots: readonly Lot[], lot: Lot): Lot[] {
  if (method === "fifo") return insertByDate(lots, lot)
  const known = lot.costUsdMicros !== null
  const pool = lots.find((l) => (l.costUsdMicros === null) === !known)
  if (!pool) return [...lots, lot]
  const estimated = estimatedOf(pool) + estimatedOf(lot)
  const acquired = pool.acquiredBlock === undefined || (lot.acquiredBlock !== undefined && lot.acquiredBlock < pool.acquiredBlock) ? lot : pool
  const merged: Lot = {
    qty: (BigInt(pool.qty) + BigInt(lot.qty)).toString(),
    costUsdMicros: known ? (BigInt(pool.costUsdMicros as string) + BigInt(lot.costUsdMicros as string)).toString() : null,
    label: pool.label === lot.label ? pool.label : "mixed",
    legId: pool.legId,
    ...(estimated > 0n ? { estimatedCostUsdMicros: estimated.toString() } : {}),
    ...(acquired.acquiredBlock === undefined ? {} : { acquiredBlock: acquired.acquiredBlock, acquiredAt: acquired.acquiredAt as string }),
  }
  return lots.map((l) => (l === pool ? merged : l))
}

function credit(state: PositionState, leg: FoldLeg, qty: bigint): Lot[] {
  const dated = leg.blockNum === undefined ? {} : { acquiredBlock: leg.blockNum, acquiredAt: leg.timestamp as string }
  const estimated = leg.estimated && leg.costUsdMicros !== null ? leg.costUsdMicros : "0"
  const pieces = leg.pieces ?? [{ qty: qty.toString(), costUsdMicros: leg.costUsdMicros, label: leg.costLabel, estimatedCostUsdMicros: estimated, ...dated }]
  return pieces.reduce<Lot[]>((lots, piece) => addLot(state.method, lots, lotOf(piece, leg.id)), state.lots)
}

type Taken = { lots: Lot[]; pieces: CostPiece[]; knownQty: bigint; knownCost: bigint; estimatedCost: bigint; unknownQty: bigint; shortfall: bigint }

function shrink(lot: Lot, qty: bigint): { rest: Lot | null; cost: bigint; estimated: bigint } {
  const lotQty = BigInt(lot.qty)
  const lotCost = lot.costUsdMicros === null ? null : BigInt(lot.costUsdMicros)
  const lotEstimated = estimatedOf(lot)
  // Taking a whole lot takes all of its cost, so rounding never leaves dust behind.
  if (qty === lotQty) return { rest: null, cost: lotCost ?? 0n, estimated: lotEstimated }
  const cost = lotCost === null ? 0n : (lotCost * qty) / lotQty
  const estimated = (lotEstimated * qty) / lotQty
  const left = lotEstimated - estimated
  const { estimatedCostUsdMicros: _, ...plain } = lot
  const rest: Lot = {
    ...plain,
    qty: (lotQty - qty).toString(),
    costUsdMicros: lotCost === null ? null : (lotCost - cost).toString(),
    ...(left > 0n ? { estimatedCostUsdMicros: left.toString() } : {}),
  }
  return { rest, cost, estimated }
}

/** FIFO takes the oldest lots first. Average takes from the known and unknown pools in proportion. */
function take(state: PositionState, qty: bigint): Taken {
  const held = state.lots.reduce((sum, l) => sum + BigInt(l.qty), 0n)
  const taking = qty < held ? qty : held
  const result: Taken = { lots: [], pieces: [], knownQty: 0n, knownCost: 0n, estimatedCost: 0n, unknownQty: 0n, shortfall: qty - taking }

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
    const { rest, cost, estimated } = shrink(lot, n)
    if (rest) result.lots.push(rest)
    if (lot.costUsdMicros === null) result.unknownQty += n
    else {
      result.knownQty += n
      result.knownCost += cost
      result.estimatedCost += estimated
    }
    result.pieces.push({
      qty: n.toString(),
      costUsdMicros: lot.costUsdMicros === null ? null : cost.toString(),
      label: lot.costUsdMicros === null ? "unknown" : lot.label === "mixed" ? "inherited" : lot.label,
      estimatedCostUsdMicros: estimated.toString(),
      ...(lot.acquiredBlock === undefined ? {} : { acquiredBlock: lot.acquiredBlock, acquiredAt: lot.acquiredAt as string }),
    })
  })
  // Units we never saw arrive have no cost anyone can carry.
  if (result.shortfall > 0n) result.pieces.push({ qty: result.shortfall.toString(), costUsdMicros: null, label: "unknown", estimatedCostUsdMicros: "0" })
  return result
}

/** Applies a leg, and says what a debit took, which is what a transfer to a linked wallet carries with it. */
export function applyLegTaking(state: PositionState, leg: FoldLeg): { state: PositionState; taken: CostPiece[] } {
  const delta = BigInt(leg.delta)
  if (delta === 0n) return { state, taken: [] }
  if (delta > 0n) return { state: { ...state, lots: credit(state, leg, delta) }, taken: [] }

  const qty = -delta
  const taken = take(state, qty)
  const next: PositionState = {
    ...state,
    lots: taken.lots,
    shortfallQty: (BigInt(state.shortfallQty) + taken.shortfall).toString(),
  }

  if (leg.kind === "transfer") {
    next.transferredOutCostUsdMicros = (BigInt(state.transferredOutCostUsdMicros) + taken.knownCost).toString()
    return { state: next, taken: taken.pieces }
  }

  const price = leg.priceUsdMicros === null ? null : BigInt(leg.priceUsdMicros)
  let proceeds: bigint | null
  if (leg.kind === "gas") proceeds = price === null ? null : usdOf(taken.knownQty, price, state.decimals)
  else proceeds = leg.proceedsUsdMicros === null ? null : (BigInt(leg.proceedsUsdMicros) * taken.knownQty) / qty

  // What left with no cost we can see: its PnL can't be known, whatever it sold for.
  let unresolved = taken.unknownQty + taken.shortfall
  if (proceeds === null) unresolved += taken.knownQty
  else {
    next.realizedUsdMicros = (BigInt(state.realizedUsdMicros) + proceeds - taken.knownCost).toString()
    next.resolvedDisposedQty = (BigInt(state.resolvedDisposedQty) + taken.knownQty).toString()
    const estimated = taken.estimatedCost + (leg.estimated ? proceeds : 0n)
    next.estimatedRealizedUsdMicros = (BigInt(state.estimatedRealizedUsdMicros) + estimated).toString()
  }
  next.unresolvedDisposedQty = (BigInt(state.unresolvedDisposedQty) + unresolved).toString()

  if (leg.kind === "gas") {
    if (price === null) next.unpricedGasQty = (BigInt(state.unpricedGasQty) + qty).toString()
    else next.gasUsdMicros = (BigInt(state.gasUsdMicros) + usdOf(qty, price, state.decimals)).toString()
  }
  return { state: next, taken: taken.pieces }
}

export function applyLeg(state: PositionState, leg: FoldLeg): PositionState {
  return applyLegTaking(state, leg).state
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
  /** How much of `costUsdMicros`'s lots is an estimate. */
  estimatedCostUsdMicros: string
  /** How much of what `realizedUsdMicros` comes from is an estimate. */
  estimatedRealizedUsdMicros: string
}

export function valuePosition(state: PositionState, priceUsdMicros: string | null): PositionValues {
  let qty = 0n
  let unknownCostQty = 0n
  let cost = 0n
  let estimatedCost = 0n
  for (const lot of state.lots) {
    qty += BigInt(lot.qty)
    if (lot.costUsdMicros === null) unknownCostQty += BigInt(lot.qty)
    else {
      cost += BigInt(lot.costUsdMicros)
      estimatedCost += estimatedOf(lot)
    }
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
    estimatedCostUsdMicros: estimatedCost.toString(),
    estimatedRealizedUsdMicros: state.estimatedRealizedUsdMicros,
  }
}
