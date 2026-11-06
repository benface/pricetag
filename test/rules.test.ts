import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { after, before, describe, it } from "node:test"
import { ASSETS, ETH_ADDRESS, PRICE_FEEDS, USDC_ADDRESS, type LegRow, type PriceFeed } from "@pricetag/sdk/core"
import type { BookPreview, PortfolioResponse, ProofResponse, VerificationResponse, WalletResponse } from "../src/core/api.ts"
import { costKey, emptyBook } from "../src/core/book.ts"
import { CAUTIOUS_RULE_ID, MARKET_RULE_ID, RULE_TEXT, fetchRules, readRules, ruleNote, type PricingRule, type RuleComparison } from "../src/core/rules.ts"
import { createApi } from "../server/app.ts"
import type { BlockData } from "../server/block.ts"
import { createProofs, type Proofs } from "../server/proof.ts"
import type { DepositDetails } from "../server/verify.ts"
import type { Source } from "@pricetag/sdk/internal"

const ME = "0x00000000000000000000000000000000000000aa"
const OTHER = "0x00000000000000000000000000000000000000bb"
const HEAD = 20
const ETH_ANSWER = 300_000_000_000n
const row = (tx: string, block: number, account: string, token: string, side: LegRow["side"], amount: string): LegRow => ({ block_num: block, timestamp: "2026-11-04T00:00:00.000Z", tx_hash: tx, tx_index: 1, log_index: 0, token, account, side, amount, kind: "erc20" })

// Bought 1 ETH for 3,000 USDC, and it had the USDC to start with.
const ROWS: Record<string, LegRow[]> = {
  [ME]: [row("0xa", 5, ME, USDC_ADDRESS, "credit", "3000000000"), row("0xb", 10, ME, USDC_ADDRESS, "debit", "3000000000"), row("0xb", 10, ME, ETH_ADDRESS, "credit", "1000000000000000000")],
  [OTHER]: [],
}

/** What a wallet's rows look like through one rule: the same rows, with ETH at this price. */
function sourceAt(ethAnswer: bigint, through = HEAD, reads: string[] = []): Source {
  const reference = (block_num: number) => ({ blockNum: block_num, ethUsd: ethAnswer.toString(), usdcUsd: "100000000" })
  return {
    mode: "dataset",
    startBlock: 1,
    historyFrom: null,
    head: async () => ({ blockNum: HEAD, timestamp: "2026-11-04T00:00:00.000Z" }),
    processedThrough: async (_, head) => Math.min(head, through),
    readWindow: async (address) => {
      reads.push(address)
      return { rows: ROWS[address] ?? [], priced: null, gasUnknown: [] }
    },
    readReferences: async (blocks) => blocks.map(reference),
    readLatestReference: async (head) => reference(head),
    readEthBalances: async () => new Map(),
    readBalances: async (address, block) => {
      const amounts: Record<string, string> = Object.fromEntries(ASSETS.map((asset) => [asset, "0"]))
      for (const r of ROWS[address] ?? []) {
        if (r.block_num > block) continue
        const asset = r.token === USDC_ADDRESS ? "USDC" : "ETH"
        amounts[asset] = (BigInt(amounts[asset] as string) + (r.side === "credit" ? BigInt(r.amount) : -BigInt(r.amount))).toString()
      }
      return { blockNum: block, amounts }
    },
  }
}

const NO_PROOFS: Proofs = { datasets: async () => [], priceBehind: async () => null, currentPriceBehind: async () => null, readBlock: async () => null }

const rule = (id: string): PricingRule => ({ id, ...RULE_TEXT[id]!, dataset: `a/${id}@0.0.1`, hash: "a".repeat(64) })

