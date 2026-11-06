// The cost fold: cost = fold(pricedLegs, method), one state per account and token.
//
// This file has no imports, clock or randomness, so it can move unchanged into a stateful table.
// State and legs are plain JSON with amounts as decimal strings. All math runs in BigInt.
//
// Price and cost stay separate. A leg's price is a shared fact. Its cost is personal, and when it's
// unknown it stays unknown: it never becomes $0, and anything that depends on it becomes null.
//
// Money is in millionths of one currency, and the fold doesn't care which. Gains are only right when it runs in the
// currency they're reported in, because a gain in CAD isn't a gain in USD at some later rate.

export type Method = "average" | "fifo"
export type CostLabel = "paid" | "inherited" | "received at market" | "self-reported" | "unknown"

export type FoldLeg = {
  id: string
  /** Signed, in the token's smallest unit. */
  delta: string
  decimals: number
  /**
   * swap: a debit is a sale for `proceedsMicros`.
   * transfer: a debit carries its cost away with no gain or loss.
   * gas: a debit is a sale at `priceMicros`, and that value is then spent as a fee.
   */
  kind: "swap" | "transfer" | "gas"
  /** The shared fact: price of one whole token at this leg's block, or null when there's no usable price. */
  priceMicros: string | null
  /** Credits only: what this wallet actually paid for the whole leg. Ignored when `costLabel` is "unknown". */
  costMicros: string | null
  /** Swap debits only: what this wallet actually received for the whole leg, or null when that isn't known. */
  proceedsMicros: string | null
  costLabel: CostLabel
  /** Credits only: what arrived, piece by piece, when it isn't one cost. Takes the place of `costMicros` and `costLabel`. */
  pieces?: CostPiece[]
  /** Its cost or proceeds rest on an estimate, so whatever comes from them does too. */
  estimated?: boolean
  /** Credits only: who says what was paid, when it isn't the chain. It stays with the cost wherever it moves. */
  purchaseSource?: string
  /**
   * Nothing says where this comes in its block, among other movements that depend on it, and the method it matters to:
   * `always` when something left, and `fifo` when things only arrived, since those come to the same average either way.
   * Where it matters, a credit takes no cost, and neither what a debit took nor what it left has one.
   */
  orderUnknown?: "always" | "fifo"
  blockNum?: number
  timestamp?: string
}

/** Part of a cost, how many units it paid for, and the block it was paid at. */
export type PaidAt = { costMicros: string; qty: string; blockNum: number }

/** Part of a credit, or what a debit took: how much, what it cost, and when it was first acquired. */
export type CostPiece = {
  qty: string
  costMicros: string | null
  label: CostLabel
  /** The part of `costMicros` that's an estimate. */
  estimatedCostMicros: string
  /** Its cost rests on what the user entered, even if that's $0, wherever it's moved since. Always so on a self-reported piece. */
  reported?: true
  /** The part of `costMicros` that's a market price for what the user said came from someone else, wherever it's moved since. Missing means none. */
  givenCostMicros?: string
  /** Who says what was paid for it, wherever it's moved since. Missing means nobody but the chain. */
  purchaseSource?: string
  /** That's only some of its cost, because an average mixed it with others. */
  purchasePartly?: true
  /** No cost because of these wallets, whose history of it can't be confirmed, wherever it's moved since. Missing means none. */
  unconfirmedBy?: string[]
  acquiredBlock?: number
  acquiredAt?: string
  /** What an average mixed together, paid at different moments. Missing means all of it at `acquiredBlock`. */
  paidAt?: PaidAt[]
  /** Its cost is only known for all of it, so part of it has no known cost, and neither does the rest. */
  wholeCostOnly?: true
}

