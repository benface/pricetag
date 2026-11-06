import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { after, before, describe, it } from "node:test"
import type { ExplanationResponse, PortfolioResponse, WalletResponse } from "../src/core/api.ts"
import { DEMO_WALLET, demoRates } from "../src/core/fixtures.ts"
import { CURRENCIES, atCurrentRate, currentRateMicros, foldPositions, formatMoney, formatUsdIn, formatPrice, formatRate, formatSignedMoney, openingLegs, pnlOverTime, sumTotals, unconfirmedAssets, unreadAssets, viewWallet, type LegEffect, type PricedLeg, type RateRound, type Rates } from "@pricetag/sdk/core"
import { describeConversion, describeEffect, explainContext, explainTarget, type ExplainTarget } from "../src/core/explain.ts"
import { createApi } from "../server/app.ts"
import { explainPortfolio, portfolioOf } from "../src/core/portfolio.ts"
import { createRates, decodeRound, feedRounds, updateRounds, type RoundReader } from "@pricetag/sdk/internal"

const E18 = 10n ** 18n
const BUY_BLOCK = 100
const SELL_BLOCK = 200
const GAS_BLOCK = 300
const HEAD = 400
const time = (block: number) => new Date(Date.UTC(2026, 10, 4) + block * 2000).toISOString()
const seconds = (block: number) => Date.parse(time(block)) / 1000

const leg = (fields: Partial<PricedLeg> & Pick<PricedLeg, "id" | "blockNum" | "delta">): PricedLeg => ({
  asset: "ETH",
  decimals: 18,
  kind: "swap",
  priceMicros: null,
  costMicros: null,
  proceedsMicros: null,
  costLabel: "unknown",
  priceSource: "oracle",
  priceNote: null,
  timestamp: time(fields.blockNum),
  txHash: `0x${fields.id}`,
  txIndex: 0,
  parts: [],
  ...fields,
})

// Buys 1 ETH for $2,000, then sells it for the same $2,000: nothing in USD, but the US dollar went up against CAD.
const buy = leg({ id: "buy", blockNum: BUY_BLOCK, delta: E18.toString(), priceMicros: "2000000000", costMicros: "2000000000", costLabel: "paid" })
const sell = leg({ id: "sell", blockNum: SELL_BLOCK, delta: `-${E18 / 2n}`, priceMicros: "2000000000", proceedsMicros: "1000000000" })
const gas = leg({ id: "gas", blockNum: GAS_BLOCK, kind: "gas", delta: `-${E18 / 1000n}`, priceMicros: "2000000000" })

/** USD for one CAD, with 8 decimals, for a rate given as CAD for one USD. */
const answerFor = (cadPerUsd: number) => String(Math.round(1e8 / cadPerUsd))
const round = (block: number, cadPerUsd: number) => ({ answer: answerFor(cadPerUsd), updatedAt: seconds(block) })

const RATES: Rates = {
  byBlock: { [BUY_BLOCK]: round(BUY_BLOCK, 1.25), [SELL_BLOCK]: round(SELL_BLOCK, 1.6), [GAS_BLOCK]: round(GAS_BLOCK, 1.6) },
  latest: { blockNum: HEAD, round: round(HEAD, 2) },
}

const walletWith = (changes: Partial<WalletResponse>): WalletResponse => ({
  ...DEMO_WALLET,
  address: "0xabc",
  mode: "raw",
  legs: [buy, sell],
  references: [],
  prices: { ETH: { micros: "3000000000", source: "oracle", blockNum: HEAD } },
  latest: { blockNum: HEAD, timestamp: time(HEAD) },
  // What the legs add up to, so these are about currency and not about reconciling.
  balances: { blockNum: HEAD, amounts: { ETH: (E18 / 2n).toString() } },
  openingUnread: [],
  unreadBalances: [],
  lastBalances: {},
  lastCheckableEth: null,
  l1FeeUnknownTxs: [],
  currency: "CAD",
  rates: RATES,
  ...changes,
})

const withoutRate = (block: number): Rates => {
  const byBlock = { ...RATES.byBlock }
  delete byBlock[block]
  return { ...RATES, byBlock }
}

const foldOf = (wallet: WalletResponse) => {
  const view = viewWallet(wallet)
  const positions = foldPositions(view.legs, "average", view.prices)
  return { view, positions, totals: sumTotals(positions), eth: positions[0]! }
}

