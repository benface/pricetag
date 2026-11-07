import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { applyLeg, applyLegTaking, emptyPosition, lotsSplitBy, returnBps, takesAnswerableCost, valuePosition, type FoldLeg, type Method } from "@pricetag/sdk/core"

const USD = 1_000_000n
const ETH = 10n ** 18n

describe("a lot whose cost is only known for all of it", () => {
  const pieces = [{ qty: (2n * ETH).toString(), costMicros: (4000n * USD).toString(), label: "self-reported" as const, estimatedCostMicros: "0", wholeCostOnly: true as const }]
  const arrived: FoldLeg = { id: "in", delta: (2n * ETH).toString(), decimals: 18, kind: "transfer", priceMicros: null, costMicros: (4000n * USD).toString(), proceedsMicros: null, costLabel: "self-reported", pieces }
  const held = applyLeg(emptyPosition("fifo", 18), arrived)
  const sold = (qty: bigint, usd: bigint): FoldLeg => ({ id: "out", delta: (-qty).toString(), decimals: 18, kind: "swap", priceMicros: null, costMicros: null, proceedsMicros: ((qty * usd * USD) / ETH).toString(), costLabel: "unknown" })

  it("keeps its cost while it's all there, and it all goes together", () => {
    assert.equal(valuePosition(held, null).costMicros, (4000n * USD).toString())
    const after = applyLeg(held, sold(2n * ETH, 3000n))
    assert.deepEqual([after.realizedMicros, after.unresolvedDisposedQty], [(2000n * USD).toString(), "0"])
  })

  it("has no known cost for what's taken or what's left once part of it goes", () => {
    const { state, taken } = applyLegTaking(held, sold(ETH, 3000n))
    assert.deepEqual([state.realizedMicros, state.unknownCostDisposedQty, taken[0]?.costMicros, state.lots[0]?.costMicros], ["0", ETH.toString(), null, null])
    assert.deepEqual([valuePosition(state, null).costMicros, valuePosition(state, null).unknownCostQty, valuePosition(state, null).realizedMicros], [null, ETH.toString(), null])
  })

  it("is only split by what doesn't reach the end of it", () => {
    assert.deepEqual(lotsSplitBy(held, ETH), [held.lots[0]])
    assert.deepEqual(lotsSplitBy(held, 2n * ETH), [])
    assert.deepEqual(lotsSplitBy(held, 3n * ETH), [])
    assert.deepEqual(lotsSplitBy(held, 0n), [])
  })

  it("says no answer can fix what its split left, in what's taken and what stays", () => {
    const { state, taken } = applyLegTaking(held, sold(ETH, 3000n))
    assert.equal(taken[0]?.unanswerable, true)
    assert.equal(state.lots[0]?.unanswerable, true)
    assert.equal(takesAnswerableCost(held, ETH), false)
    assert.equal(takesAnswerableCost(state, ETH / 2n), false)
  })

  it("can be from any time before it arrived when it has no date, so it needs all that's ahead of it to go too", () => {
    const dated = { id: "older", delta: ETH.toString(), decimals: 18, kind: "transfer" as const, priceMicros: null, costMicros: (2000n * USD).toString(), proceedsMicros: null, costLabel: "paid" as const, blockNum: 1, timestamp: "2026-10-02T00:00:00.000Z" }
    const both = applyLeg(applyLeg(emptyPosition("fifo", 18), dated), { ...arrived, blockNum: 2, timestamp: "2026-10-03T00:00:00.000Z" })
    assert.equal(lotsSplitBy(both, ETH).length, 2, "what's taken could be either")
    assert.deepEqual(lotsSplitBy(both, 3n * ETH), [])
    const after = applyLeg(both, sold(ETH, 3000n))
    assert.equal(valuePosition(after, null).costMicros, null)
    assert.equal(after.realizedMicros, "0")
    assert.equal(applyLeg(both, sold(3n * ETH, 3000n)).realizedMicros, (3000n * USD).toString())
  })

  it("can still be from before anything ahead of it once its cost is gone", () => {
    const after = applyLeg(applyLeg(emptyPosition("fifo", 18), { ...arrived, blockNum: 2, timestamp: "2026-10-03T00:00:00.000Z" }), sold(ETH / 2n, 3000n))
    const later: FoldLeg = { id: "later", delta: ETH.toString(), decimals: 18, kind: "transfer", priceMicros: null, costMicros: (2500n * USD).toString(), proceedsMicros: null, costLabel: "self-reported", blockNum: 3, timestamp: "2026-10-05T00:00:00.000Z", pieces: [{ qty: ETH.toString(), costMicros: (2500n * USD).toString(), label: "self-reported", estimatedCostMicros: "0", boughtAt: "2026-10-02T12:00:00.000Z" }] }
    const held = applyLeg(after, later)
    assert.deepEqual(held.lots.map((lot) => lot.legId), ["later", "in"], "bought before the undated one arrived")
    assert.deepEqual(applyLegTaking(held, sold(ETH, 3000n)).taken.map((piece) => piece.costMicros), [null])
    assert.equal(valuePosition(applyLeg(held, sold(ETH, 3000n)), null).costMicros, null)
  })
})

