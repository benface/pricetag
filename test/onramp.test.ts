import assert from "node:assert/strict"
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto"
import { createServer, request, type Server } from "node:http"
import { after, before, describe, it } from "node:test"
import type { AddressInfo } from "node:net"
import { ASSETS, CURRENCY_CODES, ETH_ADDRESS, MAIN_CURRENCY_CODES, USDC_ADDRESS, buildPricedLegs, type LegRow, type Reference } from "@pricetag/sdk/core"
import type { Source } from "@pricetag/sdk/internal"
import { createApi } from "../server/app.ts"
import { createHandler } from "../server/http.ts"
import { createCoinbase as createOnramp, orderOf, requestToken } from "../server/coinbase.ts"
import { unitsOf, type Onramp } from "../server/onramp.ts"
import { readPaidRates } from "../server/rates.ts"
import { explainPortfolio, portfolioOf } from "../src/core/portfolio.ts"
import type { PortfolioResponse, WalletResponse } from "../src/core/api.ts"
import { costKey, emptyBook, parseBook, type Book, type Purchase } from "../src/core/book.ts"
import { exportCsv } from "../src/core/export.ts"
import { foldBook } from "../src/core/resolve.ts"
import { taxRows } from "../src/core/tax.ts"
import { costTag } from "../src/core/wording.ts"
import { E6 } from "./support/units.ts"
import { assertMatchesFixture } from "./support/fixtures.ts"

const ME = "0x3762620fbcb400b0f98365da4aad7d2a250e5d89"
const COINBASE = "0x4b5c71082d027d16d2a146465d66f9eec11634f6"
const SAVINGS = "0x00000000000000000000000000000000000000b1"
const TX = `0x${"ab".repeat(32)}`
const OTHER_TX = `0x${"cd".repeat(32)}`
const BLOCK = 50
const ETH_BOUGHT = 2_061_830_000_000_000n

const references = (blocks: number[]): Reference[] => blocks.map((blockNum) => ({ blockNum, ethUsd: "200000000000", usdcUsd: "100000000" }))

const move = (block: number, tx: string, account: string, side: LegRow["side"], amount: bigint, counterparty: string | null, token = USDC_ADDRESS, kind: LegRow["kind"] = token === ETH_ADDRESS ? "eth" : "erc20"): LegRow => ({
  block_num: block,
  timestamp: new Date(Date.UTC(2026, 10, 5) + block * 1000).toISOString(),
  tx_hash: tx,
  tx_index: 1,
  log_index: 0,
  token,
  account,
  side,
  amount: amount.toString(),
  kind,
  ...(counterparty ? { counterparty } : {}),
})

function wallet(address: string, rows: LegRow[], changes: Partial<WalletResponse> = {}): WalletResponse {
  const refs = references([...new Set(rows.map((r) => r.block_num))])
  const legs = buildPricedLegs({ account: address, rows: rows.filter((r) => r.account === address), references: refs, priced: [] })
  const amounts: Record<string, string> = {}
  for (const leg of legs) amounts[leg.asset] = (BigInt(amounts[leg.asset] ?? 0) + BigInt(leg.delta)).toString()
  return {
    address,
    mode: "demo",
    coverage: { fromBlock: 1, toBlock: 100 },
    references: refs,
    prices: { USDC: { micros: "1000000", source: "oracle", blockNum: 100 }, ETH: { micros: "2000000000", source: "oracle", blockNum: 100 } },
    latest: { blockNum: 100, timestamp: "2026-11-05T00:10:00.000Z" },
    currency: "USD",
    rates: null,
    gasUnknownTxs: [],
    gasUnknownBlocks: [],
    l1FeeUnknownTxs: [],
    balances: { blockNum: 100, amounts },
    openingUnread: [],
    lastBalances: {},
    lastCheckableEth: null,
    unreadBalances: [],
    unseenEth: [],
    notes: [],
    marketChecked: true,
    marketMarks: {},
    unlisted: [],
    otherTokens: [],
    otherTokensLeftOut: 0,
    ...changes,
    legs,
  }
}

const purchase = (changes: Partial<Purchase> = {}): Purchase => ({ provider: "coinbase", order: "order-1", wallet: ME, asset: "USDC", units: (25n * E6).toString(), txHash: TX, blockNum: BLOCK, cost: { micros: "25800000", currency: "USD" }, costUsdMicros: null, ...changes })
const bookWith = (...purchases: Purchase[]): Book => ({ ...emptyBook(), purchases })
const delivered = move(BLOCK, TX, ME, "credit", 25n * E6, COINBASE)
const legOf = (w: WalletResponse, book: Book, others: WalletResponse[] = [], id = `${TX}:USDC`) => foldBook(w, others, "average", book).legs.find((leg) => leg.id === id)!
const stateOf = (w: WalletResponse, book: Book) => foldBook(w, [], "average", book).purchases[0]?.state