describe("converting a wallet", () => {
  it("converts cost and proceeds at each transaction's own rate, not at one rate", () => {
    const { eth } = foldOf(walletWith({}))
    // Half of a C$2,500 cost (at 1.25), sold for US$1,000 at 1.60: C$1,600 − C$1,250. In USD this sale made nothing.
    assert.equal(eth.values.realizedMicros, "350000000")
    assert.equal(eth.values.costMicros, "1250000000")
    assert.equal(foldOf(walletWith({ currency: "USD", rates: null })).eth.values.realizedMicros, "0")
  })

  it("values what's held at the current rate, against the cost at the old one", () => {
    const { eth } = foldOf(walletWith({}))
    // 0.5 ETH at US$3,000 is US$1,500, which at 2.00 is C$3,000, on a cost of C$1,250.
    assert.equal(eth.values.valueMicros, "3000000000")
    assert.equal(eth.values.unrealizedMicros, "1750000000")
    assert.equal(eth.price?.usdMicros, "3000000000")
  })

  it("is the same whichever method runs, for a sale of everything", () => {
    const all = leg({ id: "all", blockNum: SELL_BLOCK, delta: `-${E18}`, priceMicros: "2000000000", proceedsMicros: "2000000000" })
    const view = viewWallet(walletWith({ legs: [buy, all] }))
    for (const method of ["average", "fifo"] as const) {
      assert.equal(foldPositions(view.legs, method, view.prices)[0]?.values.realizedMicros, "700000000")
    }
  })

  it("leaves USD alone, and marks nothing as converted", () => {
    const view = viewWallet(walletWith({ currency: "USD", rates: null }))
    assert.deepEqual(view.legs, [buy, sell])
    assert.equal(view.latestRate, null)
    assert.deepEqual(view.missingRateTxs, [])
  })

  it("keeps what each leg was in USD, and its rate", () => {
    const [converted] = viewWallet(walletWith({})).legs
    assert.equal(converted?.costMicros, "2500000000")
    assert.equal(converted?.conversion?.costUsdMicros, "2000000000")
    assert.equal(converted?.conversion?.rateMicros, "1250000")
  })

  it("marks the chart at each transaction's own rate", () => {
    const usd = walletWith({ references: [{ blockNum: BUY_BLOCK, ethUsd: "200000000000", usdcUsd: "100000000" }] })
    assert.equal(viewWallet(usd).markPrice(BUY_BLOCK, "ETH"), "2500000000")
    assert.equal(viewWallet({ ...usd, rates: withoutRate(BUY_BLOCK) }).markPrice(BUY_BLOCK, "ETH"), null)
    const marketMarks = { [BUY_BLOCK]: { AERO: "1300000" } }
    assert.equal(viewWallet({ ...usd, marketMarks, currency: "USD", rates: null }).markPrice(BUY_BLOCK, "AERO"), "1300000")
    assert.equal(viewWallet({ ...usd, marketMarks }).markPrice(BUY_BLOCK, "AERO"), "1625000", "at the rate of that block")
    assert.equal(viewWallet({ ...usd, marketMarks, rates: withoutRate(BUY_BLOCK) }).markPrice(BUY_BLOCK, "AERO"), null)
  })
})