describe("purchases at the same moment", () => {
  const AT = "2026-10-01T00:00:00.000Z"
  const onchain = (usd: bigint, qty = ETH): FoldLeg => ({ id: "chain", delta: qty.toString(), decimals: 18, kind: "transfer", priceMicros: null, costMicros: (usd * USD).toString(), proceedsMicros: null, costLabel: "paid", blockNum: 1, timestamp: AT })
  const bought = (id: string, usd: bigint, qty = ETH, purchase = id): FoldLeg => ({ id, delta: qty.toString(), decimals: 18, kind: "transfer", priceMicros: null, costMicros: (usd * USD).toString(), proceedsMicros: null, costLabel: "self-reported", blockNum: 5, timestamp: "2026-10-03T00:00:00.000Z", pieces: [{ qty: qty.toString(), costMicros: (usd * USD).toString(), label: "self-reported", estimatedCostMicros: "0", boughtAt: AT, boughtAs: purchase }] })
  const sold = (qty: bigint, usd: bigint): FoldLeg => ({ id: "out", delta: (-qty).toString(), decimals: 18, kind: "swap", priceMicros: null, costMicros: null, proceedsMicros: (usd * USD).toString(), costLabel: "unknown" })
  const hold = (method: Method, ...legs: FoldLeg[]) => legs.reduce(applyLeg, emptyPosition(method, 18))

  it("has no known cost for part of them when they cost different amounts, whichever arrives first", () => {
    for (const legs of [[onchain(2000n), bought("cb", 1000n)], [bought("cb", 1000n), onchain(2000n)]]) {
      const held = hold("fifo", ...legs)
      assert.equal(lotsSplitBy(held, ETH).length, 2)
      assert.equal(takesAnswerableCost(held, ETH), false)
      const after = applyLeg(held, sold(ETH, 2500n))
      assert.deepEqual([after.realizedMicros, after.unknownCostDisposedQty, valuePosition(after, null).costMicros], ["0", ETH.toString(), null])
    }
  })

  it("keeps the known total when all of them go, or by average", () => {
    const all = applyLeg(hold("fifo", onchain(2000n), bought("cb", 1000n)), sold(2n * ETH, 5000n))
    assert.deepEqual([all.realizedMicros, all.unresolvedDisposedQty], [(2000n * USD).toString(), "0"])
    const average = applyLeg(hold("average", onchain(2000n), bought("cb", 1000n)), sold(ETH, 2500n))
    assert.deepEqual([average.realizedMicros, average.unresolvedDisposedQty], [(1000n * USD).toString(), "0"])
  })

  it("makes no difference when they cost the same, down to rounding", () => {
    const same = applyLeg(hold("fifo", onchain(2000n), bought("cb", 2000n)), sold(ETH, 2500n))
    assert.deepEqual([same.realizedMicros, same.unresolvedDisposedQty, valuePosition(same, null).costMicros], [(500n * USD).toString(), "0", (2000n * USD).toString()])
    const third = (ETH * 2n) / 3n
    const near = hold("fifo", { ...onchain(0n, third), costMicros: "1333333333" }, { ...bought("cb", 2000n), delta: ETH.toString() })
    assert.deepEqual(lotsSplitBy(near, ETH / 2n), [])
  })

  it("isn't a tie between parts of one purchase, whose fees can leave them at slightly different costs", () => {
    const held = hold("fifo", bought("a", 2000n, (ETH * 999n) / 1000n, "one"), bought("b", 2000n, ETH, "one"))
    assert.deepEqual(lotsSplitBy(held, ETH / 2n), [])
  })

  it("is a tie between two purchases, however they're described, or when one says nothing", () => {
    const held = hold("fifo", bought("a", 2000n, ETH, "one"), bought("b", 1000n, ETH, "two"))
    assert.equal(lotsSplitBy(held, ETH / 2n).length, 2)
    assert.deepEqual(lotsSplitBy(held, 2n * ETH), [])
    const { boughtAs: _, ...undescribed } = bought("c", 1000n).pieces![0]!
    for (const legs of [[bought("a", 2000n, ETH, "one"), { ...bought("c", 1000n), pieces: [undescribed] }], [{ ...bought("c", 3000n), pieces: [{ ...undescribed, costMicros: (3000n * USD).toString() }] }, { ...bought("d", 1000n), pieces: [undescribed] }]]) {
      assert.equal(lotsSplitBy(hold("fifo", ...legs), ETH / 2n).length, 2)
    }
  })

  it("counts one with no cost, since what's taken could be that one", () => {
    const unknown: FoldLeg = { ...onchain(0n), costMicros: null, costLabel: "unknown" }
    const held = hold("fifo", unknown, bought("cb", 1000n))
    assert.equal(lotsSplitBy(held, ETH / 2n).length, 2)
    assert.equal(applyLegTaking(held, sold(ETH / 2n, 1000n)).state.realizedMicros, "0")
  })

  it("leaves chain lots in the order the chain gives them", () => {
    const held = hold("fifo", onchain(2000n), { ...onchain(1000n), id: "same-second", blockNum: 2 })
    assert.deepEqual(lotsSplitBy(held, ETH / 2n), [])
  })
})

