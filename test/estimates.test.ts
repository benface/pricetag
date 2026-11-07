// An estimate reads as one wherever a number is explained, and an unknown cost never reads as $0.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { applyLeg, applyLegTaking, effectOf, emptyPosition, firstMarks, pnlOverTime, usdView, viewWallet, type LegEffect, type Method, type PricedLeg } from "@pricetag/sdk/core"
import type { ExplanationResponse, WalletResponse } from "../src/core/api.ts"
import { foldBook } from "../src/core/resolve.ts"
import { emptyBook } from "../src/core/book.ts"
import { ESTIMATE_LINE, est } from "../src/core/wording.ts"
import { describeEffect, summarizeEffect } from "../src/core/explain.ts"
import { explainCombined } from "../src/core/combined.ts"
import { DEMO_WALLET } from "../src/core/fixtures.ts"
import { explainPortfolio, portfolioOf } from "../src/core/portfolio.ts"

const ETH = 10n ** 18n
const method: Method = "average"

function leg(delta: bigint, rest: Partial<PricedLeg> = {}): PricedLeg {
  return { id: "leg", asset: "ETH", decimals: 18, delta: delta.toString(), kind: "transfer", priceMicros: "3000000000", priceSource: "oracle", priceNote: null, costMicros: null, proceedsMicros: null, costLabel: "unknown", parts: [], blockNum: 1, txIndex: 0, timestamp: "2026-11-04T00:00:00Z", txHash: "0xa", ...rest } as PricedLeg
}

/** The effect of `last` after `earlier`. */
function effect(earlier: readonly PricedLeg[], last: PricedLeg): LegEffect {
  const before = earlier.reduce((state, l) => applyLeg(state, l), emptyPosition(method, 18))
  return effectOf(last, before, applyLegTaking(before, last))
}

