// How long oldest first takes on a wallet that keeps buying, and on one that also sells a little often, against average, and that a
// state still reads the way it was made once oldest first has added to its lots in place (WORK-680) or a sale has taken from the
// front of them without copying the rest (WORK-681).

// The server loads Apache Arrow, which defines `Symbol.isConcatSpreadable` and so makes every `concat` in the process far slower.
// Loaded here too, so the fold is timed the way it runs there.
import "apache-arrow"
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { applyLeg, costCanBeAnswered, emptyPosition, lotsSplitBy, takesAnswerableCost, valuePosition, type CostPiece, type FoldLeg, type Method, type PositionState } from "@pricetag/sdk/core"

const PRICE = "1000000"

const buys = (count: number): FoldLeg[] =>
  Array.from({ length: count }, (_, i) => ({ id: `buy-${i}`, kind: "swap", delta: "1000000", decimals: 6, costMicros: String(1000 + i), costLabel: "paid", priceMicros: PRICE, proceedsMicros: null, blockNum: i + 1, timestamp: new Date(Date.UTC(2026, 0, 1) + i * 2000).toISOString() }))

/** Two purchases, then a sale of less than either, over and over, so about two thirds of what's bought stays held. */
const mixed = (count: number, sameTime = false): FoldLeg[] =>
  Array.from({ length: count }, (_, i) => {
    const timestamp = sameTime ? "2026-01-01T00:00:00.000Z" : new Date(Date.UTC(2026, 0, 1) + i * 2000).toISOString()
    return i % 3 === 2
      ? { id: `sell-${i}`, kind: "swap", delta: "-300000", decimals: 6, costMicros: null, costLabel: "unknown", priceMicros: PRICE, proceedsMicros: "300", blockNum: i + 1, timestamp }
      : { id: `buy-${i}`, kind: "swap", delta: "1000000", decimals: 6, costMicros: String(1000 + i), costLabel: "paid", priceMicros: PRICE, proceedsMicros: null, blockNum: i + 1, timestamp }
  })

const fold = (method: Method, legs: readonly FoldLeg[]) => legs.reduce(applyLeg, emptyPosition(method, 6))

/** The fastest of a few runs, so a busy machine slows down both methods' runs the least. */
function fastest(run: () => void): number {
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < 3; i++) {
    const started = performance.now()
    run()
    best = Math.min(best, performance.now() - started)
  }
  return best
}

