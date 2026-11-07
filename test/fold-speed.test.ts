// How long oldest first takes on a wallet that keeps buying, against average, and that a state still reads the way it was made
// once oldest first has added to its lots in place (WORK-680).

// The server loads Apache Arrow, which defines `Symbol.isConcatSpreadable` and so makes every `concat` in the process far slower.
// Loaded here too, so the fold is timed the way it runs there.
import "apache-arrow"
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { applyLeg, emptyPosition, valuePosition, type FoldLeg, type Method, type PositionState } from "@pricetag/sdk/core"

const PRICE = "1000000"

const buys = (count: number): FoldLeg[] =>
  Array.from({ length: count }, (_, i) => ({ id: `buy-${i}`, kind: "swap", delta: "1000000", decimals: 6, costMicros: String(1000 + i), costLabel: "paid", priceMicros: PRICE, proceedsMicros: null, blockNum: i + 1, timestamp: new Date(Date.UTC(2026, 0, 1) + i * 2000).toISOString() }))

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
})