export type Lot = {
  qty: string
  /** Total cost of this lot, or null when it's unknown. */
  costMicros: string | null
  label: CostLabel | "mixed"
  legId: string
  /** The part of `costMicros` that's an estimate. Missing means none. */
  estimatedCostMicros?: string
  /** Its cost rests on what the user entered, even if that's $0. An average lot stays this way, because every unit shares that cost. */
  reported?: true
  /** The part of `costMicros` that's a market price for what the user said came from someone else. Missing means none. */
  givenCostMicros?: string
  /** Who says what was paid for some or all of it. An average lot stays this way, because every unit shares that cost. */
  purchaseSource?: string
  /** That's only some of its cost, because an average mixed it with others. */
  purchasePartly?: true
  /** No cost because of these wallets, whose history of it can't be confirmed. Missing means none. */
  unconfirmedBy?: string[]
  /** When these units were first acquired, which an inherited lot keeps from the wallet that sent it. */
  acquiredBlock?: number
  acquiredAt?: string
  /** When a position tracks it: what this lot mixes together. Missing means all of it at `acquiredBlock`. */
  paidAt?: PaidAt[]
  /** Its cost is only known for all of it, so part of it has no known cost, and neither does the rest. */
  wholeCostOnly?: true
}

export type PositionState = {
  method: Method
  decimals: number
  /**
   * Keep what an average mixes together apart, so a transfer between linked wallets can say when its cost was paid.
   * Only for that: a pool never loses a date by shrinking, so this costs a little more with each purchase.
   */
  tracksPaidAt?: boolean
  /** Known-cost and unknown-cost units held. Average cost keeps at most one lot of each. */
  lots: Lot[]
  /** From disposals whose cost and proceeds are both known. */
  realizedMicros: string
  /** Units `realizedMicros` comes from, which tells a real $0 from nothing being known. */
  resolvedDisposedQty: string
  /** Units disposed of with an unknown cost or unknown proceeds. Realized PnL is unavailable while this is above 0. */
  unresolvedDisposedQty: string
  /** The units in `unresolvedDisposedQty` with an unknown cost. A unit can have both unknowns. */
  unknownCostDisposedQty: string
  /** The units in `unresolvedDisposedQty` with unknown proceeds. */
  unknownProceedsQty: string
  gasMicros: string
  /** Units spent on gas with no price at that block, so their value isn't in `gasMicros`. */
  unpricedGasQty: string
  /** Units that left beyond what we saw arrive, so this wallet's history is incomplete. */
  shortfallQty: string
  /** Cost carried away by outgoing transfers. It's not a loss, so it's not in any PnL. */
  transferredOutCostMicros: string
  /** Units sent out with no cost anyone can carry, so what they carried isn't all known. */
  transferredOutUnknownQty: string
  /** How much of `transferredOutCostMicros` is an estimate. */
  transferredOutEstimatedMicros: string
  /** How much of what `realizedMicros` comes from, in cost and proceeds, is an estimate. */
  estimatedRealizedMicros: string
}

export function emptyPosition(method: Method, decimals: number, tracksPaidAt = false): PositionState {
  return {
    method,
    decimals,
    ...(tracksPaidAt ? { tracksPaidAt } : {}),
    lots: [],
    realizedMicros: "0",
    resolvedDisposedQty: "0",
    unresolvedDisposedQty: "0",
    unknownCostDisposedQty: "0",
    unknownProceedsQty: "0",
    gasMicros: "0",
    unpricedGasQty: "0",
    shortfallQty: "0",
    transferredOutCostMicros: "0",
    transferredOutUnknownQty: "0",
    transferredOutEstimatedMicros: "0",
    estimatedRealizedMicros: "0",
  }
}

export function worth(qty: bigint, unitMicros: bigint, decimals: number): bigint {
  return (qty * unitMicros) / 10n ** BigInt(decimals)
}

/** Only what's there, so a lot with neither looks the way it always has. */
const costSource = (reported: boolean | undefined, given: bigint): Pick<CostPiece, "reported" | "givenCostMicros"> => ({
  ...(reported ? { reported: true } : {}),
  ...(given > 0n ? { givenCostMicros: given.toString() } : {}),
})

