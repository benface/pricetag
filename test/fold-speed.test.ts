// How long oldest first takes on a wallet that keeps buying, against average, and that a state still reads the way it was made
// once oldest first has added to its lots in place (WORK-680).

// The server loads Apache Arrow, which defines `Symbol.isConcatSpreadable` and so makes every `concat` in the process far slower.
// Loaded here too, so the fold is timed the way it runs there.
import "apache-arrow"
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { applyLeg, costCanBeAnswered, emptyPosition, lotsSplitBy, takesAnswerableCost, valuePosition, type CostPiece, type FoldLeg, type Method, type PositionState } from "@pricetag/sdk/core"

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

  it("answers the same about a saved state's unknown cost once a later lot is added to it", () => {
    // Only known as a whole with no date, so it would split what's ahead of it if it were there.
    staysAsMade([unit("unknown", 20, {})], [unit("whole", 30, { kind: "swap", delta: "2000000", pieces: [piece("2000000", "500", { label: "paid", wholeCostOnly: true })] })])
  })
})
