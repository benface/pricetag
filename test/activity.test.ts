import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { PricedLeg } from "@pricetag/sdk/core"
import { legsByTransaction, transactionFacts } from "../src/core/activity.ts"
import type { BookPoint, WalletResponse } from "../src/core/api.ts"
import { DEMO_SAVINGS_ADDRESS, DEMO_WALLET } from "../src/core/fixtures.ts"
import { portfolioOf } from "../src/core/portfolio.ts"

const points = portfolioOf(DEMO_WALLET, "average").points
const point = (summary: string, from: readonly BookPoint[] = points) => from.find((p) => p.summary === summary) as BookPoint
const balances = DEMO_WALLET.balances as NonNullable<WalletResponse["balances"]>

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

  it("leaves a sale's gain unknown when its balance doesn't match, as the totals do", () => {
    const wallet: WalletResponse = { ...DEMO_WALLET, balances: { ...balances, amounts: { ...balances.amounts, AERO: (500n * 10n ** 18n + 10n ** 18n).toString() } } }
    const portfolio = portfolioOf(wallet, "average")
    assert.equal(portfolio.positions.find((p) => p.asset === "AERO")?.reconciliation?.status, "incomplete")
    assert.ok(portfolio.totals.excluded.some((e) => e.asset === "AERO" && e.reason === "doesn't match its actual balance"))
    assert.deepEqual(point("Sold 300 AERO for 450 USDC", portfolio.points).gain, { micros: null, estimated: false })
  })

  it("leaves a sale's gain unknown when its balance couldn't be read", () => {
    const { AERO: _, ...amounts } = balances.amounts
    const portfolio = portfolioOf({ ...DEMO_WALLET, balances: { ...balances, amounts }, unreadBalances: ["AERO"] }, "average")
    assert.notEqual(portfolio.positions.find((p) => p.asset === "AERO")?.reconciliation?.status, "reconciled")
    assert.deepEqual(point("Sold 300 AERO for 450 USDC", portfolio.points).gain, { micros: null, estimated: false })
  })

  it("values a trade at what it brought in, not at the market price of what left", () => {
    const leg = (id: string, asset: string, delta: string, decimals: number, priceMicros: string, proceedsMicros: string | null): PricedLeg =>
      ({ id, asset, delta, decimals, kind: "swap", priceMicros, costMicros: null, proceedsMicros, costLabel: "paid", blockNum: 1, timestamp: "2026-11-05T00:00:00.000Z", txHash: "0xaa", txIndex: 0, priceSource: "swap", priceNote: null, parts: [] }) as PricedLeg
    const sale = [leg("0xaa:ETH", "ETH", (-(10n ** 18n)).toString(), 18, "2000000000", "1900000000"), leg("0xaa:USDC", "USDC", "1900000000", 6, "1000000", null)]
    assert.deepEqual(transactionFacts(legsByTransaction(sale), [], "average", "0x01").get("0xaa")?.amount, { direction: "trade", micros: "1900000000" })
    // When the fold doesn't know what a sale brought in, neither does the row.
    const unknown = [{ ...sale[0], proceedsMicros: null } as PricedLeg, sale[1] as PricedLeg]
    assert.deepEqual(transactionFacts(legsByTransaction(unknown), [], "average", "0x01").get("0xaa")?.amount, { direction: "trade", micros: null })
  })

  it("flags what left with an unknown cost, so a sale or send can be fixed from its own row", () => {
    assert.deepEqual(point("Sold 0.5 ETH for 1,300 USDC").unknownCost, ["ETH"])
    assert.deepEqual(point("Sent 0.002 ETH").unknownCost, ["ETH"])
    // Selling what had a known cost leaves nothing to fix.
    assert.deepEqual(point("Sold 300 AERO for 450 USDC").unknownCost, [])
  })

  it("doesn't call a missing price an unknown cost", () => {
    // DEGEN has no market, so its sale proceeds are unknown, which no answer about what was paid can change.
    assert.deepEqual(point("Bought 50,000 DEGEN for 0.000001 USDC").amount, { direction: "trade", micros: null })
    assert.ok(!point("Network fee of $0.10").unknownCost.length)
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