describe("a missing rate", () => {
  it("makes a purchase's cost unknown, so PnL on it is unavailable and not zero", () => {
    const { view, eth, totals } = foldOf(walletWith({ rates: withoutRate(BUY_BLOCK) }))
    assert.deepEqual(view.missingRateTxs, ["0xbuy"])
    assert.equal(view.legs[0]?.costMicros, null)
    assert.equal(view.legs[0]?.costLabel, "unknown")
    assert.equal(eth.values.costMicros, null)
    assert.equal(eth.values.unrealizedMicros, null)
    assert.equal(eth.values.realizedMicros, null, "its cost is what the sale needs")
    assert.equal(totals.pnlMicros, null)
  })

  it("makes a sale's proceeds unknown, without touching the cost of what's left", () => {
    const { view, eth, totals } = foldOf(walletWith({ rates: withoutRate(SELL_BLOCK) }))
    assert.equal(view.legs[1]?.proceedsMicros, null)
    assert.equal(eth.values.realizedMicros, null)
    assert.equal(eth.values.unrealizedMicros, "1750000000")
    assert.deepEqual(totals.excluded.map((e) => e.reason), ["sold or spent at an unknown price"])
    const explanation = explainPortfolio(walletWith({ rates: withoutRate(SELL_BLOCK) }), "average", { kind: "asset", asset: "ETH", metric: "realized" })
    assert.ok(explanation?.lines.some((line) => line.includes("was sold or spent at an unknown price, so its gain can't be known.")))
    assert.ok(explanation?.lines.every((line) => !line.includes("unknown cost")))
  })

  it("never borrows a rate from another block, even the current one", () => {
    const { view } = foldOf(walletWith({ rates: withoutRate(BUY_BLOCK) }))
    assert.equal(view.legs[0]?.priceMicros, null)
    assert.equal(view.legs[0]?.priceSource, null)
    assert.equal(view.legs[0]?.conversion?.rateMicros, null)
    assert.equal(view.legs[0]?.conversion?.priceUsdMicros, "2000000000", "what it was in USD is still a fact")
  })

  it("leaves gas out of the total, and says so", () => {
    const { totals, view } = foldOf(walletWith({ legs: [buy, gas], rates: withoutRate(GAS_BLOCK) }))
    assert.equal(totals.unpricedGas, true)
    assert.equal(totals.gasMicros, null)
    assert.deepEqual(view.missingRateTxs, ["0xgas"])
  })

  it("gives what's held no current value when there's no current rate, but keeps its cost", () => {
    const { view, eth, totals } = foldOf(walletWith({ rates: { ...RATES, latest: null } }))
    assert.equal(view.latestRate, null)
    assert.equal(eth.price, null)
    assert.equal(eth.values.valueMicros, null)
    assert.equal(eth.values.unrealizedMicros, null)
    assert.equal(eth.values.costMicros, "1250000000")
    assert.equal(eth.values.realizedMicros, "350000000", "what's already been sold doesn't need today's rate")
    assert.ok(totals.excluded.some((e) => e.reason === "no current price"))
  })

  it("treats a feed that stopped updating, or answered nothing usable, as no rate", () => {
    const stale = { answer: answerFor(1.25), updatedAt: seconds(BUY_BLOCK) - 4 * 24 * 60 * 60 }
    assert.deepEqual(foldOf(walletWith({ rates: { ...RATES, byBlock: { ...RATES.byBlock, [BUY_BLOCK]: stale } } })).view.missingRateTxs, ["0xbuy"])
    const closedMarket = { answer: answerFor(1.25), updatedAt: seconds(BUY_BLOCK) - 2.5 * 24 * 60 * 60 }
    assert.deepEqual(foldOf(walletWith({ rates: { ...RATES, byBlock: { ...RATES.byBlock, [BUY_BLOCK]: closedMarket } } })).view.missingRateTxs, [])
    const empty = { answer: "0", updatedAt: seconds(BUY_BLOCK) }
    assert.deepEqual(foldOf(walletWith({ rates: { ...RATES, byBlock: { ...RATES.byBlock, [BUY_BLOCK]: empty } } })).view.missingRateTxs, ["0xbuy"])
  })

  it("doesn't count a transaction that had nothing to convert", () => {
    const nothing = leg({ id: "free", blockNum: BUY_BLOCK, delta: E18.toString(), priceMicros: null })
    assert.deepEqual(foldOf(walletWith({ legs: [nothing], rates: withoutRate(BUY_BLOCK) })).view.missingRateTxs, [])
  })
})

