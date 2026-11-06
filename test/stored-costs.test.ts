import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { after, before, describe, it } from "node:test"
import { USDC_ADDRESS, buildPricedLegs, openingLegs, type CurrencyCode, type LegRow, type RateRound } from "@pricetag/sdk/core"
import { createApi } from "../server/app.ts"
import { createRates } from "@pricetag/sdk/internal"
import { readPaidRates } from "../server/rates.ts"
import type { PortfolioResponse, WalletResponse } from "../src/core/api.ts"
import { answerSender, costKey, currenciesIn, emptyBook, enterExchangeCosts, type Book, type ExchangeWithdrawal, type Money } from "../src/core/book.ts"
import { describeConversion } from "../src/core/explain.ts"
import { DEMO_WALLET, demoRates } from "../src/core/fixtures.ts"
import { foldBook } from "../src/core/resolve.ts"
import { walletUrl } from "../src/ui/useWallet.ts"
import { E6 } from "./support/units.ts"

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`
const [ME, SAVINGS, EXCHANGE] = [addr(0xa1), addr(0xb1), addr(0xd1)] as [string, string, string]
const START = Date.UTC(2026, 10, 4)
const timeOf = (block: number) => new Date(START + block * 1000).toISOString()

const move = (block: number, tx: string, account: string, side: LegRow["side"], counterparty: string, amount = 100n * E6): LegRow => ({
  block_num: block,
  timestamp: timeOf(block),
  tx_hash: tx,
  tx_index: 1,
  log_index: 0,
  token: USDC_ADDRESS,
  account,
  side,
  amount: amount.toString(),
  kind: "erc20",
  counterparty,
})

function wallet(address: string, rows: LegRow[], changes: Partial<WalletResponse> = {}): WalletResponse {
  const blocks = [...new Set(rows.map((r) => r.block_num))]
  const references = blocks.map((blockNum) => ({ blockNum, ethUsd: "200000000000", usdcUsd: "100000000" }))
  const legs = buildPricedLegs({ account: address, rows: rows.filter((r) => r.account === address), references, priced: [] })
  const total = legs.reduce((sum, leg) => sum + BigInt(leg.delta), 0n)
  return {
    ...DEMO_WALLET,
    address,
    coverage: { fromBlock: 1, toBlock: 100 },
    references,
    prices: { USDC: { micros: "1000000", source: "oracle", blockNum: 100 } },
    latest: { blockNum: 100, timestamp: timeOf(100) },
    currency: "USD",
    rates: null,
    balances: { blockNum: 100, amounts: { USDC: total.toString() } },
    notes: [],
    unseenEth: [],
    lastBalances: {},
    marketMarks: {},
    ...changes,
    legs,
  }
}

const round = (answer: string, block = 10): RateRound => ({ answer, updatedAt: (START + block * 1000) / 1000 })
const received = move(10, "0x1", ME, "credit", EXCHANGE)
const legId = wallet(ME, [received]).legs[0]!.id
const CAD_90: Money = { micros: "90000000", currency: "CAD" }
const receipt = { wallet: ME, legId, asset: "USDC", units: (100n * E6).toString() }
const withdrawal = (cost: Money): ExchangeWithdrawal => ({ exchange: "Coinbase", asset: "USDC", units: (100n * E6).toString(), at: timeOf(10), cost, fifoCostMicros: null, toAddress: null })

/** The three ways a cost is stored besides a purchase, which has its own tests. */
const BOOKS: [string, (cost: Money) => Book][] = [
  ["an entered cost", (cost) => ({ ...emptyBook(), costs: { [costKey(ME, legId)]: cost } })],
  ["an exchange answer", (cost) => enterExchangeCosts(emptyBook(), ME, EXCHANGE, [receipt], { USDC: cost })],
  ["an imported withdrawal", (cost) => ({ ...emptyBook(), withdrawals: [withdrawal(cost)] })],
]

const legOf = (changes: Partial<WalletResponse>, book: Book) => foldBook(wallet(ME, [received], changes), [], "average", book).legs[0]!

describe("an imported withdrawal's purchases when the main currency changes", () => {
  const paidRates = { CAD: { 10: round("75000000") } }
  const lots = [{ units: (10n * E6).toString(), micros: "1" }, { units: (90n * E6).toString(), micros: "90000000" }]
  const book: Book = { ...emptyBook(), withdrawals: [{ ...withdrawal(CAD_90), fifoCostMicros: "90000001", fifoLots: lots }] }

  it("add up to what all of it converts to, however each one rounds", () => {
    const leg = foldBook(wallet(ME, [received], { paidRates }), [], "fifo", book).legs[0]!
    assert.equal(leg.costMicros, ((90000001n * 75n) / 100n).toString())
    assert.equal(leg.pieces?.reduce((sum, piece) => sum + BigInt(piece.costMicros as string), 0n).toString(), leg.costMicros)
  })

  it("stay unknown with no rate, rather than a CAD amount read as USD", () => {
    const leg = foldBook(wallet(ME, [received]), [], "fifo", book).legs[0]!
    assert.deepEqual([leg.costLabel, leg.costMicros], ["unknown", null])
  })
})

for (const [what, bookOf] of BOOKS) {
  describe(`${what} when the main currency changes`, () => {
    const book = bookOf(CAD_90)
    const cad = { byBlock: { 10: round("75000000") }, latest: null }
    const eur = { byBlock: { 10: round("125000000") }, latest: null }
    const paidRates = { CAD: cad.byBlock }

    it("stays what was entered in its own currency", () => {
      assert.equal(legOf({ currency: "CAD", rates: cad }, book).costMicros, "90000000")
    })

    it("converts to USD at that transaction's rate", () => {
      const leg = legOf({ paidRates }, book)
      assert.deepEqual([leg.costLabel, leg.costMicros], ["self-reported", "67500000"])
    })

    it("goes through USD for another main currency", () => {
      assert.equal(legOf({ currency: "EUR", rates: eur, paidRates }, book).costMicros, "54000000")
    })

    it("comes back to the same amount, because the answer itself never changed", () => {
      const before = structuredClone(book)
      legOf({ paidRates }, book)
      legOf({ currency: "EUR", rates: eur, paidRates }, book)
      assert.deepEqual(book, before)
      assert.equal(legOf({ currency: "CAD", rates: cad }, book).costMicros, "90000000")
    })

    for (const [why, changes] of [
      ["there's no rate for its currency", {}],
      ["the rate's for another block", { paidRates: { CAD: { 11: round("75000000") } } }],
      ["the feed had stopped", { paidRates: { CAD: { 10: { answer: "75000000", updatedAt: START / 1000 - 4 * 24 * 60 * 60 } } } }],
      ["only another currency has a rate", { paidRates: { GBP: { 10: round("135000000") } } }],
      ["the shown currency has no rate", { currency: "EUR", rates: { byBlock: {}, latest: { blockNum: 100, round: round("125000000", 100) } }, paidRates }],
      ["only the shown currency has a rate", { currency: "EUR", rates: eur }],
    ] as [string, Partial<WalletResponse>][]) {
      it(`stays unknown when ${why}, and isn't counted as zero`, () => {
        const before = structuredClone(book)
        const leg = legOf(changes, book)
        assert.deepEqual([leg.costLabel, leg.costMicros], ["unknown", null])
        assert.deepEqual(book, before)
      })
    }
  })
}

