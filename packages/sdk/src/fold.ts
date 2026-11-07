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

/**
 * average: every unit costs the same. fifo: oldest first. lifo: newest first. hifo: the highest cost per unit first, with what has
 * no known cost before anything, since nothing says where it ranks, and oldest first among the same cost. Every method but average
 * keeps lots apart, oldest first, and only differs in which it takes.
 */
export type Method = "average" | "fifo" | "lifo" | "hifo"
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
   * `always` when something left, and `fifo` when things only arrived, since those come to the same average either way, and the
   * same highest cost first. Oldest and newest first both go by when each arrived, so it matters to both.
   * Where it matters, a credit takes no cost, and neither what a debit took nor what it left has one.
   */
  orderUnknown?: "always" | "fifo"
  blockNum?: number
  timestamp?: string
  /** What the wallet already held before the first block read. It isn't a transaction, so its moment isn't when any of it was acquired. */
  opening?: boolean
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
  /**
   * `acquiredAt` is only when it reached a wallet, and nothing says when it was acquired: an opening balance, or something that
   * arrived from elsewhere. It still goes by that moment among the rest. It stays whatever becomes of its cost, since a cost
   * answer says nothing about when it was acquired.
   */
  undated?: true
  /** What an average mixed together, paid at different moments. Missing means all of it at `acquiredBlock`. */
  paidAt?: PaidAt[]
  /** Its cost is only known for all of it, so part of it has no known cost, and neither does the rest. */
  wholeCostOnly?: true
  /** When an exchange says this was bought, which can be well before it reached a wallet, and is what oldest first goes by. */
  boughtAt?: string
  /** The file that says this was bought then. A file makes one lot of a moment, so parts of one date that say the same are one purchase. Missing means nothing says what it's part of. */
  boughtIn?: string
  /** It has no cost because of a lot only known as a whole, or an order nothing says, so no answer about where it came from can fix that. */
  unanswerable?: true
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
  /** `acquiredAt` is only when it reached a wallet, and nothing says when it was acquired, whether or not its cost is known. */
  undated?: true
  /** When a position tracks it: what this lot mixes together. Missing means all of it at `acquiredBlock`. */
  paidAt?: PaidAt[]
  /**
   * Its cost is only known for all of it, so part of it has no known cost, and neither does the rest. It stays this way once that's
   * happened, because with no date, what's left still could have been bought before anything ahead of it.
   */
  wholeCostOnly?: true
  /** When an exchange says this was bought, which can be well before it reached a wallet, and is what oldest first goes by. */
  boughtAt?: string
  /** The file that says this was bought then. A file makes one lot of a moment, so parts of one date that say the same are one purchase. Missing means nothing says what it's part of. */
  boughtIn?: string
  /** It has no cost because of a lot only known as a whole, or an order nothing says, so no answer about where it came from can fix that. An average lot is only this way when all of it is. */
  unanswerable?: true
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

/** A position without its lots: what a step changed comes from these, and they don't grow with what's held. */
export type PositionTally = Omit<PositionState, "lots">

export const tallyOf = ({ lots: _, ...tally }: PositionState): PositionTally => tally

/**
 * What a debit took that had a known cost, and where that cost came from, whatever each lot is labeled. Decimal strings, like the
 * rest of a state. `purchaseSources` names who says what was paid for the lots it took with a known cost, each once, in the order
 * it took them. An average's pool keeps the first it was told.
 */
export type KnownTaken = { qty: string; costMicros: string; estimatedMicros: string; givenMicros: string; reportedQty: string; purchasedQty: string; purchaseSources: string[] }

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

