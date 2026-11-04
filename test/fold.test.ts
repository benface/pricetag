import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { applyLeg, emptyPosition, valuePosition, type FoldLeg, type Method } from "../src/core/fold.ts"

const USD = 1_000_000n
const ETH = 10n ** 18n

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
    const source = readFileSync(new URL("../src/core/fold.ts", import.meta.url), "utf8")
    assert.doesNotMatch(source, /^\s*import\s/m)
    assert.doesNotMatch(source, /\b(Date|Math\.random|performance|process|require)\b/)
  })
})