describe("explaining an estimate", () => {
  const { positions, totals } = portfolioOf(DEMO_WALLET, method)
  const marks: [string, { kind: "total"; metric: "pnl" | "value" | "realized" | "unrealized" }, string | null, boolean][] = [
    ["PnL", { kind: "total", metric: "pnl" }, totals.pnlMicros, BigInt(totals.estimatedMicros) > 0n],
    ["value", { kind: "total", metric: "value" }, totals.valueMicros, totals.estimated.value],
    ["realized", { kind: "total", metric: "realized" }, totals.realizedMicros, totals.estimated.realized],
    ["unrealized", { kind: "total", metric: "unrealized" }, totals.unrealizedMicros, totals.estimated.unrealized],
  ]
  for (const [name, target, micros, estimated] of marks) {
    it(`marks total ${name} just as the main screen does, and says so`, () => {
      const { value, lines } = explainPortfolio(DEMO_WALLET, method, target)!
      assert.equal(micros !== null, value !== null)
      assert.equal(value?.startsWith("≈"), estimated)
      assert.equal(lines.includes(ESTIMATE_LINE), estimated)
    })
  }

  it("marks a holding's numbers by what each rests on, and every one of them says so", () => {
    const flags = { average: "cost", price: "value", value: "value", return: "unrealized", realized: "realized", unrealized: "unrealized" } as const
    let marked = 0
    for (const position of positions) {
      for (const [metric, flag] of Object.entries(flags) as [keyof typeof flags, (typeof flags)[keyof typeof flags]][]) {
        const explanation: ExplanationResponse = explainPortfolio(DEMO_WALLET, method, { kind: "asset", asset: position.asset, metric })!
        const { value, lines } = explanation
        if (value === null) continue
        assert.equal(value.startsWith("≈"), position.estimates[flag], `${position.asset} ${metric}`)
        if (position.estimates[flag]) {
          marked++
          assert.ok(lines.some((line) => line.includes("estimate")), `${position.asset} ${metric}`)
        }
      }
    }
    assert.ok(marked > 0)
  })

  it("marks the same numbers across wallets", () => {
    const whole = explainCombined([DEMO_WALLET], method, { kind: "total", metric: "pnl" }, emptyBook())!
    assert.ok(whole.value?.startsWith("≈"))
    assert.ok(whole.lines.includes(ESTIMATE_LINE))
    const aero = explainCombined([DEMO_WALLET], method, { kind: "asset", asset: "AERO", metric: "return" }, emptyBook())!
    assert.ok(aero.value?.startsWith("≈"))
    assert.ok(aero.lines.includes(ESTIMATE_LINE))
  })

  it("marks the comparison with holding ETH when it rests on an estimate", () => {
    const { holdComparison } = foldBook(DEMO_WALLET, [], method, emptyBook())
    assert.ok(holdComparison)
    const { value, lines } = explainPortfolio(DEMO_WALLET, method, { kind: "hold" })!
    if (holdComparison.holdMicros !== null) assert.equal(value?.startsWith("≈"), holdComparison.estimated)
    assert.equal(lines.includes(ESTIMATE_LINE), holdComparison.holdMicros !== null && (holdComparison.estimated || holdComparison.walletEstimated))
  })

  it("marks a transaction's PnL by what it rests on", () => {
    const bought = leg(ETH, { costMicros: "3000000000", costLabel: "paid" })
    const given = leg(ETH, { costMicros: "3000000000", costLabel: "received at market", txHash: "0xb", blockNum: 2 })
    const at = pnlOverTime([bought, given], method, {}, () => "3000000000", null)
    assert.equal(at[0]?.pnlEstimated, undefined)
    assert.equal(at[1]?.pnlEstimated, true)
  })

  describe("a transaction's PnL goes by the price used at that block, not today's", () => {
    const aero = leg(10n ** 18n, { asset: "AERO", costMicros: "1000000", costLabel: "paid", priceMicros: "1000000" })
    const wallet = (source: "oracle" | "market", fromFeed: boolean): WalletResponse => ({
      ...DEMO_WALLET,
      legs: [aero],
      references: [],
      marketMarks: { 1: { AERO: "2000000" } },
      ...(fromFeed ? { feedMarks: { 1: ["AERO"] } } : { feedMarks: {} }),
      prices: { AERO: { micros: "2000000", source, blockNum: 2 } },
      balances: { blockNum: 2, amounts: { AERO: aero.delta } },
      latest: { blockNum: 2, timestamp: "2026-11-04T00:00:04Z" },
      coverage: { fromBlock: 1, toBlock: 2 },
      unreadBalances: [],
      priceSamples: [],
      gasUnknownTxs: [],
      l1FeeUnknownTxs: [],
    })
    const explain = (response: WalletResponse) => explainPortfolio(response, method, { kind: "tx", txHash: "0xa" })!

    it("marks a market price then, though a feed prices it now", () => {
      const { value, lines } = explain(wallet("oracle", false))
      assert.equal(value, "≈+$1.00")
      assert.ok(lines.includes(ESTIMATE_LINE))
    })

    it("leaves a feed's price then alone, though only a market prices it now", () => {
      const { value, lines } = explain(wallet("market", true))
      assert.equal(value, "+$1.00")
      assert.ok(!lines.includes(ESTIMATE_LINE))
    })

    it("marks what's priced by a market now on the last point only", () => {
      const points = foldBook(wallet("market", true), [], method, emptyBook()).points
      assert.deepEqual(points.map((point) => point.pnlEstimated), [undefined, true])
    })

    it("keeps a price's source with the wallet that has that price", () => {
      const noPrice = { markPrice: () => null, markEstimated: () => { throw new Error("it has no price to ask about") } }
      const marks = firstMarks([noPrice, { markPrice: () => "1", markEstimated: () => true }])
      assert.equal(marks.markPrice(1, "AERO"), "1")
      assert.equal(marks.markEstimated(1, "AERO"), true)
    })
  })

  describe("a transaction across wallets", () => {
    const eth = leg(ETH, { costMicros: "3000000000", costLabel: "paid" })
    const wallet: WalletResponse = {
      ...DEMO_WALLET,
      legs: [eth],
      references: [{ blockNum: 1, ethUsd: "300000000000", usdcUsd: "100000000" }],
      marketMarks: {},
      prices: { ETH: { micros: "3000000000", source: "oracle", blockNum: 2 } },
      balances: { blockNum: 2, amounts: { ETH: eth.delta } },
      latest: { blockNum: 2, timestamp: "2026-11-04T00:00:04Z" },
      coverage: { fromBlock: 1, toBlock: 2 },
      unreadBalances: [],
      priceSamples: [],
      gasUnknownTxs: [],
      l1FeeUnknownTxs: [],
    }

    it("reads exact when it reads exact alone", () => {
      const alone = explainPortfolio(wallet, method, { kind: "tx", txHash: "0xa" })!
      const across = explainCombined([wallet], method, { kind: "tx", txHash: "0xa" }, emptyBook())!
      assert.equal(alone.value, "$0.00")
      assert.equal(across.value, "$0.00")
      assert.ok(!across.lines.includes(ESTIMATE_LINE))
    })

    it("still marks a market price", () => {
      const aero = leg(10n ** 18n, { asset: "AERO", costMicros: "1000000", costLabel: "paid", priceMicros: "1000000" })
      const held: WalletResponse = { ...wallet, legs: [aero], references: [], marketMarks: { 1: { AERO: "2000000" } }, prices: { AERO: { micros: "2000000", source: "oracle", blockNum: 2 } }, balances: { blockNum: 2, amounts: { AERO: aero.delta } } }
      const across = explainCombined([held], method, { kind: "tx", txHash: "0xa" }, emptyBook())!
      assert.equal(across.value, "≈+$1.00")
      assert.ok(across.lines.includes(ESTIMATE_LINE))
    })
  })

  it("carries a price's source through another currency", () => {
    const view = { ...DEMO_WALLET, marketMarks: { 1: { AERO: "1" }, 2: { AERO: "1" } }, feedMarks: { 1: ["AERO"] } }
    for (const { markEstimated } of [usdView(view), viewWallet({ ...view, currency: "CAD", rates: { byBlock: {}, latest: null } })]) {
      assert.equal(markEstimated(1, "AERO"), false)
      assert.equal(markEstimated(2, "AERO"), true)
      assert.equal(markEstimated(1, "ETH"), false)
    }
  })

  it("leaves exact numbers alone", () => assert.equal(est("$1.00", false), "$1.00"))
})

