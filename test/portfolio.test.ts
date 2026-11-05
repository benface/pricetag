import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { after, before, describe, it } from "node:test"
import { ASSETS, ETH_ADDRESS, ETH_USD_FEED, LAST_2S_BLOCK, PRICE_NOTES, TOKENS, TOKEN_FEEDS, USDC_ADDRESS, USDC_USD_FEED, WETH_ADDRESS, blockBefore, buildPricedLegs, chartMoneyTicks, derivePricedRows, formatChartSpan, msBetweenBlocks, encodeNote, foldPositions, formatAmount, formatDuration, formatMoney, formatPrice, formatSignedAmount, formatSignedMoney, labelUsd, sumTotals, type LegRow, type PricedLeg } from "@pricetag/sdk/core"
import type { ExplanationResponse, PortfolioResponse, WalletResponse } from "../src/core/api.ts"
import { describeEffect, describeNetting } from "../src/core/explain.ts"
import { DEMO_WALLET, demoRates } from "../src/core/fixtures.ts"
import * as wording from "../src/core/wording.ts"
import { createApi } from "../server/app.ts"
import { compareRules, explainPortfolio, parseExplainTarget, portfolioOf } from "../server/portfolio.ts"
import { emptyBook, linkMessage } from "../src/core/book.ts"
import { foldBook } from "../src/core/resolve.ts"
import { RULE_TEXT, differenceOf, ruleNote, showRuleDifference, showRuleValue, whySentence, type RuleComparison } from "../src/core/rules.ts"
import { proofOf, verificationOf } from "../server/proof.ts"

const RESOURCES = new URL("../macos/PricetagKit/Tests/PricetagKitTests/Resources/", import.meta.url)

/** The Swift package's tests read these, so a change to what the server sends or prints fails on both sides. */
function assertMatchesFile(name: string, actual: unknown) {
  const url = new URL(name, RESOURCES)
  const text = `${JSON.stringify(actual, null, 2)}\n`
  if (process.env.UPDATE_FIXTURES) writeFileSync(url, text)
  assert.equal(readFileSync(url, "utf8"), text, `${name} is out of date. Run with UPDATE_FIXTURES=1 if the change is on purpose.`)
}

