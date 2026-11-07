import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { applyLeg, applyLegTaking, emptyPosition, inTakeOrder, lotsSplitBy, orderMatters, takesAnswerableCost, valuePosition, type FoldLeg, type Method } from "@pricetag/sdk/core"

const USD = 1_000_000n
const ETH = 10n ** 18n
const day = (block: number) => `2026-10-${String(block).padStart(2, "0")}T00:00:00.000Z`

const bought = (id: string, block: number, usd: bigint | null, qty = ETH): FoldLeg => ({
  id,
  delta: qty.toString(),
  decimals: 18,
  kind: "swap",
  priceMicros: null,
  costMicros: usd === null ? null : (usd * USD).toString(),
  proceedsMicros: null,
  costLabel: usd === null ? "unknown" : "paid",
  blockNum: block,
  timestamp: day(block),
})
const sold = (qty: bigint, usd: bigint, block = 20): FoldLeg => ({ id: "out", delta: (-qty).toString(), decimals: 18, kind: "swap", priceMicros: null, costMicros: null, proceedsMicros: ((qty * usd * USD) / ETH).toString(), costLabel: "unknown", blockNum: block, timestamp: day(block) })
const hold = (method: Method, ...legs: FoldLeg[]) => legs.reduce(applyLeg, emptyPosition(method, 18))

describe("which units a sale takes", () => {
  // Bought at $100, then $300, then $200, one ETH each, then one sold for $500.
  const legs = [bought("a", 1, 100n), bought("b", 2, 300n), bought("c", 3, 200n)]
  const expected: Record<Method, { cost: bigint; left: string[] }> = {
    fifo: { cost: 100n, left: ["b", "c"] },
    lifo: { cost: 200n, left: ["a", "b"] },
    hifo: { cost: 300n, left: ["a", "c"] },
    average: { cost: 200n, left: ["a"] },
  }

  for (const [method, { cost, left }] of Object.entries(expected) as [Method, (typeof expected)[Method]][]) {
    it(`by ${method}, costs ${cost} and leaves what it didn't take oldest first`, () => {
      const after = applyLeg(hold(method, ...legs), sold(ETH, 500n))
      assert.equal(after.realizedMicros, ((500n - cost) * USD).toString())
      assert.deepEqual(after.lots.map((lot) => lot.legId), left)
      assert.equal(valuePosition(after, null).costMicros, ((600n - cost) * USD).toString())
    })
  }

  it("takes across lots in its own order, and splits the last one it reaches", () => {
    const lifo = applyLegTaking(hold("lifo", ...legs), sold(ETH + ETH / 2n, 500n))
    assert.deepEqual(lifo.taken.map((piece) => [piece.costMicros, piece.acquiredAt]), [[(200n * USD).toString(), day(3)], [(150n * USD).toString(), day(2)]])
    assert.deepEqual(lifo.state.lots.map((lot) => [lot.legId, lot.qty]), [["a", ETH.toString()], ["b", (ETH / 2n).toString()]])
    const hifo = applyLegTaking(hold("hifo", ...legs), sold(ETH + ETH / 2n, 500n))
    assert.deepEqual(hifo.taken.map((piece) => [piece.costMicros, piece.acquiredAt]), [[(300n * USD).toString(), day(2)], [(100n * USD).toString(), day(3)]])
    assert.deepEqual(hifo.state.lots.map((lot) => [lot.legId, lot.qty]), [["a", ETH.toString()], ["c", (ETH / 2n).toString()]])
  })

  it("goes by cost per unit for highest cost first, not by what a lot cost in all", () => {
    const after = applyLeg(hold("hifo", bought("big", 1, 400n, 4n * ETH), bought("small", 2, 150n)), sold(ETH, 500n))
    assert.equal(after.realizedMicros, (350n * USD).toString())
  })

  it("takes the oldest first among the same cost", () => {
    const { taken } = applyLegTaking(hold("hifo", bought("a", 1, 200n), bought("b", 2, 200n)), sold(ETH, 500n))
    assert.deepEqual(taken.map((piece) => piece.acquiredAt), [day(1)])
  })

  it("never guesses where something with no known cost ranks by cost, so it goes first, and an answer can fix it", () => {
    const held = hold("hifo", bought("a", 1, 300n), bought("unknown", 2, null))
    assert.deepEqual(inTakeOrder(held.lots, "hifo").map((lot) => lot.legId), ["unknown", "a"])
    const after = applyLeg(held, sold(ETH, 500n))
    assert.deepEqual([after.realizedMicros, after.unknownCostDisposedQty], ["0", ETH.toString()])
    assert.equal(takesAnswerableCost(held, ETH), true)
    assert.equal(valuePosition(after, null).costMicros, (300n * USD).toString())
  })

  it("has no known cost by highest cost first when part of a lot known only as a whole stays, wherever it ranks", () => {
    const whole: FoldLeg = { ...bought("whole", 2, 200n, 2n * ETH), pieces: [{ qty: (2n * ETH).toString(), costMicros: (200n * USD).toString(), label: "self-reported", estimatedCostMicros: "0", wholeCostOnly: true, boughtAt: day(2) }] }
    const held = hold("hifo", bought("a", 1, 300n), whole)
    assert.equal(lotsSplitBy({ lots: inTakeOrder(held.lots, "hifo") }, ETH, "hifo").length, 2, "its parts could cost more than the one ahead of it")
    assert.equal(applyLeg(held, sold(ETH, 500n)).realizedMicros, "0")
    assert.equal(applyLeg(held, sold(3n * ETH, 500n)).realizedMicros, ((1500n - 500n) * USD).toString())
  })

  it("matters in what order things arrived in one block for oldest and newest first, but not by cost", () => {
    assert.deepEqual((["average", "fifo", "lifo", "hifo"] as const).map((method) => orderMatters({ orderUnknown: "fifo" }, method)), [false, true, true, false])
    assert.deepEqual((["average", "fifo", "lifo", "hifo"] as const).map((method) => orderMatters({ orderUnknown: "always" }, method)), [true, true, true, true])
  })
})