describe("a purchase an exchange dates", () => {
  const credit = (id: string, qty: bigint, usd: bigint, blockNum: number, timestamp: string, boughtAt?: string): FoldLeg => ({ id, delta: qty.toString(), decimals: 18, kind: "transfer", priceMicros: null, costMicros: (usd * USD).toString(), proceedsMicros: null, costLabel: "self-reported", blockNum, timestamp, pieces: [{ qty: qty.toString(), costMicros: (usd * USD).toString(), label: "self-reported", estimatedCostMicros: "0", ...(boughtAt ? { boughtAt } : {}) }] })
  const held = (...legs: FoldLeg[]) => legs.reduce(applyLeg, emptyPosition("fifo", 18)).lots.map((lot) => lot.legId)

  it("goes by when it was bought, not when it arrived", () => {
    const wallet = credit("wallet", ETH, 2000n, 5, "2026-10-02T12:00:00.000Z")
    assert.deepEqual(held(wallet, credit("old", ETH, 1000n, 9, "2026-10-03T00:00:00.000Z", "2026-10-01T00:00:00.000Z")), ["old", "wallet"])
    assert.deepEqual(held(wallet, credit("new", ETH, 3000n, 9, "2026-10-03T00:00:00.000Z", "2026-10-02T13:00:00.000Z")), ["wallet", "new"])
  })

  it("keeps its place when nothing says what it cost anymore", () => {
    const wallet = credit("wallet", ETH, 2000n, 5, "2026-10-02T12:00:00.000Z")
    const tied = { ...credit("old", 2n * ETH, 4000n, 9, "2026-10-03T00:00:00.000Z", "2026-10-01T00:00:00.000Z") }
    tied.pieces = [{ ...tied.pieces![0]!, wholeCostOnly: true }]
    const state = [wallet, tied, { id: "out", delta: (-ETH).toString(), decimals: 18, kind: "transfer" as const, priceMicros: null, costMicros: null, proceedsMicros: null, costLabel: "unknown" as const }].reduce(applyLeg, emptyPosition("fifo", 18))
    assert.deepEqual(state.lots.map((lot) => [lot.legId, lot.costMicros, lot.boughtAt]), [["old", null, "2026-10-01T00:00:00.000Z"], ["wallet", (2000n * USD).toString(), undefined]])
  })
})

function leg(partial: Partial<Omit<FoldLeg, "delta">> & { delta: bigint }): FoldLeg {
  const { delta, ...rest } = partial
  return {
    id: "leg",
    decimals: 18,
    kind: "swap",
    priceMicros: null,
    costMicros: null,
    proceedsMicros: null,
    costLabel: "unknown",
    ...rest,
    delta: delta.toString(),
  }
}
const total = (qty: bigint, usd: bigint) => ((qty * usd * USD) / ETH).toString()
const buy = (qty: bigint, usd: bigint) =>
  leg({ delta: qty, priceMicros: (usd * USD).toString(), costMicros: total(qty, usd), costLabel: "paid" })
