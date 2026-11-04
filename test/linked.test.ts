import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { createApi } from "../server/app.ts"
import type { Source } from "../server/source.ts"
import type { PortfolioResponse } from "../src/core/api.ts"
import { buildPricedLegs, type LegRow } from "../src/core/legs.ts"
import { ETH_ADDRESS } from "../src/core/tokens.ts"
import type { Method } from "../src/core/fold.ts"
import type { PricedLeg } from "../src/core/legs.ts"
import { inheritCosts } from "../src/core/linked.ts"
import { foldPositions } from "../src/core/portfolio.ts"
import { portfolioOf, withLinkedCosts } from "../server/portfolio.ts"
import { unlistedTokens } from "../server/wallets.ts"
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
    priceUsdMicros: "3000000000",
    priceSource: "oracle",
    priceNote: null,
    costUsdMicros: null,
    proceedsUsdMicros: null,
    costLabel: "unknown",
    blockNum: block,
    timestamp: "2026-11-04T00:00:00.000Z",
    txHash: tx,
    txIndex: 1,
    parts: [],
    ...changes,
  }
}
const bought = (tx: string, qty: bigint, cost: number) => leg(tx, qty, { kind: "swap", costLabel: "paid", costUsdMicros: String(cost * 1_000_000) })
const sameBlock = (a: PricedLeg, b: PricedLeg): PricedLeg => ({ ...b, blockNum: a.blockNum })

function resolved(wallets: Record<string, PricedLeg[]>, method: Method = "average") {
  return inheritCosts(new Map(Object.entries(wallets)), method)
}

describe("inheritCosts", () => {
  it("carries what the sender paid to the receiver, labeled inherited", () => {
    const buy = bought("0x1", ONE, 3000)
    const out = leg("0x2", -ONE)
    const result = resolved({ [HOT]: [buy, out], [COLD]: [sameBlock(out, leg("0x2", ONE))] })
    const [credit] = result.get(COLD)!
    assert.equal(credit?.costLabel, "inherited")
    assert.equal(credit?.costUsdMicros, "3000000000")
  })

  it("moves no gain or loss, and the receiver's total cost is what the sender paid", () => {
    const buy = bought("0x1", ONE, 3000)
    const out = leg("0x2", -ONE)
    const result = resolved({ [HOT]: [buy, out], [COLD]: [sameBlock(out, leg("0x2", ONE))] })
    const [cold] = foldPositions(result.get(COLD)!, "average", { ETH: { usdMicros: "4000000000", source: "oracle", blockNum: 1 } })
    assert.equal(cold?.values.costUsdMicros, "3000000000")
    assert.equal(cold?.values.unrealizedUsdMicros, "1000000000")
    const [hot] = foldPositions(result.get(HOT)!, "average", {})
    assert.equal(hot?.values.realizedUsdMicros, "0")
  })

  it("follows a chain of wallets", () => {
    const buy = bought("0x1", ONE, 3000)
    const first = leg("0x2", -ONE)
    const second = leg("0x3", -ONE)
    const result = resolved({
      [HOT]: [buy, first],
      [NEXT]: [sameBlock(first, leg("0x2", ONE)), second],
      [COLD]: [sameBlock(second, leg("0x3", ONE))],
    })
    assert.equal(result.get(NEXT)?.[0]?.costLabel, "inherited")
    assert.equal(result.get(COLD)?.[0]?.costLabel, "inherited")
    assert.equal(result.get(COLD)?.[0]?.costUsdMicros, "3000000000")
  })

  it("keeps an unresolved part unresolved, and never counts it as $0", () => {
    const buy = bought("0x1", ONE, 3000)
    const gift = leg("0x2", ONE)
    const out = leg("0x3", -2n * ONE)
    const result = resolved({ [HOT]: [buy, gift, out], [COLD]: [sameBlock(out, leg("0x3", 2n * ONE))] }, "fifo")
    const legs = result.get(COLD)!
    assert.deepEqual(legs.map((l) => l.costLabel), ["inherited", "unknown"])
    assert.deepEqual(legs.map((l) => l.delta), [ONE.toString(), ONE.toString()])
    assert.equal(legs[1]?.costUsdMicros, null)
    assert.equal(new Set(legs.map((l) => l.id)).size, 2)
    const [cold] = foldPositions(legs, "fifo", {})
    assert.equal(cold?.values.costUsdMicros, null, "with part of it unknown, the position's cost is unknown")
    assert.equal(cold?.values.unknownCostQty, ONE.toString())
  })

  it("carries the right share by each method", () => {
    const cheap = bought("0x1", ONE, 1000)
    const dear = bought("0x2", ONE, 3000)
    const out = leg("0x3", -ONE)
    const credit = sameBlock(out, leg("0x3", ONE))
    assert.equal(resolved({ [HOT]: [cheap, dear, out], [COLD]: [credit] }, "fifo").get(COLD)?.[0]?.costUsdMicros, "1000000000")
    assert.equal(resolved({ [HOT]: [cheap, dear, out], [COLD]: [credit] }, "average").get(COLD)?.[0]?.costUsdMicros, "2000000000")
  })

  it("leaves a credit alone when the sender's amount doesn't match, since that isn't a plain transfer", () => {
    const buy = bought("0x1", 2n * ONE, 6000)
    const out = leg("0x2", -2n * ONE)
    const result = resolved({ [HOT]: [buy, out], [COLD]: [sameBlock(out, leg("0x2", ONE))] })
    assert.equal(result.get(COLD)?.[0]?.costLabel, "unknown")
  })

  it("leaves a credit alone when no linked wallet sent it", () => {
    const result = resolved({ [HOT]: [bought("0x1", ONE, 3000)], [COLD]: [leg("0x9", ONE)] })
    assert.equal(result.get(COLD)?.[0]?.costLabel, "unknown")
  })

  it("never turns a purchase into an inheritance", () => {
    const buy = bought("0x1", ONE, 3000)
    const out = leg("0x2", -ONE)
    const result = resolved({ [HOT]: [buy, out], [COLD]: [sameBlock(out, bought("0x2", ONE, 3500))] })
    assert.equal(result.get(COLD)?.[0]?.costLabel, "paid")
    assert.equal(result.get(COLD)?.[0]?.costUsdMicros, "3500000000")
  })

  it("marks what the sender never saw arrive as unknown", () => {
    const out = leg("0x2", -ONE)
    const result = resolved({ [HOT]: [out], [COLD]: [sameBlock(out, leg("0x2", ONE))] })
    assert.equal(result.get(COLD)?.[0]?.costLabel, "unknown")
  })
})