describe("explaining a converted number", () => {
  it("shows the number in both currencies, and where the rate came from", () => {
    const explanation = explainPortfolio(walletWith({}), "average", { kind: "asset", asset: "ETH", metric: "realized" })
    assert.equal(explanation?.value, "+$350.00")
    assert.equal(explanation?.sourceValue, "$0.00 USD")
    assert.equal(explanation?.currency, "CAD")
    assert.ok(explanation?.lines.some((line) => line.includes("Chainlink's CAD / USD price on Base")))
  })

  it("says what each transaction was in USD and at what rate", () => {
    const explanation = explainPortfolio(walletWith({}), "average", { kind: "asset", asset: "ETH", metric: "amount" })
    const bought = explanation?.legs.find((l) => l.id === "buy")
    assert.equal(bought?.conversion, "In USD: $2,000.00 each, $2,000.00 paid. 1 USD = $1.2500 CAD at this block, from Chainlink's CAD / USD price on Base.")
    assert.match(bought?.effect ?? "", /for \$2,500\.00$/)
  })

  it("says the current rate where a current value uses it", () => {
    const explanation = explainPortfolio(walletWith({}), "average", { kind: "asset", asset: "ETH", metric: "value" })
    assert.equal(explanation?.value, "$3,000.00")
    assert.equal(explanation?.sourceValue, "$1,500.00 USD")
    assert.ok(explanation?.lines.some((line) => line.includes("1 USD = $2.0000 CAD at block 400")))
  })

  it("says why there's no number when a rate is missing, and still gives the USD one", () => {
    const explanation = explainPortfolio(walletWith({ rates: withoutRate(BUY_BLOCK) }), "average", { kind: "asset", asset: "ETH", metric: "realized" })
    assert.equal(explanation?.value, null)
    assert.equal(explanation?.sourceValue, "$0.00 USD")
    assert.ok(explanation?.lines.some((line) => line.startsWith("1 transaction has no USD to CAD rate")))
    assert.match(explanation?.legs.find((l) => l.id === "buy")?.conversion ?? "", /^⚠ No USD to CAD rate for this transaction, so it has no CAD value\. In USD: /)
    const current = explainPortfolio(walletWith({ rates: { ...RATES, latest: null } }), "average", { kind: "asset", asset: "ETH", metric: "value" })
    assert.equal(current?.value, null)
    assert.ok(current?.lines.some((line) => line.startsWith("There's no current USD to CAD rate")))
    assert.ok(current?.lines.every((line) => !line.includes("oracle read")))
  })

  it("says nothing about rates in USD", () => {
    const explanation = explainPortfolio(walletWith({ currency: "USD", rates: null }), "average", { kind: "total", metric: "pnl" })
    assert.equal(explanation?.sourceValue, null)
    assert.equal(explanation?.currency, "USD")
    assert.ok(explanation?.lines.every((line) => !line.includes("Chainlink")))
    assert.equal(explanation?.legs[0]?.conversion, null)
  })

  it("gives a transaction on the chart both values", () => {
    const explanation = explainPortfolio(walletWith({ prices: {} }), "average", { kind: "tx", txHash: "0xsell" })
    assert.equal(explanation?.value, "+$350.00", "half the ETH is still held with no mark at this block, so this is only what's known")
    assert.match(explanation?.lines[0] ?? "", /Leaves out 1 unknown amount/)
    const closed = leg({ id: "all", blockNum: SELL_BLOCK, delta: `-${E18}`, priceMicros: "2000000000", proceedsMicros: "2000000000" })
    const both = explainPortfolio(walletWith({ legs: [buy, closed], balances: { blockNum: HEAD, amounts: { ETH: "0" } } }), "average", { kind: "tx", txHash: "0xall" })
    assert.equal(both?.value, "+$700.00")
    assert.equal(both?.sourceValue, "$0.00 USD")
  })
})

describe("what's open when the currency changes", () => {
  const closed = leg({ id: "all", blockNum: SELL_BLOCK, delta: `-${E18}`, priceMicros: "2000000000", proceedsMicros: "2000000000" })
  const closedWallet = (changes: Partial<WalletResponse>) => walletWith({ legs: [buy, closed], balances: { blockNum: HEAD, amounts: { ETH: "0" } }, ...changes })
  const explainIn = (wallet: WalletResponse, target: ExplainTarget) => {
    const view = viewWallet(wallet)
    const positions = foldPositions(view.legs, "average", view.prices, wallet)
    const unread = unreadAssets(positions, wallet)
    const totals = sumTotals(positions, unread)
    const points = pnlOverTime(view.legs, "average", view.prices, view.markPrice, wallet.latest, unconfirmedAssets(positions, unread))
    return explainTarget(target, { positions, totals, points }, explainContext(wallet, view, "average"))
  }
  const USD = closedWallet({ currency: "USD", rates: null })
  const CAD = closedWallet({})
  const cases: [string, ExplainTarget, cad: string, usd: string][] = [
    ["a total", { kind: "total", metric: "realized" }, "+$700.00", "$0.00"],
    ["an asset", { kind: "asset", asset: "ETH", metric: "realized" }, "+$700.00", "$0.00"],
    ["a transaction on the chart", { kind: "tx", txHash: "0xall" }, "+$700.00", "$0.00"],
  ]

  for (const [name, target, cad, usd] of cases) {
    it(`gives the same target for ${name} the new numbers, going to CAD`, () => {
      const before = explainIn(USD, target)
      assert.equal(before?.value, usd)
      assert.equal(before?.currency, "USD")
      assert.equal(before?.sourceValue, null)
      const after = explainIn(CAD, target)
      assert.equal(after?.value, cad)
      assert.equal(after?.currency, "CAD")
      assert.equal(after?.sourceValue, `${usd} USD`)
    })

    it(`gives the same target for ${name} the new numbers, going to USD`, () => {
      assert.equal(explainIn(CAD, target)?.value, cad)
      const after = explainIn(USD, target)
      assert.equal(after?.value, usd)
      assert.equal(after?.currency, "USD")
      assert.ok(after?.lines.every((line) => !line.includes("Chainlink")))
    })
  }

  it("carries the currency its legs are in, so they can't be printed in another", () => {
    const [newest] = explainIn(CAD, { kind: "total", metric: "pnl" })?.effects ?? []
    assert.equal(newest?.leg.conversion?.rateMicros, "1600000")
    assert.equal(describeEffect(newest as LegEffect, "CAD"), "Sold for $3,200.00, realized +$700.00")
  })

  it("has nothing to say about an asset or transaction that's gone", () => {
    assert.equal(explainIn(CAD, { kind: "asset", asset: "AERO", metric: "value" }), null)
    assert.equal(explainIn(CAD, { kind: "tx", txHash: "0xgone" }), null)
  })
})