const sell = (qty: bigint, usd: bigint) => leg({ delta: -qty, priceMicros: (usd * USD).toString(), proceedsMicros: total(qty, usd) })
const receive = (qty: bigint, usd: bigint | null = null) =>
  leg({ delta: qty, kind: "transfer", priceMicros: usd === null ? null : (usd * USD).toString() })
const sendOut = (qty: bigint) => leg({ delta: -qty, kind: "transfer" })
const gas = (qty: bigint, usd: bigint | null) =>
  leg({ delta: -qty, kind: "gas", priceMicros: usd === null ? null : (usd * USD).toString() })

function run(method: Method, legs: FoldLeg[]) {
  return legs.reduce(applyLeg, emptyPosition(method, 18))
}
const both = (name: string, fn: (method: Method) => void) => {
  it(`${name} (average)`, () => fn("average"))
  it(`${name} (fifo)`, () => fn("fifo"))
}
const micros = (usd: bigint) => (usd * USD).toString()

describe("applyLeg", () => {
  both("buy", (method) => {
    const v = valuePosition(run(method, [buy(2n * ETH, 100n)]), micros(150n))
    assert.equal(v.qty, (2n * ETH).toString())
    assert.equal(v.costMicros, micros(200n))
    assert.equal(v.averageCostMicros, micros(100n))
    assert.equal(v.valueMicros, micros(300n))
    assert.equal(v.realizedMicros, "0")
    assert.equal(v.unrealizedMicros, micros(100n))
  })

  both("partial sell", (method) => {
    const v = valuePosition(run(method, [buy(2n * ETH, 100n), sell(ETH / 2n, 200n)]), micros(200n))
    assert.equal(v.qty, ((3n * ETH) / 2n).toString())
    assert.equal(v.realizedMicros, micros(50n))
    assert.equal(v.costMicros, micros(150n))
    assert.equal(v.unrealizedMicros, micros(150n))
  })

  it("several buys: average cost blends them", () => {
    const v = valuePosition(run("average", [buy(ETH, 100n), buy(ETH, 200n), sell(ETH, 300n)]), micros(300n))
    assert.equal(v.realizedMicros, micros(150n))
    assert.equal(v.averageCostMicros, micros(150n))
    assert.equal(v.unrealizedMicros, micros(150n))
  })

  it("several buys: FIFO sells the oldest first", () => {
    const v = valuePosition(run("fifo", [buy(ETH, 100n), buy(ETH, 200n), sell(ETH, 300n)]), micros(300n))
    assert.equal(v.realizedMicros, micros(200n))
    assert.equal(v.averageCostMicros, micros(200n))
    assert.equal(v.unrealizedMicros, micros(100n))
  })

  both("sell to zero leaves no dust, even when rounding is involved", (method) => {
    const third = ETH / 3n
    const v = valuePosition(run(method, [buy(ETH, 100n), sell(third, 100n), sell(third, 100n), sell(ETH - 2n * third, 100n)]), micros(100n))
    assert.equal(v.qty, "0")
    assert.equal(v.costMicros, "0")
    assert.equal(v.valueMicros, "0")
    assert.equal(v.unrealizedMicros, "0")
    const realized = BigInt(v.realizedMicros!)
    assert.ok(realized > -3n && realized < 3n, `only rounding error is left, got ${realized}`)
  })

  both("an outgoing transfer carries its cost away, with no gain or loss", (method) => {
    const s = run(method, [buy(2n * ETH, 100n), sendOut(ETH)])
    const v = valuePosition(s, micros(500n))
    assert.equal(v.qty, ETH.toString())
    assert.equal(v.realizedMicros, "0")
    assert.equal(v.costMicros, micros(100n))
    assert.equal(s.transferredOutCostMicros, micros(100n))
  })

  both("gas spends ETH: it's sold at the oracle price, and that value is a fee", (method) => {
    const s = run(method, [buy(ETH, 100n), gas(ETH / 2n, 200n)])
    const v = valuePosition(s, micros(200n))
    assert.equal(s.gasMicros, micros(100n))
    assert.equal(v.realizedMicros, micros(50n))
    assert.equal(v.unrealizedMicros, micros(50n))
    // Started with $100 of ETH, now holds $100 of ETH: PnL after the fee is exactly zero.
    assert.equal(BigInt(v.realizedMicros!) + BigInt(v.unrealizedMicros!) - BigInt(s.gasMicros), 0n)
  })

  it("gas at a block with no price is counted, never as $0", () => {
    const s = run("fifo", [buy(ETH, 100n), gas(ETH / 2n, null)])
    assert.equal(s.gasMicros, "0")
    assert.equal(s.unpricedGasQty, (ETH / 2n).toString())
    assert.equal(valuePosition(s, micros(200n)).realizedMicros, null)
  })
})

