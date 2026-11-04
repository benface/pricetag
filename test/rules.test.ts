import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { after, before, describe, it } from "node:test"
import { ASSETS, ETH_ADDRESS, USDC_ADDRESS, type LegRow } from "@pricetag/sdk/core"
import type { PortfolioResponse } from "../src/core/api.ts"
import { CAUTIOUS_RULE_ID, MARKET_RULE_ID, RULE_TEXT, ruleNote, type PricingRule, type RuleComparison } from "../src/core/rules.ts"
import { createApi } from "../server/app.ts"
import type { Proofs } from "../server/proof.ts"
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
    historyBlocks: null,
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

const NO_PROOFS: Proofs = { datasets: async () => [], priceBehind: async () => null, readBlock: async () => null }

const rule = (id: string): PricingRule => ({ id, ...RULE_TEXT[id]!, dataset: `a/${id}@0.0.1`, hash: "a".repeat(64) })

async function serve(forkThrough: number, forkReads: string[] = []): Promise<{ server: Server; base: string }> {
  const market = sourceAt(ETH_ANSWER)
  const cautious = sourceAt((ETH_ANSWER * 99n) / 100n, forkThrough, forkReads)
  const api = createApi({}, { source: market, readRates: async () => ({ byBlock: {}, latest: null }), proofs: NO_PROOFS, rules: [{ rule: rule(MARKET_RULE_ID), source: market }, { rule: rule(CAUTIOUS_RULE_ID), source: cautious }] })
  const server = createServer((req, res) => void api(req, res))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

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
    const whole = { aPartial: false, bPartial: false }
    assert.deepEqual(row("ETH price"), { label: "ETH price", format: "usdPrice", a: "3000000000", b: "2970000000", difference: "-30000000", ...whole })
    assert.deepEqual(row("Value"), { label: "Value", format: "money", a: "3000000000", b: "2970000000", difference: "-30000000", ...whole })
    // The USDC it paid with arrived with an unknown cost, so the total says it leaves that out.
    assert.deepEqual(row("Total PnL"), { label: "Total PnL", format: "signed", a: "0", b: "-30000000", difference: "-30000000", aPartial: true, bPartial: true })
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

  it("refuses a bad compare request", async () => {
    assert.equal((await fetch(`${base}/api/portfolio/${ME}/compare?linked=nope`)).status, 400)
    assert.equal((await fetch(`${base}/api/portfolio/demo/compare`)).status, 400)
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
