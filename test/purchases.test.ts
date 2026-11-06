import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { OnrampOrder } from "../src/core/api.ts"
import { currenciesIn, emptyBook, parseBook, recordPurchase, type Purchase } from "../src/core/book.ts"
import { amountForUsd } from "../src/core/device-read.ts"
import { checkoutNote, isFollowed, isResolved, microsOf, pageOf, parseTrackedPurchases, phaseOf, purchaseOf, purchaseStatus, purchaseTitle, readOrder, startCheckout, trimmed, typedAmount, type TrackedPurchase } from "../src/core/purchases.ts"
import { costProof, purchaseSource } from "../src/core/wording.ts"
import { TOKENS } from "@pricetag/sdk/core"

const ME = "0x3762620fbcb400b0f98365da4aad7d2a250e5d89"
const TX = `0x${"ab".repeat(32)}`
const NOW = 1_800_000_000_000
const HOURS = 60 * 60 * 1000

const order = (changes: Partial<OnrampOrder> = {}): OnrampOrder => ({ provider: "coinbase", id: "order-1", status: "succeeded", failure: null, asset: "USDC", units: "5000000", wallet: ME, network: "base", txHash: TX, blockNum: 100, cost: { micros: "5250000", currency: "USD" }, costUsdMicros: "5250000", paidIn: null, ...changes })
const tracked = (changes: Partial<TrackedPurchase> = {}): TrackedPurchase => ({ ref: "ref-1", wallet: ME, asset: "USDC", typed: { micros: "5000000", currency: "USD" }, startedAt: NOW, order: null, ...changes })
const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe("what goes in the book", () => {
  it("is only what's delivered and says all of it", () => {
    assert.deepEqual(purchaseOf(order()), { provider: "coinbase", order: "order-1", wallet: ME, asset: "USDC", units: "5000000", txHash: TX, blockNum: 100, cost: { micros: "5250000", currency: "USD" }, costUsdMicros: "5250000" })
    for (const changes of [{ status: "pending" }, { asset: null }, { units: null }, { wallet: null }, { txHash: null }, { cost: null, costUsdMicros: null }] as Partial<OnrampOrder>[]) assert.equal(purchaseOf(order(changes)), null, JSON.stringify(changes))
  })

  it("falls back on the order's USD total", () => {
    assert.deepEqual(purchaseOf(order({ cost: null }))?.cost, { micros: "5250000", currency: "USD" })
  })

  it("never lets in a row the book couldn't read back, which would lose everything else in it", () => {
    for (const changes of [{ units: "1.5" }, { wallet: "nope" }, { cost: { micros: "x", currency: "USD" } }, { blockNum: 1.5 }] as Partial<OnrampOrder>[]) assert.equal(purchaseOf(order(changes)), null, JSON.stringify(changes))
    assert.notEqual(parseBook(recordPurchase(emptyBook(), purchaseOf(order()) as Purchase)), null)
  })

  it("takes over from what an order said before, and changes nothing when there's nothing new", () => {
    const first = recordPurchase(emptyBook(), purchaseOf(order({ blockNum: null })) as Purchase)
    const later = recordPurchase(first, purchaseOf(order()) as Purchase)
    assert.deepEqual(later.purchases?.map(({ blockNum }) => blockNum), [100])
    assert.equal(recordPurchase(later, purchaseOf(order()) as Purchase), later)
  })

  it("asks for the rates to read what was paid in another currency, without sending the book", () => {
    const book = recordPurchase(emptyBook(), purchaseOf(order({ cost: { micros: "4600000", currency: "EUR" } })) as Purchase)
    assert.deepEqual(currenciesIn(book), ["EUR"])
  })
})