describe("oldest first on purchases that all stay open", () => {
  it("takes about as long as average for 20,000 of them", () => {
    const legs = buys(20_000)
    // Compiled first, so neither method is timed while it's still being optimized.
    fold("average", legs.slice(0, 2000))
    fold("fifo", legs.slice(0, 2000))
    const average = fastest(() => fold("average", legs))
    const fifo = fastest(() => fold("fifo", legs))
    // Copying every lot held for each purchase took over 25 seconds here, hundreds of times average.
    assert.ok(fifo < average * 4 + 100, `oldest first took ${Math.round(fifo)} ms, average ${Math.round(average)} ms`)
    assert.equal(fold("fifo", legs).lots.length, 20_000)
  })

  it("takes about as long as average for 20,000 purchases and small sales", () => {
    for (const legs of [mixed(20_000), mixed(20_000, true)]) {
      fold("average", legs.slice(0, 2000))
      fold("fifo", legs.slice(0, 2000))
      const average = fastest(() => fold("average", legs))
      const fifo = fastest(() => fold("fifo", legs))
      // Copying every lot held for each sale took over a second here, and grouping every lot with one date at each sale over seven.
      assert.ok(fifo < average * 4 + 100, `oldest first took ${Math.round(fifo)} ms, average ${Math.round(average)} ms`)
      const state = fold("fifo", legs)
      assert.equal(state.lots.length, 11_335)
      assert.deepEqual(valuePosition(state, PRICE), valuePosition(structuredClone(state), PRICE))
    }
  })

  it("still reads a state as it was made, once a later purchase has added to its lots", () => {
    const legs = buys(50)
    const sell: FoldLeg = { id: "sell", kind: "swap", delta: "-2500000", decimals: 6, costMicros: null, costLabel: "unknown", priceMicros: PRICE, proceedsMicros: "3000", blockNum: 100, timestamp: "2026-01-02T00:00:00.000Z" }
    const earlier = fold("fifo", legs.slice(0, 20))
    const copy = structuredClone(earlier)
    const later = legs.slice(20).reduce(applyLeg, earlier)
    // Only the state the latest leg made has every lot.
    assert.equal(later.lots.length, 50)
    // Every function that takes a state answers for the earlier one as it was, as a copy made before would.
    const answers = (state: PositionState) => ({ values: valuePosition(state, PRICE), afterSell: applyLeg(state, sell), afterBuy: applyLeg(state, legs[20] as FoldLeg) })
    assert.deepEqual(answers(earlier), answers(copy))
    // And applying the same legs to it again makes the same state, without changing the first one.
    const saved = structuredClone(later)
    assert.deepEqual(legs.slice(20).reduce(applyLeg, earlier), saved)
    assert.deepEqual(later, saved)
    assert.deepEqual(valuePosition(later, PRICE), valuePosition(fold("fifo", legs), PRICE))
  })

  const unit = (id: string, blockNum: number, rest: Partial<FoldLeg>): FoldLeg => ({ id, kind: "transfer", delta: "1000000", decimals: 6, costMicros: null, costLabel: "unknown", priceMicros: PRICE, proceedsMicros: null, blockNum, timestamp: new Date(Date.UTC(2026, 0, 1) + blockNum * 2000).toISOString(), ...rest })
  const piece = (qty: string, costMicros: string | null, rest: Partial<CostPiece> = {}): CostPiece => ({ qty, costMicros, label: costMicros === null ? "unknown" : "inherited", estimatedCostMicros: "0", ...rest })
  const sellOne: FoldLeg = { id: "sell-one", kind: "swap", delta: "-1000000", decimals: 6, costMicros: null, costLabel: "unknown", priceMicros: PRICE, proceedsMicros: "1000", blockNum: 1000, timestamp: "2026-01-03T00:00:00.000Z" }

  /** Everything a caller can ask of a state, which must be the same for a saved one as for a copy of it made before. */
  const everything = (state: PositionState) => ({
    values: valuePosition(state, PRICE),
    afterSell: applyLeg(state, sellOne),
    split: lotsSplitBy(state, 1000000n),
    answerable: takesAnswerableCost(state, 1000000n),
    canAnswer: costCanBeAnswered(sellOne, state),
  })

  /** A state saved before these legs answers everything as a copy of it made before would, once the legs are applied to it. */
  function staysAsMade(first: readonly FoldLeg[], then: readonly FoldLeg[]) {
    const earlier = first.reduce(applyLeg, emptyPosition("fifo", 6))
    const copy = structuredClone(earlier)
    const later = then.reduce(applyLeg, earlier)
    assert.deepEqual(everything(earlier), everything(copy))
    assert.deepEqual(everything(later), everything(then.reduce(applyLeg, copy)))
  }

  it("keeps a saved state's lots when an older lot arrives after it", () => {
    // Inherited from a wallet that acquired it earlier, so it goes ahead of what's held.
    staysAsMade([unit("bought", 20, { kind: "swap", costMicros: "100", costLabel: "paid" })], [unit("inherited", 30, { pieces: [piece("1000000", "900", { acquiredBlock: 10, acquiredAt: "2026-01-01T00:00:20.000Z" })] })])
    // Imported with an exchange's earlier date.
    staysAsMade([unit("bought", 20, { kind: "swap", costMicros: "100", costLabel: "paid" })], [unit("imported", 30, { pieces: [piece("1000000", "900", { label: "self-reported", reported: true, boughtAt: "2025-06-01T00:00:00.000Z" })] })])
    // Several pieces in one credit: one goes last, then one goes ahead of what's held, then another last.
    staysAsMade(
      [unit("a", 20, { kind: "swap", costMicros: "100", costLabel: "paid" }), unit("b", 25, { kind: "swap", costMicros: "200", costLabel: "paid" })],
      [unit("pieces", 30, { delta: "3000000", pieces: [piece("1000000", "300"), piece("1000000", "900", { acquiredBlock: 10, acquiredAt: "2026-01-01T00:00:20.000Z" }), piece("1000000", "400")] })],
    )
  })

  it("keeps a saved state's lots when later sales take from the front of them", () => {
    const legs = mixed(60)
    // Sales that take part of a lot, all of several, and enough that what's left moves to a copy.
    for (const at of [3, 9, 30]) {
      staysAsMade(legs.slice(0, at), legs.slice(at))
      staysAsMade(legs.slice(0, at), [...legs.slice(at), { ...sellOne, id: "big", delta: "-20000000" }, ...buys(3).map((leg, i) => ({ ...leg, id: `late-${i}`, blockNum: 2000 + i }))])
    }
    // A sale and a purchase from one saved state, each without the other, and from a copy the fold didn't make, which it never adds to.
    const earlier = fold("fifo", legs.slice(0, 20))
    const copy = structuredClone(earlier)
    const saved = structuredClone(earlier)
    const buy = legs[21] as FoldLeg
    const sold = applyLeg(earlier, sellOne)
    const bought = applyLeg(earlier, buy)
    assert.deepEqual(sold, applyLeg(copy, sellOne))
    assert.deepEqual(bought, applyLeg(copy, buy))
    assert.deepEqual(applyLeg(sold, buy), applyLeg(applyLeg(copy, sellOne), buy))
    assert.deepEqual(copy, saved)
    assert.deepEqual(earlier, saved)
  })

  it("never adds to the lots of a state it didn't make, even one copied from a state it did", () => {
    const legs = mixed(60)
    const buy = legs[21] as FoldLeg
    // From a state a purchase made, which holds all of its array, and one a sale made, which holds part of it.
    for (const at of [20, 21, 30]) {
      const earlier = fold("fifo", legs.slice(0, at))
      const saved = structuredClone(earlier)
      const shallow = { ...earlier }
      const reassigned = { ...earlier, lots: earlier.lots }
      const sameLots = shallow.lots
      // Each answers as a copy made before would: a purchase, a sale and then a purchase, and what the purchase leaves held.
      for (const copy of [shallow, reassigned]) {
        const bought = applyLeg(copy, buy)
        assert.deepEqual(bought, applyLeg(structuredClone(saved), buy))
        assert.deepEqual(valuePosition(bought, PRICE), valuePosition(structuredClone(bought), PRICE))
        assert.deepEqual(applyLeg(applyLeg(copy, sellOne), buy), applyLeg(applyLeg(structuredClone(saved), sellOne), buy))
        assert.deepEqual(valuePosition(copy, PRICE), valuePosition(saved, PRICE))
        assert.deepEqual(copy, saved)
      }
      assert.equal(sameLots.length, saved.lots.length)
      // And the state the fold made still adds to its own array, and reads as it was.
      assert.deepEqual(applyLeg(earlier, buy), applyLeg(structuredClone(saved), buy))
      assert.deepEqual(valuePosition(earlier, PRICE), valuePosition(saved, PRICE))
    }
  })

  it("hands back a saved state as it was made when a leg changes nothing", () => {
    const legs = mixed(60)
    const nothing: FoldLeg = { ...sellOne, id: "nothing", delta: "0" }
    // A purchase after it adds to its array, whether it holds all of it, as after a purchase, or part of it, as after a sale.
    const buy: FoldLeg = { ...(legs[0] as FoldLeg), id: "next", blockNum: 500, timestamp: "2026-01-02T00:00:00.000Z" }
    for (const at of [1, 2, 19, 21, 30]) {
      const earlier = fold("fifo", legs.slice(0, at))
      const saved = structuredClone(earlier)
      applyLeg(earlier, buy)
      const same = applyLeg(earlier, nothing)
      // Its lots, and so any copy of it, say what it held, and it goes on from there as the saved copy does.
      assert.deepEqual(same, saved)
      assert.deepEqual(structuredClone(same), saved)
      assert.deepEqual(JSON.parse(JSON.stringify(same)), saved)
      assert.deepEqual(valuePosition(same, PRICE), valuePosition(saved, PRICE))
      assert.deepEqual(legs.slice(at).reduce(applyLeg, same), legs.slice(at).reduce(applyLeg, structuredClone(saved)))
    }
  })

  it("answers the same about a saved state's unknown cost once a later lot is added to it", () => {
    // Only known as a whole with no date, so it would split what's ahead of it if it were there.
    staysAsMade([unit("unknown", 20, {})], [unit("whole", 30, { kind: "swap", delta: "2000000", pieces: [piece("2000000", "500", { label: "paid", wholeCostOnly: true })] })])
  })
})