describe("a purchase's cost", () => {
  it("is what the order says was paid, fees included, with nothing asked", () => {
    const w = wallet(ME, [delivered])
    assert.equal(foldBook(w, [], "average", emptyBook()).questions.length, 1, "without the purchase, it's asked about")
    const fold = foldBook(w, [], "average", bookWith(purchase()))
    assert.deepEqual(fold.questions, [])
    const leg = fold.legs[0]!
    assert.deepEqual([leg.costLabel, leg.costMicros, leg.purchaseSource], ["paid", "25800000", "Bought on Coinbase"])
    assert.equal(stateOf(w, bookWith(purchase())), "recorded")
    assert.equal(fold.positions.find((p) => p.asset === "USDC")!.values.costMicros, "25800000")
  })

  for (const [what, changes] of [
    ["another amount", { units: (24n * E6).toString() }],
    ["another asset", { asset: "ETH" }],
    ["another transaction", { txHash: OTHER_TX }],
    ["another wallet", { wallet: SAVINGS }],
  ] as [string, Partial<Purchase>][]) {
    it(`stays unknown and asks as usual, for an order that says ${what}`, () => {
      const w = wallet(ME, [delivered])
      const fold = foldBook(w, [], "average", bookWith(purchase(changes)))
      assert.equal(fold.legs[0]!.costLabel, "unknown")
      assert.equal(fold.legs[0]!.costMicros, null)
      assert.equal(fold.legs[0]!.purchaseSource, undefined)
      assert.equal(fold.questions.length, 1)
    })
  }

  it("says why it isn't recorded: not seen yet, or not what the order says", () => {
    const w = wallet(ME, [delivered])
    assert.equal(stateOf(w, bookWith(purchase({ units: "1" }))), "unmatched")
    assert.equal(stateOf(w, bookWith(purchase({ txHash: OTHER_TX }))), "waiting")
    assert.equal(stateOf(wallet(ME, []), bookWith(purchase())), "waiting")
    assert.equal(stateOf(w, bookWith(purchase({ wallet: SAVINGS }))), undefined, "a wallet that wasn't read says nothing")
  })

  it("can only pay for one movement, and one movement has one order", () => {
    const w = wallet(ME, [delivered])
    const book = bookWith(purchase(), purchase({ order: "order-2", cost: { micros: "1", currency: "USD" } }))
    const fold = foldBook(w, [], "average", book)
    assert.equal(fold.legs[0]!.costMicros, "25800000")
    assert.deepEqual(fold.purchases.map((p) => p.state), ["recorded", "unmatched"])
  })

  it("beats what was entered for that movement, and leaves everything else's answers alone", () => {
    const w = wallet(ME, [delivered, move(60, OTHER_TX, ME, "credit", 3n * E6, COINBASE)])
    const book: Book = { ...bookWith(purchase()), costs: { [costKey(ME, `${TX}:USDC`)]: { micros: "1", currency: "USD" }, [costKey(ME, `${OTHER_TX}:USDC`)]: { micros: "3000000", currency: "USD" } } }
    const fold = foldBook(w, [], "average", book)
    assert.equal(fold.legs.find((l) => l.txHash === TX)!.costMicros, "25800000")
    assert.deepEqual([fold.legs.find((l) => l.txHash === OTHER_TX)!.costLabel, fold.legs.find((l) => l.txHash === OTHER_TX)!.costMicros], ["self-reported", "3000000"])
  })

  it("doesn't use up an imported withdrawal that belongs to something else", () => {
    const at = new Date(Date.UTC(2026, 10, 5) + BLOCK * 1000).toISOString()
    const withdrawal = { exchange: "Coinbase", asset: "USDC", units: (25n * E6).toString(), at, cost: { micros: "99000000", currency: "USD" as const }, toAddress: null }
    const fold = foldBook(wallet(ME, [delivered]), [], "average", { ...bookWith(purchase()), withdrawals: [withdrawal] })
    assert.equal(fold.legs[0]!.costMicros, "25800000")
  })

  describe("for a batched payout, whose ETH has no row", () => {
    const unseen = (tx: string, amount = ETH_BOUGHT) => move(BLOCK, tx, ME, "credit", amount, tx ? COINBASE : null, ETH_ADDRESS, "unseen_eth")
    const bought = (changes: Partial<Purchase> = {}) => purchase({ asset: "ETH", units: ETH_BOUGHT.toString(), ...changes })
    const id = `unseen:${BLOCK}:ETH`

    it("matches when the payout's transaction is named", () => {
      assert.equal(legOf(wallet(ME, [unseen(TX)]), bookWith(bought({ blockNum: null })), [], id).purchaseSource, "Bought on Coinbase")
    })

    it("matches by its block and exact amount when no transaction could be named", () => {
      const leg = legOf(wallet(ME, [unseen("")]), bookWith(bought()), [], id)
      assert.deepEqual([leg.costLabel, leg.costMicros], ["paid", "25800000"])
    })

    it("matches by its block when another transaction was named as the likeliest", () => {
      assert.equal(legOf(wallet(ME, [unseen(OTHER_TX)]), bookWith(bought()), [], id).purchaseSource, "Bought on Coinbase")
    })

    it("stays unknown when the block's amount isn't exactly the order's, or the block isn't known", () => {
      assert.equal(legOf(wallet(ME, [unseen("", ETH_BOUGHT + 1n)]), bookWith(bought()), [], id).costLabel, "unknown")
      assert.equal(legOf(wallet(ME, [unseen("")]), bookWith(bought({ blockNum: null })), [], id).costLabel, "unknown")
      assert.equal(legOf(wallet(ME, [unseen("")]), bookWith(bought({ blockNum: BLOCK + 1 })), [], id).costLabel, "unknown")
    })

    it("won't take a direct transfer in that block for it, without the transaction", () => {
      const direct = move(BLOCK, OTHER_TX, ME, "credit", ETH_BOUGHT, COINBASE, ETH_ADDRESS)
      assert.equal(legOf(wallet(ME, [direct]), bookWith(bought()), [], `${OTHER_TX}:ETH`).costLabel, "unknown")
    })
  })

  describe("paid in a currency that can't be shown yet", () => {
    const AT = Math.floor(Date.UTC(2026, 10, 5) / 1000) + BLOCK
    const round = (answer: string) => ({ answer, updatedAt: AT })
    const eur = { cost: { micros: "23150000", currency: "EUR" as const } }
    const paidRates = { EUR: { [BLOCK]: round("112000000") } }
    const cadRates = { byBlock: { [BLOCK]: round("70000000") }, latest: null }

    it("will be exact to the cent once it can be read in what was paid", () => {
      const leg = legOf(wallet(ME, [delivered], { currency: "EUR", rates: { byBlock: { [BLOCK]: round("112000000") }, latest: null } }), bookWith(purchase(eur)))
      assert.deepEqual([leg.costLabel, leg.costMicros, leg.purchaseSource], ["paid", "23150000", "Bought on Coinbase"])
    })

    it("converts at its own feed's rate when it arrived, and says what was paid", () => {
      const leg = legOf(wallet(ME, [delivered], { paidRates }), bookWith(purchase(eur)))
      assert.deepEqual([leg.costLabel, leg.costMicros, leg.purchaseSource], ["paid", "25928000", "Bought on Coinbase for €23.15"])
    })

    it("goes through USD for a third currency", () => {
      const leg = legOf(wallet(ME, [delivered], { currency: "CAD", rates: cadRates, paidRates }), bookWith(purchase(eur)))
      assert.equal(leg.costMicros, "37040000")
    })

    it("prefers the feed to the order's USD total, which only stands in", () => {
      assert.equal(legOf(wallet(ME, [delivered], { paidRates }), bookWith(purchase({ ...eur, costUsdMicros: "26000000" }))).costMicros, "25928000")
      assert.equal(legOf(wallet(ME, [delivered]), bookWith(purchase({ ...eur, costUsdMicros: "26000000" }))).costMicros, "26000000")
    })

    for (const [what, rounds] of [
      ["no answer at its block", { EUR: { [BLOCK + 1]: round("112000000") } }],
      ["a feed that had stopped", { EUR: { [BLOCK]: { answer: "112000000", updatedAt: AT - 4 * 24 * 60 * 60 } } }],
      ["another currency's feed", { GBP: { [BLOCK]: round("135000000") } }],
    ] as [string, WalletResponse["paidRates"]][]) {
      it(`stays unknown and is asked about, with ${what}`, () => {
        const fold = foldBook(wallet(ME, [delivered], { paidRates: rounds }), [], "average", bookWith(purchase(eur)))
        assert.deepEqual([fold.legs[0]!.costLabel, fold.legs[0]!.costMicros], ["unknown", null])
        assert.equal(fold.questions.length, 1)
      })
    }

    it("never leaves a kind of dollar bare, beside another currency", () => {
      const source = (cost: Purchase["cost"], changes: Partial<WalletResponse>) => legOf(wallet(ME, [delivered], changes), bookWith(purchase({ cost }))).purchaseSource
      assert.equal(source({ micros: "7100000", currency: "CAD" }, { paidRates: { CAD: { [BLOCK]: round("70000000") } } }), "Bought on Coinbase for CA$7.10")
      assert.equal(source({ micros: "7100000", currency: "USD" }, { currency: "CAD", rates: cadRates }), "Bought on Coinbase for US$7.10")
      assert.equal(source({ micros: "7100000", currency: "CHF" }, { paidRates: { CHF: { [BLOCK]: round("120000000") } } }), "Bought on Coinbase for CHF\u00a07.10")
    })

    it("reaches the tax report, in the report's currency, with what was paid in its note", () => {
      const cad = wallet(ME, [delivered, move(70, OTHER_TX, ME, "debit", 25n * E6, null), move(70, OTHER_TX, ME, "credit", 10n ** 16n, null, ETH_ADDRESS)], { currency: "CAD", rates: { byBlock: { [BLOCK]: round("70000000"), 70: round("70000000") }, latest: null }, paidRates })
      const [sold] = taxRows([cad], { method: "average", scope: "per-wallet" }, { book: bookWith(purchase(eur)), costsFrom: [] }).filter((row) => row.type === "Sold")
      assert.equal(sold!.costMicros, "37040000")
      assert.equal(sold!.status, "resolved")
      assert.match(sold!.reason ?? "", /Bought on Coinbase for €23\.15, fees included/)
    })

    it("survives the trip through what a client sends", () => {
      for (const currency of ["EUR", "GBP", "CHF"] as const) {
        assert.deepEqual(parseBook(bookWith(purchase({ cost: { micros: "1", currency } })))?.purchases?.[0]?.cost, { micros: "1", currency })
      }
    })
  })

  describe("rates for what was paid", () => {
    const AT = Math.floor(Date.UTC(2026, 10, 5) / 1000) + BLOCK
    const eur = purchase({ cost: { micros: "23150000", currency: "EUR" } })
    const asks = () => {
      const asked: { currency: string; blocks: number[] }[] = []
      const readRates = async (currency: string, { legs }: Pick<WalletResponse, "legs" | "latest">) => {
        asked.push({ currency, blocks: legs.map((leg) => leg.blockNum) })
        return { byBlock: Object.fromEntries(legs.map((leg) => [leg.blockNum, { answer: "112000000", updatedAt: AT }])), latest: null }
      }
      return { asked, readRates: readRates as Parameters<typeof readPaidRates>[0] }
    }
    const w = wallet(ME, [move(40, OTHER_TX, ME, "credit", E6, null), delivered])

    it("reads only that currency, only at the blocks it could have arrived in", async () => {
      const { asked, readRates } = asks()
      const rates = await readPaidRates(readRates, w, "USD", [bookWith(eur)])
      assert.deepEqual(asked, [{ currency: "EUR", blocks: [BLOCK] }])
      assert.deepEqual(rates, { EUR: { [BLOCK]: { answer: "112000000", updatedAt: AT } } })
    })

    it("finds a batched delivery by its block, when it doesn't name the transaction", async () => {
      const { asked, readRates } = asks()
      await readPaidRates(readRates, w, "USD", [bookWith({ ...eur, txHash: `0x${"ef".repeat(32)}` })])
      assert.deepEqual(asked[0]?.blocks, [BLOCK])
    })

    for (const [what, shown, book] of [
      ["it's what's being read", "EUR", bookWith(eur)],
      ["it was paid in USD", "CAD", bookWith(purchase())],
      ["it's another wallet's", "USD", bookWith({ ...eur, wallet: SAVINGS })],
      ["nothing's been bought", "USD", emptyBook()],
      ["it hasn't arrived", "USD", bookWith({ ...eur, txHash: `0x${"ef".repeat(32)}`, blockNum: null })],
    ] as [string, "USD" | "EUR" | "CAD", Book][]) {
      it(`reads nothing when ${what}`, async () => {
        const { asked, readRates } = asks()
        assert.equal(await readPaidRates(readRates, w, shown, [book]), undefined)
        assert.deepEqual(asked, [])
      })
    }
  })

  describe("in another currency", () => {
    const rated = (currency: "USD" | "CAD") => wallet(ME, [delivered], { currency, rates: currency === "USD" ? null : { byBlock: { [BLOCK]: { answer: "70000000", updatedAt: Math.floor(Date.UTC(2026, 10, 5) / 1000) + BLOCK } }, latest: null } as unknown as WalletResponse["rates"] })
    const cad = { cost: { micros: "35000000", currency: "CAD" as const } }

    it("uses what was paid when it's the currency being read", () => {
      assert.equal(legOf(rated("CAD"), bookWith(purchase(cad))).costMicros, "35000000")
    })

    it("falls back on the order's USD total, rather than reading CAD as USD", () => {
      assert.equal(legOf(rated("USD"), bookWith(purchase({ ...cad, costUsdMicros: "25800000" }))).costMicros, "25800000")
    })

    it("stays unknown when there's no way to convert it", () => {
      assert.equal(legOf(rated("USD"), bookWith(purchase(cad))).costLabel, "unknown")
    })
  })

  it("shows its source in explanations, the CSV and the tax report, wherever it's moved", () => {
    const hot = wallet(ME, [delivered, move(70, OTHER_TX, ME, "debit", 25n * E6, SAVINGS)])
    const savings = wallet(SAVINGS, [move(70, OTHER_TX, SAVINGS, "credit", 25n * E6, ME), move(80, `0x${"ef".repeat(32)}`, SAVINGS, "debit", 25n * E6, null), move(80, `0x${"ef".repeat(32)}`, SAVINGS, "credit", 10n ** 16n, null, ETH_ADDRESS)])
    const book = { ...bookWith(purchase()), linked: [ME, SAVINGS] }
    const explanation = explainPortfolio(hot, "average", { kind: "asset", asset: "USDC", metric: "amount" }, [savings], book)!
    const leg = explanation.legs.find((l) => l.txHash === TX)!
    assert.equal(leg.costSource, "Bought on Coinbase")
    assert.match(leg.effect, /fees included\. Bought on Coinbase/)
    assert.ok(exportCsv(foldBook(hot, [savings], "average", book).positions, "USD").includes("Bought on Coinbase"))
    const [sold] = taxRows([savings], { method: "average", scope: "per-wallet" }, { book, costsFrom: [hot] }).filter((row) => row.type === "Sold")
    assert.equal(sold!.costMicros, "25800000")
    assert.equal(sold!.status, "resolved")
    assert.match(sold!.reason ?? "", /Bought on Coinbase, fees included/)
  })

  describe("once it's swept to savings", () => {
    const SWEEP = `0x${"99".repeat(32)}`
    const sweep = (units: bigint) => [move(70, SWEEP, ME, "debit", units, SAVINGS), move(70, SWEEP, SAVINGS, "credit", units, ME)]
    const linkedBook = (...purchases: Purchase[]) => ({ ...bookWith(...purchases), linked: [ME, SAVINGS] })

    it("carries its cost and its source over, with nothing asked in either wallet", () => {
      const rows = [delivered, ...sweep(25n * E6)]
      const [hot, savings] = [wallet(ME, rows), wallet(SAVINGS, rows)]
      const fold = foldBook(savings, [hot], "average", linkedBook(purchase()))
      assert.deepEqual(fold.questions, [])
      const leg = fold.legs[0]!
      assert.deepEqual([leg.costLabel, leg.costMicros, leg.purchaseSource], ["inherited", "25800000", "Bought on Coinbase"])
      assert.equal(fold.positions.find((p) => p.asset === "USDC")!.values.costMicros, "25800000")
      assert.deepEqual(fold.purchases, [{ order: "order-1", state: "recorded" }], "and it reads the same from the savings wallet")
      const moved = explainPortfolio(savings, "average", { kind: "asset", asset: "USDC", metric: "amount" }, [hot], linkedBook(purchase()))!.legs[0]!
      assert.deepEqual([moved.costLabel, moved.costSource], ["inherited", "Bought on Coinbase"], "it says who sold it, and stays what it is here")
      assert.match(moved.effect, /from what your other wallet paid, fees included\. Bought on Coinbase/)
      assert.equal(moved.summary, "Received $25.00 of USDC from your other wallet.", "moving what was bought isn't buying it again")
      assert.equal(moved.unknown, null)
      const bought = explainPortfolio(hot, "average", { kind: "asset", asset: "USDC", metric: "amount" }, [savings], linkedBook(purchase()))!.legs.find((l) => l.txHash === TX)!
      assert.equal(bought.summary, "Bought $25.80 of USDC, fees included.", "where it was bought, it's still a purchase")
      assert.equal(costTag(leg.costLabel, leg.purchaseSource), "Cost: Bought on Coinbase, from your other wallet")
      assert.ok(exportCsv(fold.positions, "USD").includes("Bought on Coinbase, from your other wallet"))
    })

    it("splits it when only what's above the cap moves, and the two parts add up to what was paid", () => {
      const rows = [delivered, ...sweep(15n * E6)]
      const [hot, savings] = [wallet(ME, rows), wallet(SAVINGS, rows)]
      const book = linkedBook(purchase())
      const costOf = (focus: WalletResponse, other: WalletResponse) => foldBook(focus, [other], "average", book).positions.find((p) => p.asset === "USDC")!.values.costMicros
      assert.equal(costOf(savings, hot), "15480000")
      assert.equal(costOf(hot, savings), "10320000")
      const moved = explainPortfolio(savings, "average", { kind: "asset", asset: "USDC", metric: "amount" }, [hot], book)!.legs[0]!
      assert.deepEqual([moved.summary, moved.costLabel, moved.costSource], ["Received $15.00 of USDC from your other wallet.", "inherited", "Bought on Coinbase"])
    })

    it("does the same for ETH that arrived in a batched payout", () => {
      const rows = [move(BLOCK, "", ME, "credit", ETH_BOUGHT, null, ETH_ADDRESS, "unseen_eth"), move(70, SWEEP, ME, "debit", ETH_BOUGHT, SAVINGS, ETH_ADDRESS), move(70, SWEEP, SAVINGS, "credit", ETH_BOUGHT, ME, ETH_ADDRESS)]
      const fold = foldBook(wallet(SAVINGS, rows), [wallet(ME, rows)], "average", linkedBook(purchase({ asset: "ETH", units: ETH_BOUGHT.toString() })))
      assert.deepEqual(fold.questions, [])
      assert.deepEqual([fold.legs[0]!.costMicros, fold.legs[0]!.purchaseSource], ["25800000", "Bought on Coinbase"])
    })

    it("doesn't claim the source for a cost an average mixed with another", () => {
      const other = `0x${"77".repeat(32)}`
      const rows = [delivered, move(60, other, ME, "credit", 25n * E6, COINBASE), ...sweep(50n * E6)]
      const [hot, savings] = [wallet(ME, rows), wallet(SAVINGS, rows)]
      const book = { ...linkedBook(purchase()), costs: { [costKey(ME, `${other}:USDC`)]: { micros: "25000000", currency: "USD" as const } } }
      const leg = foldBook(savings, [hot], "average", book).legs[0]!
      assert.equal(leg.costLabel, "inherited")
      assert.notEqual(leg.costMicros, null, "all of it has a known cost, so this is about the mix")
      assert.equal(leg.purchaseSource, undefined)
    })

    it("stays unknown where it arrived and where it went, when the order doesn't match", () => {
      const rows = [delivered, ...sweep(25n * E6)]
      const fold = foldBook(wallet(SAVINGS, rows), [wallet(ME, rows)], "average", linkedBook(purchase({ units: "1" })))
      assert.equal(fold.legs[0]!.costMicros, null)
      assert.equal(fold.legs[0]!.purchaseSource, undefined)
    })
  })

  it("is reported to clients for each purchase", () => {
    assert.deepEqual(portfolioOf(wallet(ME, [delivered]), "average", [], bookWith(purchase())).purchases, [{ order: "order-1", state: "recorded" }])
  })

  it("survives the trip from a client, and a malformed one is refused", () => {
    assert.deepEqual(parseBook({ purchases: [{ ...purchase(), txHash: TX.toUpperCase().replace("0X", "0x") }] })?.purchases, [purchase()])
    assert.equal(parseBook({})?.purchases, undefined)
    const { blockNum: _block, costUsdMicros: _usd, ...fromMac } = purchase()
    assert.deepEqual(parseBook({ purchases: [fromMac] })?.purchases, [purchase({ blockNum: null })], "the Mac app leaves out what it doesn't have")
    for (const bad of [{ provider: "someone" }, { units: "-1" }, { wallet: "me" }, { cost: { micros: "1", currency: "XXX" } }, { blockNum: "50" }, { costUsdMicros: 5 }]) {
      assert.equal(parseBook({ purchases: [{ ...purchase(), ...bad }] }), null, JSON.stringify(bad))
    }
    assert.equal(parseBook({ purchases: "nope" }), null)
  })
})