/** What says where this goes among the rest, which stays true whatever becomes of its cost. Only what's there, so a lot with none looks the way it always has. */
export const ranking = ({ wholeCostOnly, boughtAt, boughtIn }: Pick<CostPiece, "wholeCostOnly" | "boughtAt" | "boughtIn">): Pick<CostPiece, "wholeCostOnly" | "boughtAt" | "boughtIn"> => ({
  ...(wholeCostOnly ? { wholeCostOnly } : {}),
  ...(boughtAt ? { boughtAt } : {}),
  ...(boughtIn ? { boughtIn } : {}),
})

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
    ...(piece.undated ? { undated: true as const } : {}),
    // Otherwise every leg's state would keep a copy of it, and the leg already has it for whoever needs it.
    ...(tracksPaidAt && known && piece.paidAt ? { paidAt: piece.paidAt } : {}),
    ...ranking(piece),
    ...(!known && piece.unanswerable ? { unanswerable: true as const } : {}),
  }
}

const estimatedOf = (lot: Lot) => BigInt(lot.estimatedCostMicros ?? "0")

/** What a position's lots add up to. Only a known cost's estimate counts, the way `valuePosition` has always counted it. */
type LotSums = { qty: bigint; unknownCostQty: bigint; cost: bigint; estimatedCost: bigint }

/**
 * Each lots array's sums, carried from one step to the next, so oldest first doesn't add up every lot it holds at every step
 * (WORK-559). Nothing changes a lots array once it's made, so a sum can't go stale, and state stays plain JSON.
 */
const lotSums = new WeakMap<readonly Lot[], LotSums>()

function sumsOf(lots: readonly Lot[]): LotSums {
  const known = lotSums.get(lots)
  if (known) return known
  const sums = addSums(noSums(), lots, 1n)
  lotSums.set(lots, sums)
  return sums
}

const noSums = (): LotSums => ({ qty: 0n, unknownCostQty: 0n, cost: 0n, estimatedCost: 0n })

/** Adds these lots to `sums`, or takes them away with a `sign` of -1. */
function addSums(sums: LotSums, lots: readonly Lot[], sign: 1n | -1n): LotSums {
  for (const lot of lots) {
    const qty = BigInt(lot.qty) * sign
    sums.qty += qty
    if (lot.costMicros === null) sums.unknownCostQty += qty
    else {
      sums.cost += BigInt(lot.costMicros) * sign
      sums.estimatedCost += estimatedOf(lot) * sign
    }
  }
  return sums
}

/** Records what `lots` adds up to, when it's already known, and hands them back. */
function withSums(lots: Lot[], sums: LotSums): Lot[] {
  lotSums.set(lots, sums)
  return lots
}

const dateOf = ({ boughtAt, acquiredAt }: Pick<Lot, "boughtAt" | "acquiredAt">) => boughtAt ?? acquiredAt

/**
 * Whether this was acquired after that. Blocks say, unless an exchange's date is involved, which only has a time. Every time here
 * is in the one format `toISOString` writes, so comparing them as text puts them in order.
 */
function isLater(lot: Lot, than: Lot): boolean {
  if (!lot.boughtAt && !than.boughtAt) return lot.acquiredBlock !== undefined && than.acquiredBlock !== undefined && lot.acquiredBlock > than.acquiredBlock
  const [a, b] = [dateOf(lot), dateOf(than)]
  return a !== undefined && b !== undefined && a > b
}

/** Oldest first by when it was acquired, so an inherited or imported lot goes where its own date says, not where it arrived. */
function insertByDate(lots: readonly Lot[], lot: Lot): Lot[] {
  const at = lot.acquiredBlock === undefined && !lot.boughtAt ? -1 : comesLast(lots, lot) ? -1 : lots.findIndex((l) => isLater(l, lot))
  const next = at < 0 ? lots.concat([lot]) : lots.slice(0, at).concat([lot], lots.slice(at))
  return withFacts(next, factsWith(factsOf(lots), lot))
}

/**
 * Whether any lot has an exchange's date, or is only known as a whole with no date, and the latest block any lot was acquired at,
 * so a step needn't look through every lot to know what isn't there. Like `lotSums`, carried from one lots array to the next. Lots
 * that went away can leave a fact saying something might be there when it isn't, which only costs a look through them.
 */
type LotFacts = { boughtAt: boolean; undatedWhole: boolean; lastBlock: number }