async function serve(forkThrough: number, forkReads: string[] = [], proofs: Proofs = NO_PROOFS): Promise<{ server: Server; base: string }> {
  const market = sourceAt(ETH_ANSWER)
  const cautious = sourceAt((ETH_ANSWER * 99n) / 100n, forkThrough, forkReads)
  const api = createApi({}, { source: market, readRates: async () => ({ byBlock: {}, latest: null }), proofs, rules: [{ rule: rule(MARKET_RULE_ID), source: market }, { rule: rule(CAUTIOUS_RULE_ID), source: cautious }] })
  const server = createServer((req, res) => void api(req, res))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

describe("comparing a token priced by its feed", () => {
  const DAI = "0x50c5725949a6f0c72e6c4a641f24049a917db0cb"
  const ONE = "1000000000000000000"
  const NOW = "2026-11-04T00:00:00.000Z"

  /** Holds 1 DAI, with a feed that says $1, as far as these tables have processed. */
  function daiSource(through: number, changes: Partial<Source> = {}): Source {
    const holding: LegRow = { ...row("0xd", 5, ME, DAI, "credit", ONE), account: ME }
    return {
      ...sourceAt(ETH_ANSWER, through),
      head: async () => ({ blockNum: 40, timestamp: NOW }),
      readWindow: async (_, from, to) => ({ rows: from <= 5 && to >= 5 ? [holding] : [], priced: null, gasUnknown: [] }),
      readBalances: async (_, block) => ({ blockNum: block, amounts: Object.fromEntries(ASSETS.map((asset) => [asset, asset === "DAI" && block >= 5 ? ONE : "0"])) }),
      marketReady: async () => true,
      readMarketTrades: async () => [],
      readFeedRounds: async (assets, blocks) => new Map(blocks.map((block) => [block, Object.fromEntries(assets.map((asset) => [asset, { answer: "100000000", updatedAt: Date.parse(NOW) / 1000 - 60, blockNum: block, timestamp: NOW }]))])),
      ...changes,
    }
  }

  async function valueRow(first: Source, second: Source) {
    const api = createApi({}, { source: first, readRates: async () => ({ byBlock: {}, latest: null }), proofs: NO_PROOFS, rules: [{ rule: rule(MARKET_RULE_ID), source: first }, { rule: rule(CAUTIOUS_RULE_ID), source: second }] })
    const server = createServer((req, res) => void api(req, res))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/portfolio/${ME}`
      const normal = (await (await fetch(base)).json()) as PortfolioResponse
      const response = await fetch(`${base}/compare`)
      const comparison = (await response.json()) as RuleComparison
      return { status: response.status, normal: normal.positions.find((p) => p.asset === "DAI"), value: comparison.rows.find((r) => r.label === "Value")!, comparison }
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  // Block 30 starts a new bucket, so the common block can be before what the first rule's refresh read.
  for (const [first, second] of [[31, 31], [31, 29]] as const) {
    it(`keeps it valued when the rules reach ${first} and ${second}`, async () => {
      const { status, normal, value } = await valueRow(daiSource(first), daiSource(second))
      assert.equal(status, 200)
      assert.equal(normal?.values.valueMicros, "1000000")
      assert.deepEqual([value.a, value.b, value.aPartial, value.bPartial], ["1000000", "1000000", false, false])
    })
  }

  it("says the value leaves it out, rather than $0, when the feed read fails during the comparison", async () => {
    let reads = 0
    const failsAfterTheRefresh: Partial<Source> = {
      readFeedRounds: async (assets, blocks) => {
        if (++reads > 1) throw new Error("boom")
        return new Map(blocks.map((block) => [block, Object.fromEntries(assets.map((asset) => [asset, { answer: "100000000", updatedAt: Date.parse(NOW) / 1000 - 60, blockNum: block, timestamp: NOW }]))]))
      },
    }
    const { status, normal, comparison } = await valueRow(daiSource(31, failsAfterTheRefresh), daiSource(29))
    assert.equal(status, 200)
    assert.equal(normal?.values.valueMicros, "1000000")
    const value = comparison.rows.find((r) => r.label === "Value")!
    assert.notEqual(value.a, "0")
    assert.equal(value.a, null, "nothing else is known, so there's no total at all")
    assert.equal(value.b, null, "both rules read through the same facts")
  })
})

describe("reading by a pricing rule", () => {
  let server: Server
  let base: string
  const forkReads: string[] = []
  before(async () => ({ server, base } = await serve(HEAD, forkReads)))
  after(() => server.close())
  const portfolio = async (query: string) => (await (await fetch(`${base}/api/portfolio/${ME}${query}`)).json()) as PortfolioResponse

  it("reads the first rule unless asked, and says which it read", async () => {
    assert.equal((await portfolio("")).rule, MARKET_RULE_ID)
  })

  it("the same wallet is worth less by the cautious rule, and only ETH changes", async () => {
    const [market, cautious] = [await portfolio(""), await portfolio(`?rule=${CAUTIOUS_RULE_ID}`)]
    assert.equal(cautious.rule, CAUTIOUS_RULE_ID)
    const eth = (p: PortfolioResponse) => p.positions.find((position) => position.asset === "ETH")!
    assert.equal(eth(market).values.valueMicros, "3000000000")
    assert.equal(eth(cautious).values.valueMicros, "2970000000")
    assert.equal(eth(market).values.costMicros, eth(cautious).values.costMicros, "it paid in USDC, whose price didn't change")
    assert.equal(eth(market).pnlMicros, "0")
    assert.equal(eth(cautious).pnlMicros, "-30000000")
  })

  it("says which rule is on when it explains a number, except for the default", async () => {
    const explain = async (query: string) => ((await (await fetch(`${base}/api/portfolio/${ME}/explain?metric=pnl${query}`)).json()) as { lines: string[] }).lines
    assert.ok((await explain(`&rule=${CAUTIOUS_RULE_ID}`)).includes(ruleNote(RULE_TEXT[CAUTIOUS_RULE_ID]!)))
    assert.ok(!(await explain("")).includes(ruleNote(RULE_TEXT[CAUTIOUS_RULE_ID]!)))
  })

  it("compares both at one block, and each number is what that rule shows", async () => {
    const response = await fetch(`${base}/api/portfolio/${ME}/compare`)
    assert.equal(response.status, 200)
    const comparison = (await response.json()) as RuleComparison
    const row = (label: string) => comparison.rows.find((r) => r.label === label)
    assert.equal(comparison.blockNum, HEAD)
    assert.deepEqual([comparison.a.id, comparison.b.id], [MARKET_RULE_ID, CAUTIOUS_RULE_ID])
    const whole = { aPartial: false, bPartial: false, aEstimated: false, bEstimated: false }
    assert.deepEqual(row("ETH price"), { label: "ETH price", format: "usdPrice", a: "3000000000", b: "2970000000", difference: "-30000000", ...whole })
    assert.deepEqual(row("Value"), { label: "Value", format: "money", a: "3000000000", b: "2970000000", difference: "-30000000", ...whole })
    // The USDC it paid with arrived with an unknown cost, so the total says it leaves that out.
    assert.deepEqual(row("Total PnL"), { label: "Total PnL", format: "signed", a: "0", b: "-30000000", difference: "-30000000", aPartial: true, bPartial: true, aEstimated: false, bEstimated: false })
    assert.ok(comparison.warnings.some((warning) => warning.includes("USDC")))
    assert.equal(comparison.changedTxs, 0, "it paid in USDC, so no cost changed")
  })

  it("reads linked wallets by the same rule", async () => {
    forkReads.length = 0
    await fetch(`${base}/api/portfolio/${ME}/compare?linked=${OTHER}`)
    assert.ok(forkReads.includes(OTHER))
    forkReads.length = 0
    await fetch(`${base}/api/portfolio/${ME}?rule=${CAUTIOUS_RULE_ID}&linked=${OTHER}`)
    assert.ok(!forkReads.includes(ME), "already read")
    assert.ok(!forkReads.includes(OTHER), "already read")
  })

  describe("with answers, which are posted", () => {
    const post = (path: string, body: object) => fetch(`${base}/api/portfolio/${ME}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "average", currency: "USD", ...body }) })
    const answered = { ...emptyBook(), costs: { [costKey(ME, "0xa:USDC")]: { micros: "3000000000", currency: "USD" as const } } }

    it("reads by the rule asked for, or the first", async () => {
      assert.equal(((await (await post("", {})).json()) as PortfolioResponse).rule, MARKET_RULE_ID)
      const cautious = (await (await post("", { rule: CAUTIOUS_RULE_ID })).json()) as PortfolioResponse
      assert.equal(cautious.rule, CAUTIOUS_RULE_ID)
      assert.equal(cautious.positions.find((position) => position.asset === "ETH")!.values.valueMicros, "2970000000")
    })

    it("refuses a rule this server doesn't have", async () => {
      assert.equal((await post("", { rule: "nope" })).status, 400)
    })

    it("previews and explains by that rule", async () => {
      const previews = async (rule?: string) => ((await (await post("/preview", { rule, candidates: [answered] })).json()) as { previews: BookPreview[] }).previews[0]!
      assert.equal((await previews()).pnlMicros, "0")
      assert.equal((await previews(CAUTIOUS_RULE_ID)).pnlMicros, "-30000000")
      const explained = (await (await fetch(`${base}/api/portfolio/${ME}/explain?metric=pnl`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "average", currency: "USD", rule: CAUTIOUS_RULE_ID, book: answered }) })).json()) as { lines: string[] }
      assert.ok(explained.lines.includes(ruleNote(RULE_TEXT[CAUTIOUS_RULE_ID]!)))
    })

    it("reads a linked wallet by that rule", async () => {
      await post("", { rule: CAUTIOUS_RULE_ID, linked: [OTHER] })
      const read = (await (await post("", { rule: CAUTIOUS_RULE_ID, linked: [OTHER] })).json()) as PortfolioResponse
      assert.deepEqual(read.linkedFailed, [])
      assert.deepEqual(read.linkedReading, [])
    })

    it("compares with the same answers as the main screen, on both sides", async () => {
      const comparison = (await (await post("/compare", { book: answered })).json()) as RuleComparison
      const total = comparison.rows.find((r) => r.label === "Total PnL")!
      assert.deepEqual([total.a, total.b, total.aPartial, total.bPartial], ["0", "-30000000", false, false], "the USDC's cost was answered, so nothing's left out")
    })

    it("refuses a bad compare", async () => {
      assert.equal((await post("/compare", { linked: ["nope"] })).status, 400)
    })
  })

  it("refuses a bad compare request", async () => {
    assert.equal((await fetch(`${base}/api/portfolio/${ME}/compare?linked=nope`)).status, 400)
    assert.equal((await fetch(`${base}/api/portfolio/demo/compare`)).status, 400)
  })
})