describe("reading an order", () => {
  const raw = {
    type: "ONRAMP_TRANSACTION_TYPE_BUY_AND_SEND",
    payment_method: "CARD",
    status: "ONRAMP_TRANSACTION_STATUS_SUCCESS",
    transaction_id: "abc",
    purchase_currency: "USDC",
    purchase_network: "base",
    purchase_amount: { value: "5", currency: "USDC" },
    payment_total: { value: "5.07", currency: "USD" },
    coinbase_fee: { value: "0", currency: "USD" },
    network_fee: { value: "0.07", currency: "USD" },
    tx_hash: "0x31814BA2fef2a400a9816767370be09ca12d9e9753b972198fe330a0ecedcbf6",
    wallet_address: "0x3d7b51da8AA41270C6e052eE261db4514Ba4D50A",
  }

  it("takes payment_total, which has the fees in it, and amounts to the unit", () => {
    const order = orderOf(raw)!
    assert.deepEqual(order.cost, { micros: "5070000", currency: "USD" })
    assert.equal(order.units, "5000000")
    assert.equal(order.txHash, "0x31814ba2fef2a400a9816767370be09ca12d9e9753b972198fe330a0ecedcbf6")
    assert.equal(order.wallet, "0x3d7b51da8aa41270c6e052ee261db4514ba4d50a")
    assert.equal(order.status, "succeeded")
    assert.equal(order.provider, "coinbase")
    assert.equal(orderOf({ ...raw, purchase_currency: "ETH", purchase_amount: { value: "0.00206183", currency: "ETH" } })!.units, ETH_BOUGHT.toString())
  })

  it("keeps what can't be read as null, and never makes it up", () => {
    assert.equal(orderOf({ ...raw, payment_total: { value: "5.07", currency: "XYZ" } })!.cost, null)
    assert.equal(orderOf({ ...raw, payment_total: { value: "about 5", currency: "USD" } })!.cost, null)
    assert.equal(orderOf({ ...raw, payment_total: undefined })!.cost, null)
    assert.equal(orderOf({ ...raw, purchase_currency: "DOGE" })!.units, null)
    assert.equal(orderOf({ ...raw, tx_hash: "" })!.txHash, null)
    assert.equal(orderOf({}), null)
    assert.equal(unitsOf("1.0000001", 6), null, "it won't round")
    assert.equal(unitsOf("1.0000000", 6), "1000000")
  })

  describe("that was paid from what's already held", () => {
    const withUsd = { ...raw, payment_total_usd: { value: "5.07", currency: "USD" } }
    const costOf = (changes: Record<string, unknown>) => {
      const order = orderOf({ ...withUsd, ...changes })!
      return [order.cost, order.costUsdMicros]
    }

    for (const [what, changes] of [
      ["a send, which only moves it", { type: "ONRAMP_TRANSACTION_TYPE_SEND" }],
      ["a send, whatever it says paid", { type: "ONRAMP_TRANSACTION_TYPE_SEND", payment_method: "CARD" }],
      ["crypto in the account", { payment_method: "CRYPTO_WALLET" }],
      ["crypto in the account, as the API spec spells it", { payment_method: "CRYPTO_ACCOUNT" }],
      ["a way to pay it doesn't know", { payment_method: "SOMETHING_NEW" }],
      ["no way to pay at all", { payment_method: undefined }],
      ["no type", { type: undefined }],
    ] as [string, Record<string, unknown>][]) {
      it(`has no cost, for ${what}`, () => {
        assert.deepEqual(costOf(changes), [null, null])
        // Everything else it says is still true, so what arrived is still shown.
        assert.equal(orderOf({ ...withUsd, ...changes })!.status, "succeeded")
        assert.equal(orderOf({ ...withUsd, ...changes })!.units, "5000000")
      })
    }

    for (const method of ["CARD", "ACH_BANK_ACCOUNT", "APPLE_PAY", "GUEST_CHECKOUT_APPLE_PAY", "GOOGLE_PAY", "GUEST_CHECKOUT_GOOGLE_PAY", "FIAT_WALLET"]) {
      it(`has its cost, when bought with ${method}`, () => {
        assert.deepEqual(costOf({ payment_method: method }), [{ micros: "5070000", currency: "USD" }, "5070000"])
      })
    }
  })

  it("keeps the USD total, for a read that can't convert what was paid", () => {
    const order = orderOf({ ...raw, payment_total: { value: "7.10", currency: "CAD" }, payment_total_usd: { value: "5.07", currency: "USD" } })!
    assert.deepEqual([order.cost, order.costUsdMicros], [{ micros: "7100000", currency: "CAD" }, "5070000"])
  })

  describe("paid outside the US and Canada", () => {
    const paidIn = (currency: string, value = "46.20") => ({ ...raw, payment_total: { value, currency }, payment_total_usd: { value: "50.00", currency: "USD" } })

    for (const [currency, micros] of [["EUR", "46200000"], ["GBP", "46200000"], ["CHF", "46200000"]] as const) {
      it(`keeps what was paid in ${currency}`, () => {
        const order = orderOf(paidIn(currency))!
        assert.deepEqual(order.cost, { micros, currency })
        assert.equal(order.costUsdMicros, "50000000")
        assert.equal(order.paidIn, null)
      })
    }

    for (const currency of ["SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "RON", "ISK"]) {
      it(`has no cost in ${currency}, and says that's why, without relying on Coinbase's USD figure`, () => {
        const order = orderOf(paidIn(currency, "512.40"))!
        assert.deepEqual([order.cost, order.costUsdMicros, order.paidIn], [null, null, currency])
        assert.equal(order.status, "succeeded")
        assert.equal(order.units, "5000000")
      })
    }

    it("only names a currency for something bought with money", () => {
      assert.equal(orderOf({ ...paidIn("SEK"), payment_method: "CRYPTO_WALLET" })!.paidIn, null)
      assert.equal(orderOf({ ...paidIn("SEK"), type: "ONRAMP_TRANSACTION_TYPE_SEND" })!.paidIn, null)
    })

    it("only names what reads as a currency, since an app shows it", () => {
      for (const currency of ["sek", "SEKS", "<b>", "", 5]) assert.equal(orderOf({ ...raw, payment_total: { value: "1", currency } })!.paidIn, null)
    })

    it("says nothing about a currency for an order it can read", () => {
      assert.equal(orderOf(raw)!.paidIn, null)
      assert.equal(orderOf({ ...raw, payment_total: undefined })!.paidIn, null)
    })
  })

  it("knows every status, and treats one it doesn't as still going", () => {
    const status = (value: string, extra = {}) => orderOf({ ...raw, status: value, ...extra })!
    assert.equal(status("ONRAMP_TRANSACTION_STATUS_CREATED").status, "pending")
    assert.equal(status("ONRAMP_TRANSACTION_STATUS_IN_PROGRESS").status, "pending")
    assert.equal(status("ONRAMP_TRANSACTION_STATUS_NEW").status, "pending")
    assert.deepEqual([status("ONRAMP_TRANSACTION_STATUS_FAILED", { failure_reason: "FAILURE_REASON_SEND_FAILED" }).status, status("ONRAMP_TRANSACTION_STATUS_FAILED", { failure_reason: "FAILURE_REASON_SEND_FAILED" }).failure], ["failed", "delivery"])
    assert.equal(status("ONRAMP_TRANSACTION_STATUS_FAILED", { failure_reason: "FAILURE_REASON_BUY_FAILED" }).failure, "payment")
  })
})

describe("signing a request", () => {
  const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString())

  it("signs with an Ed25519 key in the form Coinbase hands out", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const jwk = privateKey.export({ format: "jwk" })
    const secret = Buffer.concat([Buffer.from(jwk.d as string, "base64url"), Buffer.from(jwk.x as string, "base64url")]).toString("base64")
    const [header, claims, signature] = requestToken("key-id", secret, "POST", "/onramp/v1/token", 1000).split(".") as [string, string, string]
    assert.ok(verify(null, Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, "base64url")))
    const { alg, kid, nonce } = decode(header)
    assert.deepEqual([alg, kid, typeof nonce], ["EdDSA", "key-id", "string"])
    assert.deepEqual(decode(claims), { sub: "key-id", iss: "cdp", aud: ["cdp_service"], nbf: 1000, exp: 1120, uri: "POST api.developer.coinbase.com/onramp/v1/token", uris: ["POST api.developer.coinbase.com/onramp/v1/token"] })
  })

  it("signs with an older EC key, with or without its newlines escaped", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
    const pem = privateKey.export({ format: "pem", type: "sec1" }) as string
    const [header, claims, signature] = requestToken("key-id", pem.replaceAll("\n", "\\n"), "GET", "/x", 1000).split(".") as [string, string, string]
    assert.equal(decode(header).alg, "ES256")
    assert.ok(verify("sha256", Buffer.from(`${header}.${claims}`), { key: createPublicKey(privateKey), dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")))
  })

  it("turns buying off for a secret that isn't a key, and doesn't say what it was", () => {
    const logged: unknown[][] = []
    const error = console.error
    console.error = (...line: unknown[]) => logged.push(line)
    try {
      assert.equal(createOnramp({ COINBASE_ONRAMP_KEY_ID: "id", COINBASE_ONRAMP_KEY_SECRET: "not-it" }), null)
      assert.equal(createOnramp({ COINBASE_ONRAMP_KEY_ID: "id", COINBASE_ONRAMP_KEY_SECRET: "-----BEGIN not-it" }), null)
    } finally {
      console.error = error
    }
    assert.equal(logged.length, 2)
    assert.ok(!JSON.stringify(logged).includes("not-it"))
  })

  it("is off without a key", () => {
    assert.equal(createOnramp({}), null)
    assert.equal(createOnramp({ COINBASE_ONRAMP_KEY_ID: "id" }), null)
  })
})