const givenOf = (lot: Pick<Lot, "givenCostMicros">) => BigInt(lot.givenCostMicros ?? "0")

/**
 * Each part's share of a cost and of its units, when `cost` of `totalCost` and `qty` of `totalQty` are taken.
 * The shares add up to exactly what's taken, and none is more than its part.
 */
export function sharePaidAt(paidAt: readonly PaidAt[], cost: bigint, totalCost: bigint, qty: bigint, totalQty: bigint): PaidAt[] {
  const running = { cost: 0n, qty: 0n, givenCost: 0n, givenQty: 0n }
  return paidAt.map((part) => {
    running.cost += BigInt(part.costMicros)
    running.qty += BigInt(part.qty)
    const upToCost = totalCost === 0n ? 0n : (running.cost * cost) / totalCost
    const upToQty = totalQty === 0n ? 0n : (running.qty * qty) / totalQty
    const share = { costMicros: (upToCost - running.givenCost).toString(), qty: (upToQty - running.givenQty).toString(), blockNum: part.blockNum }
    running.givenCost = upToCost
    running.givenQty = upToQty
    return share
  })
}

/** What's left once `taken`, a share of these same parts, is gone. */
export const lessPaidAt = (paidAt: readonly PaidAt[], taken: readonly PaidAt[]): PaidAt[] =>
  paidAt.map(({ costMicros, qty, blockNum }, i) => {
    const gone = taken[i] as PaidAt
    return { costMicros: (BigInt(costMicros) - BigInt(gone.costMicros)).toString(), qty: (BigInt(qty) - BigInt(gone.qty)).toString(), blockNum }
  })

function paidAtOf(lot: Lot): readonly PaidAt[] | null {
  if (lot.paidAt) return lot.paidAt
  return lot.acquiredBlock === undefined || lot.costMicros === null ? null : [{ costMicros: lot.costMicros, qty: lot.qty, blockNum: lot.acquiredBlock }]
}

function mergedPaidAt(a: Lot, b: Lot): PaidAt[] | null {
  const [x, y] = [paidAtOf(a), paidAtOf(b)]
  if (!x || !y) return null
  const byBlock = new Map<number, { cost: bigint; qty: bigint }>()
  for (const { costMicros, qty, blockNum } of [...x, ...y]) {
    const sum = byBlock.get(blockNum) ?? { cost: 0n, qty: 0n }
    byBlock.set(blockNum, { cost: sum.cost + BigInt(costMicros), qty: sum.qty + BigInt(qty) })
  }
  return [...byBlock].map(([blockNum, { cost, qty }]) => ({ costMicros: cost.toString(), qty: qty.toString(), blockNum }))
}

/** Only what's there, so a lot with none looks the way it always has. */
const unconfirmed = (...wallets: readonly (readonly string[] | undefined)[]): Pick<CostPiece, "unconfirmedBy"> => {
  const all = [...new Set(wallets.flatMap((list) => list ?? []))]
  return all.length > 0 ? { unconfirmedBy: all } : {}
}

function lotOf({ tracksPaidAt }: PositionState, piece: CostPiece, legId: string): Lot {
  const known = piece.label !== "unknown" && piece.costMicros !== null
  const estimated = known ? BigInt(piece.estimatedCostMicros) : 0n
  return {
    qty: piece.qty,
    costMicros: known ? piece.costMicros : null,
    label: known ? piece.label : "unknown",
    legId,
    ...(estimated > 0n ? { estimatedCostMicros: estimated.toString() } : {}),
    ...costSource(known && (piece.reported || piece.label === "self-reported"), known ? givenOf(piece) : 0n),
    ...(known && piece.purchaseSource ? { purchaseSource: piece.purchaseSource, ...(piece.purchasePartly ? { purchasePartly: true as const } : {}) } : {}),
    ...unconfirmed(known ? [] : piece.unconfirmedBy),
    ...(piece.acquiredBlock === undefined ? {} : { acquiredBlock: piece.acquiredBlock, acquiredAt: piece.acquiredAt as string }),
    // Otherwise every leg's state would keep a copy of it, and the leg already has it for whoever needs it.
    ...(tracksPaidAt && known && piece.paidAt ? { paidAt: piece.paidAt } : {}),
    ...(known && piece.wholeCostOnly ? { wholeCostOnly: true as const } : {}),
  }
}

