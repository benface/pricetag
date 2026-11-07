import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { after, before, describe, it } from "node:test"
import { ASSETS, CURRENCIES, CURRENCY_CODES, ETH_ADDRESS, ETH_USD_FEED, KNOWN_CONTRACTS, LAST_2S_BLOCK, PRICE_NOTES, TOKENS, TOKEN_FEEDS, USDC_ADDRESS, USDC_USD_FEED, WETH_ADDRESS, applyLeg, blockBefore, effectOf, buildPricedLegs, chartMoneyTicks, derivePricedRows, emptyPosition, formatChartSpan, msBetweenBlocks, encodeNote, foldPositions, pnlOverTime, referenceMarks, formatAmount, formatDuration, formatExactUsd, formatMoney, formatPaid, formatPrice, formatReturn, formatSignedAmount, formatSignedMoney, labelUsd, plainAmount, sumTotals, type LegRow, type Method, type PricedLeg } from "@pricetag/sdk/core"
import type { ExplanationResponse, PortfolioResponse, WalletResponse } from "../src/core/api.ts"
import { END_LABEL_GAP, TICK_GAP, chartLeftMargin, chartRightMargin, placeChartTimes } from "../src/core/chart-times.ts"
import { describeEffect, describeNetting, summarizeEffect } from "../src/core/explain.ts"
import { DEMO_WALLET, demoRates } from "../src/core/fixtures.ts"
import { failureOf, readResponse, type ReadFailure } from "../src/core/read-failure.ts"
import * as wording from "../src/core/wording.ts"
import { createApi } from "../server/app.ts"
import { compareRules, explainPortfolio, parseExplainTarget, portfolioOf } from "../src/core/portfolio.ts"
import { emptyBook } from "../src/core/book.ts"
import { foldBook, microsOf } from "../src/core/resolve.ts"
import { PRESET_FIAT } from "../server/coinbase.ts"
import { RULE_TEXT, differenceOf, ruleNote, showRuleDifference, showRuleValue, whySentence, type RuleComparison } from "../src/core/rules.ts"
import { proofOf, verificationOf } from "../server/proof.ts"
import { assertMatchesFixture } from "./support/fixtures.ts"
import { NO_FACTS } from "../src/core/activity.ts"

describe("the hot wallet's allowlist", () => {
  it("matches what the Swift package has compiled in", () => {
    // When this one changes, Tokens.swift or KnownContracts.swift has to change to match.
    assertMatchesFixture("tokens.json", { tokens: TOKENS.map(({ address, symbol, decimals, asset, sanity }) => ({ address, symbol, decimals, asset, sanity })), ethUsdFeed: ETH_USD_FEED.toLowerCase(), usdcUsdFeed: USDC_USD_FEED.toLowerCase(), feeds: TOKEN_FEEDS, contracts: KNOWN_CONTRACTS }, new URL("../macos/HotWalletKit/Tests/HotWalletKitTests/Resources/", import.meta.url))
  })
})

/** Balances that match whatever legs it's given, so a test about something else isn't also a test of a mismatch. */
function balancesOf(legs: WalletResponse["legs"], blockNum: number): WalletResponse["balances"] {
  const amounts: Record<string, string> = {}
  for (const leg of legs) amounts[leg.asset] = (BigInt(amounts[leg.asset] ?? 0) + BigInt(leg.delta)).toString()
  return { blockNum, amounts }
}

const walletWith = (changes: Partial<WalletResponse>): WalletResponse => ({
  ...DEMO_WALLET,
  ...(changes.legs ? { balances: balancesOf(changes.legs, DEMO_WALLET.coverage.toBlock) } : {}),
  ...changes,
})

