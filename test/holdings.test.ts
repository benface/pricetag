import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Position } from "@pricetag/sdk/core"
import { DEFAULT_HOLDINGS_SORT, firstSort, formatHoldingsSort, parseHoldingsSort, sortHoldings } from "../src/core/holdings.ts"

function position(asset: string, { qty = "1", value = null as string | null, price = null as string | null, cost = null as string | null, unrealized = null as string | null, decimals = 18 } = {}): Position {
  return {
    asset,
    decimals,
    price: price === null ? null : { micros: price, source: "oracle", blockNum: 1 },
    values: { qty, unknownCostQty: cost === null ? qty : "0", costMicros: cost, averageCostMicros: null, valueMicros: value, realizedMicros: null, unrealizedMicros: unrealized, estimatedCostMicros: "0", estimatedRealizedMicros: "0" },
  } as Position
}

const order = (positions: Position[], sort = DEFAULT_HOLDINGS_SORT) => sortHoldings(positions, sort).map((p) => p.asset)

describe("the holdings' order", () => {
  const dai = position("DAI", { value: "250000000", price: "1000000" })
  const usdc = position("USDC", { value: "3249000000", price: "1000000" })
  const spam = position("NOPE")
  const sold = position("OLD", { qty: "0", value: "0", price: "5000000" })

  it("starts with the largest value, with what has no price last and what's no longer held after it", () => {
    assert.deepEqual(order([dai, spam, sold, usdc]), ["USDC", "DAI", "NOPE", "OLD"])
  })

  it("keeps rows with no number last whichever way it's sorted, so none counts as zero", () => {
    assert.deepEqual(order([dai, spam, sold, usdc], { column: "value", descending: false }), ["DAI", "USDC", "NOPE", "OLD"])
  })

  it("ranks returns, and an unknown return isn't 0%", () => {
    const up = position("UP", { value: "1200000", cost: "1000000", unrealized: "200000" })
    const flat = position("FLAT", { value: "1000000", cost: "1000000", unrealized: "0" })
    const down = position("DOWN", { value: "500000", cost: "1000000", unrealized: "-500000" })
    assert.deepEqual(order([flat, dai, down, up], firstSort("return")), ["UP", "FLAT", "DOWN", "DAI"])
    assert.deepEqual(order([flat, dai, down, up], { column: "return", descending: false }), ["DOWN", "FLAT", "UP", "DAI"])
  })

  it("compares amounts as whole tokens, whatever their decimals", () => {
    const btc = position("cbBTC", { qty: "200000000", decimals: 8 })
    const eth = position("ETH", { qty: "500000000000000000" })
    assert.deepEqual(order([eth, btc], firstSort("amount")), ["cbBTC", "ETH"])
  })

  it("sorts names from A, and other columns from the largest, at first", () => {
    assert.deepEqual(firstSort("asset"), { column: "asset", descending: false })
    assert.deepEqual(firstSort("price"), { column: "price", descending: true })
    assert.deepEqual(order([usdc, dai], firstSort("asset")), ["DAI", "USDC"])
  })

  it("remembers a choice, and falls back to the largest first on anything else", () => {
    for (const sort of [DEFAULT_HOLDINGS_SORT, { column: "return", descending: false } as const]) assert.deepEqual(parseHoldingsSort(formatHoldingsSort(sort)), sort)
    for (const text of [null, "", "value", "price:sideways", "bogus:asc"]) assert.deepEqual(parseHoldingsSort(text), DEFAULT_HOLDINGS_SORT)
  })
})