const estimatedOf = (lot: Lot) => BigInt(lot.estimatedCostMicros ?? "0")

/** Oldest first by when it was acquired, so an inherited lot goes where its own date says, not where it arrived. */
function insertByDate(lots: readonly Lot[], lot: Lot): Lot[] {
  const at = lot.acquiredBlock === undefined ? -1 : lots.findIndex((l) => l.acquiredBlock !== undefined && l.acquiredBlock > (lot.acquiredBlock as number))
  return at < 0 ? [...lots, lot] : [...lots.slice(0, at), lot, ...lots.slice(at)]
}

function addLot({ method, tracksPaidAt }: PositionState, lots: readonly Lot[], lot: Lot): Lot[] {
  if (method === "fifo") return insertByDate(lots, lot)
  const known = lot.costMicros !== null
  const pool = lots.find((l) => (l.costMicros === null) === !known)
  if (!pool) return [...lots, lot]
  const estimated = estimatedOf(pool) + estimatedOf(lot)
  const acquired = pool.acquiredBlock === undefined || (lot.acquiredBlock !== undefined && lot.acquiredBlock < pool.acquiredBlock) ? lot : pool
  const paidAt = tracksPaidAt && known ? mergedPaidAt(pool, lot) : null
  const merged: Lot = {
    qty: (BigInt(pool.qty) + BigInt(lot.qty)).toString(),
    costMicros: known ? (BigInt(pool.costMicros as string) + BigInt(lot.costMicros as string)).toString() : null,
    label: pool.label === lot.label ? pool.label : "mixed",
    legId: pool.legId,
    ...(estimated > 0n ? { estimatedCostMicros: estimated.toString() } : {}),
    ...costSource(pool.reported || lot.reported, givenOf(pool) + givenOf(lot)),
    ...(pool.purchaseSource || lot.purchaseSource ? { purchaseSource: (pool.purchaseSource ?? lot.purchaseSource) as string, ...(pool.purchaseSource !== lot.purchaseSource || pool.purchasePartly || lot.purchasePartly ? { purchasePartly: true as const } : {}) } : {}),
    ...unconfirmed(pool.unconfirmedBy, lot.unconfirmedBy),
    ...(acquired.acquiredBlock === undefined ? {} : { acquiredBlock: acquired.acquiredBlock, acquiredAt: acquired.acquiredAt as string }),
    ...(paidAt ? { paidAt } : {}),
  }
  return lots.map((l) => (l === pool ? merged : l))
}

/** Whether this method's answer for this leg depends on an order nothing says. */
export const orderMatters = ({ orderUnknown }: Pick<FoldLeg, "orderUnknown">, method: Method) => orderUnknown === "always" || (orderUnknown === "fifo" && method === "fifo")

function credit(state: PositionState, leg: FoldLeg, qty: bigint): Lot[] {
  const dated = leg.blockNum === undefined ? {} : { acquiredBlock: leg.blockNum, acquiredAt: leg.timestamp as string }
  if (orderMatters(leg, state.method)) return addLot(state, state.lots, lotOf(state, { qty: qty.toString(), costMicros: null, label: "unknown", estimatedCostMicros: "0", ...dated }, leg.id))
  const estimated = (leg.estimated || leg.costLabel === "received at market") && leg.costMicros !== null ? leg.costMicros : "0"
  // A piece with its own date got it from the wallet that first acquired it. Any other was acquired here and now.
  const pieces = leg.pieces?.map((piece) => ({ ...dated, ...piece })) ?? [{ qty: qty.toString(), costMicros: leg.costMicros, label: leg.costLabel, estimatedCostMicros: estimated, ...(leg.purchaseSource ? { purchaseSource: leg.purchaseSource } : {}), ...dated }]
  return pieces.reduce<Lot[]>((lots, piece) => addLot(state, lots, lotOf(state, piece, leg.id)), state.lots)
}

