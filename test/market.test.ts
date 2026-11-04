import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { ETH_ADDRESS, USDC_ADDRESS, buildPricedLegs, derivePricedRows, LAST_2S_BLOCK, marketPrice, marketTrades, type LegRow, type MarketRow, type MarketTrade, type Reference } from "@pricetag/sdk/core"
import type { Query } from "@pricetag/sdk/internal"
import { resolvingSource } from "../server/source.ts"

const AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631"
const DEGEN = "0x4ed4e862860bed51a9570b96d89af5e1b0efefed"
const ME = "0x00000000000000000000000000000000000000aa"
const E18 = 10n ** 18n
const E6 = 10n ** 6n

const trade = (blockNum: number, txHash: string, usdMicros: string, notionalUsdMicros = "500000000", asset = "AERO"): MarketTrade => ({ blockNum, txHash, asset, usdMicros, notionalUsdMicros })

describe("a market price", () => {
  const steady = [trade(990, "0xa", "1000000"), trade(995, "0xb", "1100000"), trade(1000, "0xc", "1200000")]

  it("is the median of the latest real trades", () => {
    assert.deepEqual(marketPrice(steady, "AERO", 1000), { usdMicros: "1100000", blockNum: 1000 })
  })

  it("never looks ahead of its block", () => {
    assert.equal(marketPrice(steady, "AERO", 999), null, "only two trades are at or before this block")
    assert.equal(marketPrice([...steady, trade(1001, "0xd", "9000000")], "AERO", 1000)?.usdMicros, "1100000")
  })

  it("is gone once its trades are too old", () => {
    assert.equal(marketPrice(steady, "AERO", 990 + 900)?.usdMicros, "1100000")
    assert.equal(marketPrice(steady, "AERO", 991 + 900), null)
  })

  it("lasts just as long in time after the 200 ms upgrade", () => {
    const after = [trade(LAST_2S_BLOCK + 10, "0xa", "1000000"), trade(LAST_2S_BLOCK + 15, "0xb", "1100000"), trade(LAST_2S_BLOCK + 20, "0xc", "1200000")]
    assert.equal(marketPrice(after, "AERO", LAST_2S_BLOCK + 10 + 9000)?.usdMicros, "1100000")
    assert.equal(marketPrice(after, "AERO", LAST_2S_BLOCK + 11 + 9000), null)
  })

  it("won't let small trades set it", () => {
    const thin = steady.map((t) => ({ ...t, notionalUsdMicros: "99999999" }))
    assert.equal(marketPrice(thin, "AERO", 1000), null)
  })

  it("won't take a price from too little volume, even across enough trades", () => {
    const light = steady.map((t) => ({ ...t, notionalUsdMicros: "300000000" }))
    assert.equal(marketPrice(light, "AERO", 1000), null)
  })

  it("won't count one transaction's accounts as separate trades", () => {
    assert.equal(marketPrice([trade(990, "0xa", "1000000"), trade(990, "0xa", "1000000"), trade(990, "0xa", "1000000")], "AERO", 1000), null)
  })

  it("isn't moved by one odd trade", () => {
    assert.equal(marketPrice([...steady, trade(1000, "0xd", "90000000")], "AERO", 1000)?.usdMicros, "1100000")
  })

  it("only reads its own asset", () => {
    assert.equal(marketPrice(steady, "DEGEN", 1000), null)
  })
})

describe("reading trades from priced_legs", () => {
  const row = (usd_micros: string, token = "AERO"): MarketRow => ({
    block_num: 1000,
    tx_hash: "0xa",
    sold_token: USDC_ADDRESS,
    sold_amount: (500n * E6).toString(),
    bought_token: AERO,
    bought_amount: (400n * E18).toString(),
    priced: { token, usd_micros, source: "swap" },
    eth_usd: "240000000000",
  })

  it("works out each trade's size from the token that was priced", () => {
    assert.deepEqual(marketTrades([row("1250000")]), [{ blockNum: 1000, txHash: "0xa", asset: "AERO", usdMicros: "1250000", notionalUsdMicros: "500000000" }])
  })

  it("rejects a price far from any plausible value, so it can't reach a total", () => {
    assert.deepEqual(marketTrades([row("6600000000000")]), [])
  })

  it("skips what has no price, and tokens a feed already prices", () => {
    assert.deepEqual(marketTrades([{ ...row(""), priced: { token: "", usd_micros: "", source: "unknown" } }]), [])
    assert.deepEqual(marketTrades([row("2400000000", "ETH")]), [])
  })

  it("leaves out native ETH bought in a swap, which may be an unwrap the account never received", () => {
    const claim = { ...row("500000000"), sold_token: AERO, sold_amount: (E18).toString(), bought_token: ETH_ADDRESS, bought_amount: (E18 / 4n).toString() }
    assert.deepEqual(marketTrades([claim]), [])
    const weth = { ...claim, bought_token: "0x4200000000000000000000000000000000000006" }
    assert.equal(marketTrades([{ ...weth, priced: { token: "AERO", usd_micros: "600000", source: "swap" } }]).length, 1, "wrapped ETH is a real transfer, so it counts")
  })

  it("can't set a price from those rows however many there are", () => {
    const claims = ["0xa", "0xb", "0xc"].map((tx_hash) => ({ ...row("1000000"), tx_hash, sold_token: AERO, sold_amount: (500n * E18).toString(), bought_token: ETH_ADDRESS, bought_amount: (E18 / 4n).toString() }))
    assert.equal(marketPrice(marketTrades(claims), "AERO", 1000), null)
  })

  it("skips an amount that mostly cancelled out", () => {
    assert.deepEqual(marketTrades([{ ...row("1250000"), bought_amount: "" }]), [])
  })
})

