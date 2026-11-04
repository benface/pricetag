import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { after, before, describe, it } from "node:test"
import { ETH_ADDRESS, PRICE_NOTES, WETH_ADDRESS, buildPricedLegs, foldPositions, sumTotals, type LegRow } from "@pricetag/sdk/core"
import type { ExplanationResponse, PortfolioResponse, WalletResponse } from "../src/core/api.ts"
import { describeEffect, describeNetting } from "../src/core/explain.ts"
import { DEMO_WALLET, demoRates } from "../src/core/fixtures.ts"
import { formatAmount, formatDuration, formatPrice, formatSignedAmount, formatSignedMoney, formatMoney } from "../src/core/format.ts"
import * as wording from "../src/core/wording.ts"
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
      const positions = foldPositions(DEMO_WALLET.legs, method, DEMO_WALLET.prices, DEMO_WALLET)
      const portfolio = portfolioOf(DEMO_WALLET, method)
      assert.deepEqual(portfolio.totals, sumTotals(positions))
      assert.deepEqual(portfolio.positions.map((p) => p.values), positions.map((p) => p.values))
      assert.equal(portfolio.method, method)
    }
  })

  it("never gives a position a PnL when part of it is unknown", () => {
    const portfolio = portfolioOf(DEMO_WALLET, "average")
    const position = (asset: string) => portfolio.positions.find((p) => p.asset === asset)
    assert.equal(position("USDC")?.pnlMicros, null)
    assert.equal(position("cbBTC")?.pnlMicros, null)
    assert.equal(position("AERO")?.pnlMicros, null, "AERO has a known cost, but no current price")
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
    assert.equal(explainPortfolio(wallet, "average", { kind: "total", metric: "value" })?.value, null)
    assert.equal(explainPortfolio(wallet, "average", { kind: "total", metric: "unrealized" })?.value, null)
  })

  it("still explains a total that's only partial, with its value", () => {
    assert.equal(explainPortfolio(DEMO_WALLET, "average", { kind: "total", metric: "pnl" })?.value, "+$74.28")
  })

  it("matches the files the Swift package reads", () => {
    assertMatchesFile("demo-portfolio.json", portfolioOf(DEMO_WALLET, "average"))
    assertMatchesFile("demo-explanation.json", explainPortfolio(DEMO_WALLET, "average", { kind: "asset", asset: "AERO", metric: "realized" }))
    const inCad = walletWith({ currency: "CAD", rates: demoRates("CAD") })
    assertMatchesFile("demo-portfolio-cad.json", portfolioOf(inCad, "average"))
    assertMatchesFile("demo-explanation-cad.json", explainPortfolio(inCad, "average", { kind: "asset", asset: "AERO", metric: "realized" }))
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
      usd: usd.map((micros) => ({ micros, usd: formatMoney(micros, "USD"), signed: formatSignedMoney(micros, "USD") })),
      cad: usd.map((micros) => ({ micros, usd: formatMoney(micros, "CAD"), signed: formatSignedMoney(micros, "CAD") })),
      price: usd.filter((micros) => !micros.startsWith("-") && micros !== "0").map((micros) => ({ micros, price: formatPrice(micros, "USD"), cad: formatPrice(micros, "CAD") })),
      amount: units.map(([value, decimals]) => ({ units: value, decimals, amount: formatAmount(value, decimals), signed: formatSignedAmount(value, decimals) })),
      duration: [0, 30, 1800, 3599, 3600, 5400, 100000].map((blocks) => ({ blocks, duration: formatDuration(blocks) })),
    })
  })
})

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
    behind: [6, 14, 15, 50, 5400].map((blocks) => ({ blocks, text: wording.behindSentence(blocks) })),
    stale: wording.staleSentence("Nov 4 at 5:40 AM"),
    feedDetail: [wording.feedDetail("demo", 1000), wording.feedDetail("raw", 1000), wording.feedDetail("dataset", 1000)],
    pnlHelp: ["Total PnL", "AERO: Realized PnL", "Transaction 0x1234…abcd"].map((text) => ({ text, help: wording.pnlHelp(text) ?? null })),
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
    },
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
