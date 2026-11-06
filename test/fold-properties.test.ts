import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { applyLeg, emptyPosition, valuePosition, type FoldLeg, type Method, type PositionState } from "@pricetag/sdk/core"
import { randomLegs } from "./support/random-legs.ts"

const METHODS: readonly Method[] = ["average", "fifo"]
const SEEDS = Array.from({ length: 200 }, (_, seed) => seed + 1)
const PRICE = "1234567890"

const fold = (method: Method, legs: readonly FoldLeg[], decimals: number) => legs.reduce(applyLeg, emptyPosition(method, decimals))
const sum = (legs: readonly FoldLeg[], pick: (leg: FoldLeg) => bigint) => legs.reduce((total, leg) => total + pick(leg), 0n)
const out = (leg: FoldLeg) => (BigInt(leg.delta) < 0n ? -BigInt(leg.delta) : 0n)

/** Each seed's legs, in tokens with the two usual sizes, and with both methods. */
function forEverySeed(check: (seed: number, decimals: number, method: Method) => void) {
  for (const seed of SEEDS) for (const decimals of [18, 6]) for (const method of METHODS) check(seed, decimals, method)
}

/** Realized plus unrealized, which only means something when everything is known. */
function pnl(state: PositionState) {
  const { realizedMicros, unrealizedMicros } = valuePosition(state, PRICE)
  assert.ok(realizedMicros !== null && unrealizedMicros !== null, "this history has nothing unknown")
  return BigInt(realizedMicros) + BigInt(unrealizedMicros)
}

describe("the fold, over random histories", () => {
  it("never loses or makes up a unit", () => {
    forEverySeed((seed, decimals, method) => {
      const legs = randomLegs(seed, 60, decimals)
      const state = fold(method, legs, decimals)
      const { qty } = valuePosition(state, PRICE)
      const moved = sum(legs, (leg) => BigInt(leg.delta))
      assert.equal(BigInt(qty), moved + BigInt(state.shortfallQty), `seed ${seed}: what's held is what moved, plus what left that never arrived`)
      assert.ok(BigInt(qty) >= 0n, `seed ${seed}`)
    })
  })

  it("accounts for every unit that left", () => {
    forEverySeed((seed, decimals, method) => {
      const legs = randomLegs(seed, 60, decimals)
      const state = fold(method, legs, decimals)
      const disposed = sum(legs.filter((leg) => leg.kind !== "transfer"), out)
      assert.equal(BigInt(state.resolvedDisposedQty) + BigInt(state.unresolvedDisposedQty), disposed, `seed ${seed}`)
    })
  })

  it("never lets an unknown read as zero", () => {
    forEverySeed((seed, decimals, method) => {
      const state = fold(method, randomLegs(seed, 60, decimals), decimals)
      const values = valuePosition(state, PRICE)
      if (BigInt(values.unknownCostQty) > 0n) assert.deepEqual([values.costMicros, values.averageCostMicros, values.unrealizedMicros], [null, null, null], `seed ${seed}`)
      if (BigInt(state.unresolvedDisposedQty) > 0n) assert.equal(values.realizedMicros, null, `seed ${seed}`)
    })
  })

  it("has realized plus unrealized come to what it's worth, plus what came in, less what it cost", () => {
    forEverySeed((seed, decimals, method) => {
      const legs = randomLegs(seed, 60, decimals, { known: true, transfers: true })
      const state = fold(method, legs, decimals)
      const { valueMicros } = valuePosition(state, PRICE)
      const paid = sum(legs, (leg) => BigInt(leg.costMicros ?? 0))
      const proceeds = sum(legs, (leg) => BigInt(leg.proceedsMicros ?? 0))
      // A transfer takes its cost along, so it's neither a gain nor a loss.
      assert.equal(pnl(state), BigInt(valueMicros as string) + proceeds - paid + BigInt(state.transferredOutCostMicros), `seed ${seed}`)
    })
  })

  it("has both methods agree on the totals, and differ only in when a gain shows up", () => {
    for (const seed of SEEDS) {
      for (const decimals of [18, 6]) {
        const everything = randomLegs(seed, 60, decimals)
        const [average, fifo] = METHODS.map((method) => fold(method, everything, decimals)) as [PositionState, PositionState]
        assert.equal(valuePosition(average, PRICE).qty, valuePosition(fifo, PRICE).qty, `seed ${seed}`)
        assert.equal(average.shortfallQty, fifo.shortfallQty, `seed ${seed}`)
        const known = randomLegs(seed, 60, decimals, { known: true })
        assert.equal(pnl(fold("average", known, decimals)), pnl(fold("fifo", known, decimals)), `seed ${seed}`)
      }
    }
  })

  it("gives the same answer however often it's asked", () => {
    const legs = randomLegs(7, 60, 18)
    assert.deepEqual(randomLegs(7, 60, 18), legs)
    for (const method of METHODS) assert.deepEqual(fold(method, legs, 18), fold(method, legs, 18))
  })
})