describe("the routes", () => {
  const { privateKey } = generateKeyPairSync("ed25519")
  const jwk = privateKey.export({ format: "jwk" })
  const secret = Buffer.concat([Buffer.from(jwk.d as string, "base64url"), Buffer.from(jwk.x as string, "base64url")]).toString("base64")
  const env = { COINBASE_ONRAMP_KEY_ID: "id", COINBASE_ONRAMP_KEY_SECRET: secret, BASE_RPC_URL: "https://rpc.example/secret-key" }
  const REF = "0123456789abcdef0123456789abcdef"

  /** Stands in for Coinbase and the RPC. */
  function stub(answers: { token?: () => Response; orders?: () => Response; receipt?: () => Response } = {}) {
    const calls: { url: string; init: RequestInit }[] = []
    const send = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.includes("/onramp/v1/token")) return answers.token?.() ?? Response.json({ token: "session-token", channel_id: "" })
      if (url.includes("/transactions")) return answers.orders?.() ?? Response.json({ transactions: [] })
      return answers.receipt?.() ?? Response.json({ result: { blockNumber: "0x32" } })
    }) as typeof fetch
    return { send, calls }
  }

  const servers: Server[] = []
  async function serve(onramp: Onramp | null) {
    const server = createServer(createHandler(createApi({}, null, onramp), "/nonexistent"))
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    return (server.address() as { port: number }).port
  }
  after(() => servers.forEach((server) => server.close()))

  function call(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = request({ port, host: "127.0.0.1", path, method, headers: { "content-type": "application/json" } }, (res) => {
        let text = ""
        res.on("data", (chunk) => (text += chunk))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }))
      })
      req.on("error", reject)
      req.end(body === undefined ? undefined : JSON.stringify(body))
    })
  }
  const SESSION = { address: ME, asset: "ETH", cryptoAmount: "0.01" }

  it("sends what the Swift tests read", async () => {
    const row = { type: "ONRAMP_TRANSACTION_TYPE_BUY_AND_SEND", payment_method: "CARD", purchase_currency: "USDC", purchase_network: "base", purchase_amount: { value: "5", currency: "USDC" }, wallet_address: ME }
    const delivery = { ...row, transaction_id: "delivered", status: "ONRAMP_TRANSACTION_STATUS_SUCCESS", payment_total: { value: "5.07", currency: "USD" }, payment_total_usd: { value: "5.07", currency: "USD" }, tx_hash: TX }
    const transactions = [
      delivery,
      { ...delivery, transaction_id: "no-rate", payment_total: { value: "55", currency: "SEK" } },
      { ...row, transaction_id: "pending", status: "ONRAMP_TRANSACTION_STATUS_IN_PROGRESS" },
      { ...row, transaction_id: "failed", status: "ONRAMP_TRANSACTION_STATUS_FAILED", failure_reason: "FAILURE_REASON_SEND_FAILED" },
    ]
    const port = await serve(createOnramp(env, stub({ orders: () => Response.json({ transactions }) }).send))
    const { json: checkout } = await call(port, "POST", "/api/onramp/checkout", SESSION)
    const { json: orders } = await call(port, "GET", `/api/onramp/orders/${REF}`)
    const ref = checkout.ref as string
    assertMatchesFixture("onramp-vectors.json", {
      // A new one each time, and nothing here depends on what it is.
      checkout: { url: (checkout.url as string).replace(ref, REF), ref: REF },
      orders: orders.orders,
      matches: portfolioOf(wallet(ME, [delivered]), "average", [], bookWith(purchase(), purchase({ order: "order-2", cost: { micros: "1", currency: "USD" } }), purchase({ order: "order-3", txHash: OTHER_TX }))).purchases,
    })
  })

  let quiet: typeof console.error
  before(() => {
    quiet = console.error
    console.error = () => {}
  })
  after(() => {
    console.error = quiet
  })

  it("say buying isn't set up without a key", async () => {
    const port = await serve(null)
    const session = await call(port, "POST", "/api/onramp/checkout", SESSION)
    assert.deepEqual([session.status, session.json.error], [503, "Buying isn't set up on this server."])
    assert.equal((await call(port, "GET", `/api/onramp/orders/${REF}`)).status, 503)
  })

  it("open a page for only that address, signed with the key, and hand back only the page and its order's reference", async () => {
    const { send, calls } = stub()
    const port = await serve(createOnramp(env, send))
    const { status, json } = await call(port, "POST", "/api/onramp/checkout", SESSION)
    assert.equal(status, 200)
    assert.deepEqual(Object.keys(json).sort(), ["ref", "url"])
    const url = new URL(json.url as string)
    assert.equal(url.origin + url.pathname, "https://pay.coinbase.com/buy/select-asset")
    assert.deepEqual(Object.fromEntries(url.searchParams), { sessionToken: "session-token", defaultNetwork: "base", defaultAsset: "ETH", presetCryptoAmount: "0.01", partnerUserRef: json.ref })
    assert.match(json.ref as string, /^[0-9a-f]{32}$/)
    assert.equal(calls[0]!.url, "https://api.developer.coinbase.com/onramp/v1/token")
    assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { addresses: [{ address: ME, blockchains: ["base"] }], assets: ["ETH"] }, "only what was chosen, and a client on this machine has no IP that would mean anything")
    assert.match((calls[0]!.init.headers as Record<string, string>).authorization!, /^Bearer /)
    assert.ok(!JSON.stringify(json).includes(secret))
  })

  it("start the page from what was typed, in the currency it was typed in", async () => {
    const port = await serve(createOnramp(env, stub().send))
    const { status, json } = await call(port, "POST", "/api/onramp/checkout", { ...SESSION, fiat: { amount: "27", currency: "CAD" } })
    assert.equal(status, 200)
    const params = new URL(json.url as string).searchParams
    assert.deepEqual([params.get("presetFiatAmount"), params.get("fiatCurrency")], ["27", "CAD"])
    assert.equal(params.get("presetCryptoAmount"), null, "the page ignores a fiat amount when there's also a crypto one")
  })

  it("start the page from a token amount when Coinbase can't start from the typed currency", async () => {
    const port = await serve(createOnramp(env, stub().send))
    for (const currency of ["AUD", "CHF", "MXN"]) {
      const { status, json } = await call(port, "POST", "/api/onramp/checkout", { ...SESSION, fiat: { amount: "27", currency } })
      assert.equal(status, 200, currency)
      const params = new URL(json.url as string).searchParams
      assert.deepEqual([params.get("presetFiatAmount"), params.get("fiatCurrency"), params.get("presetCryptoAmount")], [null, null, "0.01"], currency)
    }
  })

  it("refuse a typed amount that isn't one", async () => {
    const { send, calls } = stub()
    const port = await serve(createOnramp(env, send))
    for (const fiat of [{ amount: "0", currency: "CAD" }, { amount: "1e3", currency: "CAD" }, { amount: 27, currency: "CAD" }, { amount: "27", currency: "XYZ" }, { amount: "27", currency: "SEK" }, { amount: "27" }, "27"]) {
      assert.equal((await call(port, "POST", "/api/onramp/checkout", { ...SESSION, fiat })).status, 400, JSON.stringify(fiat))
    }
    assert.equal(calls.length, 0)
  })

  it("only let the page sell the token the app checked it can move", async () => {
    const { send, calls } = stub()
    const port = await serve(createOnramp(env, send))
    await call(port, "POST", "/api/onramp/checkout", { ...SESSION, asset: "USDC", cryptoAmount: "20" })
    assert.deepEqual(JSON.parse(calls[0]!.init.body as string).assets, ["USDC"])
  })

  it("ask for Coinbase's mocked mode when that's what's set up", async () => {
    const port = await serve(createOnramp({ ...env, COINBASE_ONRAMP_MOCK: "1" }, stub().send))
    const { json } = await call(port, "POST", "/api/onramp/checkout", SESSION)
    assert.match(json.ref as string, /^sandbox-[0-9a-f]{32}$/)
    assert.equal(new URL(json.url as string).searchParams.get("partnerUserRef"), json.ref)
  })

  it("refuse anything but an address, a token on sale and an amount", async () => {
    const { send, calls } = stub()
    const port = await serve(createOnramp(env, send))
    for (const bad of [{ address: "me" }, { address: undefined }, { asset: "DOGE" }, { cryptoAmount: "0" }, { cryptoAmount: "1e3" }, { cryptoAmount: "-1" }, { cryptoAmount: 5 }]) {
      assert.equal((await call(port, "POST", "/api/onramp/checkout", { ...SESSION, ...bad })).status, 400, JSON.stringify(bad))
    }
    assert.equal(calls.length, 0)
  })

  it("say so when Coinbase can't be reached or says no, without passing on what it said", async () => {
    const down = (async () => {
      throw new Error("connect ECONNREFUSED")
    }) as typeof fetch
    const unreachable = await call(await serve(createOnramp(env, down)), "POST", "/api/onramp/checkout", SESSION)
    assert.deepEqual([unreachable.status, unreachable.json.error], [502, "Coinbase can't be reached right now."])
    const refused = await call(await serve(createOnramp(env, stub({ token: () => new Response("<html>internal detail</html>", { status: 401 }) }).send)), "POST", "/api/onramp/checkout", SESSION)
    assert.deepEqual([refused.status, refused.json.error], [502, "Coinbase said no (401)."])
    const orders = await call(await serve(createOnramp(env, stub({ orders: () => new Response("", { status: 500 }) }).send)), "GET", `/api/onramp/orders/${REF}`)
    assert.equal(orders.status, 502)
  })

  it("show what Coinbase said when it refuses, as it said it", async () => {
    const refusing = (body: unknown) => stub({ token: () => Response.json(body, { status: 403 }) }).send
    for (const body of [{ message: "Trial limit reached." }, { errorMessage: "Trial limit reached." }, { error: "Trial limit reached." }, { code: 7, message: "  Trial limit reached.\n" }]) {
      const { status, json } = await call(await serve(createOnramp(env, refusing(body))), "POST", "/api/onramp/checkout", SESSION)
      assert.deepEqual([status, json.error], [502, "Coinbase said: Trial limit reached."], JSON.stringify(body))
    }
    assert.equal((await call(await serve(createOnramp(env, refusing({ code: 7 }))), "POST", "/api/onramp/checkout", SESSION)).json.error, "Coinbase said no (403).")
    assert.equal((await call(await serve(createOnramp(env, refusing({ message: 7 }))), "POST", "/api/onramp/checkout", SESSION)).json.error, "Coinbase said no (403).")
    const orders = await call(await serve(createOnramp(env, stub({ orders: () => Response.json({ message: "Trial limit reached." }, { status: 429 }) }).send)), "GET", `/api/onramp/orders/${REF}`)
    assert.equal(orders.json.error, "Coinbase said: Trial limit reached.")
  })

  it("read an order, with the block its delivery landed in", async () => {
    const order = { status: "ONRAMP_TRANSACTION_STATUS_SUCCESS", transaction_id: "abc", purchase_currency: "USDC", purchase_network: "base", purchase_amount: { value: "5", currency: "USDC" }, payment_total: { value: "5.07", currency: "USD" }, tx_hash: TX, wallet_address: ME }
    const { send, calls } = stub({ orders: () => Response.json({ transactions: [order], next_page_key: "", total_count: "1" }) })
    const { status, json } = await call(await serve(createOnramp(env, send)), "GET", `/api/onramp/orders/${REF}`)
    assert.equal(status, 200)
    const [read] = json.orders as { blockNum: number; txHash: string }[]
    assert.deepEqual([read!.blockNum, read!.txHash], [50, TX])
    assert.ok(calls[0]!.url.startsWith(`https://api.developer.coinbase.com/onramp/v1/buy/user/${REF}/transactions`))
    assert.equal(JSON.parse(calls[1]!.init.body as string).method, "eth_getTransactionReceipt")
  })

  it("leave the block out when it can't be read, and don't read it for an order that hasn't delivered", async () => {
    const order = { status: "ONRAMP_TRANSACTION_STATUS_SUCCESS", transaction_id: "abc", tx_hash: TX }
    const noReceipt = await call(await serve(createOnramp(env, stub({ orders: () => Response.json({ transactions: [order] }), receipt: () => Response.json({ result: null }) }).send)), "GET", `/api/onramp/orders/${REF}`)
    assert.equal((noReceipt.json.orders as { blockNum: null }[])[0]!.blockNum, null)
    const going = stub({ orders: () => Response.json({ transactions: [{ ...order, status: "ONRAMP_TRANSACTION_STATUS_IN_PROGRESS" }] }) })
    await call(await serve(createOnramp(env, going.send)), "GET", `/api/onramp/orders/${REF}`)
    assert.equal(going.calls.length, 1)
  })

  it("never log what an RPC's error says, which can quote its URL and the key in it", async () => {
    const order = { status: "ONRAMP_TRANSACTION_STATUS_SUCCESS", transaction_id: "abc", tx_hash: TX, type: "ONRAMP_TRANSACTION_TYPE_BUY_AND_SEND", payment_method: "CARD" }
    const fake = "fake-password-for-this-test"
    const rpc = `https://user:${fake}@rpc.example/${fake}`
    // Node's own fetch, which refuses a URL with credentials in it, and quotes it in saying so.
    const { send: stubbed } = stub({ orders: () => Response.json({ transactions: [order] }) })
    const send = (async (input: string | URL | Request, init?: RequestInit) => (String(input).startsWith(rpc) ? fetch(input, init) : stubbed(input, init))) as typeof fetch
    const logged: unknown[][] = []
    const before = console.error
    console.error = (...line: unknown[]) => logged.push(line)
    try {
      const { status, json } = await call(await serve(createOnramp({ ...env, BASE_RPC_URL: rpc }, send)), "GET", `/api/onramp/orders/${REF}`)
      assert.equal(status, 200)
      assert.equal((json.orders as { blockNum: null }[])[0]!.blockNum, null, "and the order is still read")
    } finally {
      console.error = before
    }
    assert.ok(logged.length > 0, "it does say something went wrong")
    assert.ok(!logged.flat().map((part) => (part instanceof Error ? `${part.message} ${String(part.cause)}` : String(part))).join(" ").includes(fake))
  })

  it("never log what a failed call to Coinbase says, for the same reason", async () => {
    const logged: unknown[][] = []
    const before = console.error
    console.error = (...line: unknown[]) => logged.push(line)
    try {
      const down = (async () => {
        throw new Error("https://user:fake-password@somewhere")
      }) as typeof fetch
      await call(await serve(createOnramp(env, down)), "POST", "/api/onramp/checkout", SESSION)
    } finally {
      console.error = before
    }
    assert.ok(!JSON.stringify(logged).includes("fake-password"))
  })

  it("won't read an order by anything that could change what's asked of the provider", async () => {
    const { send, calls } = stub()
    const port = await serve(createOnramp(env, send))
    for (const ref of ["a/b", `${REF}/../token`, "a".repeat(65)]) assert.equal((await call(port, "GET", `/api/onramp/orders/${encodeURIComponent(ref)}`)).status, 404, ref)
    assert.equal(calls.length, 0)
  })
})