describe("the hot wallet's allowlist", () => {
  it("matches what the Swift package has compiled in", () => {
    const url = new URL("../macos/HotWalletKit/Tests/HotWalletKitTests/Resources/tokens.json", import.meta.url)
    const actual = { tokens: TOKENS.map(({ address, symbol, decimals, asset, sanity }) => ({ address, symbol, decimals, asset, sanity })), ethUsdFeed: ETH_USD_FEED.toLowerCase(), usdcUsdFeed: USDC_USD_FEED.toLowerCase(), feeds: TOKEN_FEEDS }
    const text = `${JSON.stringify(actual, null, 2)}\n`
    if (process.env.UPDATE_FIXTURES) writeFileSync(url, text)
    assert.equal(readFileSync(url, "utf8"), text, "tokens.json is out of date. Run with UPDATE_FIXTURES=1, and change Tokens.swift to match.")
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
    assert.equal(check.value, "⚠ Incomplete")
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
    assert.equal(explainPortfolio(DEMO_WALLET, "average", { kind: "total", metric: "pnl" })?.value, "+$149.30")
  })

  it("matches the files the Swift package reads", () => {
    assertMatchesFile("demo-portfolio.json", portfolioOf(DEMO_WALLET, "average"))
    assertMatchesFile("demo-explanation.json", explainPortfolio(DEMO_WALLET, "average", { kind: "asset", asset: "AERO", metric: "realized" }))
    const inCad = walletWith({ currency: "CAD", rates: demoRates("CAD") })
    assertMatchesFile("demo-portfolio-cad.json", portfolioOf(inCad, "average"))
    assertMatchesFile("demo-explanation-cad.json", explainPortfolio(inCad, "average", { kind: "asset", asset: "AERO", metric: "realized" }))
    assertMatchesFile("demo-hold-explanation.json", explainPortfolio(DEMO_WALLET, "average", { kind: "hold" }))
    const leg = DEMO_WALLET.legs.find(({ priceSource, kind }) => priceSource === "swap" && kind === "swap") as PricedLeg
    const dataset = { title: "Base's blocks", name: "edgeandnode/base_mainnet@0.0.2", hash: "6428aaca2cf57b8403ca3ab8bc657b361926ce6beeb6577477c85684e6ea569e" }
    assertMatchesFile("proof.json", proofOf(leg, DEMO_WALLET.legs, "USD", [dataset, { ...dataset, name: "a/b@1", hash: null }], null))
    assertMatchesFile("demo-proof.json", proofOf(leg, DEMO_WALLET.legs, "USD", [], "This is the demo wallet, so there's no real block to check."))
    const fixture = JSON.parse(readFileSync(new URL("./support/base-blocks.json", import.meta.url), "utf8"))
    assertMatchesFile("verification.json", verificationOf({ ...leg, blockNum: 9200017, txHash: `0x${fixture.block.txs[1].tx_hash}`, parts: [] }, [], fixture.block, new Map(Object.entries(fixture.deposits))))
    assertMatchesFile("verification-failed.json", verificationOf({ ...leg, blockNum: 9200017, parts: [] }, [], { ...fixture.block, logs: [] }, null))
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

  it("says a wallet can't be read when there's no data source, rather than reading it forever", async () => {
    const stranger = "0x000000000000000000000000000000000000be11"
    const book = { senders: { [stranger]: { kind: "mine" } } }
    const { body } = await post("/api/portfolio/demo/preview", { method: "average", candidates: [book] })
    assert.deepEqual((body.previews as { failed: boolean; pending: boolean }[]).map((p) => [p.failed, p.pending]), [[true, true]])
    const portfolio = (await post("/api/portfolio/demo", { method: "average", book })).body as unknown as PortfolioResponse
    assert.deepEqual([portfolio.linkedReading, portfolio.linkedFailed], [[], [stranger]])
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
    assertMatchesFile("format-vectors.json", {
      usd: usd.map((micros) => ({ micros, usd: formatMoney(micros, "USD"), signed: formatSignedMoney(micros, "USD") })),
      cad: usd.map((micros) => ({ micros, usd: formatMoney(micros, "CAD"), signed: formatSignedMoney(micros, "CAD") })),
      price: usd.filter((micros) => !micros.startsWith("-") && micros !== "0").map((micros) => ({ micros, price: formatPrice(micros, "USD"), cad: formatPrice(micros, "CAD") })),
      labeledUsd: ["$2,376.00", "+$24.00", "-$24.00", "$0.004", "-$0.004"].map((text) => ({ text, usd: labelUsd(text, "USD"), cad: labelUsd(text, "CAD") })),
      amount: units.map(([value, decimals]) => ({ units: value, decimals, amount: formatAmount(value, decimals), signed: formatSignedAmount(value, decimals) })),
      chartTicks: [[], [0], [-0.0023], [-0.0015, -0.0023], [0.000001], [-0.2], [0.75], [8.5], [-3, 12], [120], [1250], [8000], [-250000, 1250000], [12000000]].map((values) => ({ values, usd: chartMoneyTicks(values, "USD"), cad: chartMoneyTicks(values, "CAD") })),
      duration: [0, 60_000, 3_600_000, 7_198_000, 7_200_000, 10_800_000, 200_000_000].map((ms) => ({ ms, duration: formatDuration(ms) })),
      blockSpans: [[100, 130], [LAST_2S_BLOCK - 5, LAST_2S_BLOCK], [LAST_2S_BLOCK - 5, LAST_2S_BLOCK + 10], [LAST_2S_BLOCK, LAST_2S_BLOCK + 300], [LAST_2S_BLOCK + 5, LAST_2S_BLOCK + 305], [130, 100]].map(([from, to]) => ({ from, to, ms: msBetweenBlocks(from as number, to as number) })),
      blocksBefore: [[130, 60_000], [LAST_2S_BLOCK, 60_000], [LAST_2S_BLOCK + 10, 60_000], [LAST_2S_BLOCK + 300, 60_000], [LAST_2S_BLOCK + 301, 60_000], [LAST_2S_BLOCK + 300, 60_100], [10, 60_000]].map(([block, ms]) => ({ block, ms, before: blockBefore(block as number, ms as number) })),
      linkMessage: { owner: DEMO_WALLET.address, address: "0x00000000000000000000000000000000000DE301", message: linkMessage(DEMO_WALLET.address, "0x00000000000000000000000000000000000DE301") },
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
    process.env.TZ = "America/Toronto"
    try {
      for (const narrow of [false, true]) {
        const [first, last] = formatChartSpan("2027-11-07T05:30:00.000Z", "2027-11-07T06:30:00.000Z", narrow)
        assert.match(first, /1:30.*EDT/)
        assert.match(last, /1:30.*EST/)
      }
    } finally {
      if (zone === undefined) delete process.env.TZ
      else process.env.TZ = zone
    }
  })

  it("says one moment once", () => {
    const [first, last] = formatChartSpan("2026-11-05T02:57:05.000Z", "2026-11-05T02:57:05.000Z")
    assert.equal(first, last)
  })
})

const UNSEEN_ETH_CASES = [
  [{ blockNum: 53517245, amount: "827782101642000000", txHashes: [`0xde3a${"0".repeat(60)}`] }],
  [{ blockNum: 1, amount: "5", txHashes: [`0xaaaa${"0".repeat(60)}`, `0xbbbb${"0".repeat(60)}`] }, ...[2, 3, 4, 5, 6].map((blockNum) => ({ blockNum, amount: "1000000000000000000", txHashes: [`0x${String(blockNum).repeat(64)}`] }))],
]

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
    withheld: wording.withheldSentence("0x1234567890abcdef1234567890abcdef12345678", "ETH"),
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
    },
    unseenEth: UNSEEN_ETH_CASES.map((unseen) => ({ unseen, text: wording.unseenEthCause(unseen) })),
    manifestHash: wording.shortManifestHash("bea12f7575e74575f2f0318213d61d421706eea0314e5d7116edebd4e77818a1"),
  }

  it("says the same on the Mac", () => {
    assertMatchesFile("wording-vectors.json", vectors)
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
            texts.push(describeEffect(effect, wallet.currency), describeNetting(effect.leg) ?? "", effect.leg.priceNote ?? "")
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
    assertMatchesFile("demo-rule-comparison.json", compared)
    const inCad = (wallet: WalletResponse) => ({ ...wallet, currency: "CAD" as const, rates: demoRates("CAD") })
    assertMatchesFile("demo-rule-comparison-cad.json", compareRules({ rule: market, wallet: inCad(walletWith({})), reference: reference("240000000000") }, { rule: cautious, wallet: inCad(forked), reference: reference("237600000000") }, "average", 1))
  })

  it("keeps the rule's words plain", () => {
    const JARGON = /\b(fifo|legs?|proceeds|oracles?|allowlist|swaps?|dataset|onchain|weth|slippage)\b/i
    for (const text of [...Object.values(RULE_TEXT).flatMap((t) => [t.name, t.summary]), whySentence(0), whySentence(1), whySentence(2), wording.RULES_HELP]) assert.doesNotMatch(text, JARGON, text)
  })
})