describe("unknown is never $0", () => {
  both("a received token has a value, but no cost or PnL", (method) => {
    const v = valuePosition(run(method, [receive(ETH, 300n)]), micros(300n))
    assert.equal(v.valueMicros, micros(300n))
    assert.equal(v.unknownCostQty, ETH.toString())
    assert.equal(v.costMicros, null)
    assert.equal(v.averageCostMicros, null)
    assert.equal(v.unrealizedMicros, null)
  })

  both("selling a received token doesn't realize its whole price as profit", (method) => {
    const s = run(method, [receive(ETH, 100n), sell(ETH, 300n)])
    const v = valuePosition(s, micros(300n))
    assert.equal(v.realizedMicros, null)
    assert.equal(s.realizedMicros, "0")
    assert.equal(s.unresolvedDisposedQty, ETH.toString())
  })

  both("mixing known and unknown cost makes the unrealized PnL unavailable", (method) => {
    const v = valuePosition(run(method, [buy(ETH, 100n), receive(ETH)]), micros(300n))
    assert.equal(v.qty, (2n * ETH).toString())
    assert.equal(v.unknownCostQty, ETH.toString())
    assert.equal(v.costMicros, null)
    assert.equal(v.unrealizedMicros, null)
  })

  it("FIFO sells a known lot first, so its PnL stands until the unknown lot is reached", () => {
    const first = run("fifo", [buy(ETH, 100n), receive(ETH), sell(ETH, 300n)])
    assert.equal(valuePosition(first, micros(300n)).realizedMicros, micros(200n))
    const second = applyLeg(first, sell(ETH / 2n, 300n))
    assert.equal(valuePosition(second, micros(300n)).realizedMicros, null)
  })

  it("average cost sells known and unknown in proportion", () => {
    const s = run("average", [buy(ETH, 100n), receive(ETH), sell(ETH, 300n)])
    assert.equal(s.unresolvedDisposedQty, (ETH / 2n).toString())
    assert.equal(valuePosition(s, micros(300n)).realizedMicros, null)
    assert.equal(valuePosition(s, micros(300n)).unknownCostQty, (ETH / 2n).toString())
  })

  both("cost and proceeds are what changed hands, not the price: a $0 round trip stays $0", (method) => {
    const bought = leg({ delta: ETH, priceMicros: micros(2400n), costMicros: micros(2500n), costLabel: "paid" })
    const sold = leg({ delta: -ETH, priceMicros: micros(2600n), proceedsMicros: micros(2500n) })
    const s = run(method, [bought, sold])
    assert.equal(s.realizedMicros, "0")
    assert.equal(s.resolvedDisposedQty, ETH.toString())
    assert.equal(valuePosition(s, micros(2600n)).realizedMicros, "0")
  })

  both("a partial sale takes its share of the proceeds, and only the known part counts", (method) => {
    const s = run(method, [buy(ETH, 100n), sell(3n * ETH, 200n)])
    assert.equal(s.realizedMicros, micros(100n))
    assert.equal(s.resolvedDisposedQty, ETH.toString())
    assert.equal(s.unresolvedDisposedQty, (2n * ETH).toString())
  })

  both("a sale with no price leaves realized PnL unavailable", (method) => {
    const s = run(method, [buy(ETH, 100n), leg({ delta: -ETH })])
    assert.equal(valuePosition(s, null).realizedMicros, null)
  })

  both("says which side of a sale is unknown", (method) => {
    const sides = (s: ReturnType<typeof run>) => [s.unresolvedDisposedQty, s.unknownCostDisposedQty, s.unknownProceedsQty]
    const half = ETH / 2n
    assert.deepEqual(sides(run(method, [buy(ETH, 100n), leg({ delta: -ETH })])), [ETH.toString(), "0", ETH.toString()], "known cost, no proceeds")
    assert.deepEqual(sides(run(method, [receive(ETH), sell(ETH, 300n)])), [ETH.toString(), ETH.toString(), "0"], "unknown cost, known proceeds")
    assert.deepEqual(sides(run(method, [receive(ETH), leg({ delta: -ETH })])), [ETH.toString(), ETH.toString(), ETH.toString()], "neither known")
    assert.deepEqual(sides(run(method, [buy(half, 100n), sell(ETH, 300n)])), [half.toString(), half.toString(), "0"], "more left than arrived")
    assert.deepEqual(sides(run(method, [buy(ETH, 100n), gas(ETH, null)])), [ETH.toString(), "0", ETH.toString()], "a network fee with no price")
    assert.deepEqual(sides(run(method, [buy(ETH, 100n), sell(ETH, 300n)])), ["0", "0", "0"], "both known")
  })

  both("no current price leaves value and unrealized PnL unavailable, never 0", (method) => {
    const v = valuePosition(run(method, [buy(ETH, 100n)]), null)
    assert.equal(v.valueMicros, null)
    assert.equal(v.unrealizedMicros, null)
    assert.equal(v.costMicros, micros(100n))
  })

  both("selling more than we saw arrive flags the shortfall and makes realized PnL unavailable", (method) => {
    const s = run(method, [buy(ETH, 100n), sell(3n * ETH, 200n)])
    const v = valuePosition(s, micros(200n))
    assert.equal(v.qty, "0")
    assert.equal(s.shortfallQty, (2n * ETH).toString())
    assert.equal(v.realizedMicros, null)
  })

  both("a cost label of unknown ignores any unit cost it was given", (method) => {
    const v = valuePosition(run(method, [leg({ delta: ETH, costMicros: micros(1n), costLabel: "unknown" })]), micros(5n))
    assert.equal(v.costMicros, null)
  })
})