describe("withLinkedCosts", () => {
  it("only touches the wallet being read, and a portfolio folds it as inherited", () => {
    const buy = bought("0x1", ONE, 3000)
    const out = leg("0x2", -ONE)
    const hot = { ...DEMO_WALLET, address: HOT, legs: [buy, out] }
    const cold = { ...DEMO_WALLET, address: COLD, legs: [sameBlock(out, leg("0x2", ONE))] }
    const wallet = withLinkedCosts(cold, [hot], "average")
    assert.equal(wallet.legs[0]?.costLabel, "inherited")
    assert.equal(portfolioOf(wallet, "average").positions[0]?.values.costUsdMicros, "3000000000")
    assert.equal(portfolioOf(cold, "average").positions[0]?.values.costUsdMicros, null)
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
      row(11, "0x2", HOT, "debit", ONE),
    ],
    [COLD]: [row(11, "0x2", COLD, "credit", ONE)],
  }
  const source: Source = {
    mode: "raw",
    startBlock: 1,
    historyBlocks: null,
    head: async () => ({ blockNum: 20, timestamp: "2026-11-04T00:00:00.000Z" }),
    processedThrough: async (_, head) => head,
    readWindow: async (address) => ({ rows: rows[address] ?? [], priced: null, gasUnknownTxs: [] }),
    readReferences: async (blocks) => blocks.map((block_num) => ({ block_num, eth_usd: "300000000000", usdc_usd: "100000000" })),
    readLatestReference: async () => ({ block_num: 20, eth_usd: "400000000000", usdc_usd: "100000000" }),
  }
  let server: Server
  let base: string
  before(async () => {
    const api = createApi({}, source)
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
    assert.equal((await eth(""))?.values.costUsdMicros, null)
  })

  it("carries over what the sender paid with them", async () => {
    const position = await eth(`?linked=${HOT}`)
    assert.equal(position?.values.costUsdMicros, "3000000000")
    assert.equal(position?.values.unrealizedUsdMicros, "1000000000")
    const explained = (await (await fetch(`${base}/api/portfolio/${COLD}/explain?asset=ETH&metric=value&linked=${HOT}`)).json()) as { legs: { costLabel: string }[] }
    assert.deepEqual(explained.legs.map((l) => l.costLabel), ["inherited"])
  })

  it("ignores the wallet itself in the list", async () => {
    assert.equal((await eth(`?linked=${COLD},${HOT}`))?.values.costUsdMicros, "3000000000")
  })

  it("answers with the failure when a linked wallet can't be read, rather than a wrong cost", async () => {
    const failing: Source = { ...source, readWindow: async (address) => {
      if (address === HOT) throw new Error("nope")
      return { rows: rows[address] ?? [], priced: null, gasUnknownTxs: [] }
    } }
    const api = createApi({}, failing)
    const other = createServer((req, res) => void api(req, res))
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve))
    const response = await fetch(`http://127.0.0.1:${(other.address() as AddressInfo).port}/api/portfolio/${COLD}?linked=${HOT}`)
    other.close()
    assert.equal(response.status, 502)
  })
})