describe("the server, reading a purchase paid in euros", () => {
  const ADDRESS = "0x00000000000000000000000000000000000000c1"
  const rows = [move(BLOCK, TX, ADDRESS, "credit", 25n * E6, COINBASE)]
  const source: Source = {
    mode: "raw",
    startBlock: 1,
    historyFrom: null,
    head: async () => ({ blockNum: 100, timestamp: "2026-11-05T00:10:00.000Z" }),
    processedThrough: async (_, head) => head,
    readWindow: async () => ({ rows, priced: null, gasUnknown: [] }),
    readReferences: async (blocks) => blocks.map((blockNum) => ({ blockNum, ethUsd: "200000000000", usdcUsd: "100000000" })),
    readLatestReference: async () => ({ blockNum: 100, ethUsd: "200000000000", usdcUsd: "100000000" }),
    readEthBalances: async () => new Map(),
    readBalances: async (_, block) => ({ blockNum: block, amounts: { ...Object.fromEntries(ASSETS.map((asset) => [asset, "0"])), USDC: block >= BLOCK ? (25n * E6).toString() : "0" } }),
  }
  const AT = Math.floor(Date.UTC(2026, 10, 5) / 1000) + BLOCK
  const asked: string[] = []
  let failing = false
  const answers: Record<string, string> = { EUR: "112000000", CAD: "70000000" }
  const readRates = async (currency: string, { legs }: Pick<WalletResponse, "legs" | "latest">) => {
    asked.push(currency)
    if (failing) throw new Error("read failed")
    const round = { answer: answers[currency] as string, updatedAt: AT }
    return { byBlock: Object.fromEntries(legs.map((leg) => [leg.blockNum, round])), latest: { blockNum: 100, round } }
  }
  const eur = bookWith(purchase({ wallet: ADDRESS, cost: { micros: "23150000", currency: "EUR" } }))
  let server: Server
  let base: string
  before(async () => {
    const api = createApi({}, { source, readRates, proofs: { datasets: async () => [], priceBehind: async () => null, currentPriceBehind: async () => null, readBlock: async () => null } })
    server = createServer((req, res) => void api(req, res))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(() => server.close())
  const post = async (path: string, body: unknown) => fetch(`${base}/api/${path}/${ADDRESS}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const costIn = async (currency: string, book: Book) => {
    const response = (await (await post("portfolio", { method: "average", currency, book })).json()) as PortfolioResponse
    return response.positions.find((position) => position.asset === "USDC")?.values.costMicros
  }

  it("converts at the feed's rate, in whatever it's read in", async () => {
    assert.equal(await costIn("USD", eur), "25928000")
    assert.equal(await costIn("CAD", eur), "37040000")
  })

  it("only reads the extra rate when a purchase needs it", async () => {
    asked.length = 0
    await costIn("USD", emptyBook())
    assert.deepEqual(asked, [])
    await costIn("USD", eur)
    assert.deepEqual(asked, ["EUR"])
    asked.length = 0
    await costIn("USD", bookWith(purchase({ wallet: ADDRESS })))
    assert.deepEqual(asked, [], "Paid in USD, read in USD")
  })

  it("reads the same rate for the tax report", async () => {
    const response = await post("tax-report", { country: "CA", currency: "CAD", book: eur })
    assert.equal(response.status, 200)
    assert.deepEqual(asked.slice(-2).sort(), ["CAD", "EUR"])
  })

  it("answers with the failure when the rate can't be read, and not with an unknown cost", async () => {
    failing = true
    try {
      assert.ok((await post("portfolio", { method: "average", currency: "USD", book: eur })).status >= 500)
    } finally {
      failing = false
    }
  })

  it("won't show a wallet in a currency with no feed, though a purchase can be paid in one", async () => {
    assert.deepEqual([...MAIN_CURRENCY_CODES], CURRENCY_CODES)
    for (const currency of ["SEK", "JPY", "XYZ"]) assert.equal((await post("portfolio", { method: "average", currency, book: emptyBook() })).status, 400, currency)
  })
})
