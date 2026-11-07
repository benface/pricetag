// What a fold's steps say, checked against working it out from every lot, before and after each leg.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { applyLeg, applyLegTaking, buildPortfolio, emptyPosition, foldPositions, lotsSplitBy, tallyOf, valuePosition, type CostLabel, type CostPiece, type FoldLeg, type KnownTaken, type Lot, type Method, type PositionState, type PricedLeg } from "@pricetag/sdk/core"
import { costCanBeAnsweredBefore, lotsSplitByBefore } from "./support/fold-before.ts"
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
  const known = { qty: 0n, cost: 0n, estimated: 0n, given: 0n, reportedQty: 0n, purchasedQty: 0n }
  for (const lot of lots) {
    if (lot.costMicros === null || leavingOut.includes(lot)) continue
    known.qty += BigInt(lot.qty)
    known.cost += BigInt(lot.costMicros)
    known.estimated += BigInt(lot.estimatedCostMicros ?? "0")
    known.given += BigInt(lot.givenCostMicros ?? "0")
    if (lot.reported) known.reportedQty += BigInt(lot.qty)
    if (lot.purchaseSource) known.purchasedQty += BigInt(lot.qty)
  }
  return known
}

/**
 * What the tax report took a debit's known cost to be: what was held with one before, less the lots it split, and after. Who says
 * what was paid comes from the pieces it took with a known cost, since WORK-679 stopped naming the last one held.
 */
function takenBefore(before: PositionState, after: PositionState, qty: bigint, taken: readonly CostPiece[]): KnownTaken {
  const was = knownBefore(before.lots, lotsSplitByBefore(before, qty))
  const is = knownBefore(after.lots)
  const purchasedQty = was.purchasedQty - is.purchasedQty
  return {
    qty: (was.qty - is.qty).toString(),
    costMicros: (was.cost - is.cost).toString(),
    estimatedMicros: (was.estimated - is.estimated).toString(),
    givenMicros: (was.given - is.given).toString(),
    reportedQty: (was.reportedQty - is.reportedQty).toString(),
    purchasedQty: purchasedQty.toString(),
    purchaseSources: [...new Set(taken.flatMap((piece) => (piece.costMicros !== null && piece.purchaseSource ? [piece.purchaseSource] : [])))],
  }
}

const NOTHING_KNOWN: KnownTaken = { qty: "0", costMicros: "0", estimatedMicros: "0", givenMicros: "0", reportedQty: "0", purchasedQty: "0", purchaseSources: [] }

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
              const applied = applyLegTaking(state, leg)
              state = applied.state
              const effect = position.effects[i]
              const where = `seed ${seed}, ${method}, ${leg.id}`
              assert.ok(effect, where)
              assert.equal(effect.leg, leg, where)
              assert.deepEqual([effect.before, effect.after], [tallyOf(before), tallyOf(state)], where)
              assert.equal(effect.answerable, costCanBeAnsweredBefore(leg, before), where)
              const qty = -BigInt(leg.delta)
              assert.deepEqual(lotsSplitBy(before, qty), lotsSplitByBefore(before, qty), where)
              // When the order matters, nothing it took has a known cost, which the tax report has always said whatever the lots said.
              const orderless = leg.orderUnknown === "always" || (leg.orderUnknown === "fifo" && method === "fifo")
              assert.deepEqual(effect.known, qty <= 0n ? null : orderless ? NOTHING_KNOWN : takenBefore(before, state, qty, applied.taken), where)
            })
            assert.deepEqual(position.state, state, `seed ${seed}, ${method}`)
          }
        }
      }
    }
  })

  it("says what a history that keeps buying did, with every purchase still held", () => {
    // Short random histories often sell everything they hold, so they never get to many lots at once.
    const legs: FoldLeg[] = []
    for (let i = 0; i < 300; i++) legs.push({ id: `buy-${i}`, kind: "swap", delta: "1000000", decimals: 6, costMicros: String(1000 + i), costLabel: "paid", priceMicros: PRICE, proceedsMicros: null, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), ...(i % 7 === 0 ? { purchaseSource: "Coinbase" } : {}) })
    for (let i = 0; i < 300; i++) legs.push({ id: `gas-${i}`, kind: "gas", delta: i % 50 === 0 ? "-2500000" : "-1", decimals: 6, costMicros: null, costLabel: "unknown", priceMicros: PRICE, proceedsMicros: null, timestamp: new Date(Date.UTC(2026, 0, 2, 0, 0, i)).toISOString() })
    for (const method of METHODS) {
      const history = priced(legs)
      const [position] = foldPositions(history, method, {})
      let state = emptyPosition(method, 6)
      history.forEach((leg, i) => {
        const before = state
        const applied = applyLegTaking(state, leg)
        state = applied.state
        const qty = -BigInt(leg.delta)
        assert.deepEqual(position?.effects[i]?.known, qty > 0n ? takenBefore(before, state, qty, applied.taken) : null, `${method}, ${leg.id}`)
        assert.equal(position?.effects[i]?.answerable, costCanBeAnsweredBefore(leg, before), `${method}, ${leg.id}`)
      })
    }
  })

  it("can be saved as JSON, debits included", () => {
    const legs = priced([
      { id: "in", kind: "swap", delta: "100", decimals: 6, costMicros: "1000", costLabel: "paid", priceMicros: PRICE, proceedsMicros: null, timestamp: "2026-01-01T00:00:00.000Z" },
      { id: "out", kind: "transfer", delta: "-10", decimals: 6, costMicros: null, costLabel: "unknown", priceMicros: PRICE, proceedsMicros: null, timestamp: "2026-01-01T00:00:01.000Z" },
    ])
    for (const method of METHODS) {
      const portfolio = buildPortfolio(legs, method)
      const saved = JSON.parse(JSON.stringify(portfolio))
      assert.deepEqual(saved.positions[0].effects[1].known, { ...NOTHING_KNOWN, qty: "10", costMicros: "100" }, method)
      for (const seed of SEEDS.slice(0, 20)) assert.doesNotThrow(() => JSON.stringify(foldPositions(priced(tangledLegs(seed, 60, 18)), method, {})), `seed ${seed}, ${method}`)
    }
  })

  it("keeps no lots in any step, so memory doesn't grow with the lots held times the legs", () => {
    const [position] = foldPositions(priced(tangledLegs(3, 60, 18)), "fifo", {})
    for (const { before, after } of position?.effects ?? []) assert.equal("lots" in before || "lots" in after, false)
  })
})