const lotFacts = new WeakMap<readonly Ranked[], LotFacts>()

const noFacts = (): LotFacts => ({ boughtAt: false, undatedWhole: false, lastBlock: Number.NEGATIVE_INFINITY })

const factsWith = (facts: LotFacts, lot: Ranked & Pick<Lot, "acquiredBlock">): LotFacts => ({
  boughtAt: facts.boughtAt || lot.boughtAt !== undefined,
  undatedWhole: facts.undatedWhole || (lot.wholeCostOnly === true && !lot.boughtAt),
  lastBlock: Math.max(facts.lastBlock, lot.acquiredBlock ?? Number.NEGATIVE_INFINITY),
})

function factsOf(lots: readonly (Ranked & Pick<Lot, "acquiredBlock">)[]): LotFacts {
  let facts = lotFacts.get(lots)
  if (!facts) {
    facts = lots.reduce(factsWith, noFacts())
    lotFacts.set(lots, facts)
  }
  return facts
}

function withFacts<T extends Ranked[]>(lots: T, facts: LotFacts): T {
  lotFacts.set(lots, facts)
  return lots
}

/**
 * Whether nothing here is later than this lot, without going through them, which only blocks can say: once an exchange's date is
 * involved, `isLater` goes by time. Otherwise a lot is later only when it has a later block, so none is when none has one.
 */
function comesLast(lots: readonly Lot[], lot: Lot): boolean {
  if (lot.boughtAt || lot.acquiredBlock === undefined) return false
  const facts = factsOf(lots)
  return !facts.boughtAt && facts.lastBlock <= lot.acquiredBlock
}

/** Whether this method keeps lots apart, oldest first, rather than averaging them. */
export const keepsLots = (method: Method) => method !== "average"

/** Whether which lot is taken depends on when it was acquired, so the order of what arrived together can matter. */
const takesByDate = (method: Method) => method === "fifo" || method === "lifo"

/** Whether the first lot costs more per unit than the second, with no known cost above any. Ties are false. */
function costsMore(a: Ranked, b: Ranked): boolean {
  if (a.costMicros === null || b.costMicros === null) return a.costMicros === null && b.costMicros !== null
  return BigInt(a.costMicros) * BigInt(b.qty) > BigInt(b.costMicros) * BigInt(a.qty)
}

/**
 * Lots in the order this method takes them. They're kept oldest first, so newest first is that backwards, and highest cost
 * first sorts them, keeping oldest first among the same cost. The order's the same array for oldest first and average.
 */
export function inTakeOrder<T extends Ranked>(lots: readonly T[], method: Method): readonly T[] {
  if (method === "lifo") return [...lots].reverse()
  if (method === "hifo") return [...lots].sort((a, b) => (costsMore(a, b) ? -1 : costsMore(b, a) ? 1 : 0))
  return lots
}

function addLot({ method, tracksPaidAt }: PositionState, lots: readonly Lot[], lot: Lot): Lot[] {
  if (keepsLots(method)) return insertByDate(lots, lot)
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
    ...(acquired.undated ? { undated: true as const } : {}),
    ...(paidAt ? { paidAt } : {}),
    ...(pool.unanswerable && lot.unanswerable ? { unanswerable: true as const } : {}),
  }
  return lots.map((l) => (l === pool ? merged : l))
}

/** Whether this method's answer for this leg depends on an order nothing says. */
export const orderMatters = ({ orderUnknown }: Pick<FoldLeg, "orderUnknown">, method: Method) => orderUnknown === "always" || (orderUnknown === "fifo" && takesByDate(method))

function credit(state: PositionState, leg: FoldLeg, qty: bigint): Lot[] {
  const before = sumsOf(state.lots)
  const added = arrivals(state, leg, qty)
  // Adding a lot, or merging it into a pool, adds its units and cost to what's held, so the sums only need what arrived.
  return withSums(added.reduce<Lot[]>((lots, lot) => addLot(state, lots, lot), state.lots), addSums({ ...before }, added, 1n))
}

