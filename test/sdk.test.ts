import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { USDC_ADDRESS, buildPortfolio, buildPricedLegs, foldPositions, pnlStatus, sumTotals } from "@pricetag/sdk"
import { DEMO_REFERENCES, DEMO_ROWS, DEMO_WALLET } from "../src/core/fixtures.ts"
import { fakeAmp } from "./support/fake-amp.ts"

const ME = "00000000000000000000000000000000000000aa"
const POOL = "00000000000000000000000000000000000000bb"
const AERO = "940181a94a35a4569e4529a3cdfb74e38fd98631"
const DEGEN = "4ed4e862860bed51a9570b96d89af5e1b0efefed"
const UNLISTED = "000000000000000000000000000000000000f00d"
const USDC = USDC_ADDRESS.slice(2)
const ETH_ANSWER = "240000000000"
const USDC_ANSWER = "100000000"
const E18 = 10n ** 18n

const leg = (tx: string, token: string, account: string, side: string, amount: string | null, kind: string) => ({
  block_num: "100",
  timestamp: 1_800_000_000_000,
  tx_hash: tx,
  tx_index: 3,
  log_index: 0,
  token,
  account,
  side,
  amount,
  kind,
})
const pricedRow = (tx: string, soldToken: string, soldAmount: string, boughtToken: string, boughtAmount: string, priced: unknown, account = ME) => ({
  block_num: "100",
  timestamp: 1_800_000_000_000,
  tx_hash: tx,
  account,
  sold_token: soldToken,
  sold_amount: soldAmount,
  bought_token: boughtToken,
  bought_amount: boughtAmount,
  eth_usd: ETH_ANSWER,
  usdc_usd: USDC_ANSWER,
  priced,
})
const swapTo = (usdMicros: string, token = "AERO") => ({ source: "swap", token, usd_micros: usdMicros })