describe("the update behind a price, by a pricing rule", () => {
  // A real block with an AnswerUpdated log at index 2. This test's prices don't come from it, so only a rule's check can pass.
  const { block: data, deposits } = JSON.parse(readFileSync(new URL("./support/base-update-block.json", import.meta.url), "utf8")) as { block: BlockData; deposits: Record<string, DepositDetails> }
  const log = data.logs.find((candidate) => candidate.log_index === 2)!
  const tx = data.txs.find((candidate) => candidate.tx_index === log.tx_index)!
  const feed: PriceFeed = { ...PRICE_FEEDS[0], aggregators: [`0x${log.address}`] }
  const update = { block_num: Number(data.block.block_num), tx_hash: `0x${tx.tx_hash}`, log_index: 2, answer: BigInt(`0x${log.topics[1]}`).toString() }
  const proofs: Proofs = { datasets: async () => [], priceBehind: async () => ({ feed, update }), currentPriceBehind: async () => null, readBlock: async () => ({ data, deposits: new Map(Object.entries(deposits)), nodeHash: data.block.hash }) }
  const cautious = `&rule=${CAUTIOUS_RULE_ID}`
  let server: Server
  let base: string
  before(async () => ({ server, base } = await serve(HEAD, [], proofs)))
  after(() => server.close())
  const get = async <T>(path: string) => (await (await fetch(`${base}${path}`)).json()) as T
  const legOf = async (query: string) => encodeURIComponent((await get<WalletResponse>(`/api/wallet/${ME}${query}`)).legs.find((leg) => leg.asset === "ETH" && !leg.opening)!.id)
  const updateCheck = (verification: VerificationResponse) => verification.checks.find((check) => check.title === "Chainlink's update")

  it("checks the update, and doesn't hold the log to the rule's own price", async () => {
    const check = updateCheck(await get<VerificationResponse>(`/api/portfolio/${ME}/verify?leg=${await legOf(`?rule=${CAUTIOUS_RULE_ID}`)}${cautious}`))
    assert.equal(check?.status, "passed")
    assert.match(check?.detail ?? "", /the price this rule starts from/)
  })

  it("still holds the default rule's price to the log", async () => {
    assert.equal(updateCheck(await get<VerificationResponse>(`/api/portfolio/${ME}/verify?leg=${await legOf("")}`))?.status, "failed")
  })

  it("names the update, then the rule, and says the log has what the rule starts from", async () => {
    const proof = await get<ProofResponse>(`/api/portfolio/${ME}/proof?leg=${await legOf(`?rule=${CAUTIOUS_RULE_ID}`)}${cautious}`)
    assert.match(proof.source[0] as string, /in log #2/)
    assert.equal(proof.source.at(-1), ruleNote(RULE_TEXT[CAUTIOUS_RULE_ID]!))
    assert.ok(proof.scope.some((line) => /has to say the price this rule starts from/.test(line)))
  })
})

describe("proof by a pricing rule", () => {
  // A real block, which isn't this test's wallet's, so its result doesn't matter. Only that no rule changes it.
  const { block } = JSON.parse(readFileSync(new URL("./support/base-blocks.json", import.meta.url), "utf8")) as { block: BlockData }
  const MAIN_HASH = "c".repeat(64)
  const proofs: Proofs = {
    ...createProofs((async () => []) as never, { baseDataset: "a/base@0.0.1", dataset: { name: `a/${MARKET_RULE_ID}@0.0.1`, reference: `a/${MARKET_RULE_ID}@0.0.1`, hash: null }, readDeposits: async () => new Map(), readBlockHash: async () => null, readManifestHash: async () => MAIN_HASH }),
    readBlock: async () => ({ data: block, deposits: null, nodeHash: null }),
  }
  const NOTE = ruleNote(RULE_TEXT[CAUTIOUS_RULE_ID]!)
  let server: Server
  let base: string
  const forkReads: string[] = []
  before(async () => ({ server, base } = await serve(HEAD, forkReads, proofs)))
  after(() => server.close())
  const get = async <T>(path: string) => (await (await fetch(`${base}${path}`)).json()) as T
  const legOf = async (asset: string, query: string) => (await get<WalletResponse>(`/api/wallet/${ME}${query}`)).legs.find((leg) => leg.asset === asset && !leg.opening)!.id
  const proof = (leg: string, query = "") => get<ProofResponse>(`/api/portfolio/${ME}/proof?leg=${encodeURIComponent(leg)}${query}`)
  const cautious = `&rule=${CAUTIOUS_RULE_ID}`

  it("reads the wallet by the rule it's asked about", async () => {
    forkReads.length = 0
    const leg = await legOf("ETH", "")
    assert.ok(!forkReads.includes(ME), "the default doesn't read the fork")
    await proof(leg, cautious)
    assert.ok(forkReads.includes(ME))
  })

  it("says which rule set the price, and lists the fork's dataset next to the one it forks", async () => {
    const answer = await proof(await legOf("ETH", `?rule=${CAUTIOUS_RULE_ID}`), cautious)
    assert.ok(answer.source.includes(NOTE))
    assert.deepEqual(answer.datasets, [
      { title: "Prices, by Cautious ETH", name: `a/${CAUTIOUS_RULE_ID}@0.0.1`, hash: "a".repeat(64) },
      { title: "Activity, and the prices that rule starts from", name: `a/${MARKET_RULE_ID}@0.0.1`, hash: MAIN_HASH },
      { title: "Base's blocks", name: "a/base@0.0.1", hash: MAIN_HASH },
    ])
  })

  it("says the same on a price that rule doesn't change, and that it doesn't change it", async () => {
    const answer = await proof(await legOf("USDC", `?rule=${CAUTIOUS_RULE_ID}`), cautious)
    assert.match(answer.source[0] as string, /Chainlink's USDC\/USD price/)
    assert.ok(answer.source.includes(NOTE))
    assert.match(NOTE, /1% below Chainlink's price.*every other price is the same/)
  })

  it("says nothing about a rule when it's the default, asked for or not", async () => {
    const leg = await legOf("ETH", "")
    for (const query of ["", `&rule=${MARKET_RULE_ID}`]) {
      const answer = await proof(leg, query)
      assert.ok(!answer.source.some((line) => line.includes("pricing rule")))
      assert.deepEqual(answer.datasets.map(({ title }) => title), ["Prices and activity", "Base's blocks"])
    }
  })

  it("checks the same block the same way, because no rule changes a block", async () => {
    const leg = encodeURIComponent(await legOf("ETH", ""))
    const verification = await get<VerificationResponse>(`/api/portfolio/${ME}/verify?leg=${leg}`)
    assert.equal(verification.blockHash, `0x${block.block.hash}`)
    assert.deepEqual(await get<VerificationResponse>(`/api/portfolio/${ME}/verify?leg=${leg}${cautious}`), verification)
  })

  it("refuses a rule that isn't here", async () => {
    const leg = encodeURIComponent(await legOf("ETH", ""))
    assert.equal((await fetch(`${base}/api/portfolio/${ME}/proof?leg=${leg}&rule=nope`)).status, 400)
    assert.equal((await fetch(`${base}/api/portfolio/${ME}/verify?leg=${leg}&rule=nope`)).status, 400)
  })

  it("has no rule on the demo wallet, which isn't read through one", async () => {
    const leg = await get<WalletResponse>("/api/wallet/demo").then(({ legs }) => legs.find((candidate) => !candidate.opening)!.id)
    const answer = await get<ProofResponse>(`/api/portfolio/demo/proof?leg=${encodeURIComponent(leg)}${cautious}`)
    assert.ok(!answer.source.includes(NOTE))
    assert.deepEqual(answer.datasets, [])
  })
})

type Overrides = Partial<Source>

async function compareWith(a: Overrides, b: Overrides, { through = [HEAD, HEAD] as [number, number], query = "", readRates = async () => ({ byBlock: {}, latest: null }) as never } = {}) {
  const market = { ...sourceAt(ETH_ANSWER, through[0]), ...a }
  const cautious = { ...sourceAt((ETH_ANSWER * 99n) / 100n, through[1]), ...b }
  const api = createApi({}, { source: market, readRates, proofs: NO_PROOFS, rules: [{ rule: rule(MARKET_RULE_ID), source: market }, { rule: rule(CAUTIOUS_RULE_ID), source: cautious }] })
  const server = createServer((req, res) => void api(req, res))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/portfolio/${ME}/compare${query}`)
  server.close()
  return { status: response.status, body: (await response.json()) as RuleComparison & { error?: string } }
}

const valueRow = (comparison: RuleComparison) => comparison.rows.find((r) => r.label === "ETH value")!

describe("comparing a token only its trades price", () => {
  const AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631"
  const HOLDING = (100n * 10n ** 18n).toString()
  const USDC_HELD = "1000000000"
  const LATER = 61
  const trades = (usdMicros: string): NonNullable<Source["readMarketTrades"]> => async (asset, _from, to) => [1, 2, 3].map((n) => ({ blockNum: to - n, txHash: `0x${n}`, asset, usdMicros, notionalUsdMicros: "500000000" }))
  // It received 100 AERO in a plain transfer, so a market price is all that values it. It holds them, and 1,000 USDC.
  const holder = (readMarketTrades: NonNullable<Source["readMarketTrades"]>): Overrides => ({
    head: async () => ({ blockNum: LATER, timestamp: "2026-11-04T00:00:00.000Z" }),
    readWindow: async () => ({ rows: [row("0xa", 5, ME, AERO, "credit", HOLDING), row("0xa", 5, ME, USDC_ADDRESS, "credit", USDC_HELD)], priced: null, gasUnknown: [] }),
    readBalances: async (_, block) => ({ blockNum: block, amounts: { ...Object.fromEntries(ASSETS.map((asset) => [asset, "0"])), AERO: block >= 5 ? HOLDING : "0", USDC: block >= 5 ? USDC_HELD : "0" } }),
    marketReady: async () => true,
    readMarketTrades,
  })
  const market = holder(trades("1300000"))
  const cautious = holder(trades("1287000"))
  const label = (comparison: RuleComparison, name: string) => comparison.rows.find((r) => r.label === name)

  for (const through of [[59, LATER], [LATER, 59]] as [number, number][]) {
    it(`prices both at the common block when they read either side of a price's bucket, at ${through.join(" and ")}`, async () => {
      const { status, body } = await compareWith(market, cautious, { through })
      assert.equal(status, 200)
      assert.equal(body.blockNum, 59)
      const none = { aPartial: false, bPartial: false }
      assert.deepEqual(label(body, "AERO value"), { label: "AERO value", format: "money", a: "130000000", b: "128700000", difference: "-1300000", ...none, aEstimated: true, bEstimated: true })
      assert.deepEqual(label(body, "Value"), { label: "Value", format: "money", a: "1130000000", b: "1128700000", difference: "-1300000", ...none, aEstimated: true, bEstimated: true })
      assert.ok(body.warnings.every((w) => !w.startsWith("Market price:") && !w.startsWith("Cautious ETH:")), "both sides say the same")
    })
  }

  const leftOut = (body: RuleComparison) => {
    assert.equal(label(body, "AERO value"), undefined)
    const value = label(body, "Value")!
    assert.deepEqual([value.a, value.b, value.difference], ["1000000000", "1000000000", "0"], "only what both can value")
    assert.deepEqual([value.aPartial, value.bPartial], [true, true])
    assert.ok(body.warnings.some((w) => w.includes("AERO (no current price)")))
    assert.ok(body.warnings.every((w) => !w.startsWith("Market price:") && !w.startsWith("Cautious ETH:")), "both sides say the same")
  }
  const thin: NonNullable<Source["readMarketTrades"]> = async () => []
  const failing: NonNullable<Source["readMarketTrades"]> = async () => {
    throw new Error("no")
  }

  it("leaves a token out on both sides when the other rule's trades don't back a price", async () => {
    const { status, body } = await compareWith(market, holder(thin))
    assert.equal(status, 200)
    leftOut(body)
    assert.equal(body.changedTxs, 0)
  })

  it("leaves a token out on both sides when the first rule has no price and the other does", async () => {
    const { status, body } = await compareWith(holder(thin), cautious)
    assert.equal(status, 200)
    leftOut(body)
    assert.equal(body.changedTxs, 0)
  })

  it("leaves a token out on both sides when one rule's read of it fails", async () => {
    const { status, body } = await compareWith(market, holder(failing))
    assert.equal(status, 200)
    leftOut(body)
    assert.equal(body.changedTxs, 0)
  })

  it("a price only one rule has for what moved isn't a change in its cost", async () => {
    // AERO for DEGEN, with no feed on either side, so what left is worth its market price, and that's what DEGEN cost.
    const DEGEN = "0x4ed4e862860bed51a9570b96d89af5e1b0efefed"
    const swap: Overrides = { readWindow: async () => ({ rows: [row("0xa", 5, ME, AERO, "credit", HOLDING), row("0xb", 7, ME, AERO, "debit", HOLDING), row("0xb", 7, ME, DEGEN, "credit", HOLDING)], priced: null, gasUnknown: [] }) }
    const onlyTheHead: NonNullable<Source["readMarketTrades"]> = async (asset, from, to) => (to === 0 ? [] : trades("1287000")(asset, from, to))
    const both = await compareWith({ ...market, ...swap }, { ...cautious, ...swap }, { through: [59, 59] })
    assert.equal(both.status, 200)
    assert.equal(both.body.changedTxs, 1, "both have one, so this is the rule")
    const { status, body } = await compareWith({ ...market, ...swap }, { ...holder(onlyTheHead), ...swap }, { through: [59, 59] })
    assert.equal(status, 200)
    assert.equal(body.changedTxs, 0)
    assert.equal(label(body, "DEGEN cost"), undefined)
  })

  it("says the same when neither rule has a market for it", async () => {
    const { status, body } = await compareWith(holder(thin), holder(thin))
    assert.equal(status, 200)
    assert.equal(label(body, "AERO value"), undefined)
    assert.ok(body.warnings.every((w) => !w.startsWith("Market price:") && !w.startsWith("Cautious ETH:")))
  })
})