describe("the price of a leg, in order", () => {
  const REF: Reference = { blockNum: 100, ethUsd: "240000000000", usdcUsd: "100000000" }
  const rows = (tx: string, ...moves: [string, LegRow["side"], bigint][]): LegRow[] =>
    moves.map(([token, side, amount]) => ({ block_num: 100, timestamp: "2026-11-04T00:00:00.000Z", tx_hash: tx, tx_index: 1, log_index: 0, token, account: ME, side, amount: amount.toString(), kind: token === ETH_ADDRESS ? ("eth" as const) : ("erc20" as const) }))
  const legsOf = (input: LegRow[], market: (asset: string) => string | null = (asset) => (asset === "AERO" ? "1300000" : null)) => buildPricedLegs({ account: ME, rows: input, references: [REF], priced: derivePricedRows(input, [REF]), market })

  it("1. a feed, even with a market price around", () => {
    const [leg] = legsOf(rows("0x1", [ETH_ADDRESS, "credit", E18]), () => "1")
    assert.equal(leg?.priceSource, "oracle")
  })

  it("2. a swap in the same transaction beats the market", () => {
    const aero = legsOf(rows("0x1", [USDC_ADDRESS, "debit", 1000n * E6], [AERO, "credit", 800n * E18])).find((l) => l.asset === "AERO")
    assert.equal(aero?.priceSource, "swap")
    assert.equal(aero?.priceMicros, "1250000")
  })

  it("3. the market for a plain transfer, whose cost stays open", () => {
    const [leg] = legsOf(rows("0x1", [AERO, "credit", E18]))
    assert.equal(leg?.priceSource, "market")
    assert.equal(leg?.priceMicros, "1300000")
    assert.equal(leg?.priceNote, null)
    assert.equal(leg?.costLabel, "unknown")
  })

  it("4. none, when there's no usable price", () => {
    const [leg] = legsOf(rows("0x1", [DEGEN, "credit", E18]))
    assert.equal(leg?.priceSource, null)
    assert.equal(leg?.priceMicros, null)
  })

  it("an absurd swap gets the market's price instead, and still no cost", () => {
    const aero = legsOf(rows("0x1", [USDC_ADDRESS, "debit", 1n], [AERO, "credit", 50_000n * E18])).find((l) => l.asset === "AERO")
    assert.equal(aero?.priceSource, "market")
    assert.equal(aero?.costLabel, "unknown")
    assert.equal(aero?.costMicros, null)
  })

  it("values a swap with no feed on either side from the market, as an estimate", () => {
    const legs = legsOf(rows("0x1", [AERO, "debit", 1000n * E18], [DEGEN, "credit", 500_000n * E18]))
    const [sold, bought] = [legs.find((l) => l.asset === "AERO"), legs.find((l) => l.asset === "DEGEN")]
    assert.equal(sold?.proceedsMicros, "1300000000")
    assert.equal(bought?.costMicros, "1300000000")
    assert.equal(bought?.costLabel, "paid")
    assert.equal(bought?.estimated, true)
    assert.equal(sold?.estimated, true)
  })

  it("won't value that swap when it implies something far from the other token's market price", () => {
    const legs = legsOf(rows("0x1", [AERO, "debit", 1000n * E18], [DEGEN, "credit", 500_000n * E18]), (asset) => (asset === "AERO" ? "1300000" : "1"))
    assert.equal(legs.find((l) => l.asset === "DEGEN")?.costMicros, null)
    assert.equal(legs.find((l) => l.asset === "AERO")?.proceedsMicros, null)
  })
})

describe("a trade in a transaction with an unconfirmed credit", () => {
  it("gets no value from its market price, even with what's sold and bought both priced", () => {
    const at = (token: string, side: LegRow["side"], amount: string, kind: LegRow["kind"] = "erc20"): LegRow => ({ block_num: 5, timestamp: "2026-11-04T00:00:00.000Z", tx_hash: "0xc", tx_index: 1, log_index: 0, token, account: ME, side, amount, kind })
    const rows = [at(AERO, "debit", (5n * E18).toString()), at(DEGEN, "credit", (5n * E18).toString()), at(ETH_ADDRESS, "credit", E18.toString(), "unwrap")]
    const legs = buildPricedLegs({ account: ME, rows, references: [{ blockNum: 5, ethUsd: "200000000000", usdcUsd: "100000000" }], priced: [], market: () => "1300000" })
    assert.deepEqual(legs.map((l) => [l.asset, l.kind, l.costMicros, l.proceedsMicros, l.estimated ?? false]), [["AERO", "swap", null, null, false], ["DEGEN", "swap", null, null, false], ["ETH", "swap", null, null, false]])
  })
})

describe("where a rule's market prices come from", () => {
  it("reads a fork's own priced_legs, so its trades are priced by its rule", async () => {
    const asked: string[] = []
    const query = (async (sql: string) => {
      asked.push(sql)
      return []
    }) as unknown as Query
    const source = resolvingSource(query, { baseDataset: "base", dataset: "pricetag", priceDataset: "pricing", startBlock: 1, network: "base" })
    await source.readMarketTrades?.("AERO", 1, 2)
    assert.ok(asked[0]?.includes(`"pricing".priced_legs`))
  })
})