/** The lots a credit adds, before any of them is merged with what's held. */
function arrivals(state: PositionState, leg: FoldLeg, qty: bigint): Lot[] {
  const dated = leg.blockNum === undefined ? {} : { acquiredBlock: leg.blockNum, acquiredAt: leg.timestamp as string }
  // No cost, but what says where its pieces go among the rest is still true.
  const parts: readonly (Pick<CostPiece, "qty" | "wholeCostOnly" | "boughtAt" | "boughtIn">)[] = leg.pieces ?? [{ qty: qty.toString() }]
  // A piece with its own date got it from the wallet that first acquired it. Any other reached a wallet here and now, which is
  // when it was acquired if it was bought here, paid for on its way in, or received as itself. Anything else arrived from
  // somewhere that knows when it was acquired, or was already held, so its moment here says when it arrived, not more. That's
  // so whatever its cost, which says nothing about when it was acquired.
  const undated = (label: CostLabel, boughtAt: string | undefined) => !boughtAt && (leg.opening || !(leg.kind === "swap" || label === "paid" || label === "received at market"))
  const arrivedOnly = (label: CostLabel, boughtAt: string | undefined) => (leg.blockNum !== undefined && undated(label, boughtAt) ? { undated: true as const } : {})
  if (orderMatters(leg, state.method)) return parts.map((piece) => lotOf(state, { qty: piece.qty, costMicros: null, label: "unknown", estimatedCostMicros: "0", unanswerable: true, ...dated, ...arrivedOnly(leg.costLabel, piece.boughtAt), ...ranking(piece) }, leg.id))
  const estimated = (leg.estimated || leg.costLabel === "received at market") && leg.costMicros !== null ? leg.costMicros : "0"
  const own = (piece: CostPiece): CostPiece => ({ ...dated, ...piece, ...(piece.acquiredBlock === undefined ? arrivedOnly(piece.label, piece.boughtAt) : {}) })
  const pieces = leg.pieces?.map(own) ?? [own({ qty: qty.toString(), costMicros: leg.costMicros, label: leg.costLabel, estimatedCostMicros: estimated, ...(leg.purchaseSource ? { purchaseSource: leg.purchaseSource } : {}) })]
  return pieces.map((piece) => lotOf(state, piece, leg.id))
}

type Taken = {
  lots: Lot[]
  pieces: CostPiece[]
  knownQty: bigint
  knownCost: bigint
  estimatedCost: bigint
  /** Of what was taken with a known cost: what someone else first paid, what the user reported, and what an exchange says was bought. */
  givenCost: bigint
  reportedQty: bigint
  purchasedQty: bigint
  /** Who says what was paid for what it took with a known cost, each once, in the order it took them. */
  purchaseSources: string[]
  unknownQty: bigint
  shortfall: bigint
  /** What lost its cost by being taken from, which `lotsSplitBy` says. */
  split: ReadonlySet<Lot>
}

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

type Ranked = Pick<Lot, "qty" | "costMicros" | "wholeCostOnly" | "boughtAt" | "boughtIn" | "acquiredAt">

/**
 * What puts this in order with others of its date. The chain does for its own. Parts of one purchase don't need it, because only
 * fees separate them. Null means nothing does: two purchases an exchange dates the same could be from different accounts, whose
 * files don't say which came first.
 */
const orderedBy = ({ boughtAt, boughtIn }: Ranked) => (boughtAt ? (boughtIn ?? null) : "chain")

/**
 * Whether the order of lots with one date, when nothing says what it is, could change what part of them costs. It can with different
 * costs, and with a lot only known as a whole, however it averages out, because that average needn't be what any part of it cost.
 */
const isTied = <T extends Ranked>(run: readonly T[]) => run.some((lot) => orderedBy(lot) === null || orderedBy(lot) !== orderedBy(run[0] as T)) && run.some((lot) => lot.wholeCostOnly || costsDiffer(run[0] as T, lot))