describe("portfolioOf", () => {
  it("returns exactly what the browser's fold gives", () => {
    for (const method of ["average", "fifo"] as const) {
      const { positions, totals } = foldBook(DEMO_WALLET, [], method, emptyBook())
      const portfolio = portfolioOf(DEMO_WALLET, method)
      assert.deepEqual(portfolio.totals, totals)
      assert.deepEqual(portfolio.positions.map((p) => p.values), positions.map((p) => p.values))
      assert.equal(portfolio.method, method)
    }
  })

  it("never gives a position a PnL when part of it is unknown", () => {
    const portfolio = portfolioOf(DEMO_WALLET, "average")
    const position = (asset: string) => portfolio.positions.find((p) => p.asset === asset)
    assert.equal(position("USDC")?.pnlMicros, null)
    assert.equal(position("cbBTC")?.pnlMicros, null)
    assert.equal(position("DEGEN")?.pnlMicros, null, "DEGEN has no market at all")
  })

  it("carries each position's check, and leaves what doesn't match out of the chart too", () => {
    const portfolio = portfolioOf(DEMO_WALLET, "average")
    const cbBtc = portfolio.positions.find((p) => p.asset === "cbBTC")!
    assert.equal(cbBtc.reconciliation?.status, "incomplete")
    assert.equal(cbBtc.pnlMicros, null)
    assert.ok(portfolio.totals.excluded.some((e) => e.asset === "cbBTC" && e.reason === "doesn't match its actual balance"))
    assert.ok(portfolio.points.at(-1)!.excludedCount > 0)
    assert.equal(portfolio.points.at(-1)!.pnlMicros, portfolio.totals.pnlMicros)
    assert.equal(portfolio.positions.find((p) => p.asset === "USDC")!.reconciliation?.status, "reconciled")
  })

  it("explains the check, and marks an opening balance so it isn't linked as a transaction", () => {
    const check = explainPortfolio(DEMO_WALLET, "average", { kind: "asset", asset: "cbBTC", metric: "onchain" })!
    assert.equal(check.value, "⚠ Doesn't match")
    assert.match(check.lines.join(" "), /Difference/)
    const dai = explainPortfolio(DEMO_WALLET, "average", { kind: "asset", asset: "DAI", metric: "amount" })!
    assert.deepEqual(dai.legs.map((l) => [l.opening, l.txHash]), [[true, ""]])
  })

  it("explains an average price that isn't known, instead of leaving it out", () => {
    const dai = explainPortfolio(DEMO_WALLET, "average", { kind: "asset", asset: "DAI", metric: "average" })!
    assert.equal(dai.title, "DAI: Average price paid")
    assert.equal(dai.value, null)
    assert.match(dai.lines.join(" "), /unknown cost, so there's no average/)
  })

  it("explains a price and a return, and a return with an unknown cost is unknown, not 0%", () => {
    const aero = portfolioOf(DEMO_WALLET, "average").positions.find((p) => p.asset === "AERO")!
    assert.equal(aero.returnBps, "1202")
    const aeroReturn = explainPortfolio(DEMO_WALLET, "average", { kind: "asset", asset: "AERO", metric: "return" })!
    assert.equal(aeroReturn.title, "AERO: Return")
    assert.equal(aeroReturn.value, "≈+12.0%")
    assert.match(aeroReturn.lines.join(" "), /≈\+\$75\.13 unrealized ÷ ≈?\$624\.88 cost/)
    const daiReturn = explainPortfolio(DEMO_WALLET, "average", { kind: "asset", asset: "DAI", metric: "return" })!
    assert.equal(daiReturn.value, null)
    assert.match(daiReturn.lines.join(" "), /unknown cost, so there's no return/)
    const price = explainPortfolio(DEMO_WALLET, "average", { kind: "asset", asset: "AERO", metric: "price" })!
    assert.equal(price.title, "AERO: Price")
    assert.equal(price.value, "≈$1.40")
    assert.match(price.lines[0] as string, /^Current price: \$1\.40/)
    for (const metric of ["price", "return"]) assert.deepEqual(parseExplainTarget(new URLSearchParams({ asset: "AERO", metric })), { kind: "asset", asset: "AERO", metric })
  })

  it("says the total is partial when it leaves something out", () => {
    const portfolio = portfolioOf(DEMO_WALLET, "average")
    assert.equal(portfolio.pnlStatus, "partial")
    assert.ok(portfolio.totals.excluded.length > 0)
  })

  it("says the total is unavailable when nothing in it is known", () => {
    const onlyUnknown = DEMO_WALLET.legs.filter((l) => l.asset === "cbBTC")
    const portfolio = portfolioOf(walletWith({ legs: onlyUnknown }), "average")
    assert.equal(portfolio.totals.pnlMicros, null)
    assert.equal(portfolio.pnlStatus, "unavailable")
    assert.deepEqual(portfolio.points.map((p) => p.pnlMicros), [null, null])
  })

  it("says the total is partial when gas couldn't be worked out, even with nothing excluded", () => {
    const portfolio = portfolioOf(walletWith({ legs: [], gasUnknownTxs: ["0xabc"] }), "average")
    assert.equal(portfolio.totals.excluded.length, 0)
    assert.equal(portfolio.pnlStatus, "partial")
  })

  it("treats a known zero as an answer", () => {
    const portfolio = portfolioOf(walletWith({ legs: [] }), "average")
    assert.equal(portfolio.totals.pnlMicros, "0")
    assert.equal(portfolio.pnlStatus, "complete")
  })

  it("keeps the demo's early unknown points unknown, and explains them that way", () => {
    const portfolio = portfolioOf(DEMO_WALLET, "average")
    const first = portfolio.points[0]
    assert.equal(first?.pnlMicros, null)
    const explanation = explainPortfolio(DEMO_WALLET, "average", { kind: "tx", txHash: first?.txHash as string })
    assert.equal(explanation?.value, null)
    assert.ok(portfolio.points.some((p) => p.pnlMicros !== null))
  })

  it("gives no PnL to a position whose history is incomplete", () => {
    const leg = DEMO_WALLET.legs.find((l) => l.asset === "AERO" && BigInt(l.delta) > 0n) as (typeof DEMO_WALLET.legs)[number]
    const out = { ...leg, id: "out", delta: `-${BigInt(leg.delta) * 2n}`, kind: "transfer" as const, costMicros: null, proceedsMicros: null }
    const position = portfolioOf(walletWith({ legs: [leg, out] }), "average").positions[0]
    assert.ok(BigInt(position?.shortfallQty ?? "0") > 0n)
    assert.equal(position?.pnlMicros, null)
  })

  it("says how far what's read is behind the chain", () => {
    const at = (toBlock: number, fromBlock = 100) => portfolioOf(walletWith({ legs: [], coverage: { fromBlock, toBlock }, latest: { blockNum: 200, timestamp: DEMO_WALLET.latest.timestamp } }), "average").progress
    assert.deepEqual(at(199), { started: true, behindBlocks: 0 })
    assert.deepEqual(at(150), { started: true, behindBlocks: 50 })
    assert.deepEqual(at(99), { started: false, behindBlocks: 101 })
  })

  it("only calls it behind past 30 seconds, so one slow read at normal lag doesn't", () => {
    const head = LAST_2S_BLOCK + 1000
    const behindBy = (blocks: number) => portfolioOf(walletWith({ legs: [], coverage: { fromBlock: LAST_2S_BLOCK, toBlock: head - blocks }, latest: { blockNum: head, timestamp: DEMO_WALLET.latest.timestamp } }), "average").progress.behindBlocks
    assert.equal(behindBy(86), 0, "17.2 s, the slowest read measured at normal lag")
    assert.equal(behindBy(150), 0, "30 s")
    assert.equal(behindBy(151), 151, "30.2 s")
  })

  it("keeps a closed position's realized PnL, with nothing unrealized to add", () => {
    const eth = DEMO_WALLET.legs.filter((l) => l.asset === "ETH").slice(0, 1)
    const closing = { ...eth[0], id: "closing", delta: `-${eth[0]?.delta}`, kind: "transfer" as const } as (typeof eth)[number]
    const portfolio = portfolioOf(walletWith({ legs: [...eth, closing] }), "average")
    assert.equal(portfolio.positions[0]?.values.qty, "0")
    assert.equal(portfolio.positions[0]?.pnlMicros, "0")
  })

  it("doesn't explain a total with nothing known in it as $0", () => {
    const wallet = walletWith({ legs: DEMO_WALLET.legs.filter((l) => l.asset === "cbBTC") })
    const pnl = explainPortfolio(wallet, "average", { kind: "total", metric: "pnl" })
    assert.equal(pnl?.value, null)
    assert.ok(pnl?.lines.every((line) => !line.includes("$0.00 ")))
    assert.ok(pnl?.lines.some((line) => line.includes("Not included: cbBTC")))
    assert.equal(explainPortfolio(wallet, "average", { kind: "total", metric: "unrealized" })?.value, null)
  })

  it("still explains a total that's only partial, with its value", () => {
    assert.equal(explainPortfolio(DEMO_WALLET, "average", { kind: "total", metric: "pnl" })?.value, "≈+$149.30")
  })

  it("leads each movement with a plain sentence in money, and says what isn't known", () => {
    const legs = (asset: string) => explainPortfolio(DEMO_WALLET, "average", { kind: "asset", asset, metric: "realized" })?.legs.map(({ summary, unknown }) => [summary, unknown]) ?? []
    assert.deepEqual(legs("AERO"), [
      ["Sold $449.91 of AERO, a $74.99 gain.", null],
      ["Bought $999.80 of AERO.", null],
    ])
    const eth = legs("ETH")
    assert.ok(eth.some(([summary, unknown]) => summary === "Sold $1,299.74 of ETH, a $98.02 gain on part of it." && unknown === "The gain on 0.00978 ETH isn't known, because what it cost isn't known yet."))
    assert.ok(eth.some(([summary]) => summary === "Paid $0.10 in network fees."))
    assert.ok(eth.some(([summary, unknown]) => summary === "Received $47.84 of ETH." && unknown === "What this cost isn't known yet."))
    // Money after "Bought" would read as what was paid, which isn't known here.
    assert.deepEqual(legs("VIRTUAL"), [["Bought 50 VIRTUAL, worth about $105.00.", "What this cost isn't known yet."]])
  })

  describe("says what's actually missing when a gain isn't known", () => {
    const ETH = 10n ** 18n
    const PRICE = "2000000000"
    const leg = (delta: bigint, extra: Partial<PricedLeg> = {}) => ({ id: "leg", asset: "ETH", decimals: 18, delta: delta.toString(), kind: "swap", priceMicros: PRICE, costMicros: null, proceedsMicros: null, costLabel: "unknown", ...extra }) as PricedLeg
    const bought = leg(ETH, { costMicros: "2000000000", costLabel: "paid" })
    const unknownCost = leg(ETH, { kind: "transfer" })
    const sold = { proceedsMicros: "1000000000" }
    /** What the last leg says, after the ones before it. */
    const saysIn = (method: Method, legs: PricedLeg[]) => {
      const last = legs.at(-1) as PricedLeg
      const before = legs.slice(0, -1).reduce(applyLeg, emptyPosition(method, 18))
      const { unknown, answerable } = summarizeEffect(effectOf(last, before, applyLeg(before, last)), "USD")
      return [unknown, answerable]
    }
    const says = (...legs: PricedLeg[]) => saysIn("average", legs)

    it("on a sale", () => {
      assert.deepEqual(says(unknownCost, leg(-ETH / 2n, sold)), ["The gain on 0.5 ETH isn't known, because what it cost isn't known yet.", true])
      assert.deepEqual(says(bought, leg(-ETH / 2n)), ["The gain on 0.5 ETH isn't known, because what you received has no usable value.", false], "and no question about its cost can fix that")
      assert.deepEqual(says(unknownCost, leg(-ETH / 2n)), ["The gain on 0.5 ETH isn't known, because what it cost isn't known yet, and what you received has no usable value.", true])
    })

    it("on a network fee", () => {
      const fee = (extra: Partial<PricedLeg> = {}) => leg(-ETH / 2n, { kind: "gas", ...extra })
      assert.deepEqual(says(unknownCost, fee()), ["The gain on 0.5 ETH isn't known, because what it cost isn't known yet.", true])
      assert.deepEqual(says(bought, fee({ priceMicros: null })), ["The gain on 0.5 ETH isn't known, because it has no price at this block.", false])
      assert.deepEqual(says(unknownCost, fee({ priceMicros: null })), ["The gain on 0.5 ETH isn't known, because what it cost isn't known yet, and it has no price at this block.", true])
    })

    it("when only some of it is missing a cost", () => {
      const half = leg(ETH / 2n, { kind: "transfer" })
      const paid = leg(ETH / 2n, { costMicros: "1000000000", costLabel: "paid" })
      assert.deepEqual(saysIn("fifo", [paid, half, leg(-ETH)]), ["The gain on 1 ETH isn't known, because what some of it cost isn't known yet, and what you received has no usable value.", true])
    })

    it("when more left than arrived, which no question is about", () => {
      assert.deepEqual(says(bought, leg(-ETH * 2n, { proceedsMicros: "4000000000" })), ["The gain on 1 ETH isn't known, because 1 ETH more left than we saw arrive.", false])
      assert.deepEqual(says(unknownCost, leg(-ETH * 2n)), ["The gain on 2 ETH isn't known, because 1 ETH more left than we saw arrive, and what some of it cost isn't known yet, and what you received has no usable value.", true])
      assert.deepEqual(says(bought, leg(-ETH * 2n, { kind: "transfer" })), ["1 ETH more left than we saw arrive, so what it cost isn't known.", false], "a transfer has no gain to talk about")
    })

    it("and offers no question where nobody can answer", () => {
      assert.deepEqual(says(leg(ETH, { kind: "transfer", orderUnknown: "always" })), ["What this cost isn't known yet.", false])
      assert.deepEqual(says(leg(ETH, { kind: "transfer", unsettledCredit: true })), ["What this cost isn't known yet.", false])
      assert.deepEqual(says(unknownCost), ["What this cost isn't known yet.", true])
      assert.deepEqual(says(unknownCost, leg(-ETH / 2n, { ...sold, orderUnknown: "always" })), ["The gain on 0.5 ETH isn't known, because what it cost isn't known yet.", false])
    })

    it("and offers no question on what's spent after an unknown order, by either method", () => {
      for (const method of ["fifo", "average"] as const) {
        const unknownOrder = leg(-ETH / 2n, { ...sold, orderUnknown: "always" })
        assert.deepEqual(saysIn(method, [unknownCost, unknownOrder, leg(-ETH / 4n, sold)]), ["The gain on 0.25 ETH isn't known, because what it cost isn't known yet.", false])
        assert.deepEqual(saysIn(method, [bought, unknownOrder, leg(-ETH / 4n, sold)]), ["The gain on 0.25 ETH isn't known, because what it cost isn't known yet.", false])
        assert.deepEqual(saysIn(method, [unknownCost, leg(-ETH / 4n, { kind: "transfer", orderUnknown: "always" }), leg(-ETH / 4n, { kind: "transfer" })]), ["What this cost isn't known yet.", false])
      }
    })
  })

  it("matches the files the Swift package reads", () => {
    assertMatchesFixture("demo-portfolio.json", portfolioOf(DEMO_WALLET, "average"))
    assertMatchesFixture("demo-explanation.json", explainPortfolio(DEMO_WALLET, "average", { kind: "asset", asset: "AERO", metric: "realized" }))
    const inCad = walletWith({ currency: "CAD", rates: demoRates("CAD") })
    assertMatchesFixture("demo-portfolio-cad.json", portfolioOf(inCad, "average"))
    assertMatchesFixture("demo-explanation-cad.json", explainPortfolio(inCad, "average", { kind: "asset", asset: "AERO", metric: "realized" }))
    assertMatchesFixture("demo-hold-explanation.json", explainPortfolio(DEMO_WALLET, "average", { kind: "hold" }))
    const leg = DEMO_WALLET.legs.find(({ priceSource, kind }) => priceSource === "swap" && kind === "swap") as PricedLeg
    const dataset = { title: "Base's blocks", name: "edgeandnode/base_mainnet@0.0.2", hash: "6428aaca2cf57b8403ca3ab8bc657b361926ce6beeb6577477c85684e6ea569e" }
    assertMatchesFixture("proof.json", proofOf(leg, DEMO_WALLET.legs, "USD", [dataset, { ...dataset, name: "a/b@1", hash: null }], null))
    assertMatchesFixture("demo-proof.json", proofOf(leg, DEMO_WALLET.legs, "USD", [], "This is the demo wallet, so there's no real block to check."))
    const fixture = JSON.parse(readFileSync(new URL("./support/base-blocks.json", import.meta.url), "utf8"))
    assertMatchesFixture("verification.json", verificationOf({ ...leg, blockNum: 9200017, txHash: `0x${fixture.block.txs[1].tx_hash}`, parts: [] }, [], fixture.block, new Map(Object.entries(fixture.deposits)), null, fixture.block.block.hash))
    assertMatchesFixture("verification-failed.json", verificationOf({ ...leg, blockNum: 9200017, parts: [] }, [], { ...fixture.block, logs: [] }, null))
  })
})

describe("what the value chart can join", () => {
  const ME = "0x00000000000000000000000000000000000000aa"
  const minute = (m: number) => new Date(Date.UTC(2026, 10, 4, 0, m)).toISOString()
  const move = (m: number, tx: string, token: string, amount: bigint, kind: LegRow["kind"] = token === ETH_ADDRESS ? "eth" : "erc20"): LegRow => ({ block_num: m, timestamp: minute(m), tx_hash: tx, tx_index: 1, log_index: 0, token, account: ME, side: "credit", amount: amount.toString(), kind })
  const pointsOf = (rows: LegRow[], blocks: { blockNum: number; ethUsd: string | null; usdcUsd: string | null }[], last: number) => {
    const references = blocks as Parameters<typeof buildPricedLegs>[0]["references"]
    const legs = buildPricedLegs({ account: ME, rows, references, priced: derivePricedRows(rows, references) })
    const prices = { ETH: { micros: "2000000000", source: "oracle" as const, blockNum: last }, USDC: { micros: "1000000", source: "oracle" as const, blockNum: last } }
    return pnlOverTime(legs, "average", prices, referenceMarks(references), { blockNum: last, timestamp: minute(last) })
  }
  const ETH = 10n ** 18n
  const DOLLAR = 10n ** 6n
  const constant = (blockNum: number) => ({ blockNum, ethUsd: "200000000000", usdcUsd: "100000000" })

  const unnamedEth = pointsOf(
    [move(0, "0x1", ETH_ADDRESS, ETH), move(20, "0x2", USDC_ADDRESS, DOLLAR), move(60, "", ETH_ADDRESS, ETH, "unseen_eth"), move(120, "0x3", USDC_ADDRESS, DOLLAR)],
    [0, 20, 60, 120].map(constant),
    150,
  )
  // Each point leaves out one holding, and not the same one.
  const differentOmissions = pointsOf(
    [move(0, "0x1", ETH_ADDRESS, ETH), move(10, "0x2", USDC_ADDRESS, 100n * DOLLAR), move(20, "0x3", ETH_ADDRESS, ETH / 2n), move(30, "0x4", USDC_ADDRESS, DOLLAR)],
    [constant(0), { ...constant(10), ethUsd: null }, { ...constant(20), usdcUsd: null }, constant(30)],
    40,
  )

  it("doesn't join across ETH that arrived with no transaction, and adds no point for it, so PnL's stay as they were", () => {
    assert.deepEqual(unnamedEth.map((p) => p.txHash), ["0x1", "0x2", "0x3", null])
    assert.deepEqual(unnamedEth.map((p) => p.valueContinues), [false, true, false, true])
    assert.equal(unnamedEth[2]!.valueBeforeMicros, "4001000000")
    assert.equal(unnamedEth[1]!.valueMicros, "2001000000")
  })

  it("doesn't join points that leave out different holdings, even when it's as many of them", () => {
    assert.deepEqual(differentOmissions.slice(1, 3).map((p) => [p.valueExcludedCount, p.valueMicros]), [[1, "100000000"], [1, "3000000000"]])
    assert.equal(differentOmissions[2]!.valueBeforeMicros, "2000000000")
    assert.deepEqual(differentOmissions.map((p) => p.valueContinues), [false, false, false, false, true])
  })

  it("matches the file the Swift package reads", () => {
    // As the server sends them: a point with no facts of its own still says so.
    const sent = (points: typeof unnamedEth) => points.map((point) => ({ ...point, ...NO_FACTS }))
    assertMatchesFixture("value-breaks.json", { unnamedEth: sent(unnamedEth), differentOmissions: sent(differentOmissions) })
  })

  describe("with prices read between transactions", () => {
    const held = [move(0, "0x1", ETH_ADDRESS, ETH), move(100, "0x2", USDC_ADDRESS, DOLLAR)]
    const at = (blockNum: number, ethUsd = "200000000000") => ({ ...constant(blockNum), ethUsd })
    const sampled = (rows: LegRow[], blocks: ReturnType<typeof constant>[], samples: number[], last = 150) => {
      const legs = buildPricedLegs({ account: ME, rows, references: blocks, priced: derivePricedRows(rows, blocks) })
      const prices = { ETH: { micros: "2000000000", source: "oracle" as const, blockNum: last }, USDC: { micros: "1000000", source: "oracle" as const, blockNum: last } }
      return pnlOverTime(legs, "average", prices, referenceMarks(blocks), { blockNum: last, timestamp: minute(last) }, new Set(), new Set(), samples)
    }

    it("adds a point with no transaction, at that moment's prices, and the stretches around it are known", () => {
      const points = sampled(held, [at(0), at(50, "300000000000"), at(100)], [50])
      assert.deepEqual(points.map((p) => [p.blockNum, p.txHash]), [[0, "0x1"], [50, null], [100, "0x2"], [150, null]])
      assert.equal(points[1]!.valueMicros, "3000000000")
      assert.equal(points[1]!.timestamp, new Date(Date.parse(minute(150)) - 100 * 2000).toISOString(), "worked out from the last block")
      assert.deepEqual(points.map((p) => p.valueRead), [undefined, true, true, true])
    })

    it("leaves what PnL says alone, and the same at every transaction", () => {
      const references = [at(0), at(50, "300000000000"), at(100)]
      const points = sampled(held, references, [50])
      const without = sampled(held, references, [])
      assert.equal(points[1]!.pnlMicros, points[0]!.pnlMicros)
      assert.equal(points[1]!.excludedCount, points[0]!.excludedCount)
      assert.deepEqual(points.filter((p) => p.blockNum !== 50).map((p) => [p.txHash, p.pnlMicros, p.valueMicros, p.valueBeforeMicros]), without.map((p) => [p.txHash, p.pnlMicros, p.valueMicros, p.valueBeforeMicros]))
    })

    it("calls no stretch read when nothing was sampled", () => {
      assert.ok(sampled(held, [at(0), at(100)], []).every((p) => p.valueRead === undefined))
    })

    it("adds no point where something held has no price, and that stretch stays a guess", () => {
      const points = sampled(held, [at(0), { ...at(50), ethUsd: "" }, at(70), at(100)], [50, 70])
      assert.deepEqual(points.map((p) => p.blockNum), [0, 70, 100, 150])
      assert.deepEqual(points.map((p) => p.valueRead), [undefined, undefined, true, true], "from the transaction to the first price it could read")
    })

    describe("after a transaction with no price", () => {
      const ethOnly = [move(0, "0x1", ETH_ADDRESS, ETH)]
      const unpriced = (blockNum: number) => ({ ...at(blockNum), ethUsd: "" })

      it("starts again at the first sample that knows it, from nothing known", () => {
        const points = sampled(ethOnly, [unpriced(0), at(50), at(70), at(100)], [50, 70, 100])
        assert.deepEqual(points.map((p) => [p.blockNum, p.valueMicros === null, p.valueContinues, p.valueRead]), [[0, true, false, undefined], [50, false, false, undefined], [70, false, true, true], [100, false, true, true], [150, false, true, true]])
      })

      it("starts again from part of it known, without joining the two", () => {
        const points = sampled(held, [at(0), unpriced(100), at(110), at(120)], [110, 120])
        assert.deepEqual(points.map((p) => [p.blockNum, p.valueExcludedCount, p.valueContinues, p.valueRead]), [[0, 0, false, undefined], [100, 1, false, undefined], [110, 0, false, undefined], [120, 0, true, true], [150, 0, true, true]])
        assert.equal(points[2]!.valueMicros, "2001000000")
      })

      it("carries on into the next transaction", () => {
        const points = sampled([...ethOnly, move(90, "0x2", USDC_ADDRESS, DOLLAR)], [unpriced(0), at(50), at(90)], [50])
        assert.deepEqual(points.map((p) => [p.blockNum, p.valueContinues, p.valueRead]), [[0, false, undefined], [50, false, undefined], [90, true, true], [150, true, true]])
      })

      it("skips one that only leaves out something else, which it can't start from", () => {
        const points = sampled(held, [at(0), unpriced(100), { ...at(110), usdcUsd: "" }, at(120)], [110, 120])
        assert.deepEqual(points.map((p) => p.blockNum), [0, 100, 120, 150])
        assert.equal(points[2]!.valueContinues, false)
      })

      it("still leaves out what's left out at every price", () => {
        const points = pnlOverTime(buildPricedLegs({ account: ME, rows: held, references: [at(0), at(100)], priced: derivePricedRows(held, [at(0), at(100)]) }), "average", {}, referenceMarks([at(0), unpriced(100), at(110)]), { blockNum: 150, timestamp: minute(150) }, new Set(["USDC"]), new Set(), [110])
        assert.deepEqual(points.map((p) => [p.blockNum, p.valueExcludedCount, p.valueContinues]), [[0, 1, false], [100, 2, false], [110, 1, false], [150, 2, false]])
      })
    })

    it("keeps a sample that leaves out what the point before already left out", () => {
      const unpriced = [{ ...at(0), ethUsd: "" }, { ...at(50), ethUsd: "" }, { ...at(100), ethUsd: "" }]
      const points = sampled(held, unpriced, [50])
      assert.deepEqual(points.map((p) => p.valueExcludedCount), [1, 1, 1, 0])
      assert.equal(points[1]!.txHash, null)
      assert.equal(points[1]!.valueRead, true)
    })

    it("still breaks at ETH that arrived with no transaction, and is back to known after that", () => {
      const rows = [...held, move(120, "", ETH_ADDRESS, ETH, "unseen_eth")]
      const points = sampled(rows, [at(0), at(100), at(120), at(130), at(140)], [130, 140])
      assert.deepEqual(points.map((p) => [p.blockNum, p.valueContinues, p.valueRead]), [[0, false, undefined], [100, true, true], [130, false, undefined], [140, true, true], [150, true, true]])
    })

    it("has nothing to join before the first transaction, or to add at the last point's own block", () => {
      const points = sampled([move(50, "0x1", ETH_ADDRESS, ETH)], [at(10), at(50), at(150)], [10, 150])
      assert.deepEqual(points.map((p) => [p.blockNum, p.txHash]), [[50, "0x1"], [150, null]])
    })

    it("comes after every transaction in its own block", () => {
      const points = sampled([move(50, "0x1", ETH_ADDRESS, ETH), move(50, "0x2", USDC_ADDRESS, DOLLAR)], [at(50)], [50])
      assert.deepEqual(points.map((p) => [p.blockNum, p.txHash]), [[50, "0x1"], [50, "0x2"], [50, null], [150, null]])
    })
  })
})

describe("parseExplainTarget", () => {
  const parse = (query: string) => parseExplainTarget(new URLSearchParams(query))

  it("reads totals, assets and transactions", () => {
    assert.deepEqual(parse("metric=gas"), { kind: "total", metric: "gas" })
    assert.deepEqual(parse("asset=ETH&metric=average"), { kind: "asset", asset: "ETH", metric: "average" })
    assert.deepEqual(parse("tx=0xABC"), { kind: "tx", txHash: "0xabc" })
  })

  it("refuses a metric that doesn't go with what's asked", () => {
    assert.equal(parse("metric=amount"), null)
    assert.equal(parse("asset=ETH&metric=gas"), null)
    assert.equal(parse(""), null)
  })
})

describe("the portfolio API", () => {
  let server: Server
  let base: string

  before(async () => {
    const handle = createApi({})
    server = createServer((req, res) => void handle(req, res))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(() => server.close())

  const get = async (path: string) => {
    const response = await fetch(base + path)
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }

  it("serves the fixtures with no Amp set up", async () => {
    const { status, body } = await get("/api/portfolio/demo?method=fifo")
    assert.equal(status, 200)
    const portfolio = body as unknown as PortfolioResponse
    assert.equal(portfolio.mode, "demo")
    assert.equal(portfolio.method, "fifo")
    assert.deepEqual(portfolio, JSON.parse(JSON.stringify(portfolioOf(DEMO_WALLET, "fifo"))))
  })

  it("defaults to average cost", async () => {
    assert.equal((await get("/api/portfolio/demo")).body.method, "average")
  })

  it("explains a number, with its legs, price source and transaction", async () => {
    const { status, body } = await get("/api/portfolio/demo/explain?asset=ETH&metric=realized")
    assert.equal(status, 200)
    const explanation = body as unknown as ExplanationResponse
    assert.equal(explanation.title, "ETH: Realized PnL")
    assert.equal(explanation.legCount, explanation.legs.length)
    const leg = explanation.legs[0]
    assert.match(leg?.txHash ?? "", /^0x/)
    assert.ok(leg?.effect)
    assert.ok(explanation.legs.some((l) => l.priceSource === "oracle"))
  })

  it("explains a transaction", async () => {
    const txHash = DEMO_WALLET.legs.find((l) => !l.opening)?.txHash as string
    const { status, body } = await get(`/api/portfolio/demo/explain?tx=${txHash}`)
    assert.equal(status, 200)
    assert.ok((body as unknown as ExplanationResponse).legs.every((l) => l.txHash === txHash))
  })

  it("answers with what's wrong", async () => {
    assert.equal((await get("/api/portfolio/nope")).status, 400)
    assert.equal((await get("/api/portfolio/demo?linked=nope")).status, 400)
    assert.equal((await get(`/api/portfolio/demo?linked=${Array(11).fill("0x0000000000000000000000000000000000000001").join(",")}`)).status, 400)
    assert.equal((await get("/api/portfolio/demo?method=lifo")).status, 400)
    assert.equal((await get("/api/portfolio/demo/explain?metric=nope")).status, 400)
    assert.equal((await get("/api/portfolio/demo/explain?asset=NOPE&metric=value")).status, 404)
    assert.equal((await get("/api/portfolio/demo/explain?tx=0x00")).status, 404)
  })

  it("doesn't pass fixtures off as a real wallet when there's no Amp", async () => {
    const { status, body } = await get("/api/portfolio/0x0000000000000000000000000000000000000001")
    assert.equal(status, 503)
    assert.match(String(body.error), /only the demo wallet/)
  })

  const post = async (path: string, body: unknown, contentType = "application/json") => {
    const response = await fetch(base + path, { method: "POST", headers: { "content-type": contentType }, body: JSON.stringify(body) })
    const text = await response.text()
    return { status: response.status, text, body: (response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : {}) as Record<string, unknown> }
  }
  const SAVINGS = "0x00000000000000000000000000000000000de301"
  const mine = { senders: { [SAVINGS]: { kind: "mine" } }, costs: {}, withdrawals: [] }

  it("folds with the answers it's sent, and keeps none of them", async () => {
    const answered = (await post("/api/portfolio/demo", { method: "average", book: mine })).body as unknown as PortfolioResponse
    assert.ok(answered.questions.some((q) => q.wallet === SAVINGS))
    assert.deepEqual(answered.linkedReading, [])
    const without = (await get("/api/portfolio/demo")).body as unknown as PortfolioResponse
    assert.ok(!without.questions.some((q) => q.wallet === SAVINGS), "the next request knows nothing about it")
  })

  it("has nothing waiting or failing on the book the Mac sends for the demo, with its accounts left out", async () => {
    const macBook = { senders: { [SAVINGS]: { kind: "mine" } } }
    const account = "0x000000000000000000000000000000000000aaaa"
    // `linked` is the one thing a client sends that the demo ignores outright.
    const portfolio = (await post("/api/portfolio/demo", { method: "average", book: macBook, linked: [account] })).body as unknown as PortfolioResponse
    assert.deepEqual([portfolio.linkedReading, portfolio.linkedFailed, portfolio.meter.waiting], [[], [], 0])
    const { previews } = (await post("/api/portfolio/demo/preview", { method: "average", candidates: [macBook], linked: [account] })).body as { previews: { failed: boolean; pending: boolean }[] }
    assert.deepEqual(previews.map((p) => [p.failed, p.pending]), [[false, false]])
    const explained = (await post("/api/portfolio/demo/explain?asset=USDC&metric=amount", { method: "average", book: macBook, linked: [account] })).body as unknown as ExplanationResponse
    assert.ok(explained.legs.some((l) => l.costLabel === "inherited"), "it still inherits from its own savings wallet")
    assert.equal((await post("/api/portfolio/demo/export", { method: "average", book: macBook, linked: [account] })).status, 200)
  })

  it("folds linked wallets in the currency asked for", async () => {
    const { status, body } = await post("/api/portfolio/demo", { method: "average", currency: "CAD", book: mine })
    assert.equal(status, 200)
    assert.equal((body as unknown as PortfolioResponse).currency, "CAD")
    assert.equal((await post("/api/portfolio/demo", { method: "average", currency: "XYZ" })).status, 400)
  })

  it("previews what each answer would do, before any is final", async () => {
    const { body } = await post("/api/portfolio/demo/preview", { method: "average", book: {}, candidates: [{}, mine] })
    const [before, after] = body.previews as { unresolvedMicros: string; pending: boolean }[]
    assert.ok(BigInt(after!.unresolvedMicros) < BigInt(before!.unresolvedMicros))
    assert.equal(after!.pending, false)
  })

  it("doesn't wait on a wallet outside the demo, and asks what came from it cost instead", async () => {
    const coinbase = "0x71660c4005ba85c37ccec55d0c4493e66fe775d3"
    const book = { senders: { [coinbase]: { kind: "mine" } } }
    const { body } = await post("/api/portfolio/demo/preview", { method: "average", candidates: [book] })
    assert.deepEqual((body.previews as { failed: boolean; pending: boolean }[]).map((p) => [p.failed, p.pending]), [[false, false]])
    const portfolio = (await post("/api/portfolio/demo", { method: "average", book })).body as unknown as PortfolioResponse
    assert.deepEqual([portfolio.linkedReading, portfolio.linkedFailed, portfolio.meter.waiting], [[], [], 0])
    assert.ok(!portfolio.questions.some((q) => q.sender === coinbase), "answering it again wouldn't change anything")
    const card = portfolio.questions.find((q) => q.kind === "cost" && q.arrivals.some((a) => a.asset === "cbBTC"))
    assert.ok(card, "it's still unknown, so it asks")
    assert.match(card.evidence.join(), /the demo only reads its own wallets/)
    const paid = { ...book, costs: { [card.costKey as string]: { micros: "1000000", currency: "USD" } } }
    const after = (await post("/api/portfolio/demo", { method: "average", book: paid })).body as unknown as PortfolioResponse
    assert.ok(!after.questions.some((q) => q.id === card.id), "and what was paid settles it")
  })

  it("explains a number with the answers it's sent", async () => {
    const { status, body } = await post("/api/portfolio/demo/explain?asset=USDC&metric=amount", { method: "average", book: mine })
    assert.equal(status, 200)
    assert.ok((body as unknown as ExplanationResponse).legs.some((l) => l.costLabel === "inherited"))
  })

  it("exports a CSV", async () => {
    const { status, text } = await post("/api/portfolio/demo/export", { method: "average" })
    assert.equal(status, 200)
    assert.match(text, /^time,block,transaction/)
  })

  it("imports a Coinbase history without keeping it", async () => {
    const csv = "Timestamp,Transaction Type,Asset,Quantity Transacted,Spot Price Currency,Spot Price at Transaction,Subtotal,Total (inclusive of fees and/or spread),Fees and/or Spread,Notes\n2026-10-01T10:00:00Z,Buy,ETH,1,USD,$2000,$2000,$2000,$0,x\n2026-10-02T10:00:00Z,Send,ETH,1,USD,$2000,$2000,$2000,$0,x\n"
    const { status, body } = await post("/api/import/coinbase", { csv })
    assert.equal(status, 200)
    assert.equal((body.withdrawals as unknown[]).length, 1)
    assert.equal((await post("/api/import/coinbase", { csv: "nope" })).status, 400)
  })

  it("refuses a post that isn't JSON, so a page can't send one without asking", async () => {
    assert.equal((await post("/api/portfolio/demo", { method: "average" }, "text/plain")).status, 400)
  })

  it("refuses answers it can't read", async () => {
    assert.equal((await post("/api/portfolio/demo", { method: "average", book: { senders: { nope: {} } } })).status, 400)
    assert.equal((await post("/api/portfolio/demo", { method: "lifo" })).status, 400)
    assert.equal((await post("/api/portfolio/demo/preview", { method: "average", candidates: "x" })).status, 400)
    assert.equal((await post("/api/links/verify", { owner: "x" })).status, 400)
  })

  it("still serves the browser's wallet route", async () => {
    assert.equal((await get("/api/wallet/demo")).body.mode, "demo")
  })
})

describe("the formatters the Swift package repeats", () => {
  it("match the vectors it tests against", () => {
    const usd = ["0", "1", "1234", "9999", "10000", "1005000", "-1234", "-12340000", "2640000000", "1234567890123", "99999999", "999800"]
    const units: [string, number][] = [
      ["0", 18],
      ["1", 18],
      ["1000000000000000", 18],
      ["519000000000000000", 18],
      ["1234567890000000000", 18],
      ["-1234567890000000000", 18],
      ["1234567000000000000000", 18],
      ["2000000", 8],
      ["3349990000", 6],
      ["50000000000000000000000", 18],
      ["115792089237316195423570985008687907853269984665640564039457584007913129639935", 18],
    ]
    assertMatchesFixture("format-vectors.json", {
      usd: usd.map((micros) => ({ micros, usd: formatMoney(micros, "USD"), signed: formatSignedMoney(micros, "USD") })),
      cad: usd.map((micros) => ({ micros, usd: formatMoney(micros, "CAD"), signed: formatSignedMoney(micros, "CAD") })),
      price: usd.filter((micros) => !micros.startsWith("-") && micros !== "0").map((micros) => ({ micros, price: formatPrice(micros, "USD"), cad: formatPrice(micros, "CAD") })),
      others: CURRENCY_CODES.filter((currency) => currency !== "USD" && currency !== "CAD").map((currency) => ({
        currency,
        label: CURRENCIES[currency].label,
        paid: formatPaid("25810000", currency),
        money: usd.map((micros) => ({ micros, usd: formatMoney(micros, currency), signed: formatSignedMoney(micros, currency) })),
        price: usd.filter((micros) => !micros.startsWith("-") && micros !== "0").map((micros) => ({ micros, price: formatPrice(micros, currency) })),
        chartTicks: [[0], [-0.0023], [0.75], [120], [-250000, 1250000]].map((values) => ({ values, ticks: chartMoneyTicks(values, currency) })),
      })),
      exactUsd: ["0", "1", "1234", "500000", "1000000", "250000000", "1234500000", "1234567000", "1234567891", "1000000000000"].map((micros) => ({ micros, usd: formatExactUsd(micros) })),
      labeledUsd: ["$2,376.00", "+$24.00", "-$24.00", "$0.004", "-$0.004"].map((text) => ({ text, usd: labelUsd(text, "USD"), cad: labelUsd(text, "CAD") })),
      amount: units.map(([value, decimals]) => ({ units: value, decimals, amount: formatAmount(value, decimals), signed: formatSignedAmount(value, decimals) })),
      chartTicks: [[], [0], [-0.0023], [-0.0015, -0.0023], [0.000001], [-0.2], [0.75], [8.5], [-3, 12], [120], [1250], [8000], [-250000, 1250000], [12000000]].map((values) => ({ values, usd: chartMoneyTicks(values, "USD"), cad: chartMoneyTicks(values, "CAD") })),
      duration: [0, 60_000, 3_600_000, 7_198_000, 7_200_000, 10_800_000, 200_000_000].map((ms) => ({ ms, duration: formatDuration(ms) })),
      blockSpans: [[100, 130], [LAST_2S_BLOCK - 5, LAST_2S_BLOCK], [LAST_2S_BLOCK - 5, LAST_2S_BLOCK + 10], [LAST_2S_BLOCK, LAST_2S_BLOCK + 300], [LAST_2S_BLOCK + 5, LAST_2S_BLOCK + 305], [130, 100]].map(([from, to]) => ({ from, to, ms: msBetweenBlocks(from as number, to as number) })),
      blocksBefore: [[130, 60_000], [LAST_2S_BLOCK, 60_000], [LAST_2S_BLOCK + 10, 60_000], [LAST_2S_BLOCK + 300, 60_000], [LAST_2S_BLOCK + 301, 60_000], [LAST_2S_BLOCK + 300, 60_100], [10, 60_000]].map(([block, ms]) => ({ block, ms, before: blockBefore(block as number, ms as number) })),
      returns: ["0", "4", "5", "-4", "-5", "1", "-1", "1234", "-1234", "-10000", "99949", "99950", "-99950", "100000", "123456", "-123456", "10000000"].map((bps) => ({ bps, text: formatReturn(bps) })),
      plainAmount: ["46,20", "46,2", "0,5", "1 234,50", "1\u00a0234,50", "1\u202f234,50", "1,234", "1,234,567.50", "1,000.", "12.50", "46", ".5", "", "abc", "1.234,50", "12,3456", "1,23,456", "1,234,50", "1234,567", "0,125", "012,345", ",5", "5,", "1,,5", "46,20.5", "abc,5", "٤٦,٢٠"].map((text) => ({ text, plain: plainAmount(text) })),
      typed: CURRENCY_CODES.flatMap((currency) => [...new Set(CURRENCY_CODES.flatMap((other) => [CURRENCIES[other].code, CURRENCIES[other].symbol.trim(), CURRENCIES[other].label.trim()]))].flatMap((mark) => [`${mark}46`, `46 ${mark}`]).concat(["46,20", "$46", "46 $", "€46", "46,20 €", "£46", "US$46", "CA$46", "A$46", "MX$46", "R$46", "R46", "₺46", "CHF 46", "46 EUR", "46 SEK"]).map((text) => ({ currency, text, micros: microsOf(text, currency) }))),
      presetFiat: [...PRESET_FIAT],
      note: { txHash: `0x${"ab".repeat(32)}`, asset: "USDC", usdMicros: "250000000", calldata: encodeNote(`0x${"ab".repeat(32)}`, "USDC", "250000000") },
    })
  })
})

describe("a chart's axes", () => {
  it("never labels two money marks the same, or labels one with what it isn't", () => {
    for (const values of [[-0.0023], [0.000001], [-0.2], [8.5], [1250], [8000], [-250000, 1250000]]) {
      const labels = chartMoneyTicks(values).map(({ label }) => label)
      assert.equal(new Set(labels).size, labels.length, labels.join(" "))
    }
    assert.deepEqual(chartMoneyTicks([-0.0023]).map(({ label }) => label), ["-$0.003", "-$0.002", "-$0.001", "$0.000"])
    assert.deepEqual(chartMoneyTicks([8.5]).map(({ label }) => label), ["$0.00", "$2.50", "$5.00", "$7.50", "$10.00"])
    assert.deepEqual(chartMoneyTicks([1_000_000], "CAD").map(({ label }) => label), ["$0", "$250K", "$500K", "$750K", "$1M"])
  })

  it("says as much of a time as it takes to tell the two ends apart", () => {
    const at = (ms: number) => new Date(1_793_800_020_000 + ms).toISOString()
    for (const narrow of [false, true]) {
      for (const ms of [20_000, 90_000, 3_600_000, 26 * 3_600_000, 86_400_000, 30 * 86_400_000]) {
        const [first, last] = formatChartSpan(at(0), at(ms), narrow)
        assert.notEqual(first, last, `${ms} ${narrow}`)
      }
    }
    assert.match(formatChartSpan(at(0), at(20_000))[0], /:\d\d:\d\d/)
    assert.doesNotMatch(formatChartSpan(at(0), at(90_000))[0], /:\d\d:\d\d/)
    assert.doesNotMatch(formatChartSpan(at(0), at(3 * 86_400_000), true)[0], /:/)
  })

  it("tells apart the hour that repeats when the clocks go back", () => {
    const zone = process.env.TZ
    const cases = [
      ["America/Toronto", "2027-11-07T05:30:00.000Z", "2027-11-07T06:30:00.000Z", /1:30.*EDT/, /1:30.*EST/],
      ["Australia/Lord_Howe", "2027-04-03T14:30:00.000Z", "2027-04-03T15:00:00.000Z", /1:30.*GMT\+11/, /1:30.*GMT\+10:30/],
    ] as const
    try {
      for (const [name, start, end, firstZone, lastZone] of cases) {
        process.env.TZ = name
        for (const narrow of [false, true]) {
          const [first, last] = formatChartSpan(start, end, narrow)
          assert.match(first, firstZone)
          assert.match(last, lastZone)
        }
      }
    } finally {
      if (zone === undefined) delete process.env.TZ
      else process.env.TZ = zone
    }
  })

  it("places two times inside the chart without touching, however wide they are", () => {
    for (const chartWidth of [202, 242, 297, 312, 680]) {
      for (const widths of [[28, 28], [62, 62], [69, 69], [100, 110], [150, 160]]) {
        const [first, last] = placeChartTimes(widths, { start: 64, end: chartWidth - 84, width: chartWidth }) as [{ x: number; row: number }, { x: number; row: number }]
        const [firstWidth, lastWidth] = widths as [number, number]
        assert.ok(first.x >= 0 && first.x + firstWidth <= chartWidth, `${chartWidth} ${widths}`)
        assert.ok(last.x >= 0 && last.x + lastWidth <= chartWidth, `${chartWidth} ${widths}`)
        assert.ok(first.row !== last.row || first.x + firstWidth < last.x, `${chartWidth} ${widths}`)
      }
    }
  })

  it("only moves times away from their points when it has to", () => {
    assert.deepEqual(placeChartTimes([100, 100], { start: 64, end: 596, width: 680 }), [{ x: 64, row: 0 }, { x: 496, row: 0 }])
    assert.deepEqual(placeChartTimes([62, 62], { start: 64, end: 158, width: 242 }), [{ x: 64, row: 0 }, { x: 158, row: 0 }])
    assert.deepEqual(placeChartTimes([100, 110], { start: 64, end: 158, width: 242 }), [{ x: 20, row: 0 }, { x: 132, row: 0 }])
    assert.deepEqual(placeChartTimes([100, 110], { start: 64, end: 118, width: 202 }), [{ x: 64, row: 0 }, { x: 92, row: 1 }])
    assert.deepEqual(placeChartTimes([60], { start: 64, end: 158, width: 242 }), [{ x: 98, row: 0 }])
  })

  it("leaves room for the widest money label", () => {
    assert.equal(chartLeftMargin([], 64), 64)
    assert.equal(chartLeftMargin([30, 40], 64), 64)
    assert.equal(chartLeftMargin([71.53, 66.28], 64), 72 + TICK_GAP)
  })

  it("leaves room for the money label at the end of the line", () => {
    assert.equal(chartRightMargin(0, 84), 84)
    assert.equal(chartRightMargin(60, 84), 84)
    assert.equal(chartRightMargin(87.2, 84), 88 + END_LABEL_GAP)
  })

  it("says one moment once", () => {
    const [first, last] = formatChartSpan("2026-11-05T02:57:05.000Z", "2026-11-05T02:57:05.000Z")
    assert.equal(first, last)
  })
})

const FINISH_METERS = [
  { open: 5, answered: 0, waiting: 0 },
  { open: 2, answered: 3, waiting: 0 },
  { open: 0, answered: 0, waiting: 1 },
  { open: 0, answered: 3, waiting: 1 },
  { open: 0, answered: 0, waiting: 0 },
  { open: 0, answered: 3, waiting: 0 },
]

const UNSEEN_ETH_CASES = [
  [{ blockNum: 53517245, amount: "827782101642000000", txHashes: [`0xde3a${"0".repeat(60)}`] }],
  [{ blockNum: 1, amount: "5", txHashes: [`0xaaaa${"0".repeat(60)}`, `0xbbbb${"0".repeat(60)}`] }, ...[2, 3, 4, 5, 6].map((blockNum) => ({ blockNum, amount: "1000000000000000000", txHashes: [`0x${String(blockNum).repeat(64)}`] }))],
]

describe("what a transaction did", () => {
  const usd = (delta: bigint, asset: string, decimals: number, kind: PricedLeg["kind"], extra: Partial<PricedLeg> = {}) => ({ asset, decimals, kind, delta: delta.toString(), priceMicros: null, ...extra }) as PricedLeg
  const ETH = 10n ** 18n
  const USDC = 10n ** 6n
  const say = (...legs: PricedLeg[]) => wording.describeTransaction(legs, "USD")

  it("says what was sold and for what", () => {
    assert.equal(say(usd(-(ETH / 2500n), "ETH", 18, "swap"), usd(USDC, "USDC", 6, "swap")), "Sold 0.0004 ETH for 1 USDC")
  })

  it("says dollars spent bought something", () => {
    assert.equal(say(usd(-USDC, "USDC", 6, "swap"), usd(ETH / 2500n, "ETH", 18, "swap")), "Bought 0.0004 ETH for 1 USDC")
  })

  it("names one side when the other's off the allowlist", () => {
    assert.equal(say(usd(-USDC, "USDC", 6, "swap")), "Sold 1 USDC")
    assert.equal(say(usd(USDC, "USDC", 6, "swap")), "Bought 1 USDC")
  })

  it("doesn't state a claimed amount as fact", () => {
    assert.equal(say(usd(-USDC, "AERO", 6, "swap"), usd(ETH, "ETH", 18, "swap", { unsettledCredit: true })), "Sold 1 AERO for ETH")
  })

  it("says what was sent or received, and leaves the fee out when something moved", () => {
    assert.equal(say(usd(-USDC, "USDC", 6, "transfer"), usd(-ETH / 1000n, "ETH", 18, "gas", { priceMicros: "3000000000" })), "Sent 1 USDC")
    assert.equal(say(usd(ETH, "ETH", 18, "transfer")), "Received 1 ETH")
  })

  it("keeps a long list short", () => {
    const asset = (name: string) => usd(-USDC, name, 6, "transfer")
    assert.equal(say(asset("USDC"), asset("DAI"), asset("AERO"), asset("DEGEN")), "Sent 1 USDC, 1 DAI and 2 more")
  })

  it("joins what moved in different ways", () => {
    assert.equal(say(usd(-ETH, "ETH", 18, "swap"), usd(USDC, "USDC", 6, "swap"), usd(-USDC, "DAI", 6, "transfer")), "Sold 1 ETH for 1 USDC, sent 1 DAI")
  })

  it("says when only a fee was paid, with its value when it has one", () => {
    assert.equal(say(usd(-ETH / 1000n, "ETH", 18, "gas", { priceMicros: "3000000000" })), "Network fee of $3.00")
    assert.equal(say(usd(-ETH / 1000n, "ETH", 18, "gas")), "Network fee")
  })

  it("is on each point with a transaction, in the wallet's currency, and not on the last", () => {
    const { points } = portfolioOf(DEMO_WALLET, "average")
    assert.ok(points.filter((p) => p.txHash).every((p) => p.summary))
    assert.equal(points.at(-1)?.txHash, null)
    assert.equal(points.at(-1)?.summary, null)
  })
})

const READ_FAILURES: readonly ReadFailure[] = [{ kind: "unreachable" }, { kind: "unavailable", said: "Couldn't read this wallet's data." }, { kind: "noSource", said: "No data source is set up, so only the demo wallet is available." }, { kind: "refused", said: "That isn't a Base address." }]

describe("wording", () => {
  const costLabels = ["paid", "inherited", "received at market", "self-reported", "unknown"] as const
  const kinds = ["swap", "transfer", "gas"] as const
  const vectors = {
    methods: { average: wording.METHOD_LABELS.average, fifo: wording.METHOD_LABELS.fifo },
    modes: wording.MODE_LABELS,
    actions: kinds.flatMap((kind) => [true, false].map((incoming) => ({ kind, incoming, label: wording.actionLabel(kind, incoming) }))),
    priceSources: (["oracle", "swap", "market"] as const).map((source) => ({ source, label: wording.priceSourceLabel(source) })),
    costs: costLabels.map((cost) => ({ cost, tag: wording.costTag(cost) })),
    activity: [[1, 1], [10, 10], [1203, 200]].map(([count, shown]) => ({ count, shown, title: wording.activityTitle(count as number, shown as number) })),
    excluded: wording.excludedSentence([{ asset: "USDC", reason: "unknown cost" }, { asset: "AERO", reason: "no current price" }, { asset: "ETH", reason: "unknown cost" }]),
    coverage: [false, true].map((openingUnread) => ({ fromBlock: 53500000, toBlock: 53505400, trackedTokens: 10, openingUnread, text: wording.coverageSentence({ fromBlock: 53500000, toBlock: 53505400 }, 10, openingUnread) })),
    networkFeeUnknown: [1, 2].map((count) => ({ count, text: wording.networkFeeUnknownSentence(count) })),
    checkLabels: wording.CHECK_LABELS,
    feesUnknown: [1, 2].map((count) => ({ count, text: wording.feesUnknownSentence(count) })),
    behind: [12_000, 28_000, 30_000, 100_000, 10_800_000].map((ms) => ({ ms, text: wording.behindSentence(ms) })),
    stale: wording.staleSentence("Nov 4 at 5:40 AM"),
    feedDetail: [wording.feedDetail("demo", 1000), wording.feedDetail("raw", 1000), wording.feedDetail("dataset", 1000)],
    pnlHelp: ["Total PnL", "AERO: Realized PnL", "Transaction 0x1234…abcd"].map((text) => ({ text, help: wording.pnlHelp(text) ?? null })),
    linkedFailed: [1, 2].map((count) => ({ count, text: wording.linkedFailedSentence(count) })),
    imported: [[0, 0], [0, 1], [0, 2], [1, 0], [2, 0], [2, 1]].map(([found, skipped]) => ({ found: found!, skipped: skipped!, text: wording.importedSentence(found!, skipped!) })),
    importAsk: { question: wording.IMPORT_QUESTION, notWhole: wording.IMPORT_NOT_WHOLE, startsLate: wording.IMPORT_STARTS_LATE, why: ["2026-01-05T10:00:00.000Z", "2025-12-31T23:59:59.000Z"].map((startsAt) => ({ startsAt, text: wording.importWhySentence(startsAt) })) },
    withheld: wording.withheldSentence("0x1234567890abcdef1234567890abcdef12345678", "ETH"),
    answerQuestions: [1, 5, 1203].map((count) => ({ count, text: wording.answerQuestionsLabel(count) })),
    sentences: {
      methodName: wording.METHOD_NAME,
      methodHelp: wording.METHOD_HELP,
      averagePricePaid: wording.AVERAGE_PRICE_PAID,
      networkFees: wording.NETWORK_FEES,
      balanceCheck: wording.BALANCE_CHECK,
      startingBalance: wording.STARTING_BALANCE,
      pnlHelp: wording.PNL_HELP,
      realizedHelp: wording.REALIZED_HELP,
      unrealizedHelp: wording.UNREALIZED_HELP,
      returnHelp: wording.RETURN_HELP,
      notStarted: wording.NOT_STARTED,
      unpricedFees: wording.UNPRICED_FEES,
      demo: wording.DEMO_NOTICE,
      pnlUnavailable: wording.PNL_UNAVAILABLE,
      nothingToChart: wording.NOTHING_TO_CHART,
      reading: wording.READING,
      notAnAddress: wording.NOT_AN_ADDRESS,
      rulesTitle: wording.RULES_TITLE,
      rulesHelp: wording.RULES_HELP,
      holdTitle: wording.HOLD_TITLE,
      holdWallet: wording.HOLD_WALLET,
      holdEth: wording.HOLD_ETH,
      holdPast: wording.HOLD_PAST,
      answerQuestions: wording.ANSWER_QUESTIONS,
      showMissing: wording.SHOW_MISSING,
      senderQuestion: wording.SENDER_QUESTION,
      senderWhy: wording.SENDER_WHY,
      costQuestion: wording.COST_QUESTION,
      costWhy: wording.COST_WHY,
      exchangeCostWhy: wording.EXCHANGE_COST_WHY,
      allAnswered: wording.ALL_ANSWERED,
      nothingLeft: wording.NOTHING_LEFT,
      moneyUnaffected: wording.MONEY_UNAFFECTED,
    },
    finishNotes: FINISH_METERS.map((meter) => ({ ...meter, text: wording.finishNote(meter) })),
    problems: READ_FAILURES.map((failure) => ({ ...failure, ...wording.feedProblem(failure, "https://prices.example.com") })),
    problemsOnThisMachine: READ_FAILURES.filter((failure) => failure.kind === "noSource" || failure.kind === "refused").map((failure) => ({ ...failure, ...wording.feedProblem(failure, "http://127.0.0.1:8787") })),
    unseenEth: UNSEEN_ETH_CASES.map((unseen) => ({ unseen, text: wording.unseenEthCause(unseen) })),
    unrecorded: wording.unrecordedSentence("2061830000000000", 18, "ETH"),
    manifestHash: wording.shortManifestHash("bea12f7575e74575f2f0318213d61d421706eea0314e5d7116edebd4e77818a1"),
  }

  it("says the same on the Mac", () => {
    assertMatchesFixture("wording-vectors.json", vectors)
  })

  it("says what a failed read means, that money is fine and what to do, with the technical side apart", () => {
    const stale = wording.staleSentence("Nov 4 at 5:40 AM")
    for (const failure of READ_FAILURES) {
      for (const problem of [wording.feedProblem(failure, "https://prices.example.com"), wording.feedProblem(failure, "https://prices.example.com", stale), failure.kind === "refused" ? null : wording.panelProblem(failure, "https://prices.example.com")]) {
        if (!problem) continue
        assert.ok(problem.message.includes(wording.MONEY_UNAFFECTED), problem.message)
        assert.ok(problem.detail, failure.kind)
        assert.doesNotMatch(problem.message, /https?:|server|\bAmp\b|Couldn't read this wallet's data/)
      }
    }
    assert.ok(wording.feedProblem(READ_FAILURES[1]!, "https://prices.example.com", stale).message.includes(`right now. ${stale} ${wording.MONEY_UNAFFECTED}`))
    assert.equal(wording.feedProblem({ kind: "unreachable" }, "https://prices.example.com").detail, "Nothing answered at https://prices.example.com.")
    assert.equal(wording.feedProblem({ kind: "unavailable", said: "Couldn't read this wallet's data." }, "x").detail, "The price service said: Couldn't read this wallet's data.")
  })

  it("only asks someone to restart a server on their own machine", () => {
    for (const failure of READ_FAILURES) {
      const hosted = wording.feedProblem(failure, "https://prices.example.com")
      assert.doesNotMatch(`${hosted.message} ${hosted.detail}`, /restart|\.env\.local/i)
    }
    for (const server of ["http://127.0.0.1:8787", "http://localhost:5173", "http://[::1]:8787"]) {
      assert.match(wording.feedProblem({ kind: "refused", said: "Nope." }, server).message, /restart the price service/)
      assert.match(wording.feedProblem({ kind: "noSource", said: "None." }, server).detail ?? "", /\.env\.local/)
    }
  })

  it("lets a panel say what a refusal said, since that's about the question it asked", () => {
    assert.deepEqual(wording.panelProblem({ kind: "refused", said: "The two rules haven't reached the same block yet. Try again in a moment." }, "x"), { message: "The two rules haven't reached the same block yet. Try again in a moment.", detail: null })
  })

  it("sorts a failed read the way the Mac does", async () => {
    const failed = async (response: Response) => {
      try {
        await readResponse(response)
      } catch (error) {
        return failureOf(error)
      }
      return null
    }
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    assert.deepEqual(await failed(json(502, { error: "a" })), { kind: "unavailable", said: "a" })
    assert.deepEqual(await failed(json(503, { error: "b" })), { kind: "noSource", said: "b" })
    assert.deepEqual(await failed(json(409, { error: "c" })), { kind: "refused", said: "c" })
    assert.deepEqual(await failed(json(200, { error: "d" })), { kind: "refused", said: "d" })
    assert.deepEqual(await failed(new Response("<html>Bad gateway</html>", { status: 502 })), { kind: "unreachable" })
    assert.deepEqual(await failed(new Response("not json", { status: 200 })), { kind: "unreachable" })
    assert.equal(await failed(json(200, { ok: true })), null)
    assert.deepEqual(await readResponse(json(200, { ok: true })), { ok: true })
    assert.deepEqual(failureOf(new TypeError("Failed to fetch")), { kind: "unreachable" })
  })

  it("says what PnL stands for", () => {
    assert.match(wording.PNL_HELP, /profit and loss/)
    assert.equal(wording.pnlHelp("Total PnL"), wording.PNL_HELP)
    assert.equal(wording.pnlHelp("Transaction 0x1234…abcd"), undefined)
  })

  it("uses none of the old terms in anything people read", () => {
    const JARGON = /\b(fifo|avg|average cost|legs?|proceeds|oracles?|allowlist|off the list|swaps?|inherited|self-reported|received at market|gas|dataset|onchain|weth|reconcil\w*|L[12])\b/i
    // The vectors also name the API's own values, as inputs, so only what they print is held to this.
    const printed = (value: unknown): string[] => {
      if (typeof value === "string") return [value]
      if (typeof value !== "object" || value === null) return []
      return Object.entries(value).flatMap(([key, inner]) => (["kind", "source", "cost"].includes(key) ? [] : printed(inner)))
    }
    const texts: string[] = [...printed(vectors), ...Object.values(PRICE_NOTES), wording.ETH_NOTE]
    const incoming = (token: string, kind: LegRow["kind"]): LegRow => ({ block_num: 100, timestamp: "2026-11-04T00:00:00.000Z", tx_hash: "0xa", tx_index: 1, log_index: 0, token, account: "0xaa", side: "credit", amount: "1000000000000000000", kind })
    const [wrapped] = buildPricedLegs({ account: "0xaa", rows: [incoming(ETH_ADDRESS, "eth"), incoming(WETH_ADDRESS, "erc20")], references: [], priced: [] })
    assert.equal(describeNetting(wrapped!), "Combines 2 movements: +1 ETH, +1 wrapped ETH")
    texts.push(describeNetting(wrapped!) ?? "")
    const wallets = [DEMO_WALLET, walletWith({ currency: "CAD", rates: demoRates("CAD") })]
    for (const wallet of wallets) {
      for (const method of ["average", "fifo"] as const) {
        for (const position of foldPositions(DEMO_WALLET.legs, method, DEMO_WALLET.prices)) {
          for (const effect of position.effects) {
            const { summary, unknown } = summarizeEffect(effect, wallet.currency)
            texts.push(describeEffect(effect, wallet.currency), summary, unknown ?? "", describeNetting(effect.leg) ?? "", effect.leg.priceNote ?? "")
          }
          for (const metric of ["amount", "average", "value", "realized", "unrealized", "onchain"] as const) {
            const explanation = explainPortfolio(wallet, method, { kind: "asset", asset: position.asset, metric })
            texts.push(explanation?.title ?? "", ...(explanation?.lines ?? []))
          }
        }
        for (const metric of ["pnl", "value", "realized", "unrealized", "gas"] as const) {
          const explanation = explainPortfolio(wallet, method, { kind: "total", metric })
          texts.push(explanation?.title ?? "", ...(explanation?.lines ?? []))
        }
      }
    }
    for (const text of texts) assert.doesNotMatch(text, JARGON)
  })
})

describe("comparing pricing rules", () => {
  const rule = (id: string, name: string) => ({ id, name, summary: "", dataset: `a/${id}@0.0.1`, hash: "a".repeat(64) })
  const market = rule("market-price", "Market price")
  const cautious = rule("cautious-eth", "Cautious ETH")
  const eth = DEMO_WALLET.prices.ETH!
  const lower = (micros: string | null) => (micros === null ? null : ((BigInt(micros) * 99n) / 100n).toString())
  // What the fork does: everything's the same but what ETH is worth, here and in anything valued in ETH.
  const forked = walletWith({
    prices: { ...DEMO_WALLET.prices, ETH: { ...eth, micros: lower(eth.micros)! } },
    balances: DEMO_WALLET.balances,
    legs: DEMO_WALLET.legs.map((leg) => (leg.asset === "ETH" ? { ...leg, priceMicros: lower(leg.priceMicros), costMicros: lower(leg.costMicros), proceedsMicros: lower(leg.proceedsMicros) } : leg)),
  })
  const reference = (eth_usd: string) => ({ blockNum: 1, ethUsd: eth_usd, usdcUsd: "100000000" })
  const compared = compareRules({ rule: market, wallet: walletWith({}), reference: reference("240000000000") }, { rule: cautious, wallet: forked, reference: reference("237600000000") }, "average", 1)
  const row = (label: string) => compared.rows.find((r) => r.label === label)

  it("says what ETH is worth by each rule", () => {
    assert.deepEqual(row("ETH price"), { label: "ETH price", format: "usdPrice", a: "2400000000", b: "2376000000", difference: "-24000000", aPartial: false, bPartial: false, aEstimated: false, bEstimated: false })
  })

  it("says which dollars ETH's price is in, only when the rest aren't USD", () => {
    const { a, difference } = row("ETH price")!
    assert.equal(showRuleValue(a, "usdPrice", "USD"), "$2,400.00")
    assert.equal(showRuleDifference(difference, "usdPrice", "USD"), "-$24.00")
    assert.equal(showRuleValue(a, "usdPrice", "CAD"), "US$2,400.00")
    assert.equal(showRuleDifference(difference, "usdPrice", "CAD"), "-US$24.00")
    assert.equal(showRuleDifference("24000000", "usdPrice", "CAD"), "+US$24.00")
    assert.equal(showRuleValue(a, "usdPrice", "CAD", true), "≈US$2,400.00")
    assert.equal(showRuleValue("1500000", "money", "CAD"), "$1.50")
    assert.equal(showRuleDifference("1500000", "signed", "CAD"), "+$1.50")
  })

  it("gets each side from the same fold the app shows", () => {
    assert.equal(row("Total PnL")?.a, portfolioOf(walletWith({}), "average").totals.pnlMicros)
    assert.equal(row("Total PnL")?.b, portfolioOf(forked, "average").totals.pnlMicros)
    assert.equal(row("Value")?.a, portfolioOf(walletWith({}), "average").totals.valueMicros)
  })

  it("has no difference from something unknown, and an unknown is never zero", () => {
    assert.equal(differenceOf(null, "5"), null)
    assert.equal(differenceOf("5", null), null)
    assert.equal(differenceOf("5", "7"), "2")
  })

  it("lists each transaction that changed, newest first, and counts them all", () => {
    assert.ok(compared.changedTxs > 0)
    assert.ok(compared.transactions.every((tx) => tx.asset === "ETH" && tx.a !== tx.b))
    const blocks = compared.transactions.map((tx) => tx.blockNum)
    assert.deepEqual(blocks, [...blocks].sort((x, y) => y - x))
    assert.ok(compared.why.includes(`${compared.changedTxs}`))
  })

  it("finds no difference between a rule and itself", () => {
    const same = compareRules({ rule: market, wallet: walletWith({}), reference: reference("1") }, { rule: cautious, wallet: walletWith({}), reference: reference("1") }, "average", 1)
    assert.equal(same.changedTxs, 0)
    assert.deepEqual(same.transactions, [])
    assert.ok(same.rows.every((r) => r.a === r.b))
    assert.equal(same.why, whySentence(0))
  })

  it("says which rule is on wherever a number is explained, because a label alone can't", () => {
    const note = ruleNote(RULE_TEXT["cautious-eth"]!)
    const explained = explainPortfolio(walletWith({ ruleNote: note }), "average", { kind: "total", metric: "pnl" })
    assert.ok(explained?.lines.includes(note))
    assert.ok(!explainPortfolio(walletWith({}), "average", { kind: "total", metric: "pnl" })?.lines.includes(note))
  })

  it("says what a partial sum leaves out, the same as the main screen, and marks it", () => {
    const portfolio = portfolioOf(walletWith({}), "average")
    assert.ok(portfolio.totals.coverage.pnl.missing > 0, "the demo wallet leaves things out")
    assert.equal(row("Total PnL")?.aPartial, true)
    assert.equal(row("Total PnL")?.bPartial, true)
    assert.ok(compared.warnings.includes(wording.excludedSentence(portfolio.totals.excluded)!))
  })

  it("says when a total's difference is real", () => {
    assert.notEqual(row("Value")?.difference, null)
  })

  it("won't call it a difference when one side leaves out something the other doesn't", () => {
    const missing = walletWith({ balances: null })
    const lopsided = compareRules({ rule: market, wallet: walletWith({}), reference: reference("1") }, { rule: cautious, wallet: missing, reference: reference("1") }, "average", 1)
    assert.equal(lopsided.rows.find((r) => r.label === "Total PnL")?.difference, null)
    assert.ok(lopsided.warnings.some((w) => w.startsWith("Cautious ETH: ")))
  })

  it("counts a network fee that changed, and says so", () => {
    const gas: LegRow = { block_num: 5, timestamp: "2026-11-04T00:00:00.000Z", tx_hash: "0xfee", tx_index: 1, log_index: 0, token: ETH_ADDRESS, account: "0xaa", side: "debit", amount: "1000000000000000", kind: "gas" }
    const by = (eth_usd: string) => walletWith({ address: "0xaa", prices: {}, legs: buildPricedLegs({ account: "0xaa", rows: [gas], references: [{ blockNum: 5, ethUsd: eth_usd, usdcUsd: "100000000" }], priced: [] }), balances: null })
    const fees = compareRules({ rule: market, wallet: by("300000000000"), reference: reference("300000000000") }, { rule: cautious, wallet: by("297000000000"), reference: reference("297000000000") }, "average", 5)
    assert.equal(fees.changedTxs, 1)
    assert.deepEqual(fees.transactions.map((tx) => [tx.label, tx.a, tx.b, tx.difference]), [["Network fee", "3000000", "2970000", "-30000"]])
    assert.deepEqual(fees.rows.find((r) => r.label === "Network fees")?.difference, "-30000")
    assert.equal(fees.why, whySentence(1))
  })

  describe("what rests on an estimate", () => {
    const [ME, OTHER, STRANGER] = ["0x00000000000000000000000000000000000000aa", "0x00000000000000000000000000000000000000bb", "0x00000000000000000000000000000000000000dd"]
    const AERO = TOKENS.find((t) => t.symbol === "AERO")!.address
    const VIRTUAL = TOKENS.find((t) => t.symbol === "VIRTUAL")!.address
    const E18 = 10n ** 18n
    const moved = (tx: string, block: number, account: string, token: string, side: LegRow["side"], amount: bigint, counterparty?: string): LegRow => ({ block_num: block, timestamp: "2026-11-04T00:00:00.000Z", tx_hash: tx, tx_index: 1, log_index: 0, token, account, side, amount: amount.toString(), kind: token === ETH_ADDRESS ? "eth" : "erc20", ...(counterparty ? { counterparty } : {}) })
    const walletOf = (address: string, rows: LegRow[], eth_usd: string, market: string | null = null, prices: Record<string, string> = {}) => {
      const references = [...new Set(rows.map((r) => r.block_num))].map((block_num) => ({ blockNum: block_num, ethUsd: eth_usd, usdcUsd: "100000000" }))
      const legs = buildPricedLegs({ account: address, rows, references, priced: [], ...(market ? { market: () => market } : {}) })
      const amounts: Record<string, string> = Object.fromEntries(ASSETS.map((asset) => [asset, "0"]))
      for (const leg of legs) amounts[leg.asset] = (BigInt(amounts[leg.asset] ?? "0") + BigInt(leg.delta)).toString()
      return walletWith({ address, legs, references, balances: { blockNum: 20, amounts }, prices: Object.fromEntries(Object.entries(prices).map(([asset, micros]) => [asset, { micros, source: asset === "ETH" ? ("oracle" as const) : ("market" as const), blockNum: 20 }])) })
    }
    const mine = () => ({ senders: { [OTHER]: { kind: "mine" as const }, [ME]: { kind: "mine" as const }, [STRANGER]: { kind: "someone-else" as const } }, costs: {}, withdrawals: [] })
    // OTHER got 1 ETH from someone else, so its cost is an estimate, and sent it to this wallet, which inherits that.
    const inherited = (eth: string, rule: typeof market) => ({
      rule,
      reference: reference(eth),
      wallet: walletOf(ME, [moved("0xout", 15, ME, ETH_ADDRESS, "credit", E18, OTHER)], eth, null, { ETH: ((BigInt(eth) / 100n)).toString() }),
      linked: [walletOf(OTHER, [moved("0xin", 10, OTHER, ETH_ADDRESS, "credit", E18, STRANGER), moved("0xout", 15, OTHER, ETH_ADDRESS, "debit", E18, ME)], eth)],
    })
    const ruleRow = (comparison: RuleComparison, label: string) => comparison.rows.find((r) => r.label === label)!

    it("marks an inherited estimate, and what's worked out from it, on each side", () => {
      const comparison = compareRules(inherited("300000000000", market), inherited("297000000000", cautious), "average", 20, mine())
      const cost = ruleRow(comparison, "ETH cost")
      assert.deepEqual([cost.a, cost.b, cost.difference, cost.aEstimated, cost.bEstimated], ["3000000000", "2970000000", "-30000000", true, true])
      const pnl = ruleRow(comparison, "Total PnL")
      assert.deepEqual([pnl.a, pnl.b, pnl.aEstimated, pnl.bEstimated], ["0", "0", true, true])
      assert.deepEqual(comparison.transactions.map((tx) => [tx.txHash, tx.label, tx.aEstimated, tx.bEstimated]), [["0xout", "Cost", true, true]])
    })

    it("says how much is an estimate, per side when the sides differ", () => {
      const comparison = compareRules(inherited("300000000000", market), inherited("297000000000", cautious), "average", 20, mine())
      assert.ok(comparison.warnings.includes(`Market price: ${wording.estimatedSentence("3000000000", "USD")}`))
      assert.ok(comparison.warnings.includes(`Cautious ETH: ${wording.estimatedSentence("2970000000", "USD")}`))
    })

    it("marks a value from a market price, and a trade valued by one", () => {
      const rows = [moved("0xin", 10, ME, AERO, "credit", 10n * E18, STRANGER), moved("0xtrade", 15, ME, AERO, "debit", 5n * E18), moved("0xtrade", 15, ME, VIRTUAL, "credit", 5n * E18)]
      const by = (rule: typeof market, price: string) => ({ rule, reference: reference("300000000000"), wallet: walletOf(ME, rows, "300000000000", price, { AERO: price }) })
      const comparison = compareRules(by(market, "2000000"), by(cautious, "1900000"), "average", 20, { ...mine(), linked: [] })
      const value = ruleRow(comparison, "AERO value")
      assert.deepEqual([value.a, value.b, value.aEstimated, value.bEstimated], ["10000000", "9500000", true, true])
      const sold = comparison.transactions.find((tx) => tx.txHash === "0xtrade" && tx.label === "Sold for")!
      assert.deepEqual([sold.a, sold.b, sold.difference, sold.aEstimated, sold.bEstimated], ["10000000", "9500000", "-500000", true, true])
    })

    it("doesn't mark what's exact, right beside it", () => {
      const eth = (usd: string, rule: typeof market) => ({ rule, reference: reference(usd), wallet: walletOf(ME, [moved("0xbuy", 10, ME, USDC_ADDRESS, "debit", 3_000_000_000n), moved("0xbuy", 10, ME, ETH_ADDRESS, "credit", E18), moved("0xgift", 11, ME, ETH_ADDRESS, "credit", E18 / 2n, STRANGER)], usd, null, { ETH: (BigInt(usd) / 100n).toString() }) })
      const comparison = compareRules(eth("300000000000", market), eth("297000000000", cautious), "fifo", 20, { ...mine(), linked: [] })
      assert.deepEqual([ruleRow(comparison, "ETH price").aEstimated, ruleRow(comparison, "Network fees").aEstimated, ruleRow(comparison, "Value").aEstimated], [false, false, false])
      const costs = comparison.transactions.filter((tx) => tx.label === "Cost")
      assert.deepEqual(costs.map((tx) => [tx.txHash, tx.aEstimated, tx.bEstimated]), [["0xgift", true, true]], "the USDC trade cost the same by both, so only what came at market is listed")
    })

    it("leaves a side alone when it's unavailable", () => {
      const comparison = compareRules(inherited("300000000000", market), { ...inherited("297000000000", cautious), linked: [] }, "average", 20, mine())
      const cost = comparison.transactions.find((tx) => tx.txHash === "0xout")!
      assert.deepEqual([cost.a, cost.b, cost.difference, cost.aEstimated, cost.bEstimated], ["3000000000", null, null, true, false])
    })
  })

  describe("a transfer between linked wallets carrying several purchases", () => {
    const [ME, OTHER] = ["0x00000000000000000000000000000000000000aa", "0x00000000000000000000000000000000000000bb"]
    const DEGEN = TOKENS.find((t) => t.symbol === "DEGEN")!.address
    const THOUSANDS = "10000000000000000000000"
    const moved = (tx: string, block: number, account: string, token: string, side: LegRow["side"], amount: string): LegRow => ({ block_num: block, timestamp: "2026-11-04T00:00:00.000Z", tx_hash: tx, tx_index: 1, log_index: 0, token, account, side, amount, kind: "erc20" })
    const walletOf = (address: string, rows: LegRow[], eth_usd: string) => {
      const references = [...new Set(rows.map((r) => r.block_num))].map((block_num) => ({ blockNum: block_num, ethUsd: eth_usd, usdcUsd: "100000000" }))
      return walletWith({ address, legs: buildPricedLegs({ account: address, rows, references, priced: derivePricedRows(rows, references) }), references, prices: {} })
    }
    const fund = moved("0xfund", 2, OTHER, ETH_ADDRESS, "credit", "300000000000000000")
    const buys = [
      moved("0xbuy1", 3, OTHER, ETH_ADDRESS, "debit", "100000000000000000"),
      moved("0xbuy1", 3, OTHER, DEGEN, "credit", THOUSANDS),
      moved("0xbuy2", 4, OTHER, ETH_ADDRESS, "debit", "200000000000000000"),
      moved("0xbuy2", 4, OTHER, DEGEN, "credit", THOUSANDS),
    ]
    const send = (amount: string) => [{ ...moved("0xsend", 6, OTHER, DEGEN, "debit", amount), counterparty: ME }]
    const land = (amount: string) => [{ ...moved("0xsend", 6, ME, DEGEN, "credit", amount), counterparty: OTHER }]
    const by = (rule: typeof market, eth: string, others: LegRow[], amount: string) => ({ rule, wallet: walletOf(ME, land(amount), eth), linked: [walletOf(OTHER, [fund, ...others, ...send(amount)], eth)], reference: reference(eth) })
    const compareFifo = (others: LegRow[], amount: string) => compareRules(by(market, "300000000000", others, amount), by(cautious, "297000000000", others, amount), "fifo", 20)
    const costs = (comparison: ReturnType<typeof compareFifo>) => comparison.transactions.filter((tx) => tx.txHash === "0xsend")

    it("is one cost for one transaction", () => {
      const comparison = compareFifo(buys, "20000000000000000000000")
      assert.deepEqual(costs(comparison).map((tx) => [tx.asset, tx.label, tx.a, tx.b, tx.difference]), [["DEGEN", "Cost", "900000000", "891000000", "-9000000"]])
      assert.equal(comparison.changedTxs, 1)
    })

    it("gives every row its own identity, which both apps key on", () => {
      const { transactions } = compareFifo(buys, "20000000000000000000000")
      const ids = transactions.map((tx) => `${tx.txHash}:${tx.asset}:${tx.label}`)
      assert.equal(new Set(ids).size, ids.length)
    })

    it("stays unknown when part of it is, and still says it changed", () => {
      // Half of what's sent arrived from a stranger at an unknown cost, so the whole cost is unknown by either rule.
      const others = [moved("0xbuy1", 3, OTHER, ETH_ADDRESS, "debit", "100000000000000000"), moved("0xbuy1", 3, OTHER, DEGEN, "credit", THOUSANDS), moved("0xgift", 4, OTHER, DEGEN, "credit", THOUSANDS)]
      const comparison = compareFifo(others, "20000000000000000000000")
      assert.deepEqual(costs(comparison).map((tx) => [tx.label, tx.a, tx.b, tx.difference]), [["Cost", null, null, null]])
      assert.equal(comparison.changedTxs, 1)
    })

    it("doesn't list an amount that stayed the same, known or not", () => {
      const same = compareRules(by(market, "300000000000", buys, "20000000000000000000000"), by(cautious, "300000000000", buys, "20000000000000000000000"), "fifo", 20)
      assert.deepEqual(same.transactions, [])
      assert.equal(same.changedTxs, 0)
    })
  })

  it("sends the Mac app what it can read", () => {
    assertMatchesFixture("demo-rule-comparison.json", compared)
    const inCad = (wallet: WalletResponse) => ({ ...wallet, currency: "CAD" as const, rates: demoRates("CAD") })
    assertMatchesFixture("demo-rule-comparison-cad.json", compareRules({ rule: market, wallet: inCad(walletWith({})), reference: reference("240000000000") }, { rule: cautious, wallet: inCad(forked), reference: reference("237600000000") }, "average", 1))
  })

  it("keeps the rule's words plain", () => {
    const JARGON = /\b(fifo|legs?|proceeds|oracles?|allowlist|swaps?|dataset|onchain|weth|slippage)\b/i
    for (const text of [...Object.values(RULE_TEXT).flatMap((t) => [t.name, t.summary]), whySentence(0), whySentence(1), whySentence(2), wording.RULES_HELP]) assert.doesNotMatch(text, JARGON, text)
  })
})