type Taken = { lots: Lot[]; pieces: CostPiece[]; knownQty: bigint; knownCost: bigint; estimatedCost: bigint; unknownQty: bigint; shortfall: bigint }

function shrink(lot: Lot, qty: bigint): { rest: Lot | null; cost: bigint; estimated: bigint; given: bigint; paidAt?: PaidAt[] } {
  const lotQty = BigInt(lot.qty)
  const lotCost = lot.costMicros === null ? null : BigInt(lot.costMicros)
  const lotEstimated = estimatedOf(lot)
  // Taking a whole lot takes all of its cost, so rounding never leaves dust behind.
  if (qty === lotQty) return { rest: null, cost: lotCost ?? 0n, estimated: lotEstimated, given: givenOf(lot), ...(lot.paidAt ? { paidAt: lot.paidAt } : {}) }
  const cost = lotCost === null ? 0n : (lotCost * qty) / lotQty
  const estimated = (lotEstimated * qty) / lotQty
  const left = lotEstimated - estimated
  const given = (givenOf(lot) * qty) / lotQty
  const paidAt = lot.paidAt && lotCost !== null ? sharePaidAt(lot.paidAt, cost, lotCost, qty, lotQty) : null
  const { estimatedCostMicros: _, givenCostMicros: _given, ...plain } = lot
  const rest: Lot = {
    ...plain,
    qty: (lotQty - qty).toString(),
    costMicros: lotCost === null ? null : (lotCost - cost).toString(),
    ...(left > 0n ? { estimatedCostMicros: left.toString() } : {}),
    ...costSource(false, givenOf(lot) - given),
    ...(paidAt && lot.paidAt ? { paidAt: lessPaidAt(lot.paidAt, paidAt) } : {}),
  }
  return { rest, cost, estimated, given, ...(paidAt ? { paidAt } : {}) }
}

/** The lot whose only known cost is for all of it, when taking this much would leave part of it behind. It has no known cost after that. */
export function lotSplitBy({ lots }: Pick<PositionState, "lots">, qty: bigint): Lot | null {
  let left = qty
  for (const lot of lots) {
    const lotQty = BigInt(lot.qty)
    if (left < lotQty) return left > 0n && lot.wholeCostOnly ? lot : null
    left -= lotQty
  }
  return null
}

/** This lot with no cost anyone can rely on. */
const withoutCost = ({ qty, legId, unconfirmedBy, acquiredBlock, acquiredAt }: Lot): Lot => ({ qty, costMicros: null, label: "unknown", legId, ...unconfirmed(unconfirmedBy), ...(acquiredBlock === undefined ? {} : { acquiredBlock, acquiredAt: acquiredAt as string }) })