/** Whether either's order would change what part of them costs. Dividing a cost can round by a millionth each way, which isn't a different cost. */
function costsDiffer(a: Ranked, b: Ranked): boolean {
  if (a.costMicros === null || b.costMicros === null) return a.costMicros !== b.costMicros
  const [aQty, bQty] = [BigInt(a.qty), BigInt(b.qty)]
  const gap = BigInt(a.costMicros) * bQty - BigInt(b.costMicros) * aQty
  return (gap < 0n ? -gap : gap) > aQty + bQty
}

/**
 * Lots next to each other with the same date and different costs, when nothing says which came first. Any other lot is on its own.
 * One at a time, so whoever only needs the first few needn't group them all.
 */
function* runsInOrder<T extends Ranked>(lots: readonly T[]): Generator<T[]> {
  let run: T[] = []
  for (const lot of lots) {
    const date = dateOf(lot)
    if (run.length > 0 && date !== undefined && dateOf(run[0] as T) === date) run.push(lot)
    else {
      if (run.length > 0) yield* untied(run)
      run = [lot]
    }
  }
  if (run.length > 0) yield* untied(run)
}

const untied = <T extends Ranked>(run: T[]): T[][] => (isTied(run) ? [run] : run.map((lot) => [lot]))

/**
 * The lots with no known cost once this much is taken. A lot only known as a whole loses its cost when part of it stays behind,
 * and so do lots tied with each other, when only some of them go. One with no purchase date could have been bought before anything
 * ahead of it too, so what's taken could be either, and unless all of them go, none of them has a known cost.
 */
export function lotsSplitBy<T extends Ranked>({ lots }: { lots: readonly T[] }, qty: bigint, method: Method = "fifo"): T[] {
  if (qty <= 0n) return []
  // Highest cost first goes by cost, not date, so lots of one date are never tied. But a lot only known as a whole could have
  // parts that cost more than anything, wherever its average puts it, so it's like one with no date for oldest first.
  const byCost = method === "hifo"
  // Only a lot known as a whole with no date makes what's ahead of it split, from wherever it is. Without one, nothing past what's
  // taken can, so oldest first needn't look through every purchase it still holds.
  const anywhere = byCost ? lots.some((lot) => lot.wholeCostOnly) : factsOf(lots).undatedWhole
  let through = 0n
  let last = -1
  let split: T[] = []
  let index = 0
  for (const run of byCost ? lots.map((lot) => [lot]) : runsInOrder(lots)) {
    const before = through
    for (const lot of run) {
      through += BigInt(lot.qty)
      if (through > qty && lot.wholeCostOnly && (byCost || !lot.boughtAt)) last = index
      index++
    }
    if (before < qty && through > qty && (run.length > 1 || run[0]?.wholeCostOnly)) split = run
    if (!anywhere && through >= qty) break
  }
  const ahead = lots.slice(0, last + 1)
  return [...ahead, ...split.filter((lot) => !ahead.includes(lot))]
}

/** Whether an answer could fix any of the unknown cost in what this much takes. An average takes from all of what's unknown. */
export function takesAnswerableCost(state: Pick<PositionState, "lots" | "method">, qty: bigint, split?: ReadonlySet<Lot>): boolean {
  const ordered = inTakeOrder(state.lots, state.method)
  const splitBy = split ?? new Set(lotsSplitBy({ lots: ordered }, qty, state.method))
  let through = 0n
  for (const lot of ordered) {
    // Every method but average takes nothing past what adds up to this much.
    if (keepsLots(state.method) && through >= qty) return false
    through += BigInt(lot.qty)
    if (lot.costMicros === null && !lot.unanswerable && !splitBy.has(lot)) return true
  }
  return false
}

/** Whether an answer could fix any of a leg's unknown cost, going by what was held before it. Nobody can answer which came first. */
export function costCanBeAnswered(leg: Pick<FoldLeg, "delta" | "pieces" | "orderUnknown">, before: Pick<PositionState, "lots" | "method">, split?: ReadonlySet<Lot>): boolean {
  if (orderMatters(leg, before.method)) return false
  const delta = BigInt(leg.delta)
  return delta > 0n ? (leg.pieces?.some((p) => p.costMicros === null && !p.unanswerable) ?? true) : takesAnswerableCost(before, -delta, split)
}

