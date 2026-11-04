import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { USD_CONTEXT, explainMetric } from "../src/core/explain.ts"
import { decodeEthBalance, encodeEthBalanceCall } from "../server/balances.ts"
import { datasetSource } from "../server/source.ts"
import { ETH_ADDRESS, USDC_ADDRESS, WETH_ADDRESS, buildPricedLegs, derivePricedRows, foldPositions, settleUnwraps, sumTotals, unwrapBalanceBlocks, type LegRow, type Onchain, type PricedLeg, type PricedRow, type ReferenceRow } from "@pricetag/sdk/core"

const ME = "0x7b42a330a13a8032a48fd4e6392f46d132104f5e"
const CBBTC = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf"
const BLOCK = 53515217
const ETH_USD = 2420n
const REF: ReferenceRow = { block_num: BLOCK, eth_usd: (ETH_USD * 10n ** 8n).toString(), usdc_usd: "100000000" }
const PRIOR: ReferenceRow = { ...REF, block_num: BLOCK - 10 }

function row(token: string, side: LegRow["side"], amount: bigint | string, kind: LegRow["kind"], tx = "0xcb", block = BLOCK): LegRow {
  return { block_num: block, timestamp: "2026-11-04T00:00:00.000Z", tx_hash: tx, tx_index: 1, log_index: 0, token, account: ME, side, amount: amount.toString(), kind }
}
const claim = (amount: bigint | string, tx = "0xcb", block = BLOCK) => row(ETH_ADDRESS, "credit", amount, "unwrap", tx, block)
const gas = (amount: bigint | string, tx = "0xcb", block = BLOCK) => row(ETH_ADDRESS, "debit", amount, "gas", tx, block)
const balances = (before: bigint | string, after: bigint | string, block = BLOCK) =>
  new Map([
    [block - 1, before.toString()],
    [block, after.toString()],
  ])
const settle = (rows: LegRow[], ethBalances: ReadonlyMap<number, string>, feeUnknownTxs: string[] = [], priced: PricedRow[] = []) =>
  settleUnwraps({ rows, priced, references: [REF], ethBalances, feeUnknownTxs })
const creditsOf = (rows: LegRow[]) => rows.filter((r) => r.kind === "unwrap" && r.side === "credit").map((r) => [r.tx_hash, r.amount, r.settled === true])

// The real transaction 0x23471eb8…, where the sender was credited another account's Withdrawal. Its balance really fell
// by exactly its gas and L1 fee. The purchase before it is made up: this isn't the sender's real history.
const CB_SOLD = 2884455n
const WETH_BACK = 954712603209639146n
const FALSE_CLAIM = 920291285779000000n
const BEFORE = 0x43ecabcd13e3efn
const AFTER = 0x43df5526ea658dn
const FEE = BEFORE - AFTER
const PURCHASE_USDC = 2310_000000n
const PURCHASE: LegRow[] = [row(USDC_ADDRESS, "debit", PURCHASE_USDC, "erc20", "0xbuy", BLOCK - 10), row(CBBTC, "credit", CB_SOLD, "erc20", "0xbuy", BLOCK - 10)]
const SALE: LegRow[] = [gas(FEE), row(CBBTC, "debit", CB_SOLD, "erc20"), row(WETH_ADDRESS, "credit", WETH_BACK, "erc20"), claim(FALSE_CLAIM)]
const references = [REF, PRIOR]
const PRICES = { ETH: { micros: (ETH_USD * 1_000_000n).toString(), source: "oracle" as const, blockNum: BLOCK } }
// USDC starts where the purchase needs it, so the only thing in question is what the sale received.
const FUNDING = [row(USDC_ADDRESS, "credit", PURCHASE_USDC, "erc20", "0xfund", BLOCK - 20), row(ETH_ADDRESS, "credit", BEFORE, "eth", "0xfund", BLOCK - 20)]
const ONCHAIN: Onchain = { balances: { blockNum: BLOCK, amounts: { ETH: (AFTER + WETH_BACK).toString(), cbBTC: "0", USDC: "0" } }, l1FeeUnknownTxs: [] }

function foldOf(rows: LegRow[]) {
  const all = [...FUNDING, ...PURCHASE, ...rows]
  const legs = buildPricedLegs({ account: ME, rows: all, references: [...references, { ...REF, block_num: BLOCK - 20 }], priced: [] })
  const positions = foldPositions(legs, "average", PRICES, ONCHAIN)
  return { legs, positions, cbBtc: positions.find((p) => p.asset === "cbBTC")!, eth: positions.find((p) => p.asset === "ETH")! }
}

const saleOf = (legs: PricedLeg[]) => legs.find((l) => l.asset === "cbBTC" && l.txHash === "0xcb")!