describe("what a wallet already held", () => {
  const opening = openingLegs({ blockNum: BUY_BLOCK - 1, amounts: { ETH: E18.toString() } }, time(BUY_BLOCK - 1))

  it("has nothing to convert, so it isn't a missing rate", () => {
    const { view } = foldOf(walletWith({ legs: [...opening, buy], rates: RATES }))
    assert.deepEqual(view.missingRateTxs, [])
    assert.equal(view.legs[0]?.conversion, undefined)
    assert.equal(describeConversion(view.legs[0] as PricedLeg, "CAD"), null)
  })

  it("needs no rate read", async () => {
    const asked: number[][] = []
    const read: RoundReader = async (_feed, blocks) => {
      asked.push([...blocks])
      return new Map()
    }
    await createRates(read)("CAD", { legs: [...opening, buy], latest: { blockNum: HEAD, timestamp: time(HEAD) } })
    assert.deepEqual(asked, [[BUY_BLOCK, HEAD]])
  })
})

describe("a portfolio in another currency", () => {
  it("says what it's in, where its rates came from and what's missing", () => {
    const portfolio = portfolioOf(walletWith({ rates: withoutRate(BUY_BLOCK) }), "average")
    assert.equal(portfolio.currency, "CAD")
    assert.equal(portfolio.exchange?.source, "Chainlink's CAD / USD price on Base")
    assert.equal(portfolio.exchange?.latestRateMicros, "2000000")
    assert.deepEqual(portfolio.exchange?.missingRateTxs, ["0xbuy"])
  })

  it("has no exchange in USD", () => {
    assert.equal(portfolioOf(DEMO_WALLET, "average").exchange, null)
  })

  it("gives the demo wallet different numbers in CAD than one rate would", () => {
    const usd = portfolioOf(DEMO_WALLET, "average")
    const cad = portfolioOf({ ...DEMO_WALLET, currency: "CAD", rates: demoRates("CAD") }, "average")
    assert.deepEqual(cad.exchange?.missingRateTxs, [])
    assert.equal(cad.positions.length, usd.positions.length)
    const realized = (p: PortfolioResponse) => BigInt(p.positions.find((x) => x.asset === "AERO")?.values.realizedMicros as string)
    const latest = Number(demoRates("CAD").latest?.round.answer) / 1e8
    assert.notEqual(Number(realized(cad)), Math.round(Number(realized(usd)) / latest))
  })
})

describe("formatting a currency", () => {
  it("prints each with its own symbol and locale", () => {
    assert.equal(formatMoney("1234560000", "CAD"), "$1,234.56")
    assert.equal(formatMoney("1234560000", "USD"), "$1,234.56")
    assert.equal(formatSignedMoney("1234560000", "CAD"), "+$1,234.56")
    assert.equal(formatSignedMoney("-1234560000", "CAD"), "-$1,234.56")
    assert.equal(formatMoney("1234", "CAD"), "$0.0012")
    assert.equal(formatPrice("999800", "CAD"), "$0.9998")
    assert.equal(formatRate("1397310", "CAD"), "$1.3973")
  })

  it("knows a feed for every currency but USD", () => {
    for (const currency of Object.values(CURRENCIES)) assert.equal(currency.feed === null, currency.code === "USD", currency.code)
  })
})

