// The plain way to say which lots a debit splits and whether answering could fix what it took: by going through
// every lot. The fold stops early when it can, so its steps are checked against this.

import { orderMatters, type FoldLeg, type Lot, type PositionState } from "@pricetag/sdk/core"

const dateOf = ({ boughtAt, acquiredAt }: Pick<Lot, "boughtAt" | "acquiredAt">) => boughtAt ?? acquiredAt


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

/** Lots next to each other with the same date and different costs, when nothing says which came first. Any other lot is on its own. */
function runsInOrder<T extends Ranked>(lots: readonly T[]): T[][] {
  const runs: T[][] = []
  for (const lot of lots) {
    const run = runs.at(-1)
    const date = dateOf(lot)
    if (run && date !== undefined && dateOf(run[0] as T) === date) run.push(lot)
    else runs.push([lot])
  }
  return runs.flatMap((run) => (isTied(run) ? [run] : run.map((lot) => [lot])))
}

/**
 * The lots with no known cost once this much is taken. A lot only known as a whole loses its cost when part of it stays behind,
 * and so do lots tied with each other, when only some of them go. One with no purchase date could have been bought before anything
 * ahead of it too, so what's taken could be either, and unless all of them go, none of them has a known cost.
 */
export function lotsSplitByBefore<T extends Ranked>({ lots }: { lots: readonly T[] }, qty: bigint): T[] {
  if (qty <= 0n) return []
  let through = 0n
  let last = -1
  let split: T[] = []
  let index = 0
  for (const run of runsInOrder(lots)) {
    const before = through
    for (const lot of run) {
      through += BigInt(lot.qty)
      if (through > qty && lot.wholeCostOnly && !lot.boughtAt) last = index
      index++
    }
    if (before < qty && through > qty && (run.length > 1 || run[0]?.wholeCostOnly)) split = run
  }
  const ahead = lots.slice(0, last + 1)
  return [...ahead, ...split.filter((lot) => !ahead.includes(lot))]
}

/** Whether an answer could fix any of the unknown cost in what this much takes. An average takes from all of what's unknown. */
function takesAnswerableCost(state: Pick<PositionState, "lots" | "method">, qty: bigint): boolean {
  const split = lotsSplitByBefore(state, qty)
  let through = 0n
  return state.lots.some((lot) => {
    const taken = state.method === "average" || through < qty
    through += BigInt(lot.qty)
    return taken && lot.costMicros === null && !lot.unanswerable && !split.includes(lot)
  })
}

/** Whether an answer could fix any of a leg's unknown cost, going by what was held before it. Nobody can answer which came first. */
export function costCanBeAnsweredBefore(leg: Pick<FoldLeg, "delta" | "pieces" | "orderUnknown">, before: Pick<PositionState, "lots" | "method">): boolean {
  if (orderMatters(leg, before.method)) return false
  const delta = BigInt(leg.delta)
  return delta > 0n ? (leg.pieces?.some((p) => p.costMicros === null && !p.unanswerable) ?? true) : takesAnswerableCost(before, -delta)
}