describe("comparing only ever shows the rule", () => {
  it("compares at the older block when one rule is behind", async () => {
    const { status, body } = await compareWith({}, {}, { through: [HEAD, 15] })
    assert.equal(status, 200)
    assert.equal(body.blockNum, 15)
  })

  it("leaves out what moved after that block, on both sides", async () => {
    const { status, body } = await compareWith({}, {}, { through: [HEAD, 7] })
    assert.equal(status, 200)
    assert.equal(body.blockNum, 7)
    assert.ok(!body.rows.some((r) => r.label.startsWith("ETH ") && r.label !== "ETH price"), "it hadn't bought the ETH by block 7")
  })

  it("an internal ETH transfer after the common block isn't a difference between the rules", async () => {
    // It's in the balance from block 18, with no row saying so, because there are no traces.
    const balances = (base: Source["readBalances"]): Source["readBalances"] => async (address, block) => {
      const read = await base(address, block)
      return block >= 18 && read ? { ...read, amounts: { ...read.amounts, ETH: (BigInt(read.amounts.ETH as string) + 10n ** 18n).toString() } } : read
    }
    const { readBalances } = sourceAt(ETH_ANSWER)
    const { status, body } = await compareWith({ readBalances: balances(readBalances) }, { readBalances: balances(readBalances) }, { through: [HEAD, 15] })
    assert.equal(status, 200)
    assert.equal(body.blockNum, 15)
    assert.deepEqual([valueRow(body).a, valueRow(body).b, valueRow(body).difference], ["3000000000", "2970000000", "-30000000"])
  })

  it("reads exchange rates once, so a rate that moves between reads isn't a difference", async () => {
    let answer = 70_000_000n
    let reads = 0
    const readRates = async (_currency: unknown, wallet: { latest: { blockNum: number } }) => {
      reads++
      answer += 1_000_000n
      const round = { answer: answer.toString(), updatedAt: Date.parse("2026-11-04T00:00:00.000Z") / 1000 }
      return { byBlock: Object.fromEntries([5, 10].map((block) => [block, round])), latest: { blockNum: wallet.latest.blockNum, round } }
    }
    const { status, body } = await compareWith({}, {}, { query: "?currency=CAD", readRates: readRates as never })
    assert.equal(status, 200)
    assert.equal(reads, 1)
    assert.equal(body.currency, "CAD")
    assert.equal(body.rows.find((r) => r.label === "ETH price")?.format, "usdPrice")
    const row = valueRow(body)
    assert.equal(((BigInt(row.a!) * 99n) / 100n - BigInt(row.b!)) ** 2n <= 1n, true, "the only difference is the 1%")
  })

  it("tells the rates the chain's head when it compares at an earlier block", async () => {
    const seen: [number, number | undefined][] = []
    const readRates = async (_currency: unknown, wallet: { latest: { blockNum: number } }, options?: { chainHead?: number }) => {
      seen.push([wallet.latest.blockNum, options?.chainHead])
      return { byBlock: {}, latest: null }
    }
    const { status } = await compareWith({}, {}, { through: [HEAD - 1, HEAD], query: "?currency=CAD", readRates: readRates as never })
    assert.equal(status, 200)
    assert.deepEqual(seen, [[HEAD - 1, HEAD]])
  })

  it("a balance read that fails for one rule's own reads changes nothing", async () => {
    const { status, body } = await compareWith({}, { readBalances: async () => null })
    assert.equal(status, 200)
    assert.deepEqual([valueRow(body).a, valueRow(body).b], ["3000000000", "2970000000"])
  })

  it("a balance read that fails on the shared facts fails for both, with no difference that isn't the rule", async () => {
    let reads = 0
    const { readBalances } = sourceAt(ETH_ANSWER)
    const failsAtTheCommonBlock: Source["readBalances"] = async (address, block) => {
      reads++
      return block === 15 ? null : readBalances(address, block)
    }
    const { status, body } = await compareWith({ readBalances: failsAtTheCommonBlock }, {}, { through: [HEAD, 15] })
    assert.ok(reads > 0)
    assert.equal(status, 200)
    const pnl = body.rows.find((r) => r.label === "Total PnL")!
    assert.equal(pnl.aPartial, pnl.bPartial)
    assert.ok(body.warnings.every((w) => !w.startsWith("Market price:") && !w.startsWith("Cautious ETH:")), "both sides say the same")
  })

  it("won't compare when one rule has no current price at that block", async () => {
    const { status, body } = await compareWith({}, { readLatestReference: async () => null })
    assert.equal(status, 409)
    assert.match(body.error!, /same block/)
  })

  it("won't compare when the rules' current prices are from different blocks", async () => {
    const { status } = await compareWith({}, { readLatestReference: async (head) => ({ blockNum: head - 1, ethUsd: "1", usdcUsd: "1" }) })
    assert.equal(status, 409)
  })

  it("won't compare when the two read different transactions, as after a reorg", async () => {
    const { status, body } = await compareWith({}, { readWindow: async () => ({ rows: [], priced: null, gasUnknown: [] }) })
    assert.equal(status, 409)
    assert.match(body.error!, /same block/)
  })

  it("won't compare when a transaction is at another block on one side, with the same hash and amounts", async () => {
    const moved = (ROWS[ME] as LegRow[]).map((r) => (r.tx_hash === "0xb" ? { ...r, block_num: r.block_num + 1 } : r))
    // The same prices on both sides, so nothing here could be the rule.
    const { status, body } = await compareWith({}, { readWindow: async () => ({ rows: moved, priced: null, gasUnknown: [] }), readReferences: sourceAt(ETH_ANSWER).readReferences, readLatestReference: sourceAt(ETH_ANSWER).readLatestReference })
    assert.equal(status, 409)
    assert.match(body.error!, /same block/)
    assert.equal(body.rows, undefined)
  })

  it("won't compare when a transaction's place in its block differs on one side", async () => {
    const moved = (ROWS[ME] as LegRow[]).map((r) => ({ ...r, tx_index: r.tx_index + 1 }))
    const { status } = await compareWith({}, { readWindow: async () => ({ rows: moved, priced: null, gasUnknown: [] }) })
    assert.equal(status, 409)
  })

  it("won't compare when one side has no price at a block the wallet moved in, because that isn't the rule either", async () => {
    const { status, body } = await compareWith({}, { readReferences: async () => [] })
    assert.equal(status, 409)
    assert.equal(body.rows, undefined)
  })

  it("answers with the failure when a price or a rate can't be read, and shows no numbers", async () => {
    const broken = await compareWith({}, { readLatestReference: async () => { throw new Error("no") } })
    assert.equal(broken.status, 502)
    const rates = await compareWith({}, {}, { query: "?currency=CAD", readRates: (async () => { throw new Error("no") }) as never })
    assert.equal(rates.status, 502)
    assert.equal(rates.body.rows, undefined)
  })
})