describe("getLegs", () => {
  it("prices a wallet's swap, with its source and transaction", async () => {
    const { client } = fakeAmp({
      legs: [leg("aa", USDC, ME, "debit", "1000000000", "erc20"), leg("aa", AERO, ME, "credit", String(500n * E18), "erc20")],
      priced_legs: [pricedRow("aa", USDC, "1000000000", AERO, String(500n * E18), swapTo("2000000"))],
      reference_prices: [{ block_num: "100", eth_usd: ETH_ANSWER, usdc_usd: USDC_ANSWER }],
    })
    const { legs, blocks, address } = await client.getLegs(`0x${ME.toUpperCase()}`, { from: 50 })
    assert.equal(address, `0x${ME}`)
    assert.deepEqual(blocks, { fromBlock: 50, toBlock: 200 })
    const aero = legs.find((l) => l.asset === "AERO")!
    assert.deepEqual([aero.priceMicros, aero.priceSource, aero.txHash, aero.costLabel, aero.costMicros], ["2000000", "swap", "0xaa", "paid", "1000000000"])
  })

  it("keeps an unpriced leg unknown, and says why", async () => {
    const { client } = fakeAmp({ legs: [leg("aa", AERO, ME, "credit", "5", "erc20")], reference_prices: [{ block_num: "100", eth_usd: ETH_ANSWER, usdc_usd: USDC_ANSWER }] })
    const [aero] = (await client.getLegs(`0x${ME}`, { from: 50 })).legs
    assert.deepEqual([aero!.priceMicros, aero!.priceSource, aero!.costLabel, aero!.costMicros], [null, null, "unknown", null])
    assert.ok(aero!.priceNote)
  })

  it("stops at what every table has processed, and says so", async () => {
    const { client, queries } = fakeAmp({}, 150)
    assert.deepEqual((await client.getLegs(`0x${ME}`, { from: 50 })).blocks, { fromBlock: 50, toBlock: 150 })
    assert.ok(queries.some((q) => q.includes(".legs WHERE block_num BETWEEN 50 AND 150")))
  })

  it("waits for the slowest of every table a wallet needs", async () => {
    const { client } = fakeAmp({}, { legs: 200, unlisted_legs: 200, priced_legs: 200, reference_prices: 150 })
    assert.deepEqual((await client.getLegs(`0x${ME}`, { from: 50 })).blocks, { fromBlock: 50, toBlock: 150 })
  })

  it("reads no further than `to`, even when more has been processed", async () => {
    const { client, queries } = fakeAmp({}, 200)
    assert.deepEqual((await client.getLegs(`0x${ME}`, { from: 50, to: 60 })).blocks, { fromBlock: 50, toBlock: 60 })
    assert.ok(queries.some((q) => q.includes(".legs WHERE block_num BETWEEN 50 AND 60")))
    // A table with no rows in a short range has still processed it, so how far it's got isn't read from the range alone.
    assert.ok(queries.some((q) => q.includes(".priced_legs WHERE block_num >= 50 ORDER BY block_num DESC LIMIT 1")))
  })

  it("says nothing was read when no table has reached the range, rather than reporting an empty wallet", async () => {
    const { client, queries } = fakeAmp({}, null)
    const result = await client.getLegs(`0x${ME}`, { from: 50 })
    assert.deepEqual(result.blocks, { fromBlock: 50, toBlock: 49 })
    assert.deepEqual(result.legs, [])
    assert.ok(!queries.some((q) => q.includes("BETWEEN")))
  })

  it("rejects what could end up in the SQL, before any query", async () => {
    const { client, queries } = fakeAmp({})
    await assert.rejects(client.getLegs("0x' OR 1=1 --", { from: 50 }), /isn't a Base address/)
    await assert.rejects(client.getLegs(`0x${ME}`, { from: "1; DROP" as unknown as number }), /Bad block range/)
    await assert.rejects(client.getLegs(`0x${ME}`, { from: Number("") }), /Bad block range/)
    await assert.rejects(client.getLegs(`0x${ME}`, { from: 60, to: 50 }), /Bad block range/)
    assert.deepEqual(queries, [])
  })
})

describe("getPrices", () => {
  it("reads an oracle token from reference_prices, one price a block, with no transaction", async () => {
    const { client, queries } = fakeAmp({ reference_prices: [{ block_num: "100", timestamp: 1_800_000_000_000, answer: ETH_ANSWER }] })
    const { token, prices } = await client.getPrices("ETH", { from: 50, to: 150 })
    assert.equal(token, "ETH")
    assert.deepEqual(prices, [{ blockNum: 100, timestamp: new Date(1_800_000_000_000).toISOString(), usdMicros: "2400000000", source: "oracle", txHash: null, account: null, note: null }])
    assert.ok(queries.some((q) => q.includes("eth_answer AS answer") && q.includes("BETWEEN 50 AND 150")))
  })

  it("reads USDC from its own feed, and WETH from ETH's", async () => {
    const usdc = fakeAmp({ reference_prices: [{ block_num: "100", timestamp: 0, answer: USDC_ANSWER }] })
    assert.equal((await usdc.client.getPrices(USDC_ADDRESS, { from: 50 })).prices[0]!.usdMicros, "1000000")
    assert.ok(usdc.queries.some((q) => q.includes("usdc_answer AS answer")))
    const weth = fakeAmp({ reference_prices: [] })
    await weth.client.getPrices("WETH", { from: 50 })
    assert.ok(weth.queries.some((q) => q.includes("eth_answer AS answer")))
  })

  it("keeps a failed oracle read as unknown, not $0", async () => {
    const { client } = fakeAmp({ reference_prices: [{ block_num: "100", timestamp: 0, answer: null }, { block_num: "101", timestamp: 0, answer: "0" }] })
    const { prices } = await client.getPrices("ETH", { from: 50 })
    assert.deepEqual(prices.map((p) => [p.usdMicros, p.source]), [[null, "unknown"], [null, "unknown"]])
    assert.ok(prices.every((p) => p.note))
  })

  for (const token of ["ETH", "WETH", "USDC"]) {
    it(`reads ${token} when only reference_prices has reached the range`, async () => {
      const rows = [100, 101].map((block) => ({ block_num: String(block), timestamp: 0, answer: ETH_ANSWER }))
      const { client } = fakeAmp({ reference_prices: rows }, { legs: null, unlisted_legs: null, priced_legs: null, reference_prices: 101 })
      const { prices, blocks } = await client.getPrices(token, { from: 100, to: 101 })
      assert.deepEqual(blocks, { fromBlock: 100, toBlock: 101 })
      assert.deepEqual(prices.map((p) => p.blockNum), [100, 101])
    })
  }

  it("isn't held back by swap tables that lag the oracle", async () => {
    const { client, queries } = fakeAmp({}, { legs: 110, unlisted_legs: 120, priced_legs: 130, reference_prices: 150 })
    assert.deepEqual((await client.getPrices("ETH", { from: 100 })).blocks, { fromBlock: 100, toBlock: 150 })
    assert.ok(queries.some((q) => q.includes("reference_prices WHERE block_num BETWEEN 100 AND 150")))
  })

  it("says nothing was read when reference_prices hasn't reached an oracle token's range", async () => {
    const { client } = fakeAmp({}, { legs: 150, unlisted_legs: 150, priced_legs: 150, reference_prices: null })
    assert.deepEqual(await client.getPrices("ETH", { from: 100 }), { token: "ETH", blocks: { fromBlock: 100, toBlock: 99 }, prices: [] })
  })

  it("has a swap token wait for the tables its prices come from, and not reference_prices", async () => {
    const { client } = fakeAmp({}, { legs: 120, unlisted_legs: 150, priced_legs: 150, reference_prices: null })
    assert.deepEqual((await client.getPrices("AERO", { from: 100 })).blocks, { fromBlock: 100, toBlock: 120 })
  })

  it("says nothing was read when priced_legs hasn't reached a swap token's range", async () => {
    const { client, queries } = fakeAmp({}, { legs: 150, unlisted_legs: 150, priced_legs: null, reference_prices: 150 })
    assert.deepEqual((await client.getPrices("AERO", { from: 100 })).blocks, { fromBlock: 100, toBlock: 99 })
    assert.ok(!queries.some((q) => q.includes("BETWEEN")))
  })

  it("prices a token without an oracle from its swaps, with the transaction", async () => {
    const { client, queries } = fakeAmp({
      priced_legs: [pricedRow("aa", USDC, "1000000000", AERO, String(500n * E18), swapTo("2000000"))],
      legs: [leg("aa", USDC, ME, "debit", "1000000000", "erc20"), leg("aa", AERO, ME, "credit", String(500n * E18), "erc20")],
    })
    const { prices } = await client.getPrices("AERO", { from: 50 })
    assert.deepEqual(prices.map((p) => [p.usdMicros, p.source, p.txHash, p.account]), [["2000000", "swap", "0xaa", `0x${ME}`]])
    assert.ok(queries.some((q) => q.includes(`sold_token = X'${AERO}' OR bought_token = X'${AERO}'`)))
  })

  it("gives one price per account in a transaction, from that account's own rows", async () => {
    const { client } = fakeAmp({
      priced_legs: [
        pricedRow("aa", USDC, "1000000000", AERO, String(500n * E18), swapTo("2000000")),
        pricedRow("aa", AERO, String(500n * E18), USDC, "1000000000", swapTo("2000000"), POOL),
      ],
      legs: [
        leg("aa", USDC, ME, "debit", "1000000000", "erc20"),
        leg("aa", AERO, ME, "credit", String(500n * E18), "erc20"),
        leg("aa", AERO, POOL, "debit", String(500n * E18), "erc20"),
        leg("aa", USDC, POOL, "credit", "1000000000", "erc20"),
      ],
    })
    const { prices } = await client.getPrices("AERO", { from: 50 })
    assert.deepEqual(prices.map((p) => [p.account, p.usdMicros]), [[`0x${ME}`, "2000000"], [`0x${POOL}`, "2000000"]])
  })

  it("doesn't publish a swap price from a transaction that also moved a token off the allowlist", async () => {
    // The dataset leaves these out of priced_legs now, but an older manifest's row must still not become a price.
    const { client } = fakeAmp({
      priced_legs: [pricedRow("aa", USDC, "1000000000", AERO, String(500n * E18), swapTo("2000000"))],
      legs: [leg("aa", USDC, ME, "debit", "1000000000", "erc20"), leg("aa", AERO, ME, "credit", String(500n * E18), "erc20")],
      unlisted_legs: [leg("aa", UNLISTED, ME, "credit", "7", "unlisted")],
    })
    const [point] = (await client.getPrices("AERO", { from: 50 })).prices
    assert.deepEqual([point!.usdMicros, point!.source, point!.txHash], [null, "unknown", "0xaa"])
    assert.match(point!.note!, /a token we can't price yet/)
  })

  it("rejects an absurd swap price", async () => {
    const { client } = fakeAmp({
      priced_legs: [pricedRow("aa", USDC, "1000000000", DEGEN, "1", swapTo("1000000000000000000000000", "DEGEN"))],
      legs: [leg("aa", USDC, ME, "debit", "1000000000", "erc20"), leg("aa", DEGEN, ME, "credit", "1", "erc20")],
    })
    const [point] = (await client.getPrices("DEGEN", { from: 50 })).prices
    assert.deepEqual([point!.usdMicros, point!.source], [null, "unknown"])
  })

  it("keeps a swap the dataset couldn't price, as unknown", async () => {
    const { client } = fakeAmp({
      priced_legs: [pricedRow("aa", AERO, "5", DEGEN, "6", { source: "unknown", token: "", usd_micros: "" })],
      legs: [leg("aa", AERO, ME, "debit", "5", "erc20"), leg("aa", DEGEN, ME, "credit", "6", "erc20")],
    })
    const { prices } = await client.getPrices("AERO", { from: 50 })
    assert.deepEqual(prices.map((p) => [p.usdMicros, p.source, p.txHash]), [[null, "unknown", "0xaa"]])
  })

  it("refuses a token off the allowlist, instead of answering with no prices", async () => {
    const { client, queries } = fakeAmp({})
    await assert.rejects(client.getPrices(`0x${UNLISTED}`, { from: 50 }), /isn't on the allowlist/)
    await assert.rejects(client.getPrices("' OR 1=1 --", { from: 50 }), /isn't on the allowlist/)
    assert.deepEqual(queries, [])
  })

  it("agrees with the wallet path on the same swap", async () => {
    const tables = {
      priced_legs: [pricedRow("aa", USDC, "1000000000", AERO, String(500n * E18), swapTo("2000000"))],
      legs: [leg("aa", USDC, ME, "debit", "1000000000", "erc20"), leg("aa", AERO, ME, "credit", String(500n * E18), "erc20")],
      reference_prices: [{ block_num: "100", eth_usd: ETH_ANSWER, usdc_usd: USDC_ANSWER }],
    }
    const { client } = fakeAmp(tables)
    const fromLegs = (await client.getLegs(`0x${ME}`, { from: 50 })).legs.find((l) => l.asset === "AERO")!
    const [fromPrices] = (await client.getPrices("AERO", { from: 50 })).prices
    assert.deepEqual([fromPrices!.usdMicros, fromPrices!.source, fromPrices!.txHash], [fromLegs.priceMicros, fromLegs.priceSource, fromLegs.txHash])
  })
})

describe("getLatestPrices", () => {
  it("has only what a recent oracle read gives", async () => {
    const { client } = fakeAmp({ reference_prices: [{ block_num: "199", eth_usd: ETH_ANSWER, usdc_usd: "" }] })
    assert.deepEqual(await client.getLatestPrices(), { ETH: { micros: "2400000000", source: "oracle", blockNum: 199 } })
  })

  it("has nothing without a recent read", async () => {
    assert.deepEqual(await fakeAmp({ reference_prices: [] }).client.getLatestPrices(), {})
  })
})

describe("buildPortfolio", () => {
  it("is the app's fold and totals on the demo wallet", () => {
    const { positions, totals, method } = buildPortfolio(DEMO_WALLET.legs, "fifo", DEMO_WALLET.prices)
    assert.equal(method, "fifo")
    const expected = foldPositions(DEMO_WALLET.legs, "fifo", DEMO_WALLET.prices)
    assert.deepEqual(positions, expected)
    assert.deepEqual(totals, sumTotals(expected))
  })

  it("keeps each position's legs, with their transaction and price source", () => {
    const { positions } = buildPortfolio(DEMO_WALLET.legs, "average", DEMO_WALLET.prices)
    const effects = positions.flatMap((p) => p.effects)
    assert.equal(effects.length, DEMO_WALLET.legs.length)
    // An opening balance is the one leg with no transaction: it's what the chain said before the first block read.
    assert.ok(effects.every((e) => (e.leg.opening || e.leg.txHash.startsWith("0x")) && "priceSource" in e.leg))
  })

  it("leaves value and unrealized PnL unknown without current prices, rather than $0", () => {
    const legs = buildPricedLegs({ account: DEMO_WALLET.address, rows: DEMO_ROWS, references: DEMO_REFERENCES, priced: [] })
    const { positions } = buildPortfolio(legs, "average")
    const eth = positions.find((p) => p.asset === "ETH")!
    assert.deepEqual([eth.values.valueMicros, eth.values.unrealizedMicros, eth.price], [null, null, null])
  })
})

describe("pnlStatus", () => {
  const { totals } = buildPortfolio([], "average")

  it("calls a known zero complete", () => {
    assert.equal(pnlStatus(totals), "complete")
  })

  it("calls a total partial when gas couldn't be worked out, even with nothing excluded", () => {
    assert.equal(pnlStatus(totals, ["0xaa"]), "partial")
  })

  it("calls a total partial when gas had no price", () => {
    assert.equal(pnlStatus({ ...totals, unpricedGas: true }), "partial")
  })

  it("calls a total partial when it leaves something out", () => {
    assert.equal(pnlStatus({ ...totals, excluded: [{ asset: "ETH", reason: "unknown cost" }] }), "partial")
  })

  it("calls a total with no answer unavailable", () => {
    assert.equal(pnlStatus({ ...totals, pnlMicros: null }), "unavailable")
  })
})

describe("the package boundary", () => {
  const sdkFile = (name: string) => readFileSync(new URL(`../packages/sdk/src/${name}`, import.meta.url), "utf8")

  it("keeps the Amp client out of what browsers load", () => {
    const seen = new Set<string>()
    const walk = (name: string) => {
      if (seen.has(name)) return
      seen.add(name)
      for (const [, path] of sdkFile(name).matchAll(/from "(.+?)"/g)) {
        assert.ok(path!.startsWith("./"), `${name} imports ${path}`)
        walk(path!.slice(2))
      }
    }
    walk("core.ts")
    assert.deepEqual([...seen].sort(), ["core.ts", "fold.ts", "legs.ts", "portfolio.ts", "reconcile.ts", "tokens.ts"])
  })

  it("has the app's browser code import only that part", () => {
    const dirs = ["../src/core/", "../src/ui/"]
    for (const dir of dirs) {
      for (const name of readdirSync(new URL(dir, import.meta.url))) {
        const source = readFileSync(new URL(`${dir}${name}`, import.meta.url), "utf8")
        assert.ok(!source.includes('from "@pricetag/sdk"'), `${name} imports the Amp client`)
        assert.ok(!source.includes("server/"), `${name} imports the server`)
      }
    }
  })

})