/** This lot with no cost anyone can rely on, which is where it stays among the rest. No answer brings that back. */
const withoutCost = ({ qty, legId, unconfirmedBy, acquiredBlock, acquiredAt, undated, ...rest }: Lot): Lot => ({ qty, costMicros: null, label: "unknown", legId, ...unconfirmed(unconfirmedBy), ...(acquiredBlock === undefined ? {} : { acquiredBlock, acquiredAt: acquiredAt as string }), ...(undated ? { undated } : {}), ...ranking(rest), unanswerable: true })

/**
 * FIFO takes the oldest lots first, LIFO the newest and HIFO the costliest per unit. Average takes from the known and unknown pools
 * in proportion. What's left stays oldest first, whichever it took.
 */
function take(state: PositionState, qty: bigint): Taken {
  const before = sumsOf(state.lots)
  const held = before.qty
  const taking = qty < held ? qty : held
  const ordered = inTakeOrder(state.lots, state.method)
  const split = new Set(lotsSplitBy({ lots: ordered }, taking, state.method))
  const result: Taken = { lots: [], pieces: [], knownQty: 0n, knownCost: 0n, estimatedCost: 0n, givenCost: 0n, reportedQty: 0n, purchasedQty: 0n, purchaseSources: [], unknownQty: 0n, shortfall: qty - taking, split }
  // What's left adds up to what was held, less what lost its cost and what was taken.
  const sums = { ...before }

  let remaining = taking
  let splitLeft = split.size
  // Where each lot left came from, so highest cost first can put them back oldest first.
  const storedAt = state.method === "hifo" ? new Map(state.lots.map((lot, i) => [lot, i])) : null
  const from: number[] = []
  const keep = (lot: Lot, source: Lot) => {
    result.lots.push(lot)
    if (storedAt) from.push(storedAt.get(source) as number)
  }
  for (const [i, current] of ordered.entries()) {
    // Every method but average is done once it's taken enough and nothing further on lost its cost, and leaves the rest as it was.
    if (keepsLots(state.method) && remaining === 0n && splitLeft === 0) {
      for (const lot of ordered.slice(i)) keep(lot, lot)
      break
    }
    if (split.has(current)) splitLeft--
    const lot = split.has(current) ? withoutCost(current) : current
    if (lot !== current) addSums(addSums(sums, [current], -1n), [lot], 1n)
    const lotQty = BigInt(lot.qty)
    let n: bigint
    if (keepsLots(state.method)) n = remaining < lotQty ? remaining : lotQty
    else n = i === state.lots.length - 1 ? remaining : (taking * lotQty) / held
    remaining -= n
    if (n === 0n) {
      keep(lot, current)
      continue
    }
    const { rest, cost, estimated, given, paidAt } = shrink(lot, n)
    if (rest) keep(rest, current)
    addSums(sums, [lot], -1n)
    if (rest) addSums(sums, [rest], 1n)
    if (lot.costMicros === null) result.unknownQty += n
    else {
      result.knownQty += n
      result.knownCost += cost
      result.estimatedCost += estimated
      result.givenCost += given
      if (lot.reported) result.reportedQty += n
      if (lot.purchaseSource) {
        result.purchasedQty += n
        if (!result.purchaseSources.includes(lot.purchaseSource)) result.purchaseSources.push(lot.purchaseSource)
      }
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
      ...(lot.undated ? { undated: true as const } : {}),
      ...(paidAt ? { paidAt } : {}),
      ...ranking(lot),
      ...(lot.unanswerable ? { unanswerable: true as const } : {}),
    })
  }
  // Units we never saw arrive have no cost anyone can carry.
  if (result.shortfall > 0n) result.pieces.push({ qty: result.shortfall.toString(), costMicros: null, label: "unknown", estimatedCostMicros: "0" })
  if (state.method === "lifo") result.lots.reverse()
  if (storedAt) result.lots = from.map((at, i) => [at, result.lots[i] as Lot] as const).sort(([a], [b]) => a - b).map(([, lot]) => lot)
  // What's left is some of what was held, and each lot keeps its dates, so what could be among them still could.
  withFacts(withSums(result.lots, sums), factsOf(state.lots))
  return result
}

