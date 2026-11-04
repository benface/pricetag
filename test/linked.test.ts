import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { ASSETS, ETH_ADDRESS, buildPricedLegs, foldPositions, type LegPart, type LegRow, type Method, type PricedLeg } from "@pricetag/sdk/core"
import { createApi } from "../server/app.ts"
import { portfolioOf } from "../server/portfolio.ts"
import type { Source } from "@pricetag/sdk/internal"
import { unlistedTokens } from "@pricetag/sdk/internal"
import type { PortfolioResponse, WalletResponse } from "../src/core/api.ts"
import { DEMO_WALLET } from "../src/core/fixtures.ts"

const HOT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const COLD = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const NEXT = "0xcccccccccccccccccccccccccccccccccccccccc"
const ONE = 10n ** 18n

let block = 100
function leg(tx: string, delta: bigint, changes: Partial<PricedLeg> = {}): PricedLeg {
  block += 1
  return {
    id: `${tx}:ETH`,
    asset: "ETH",
    delta: delta.toString(),
    decimals: 18,
    kind: "transfer",
    priceMicros: "3000000000",
    priceSource: "oracle",
    priceNote: null,
    costMicros: null,
    proceedsMicros: null,
    costLabel: "unknown",
    blockNum: block,
    timestamp: "2026-11-04T00:00:00.000Z",
    txHash: tx,
    txIndex: 1,
    parts: [],
    ...changes,
  }
}
/** What a real row says about a plain ETH transfer: who was on the other side. */
const moved = (tx: string, account: string, side: LegPart["side"], amount: bigint, counterparty: string): LegPart => ({ logIndex: 0, token: ETH_ADDRESS, account, side, amount: amount.toString(), kind: "eth", counterparty })
const bought = (tx: string, qty: bigint, cost: number) => leg(tx, qty, { kind: "swap", costLabel: "paid", costMicros: String(cost * 1_000_000) })
const sameBlock = (a: PricedLeg, b: PricedLeg): PricedLeg => ({ ...b, blockNum: a.blockNum })

/** A wallet the chain agrees with, since a balance that doesn't match makes every cost unconfirmed. */
function walletOf(address: string, legs: PricedLeg[], changes: Partial<WalletResponse> = {}): WalletResponse {
  const amounts: Record<string, string> = {}
  for (const l of legs) amounts[l.asset] = (BigInt(amounts[l.asset] ?? 0) + BigInt(l.delta)).toString()
  return { ...DEMO_WALLET, address, legs, balances: { blockNum: DEMO_WALLET.coverage.toBlock, amounts }, ...changes }
}

const ethOf = (portfolio: PortfolioResponse) => portfolio.positions.find((p) => p.asset === "ETH")

describe("linked wallets in a portfolio", () => {
  it("only touches the wallet being read, and a portfolio folds it as inherited", () => {
    const buy = bought("0x1", ONE, 3000)
    const out = leg("0x2", -ONE, { parts: [moved("0x2", HOT, "debit", ONE, COLD)] })
    const hot = walletOf(HOT, [buy, out])
    const cold = walletOf(COLD, [sameBlock(out, leg("0x2", ONE, { parts: [moved("0x2", COLD, "credit", ONE, HOT)] }))])
    assert.equal(ethOf(portfolioOf(cold, "average", [hot]))?.values.costMicros, "3000000000")
    assert.equal(ethOf(portfolioOf(cold, "average"))?.values.costMicros, null)
  })

  it("keeps the rate from when it was bought, not from when it moved", () => {
    const buy = bought("0x1", ONE, 3000)
    const out = leg("0x2", -ONE, { parts: [moved("0x2", HOT, "debit", ONE, COLD)] })
    const credit = sameBlock(out, leg("0x2", ONE, { parts: [moved("0x2", COLD, "credit", ONE, HOT)] }))
    const updatedAt = Date.parse(buy.timestamp) / 1000
    const rates = (legs: PricedLeg[], answers: Record<number, string>) => ({
      currency: "CAD" as const,
      rates: {
        byBlock: Object.fromEntries(legs.map((l) => [l.blockNum, { answer: answers[l.blockNum] ?? "75000000", updatedAt }])),
        latest: { blockNum: 1, round: { answer: "75000000", updatedAt } },
      },
    })
    // A Canadian dollar is worth 0.50 USD when the ETH is bought, and 0.75 when it moves.
    const hot = walletOf(HOT, [buy, out], rates([buy, out], { [buy.blockNum]: "50000000" }))
    const cold = walletOf(COLD, [credit], rates([credit], {}))
    assert.equal(ethOf(portfolioOf(cold, "average", [hot]))?.values.costMicros, "6000000000")
  })
})