/** FIFO takes the oldest lots first. Average takes from the known and unknown pools in proportion. */
function take(state: PositionState, qty: bigint): Taken {
  const held = state.lots.reduce((sum, l) => sum + BigInt(l.qty), 0n)
  const taking = qty < held ? qty : held
  const result: Taken = { lots: [], pieces: [], knownQty: 0n, knownCost: 0n, estimatedCost: 0n, unknownQty: 0n, shortfall: qty - taking }

  let remaining = taking
  const split = lotSplitBy(state, taking)
  state.lots.forEach((current, i) => {
    const lot = current === split ? withoutCost(current) : current
    const lotQty = BigInt(lot.qty)
    let n: bigint
    if (state.method === "fifo") n = remaining < lotQty ? remaining : lotQty
    else n = i === state.lots.length - 1 ? remaining : (taking * lotQty) / held
    remaining -= n
    if (n === 0n) {
      result.lots.push(lot)
      return
    }
    const { rest, cost, estimated, given, paidAt } = shrink(lot, n)
    if (rest) result.lots.push(rest)
    if (lot.costMicros === null) result.unknownQty += n
    else {
      result.knownQty += n
      result.knownCost += cost
      result.estimatedCost += estimated
    }
    result.pieces.push({
      qty: n.toString(),
      costMicros: lot.costMicros === null ? null : cost.toString(),
      label: lot.costMicros === null ? "unknown" : lot.label === "mixed" ? "inherited" : lot.label,
      estimatedCostMicros: estimated.toString(),
      ...costSource(lot.costMicros !== null && lot.reported, given),
      ...(lot.costMicros !== null && lot.purchaseSource ? { purchaseSource: lot.purchaseSource, ...(lot.purchasePartly ? { purchasePartly: true as const } : {}) } : {}),
      ...unconfirmed(lot.unconfirmedBy),
      ...(lot.acquiredBlock === undefined ? {} : { acquiredBlock: lot.acquiredBlock, acquiredAt: lot.acquiredAt as string }),
      ...(paidAt ? { paidAt } : {}),
      ...(lot.wholeCostOnly ? { wholeCostOnly: true as const } : {}),
    })
  })
  // Units we never saw arrive have no cost anyone can carry.
  if (result.shortfall > 0n) result.pieces.push({ qty: result.shortfall.toString(), costMicros: null, label: "unknown", estimatedCostMicros: "0" })
  return result
}

/** What was taken, with no cost anyone can rely on. */
function withoutCosts(taken: Taken): Taken {
  return {
    ...taken,
    pieces: taken.pieces.map(({ qty, unconfirmedBy, acquiredBlock, acquiredAt }) => ({ qty, costMicros: null, label: "unknown", estimatedCostMicros: "0", ...unconfirmed(unconfirmedBy), ...(acquiredBlock === undefined ? {} : { acquiredBlock, acquiredAt: acquiredAt as string }) })),
    knownQty: 0n,
    knownCost: 0n,
    estimatedCost: 0n,
    unknownQty: taken.unknownQty + taken.knownQty,
  }
}

/** What's still held, with no cost anyone can rely on, since how much of each lot is left depends on the same order. */
function lotsWithoutCosts(state: PositionState, lots: readonly Lot[]): Lot[] {
  return lots.reduce<Lot[]>((kept, lot) => addLot(state, kept, withoutCost(lot)), [])
}

