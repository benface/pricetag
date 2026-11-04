import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { after, before, describe, it } from "node:test"
import { foldPositions, sumTotals } from "@pricetag/sdk/core"
import type { ExplanationResponse, PortfolioResponse, WalletResponse } from "../src/core/api.ts"
import { DEMO_WALLET } from "../src/core/fixtures.ts"
import { formatAmount, formatDuration, formatPrice, formatSignedAmount, formatSignedUsd, formatUsd } from "../src/core/format.ts"
import { createApi } from "../server/app.ts"
import { explainPortfolio, parseExplainTarget, portfolioOf } from "../server/portfolio.ts"

const RESOURCES = new URL("../macos/PricetagKit/Tests/PricetagKitTests/Resources/", import.meta.url)

/** The Swift package's tests read these, so a change to what the server sends or prints fails on both sides. */
function assertMatchesFile(name: string, actual: unknown) {
  const url = new URL(name, RESOURCES)
  const text = `${JSON.stringify(actual, null, 2)}\n`
  if (process.env.UPDATE_FIXTURES) writeFileSync(url, text)
  assert.equal(readFileSync(url, "utf8"), text, `${name} is out of date. Run with UPDATE_FIXTURES=1 if the change is on purpose.`)
}

const walletWith = (changes: Partial<WalletResponse>): WalletResponse => ({ ...DEMO_WALLET, ...changes })

describe("portfolioOf", () => {
  it("returns exactly what the browser's fold gives", () => {
    for (const method of ["average", "fifo"] as const) {
      const positions = foldPositions(DEMO_WALLET.legs, method, DEMO_WALLET.prices)
      const portfolio = portfolioOf(DEMO_WALLET, method)
      assert.deepEqual(portfolio.totals, sumTotals(positions))
      assert.deepEqual(portfolio.positions.map((p) => p.values), positions.map((p) => p.values))
      assert.equal(portfolio.method, method)
    }
  })

  it("never gives a position a PnL when part of it is unknown", () => {
    const portfolio = portfolioOf(DEMO_WALLET, "average")
    const position = (asset: string) => portfolio.positions.find((p) => p.asset === asset)
    assert.equal(position("USDC")?.pnlUsdMicros, null)
    assert.equal(position("cbBTC")?.pnlUsdMicros, null)
    assert.equal(position("AERO")?.pnlUsdMicros, null, "AERO has a known cost, but no current price")
  })

  it("says the total is partial when it leaves something out", () => {
    const portfolio = portfolioOf(DEMO_WALLET, "average")
    assert.equal(portfolio.pnlStatus, "partial")
    assert.ok(portfolio.totals.excluded.length > 0)
  })

  it("says the total is unavailable when nothing in it is known", () => {
    const onlyUnknown = DEMO_WALLET.legs.filter((l) => l.asset === "cbBTC")
    const portfolio = portfolioOf(walletWith({ legs: onlyUnknown }), "average")
    assert.equal(portfolio.totals.pnlUsdMicros, null)
    assert.equal(portfolio.pnlStatus, "unavailable")
    assert.deepEqual(portfolio.points.map((p) => p.pnlUsdMicros), [null, null])
  })

  it("says the total is partial when gas couldn't be worked out, even with nothing excluded", () => {
    const portfolio = portfolioOf(walletWith({ legs: [], gasUnknownTxs: ["0xabc"] }), "average")
    assert.equal(portfolio.totals.excluded.length, 0)
    assert.equal(portfolio.pnlStatus, "partial")
  })

  it("treats a known zero as an answer", () => {
    const portfolio = portfolioOf(walletWith({ legs: [] }), "average")
    assert.equal(portfolio.totals.pnlUsdMicros, "0")
    assert.equal(portfolio.pnlStatus, "complete")
  })

  it("keeps the demo's early unknown points unknown, and explains them that way", () => {
    const portfolio = portfolioOf(DEMO_WALLET, "average")
    const first = portfolio.points[0]
    assert.equal(first?.pnlUsdMicros, null)
    const explanation = explainPortfolio(DEMO_WALLET, "average", { kind: "tx", txHash: first?.txHash as string })
    assert.equal(explanation?.value, null)
    assert.ok(portfolio.points.some((p) => p.pnlUsdMicros !== null))
  })

  it("gives no PnL to a position whose history is incomplete", () => {
    const leg = DEMO_WALLET.legs.find((l) => l.asset === "AERO" && BigInt(l.delta) > 0n) as (typeof DEMO_WALLET.legs)[number]
    const out = { ...leg, id: "out", delta: `-${BigInt(leg.delta) * 2n}`, kind: "transfer" as const, costUsdMicros: null, proceedsUsdMicros: null }
    const position = portfolioOf(walletWith({ legs: [leg, out] }), "average").positions[0]
    assert.ok(BigInt(position?.shortfallQty ?? "0") > 0n)
    assert.equal(position?.pnlUsdMicros, null)
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
    assert.equal(portfolio.positions[0]?.pnlUsdMicros, "0")
  })

  it("doesn't explain a total with nothing known in it as $0", () => {
    const wallet = walletWith({ legs: DEMO_WALLET.legs.filter((l) => l.asset === "cbBTC") })
    const pnl = explainPortfolio(wallet, "average", { kind: "total", metric: "pnl" })
    assert.equal(pnl?.value, null)
    assert.ok(pnl?.lines.every((line) => !line.includes("$0.00 ")))
    assert.ok(pnl?.lines.some((line) => line.includes("Not included: cbBTC")))
    assert.equal(explainPortfolio(wallet, "average", { kind: "total", metric: "value" })?.value, null)
    assert.equal(explainPortfolio(wallet, "average", { kind: "total", metric: "unrealized" })?.value, null)
  })

  it("still explains a total that's only partial, with its value", () => {
    assert.equal(explainPortfolio(DEMO_WALLET, "average", { kind: "total", metric: "pnl" })?.value, "+$74.28")
  })

  it("matches the files the Swift package reads", () => {
    assertMatchesFile("demo-portfolio.json", portfolioOf(DEMO_WALLET, "average"))
    assertMatchesFile("demo-explanation.json", explainPortfolio(DEMO_WALLET, "average", { kind: "asset", asset: "AERO", metric: "realized" }))
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
    const txHash = DEMO_WALLET.legs[0]?.txHash as string
    const { status, body } = await get(`/api/portfolio/demo/explain?tx=${txHash}`)
    assert.equal(status, 200)
    assert.ok((body as unknown as ExplanationResponse).legs.every((l) => l.txHash === txHash))
  })

  it("answers with what's wrong", async () => {
    assert.equal((await get("/api/portfolio/nope")).status, 400)
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
      usd: usd.map((micros) => ({ micros, usd: formatUsd(micros), signed: formatSignedUsd(micros) })),
      price: usd.filter((micros) => !micros.startsWith("-") && micros !== "0").map((micros) => ({ micros, price: formatPrice(micros) })),
      amount: units.map(([value, decimals]) => ({ units: value, decimals, amount: formatAmount(value, decimals), signed: formatSignedAmount(value, decimals) })),
      duration: [0, 30, 1800, 3599, 3600, 5400, 100000].map((blocks) => ({ blocks, duration: formatDuration(blocks) })),
    })
  })
})
