// What a fold's steps say, checked against the way it was worked out before WORK-559: from every lot, before and after each leg.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { applyLeg, costCanBeAnswered, emptyPosition, foldPositions, lotsSplitBy, tallyOf, valuePosition, type CostLabel, type CostPiece, type FoldLeg, type Lot, type Method, type PositionState, type PricedLeg } from "@pricetag/sdk/core"
import { randomFrom, randomLegs } from "./support/random-legs.ts"

const METHODS: readonly Method[] = ["average", "fifo"]
const SEEDS = Array.from({ length: 150 }, (_, seed) => seed + 1)
const PRICE = "1234567890"
const LABELS: readonly CostLabel[] = ["paid", "inherited", "received at market", "self-reported", "unknown"]

/**
 * Random legs with what `randomLegs` leaves out: credits that arrive in pieces, some only known as a whole, some dated by an
 * exchange, some with dates they share, and legs whose order in their block nothing says.
 */
function tangledLegs(seed: number, count: number, decimals: number): FoldLeg[] {
  const random = randomFrom(seed * 7919)
  const dates = [] as string[]
  return randomLegs(seed, count, decimals).map((leg, i) => {
    const delta = BigInt(leg.delta)
    const at = leg.timestamp as string
    dates.push(at)
    const order = random.below(8) === 0 ? { orderUnknown: random.below(2) === 0 ? ("always" as const) : ("fifo" as const) } : {}
    if (delta <= 0n || random.below(3) !== 0) return { ...leg, ...order, ...(delta > 0n && random.below(4) === 0 ? { estimated: true } : {}) }
    const count = 1 + random.below(3)
    const pieces: CostPiece[] = []
    let left = delta
    for (let p = 0; p < count && left > 0n; p++) {
      const qty = p === count - 1 ? left : (left * BigInt(1 + random.below(90))) / 100n || left
      left -= qty
      const known = random.below(3) !== 0
      const cost = random.amount(10).toString()
      const earlier = random.below(2) === 0 ? random.below(i + 1) : i
      pieces.push({
        qty: qty.toString(),
        costMicros: known ? cost : null,
        label: known ? (LABELS[random.below(4)] as CostLabel) : "unknown",
        estimatedCostMicros: known && random.below(3) === 0 ? (BigInt(cost) / 2n).toString() : "0",
        ...(known && random.below(4) === 0 ? { reported: true as const } : {}),
        ...(known && random.below(4) === 0 ? { givenCostMicros: (BigInt(cost) / 3n).toString() } : {}),
        ...(known && random.below(4) === 0 ? { purchaseSource: random.below(2) === 0 ? "Coinbase" : "Kraken" } : {}),
        ...(!known && random.below(3) === 0 ? { unanswerable: true as const } : {}),
        ...(random.below(3) === 0 ? { acquiredBlock: earlier + 1, acquiredAt: dates[earlier] as string } : {}),
        ...(random.below(4) === 0 ? { wholeCostOnly: true as const } : {}),
        // A shared date, sometimes from one file and sometimes from none, is what ties lots.
        ...(random.below(3) === 0 ? { boughtAt: dates[random.below(i + 1)] as string, ...(random.below(2) === 0 ? { boughtIn: `file-${random.below(2)}` } : {}) } : {}),
      })
    }
    return { ...leg, ...order, kind: "transfer", costLabel: "inherited", pieces }
  })
}

/** How `valuePosition` added up lots before it carried its sums from one step to the next. */
function summedBefore(state: PositionState) {
  let qty = 0n
  let unknownCostQty = 0n
  let cost = 0n
  let estimatedCost = 0n
  for (const lot of state.lots) {
    qty += BigInt(lot.qty)
    if (lot.costMicros === null) unknownCostQty += BigInt(lot.qty)
    else {
      cost += BigInt(lot.costMicros)
      estimatedCost += BigInt(lot.estimatedCostMicros ?? "0")
    }
  }
  return { qty: qty.toString(), unknownCostQty: unknownCostQty.toString(), costMicros: unknownCostQty === 0n ? cost.toString() : null, estimatedCostMicros: estimatedCost.toString() }
}