describe("the fold can move into a stateful table", () => {
  it("state survives a JSON round trip at every step", () => {
    const legs = [buy(ETH, 100n), receive(ETH), sell(ETH / 3n, 300n), gas(ETH / 7n, 300n), sendOut(ETH / 5n)]
    for (const method of ["average", "fifo"] as const) {
      const direct = legs.reduce(applyLeg, emptyPosition(method, 18))
      const roundTripped = legs.reduce((s, l) => JSON.parse(JSON.stringify(applyLeg(s, l))), emptyPosition(method, 18))
      assert.deepEqual(roundTripped, direct)
    }
  })

  it("doesn't change the state it's given", () => {
    const s = run("fifo", [buy(ETH, 100n)])
    const before = JSON.stringify(s)
    applyLeg(s, sell(ETH / 2n, 200n))
    assert.equal(JSON.stringify(s), before)
  })

  it("has no imports, clock or randomness", () => {
    const source = readFileSync(new URL("../packages/sdk/src/fold.ts", import.meta.url), "utf8")
    assert.doesNotMatch(source, /^\s*import\s/m)
    assert.doesNotMatch(source, /\b(Date|Math\.random|performance|process|require)\b/)
  })
})

describe("a position's return", () => {
  const of = (costMicros: string | null, unrealizedMicros: string | null) => returnBps({ costMicros, unrealizedMicros })

  it("is the gain on what's held over what it cost, in basis points, rounded half away from zero", () => {
    assert.equal(of("100000000", "12345678"), "1235")
    assert.equal(of("100000000", "-12345678"), "-1235")
    assert.equal(of("3000000", "150"), "1")
    assert.equal(of("3000000", "-150"), "-1")
    assert.equal(of("3000000", "149"), "0")
    assert.equal(of("1000000", "0"), "0")
  })

  it("is unknown when the cost or value is, and never 0", () => {
    assert.equal(of(null, "5"), null)
    assert.equal(of("5", null), null)
  })

  it("has no share of something that cost nothing", () => {
    assert.equal(of("0", "5000000"), null)
  })

  it("comes from the same fold as the rest", () => {
    const s = run("average", [buy(ETH, 2000n)])
    assert.equal(returnBps(valuePosition(s, (2500n * USD).toString())), "2500")
    assert.equal(returnBps(valuePosition(s, null)), null)
  })
})