describe("a stored cost at each transaction's own rate", () => {
  const later = move(20, "0x2", ME, "credit", EXCHANGE)
  const legs = wallet(ME, [received, later]).legs
  const paidRates = { CAD: { 10: round("75000000"), 20: round("50000000", 20) } }

  it("uses the rate where each arrived, not the latest", () => {
    const book = { ...emptyBook(), costs: { [costKey(ME, legs[0]!.id)]: CAD_90, [costKey(ME, legs[1]!.id)]: CAD_90 } }
    const fold = foldBook(wallet(ME, [received, later], { paidRates }), [], "average", book)
    assert.deepEqual(fold.legs.map((leg) => leg.costMicros), ["67500000", "45000000"])
  })

  it("splits an exchange answer first, then converts each share at its own rate", () => {
    const receipts = legs.map((leg) => ({ wallet: ME, legId: leg.id, asset: "USDC", units: leg.delta }))
    const book = enterExchangeCosts(emptyBook(), ME, EXCHANGE, receipts, { USDC: { micros: "200000000", currency: "CAD" } })
    const fold = foldBook(wallet(ME, [received, later], { paidRates }), [], "average", book)
    assert.deepEqual(fold.legs.map((leg) => leg.costMicros), ["75000000", "50000000"])
  })

  it("carries to a linked wallet, converted by the wallet that holds the answer", () => {
    const rows = [move(10, "0x1", SAVINGS, "credit", EXCHANGE), move(20, "0x2", SAVINGS, "debit", ME), move(20, "0x2", ME, "credit", SAVINGS)]
    const savings = wallet(SAVINGS, rows, { paidRates: { CAD: { 10: round("75000000") } } })
    const mine = wallet(ME, rows)
    const costs = { [costKey(SAVINGS, savings.legs[0]!.id)]: CAD_90 }
    const linked = answerSender(answerSender({ ...emptyBook(), costs }, ME, SAVINGS, { kind: "mine" }), SAVINGS, ME, { kind: "mine" })
    const [leg] = foldBook(mine, [savings], "average", linked).legs
    assert.deepEqual([leg!.costLabel, leg!.costMicros], ["inherited", "67500000"])
  })
})