/** How the tax report counted what had a known cost, from a state's lots, before the fold did it. */
function knownBefore(lots: readonly Lot[], leavingOut: readonly Lot[] = []) {
  const known = { qty: 0n, cost: 0n, estimated: 0n, given: 0n, reportedQty: 0n, purchasedQty: 0n, purchaseSource: null as string | null }
  for (const lot of lots) {
    if (lot.costMicros === null || leavingOut.includes(lot)) continue
    known.qty += BigInt(lot.qty)
    known.cost += BigInt(lot.costMicros)
    known.estimated += BigInt(lot.estimatedCostMicros ?? "0")
    known.given += BigInt(lot.givenCostMicros ?? "0")
    if (lot.reported) known.reportedQty += BigInt(lot.qty)
    if (lot.purchaseSource) {
      known.purchasedQty += BigInt(lot.qty)
      known.purchaseSource = lot.purchaseSource
    }
  }
  return known
}

const priced = (legs: readonly FoldLeg[]): PricedLeg[] =>
  legs.map((leg, i) => ({ ...leg, asset: "AERO", blockNum: i + 1, timestamp: leg.timestamp as string, txHash: `0x${(i + 1).toString(16)}`, txIndex: 0, priceSource: null, priceNote: null, parts: [] }))

const histories = (seed: number, decimals: number) => [randomLegs(seed, 60, decimals), randomLegs(seed, 60, decimals, { known: true, transfers: true }), tangledLegs(seed, 60, decimals)]

describe("a fold's steps, against every lot before and after", () => {
  it("adds up what's held the same at every step", () => {
    for (const seed of SEEDS) {
      for (const decimals of [18, 6]) {
        for (const legs of histories(seed, decimals)) {
          for (const method of METHODS) {
            let state = emptyPosition(method, decimals)
            for (const leg of legs) {
              state = applyLeg(state, leg)
              const values = valuePosition(state, PRICE)
              const { qty, unknownCostQty, costMicros, estimatedCostMicros } = values
              assert.deepEqual({ qty, unknownCostQty, costMicros, estimatedCostMicros }, summedBefore(state), `seed ${seed}, ${method}, ${leg.id}`)
              // A copy has no sums to carry, so it adds them up from scratch.
              assert.deepEqual(valuePosition(structuredClone(state), PRICE), values, `seed ${seed}, ${method}, ${leg.id}`)
            }
          }
        }
      }
    }
  })

  it("says what each leg did the same way as from its states", () => {
    for (const seed of SEEDS) {
      for (const decimals of [18, 6]) {
        for (const legs of histories(seed, decimals).map(priced)) {
          for (const method of METHODS) {
            const [position] = foldPositions(legs, method, {})
            assert.ok(position)
            let state = emptyPosition(method, decimals)
            legs.forEach((leg, i) => {
              const before = state
              state = applyLeg(state, leg)
              const effect = position.effects[i]
              const where = `seed ${seed}, ${method}, ${leg.id}`
              assert.ok(effect, where)
              assert.equal(effect.leg, leg, where)
              assert.deepEqual([effect.before, effect.after], [tallyOf(before), tallyOf(state)], where)
              assert.equal(effect.answerable, costCanBeAnswered(leg, before), where)
              const qty = -BigInt(leg.delta)
              assert.deepEqual(effect.known, qty > 0n ? { before: knownBefore(before.lots, lotsSplitBy(before, qty)), after: knownBefore(state.lots) } : null, where)
            })
            assert.deepEqual(position.state, state, `seed ${seed}, ${method}`)
          }
        }
      }
    }
  })

  it("keeps no lots in any step, so memory doesn't grow with the lots held times the legs", () => {
    const [position] = foldPositions(priced(tangledLegs(3, 60, 18)), "fifo", {})
    for (const { before, after } of position?.effects ?? []) assert.equal("lots" in before || "lots" in after, false)
  })
})
