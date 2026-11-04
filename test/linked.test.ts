import assert from "node:assert/strict"
import { describe, it } from "node:test"
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