describe("which rates a stored cost reads", () => {
  const rows = [move(5, "0x0", ME, "debit", EXCHANGE, E6), received, move(20, "0x2", ME, "credit", SAVINGS, 7n * E6)]
  const w = wallet(ME, rows)
  const asks = () => {
    const asked: { currency: string; blocks: number[] }[] = []
    const readRates = async (currency: CurrencyCode, { legs }: Pick<WalletResponse, "legs" | "latest">) => {
      asked.push({ currency, blocks: legs.map((leg) => leg.blockNum) })
      return { byBlock: Object.fromEntries(legs.map((leg) => [leg.blockNum, round("75000000", leg.blockNum)])), latest: null }
    }
    return { asked, readRates }
  }

  for (const [what, bookOf] of BOOKS) {
    it(`reads ${what}'s currency only where it could have arrived`, async () => {
      const { asked, readRates } = asks()
      const rates = await readPaidRates(readRates, w, "USD", [bookOf(CAD_90)])
      assert.deepEqual(asked, [{ currency: "CAD", blocks: [10] }])
      assert.deepEqual(Object.keys(rates?.CAD ?? {}), ["10"])
    })

    it(`reads nothing for ${what} in the currency being shown, or in USD`, async () => {
      for (const [shown, cost] of [["CAD", CAD_90], ["CAD", { micros: "90000000", currency: "USD" }]] as [CurrencyCode, Money][]) {
        const { asked, readRates } = asks()
        assert.equal(await readPaidRates(readRates, w, shown, [bookOf(cost)]), undefined)
        assert.deepEqual(asked, [])
      }
    })
  }

  it("reads nothing for another wallet's answers", async () => {
    const { asked, readRates } = asks()
    const elsewhere = wallet(SAVINGS, [move(10, "0x1", SAVINGS, "credit", EXCHANGE)])
    const costs = { [costKey(ME, legId)]: CAD_90 }
    const answers = enterExchangeCosts({ ...emptyBook(), costs }, ME, EXCHANGE, [receipt], { USDC: CAD_90 })
    assert.equal(await readPaidRates(readRates, elsewhere, "USD", [answers]), undefined)
    assert.deepEqual(asked, [])
  })

  it("reads a currency only once across every answer and candidate", async () => {
    const { asked, readRates } = asks()
    await readPaidRates(readRates, w, "USD", BOOKS.map(([, bookOf]) => bookOf(CAD_90)))
    assert.deepEqual(asked, [{ currency: "CAD", blocks: [10] }])
  })

  it("reads what arrived and what was already held, not what left, for a client that keeps its answers", async () => {
    const { asked, readRates } = asks()
    const held = { ...w, legs: [...openingLegs({ blockNum: 4, amounts: { USDC: "5" } }, timeOf(5)), ...w.legs] }
    await readPaidRates(readRates, held, "USD", [], ["CAD", "USD"])
    assert.deepEqual(asked, [{ currency: "CAD", blocks: [10, 20, 4] }])
  })

  it("reads the rate shown at the start of the history for a USD answer about what was held, and nothing with no such answer", async () => {
    const held = { ...w, legs: [...openingLegs({ blockNum: 4, amounts: { USDC: "5" } }, timeOf(5)), ...w.legs] }
    const client = asks()
    await readPaidRates(client.readRates, held, "CAD", [], ["USD"])
    assert.deepEqual(client.asked, [{ currency: "CAD", blocks: [4] }])
    const none = asks()
    assert.equal(await readPaidRates(none.readRates, held, "CAD", [emptyBook()]), undefined)
    assert.deepEqual(none.asked, [])
  })
})