/** What was taken, with no cost anyone can rely on, and no answer brings that back. */
function withoutCosts(taken: Taken): Taken {
  return {
    ...taken,
    pieces: taken.pieces.map(({ qty, unconfirmedBy, acquiredBlock, acquiredAt, undated, ...rest }) => ({ qty, costMicros: null, label: "unknown", estimatedCostMicros: "0", ...unconfirmed(unconfirmedBy), ...(acquiredBlock === undefined ? {} : { acquiredBlock, acquiredAt: acquiredAt as string }), ...(undated ? { undated } : {}), ...ranking(rest), unanswerable: true })),
    knownQty: 0n,
    knownCost: 0n,
    estimatedCost: 0n,
    givenCost: 0n,
    reportedQty: 0n,
    purchasedQty: 0n,
    purchaseSources: [],
    unknownQty: taken.unknownQty + taken.knownQty,
  }
}

/** What's still held, with no cost anyone can rely on, since how much of each lot is left depends on the same order. */
function lotsWithoutCosts(state: PositionState, lots: readonly Lot[]): Lot[] {
  const { qty } = sumsOf(lots)
  return withSums(
    lots.reduce<Lot[]>((kept, lot) => addLot(state, kept, withoutCost(lot)), []),
    { qty, unknownCostQty: qty, cost: 0n, estimatedCost: 0n },
  )
}

/** Applies a leg, and says what a debit took, which is what a transfer to a linked wallet carries with it. */
export type LegApplied = {
  state: PositionState
  taken: CostPiece[]
  /** Debits only: what was taken with a known cost. */
  known: KnownTaken | null
  /** Debits only: the lots held before that lost their cost by being taken from. */
  split: ReadonlySet<Lot> | null
}

export function applyLegTaking(state: PositionState, leg: FoldLeg): LegApplied {
  const delta = BigInt(leg.delta)
  if (delta === 0n) return { state, taken: [], known: null, split: null }
  if (delta > 0n) return { state: { ...state, lots: credit(state, leg, delta) }, taken: [], known: null, split: null }

  const qty = -delta
  const orderless = orderMatters(leg, state.method)
  const taken = orderless ? withoutCosts(take(state, qty)) : take(state, qty)
  const applied = (next: PositionState): LegApplied => ({ state: next, taken: taken.pieces, known: knownTaken(taken), split: taken.split })
  const next: PositionState = {
    ...state,
    lots: orderless ? lotsWithoutCosts(state, taken.lots) : taken.lots,
    shortfallQty: (BigInt(state.shortfallQty) + taken.shortfall).toString(),
  }

  if (leg.kind === "transfer") {
    next.transferredOutCostMicros = (BigInt(state.transferredOutCostMicros) + taken.knownCost).toString()
    next.transferredOutUnknownQty = (BigInt(state.transferredOutUnknownQty) + taken.unknownQty + taken.shortfall).toString()
    next.transferredOutEstimatedMicros = (BigInt(state.transferredOutEstimatedMicros) + taken.estimatedCost).toString()
    return applied(next)
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
  return applied(next)
}

function knownTaken(taken: Taken): KnownTaken {
  return {
    qty: taken.knownQty.toString(),
    costMicros: taken.knownCost.toString(),
    estimatedMicros: taken.estimatedCost.toString(),
    givenMicros: taken.givenCost.toString(),
    reportedQty: taken.reportedQty.toString(),
    purchasedQty: taken.purchasedQty.toString(),
    purchaseSources: taken.purchaseSources,
  }
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
  const { qty, unknownCostQty, cost, estimatedCost } = sumsOf(state.lots)
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
