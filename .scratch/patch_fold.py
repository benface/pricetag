import re
p='src/core/fold.ts'; s=open(p).read()
s=s.replace('''  costLabel: CostLabel
}

export type Lot = {
  qty: string
  /** Total cost of this lot, or null when it's unknown. */
  costUsdMicros: string | null
  label: CostLabel | "mixed"
  legId: string
}
''','''  costLabel: CostLabel
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
''')
s=s.replace('''  /** Cost carried away by outgoing transfers. It's not a loss, so it's not in any PnL. */
  transferredOutCostUsdMicros: string
}''','''  /** Cost carried away by outgoing transfers. It's not a loss, so it's not in any PnL. */
  transferredOutCostUsdMicros: string
  /** How much of what `realizedUsdMicros` comes from, in cost and proceeds, is an estimate. */
  estimatedRealizedUsdMicros: string
}''')
s=s.replace('''    transferredOutCostUsdMicros: "0",
  }''','''    transferredOutCostUsdMicros: "0",
    estimatedRealizedUsdMicros: "0",
  }''')
a=s.index('function credit(state'); b=s.index('type Taken =')
s=s[:a]+'''function lotOf(piece: CostPiece, legId: string): Lot {
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

'''+s[b:]
a=s.index('type Taken ='); b=s.index('export type PositionValues')
s=s[:a]+'''type Taken = { lots: Lot[]; pieces: CostPiece[]; knownQty: bigint; knownCost: bigint; estimatedCost: bigint; unknownQty: bigint; shortfall: bigint }

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
      label: lot.costUsdMicros === null || lot.label === "mixed" ? (lot.costUsdMicros === null ? "unknown" : "inherited") : lot.label,
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

'''+s[b:]
s=s.replace('''  /** null when something it depends on is unknown. Never 0 in that case. */
  realizedUsdMicros: string | null
  unrealizedUsdMicros: string | null
}''','''  /** null when something it depends on is unknown. Never 0 in that case. */
  realizedUsdMicros: string | null
  unrealizedUsdMicros: string | null
  /** How much of `costUsdMicros`'s lots is an estimate. */
  estimatedCostUsdMicros: string
  /** How much of what `realizedUsdMicros` comes from is an estimate. */
  estimatedRealizedUsdMicros: string
}''')
s=s.replace('''  let cost = 0n
  for (const lot of state.lots) {
    qty += BigInt(lot.qty)
    if (lot.costUsdMicros === null) unknownCostQty += BigInt(lot.qty)
    else cost += BigInt(lot.costUsdMicros)
  }''','''  let cost = 0n
  let estimatedCost = 0n
  for (const lot of state.lots) {
    qty += BigInt(lot.qty)
    if (lot.costUsdMicros === null) unknownCostQty += BigInt(lot.qty)
    else {
      cost += BigInt(lot.costUsdMicros)
      estimatedCost += estimatedOf(lot)
    }
  }''')
s=s.replace('''    unrealizedUsdMicros: costKnown && value !== null ? (value - cost).toString() : null,
  }''','''    unrealizedUsdMicros: costKnown && value !== null ? (value - cost).toString() : null,
    estimatedCostUsdMicros: estimatedCost.toString(),
    estimatedRealizedUsdMicros: state.estimatedRealizedUsdMicros,
  }''')
open(p,'w').write(s)

p='src/core/legs.ts'; s=open(p).read()
s=s.replace('''  amount: string
  kind: LegKind
}

/** A row of `reference_prices`''','''  amount: string
  kind: LegKind
  /** The other side of this movement, when it's known: who sent a credit, or who a debit went to. */
  counterparty?: string | null
}

/** A row of `reference_prices`''')
s=s.replace('''const REJECTED_NOTE =''','''/** The guarded price of an asset's recent trades at or before a block. See `market.ts`. */
export type MarketLookup = (asset: string, blockNum: number) => string | null

const REJECTED_NOTE =''')
s=s.replace('''  priced: readonly PricedRow[]
}

/**
 * Nets each''','''  priced: readonly PricedRow[]
  market?: MarketLookup
}

/**
 * Nets each''')
s=s.replace('export function buildPricedLegs({ account, rows, references, priced }: Input)','export function buildPricedLegs({ account, rows, references, priced, market }: Input)')
s=s.replace('''          priceSource = "swap"
        }
      }
      return { net, price, priceSource, priceNote, rejected }''','''          priceSource = "swap"
        }
      }
      // A price is a fact about the token at this block, so a trade we couldn't value doesn't stop it having one.
      const marketPrice = price === null && !net.token.oracle ? (market?.(net.token.asset, first.block_num) ?? null) : null
      if (marketPrice !== null) {
        price = marketPrice
        priceSource = "market"
        if (!rejected && !hasUnlisted) priceNote = null
      }
      return { net, price, priceSource, priceNote, rejected }''')
s=s.replace('''    const anchor = isSwap ? (usdcSide ?? resolved.find((r) => r.net.token.oracle === "eth" && r.price !== null)) : undefined
''','''    const oracleSide = isSwap ? (usdcSide ?? resolved.find((r) => r.net.token.oracle === "eth" && r.price !== null)) : undefined
    // With no feed on either side, what left is worth about its market price. That's an estimate, and it's labeled as one.
    const marketSide = isSwap && !oracleSide && !resolved.some((r) => r.rejected) ? (resolved.find((r) => r.net.delta < 0n && r.priceSource === "market") ?? resolved.find((r) => r.priceSource === "market")) : undefined
    const anchor = oracleSide ?? marketSide
''')
s=s.replace('''      const sane = other.net.token.oracle && other.price !== null ? isSaneAgainstOracle(implied, other.price) : isSanePrice(other.net.token, implied.toString(), ethMicros)''','''      const sane = other.price !== null && other.priceSource !== "swap" ? isSaneAgainstOracle(implied, other.price) : isSanePrice(other.net.token, implied.toString(), ethMicros)''')
s=s.replace('''        proceedsUsdMicros: net.delta < 0n ? value : null,
        costLabel,
        parts: net.parts,''','''        proceedsUsdMicros: net.delta < 0n ? value : null,
        costLabel,
        ...(marketSide && value !== null ? { estimated: true } : {}),
        parts: net.parts,''')
open(p,'w').write(s)