describe("a cost entered for what the wallet already held", () => {
  const blockOf = 4
  const held = openingLegs({ blockNum: blockOf, amounts: { USDC: (100n * E6).toString() } }, timeOf(blockOf))[0]!
  const key = costKey(ME, held.id)
  const heldWallet = (changes: Partial<WalletResponse> = {}): WalletResponse => {
    const base = wallet(ME, [])
    return { ...base, legs: [held], balances: { blockNum: 100, amounts: { USDC: held.delta } }, ...changes }
  }
  const cost = (money: Money, changes: Partial<WalletResponse> = {}) => foldBook(heldWallet(changes), [], "average", { ...emptyBook(), costs: { [key]: money } }).legs[0]!
  const paidRates = { CAD: { [blockOf]: round("75000000", blockOf) } }

  it("stays exact in the currency it was entered in", () => {
    const leg = cost(CAD_90, { currency: "CAD", rates: { byBlock: {}, latest: null } })
    assert.equal(leg.costMicros, "90000000")
    assert.equal(leg.costLabel, "self-reported")
    assert.equal(leg.estimated, undefined)
    assert.equal(describeConversion(leg, "CAD"), null)
  })

  it("converts at the rate when the history starts, and says that's an estimate", () => {
    const leg = cost(CAD_90, { paidRates })
    assert.equal(leg.costMicros, "67500000")
    assert.equal(leg.costLabel, "self-reported")
    assert.equal(leg.estimated, true)
    assert.match(describeConversion(leg, "USD") as string, /^You entered CA\$90\.00\. The day you paid isn't known, .*estimate\.$/)
  })

  it("reads a USD cost in the currency shown at that same rate", () => {
    const leg = cost({ micros: "75000000", currency: "USD" }, { currency: "CAD", rates: { byBlock: {}, latest: null }, paidRates })
    assert.equal(leg.costMicros, "100000000")
    assert.equal(leg.estimated, true)
  })

  it("counts it as estimated in what's held", () => {
    const { positions } = foldBook(heldWallet({ paidRates }), [], "average", { ...emptyBook(), costs: { [key]: CAD_90 } })
    assert.equal(positions[0]!.values.estimatedCostMicros, "67500000")
  })

  it("stays unknown with no rate, rather than guessing", () => {
    const leg = cost(CAD_90)
    assert.equal(leg.costLabel, "unknown")
    assert.equal(leg.costMicros, null)
    assert.equal(cost(CAD_90, { paidRates: { CAD: { [blockOf]: { answer: "75000000", updatedAt: Date.parse(timeOf(blockOf)) / 1000 - 4 * 24 * 60 * 60 } } } }).costMicros, null)
  })

  it("only asks the live reader for that block when something stored needs it", async () => {
    const asked: number[][] = []
    const readRates = createRates(async (_currency, blocks) => {
      asked.push([...blocks])
      return new Map(blocks.map((block) => [block, round("75000000", block)]))
    })
    const rates = await readPaidRates(readRates, heldWallet(), "USD", [{ ...emptyBook(), costs: { [key]: CAD_90 } }])
    assert.equal(rates?.CAD?.[blockOf]?.answer, "75000000")
    assert.deepEqual(asked, [[blockOf, 100]])
    assert.equal(await readPaidRates(readRates, heldWallet(), "USD", [emptyBook()]), undefined)
    assert.deepEqual(asked, [[blockOf, 100]])
  })
})

describe("the demo wallet's opening DAI, saved at CA$90", () => {
  const book: Book = { ...emptyBook(), costs: { [costKey(DEMO_WALLET.address, "opening:DAI")]: CAD_90 } }
  const dai = (wallet: WalletResponse) => foldBook(wallet, [], "average", book).legs.find((leg) => leg.id === "opening:DAI")!

  it("is CA$90 in CAD, and an estimate in USD and EUR", async () => {
    const cad = await readPaidRates(async (other) => demoRates(other), DEMO_WALLET, "CAD", [book])
    const inCad = dai({ ...DEMO_WALLET, currency: "CAD", rates: demoRates("CAD"), ...(cad ? { paidRates: cad } : {}) })
    assert.deepEqual([inCad.costLabel, inCad.costMicros, inCad.estimated], ["self-reported", "90000000", undefined])

    const usd = await readPaidRates(async (other) => demoRates(other), DEMO_WALLET, "USD", [book])
    const inUsd = dai({ ...DEMO_WALLET, ...(usd ? { paidRates: usd } : {}) })
    assert.deepEqual([inUsd.costLabel, inUsd.estimated], ["self-reported", true])
    assert.equal(inUsd.costMicros, "66870000")

    const eur = await readPaidRates(async (other) => demoRates(other), DEMO_WALLET, "EUR", [book])
    const inEur = dai({ ...DEMO_WALLET, currency: "EUR", rates: demoRates("EUR"), ...(eur ? { paidRates: eur } : {}) })
    assert.deepEqual([inEur.costLabel, inEur.estimated], ["self-reported", true])
    assert.ok(inEur.costMicros)
  })
})

describe("what a book holds amounts in", () => {
  it("names every kind of stored amount once", () => {
    const eur: Money = { micros: "1", currency: "EUR" }
    const gbp: Money = { micros: "1", currency: "GBP" }
    const chf: Money = { micros: "1", currency: "CHF" }
    const book = enterExchangeCosts({ ...emptyBook(), costs: { a: CAD_90, b: CAD_90 }, withdrawals: [withdrawal(eur)] }, ME, EXCHANGE, [receipt], { USDC: gbp })
    assert.deepEqual(currenciesIn({ ...book, purchases: [{ cost: chf } as NonNullable<Book["purchases"]>[number]] }), ["CAD", "CHF", "EUR", "GBP"])
    assert.deepEqual(currenciesIn(emptyBook()), [])
  })
})

describe("switching currency through the API", () => {
  let server: Server
  let base: string
  before(async () => {
    const handle = createApi({})
    server = createServer((req, res) => void handle(req, res))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(() => server.close())

  const first = DEMO_WALLET.legs.find((leg) => leg.asset === "USDC" && leg.costLabel === "unknown" && BigInt(leg.delta) > 0n && !leg.opening)!
  const book: Book = { ...emptyBook(), costs: { [costKey(DEMO_WALLET.address, first.id)]: CAD_90 } }
  const answer = demoRates("CAD").byBlock[first.blockNum]!.answer
  const usd = ((90_000_000n * BigInt(answer)) / 10n ** 8n).toString()
  const costIn = (wallet: WalletResponse) => foldBook(wallet, [], "average", book).legs.find((leg) => leg.id === first.id)!.costMicros
  const read = async (currency: CurrencyCode, paid = "") => (await (await fetch(base + walletUrl("demo", currency, null, paid))).json()) as WalletResponse

  it("gives a browser the rates for what its answers are in, so it can fold them", async () => {
    assert.equal(costIn(await read("USD", "CAD")), usd)
    assert.equal(costIn(await read("EUR", "CAD")), ((BigInt(usd) * 10n ** 8n) / BigInt(demoRates("EUR").byBlock[first.blockNum]!.answer)).toString())
    assert.equal(costIn(await read("CAD", "CAD")), "90000000")
  })

  it("leaves it unknown for a client that doesn't ask, and adds nothing for one with no such answers", async () => {
    const wallet = await read("USD")
    assert.equal(wallet.paidRates, undefined)
    assert.equal(costIn(wallet), null)
  })

  it("refuses a currency it doesn't have", async () => {
    const response = await fetch(`${base}/api/wallet/demo?paid=CAD,XXX`)
    await response.body?.cancel()
    assert.equal(response.status, 400)
  })

  it("reads the rates itself for a client that sends its answers", async () => {
    const response = await fetch(`${base}/api/portfolio/demo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "average", currency: "USD", book }) })
    const { positions } = (await response.json()) as PortfolioResponse
    const fold = foldBook({ ...DEMO_WALLET, paidRates: { CAD: demoRates("CAD").byBlock } }, [], "average", book)
    assert.equal(fold.legs.find((leg) => leg.id === first.id)!.costMicros, usd)
    const costOf = (list: { asset: string; values: { costMicros: string | null } }[]) => list.find((position) => position.asset === "USDC")!.values.costMicros
    assert.equal(costOf(positions), costOf(fold.positions))
  })
})