describe("where a purchase has got to", () => {
  const at = (purchase: TrackedPurchase, match: "recorded" | "waiting" | "unmatched" | null = null, now = NOW) => phaseOf(purchase, match, now).kind

  it("follows what the order says, and the chain", () => {
    assert.equal(at(tracked()), "on-page")
    assert.equal(at(tracked(), null, NOW + 3 * HOURS), "no-order-yet")
    assert.equal(at(tracked({ order: order({ status: "pending", txHash: null }) })), "on-its-way")
    assert.equal(at(tracked({ order: order({ txHash: null }) })), "on-its-way")
    assert.equal(at(tracked({ order: order() }), "waiting"), "arriving")
    assert.equal(at(tracked({ order: order() }), null), "arriving", "its wallet isn't on screen")
    assert.equal(at(tracked({ order: order() }), "recorded"), "recorded")
    assert.equal(at(tracked({ order: order() }), "unmatched"), "cost-unknown")
    assert.equal(at(tracked({ order: order({ status: "failed", failure: "delivery" }) })), "failed")
  })

  it("leaves a cost unknown when the order can't say it, and never counts it as nothing", () => {
    assert.equal(at(tracked({ order: order({ cost: null, costUsdMicros: null }) })), "cost-not-said")
    assert.equal(at(tracked({ order: order({ cost: null, costUsdMicros: null, paidIn: "SEK" }) })), "no-rate")
    assert.equal(at(tracked({ order: order({ blockNum: null }) }), "waiting", NOW + 3 * HOURS), "cost-unknown")
    assert.equal(at(tracked({ order: order({ blockNum: 100 }) }), "waiting", NOW + 3 * HOURS), "arriving", "there's a block, so it can still be seen")
  })

  it("keeps asking about whatever could still change, however old it is", () => {
    assert.equal(isResolved(tracked()), false)
    assert.equal(isResolved(tracked({ order: order({ status: "pending" }) })), false)
    assert.equal(isResolved(tracked({ order: order({ blockNum: null }) })), false)
    assert.equal(isResolved(tracked({ order: order() })), true)
    assert.equal(isResolved(tracked({ order: order({ status: "failed" }) })), true)
    assert.equal(isFollowed(tracked(), NOW + HOURS), true)
    assert.equal(isFollowed(tracked(), NOW + 3 * HOURS), false)
  })

  it("only drops what's finished", () => {
    const finished = Array.from({ length: 7 }, (_, i) => tracked({ ref: `done-${i}`, order: order() }))
    const refs = trimmed([tracked({ ref: "open" }), ...finished]).map(({ ref }) => ref)
    assert.deepEqual(refs, ["open", "done-2", "done-3", "done-4", "done-5", "done-6"])
  })

  it("says it plainly", () => {
    assert.equal(purchaseTitle(tracked(), "USD"), "$5 of USDC")
    assert.equal(purchaseTitle(tracked({ typed: { micros: "5000000", currency: "EUR" } }), "EUR"), "€5 of USDC")
    assert.equal(purchaseTitle(tracked({ order: order() }), "USD"), `${5} USDC`)
    assert.equal(purchaseStatus({ kind: "recorded", cost: { micros: "5250000", currency: "USD" } }, "USD"), "Cost $5.25, fees included")
    assert.match(purchaseStatus({ kind: "recorded", cost: { micros: "5250000", currency: "EUR" } }, "CAD"), /EUR|€/)
  })

  it("says what the page will do with the amount", () => {
    assert.match(checkoutNote("USD", "USD"), /fees are added/)
    assert.match(checkoutNote("EUR", "EUR"), /starts at this amount in EUR/)
    assert.match(checkoutNote("CHF", "CHF"), /can't start from an amount in CHF/)
    assert.match(checkoutNote("USD", "CAD"), /no current USD to CAD rate/)
  })
})

describe("starting one", () => {
  const REQUEST = { address: ME, asset: "ETH", cryptoAmount: "0.001", fiat: null }

  it("only opens a known provider's own page", () => {
    assert.equal(pageOf("https://pay.coinbase.com/buy/select-asset?x=1"), "https://pay.coinbase.com/buy/select-asset?x=1")
    for (const url of ["http://pay.coinbase.com/buy", "https://pay.coinbase.com.evil.example/buy", "https://evil.example/https://pay.coinbase.com", "javascript:alert(1)", "not a url", 5, null]) assert.equal(pageOf(url), null, String(url))
  })

  it("refuses any other page, and says what the server said", async () => {
    assert.deepEqual(await startCheckout(REQUEST, answer(200, { url: "https://pay.coinbase.com/buy", ref: "r" })), { page: "https://pay.coinbase.com/buy", ref: "r" })
    await assert.rejects(startCheckout(REQUEST, answer(200, { url: "https://evil.example/", ref: "r" })), /isn't Coinbase's/)
    await assert.rejects(startCheckout(REQUEST, answer(503, { error: "Buying isn't set up on this server." })), /isn't set up/)
  })

  it("reads an order, or that there's none yet, and throws what it can't read", async () => {
    const signal = new AbortController().signal
    assert.equal((await readOrder("r", signal, answer(200, { orders: [order()] })))?.id, "order-1")
    assert.equal(await readOrder("r", signal, answer(200, { orders: [] })), null)
    await assert.rejects(readOrder("r", signal, answer(502, { error: "Coinbase can't be reached right now." })), /can't be reached/)
  })

  it("reads an amount as the checkout takes it", () => {
    for (const [text, plain] of [["5", "5"], ["5.5", "5.5"], ["1,000.50", "1000.50"], ["46,20", "46.20"]] as const) assert.equal(typedAmount(text), plain, text)
    for (const text of ["", "0", "0.00", "abc", "1.234", "-5", "1234567890"]) assert.equal(typedAmount(text), null, text)
    assert.equal(microsOf("5.5"), "5500000")
    assert.equal(microsOf("1000"), "1000000000")
  })

  it("makes a token amount the route accepts, even at a whole number", () => {
    const eth = TOKENS.find(({ symbol }) => symbol === "ETH")!
    assert.equal(amountForUsd("3000000000", eth, 3000000000n), "1")
    assert.equal(amountForUsd("3000000", eth, 3000000000n), "0.001")
    assert.match(amountForUsd("3000000000", eth, 3000000000n) as string, /^\d{1,12}(\.\d{1,18})?$/)
  })

  it("keeps what can be read from what's stored, whatever else is in there", () => {
    const good = tracked({ order: order() })
    assert.deepEqual(parseTrackedPurchases(JSON.parse(JSON.stringify([good, { ref: 5 }, null, tracked({ wallet: "nope" })]))), [good])
    assert.deepEqual(parseTrackedPurchases("nope"), [])
  })
})

describe("a bought cost's own note", () => {
  it("says where it came from, and when this transaction only moved it", () => {
    assert.match(costProof(purchaseSource("coinbase"), "paid"), /^Bought on Coinbase\. The order says what you paid, fees included, and matches this transaction exactly\.$/)
    assert.match(costProof(purchaseSource("coinbase"), "inherited"), /by your other wallet\. This transaction only moved it here/)
  })
})
