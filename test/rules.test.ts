import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { after, before, describe, it } from "node:test"
import { ASSETS, ETH_ADDRESS, USDC_ADDRESS, type LegRow } from "@pricetag/sdk/core"
import type { PortfolioResponse } from "../src/core/api.ts"
import { CAUTIOUS_RULE_ID, MARKET_RULE_ID, RULE_TEXT, ruleNote, type PricingRule, type RuleComparison } from "../src/core/rules.ts"
import { createApi } from "../server/app.ts"
import type { Source } from "../server/source.ts"

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
  const reference = (block_num: number) => ({ block_num, eth_usd: ethAnswer.toString(), usdc_usd: "100000000" })
  return {
    mode: "dataset",
    startBlock: 1,
    historyBlocks: null,
    head: async () => ({ blockNum: HEAD, timestamp: "2026-11-04T00:00:00.000Z" }),
    processedThrough: async (_, head) => Math.min(head, through),
    readWindow: async (address) => {
      reads.push(address)
      return { rows: ROWS[address] ?? [], priced: null, gasUnknownTxs: [] }
    },
    readReferences: async (blocks) => blocks.map(reference),
    readLatestReference: async (head) => reference(head),
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

const rule = (id: string): PricingRule => ({ id, ...RULE_TEXT[id]!, dataset: `a/${id}@0.0.1`, hash: "a".repeat(64) })

async function serve(forkThrough: number, forkReads: string[] = []): Promise<{ server: Server; base: string }> {
  const market = sourceAt(ETH_ANSWER)
  const cautious = sourceAt((ETH_ANSWER * 99n) / 100n, forkThrough, forkReads)
  const api = createApi({}, { source: market, readRates: async () => ({ byBlock: {}, latest: null }), rules: [{ rule: rule(MARKET_RULE_ID), source: market }, { rule: rule(CAUTIOUS_RULE_ID), source: cautious }] })
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
    assert.deepEqual(row("ETH price"), { label: "ETH price", format: "usdPrice", a: "3000000000", b: "2970000000", difference: "-30000000" })
    assert.deepEqual(row("Value"), { label: "Value", format: "money", a: "3000000000", b: "2970000000", difference: "-30000000" })
    assert.deepEqual(row("Total PnL"), { label: "Total PnL", format: "signed", a: "0", b: "-30000000", difference: "-30000000" })
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

describe("comparing while one rule is behind", () => {
  it("won't compare when the wallet moved in blocks only one has read, because the difference wouldn't be the rule", async () => {
    const { server, base } = await serve(7)
    const response = await fetch(`${base}/api/portfolio/${ME}/compare`)
    server.close()
    assert.equal(response.status, 409)
    assert.match(((await response.json()) as { error: string }).error, /same block/)
  })

  it("compares at the older block when nothing moved after it", async () => {
    const { server, base } = await serve(15)
    const response = await fetch(`${base}/api/portfolio/${ME}/compare`)
    server.close()
    assert.equal(response.status, 200)
    assert.equal(((await response.json()) as RuleComparison).blockNum, 15)
  })
})
