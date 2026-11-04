import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildPricedLegs, derivePricedRows, type LegRow, type ReferenceRow } from "../src/core/legs.ts"
import { MARKET_MAX_AGE_BLOCKS, marketPrice, marketTrades, type MarketRow, type MarketTrade } from "../src/core/market.ts"
import { ETH_ADDRESS, USDC_ADDRESS } from "../src/core/tokens.ts"

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
    assert.equal(marketPrice(steady, "AERO", 990 + MARKET_MAX_AGE_BLOCKS)?.usdMicros, "1100000")
    assert.equal(marketPrice(steady, "AERO", 991 + MARKET_MAX_AGE_BLOCKS), null)
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

  it("skips an amount that mostly cancelled out", () => {
    assert.deepEqual(marketTrades([{ ...row("1250000"), bought_amount: "" }]), [])
  })
})

describe("the price of a leg, in order", () => {
  const REF: ReferenceRow = { block_num: 100, eth_usd: "240000000000", usdc_usd: "100000000" }
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
    assert.equal(aero?.priceUsdMicros, "1250000")
  })

  it("3. the market for a plain transfer, whose cost stays open", () => {
    const [leg] = legsOf(rows("0x1", [AERO, "credit", E18]))
    assert.equal(leg?.priceSource, "market")
    assert.equal(leg?.priceUsdMicros, "1300000")
    assert.equal(leg?.priceNote, null)
    assert.equal(leg?.costLabel, "unknown")
  })

  it("4. none, when there's no usable price", () => {
    const [leg] = legsOf(rows("0x1", [DEGEN, "credit", E18]))
    assert.equal(leg?.priceSource, null)
    assert.equal(leg?.priceUsdMicros, null)
  })

  it("an absurd swap gets the market's price instead, and still no cost", () => {
    const aero = legsOf(rows("0x1", [USDC_ADDRESS, "debit", 1n], [AERO, "credit", 50_000n * E18])).find((l) => l.asset === "AERO")
    assert.equal(aero?.priceSource, "market")
    assert.equal(aero?.costLabel, "unknown")
    assert.equal(aero?.costUsdMicros, null)
  })

  it("values a swap with no feed on either side from the market, as an estimate", () => {
    const legs = legsOf(rows("0x1", [AERO, "debit", 1000n * E18], [DEGEN, "credit", 500_000n * E18]))
    const [sold, bought] = [legs.find((l) => l.asset === "AERO"), legs.find((l) => l.asset === "DEGEN")]
    assert.equal(sold?.proceedsUsdMicros, "1300000000")
    assert.equal(bought?.costUsdMicros, "1300000000")
    assert.equal(bought?.costLabel, "paid")
    assert.equal(bought?.estimated, true)
    assert.equal(sold?.estimated, true)
  })

  it("won't value that swap when it implies something far from the other token's market price", () => {
    const legs = legsOf(rows("0x1", [AERO, "debit", 1000n * E18], [DEGEN, "credit", 500_000n * E18]), (asset) => (asset === "AERO" ? "1300000" : "1"))
    assert.equal(legs.find((l) => l.asset === "DEGEN")?.costUsdMicros, null)
    assert.equal(legs.find((l) => l.asset === "AERO")?.proceedsUsdMicros, null)
  })
})