describe("saying what a movement's cost is", () => {
  const known = leg(ETH, { costMicros: "3000000000", costLabel: "paid" })
  const unknown = leg(ETH)

  it("never calls an unknown cost $0 of known cost", () => {
    const sent = effect([unknown], leg(-ETH))
    assert.equal(describeEffect(sent, "USD"), "Sent out at an unknown cost, so no gain or loss")
    const { summary, unknown: says, answerable } = summarizeEffect(sent, "USD")
    assert.equal(summary, "Sent $3,000.00 of ETH, with no gain or loss.")
    assert.equal(says, "What this cost isn't known yet.")
    assert.equal(answerable, true)
  })

  it("says which part is known, when only part of it is", () => {
    const sent = effect([known, unknown], leg(-2n * ETH))
    assert.match(describeEffect(sent, "USD"), /^Sent out with \$3,000\.00 of known cost, and 1 ETH at an unknown cost, so no gain or loss/)
    assert.equal(summarizeEffect(sent, "USD").unknown, "What part of this cost isn't known yet.")
  })

  it("keeps a known cost, even a known cost of nothing", () => {
    assert.equal(describeEffect(effect([known], leg(-ETH)), "USD"), "Sent out with $3,000.00 of known cost, so no gain or loss")
    const free = effect([leg(ETH, { costMicros: "0", costLabel: "paid" })], leg(-ETH))
    assert.equal(describeEffect(free, "USD"), "Sent out with $0.00 of known cost, so no gain or loss")
    assert.equal(summarizeEffect(free, "USD").unknown, null)
  })

  it("still says what's short never arrived, which no question can answer", () => {
    const { unknown: says, answerable } = summarizeEffect(effect([], leg(-ETH)), "USD")
    assert.equal(says, "1 ETH more left than we saw arrive, so what it cost isn't known.")
    assert.equal(answerable, false)
  })

  it("says about when what it sold for or carried is an estimate", () => {
    const market = leg(ETH, { costMicros: "3000000000", costLabel: "received at market", estimated: true })
    assert.match(describeEffect(effect([market], leg(-ETH)), "USD"), /^Sent out with about \$3,000\.00 of known cost/)
    const sold = effect([market], leg(-ETH, { kind: "swap", proceedsMicros: "4000000000", estimated: true }))
    assert.match(describeEffect(sold, "USD"), /^Sold for about \$4,000\.00, realized about \+\$1,000\.00/)
    assert.equal(summarizeEffect(sold, "USD").summary, "Sold about $4,000.00 of ETH, about a $1,000.00 gain.")
    assert.equal(summarizeEffect(effect([], leg(ETH, { priceSource: "market" })), "USD").summary, "Received about $3,000.00 of ETH.")
  })
})