describe("reading rates", () => {
  const word = (value: bigint) => value.toString(16).padStart(64, "0")
  const data = (answer: bigint, updatedAt: bigint) => word(2n) + word(answer) + word(updatedAt) + word(updatedAt) + word(2n)
  const walletAt = (head: number, blocks: number[]) => ({ legs: blocks.map((b) => leg({ id: `b${b}`, blockNum: b, delta: "1" })), latest: { blockNum: head, timestamp: time(head) } })

  it("decodes a round, and refuses what isn't one", () => {
    assert.deepEqual(decodeRound(data(71566080n, 1_800_000_000n)), { answer: "71566080", updatedAt: 1_800_000_000 })
    assert.equal(decodeRound(data(0n, 1_800_000_000n)), null)
    assert.equal(decodeRound(data((1n << 256n) - 1n, 1_800_000_000n)), null, "a negative answer")
    assert.equal(decodeRound(""), null)
    assert.equal(decodeRound(null), null)
  })

  describe("from the rates dataset", () => {
    const update = (block: number, currency: string, answer: string) => ({ block_num: String(block), currency, answer, updated_at: String(1_800_000_000 + block) })
    /** A table whose rows can change between reads, and a contract that answers `onchain` at the blocks it's asked about. */
    const reader = (table: { rows: object[] | Error }, onchain: (block: number) => string | null = () => null) => {
      const sql: string[] = []
      const exactly: number[][] = []
      const exact: RoundReader = async (_currency, blocks) => {
        exactly.push([...blocks])
        return new Map(blocks.flatMap((block) => {
          const answer = onchain(block)
          return answer ? [[block, { answer, updatedAt: 1_800_000_000 + block }]] : []
        }))
      }
      const read = updateRounds((async <T>(text: string) => {
        sql.push(text)
        if (table.rows instanceof Error) throw table.rows
        return table.rows as T[]
      }) as never, "benface/pricetag_rates@0.1.0", exact)
      return { sql, exactly, read }
    }

    it("takes each block's latest update of that currency at or before it, and leaves out a block before any", async () => {
      const { sql, exactly, read } = reader({ rows: [update(90, "CAD", "71000000"), update(95, "EUR", "112000000"), update(100, "CAD", "72000000"), update(100, "CAD", "73000000"), update(150, "EUR", "113000000")] })
      const rounds = await read("CAD", [120, 80, 100, 99])
      assert.deepEqual(Object.fromEntries(rounds), { 99: { answer: "71000000", updatedAt: 1_800_000_090 }, 100: { answer: "73000000", updatedAt: 1_800_000_100 }, 120: { answer: "73000000", updatedAt: 1_800_000_100 } })
      assert.deepEqual(exactly, [], "every block is before the table's newest row")
      assert.match(sql[0] as string, /FROM "benface\/pricetag_rates@0\.1\.0"\.rate_updates WHERE block_num >= \d+ ORDER BY block_num, log_index$/)
    })

    it("reads the contract from the table's newest row on, so a lagging table never gives an old rate, and stops once it catches up", async () => {
      // The table has reached 900. CAD changed at 950, which is onchain but not in the table yet.
      const table = { rows: [update(800, "CAD", "71000000"), update(900, "EUR", "113000000")] as object[] }
      const { exactly, read } = reader(table, (block) => (block >= 950 ? "72000000" : "71000000"))
      const lagging = await read("CAD", [850, 900, 1000])
      assert.equal(lagging.get(850)?.answer, "71000000")
      assert.equal(lagging.get(1000)?.answer, "72000000", "not the table's older answer")
      assert.deepEqual(exactly, [[900, 1000]])
      table.rows = [...table.rows, update(950, "CAD", "72000000"), update(1010, "EUR", "114000000")]
      const caughtUp = await read("CAD", [850, 900, 1000])
      assert.deepEqual([caughtUp.get(900)?.answer, caughtUp.get(1000)?.answer], ["71000000", "72000000"])
      assert.deepEqual(exactly, [[900, 1000]], "nothing more from the contract")
    })

    it("reads the contract for everything before the table's job has written, and passes on other failures", async () => {
      const notStarted = reader({ rows: new Error("no common canonical watermark") }, () => "71000000")
      assert.equal((await notStarted.read("CAD", [100])).get(100)?.answer, "71000000")
      assert.deepEqual(notStarted.exactly, [[100]])
      await assert.rejects(reader({ rows: new Error("connection reset") }).read("CAD", [100]), /connection reset/)
    })

    it("gives the current rate at a head the table hasn't reached, on the first read and the next one at the same head", async () => {
      let onchain = "71000000"
      const ratesFor = createRates(reader({ rows: [update(800, "CAD", "70000000")] }, () => onchain).read)
      const wallet = { legs: [], latest: { blockNum: 1000, timestamp: time(1000) } }
      assert.equal((await ratesFor("CAD", wallet))?.latest?.round.answer, "71000000")
      onchain = "72000000"
      assert.equal((await ratesFor("CAD", wallet))?.latest?.round.answer, "71000000", "the same block's answer doesn't change")
    })
  })

  it("reads the feed through the same query shape as the oracle, leaving out failed reads", async () => {
    const sql: string[] = []
    const read = feedRounds(
      (async <T>(text: string) => {
        sql.push(text)
        return [{ block_num: "5", round: { data: data(71566080n, 1_800_000_000n) } }, { block_num: "6", round: null }, { block_num: "7", round: { data: "" } }] as T[]
      }),
      { baseDataset: "base", network: "base_mainnet" },
    )
    const rounds = await read("CAD", [5, 6, 7])
    assert.deepEqual([...rounds.keys()], [5])
    assert.match(sql[0] as string, /rpc\.base_mainnet\.eth_call\(NULL, evm_encode_hex\('0xA840145F87572E82519d578b1F36340368a25D5d'\), evm_encode_params\('latestRoundData\(\)'\), block_num\)/)
    assert.match(sql[0] as string, /FROM \(SELECT block_num FROM "base"\.blocks WHERE block_num BETWEEN 5 AND 7 AND block_num IN \(5, 6, 7\) LIMIT 3\)/)
  })

  const scripted = () => {
    const asked: number[][] = []
    const failing = new Set<number>()
    const read: RoundReader = async (_feed, blocks) => {
      asked.push([...blocks])
      return new Map(blocks.filter((b) => !failing.has(b)).map((b) => [b, round(b, 1.4)]))
    }
    return { asked, failing, read }
  }

  it("reads a settled block once, and keeps asking about the head and recent blocks", async () => {
    const { asked, read } = scripted()
    const ratesFor = createRates(read)
    await ratesFor("CAD", walletAt(1000, [100, 990]))
    await ratesFor("CAD", walletAt(1002, [100, 990]))
    assert.deepEqual(asked, [[100, 990, 1000], [990, 1002]])
  })

  it("doesn't ask again for a head it just read", async () => {
    const { asked, read } = scripted()
    const ratesFor = createRates(read)
    await ratesFor("CAD", walletAt(1000, [100]))
    const rates = await ratesFor("CAD", walletAt(1000, [100]))
    assert.deepEqual(asked, [[100, 1000]])
    assert.equal(rates?.latest?.blockNum, 1000)
  })

  it("leaves out what the feed didn't answer, and tries it again next time", async () => {
    const { asked, failing, read } = scripted()
    const ratesFor = createRates(read)
    failing.add(100).add(1000)
    const first = await ratesFor("CAD", walletAt(1000, [100]))
    assert.deepEqual(first, { byBlock: {}, latest: null })
    failing.clear()
    const second = await ratesFor("CAD", walletAt(1000, [100]))
    assert.deepEqual(asked.at(-1), [100, 1000])
    assert.ok(second?.byBlock[100])
    assert.equal(second?.latest?.blockNum, 1000)
  })

  it("reads nothing for USD", async () => {
    const { asked, read } = scripted()
    assert.equal(await createRates(read)("USD", walletAt(1000, [100])), null)
    assert.deepEqual(asked, [])
  })
})