describe("a credit the sender never received", () => {
  const { rows } = settle(SALE, balances(BEFORE, AFTER))

  it("the balance shows nothing arrived, so the credit goes", () => {
    assert.deepEqual(creditsOf(rows), [])
    assert.deepEqual(rows.filter((r) => r.kind !== "unwrap").map((r) => r.kind), ["gas", "erc20", "erc20"])
  })

  it("gives the true realized PnL, and both sides match the chain", () => {
    const { cbBtc, eth, legs } = foldOf(rows)
    assert.equal(cbBtc.reconciliation?.status, "reconciled")
    assert.equal(eth.reconciliation?.status, "reconciled")
    // 0.9547 ETH at $2,420, less the $2,310 it cost.
    assert.equal(cbBtc.values.realizedMicros, "404499")
    assert.equal(saleOf(legs).proceedsMicros, "2310404499")
  })

  it("was inflated before: taking the credit at its word shows over $2,000 of profit", () => {
    const { cbBtc } = foldOf(SALE.map((r) => ({ ...r, settled: true })))
    assert.equal(cbBtc.reconciliation?.status, "reconciled")
    assert.ok(BigInt(cbBtc.values.realizedMicros!) > 2_000_000000n)
  })

  it("the same swap without a balance read has no known PnL, and never the inflated one", () => {
    const { cbBtc, eth, positions, legs } = foldOf(settle(SALE, new Map()).rows)
    // cbBTC's own balance matches the chain, and that doesn't vouch for what it was sold for.
    assert.equal(cbBtc.reconciliation?.status, "reconciled")
    assert.equal(cbBtc.values.realizedMicros, null)
    assert.equal(eth.reconciliation?.status, "incomplete")
    const sale = saleOf(legs)
    assert.equal(sale.proceedsMicros, null)
    assert.equal(sale.unsettledCredit, true)
    assert.match(sale.priceNote!, /couldn't confirm/)
    assert.equal(sumTotals(positions).realizedMicros, null)
  })
})

describe("settling a credit", () => {
  it("keeps one the balance confirms, so a real swap into ETH keeps its value", () => {
    const received = 10n ** 18n
    const rows = [gas(100n), row(USDC_ADDRESS, "debit", 2420_000000n, "erc20"), claim(received)]
    const settled = settle(rows, balances(5000n, 5000n - 100n + received)).rows
    assert.deepEqual(creditsOf(settled), [["0xcb", received.toString(), true]])
    const legs = buildPricedLegs({ account: ME, rows: settled, references, priced: [] })
    assert.equal(legs.find((l) => l.asset === "ETH" && l.kind === "swap")!.costMicros, "2420000000")
    assert.equal(legs.find((l) => l.asset === "ETH" && l.kind === "swap")!.unsettledCredit, undefined)
  })

  it("uses what really arrived when a contract kept a cut", () => {
    const { rows } = settle([gas(100n), claim(1000n)], balances(5000n, 5000n - 100n + 996n))
    assert.deepEqual(creditsOf(rows), [["0xcb", "996", true]])
  })

  it("counts the ETH this transaction sent, and its L1 fee", () => {
    const rows = [gas(100n), row(ETH_ADDRESS, "debit", 30n, "l1_fee"), row(ETH_ADDRESS, "debit", 1000n, "eth"), claim(200n)]
    assert.deepEqual(creditsOf(settle(rows, balances(5000n, 5000n - 100n - 30n - 1000n + 200n)).rows), [["0xcb", "200", true]])
  })

  it("turns several withdrawals in a transaction into one credit", () => {
    const { rows } = settle([gas(100n), claim(700n), claim(300n)], balances(5000n, 5000n - 100n + 996n))
    assert.deepEqual(creditsOf(rows), [["0xcb", "996", true]])
  })

  it("leaves them alone when they add up", () => {
    const { rows } = settle([gas(100n), claim(700n), claim(300n)], balances(5000n, 5000n - 100n + 1000n))
    assert.deepEqual(creditsOf(rows), [["0xcb", "700", true], ["0xcb", "300", true]])
  })

  it("nets to nothing when the wallet unwrapped its own WETH", () => {
    const rows = [gas(100n), row(WETH_ADDRESS, "debit", 1000n, "unwrap"), claim(1000n)]
    const settled = settle(rows, balances(5000n, 5000n - 100n + 1000n)).rows
    assert.deepEqual(buildPricedLegs({ account: ME, rows: settled, references, priced: [] }).map((l) => l.kind), ["gas"])
  })

  it("makes a false credit a plain send, when it was hiding one", () => {
    // The wallet's WETH went to a contract, which unwrapped it and paid someone else.
    const rows = [gas(100n), row(WETH_ADDRESS, "debit", 1000n, "erc20"), claim(1000n)]
    const settled = settle(rows, balances(5000n, 4900n)).rows
    const legs = buildPricedLegs({ account: ME, rows: settled, references, priced: [] })
    assert.deepEqual(legs.map((l) => [l.kind, l.delta]), [["gas", "-100"], ["transfer", "-1000"]])
  })
})

describe("a credit that can't be settled", () => {
  const rows = [gas(100n), claim(1000n)]
  const unsettled = (result: { rows: LegRow[] }) => assert.deepEqual(creditsOf(result.rows), [["0xcb", "1000", false]])

  it("stays a claim when either balance is missing", () => {
    unsettled(settle(rows, new Map()))
    unsettled(settle(rows, new Map([[BLOCK, "5900"]])))
    unsettled(settle(rows, new Map([[BLOCK - 1, "5000"]])))
  })

  it("stays a claim until its gas or L1 fee is known", () => {
    unsettled(settle(rows, balances(5000n, 5900n), ["0xcb"]))
  })

  it("stays a claim when ETH left that we can't see", () => {
    unsettled(settle(rows, balances(5000n, 4000n)))
  })

  it("settles once the read works", () => {
    assert.deepEqual(creditsOf(settle(rows, balances(5000n, 5900n)).rows), [["0xcb", "1000", true]])
  })
})

describe("several of a wallet's transactions in one block", () => {
  const rows = [gas(100n, "0xa"), claim(1000n, "0xa"), gas(50n, "0xb"), claim(400n, "0xb")]
  const start = 5000n
  const fees = 150n

  it("all settle when the change is exactly what they claim", () => {
    assert.deepEqual(creditsOf(settle(rows, balances(start, start - fees + 1400n)).rows), [["0xa", "1000", true], ["0xb", "400", true]])
  })

  it("all go when nothing arrived", () => {
    assert.deepEqual(creditsOf(settle(rows, balances(start, start - fees)).rows), [])
  })

  it("stay claims otherwise, because the difference can't be split between them", () => {
    assert.deepEqual(creditsOf(settle(rows, balances(start, start - fees + 1399n)).rows), [["0xa", "1000", false], ["0xb", "400", false]])
  })

  it("counts a transaction with no claim, which can't be told apart from one that got a cut", () => {
    const mixed = [gas(100n, "0xa"), claim(1000n, "0xa"), gas(50n, "0xb")]
    assert.deepEqual(creditsOf(settle(mixed, balances(start, start - fees + 996n)).rows), [["0xa", "1000", false]])
  })

  it("ignores a transaction that moved no ETH", () => {
    const withToken = [gas(100n), claim(1000n), row(USDC_ADDRESS, "credit", 5n, "erc20", "0xother")]
    assert.deepEqual(creditsOf(settle(withToken, balances(start, start - 100n + 996n)).rows), [["0xcb", "996", true]])
  })

  it("settles each block by itself", () => {
    const two = [gas(100n, "0xa"), claim(1000n, "0xa"), gas(100n, "0xc", BLOCK + 5), claim(1000n, "0xc", BLOCK + 5)]
    const eth = new Map([...balances(5000n, 4900n), ...balances(4900n, 5800n, BLOCK + 5)])
    assert.deepEqual(creditsOf(settle(two, eth).rows), [["0xc", "1000", true]])
    assert.deepEqual(unwrapBalanceBlocks(two), [BLOCK - 1, BLOCK, BLOCK + 4, BLOCK + 5])
  })
})

describe("the priced rows of a settled transaction", () => {
  const SWAP_ROW = (bought: bigint): PricedRow => ({
    block_num: BLOCK,
    tx_hash: "0xcb",
    account: ME,
    sold_token: CBBTC,
    sold_amount: CB_SOLD.toString(),
    bought_token: ETH_ADDRESS,
    bought_amount: bought.toString(),
    priced: { source: "swap", token: "cbBTC", usd_micros: "1" },
  })

  it("stay when the credit was right", () => {
    const rows = [gas(100n), row(CBBTC, "debit", CB_SOLD, "erc20"), claim(1000n)]
    const priced = [SWAP_ROW(1000n)]
    assert.deepEqual(settle(rows, balances(5000n, 5900n), [], priced).priced, priced)
  })

  it("are worked out again from what really arrived", () => {
    const received = 10n ** 18n
    const rows = [gas(100n), row(CBBTC, "debit", CB_SOLD, "erc20"), claim(received + 5n)]
    const settled = settle(rows, balances(5000n, 5000n - 100n + received), [], [SWAP_ROW(received + 5n)])
    assert.deepEqual(settled.priced, derivePricedRows(settled.rows, [REF]))
    assert.equal(settled.priced[0]!.bought_amount, received.toString())
  })

  it("go when the swap was never a swap", () => {
    const rows = [gas(100n), row(CBBTC, "debit", CB_SOLD, "erc20"), claim(1000n)]
    const settled = settle(rows, balances(5000n, 4900n), [], [SWAP_ROW(1000n)])
    assert.deepEqual(settled.priced, [])
    assert.equal(buildPricedLegs({ account: ME, rows: settled.rows, references, priced: settled.priced }).find((l) => l.asset === "cbBTC")!.priceMicros, null)
  })

  it("give a swap its price when a false credit was splitting it into two pairs", () => {
    const settled = settle(SALE, balances(BEFORE, AFTER))
    assert.deepEqual(derivePricedRows(SALE, [REF]), [])
    assert.equal(settled.priced.length, 1)
    assert.equal(settled.priced[0]!.bought_amount, WETH_BACK.toString())
    assert.equal(buildPricedLegs({ account: ME, rows: settled.rows, references, priced: settled.priced }).find((l) => l.asset === "cbBTC")!.priceSource, "swap")
  })

  it("aren't used while the credit is only a claim", () => {
    const rows = [gas(100n), row(CBBTC, "debit", CB_SOLD, "erc20"), claim(10n ** 18n)]
    const settled = settle(rows, new Map(), [], [{ ...SWAP_ROW(10n ** 18n), priced: { source: "swap", token: "cbBTC", usd_micros: "80000000000" } }])
    const legs = buildPricedLegs({ account: ME, rows: settled.rows, references, priced: settled.priced })
    assert.equal(legs.find((l) => l.asset === "cbBTC")!.priceMicros, null)
    // ETH's oracle price is a fact whatever happened here. Only what was paid is in question.
    const eth = legs.find((l) => l.asset === "ETH" && l.kind === "swap")!
    assert.equal(eth.priceSource, "oracle")
    assert.deepEqual([eth.costLabel, eth.costMicros], ["unknown", null])
  })
})

describe("what the explanation says", () => {
  it("names the transactions it couldn't confirm", () => {
    const { eth } = foldOf(settle(SALE, new Map()).rows)
    assert.ok(explainMetric(eth, "onchain", USD_CONTEXT).lines.some((line) => line.includes("couldn't confirm") && line.includes("0xcb")))
  })

  it("names none once they're settled", () => {
    const { eth } = foldOf(settle(SALE, balances(BEFORE, AFTER)).rows)
    assert.ok(!explainMetric(eth, "onchain", USD_CONTEXT).lines.some((line) => line.includes("couldn't confirm")))
  })
})

describe("the ETH balance read", () => {
  const WALLET = "0x00000000000000000000000000000000000000cc"
  const config = { baseDataset: "base", dataset: "ds", startBlock: 1, network: "base_mainnet" }
  const word = (value: bigint) => value.toString(16).padStart(64, "0")

  it("asks Multicall3 for plain ETH, and reads one word back", () => {
    assert.equal(encodeEthBalanceCall(WALLET), `4d2301cc${"cc".padStart(64, "0")}`)
    assert.equal(decodeEthBalance(word(5n)), "5")
    for (const bad of [null, undefined, "", "abc", word(5n) + word(5n)]) assert.equal(decodeEthBalance(bad), null)
  })

  it("reads many blocks in one query, in the shape that can't run eth_call on the whole table", async () => {
    const queries: string[] = []
    const query = async <T>(sql: string) => {
      queries.push(sql)
      return [{ block_num: "41", r: { data: word(7n) } }, { block_num: "42", r: { data: word(8n) } }] as T[]
    }
    const read = await datasetSource(query, config).readEthBalances(WALLET, [41, 42])
    assert.deepEqual([...read], [[41, "7"], [42, "8"]])
    assert.equal(queries.length, 1)
    assert.match(queries[0]!, /FROM \(SELECT block_num FROM "base"\.blocks WHERE block_num BETWEEN 41 AND 42 AND block_num IN \(41, 42\) LIMIT 2\)$/)
    assert.doesNotMatch(queries[0]!, /\.r\b|get_field/)
  })

  it("leaves out a block whose call failed, and doesn't call that zero", async () => {
    const query = async <T>() => [{ block_num: "41", r: { data: null, message: "boom" } }] as T[]
    assert.equal((await datasetSource(query, config).readEthBalances(WALLET, [41])).size, 0)
  })

  it("reads a block the table doesn't have by itself, like the one before a local dataset's start", async () => {
    const queries: string[] = []
    const query = async <T>(sql: string) => {
      queries.push(sql)
      return (sql.includes("FROM") ? [{ block_num: "42", r: { data: word(8n) } }] : [{ r: { data: word(7n) } }]) as T[]
    }
    const read = await datasetSource(query, config).readEthBalances(WALLET, [41, 42])
    assert.deepEqual([...read].sort(), [[41, "7"], [42, "8"]])
    assert.match(queries[1]!, /, 41\) AS r$/)
    assert.doesNotMatch(queries[1]!, /FROM/)
  })
})