describe("outgoingTxs", () => {
  it("ignores a zero-value transfer, which anyone can make in this wallet's name to poison its history", () => {
    const row = { block_num: 1, timestamp: "2026-11-04T00:00:00.000Z", tx_hash: "0xbad", tx_index: 0, log_index: 0, token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", account: HOT, side: "debit" as const, amount: "0", kind: "erc20" as const }
    const legs = buildPricedLegs({ account: HOT, rows: [row], references: [], priced: [] })
    assert.deepEqual(portfolioOf({ ...DEMO_WALLET, address: HOT, legs }, "average").outgoingTxs, [])
  })

  it("lists what left or paid gas, including gas it couldn't work out, and not what only arrived", () => {
    const wallet = { ...DEMO_WALLET, address: HOT, legs: [leg("0x1", ONE), leg("0x2", -ONE), leg("0x3", -1n, { kind: "gas" })], gasUnknownTxs: ["0x4"] }
    assert.deepEqual(portfolioOf(wallet, "average").outgoingTxs, ["0x2", "0x3", "0x4"])
  })
})

describe("unlistedTokens", () => {
  const row = (token: string, side: "credit" | "debit", amount: string, kind: "unlisted" | "unlisted_nft" | "erc20" = "unlisted", account = HOT) => ({
    block_num: 1,
    timestamp: "",
    tx_hash: "0x1",
    tx_index: 0,
    log_index: 0,
    token,
    account,
    side,
    amount,
    kind,
  })

  it("lists what's held off the allowlist, and nothing that's gone, on the allowlist or someone else's", () => {
    const rows = [
      row("0x1", "credit", "5"),
      row("0x2", "credit", "5"),
      row("0x2", "debit", "5"),
      row("0x3", "credit", "12", "unlisted_nft"),
      row("0x4", "credit", ""),
      row("0x5", "credit", "5", "erc20"),
      row("0x6", "credit", "5", "unlisted", COLD),
    ]
    assert.deepEqual(unlistedTokens(rows, HOT), [
      { token: "0x1", transfers: 1 },
      { token: "0x3", transfers: 1 },
      { token: "0x4", transfers: 1 },
    ])
  })
})

describe("the portfolio endpoint with linked wallets", () => {
  const row = (block: number, tx: string, account: string, side: "credit" | "debit", amount: bigint): LegRow => ({
    block_num: block,
    timestamp: "2026-11-04T00:00:00.000Z",
    tx_hash: tx,
    tx_index: 1,
    log_index: 0,
    token: ETH_ADDRESS,
    account,
    side,
    amount: amount.toString(),
    kind: "eth",
  })
  const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
  // The hot wallet buys 1 ETH with 3,000 USDC, then sends it to savings.
  const rows: Record<string, LegRow[]> = {
    [HOT]: [
      row(10, "0x1", HOT, "credit", ONE),
      { ...row(10, "0x1", HOT, "debit", 3_000_000_000n), token: USDC, kind: "erc20" },
      { ...row(11, "0x2", HOT, "debit", ONE), counterparty: COLD },
    ],
    [COLD]: [{ ...row(11, "0x2", COLD, "credit", ONE), counterparty: HOT }],
  }
  const source: Source = {
    mode: "raw",
    startBlock: 1,
    historyFrom: null,
    head: async () => ({ blockNum: 20, timestamp: "2026-11-04T00:00:00.000Z" }),
    processedThrough: async (_, head) => head,
    readWindow: async (address) => ({ rows: rows[address] ?? [], priced: null, gasUnknown: [] }),
    readReferences: async (blocks) => blocks.map((block_num) => ({ blockNum: block_num, ethUsd: "300000000000", usdcUsd: "100000000" })),
    readLatestReference: async () => ({ blockNum: 20, ethUsd: "400000000000", usdcUsd: "100000000" }),
    readEthBalances: async () => new Map(),
    readBalances: async (address, block) => {
      const amounts: Record<string, string> = Object.fromEntries(ASSETS.map((asset) => [asset, "0"]))
      for (const r of rows[address] ?? []) {
        if (r.block_num > block) continue
        const asset = r.token === USDC ? "USDC" : "ETH"
        amounts[asset] = (BigInt(amounts[asset] as string) + (r.side === "credit" ? BigInt(r.amount) : -BigInt(r.amount))).toString()
      }
      return { blockNum: block, amounts }
    },
  }
  let server: Server
  let base: string
  before(async () => {
    const api = createApi({}, { source, readRates: async () => ({ byBlock: {}, latest: null }), proofs: { datasets: async () => [], priceBehind: async () => null, readBlock: async () => null } })
    server = createServer((req, res) => void api(req, res))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(() => server.close())
  const eth = async (query: string) => {
    const body = (await (await fetch(`${base}/api/portfolio/${COLD}${query}`)).json()) as PortfolioResponse
    return body.positions.find((p) => p.asset === "ETH")
  }

  it("leaves a transfer's cost unknown without them", async () => {
    assert.equal((await eth(""))?.values.costMicros, null)
  })

  it("carries over what the sender paid with them", async () => {
    const position = await eth(`?linked=${HOT}`)
    assert.equal(position?.values.costMicros, "3000000000")
    assert.equal(position?.values.unrealizedMicros, "1000000000")
    const explained = (await (await fetch(`${base}/api/portfolio/${COLD}/explain?asset=ETH&metric=value&linked=${HOT}`)).json()) as { legs: { costLabel: string }[] }
    assert.deepEqual(explained.legs.map((l) => l.costLabel), ["inherited"])
  })

  it("takes the client's own wallets on a post too, and doesn't count them as answers", async () => {
    const post = async (body: unknown) => (await (await fetch(`${base}/api/portfolio/${COLD}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as PortfolioResponse
    await post({ method: "average", linked: [HOT] })
    // A linked wallet's first read doesn't hold up the number, so it's there by the next one.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const portfolio = await post({ method: "average", linked: [HOT] })
    assert.equal(portfolio.positions.find((p) => p.asset === "ETH")?.values.costMicros, "3000000000")
    assert.equal(portfolio.meter.answered, 0)
    assert.deepEqual(portfolio.linkedReading, [])
  })

  it("refuses a linked list it can't read", async () => {
    const response = await fetch(`${base}/api/portfolio/${COLD}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "average", linked: ["nope"] }) })
    assert.equal(response.status, 400)
  })

  describe("a linked wallet that can't be read", () => {
    let broken = true
    const flaky: Source = {
      ...source,
      readWindow: async (address) => {
        if (address === HOT && broken) throw new Error("nope")
        return { rows: rows[address] ?? [], priced: null, gasUnknown: [] }
      },
    }
    let other: Server
    let url: string
    before(async () => {
      const api = createApi({}, { source: flaky, readRates: async () => ({ byBlock: {}, latest: null }), proofs: { datasets: async () => [], priceBehind: async () => null, readBlock: async () => null } })
      other = createServer((req, res) => void api(req, res))
      await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve))
      url = `http://127.0.0.1:${(other.address() as AddressInfo).port}`
    })
    after(() => other.close())
    const settle = () => new Promise((resolve) => setTimeout(resolve, 50))
    const post = async (path: string, body: unknown) => (await fetch(`${url}/api/portfolio/${COLD}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()

    it("says it's reading at first, then that it failed, then recovers", async () => {
      const first = (await post("", { method: "average", linked: [HOT] })) as PortfolioResponse
      assert.deepEqual([first.linkedReading, first.linkedFailed], [[HOT], []], "a first read doesn't hold up the number")
      assert.equal(first.positions.find((p) => p.asset === "ETH")?.values.costMicros, null)
      await settle()

      const second = (await post("", { method: "average", linked: [HOT] })) as PortfolioResponse
      assert.deepEqual([second.linkedReading, second.linkedFailed], [[], [HOT]], "it isn't still reading: it failed")
      assert.equal(second.meter.waiting, 1, "so nothing's balanced")
      assert.equal(second.positions.find((p) => p.asset === "ETH")?.values.costMicros, null, "and the cost stays unknown")
      const previews = (await post("/preview", { method: "average", linked: [HOT], candidates: [{}] })) as { previews: { failed: boolean; pending: boolean }[] }
      assert.deepEqual(previews.previews.map((p) => [p.failed, p.pending]), [[true, true]])

      broken = false
      await post("", { method: "average", linked: [HOT] })
      await settle()
      const third = (await post("", { method: "average", linked: [HOT] })) as PortfolioResponse
      assert.deepEqual([third.linkedReading, third.linkedFailed, third.meter.waiting], [[], [], 0])
      assert.equal(third.positions.find((p) => p.asset === "ETH")?.values.costMicros, "3000000000")
    })
  })

  it("ignores the wallet itself in the list", async () => {
    assert.equal((await eth(`?linked=${COLD},${HOT}`))?.values.costMicros, "3000000000")
  })

  it("answers with the failure when a linked wallet can't be read, rather than a wrong cost", async () => {
    const failing: Source = { ...source, readWindow: async (address) => {
      if (address === HOT) throw new Error("nope")
      return { rows: rows[address] ?? [], priced: null, gasUnknown: [] }
    } }
    const api = createApi({}, { source: failing, readRates: async () => ({ byBlock: {}, latest: null }), proofs: { datasets: async () => [], priceBehind: async () => null, readBlock: async () => null } })
    const other = createServer((req, res) => void api(req, res))
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve))
    const response = await fetch(`http://127.0.0.1:${(other.address() as AddressInfo).port}/api/portfolio/${COLD}?linked=${HOT}`)
    other.close()
    assert.equal(response.status, 502)
  })
})