describe("the API with a currency", () => {
  let server: Server
  let base: string

  before(async () => {
    const handle = createApi({})
    server = createServer((req, res) => void handle(req, res))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(() => server.close())

  const get = async <T>(path: string) => {
    const response = await fetch(base + path)
    return { status: response.status, body: (await response.json()) as T }
  }

  it("defaults to USD", async () => {
    const { body } = await get<PortfolioResponse>("/api/portfolio/demo")
    assert.equal(body.currency, "USD")
    assert.equal(body.exchange, null)
  })

  it("serves a portfolio and an explanation in CAD", async () => {
    const { body } = await get<PortfolioResponse>("/api/portfolio/demo?currency=CAD")
    assert.equal(body.currency, "CAD")
    assert.equal(body.exchange?.source, "Chainlink's CAD / USD price on Base")
    const explained = await get<ExplanationResponse>("/api/portfolio/demo/explain?metric=pnl&currency=CAD")
    assert.match(explained.body.sourceValue ?? "", / USD$/)
  })

  it("gives the browser USD money and the rates to convert it, since it folds for itself", async () => {
    const { body } = await get<WalletResponse>("/api/wallet/demo?currency=CAD")
    assert.equal(body.currency, "CAD")
    assert.ok(body.rates?.latest)
    assert.deepEqual(body.legs, JSON.parse(JSON.stringify(DEMO_WALLET.legs)))
  })

  it("refuses a currency it doesn't have, rather than showing USD as if it were", async () => {
    assert.equal((await get("/api/portfolio/demo?currency=XXX")).status, 400)
    assert.equal((await get("/api/wallet/demo?currency=usd")).status, 400)
  })
})

describe("the current rate", () => {
  const at = "2026-11-05T12:00:00Z"
  const fresh = Date.parse(at) / 1000 - 60
  const rates = (answer: string, updatedAt = fresh): Rates => ({ byBlock: {}, latest: { blockNum: 1, round: { answer, updatedAt } } })

  it("says what one USD buys", () => {
    assert.equal(currentRateMicros(rates("71500000"), at), "1398601")
  })

  it("is null with no answer, a stopped feed or a zero, and never another day's", () => {
    assert.equal(currentRateMicros(null, at), null)
    assert.equal(currentRateMicros({ byBlock: {}, latest: null }, at), null)
    assert.equal(currentRateMicros(rates("0"), at), null)
    assert.equal(currentRateMicros(rates("71500000", fresh - 4 * 24 * 60 * 60), at), null)
  })

  it("converts what's shown, and says US$ when it can't", () => {
    assert.equal(atCurrentRate("50000000", "1398601"), "69930050")
    assert.equal(formatUsdIn("50000000", "CAD", "1398601"), "$69.93")
    assert.equal(formatUsdIn("50000000", "CAD", null), "US$50.00")
    assert.equal(formatUsdIn("50000000", "USD", null), "$50.00")
    assert.equal(formatUsdIn("50000000", "USD", "1398601"), "$50.00")
  })
})

describe("GET /api/rate", () => {
  const serve = async (created: Parameters<typeof createApi>[1]) => {
    const api = createApi({}, created, null)
    const server = createServer((req, res) => void api(req, res))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    return { server, read: async (query: string) => { const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/rate${query}`); return { status: response.status, body: await response.json() as { rateMicros?: string | null } } } }
  }

  it("has no rate without a data source, because the demo's aren't for real balances, and nothing for USD", async () => {
    const { server, read } = await serve(null)
    assert.deepEqual((await read("?currency=CAD")).body, { currency: "CAD", rateMicros: null })
    assert.deepEqual((await read("?currency=USD")).body, { currency: "USD", rateMicros: null })
    assert.equal((await read("?currency=XYZ")).status, 400)
    assert.equal((await read("?currency=SEK")).status, 400, "no feed, so not a currency here")
    assert.equal((await read("")).status, 400)
    server.close()
  })

  it("reads at the head without any wallet, and has no rate rather than an old one", async () => {
    const timestamp = "2026-11-05T12:00:00Z"
    const updatedAt = Date.parse(timestamp) / 1000 - 60
    let round: RateRound | null = { answer: "71500000", updatedAt }
    const asked: unknown[] = []
    const created = {
      source: { head: async () => ({ blockNum: 10, timestamp }) },
      readRates: async (currency: string, wallet: unknown) => {
        asked.push([currency, wallet])
        if (round === null) throw new Error("No answer")
        return { byBlock: {}, latest: { blockNum: 10, round } }
      },
    } as unknown as Parameters<typeof createApi>[1]
    const { server, read } = await serve(created)
    const quiet = console.error
    console.error = () => {}
    try {
      assert.equal((await read("?currency=CAD")).body.rateMicros, "1398601")
      assert.deepEqual(asked[0], ["CAD", { legs: [], latest: { blockNum: 10, timestamp } }])
      round = { answer: "71500000", updatedAt: updatedAt - 4 * 24 * 60 * 60 }
      assert.equal((await read("?currency=CAD")).body.rateMicros, null)
      round = null
      assert.notEqual((await read("?currency=CAD")).status, 200, "a read that failed doesn't look like an answer")
    } finally {
      console.error = quiet
      server.close()
    }
  })
})
