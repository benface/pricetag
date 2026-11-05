import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { createServer } from "node:http2"
import { createServer as createNetServer, type AddressInfo, type Socket } from "node:net"
import { describe, it } from "node:test"
import { createPricetag } from "@pricetag/sdk"
import { USDC_ADDRESS, buildPortfolio, buildPricedLegs, foldPositions, formatPrice, formatSignedMoney, formatMoney, pnlStatus, sumTotals } from "@pricetag/sdk/core"
import { createQuery, createWallets, datasetReader, datasetSource, pricetagClient, type Query, type ReadL1Fees } from "@pricetag/sdk/internal"
import { portfolioOf } from "../server/portfolio.ts"
import { DEMO_REFERENCES, DEMO_ROWS, DEMO_WALLET } from "../src/core/fixtures.ts"
import { fakeAmp, type Tables } from "./support/fake-amp.ts"

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

  it("leaves a swap paid out in unwrapped ETH unknown, because it can't confirm the ETH arrived", async () => {
    const { client } = fakeAmp({
      legs: [leg("aa", AERO, ME, "debit", String(500n * E18), "erc20"), leg("aa", "0000000000000000000000000000000000000000", ME, "credit", String(E18), "unwrap")],
      priced_legs: [pricedRow("aa", AERO, String(500n * E18), "0000000000000000000000000000000000000000", String(E18), swapTo("2000000"))],
      reference_prices: [{ block_num: "100", eth_usd: ETH_ANSWER, usdc_usd: USDC_ANSWER }],
    })
    const { legs } = await client.getLegs(`0x${ME}`, { from: 50 })
    const aero = legs.find((l) => l.asset === "AERO")!
    assert.deepEqual([aero.priceMicros, aero.priceSource, aero.proceedsMicros], [null, null, null])
    assert.match(aero.priceNote!, /couldn't confirm/)
    const { prices } = await client.getPrices("AERO", { from: 50 })
    assert.deepEqual(prices.map((p) => [p.usdMicros, p.source]), [[null, "unknown"]])
  })

  describe("with an RPC URL and a swap paid out in unwrapped ETH", () => {
    const ETH = "0000000000000000000000000000000000000000"
    const HEAD = { blockNum: 200, timestamp: new Date(1_800_000_000_000).toISOString() }
    const reference = { block_num: "100", eth_usd: ETH_ANSWER, usdc_usd: USDC_ANSWER }
    const readFees: ReadL1Fees = async (requests) => new Map(requests.map(({ txHash }) => [txHash, "24"]))
    const before = E18
    // It sells AERO, pays gas and a fee, and the claimed ETH arrives, or only `arrived` of it does.
    const tables = (arrived: bigint) => ({
      legs: [leg("aa", ETH, ME, "debit", "1000", "gas"), leg("aa", AERO, ME, "debit", String(500n * E18), "erc20"), leg("aa", ETH, ME, "credit", String(E18), "unwrap")],
      priced_legs: [pricedRow("aa", AERO, String(500n * E18), ETH, String(E18), swapTo("4800000"))],
      reference_prices: [reference, { ...reference, block_num: "199" }],
      balances: { 49: { ETH: String(before), AERO: String(500n * E18) }, 200: { ETH: String(before + arrived - 1024n) } },
      ethBalances: { 99: String(before), 100: String(before + arrived - 1024n) },
    })
    const appLegs = async (query: Query) => {
      const source = datasetSource(query, { dataset: "benface/pricetag@0.0.1", baseDataset: "edgeandnode/base_mainnet@0.0.2", startBlock: 50, network: "base_mainnet" })
      return (await createWallets(source, async () => HEAD, readFees).get(`0x${ME}`)).legs
    }

    for (const [name, arrived] of [["all of it arrived", E18], ["only part of it arrived", E18 / 2n]] as const) {
      it(`gives the same legs as the app when ${name}`, async () => {
        const { query, client } = fakeAmp(tables(arrived), 200, { readL1Fees: readFees })
        const { legs, l1Fees, l1FeeUnknownTxs } = await client.getLegs(`0x${ME}`, { from: 50 })
        assert.deepEqual(legs, (await appLegs(query)).filter((l) => !l.opening))
        assert.deepEqual([l1Fees, l1FeeUnknownTxs], ["read", []])
        const aero = legs.find((l) => l.asset === "AERO")!
        assert.equal(aero.priceSource, "swap")
        assert.equal(aero.priceNote, null)
        assert.equal(aero.proceedsMicros, String(arrived * 2400n * 10n ** 6n / E18))
        assert.equal(legs.find((l) => l.asset === "ETH" && l.kind === "swap")!.delta, String(arrived))
        assert.equal(legs.find((l) => l.kind === "gas")!.delta, "-1024")
      })
    }

    it("matches `getPortfolio`'s legs, without the opening ones", async () => {
      const { client } = fakeAmp(tables(E18), 200, { readL1Fees: readFees })
      const legs = (await client.getLegs(`0x${ME}`, { from: 50 })).legs
      assert.deepEqual(legs, (await client.getPortfolio(`0x${ME}`, { from: 50 })).legs.filter((l) => !l.opening))
    })

    it("stops at `to`, like the app's read as of a block", async () => {
      const { client } = fakeAmp(tables(E18), 200, { readL1Fees: readFees })
      const { legs, blocks } = await client.getLegs(`0x${ME}`, { from: 50, to: 99 })
      assert.deepEqual(blocks, { fromBlock: 50, toBlock: 99 })
      assert.deepEqual(legs, [])
    })

    it("stays unknown while the L1 fee can't be read, and says so", async () => {
      const { client } = fakeAmp(tables(E18), 200, { readL1Fees: async () => new Map() })
      const { legs, l1Fees, l1FeeUnknownTxs } = await client.getLegs(`0x${ME}`, { from: 50 })
      assert.deepEqual([l1Fees, l1FeeUnknownTxs], ["pending", ["0xaa"]])
      const aero = legs.find((l) => l.asset === "AERO")!
      assert.deepEqual([aero.priceMicros, aero.proceedsMicros], [null, null])
      assert.match(aero.priceNote!, /couldn't confirm/)
    })

    it("stays unknown while the balance can't be read", async () => {
      const { client } = fakeAmp({ ...tables(E18), ethBalances: {} }, 200, { readL1Fees: readFees })
      const { legs, l1Fees } = await client.getLegs(`0x${ME}`, { from: 50 })
      assert.equal(l1Fees, "read")
      assert.match(legs.find((l) => l.asset === "AERO")!.priceNote!, /couldn't confirm/)
    })

    it("stays unknown when more ETH arrived than it claims", async () => {
      const { client } = fakeAmp(tables(2n * E18), 200, { readL1Fees: readFees })
      const aero = (await client.getLegs(`0x${ME}`, { from: 50 })).legs.find((l) => l.asset === "AERO")!
      assert.deepEqual([aero.priceMicros, aero.proceedsMicros], [null, null])
    })

    it("keeps today's unknown without one, and doesn't read balances that couldn't confirm it", async () => {
      const { client, queries } = fakeAmp(tables(E18))
      const { legs, l1Fees, l1FeeUnknownTxs } = await client.getLegs(`0x${ME}`, { from: 50 })
      assert.deepEqual([l1Fees, l1FeeUnknownTxs], ["no rpc url", ["0xaa"]])
      assert.match(legs.find((l) => l.asset === "AERO")!.priceNote!, /couldn't confirm/)
      assert.equal(legs.find((l) => l.kind === "gas")!.delta, "-1000")
      assert.ok(!queries.some((q) => q.includes("eth_call")), queries.join("; "))
    })

    it("still leaves `getPrices` on the sender's row unknown", async () => {
      const { client } = fakeAmp(tables(E18), 200, { readL1Fees: readFees })
      const { prices } = await client.getPrices("AERO", { from: 50 })
      assert.deepEqual(prices.map((p) => [p.usdMicros, p.source]), [[null, "unknown"]])
    })
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

describe("getPortfolio", () => {
  const HEAD = { blockNum: 200, timestamp: new Date(1_800_000_000_000).toISOString() }
  const reference = { block_num: "100", eth_usd: ETH_ANSWER, usdc_usd: USDC_ANSWER }
  const latest = { ...reference, block_num: "199" }
  const ETH = "0000000000000000000000000000000000000000"
  // A wallet with history before the first block read: it holds ETH and USDC, sells USDC for AERO and pays gas.
  const TABLES = {
    legs: [
      leg("aa", ETH, ME, "debit", "1000", "gas"),
      leg("aa", USDC, ME, "debit", "1000000000", "erc20"),
      leg("aa", AERO, ME, "credit", String(500n * E18), "erc20"),
    ],
    priced_legs: [pricedRow("aa", USDC, "1000000000", AERO, String(500n * E18), swapTo("2000000"))],
    reference_prices: [reference, latest],
    balances: {
      49: { ETH: String(E18), USDC: "3000000000" },
      200: { ETH: String(E18 - 1024n), USDC: "2000000000", AERO: String(500n * E18) },
    },
  }
  const readFees: ReadL1Fees = async (requests) => new Map(requests.map(({ txHash }) => [txHash, "24"]))

  it("gives the same answer as the app, with opening balances, reconciliation and L1 fees", async () => {
    const { query, client } = fakeAmp(TABLES, 200, { readL1Fees: readFees })
    const source = datasetSource(query, { dataset: "benface/pricetag@0.0.1", baseDataset: "edgeandnode/base_mainnet@0.0.2", startBlock: 50, network: "base_mainnet" })
    const app = portfolioOf(await createWallets(source, async () => HEAD, readFees).get(`0x${ME}`), "fifo")
    const sdk = await client.getPortfolio(`0x${ME}`, { method: "fifo", from: 50 })

    assert.deepEqual(sdk.totals, app.totals)
    assert.equal(sdk.pnlStatus, app.pnlStatus)
    // The words and each transaction's facts are the app's, and the SDK leaves them out.
    assert.deepEqual(sdk.points, app.points.map(({ blockNum, timestamp, txHash, pnlMicros, excludedCount }) => ({ blockNum, timestamp, txHash, pnlMicros, excludedCount })))
    assert.deepEqual(sdk.blocks, app.coverage)
    assert.deepEqual(sdk.positions.map((p) => [p.asset, p.values, p.reconciliation, p.price]), app.positions.map((p) => [p.asset, p.values, p.reconciliation, p.price]))
    assert.deepEqual(sdk.positions.map((p) => [p.asset, p.reconciliation?.status]), [["ETH", "reconciled"], ["USDC", "reconciled"], ["AERO", "reconciled"]])
    assert.equal(sdk.l1Fees, "read")
    // The opening legs count: USDC's sale came out of what it already held, so that PnL is left out rather than $0.
    assert.equal(sdk.legs.filter((l) => l.opening).length, 2)
    assert.match(sdk.missing.join(), /USDC/)
  })

  it("says L1 fees are missing without an RPC URL, and leaves ETH unchecked", async () => {
    const { client } = fakeAmp(TABLES, 200, { startBlock: 50 })
    const { l1Fees, l1FeeUnknownTxs, positions, missing } = await client.getPortfolio(`0x${ME}`)
    assert.equal(l1Fees, "no rpc url")
    assert.deepEqual(l1FeeUnknownTxs, ["0xaa"])
    assert.equal(positions.find((p) => p.asset === "ETH")!.reconciliation?.status, "unchecked")
    assert.match(missing.join(), /the L1 fees of 1 tx/)
  })

  it("has nothing to read in L1 fees for a wallet that sent nothing", async () => {
    const { client } = fakeAmp({ legs: [leg("aa", USDC, ME, "credit", "5", "erc20")], reference_prices: [latest], balances: { 49: {}, 200: { USDC: "5" } } }, 200, { startBlock: 50 })
    const { l1Fees, pnlStatus: status, missing } = await client.getPortfolio(`0x${ME}`)
    assert.equal(l1Fees, "read")
    assert.notEqual(status, "complete")
    assert.ok(missing.length > 0)
  })

  it("gives no totals before anything's been processed, rather than $0", async () => {
    const { client, queries } = fakeAmp({}, null, { startBlock: 50 })
    const { started, blocks, positions, totals, pnlStatus: status, missing } = await client.getPortfolio(`0x${ME}`)
    assert.equal(started, false)
    assert.deepEqual(blocks, { fromBlock: 50, toBlock: 49 })
    assert.deepEqual(positions, [])
    assert.deepEqual([totals.valueMicros, totals.realizedMicros, totals.unrealizedMicros, totals.gasMicros, totals.pnlMicros], [null, null, null, null, null])
    assert.equal(status, "unavailable")
    assert.match(missing.join(), /hasn't processed block 50/)
    assert.ok(!queries.some((q) => q.includes("eth_call")))
  })

  it("gives no totals when the chain has no blocks yet", async () => {
    const queries: string[] = []
    const client = pricetagClient(async (sql) => (queries.push(sql), []), { dataset: "benface/pricetag@0.0.1", startBlock: 50 })
    const { started, totals } = await client.getPortfolio(`0x${ME}`)
    assert.equal(started, false)
    assert.equal(totals.pnlMicros, null)
    assert.equal(queries.length, 1)
  })

  it("reads a wallet as of `to`, with that block's prices", async () => {
    const { client, queries } = fakeAmp({ ...TABLES, balances: { 49: TABLES.balances[49], 150: TABLES.balances[200] } }, 200, { startBlock: 50, readL1Fees: readFees })
    const { blocks, positions } = await client.getPortfolio(`0x${ME}`, { to: 150 })
    assert.deepEqual(blocks, { fromBlock: 50, toBlock: 150 })
    assert.equal(positions.find((p) => p.asset === "AERO")!.reconciliation?.status, "reconciled")
    assert.ok(queries.some((q) => q.includes("reference_prices WHERE block_num BETWEEN 90 AND 150")))
    assert.ok(queries.some((q) => /\.legs WHERE block_num BETWEEN 50 AND 150/.test(q)))
  })

  it("keeps a wallet's rows between calls, so a second call only reads what's new", async () => {
    let block = 200
    const queries: string[] = []
    const { query } = fakeAmp(TABLES, 200)
    const moving: Query = async <T,>(sql: string) => {
      queries.push(sql)
      if (sql.includes(".blocks")) return [{ block_num: String(block), timestamp: 1_800_000_000_000 }] as T[]
      return query<T>(sql)
    }
    const client = pricetagClient(moving, { dataset: "benface/pricetag@0.0.1", startBlock: 50 })
    await client.getPortfolio(`0x${ME}`)
    assert.equal(queries.filter((q) => /\.legs WHERE block_num BETWEEN 50 AND 200/.test(q)).length, 1)
    block = 201
    await client.getPortfolio(`0x${ME}`)
    assert.equal(queries.filter((q) => /\.legs WHERE block_num BETWEEN 50 AND/.test(q)).length, 1)
  })

  describe("a read with a `to`, near the chain's head", () => {
    const ADDRESS = `0x${ME}`
    const creditAt = (block: number, amount: bigint) => ({ ...leg("aa", ETH, ME, "credit", String(amount), "eth"), block_num: String(block) })
    const gasAt = (block: number, tx: string) => ({ ...leg(tx, ETH, ME, "debit", "1000", "gas"), block_num: String(block) })
    const refsThrough = (block: number) => [{ ...reference, block_num: String(block) }]

    /** A fake chain whose head and tables a test can change, and a client that reads it, the same way each time. */
    function chainAt(block: number, tables: Tables, readL1Fees?: ReadL1Fees) {
      const chain = { block, tables, queries: [] as string[] }
      const query: Query = async <T,>(sql: string) => {
        chain.queries.push(sql)
        if (sql.includes(".blocks")) return [{ block_num: String(chain.block), timestamp: 1_800_000_000_000 }] as T[]
        return fakeAmp(chain.tables, chain.block).query<T>(sql)
      }
      const client = () => pricetagClient(query, { dataset: "benface/pricetag@0.0.1", startBlock: 50, readL1Fees })
      return { chain, client }
    }
    const summary = async (client: ReturnType<typeof pricetagClient>) => {
      const { positions, totals } = await client.getPortfolio(ADDRESS, { to: 200 })
      return { positions: positions.map((p) => [p.asset, p.values.qty, p.values.valueMicros, p.reconciliation?.status]), totals }
    }

    const before = { legs: [creditAt(195, E18)], reference_prices: refsThrough(195), balances: { 49: {}, 200: { ETH: String(E18) } } }
    const reorged = { ...before, legs: [creditAt(195, 2n * E18)], balances: { 49: {}, 200: { ETH: String(2n * E18) } } }

    it("matches a fresh client after a shallow reorg", async () => {
      const { chain, client } = chainAt(200, before)
      const kept = client()
      assert.equal((await summary(kept)).positions[0]![1], String(E18))
      chain.tables = reorged
      chain.block = 201
      const after = await summary(kept)
      assert.equal(after.positions[0]![1], String(2n * E18))
      assert.deepEqual(after, await summary(client()))
    })

    it("still catches a reorg on the block that leaves the window, and then stops reading", async () => {
      const { chain, client } = chainAt(200, before)
      const kept = client()
      await summary(kept)
      // The tables change before anything's read again, and the first read after that is the one past the window.
      chain.tables = reorged
      chain.block = 230
      assert.equal((await summary(kept)).positions[0]![1], String(2n * E18))
      chain.tables = before
      chain.block = 231
      chain.queries.length = 0
      assert.equal((await summary(kept)).positions[0]![1], String(2n * E18))
      assert.ok(!chain.queries.some((q) => q.includes("eth_call") || q.includes(".legs")), chain.queries.join("; "))
    })

    it("doesn't read it again without a new block", async () => {
      const { chain, client } = chainAt(201, before)
      const kept = client()
      await summary(kept)
      chain.queries.length = 0
      await summary(kept)
      assert.ok(!chain.queries.some((q) => q.includes("eth_call") || q.includes(".legs")), chain.queries.join("; "))
    })

    it("reads what's far from the head once", async () => {
      const { chain, client } = chainAt(500, before)
      const kept = client()
      await summary(kept)
      chain.block = 501
      chain.queries.length = 0
      await summary(kept)
      assert.ok(!chain.queries.some((q) => q.includes("eth_call") || q.includes(".legs")), chain.queries.join("; "))
    })

    it("still retries what's missing, without a new block", async () => {
      const { chain, client } = chainAt(500, { ...before, balances: { 49: {} } })
      const kept = client()
      assert.equal((await kept.getPortfolio(ADDRESS, { to: 200 })).positions[0]!.reconciliation?.status, "unchecked")
      chain.tables = before
      assert.equal((await kept.getPortfolio(ADDRESS, { to: 200 })).positions[0]!.reconciliation?.status, "reconciled")
    })

    it("reads a transaction's L1 fee again once it's past the window, and only then", async () => {
      const tables = { legs: [gasAt(195, "bb")], reference_prices: refsThrough(195), balances: { 49: { ETH: String(E18) }, 200: { ETH: String(E18 - 1000n) } } }
      const reads: string[] = []
      const fee = { amount: "0" }
      const readFees: ReadL1Fees = async (requests) => {
        reads.push(...requests.map((r) => r.txHash))
        return new Map(requests.map(({ txHash }) => [txHash, fee.amount]))
      }
      const { chain, client } = chainAt(200, tables, readFees)
      const kept = client()
      await summary(kept)
      assert.equal(reads.length, 1)
      chain.block = 210
      await summary(kept)
      assert.equal(reads.length, 1)
      fee.amount = "24"
      chain.tables = { ...tables, balances: { ...tables.balances, 200: { ETH: String(E18 - 1024n) } } }
      chain.block = 230
      const { positions } = await summary(kept)
      assert.equal(reads.length, 2)
      assert.deepEqual(positions[0]!.slice(1, 2).concat(positions[0]![3]), [String(E18 - 1024n), "reconciled"])
      chain.block = 231
      await summary(kept)
      assert.equal(reads.length, 2)
    })

    it("picks up a reorg of what the wallet held before a first block near the head", async () => {
      const opening = (amount: bigint) => ({ legs: [creditAt(195, 5n)], reference_prices: refsThrough(195), balances: { 189: { ETH: String(amount) }, 200: { ETH: String(amount + 5n) } } })
      const { chain, client } = chainAt(200, opening(E18))
      const kept = client()
      const read = async () => (await kept.getPortfolio(ADDRESS, { from: 190, to: 200 })).legs.find((l) => l.opening)?.delta
      assert.equal(await read(), String(E18))
      chain.tables = opening(2n * E18)
      chain.block = 201
      assert.equal(await read(), String(2n * E18))
    })

    describe("with an unwrap credit that only the balance can confirm", () => {
      const ethReads = (queries: string[]) => queries.filter((q) => q.includes("X'4d2301cc")).length
      const claimAt = (block: number) => ({ ...leg("bb", ETH, ME, "credit", "5", "unwrap"), block_num: String(block) })
      const claim = { legs: [gasAt(195, "bb"), claimAt(195)], reference_prices: refsThrough(195), balances: { 49: { ETH: String(E18) }, 200: { ETH: String(E18) } } }

      it("still retries a block's ETH balance without a new block, then stops", async () => {
        const { chain, client } = chainAt(500, claim, async (requests) => new Map(requests.map(({ txHash }) => [txHash, "0"])))
        const kept = client()
        await summary(kept)
        chain.queries.length = 0
        await summary(kept)
        assert.ok(ethReads(chain.queries) > 0, "a missing balance is read again")
        chain.tables = { ...claim, ethBalances: { 49: String(E18), 194: String(E18), 195: String(E18), 200: String(E18) } }
        await summary(kept)
        chain.queries.length = 0
        await summary(kept)
        assert.equal(ethReads(chain.queries), 0)
      })

      it("keeps its L1 fee as current as the balance on each new block, until it's past the window", async () => {
        const reads: string[] = []
        const readFees: ReadL1Fees = async (requests) => {
          reads.push(...requests.map((r) => r.txHash))
          return new Map(requests.map(({ txHash }) => [txHash, "0"]))
        }
        const { chain, client } = chainAt(200, { ...claim, ethBalances: { 194: String(E18), 195: String(E18) } }, readFees)
        const kept = client()
        await summary(kept)
        assert.equal(reads.length, 1)
        chain.block = 201
        await summary(kept)
        assert.equal(reads.length, 2)
        chain.block = 240
        await summary(kept)
        assert.equal(reads.length, 3)
        chain.block = 241
        await summary(kept)
        assert.equal(reads.length, 3)
      })
    })

    for (const [name, range] of [["with a `to`", { from: 190, to: 200 }], ["without a `to`", { from: 190 }]] as const) {
      describe(`an opening balance put together from reads that each failed for one asset, ${name}`, () => {
        const CLOSING_BLOCKS = [200, 201, 202, 240, 241, 250, 251]
        const tables = (opening: Record<string, string | null>, held: bigint) => ({
          legs: [creditAt(195, 5n)],
          reference_prices: refsThrough(195),
          balances: { 189: opening, ...Object.fromEntries(CLOSING_BLOCKS.map((block) => [block, { ETH: String(held + 5n) }])) },
        })
        const summaryOf = async (client: ReturnType<typeof pricetagClient>) => {
          const { legs, positions } = await client.getPortfolio(ADDRESS, range)
          return { opening: legs.find((l) => l.opening)?.delta, status: positions.find((p) => p.asset === "ETH")?.reconciliation?.status }
        }

        /** Each read misses a different asset, so together they make a whole opening balance. */
        async function assemble() {
          const { chain, client } = chainAt(200, tables({ ETH: String(E18), USDC: null }, E18))
          const kept = client()
          await summaryOf(kept)
          chain.tables = tables({ ETH: null, USDC: "0" }, E18)
          chain.block = 201
          assert.deepEqual(await summaryOf(kept), { opening: String(E18), status: "reconciled" })
          return { chain, client, kept }
        }

        it("still picks up a reorg, and matches a fresh client", async () => {
          const { chain, client, kept } = await assemble()
          chain.tables = tables({ ETH: String(2n * E18), USDC: "0" }, 2n * E18)
          chain.block = 202
          const after = await summaryOf(kept)
          assert.deepEqual(after, { opening: String(2n * E18), status: "reconciled" })
          assert.deepEqual(after, await summaryOf(client()))
          chain.block = 240
          assert.deepEqual(await summaryOf(kept), after)
          chain.block = 250
          assert.deepEqual(await summaryOf(kept), after)
        })

        it("stops reading it once a read of every asset is past the window", async () => {
          const { chain, kept } = await assemble()
          chain.tables = tables({ ETH: String(E18), USDC: "0" }, E18)
          chain.block = 240
          await summaryOf(kept)
          chain.block = 250
          chain.queries.length = 0
          await summaryOf(kept)
          assert.ok(!chain.queries.some((q) => q.includes(", 189) AS r")), chain.queries.join("; "))
        })

        it("keeps trying an asset whose read past the window failed, then stops", async () => {
          const { chain, kept } = await assemble()
          // A reorg, and the one read that would have caught it fails for that asset.
          chain.tables = tables({ ETH: null, USDC: "0" }, 2n * E18)
          chain.block = 240
          await summaryOf(kept)
          chain.tables = tables({ ETH: String(2n * E18), USDC: "0" }, 2n * E18)
          chain.block = 241
          assert.deepEqual(await summaryOf(kept), { opening: String(2n * E18), status: "reconciled" })
          chain.block = 250
          chain.queries.length = 0
          await summaryOf(kept)
          assert.ok(!chain.queries.some((q) => q.includes(", 189) AS r")), chain.queries.join("; "))
        })
      })
    }
  })

  it("needs a first block from somewhere, and checks the rest", async () => {
    const { client } = fakeAmp({})
    await assert.rejects(client.getPortfolio(`0x${ME}`), /No first block/)
    await assert.rejects(client.getLegs(`0x${ME}`), /No first block/)
    await assert.rejects(client.getPortfolio(`0x${ME}`, { from: 50, to: 10 }), /Bad block range/)
    await assert.rejects(client.getPortfolio("nope", { from: 50 }), /isn't a Base address/)
    assert.throws(() => fakeAmp({}, 200, { startBlock: Number(undefined) }), /Bad start block/)
  })

  it("makes `from` optional on the lower-level calls too", async () => {
    const { client } = fakeAmp({ reference_prices: [{ ...reference, timestamp: 1_800_000_000_000 }] }, 200, { startBlock: 50 })
    assert.deepEqual((await client.getLegs(`0x${ME}`)).blocks, { fromBlock: 50, toBlock: 200 })
    assert.deepEqual((await client.getPrices("ETH")).blocks, { fromBlock: 50, toBlock: 200 })
    assert.deepEqual((await client.getLegs(`0x${ME}`, { from: 60 })).blocks, { fromBlock: 60, toBlock: 200 })
  })
})

describe("the client's options", () => {
  const ADDRESS = `0x${ME}`

  it("sends a read that failed to the caller's logger, not the console", async () => {
    const warnings: string[] = []
    const { query } = fakeAmp({})
    const failing: Query = (sql) => (sql.includes("eth_call") ? Promise.reject({ cause: { rawMessage: "rpc is down" } }) : query(sql))
    const client = pricetagClient(failing, { dataset: "benface/pricetag@0.0.1", startBlock: 50, logger: { warn: (message) => warnings.push(message) } })
    const { unreadAssets } = await client.getPortfolio(ADDRESS)
    assert.ok(unreadAssets.includes("ETH"))
    assert.ok(warnings.some((w) => w.includes("rpc is down")))
  })

  it("stops a query at the timeout, and says so", async () => {
    // Accepts connections and never answers. Its sockets have to be closed here, or the client's would keep this process alive.
    const sockets: Socket[] = []
    const server = createNetServer((socket) => void sockets.push(socket.on("error", () => {})))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const { port } = server.address() as AddressInfo
      const client = createPricetag({ url: `http://127.0.0.1:${port}`, dataset: "benface/pricetag@0.0.1", startBlock: 50, timeoutMs: 50 })
      await assert.rejects(client.getLatestPrices(), { message: "Query timed out after 50 ms" })
    } finally {
      for (const socket of sockets) socket.destroy()
      server.close()
    }
  })

  it("puts Amp's message on the error, and keeps the rest as its cause", async () => {
    const client = createPricetag({ url: "http://127.0.0.1:1", dataset: "benface/pricetag@0.0.1", startBlock: 50 })
    await assert.rejects(client.getLatestPrices(), (error: Error) => {
      assert.ok(error.message.length > 0)
      assert.ok(error.cause)
      return true
    })
  })
})

describe("the formatters", () => {
  it("print unknown as unknown, never as $0", () => {
    assert.equal(formatMoney(null), "unknown")
    assert.equal(formatSignedMoney(null), "unknown")
    assert.equal(formatPrice(null), "unknown")
    assert.equal(formatMoney("0"), "$0.00")
  })
})

describe("the package boundary", () => {
  it("keeps the public API small", async () => {
    const sdk = await import("@pricetag/sdk")
    assert.deepEqual(Object.keys(sdk).sort(), ["ASSETS", "TOKENS", "buildPortfolio", "createPricetag", "describeError", "formatAmount", "formatMoney", "formatPrice", "formatSignedAmount", "formatSignedMoney", "isAddress", "pnlOverTime", "pnlStatus", "referenceMarks", "shortHash"])
  })

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
    assert.deepEqual([...seen].sort(), ["chain.ts", "core.ts", "currency.ts", "fold.ts", "format.ts", "hold.ts", "legs.ts", "market.ts", "notes.ts", "portfolio.ts", "reconcile.ts", "tokens.ts", "wallet.ts"])
  })

  it("has the app's browser code import only that part", () => {
    const dirs = ["../src/core/", "../src/ui/", "../src/ui/devices/"]
    for (const dir of dirs) {
      for (const name of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name)) {
        const source = readFileSync(new URL(`${dir}${name}`, import.meta.url), "utf8")
        assert.ok(!source.includes('from "@pricetag/sdk"'), `${name} imports the Amp client`)
        assert.ok(!source.includes("server/"), `${name} imports the server`)
      }
    }
  })

})

describe("reading through aliases", () => {
  it("sends amp-alias only on an aliased query, with the token on both", async () => {
    const seen: { alias: unknown; authorization: unknown }[] = []
    const server = createServer((req, res) => {
      seen.push({ alias: req.headers["amp-alias"], authorization: req.headers.authorization })
      res.writeHead(200, { "content-type": "application/grpc", "grpc-status": "14", "grpc-message": "not a real Amp" })
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const query = createQuery(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "t0ken")
    const aliases = { pricetag: "benface/pricetag@aa", pricing: "benface/fork@bb" }
    await query("SELECT 1").catch(() => {})
    await query.aliased(aliases)("SELECT 1").catch(() => {})
    server.close()
    assert.ok(seen.length >= 2)
    assert.equal(seen[0]!.alias, undefined)
    assert.equal(seen.at(-1)!.alias, JSON.stringify(aliases))
    for (const { authorization } of seen) assert.match(String(authorization), /t0ken/)
  })

  it("reads prices from the price dataset, and what happened on the chain from the other", async () => {
    const { query, queries } = fakeAmp({ legs: [], unlisted_legs: [], priced_legs: [], reference_prices: [] })
    const reader = datasetReader(query, { baseDataset: "base", dataset: "pricetag", priceDataset: "pricing" })
    await reader.readWindow("0x" + ME, 1, 2)
    await reader.readReferences([1])
    await reader.processedThrough(1, 200)
    const from = (table: string) => [...new Set(queries.filter((sql) => sql.includes(`.${table} `)).map((sql) => /FROM "(\w+)"/.exec(sql)![1]))]
    assert.deepEqual(from("legs"), ["pricetag"])
    assert.deepEqual(from("unlisted_legs"), ["pricetag"])
    assert.deepEqual(from("priced_legs"), ["pricing"])
    assert.deepEqual(from("reference_prices"), ["pricing"])
  })

  it("reads everything from one dataset when there's no price dataset", async () => {
    const { query, queries } = fakeAmp({ legs: [], unlisted_legs: [], priced_legs: [], reference_prices: [] })
    await datasetReader(query, { baseDataset: "base", dataset: "pricetag" }).readWindow("0x" + ME, 1, 2)
    for (const sql of queries) assert.match(sql, /FROM "pricetag"\./)
  })
})