describe("reading the list of rules", () => {
  const answer = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "application/json" } })
  const rule = { id: MARKET_RULE_ID, name: "Market price", summary: "", dataset: "benface/pricetag", hash: "abc" }

  it("gives the rules the server lists, including none", async () => {
    assert.deepEqual(await readRules(answer(200, JSON.stringify({ rules: [rule] }))), [rule])
    assert.deepEqual(await readRules(answer(200, JSON.stringify({ rules: [] }))), [])
  })

  // `useRules` keeps its empty list when this throws. A list that came back undefined blanked the whole app.
  it("fails on a refusal, a page or an answer with no list, so the app keeps rendering", async () => {
    await assert.rejects(readRules(answer(401, JSON.stringify({ error: "This server needs an invite." }))))
    await assert.rejects(readRules(answer(429, JSON.stringify({ error: "Slow down." }))))
    await assert.rejects(readRules(answer(502, "<html>Bad gateway</html>")))
    await assert.rejects(readRules(answer(200, JSON.stringify({ error: "No rules." }))))
  })

  it("is how the app asks for them", async () => {
    const asked: string[] = []
    const send = (async (url: string) => (asked.push(url), answer(200, JSON.stringify({ rules: [rule] })))) as unknown as typeof fetch
    assert.deepEqual(await fetchRules(new AbortController().signal, send), [rule])
    assert.deepEqual(asked, ["/api/rules"])
    await assert.rejects(fetchRules(new AbortController().signal, (async () => answer(401, "{}")) as unknown as typeof fetch))
  })
})
