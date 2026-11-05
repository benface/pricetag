import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { BookPoint } from "../src/core/api.ts"
import { DEMO_SAVINGS_ADDRESS, DEMO_WALLET } from "../src/core/fixtures.ts"
import { portfolioOf } from "../server/portfolio.ts"

const points = portfolioOf(DEMO_WALLET, "average").points
const point = (summary: string) => points.find((p) => p.summary === summary) as BookPoint

describe("each transaction's facts", () => {
  it("says what arrived and who sent it, and flags a cost nobody knows yet", () => {
    const funded = point("Received 5,000 USDC")
    assert.deepEqual(funded.amount, { direction: "in", micros: "4999000000" })
    assert.equal(funded.counterparty, DEMO_SAVINGS_ADDRESS)
    assert.deepEqual(funded.unknownCost, ["USDC"])
    assert.equal(funded.gain, null)
  })

  it("gives a sale the gain the fold realized for it", () => {
    const sale = point("Sold 300 AERO for 450 USDC")
    assert.deepEqual(sale.gain, { micros: "74985000", estimated: false })
    assert.equal(sale.amount?.direction, "trade")
    assert.deepEqual(sale.assets, ["AERO", "USDC"])
  })

  it("leaves a sale's gain unknown when what was sold has an unknown cost, never $0", () => {
    assert.deepEqual(point("Sold 0.5 ETH for 1,300 USDC").gain, { micros: null, estimated: false })
  })

  it("values a fee on its own, and has no other party or assets for it", () => {
    const fee = point("Network fee of $0.10")
    assert.deepEqual(fee.amount, { direction: "fee", micros: "98600" })
    assert.deepEqual(fee.assets, [])
    assert.equal(fee.counterparty, null)
  })

  it("names no other party when more than one was on the other side", () => {
    assert.equal(point("Bought 1 ETH for 2,400 USDC").counterparty, null)
  })

  it("has no facts on the last point, which isn't a transaction", () => {
    const last = points.at(-1) as BookPoint
    assert.equal(last.txHash, null)
    assert.deepEqual([last.assets, last.counterparty, last.amount, last.gain, last.unknownCost], [[], null, null, null, []])
  })
})