/** Applies a leg, and says what a debit took, which is what a transfer to a linked wallet carries with it. */
export function applyLegTaking(state: PositionState, leg: FoldLeg): { state: PositionState; taken: CostPiece[] } {
  const delta = BigInt(leg.delta)
  if (delta === 0n) return { state, taken: [] }
  if (delta > 0n) return { state: { ...state, lots: credit(state, leg, delta) }, taken: [] }

  const qty = -delta
  const orderless = orderMatters(leg, state.method)
  const taken = orderless ? withoutCosts(take(state, qty)) : take(state, qty)
  const next: PositionState = {
    ...state,
    lots: orderless ? lotsWithoutCosts(state, taken.lots) : taken.lots,
    shortfallQty: (BigInt(state.shortfallQty) + taken.shortfall).toString(),
  }

  if (leg.kind === "transfer") {
    next.transferredOutCostMicros = (BigInt(state.transferredOutCostMicros) + taken.knownCost).toString()
    next.transferredOutUnknownQty = (BigInt(state.transferredOutUnknownQty) + taken.unknownQty + taken.shortfall).toString()
    next.transferredOutEstimatedMicros = (BigInt(state.transferredOutEstimatedMicros) + taken.estimatedCost).toString()
    return { state: next, taken: taken.pieces }
  }

  const price = leg.priceMicros === null ? null : BigInt(leg.priceMicros)
  let proceeds: bigint | null
  if (leg.kind === "gas") proceeds = price === null ? null : worth(taken.knownQty, price, state.decimals)
  else proceeds = leg.proceedsMicros === null ? null : (BigInt(leg.proceedsMicros) * taken.knownQty) / qty

  // What left with no cost we can see: its PnL can't be known, whatever it sold for.
  const unknownCost = taken.unknownQty + taken.shortfall
  let unresolved = unknownCost
  next.unknownCostDisposedQty = (BigInt(state.unknownCostDisposedQty) + unknownCost).toString()
  if (proceeds === null) {
    unresolved += taken.knownQty
    next.unknownProceedsQty = (BigInt(state.unknownProceedsQty) + qty).toString()
  } else {
    next.realizedMicros = (BigInt(state.realizedMicros) + proceeds - taken.knownCost).toString()
    next.resolvedDisposedQty = (BigInt(state.resolvedDisposedQty) + taken.knownQty).toString()
    const estimated = taken.estimatedCost + (leg.estimated ? proceeds : 0n)
    next.estimatedRealizedMicros = (BigInt(state.estimatedRealizedMicros) + estimated).toString()
  }
  next.unresolvedDisposedQty = (BigInt(state.unresolvedDisposedQty) + unresolved).toString()

  if (leg.kind === "gas") {
    if (price === null) next.unpricedGasQty = (BigInt(state.unpricedGasQty) + qty).toString()
    else next.gasMicros = (BigInt(state.gasMicros) + worth(qty, price, state.decimals)).toString()
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
  costMicros: string | null
  /** Per whole token. null whenever part of the position has an unknown cost. */
  averageCostMicros: string | null
  /** null when there's no current price. */
  valueMicros: string | null
  /** null when something it depends on is unknown. Never 0 in that case. */
  realizedMicros: string | null
  unrealizedMicros: string | null
  /** How much of `costMicros`'s lots is an estimate. */
  estimatedCostMicros: string
  /** How much of what `realizedMicros` comes from is an estimate. */
  estimatedRealizedMicros: string
}

export function valuePosition(state: PositionState, priceMicros: string | null): PositionValues {
  let qty = 0n
  let unknownCostQty = 0n
  let cost = 0n
  let estimatedCost = 0n
  for (const lot of state.lots) {
    qty += BigInt(lot.qty)
    if (lot.costMicros === null) unknownCostQty += BigInt(lot.qty)
    else {
      cost += BigInt(lot.costMicros)
      estimatedCost += estimatedOf(lot)
    }
  }
  const costKnown = unknownCostQty === 0n
  const value = priceMicros === null ? null : worth(qty, BigInt(priceMicros), state.decimals)
  return {
    qty: qty.toString(),
    unknownCostQty: unknownCostQty.toString(),
    costMicros: costKnown ? cost.toString() : null,
    averageCostMicros: costKnown && qty > 0n ? ((cost * 10n ** BigInt(state.decimals)) / qty).toString() : null,
    valueMicros: value === null ? null : value.toString(),
    realizedMicros: BigInt(state.unresolvedDisposedQty) === 0n ? state.realizedMicros : null,
    unrealizedMicros: costKnown && value !== null ? (value - cost).toString() : null,
    estimatedCostMicros: estimatedCost.toString(),
    estimatedRealizedMicros: state.estimatedRealizedMicros,
  }
}

/**
 * What's held has gained or lost, as a share of what it cost, in basis points rounded half away from zero. null whenever
 * its cost or value is unknown, so an unknown is never 0%, and when it cost nothing, because there's no share of nothing.
 */
export function returnBps({ costMicros, unrealizedMicros }: Pick<PositionValues, "costMicros" | "unrealizedMicros">): string | null {
  if (costMicros === null || unrealizedMicros === null) return null
  const cost = BigInt(costMicros)
  if (cost <= 0n) return null
  const gain = BigInt(unrealizedMicros) * 10_000n
  const size = ((gain < 0n ? -gain : gain) * 2n + cost) / (2n * cost)
  return (gain < 0n ? -size : size).toString()
}
