// What a wallet made next to what simply holding ETH would have. One worked example per case, with the arithmetic by hand.

import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { describe, it } from "node:test"
import { compareWithHoldingEth, foldPositions, pnlStatus, sumTotals, type CostLabel, type CurrencyCode, type HoldComparison, type LatestPrices, type Method, type PricedLeg } from "@pricetag/sdk/core"
import type { WalletResponse } from "../src/core/api.ts"
import { emptyBook } from "../src/core/book.ts"
import { explainTarget } from "../src/core/explain.ts"
import { DEMO_SAVINGS_ADDRESS, DEMO_SAVINGS_WALLET, DEMO_WALLET, demoRates } from "../src/core/fixtures.ts"
import { foldBook } from "../src/core/resolve.ts"
import { holdCaveatSentence, holdDifferenceSentence } from "../src/core/wording.ts"
import { explainPortfolio, parseExplainTarget, portfolioOf } from "../server/portfolio.ts"

const E18 = 10n ** 18n
const E6 = 10n ** 6n
const usd = (dollars: number) => (BigInt(dollars) * E6).toString()
const units = { ETH: E18, USDC: E6, AERO: E18 } as Record<string, bigint>
const decimals = { ETH: 18, USDC: 6, AERO: 18 } as Record<string, number>

let nextTx = 0

function leg(asset: string, amount: number | bigint, blockNum: number, rest: Partial<PricedLeg> = {}): PricedLeg {
  const txHash = rest.txHash ?? `0x${(nextTx++).toString(16).padStart(64, "0")}`
  return {
    id: `${txHash}:${asset}`,
    asset,
    delta: (typeof amount === "bigint" ? amount : BigInt(amount) * (units[asset] as bigint)).toString(),
    decimals: decimals[asset] as number,
    kind: "transfer",
    priceMicros: null,
    priceSource: null,
    priceNote: null,
    costMicros: null,
    proceedsMicros: null,
    costLabel: "unknown",
    blockNum,
    timestamp: new Date(1_800_000_000_000 + blockNum * 2000).toISOString(),
    txHash,
    txIndex: 0,
    parts: [],
    ...rest,
  }
}

/** Something arrives from outside, worth `dollars` when it arrived. */
const deposit = (asset: string, amount: number, dollars: number, blockNum: number, costLabel: CostLabel = "received at market") => leg(asset, amount, blockNum, { costMicros: usd(dollars), costLabel, priceMicros: ((BigInt(dollars) * E6) / BigInt(amount)).toString(), priceSource: "oracle" })
/** Something leaves, with a known price at that block. */
const send = (asset: string, amount: number, price: number, blockNum: number) => leg(asset, -amount, blockNum, { priceMicros: usd(price), priceSource: "oracle" })
/** One token for another, at one value, in one transaction. */
function swap(soldAsset: string, sold: number, boughtAsset: string, bought: number, dollars: number, blockNum: number): PricedLeg[] {
  const txHash = `0x${(nextTx++).toString(16).padStart(64, "0")}`
  return [leg(soldAsset, -sold, blockNum, { txHash, kind: "swap", proceedsMicros: usd(dollars) }), leg(boughtAsset, bought, blockNum, { txHash, kind: "swap", costMicros: usd(dollars), costLabel: "paid" })]
}
/** A network fee in thousandths of an ETH, at `price`. */
const gas = (thousandths: number, price: number, blockNum: number) => leg("ETH", -(BigInt(thousandths) * E18) / 1000n, blockNum, { kind: "gas", priceMicros: usd(price), priceSource: "oracle" })

const ETH_AT: Record<number, number> = { 100: 1000, 200: 2000, 300: 4000 }
const marks = (blockNum: number, asset: string) => (asset === "ETH" && ETH_AT[blockNum] ? usd(ETH_AT[blockNum]) : null)

function prices(eth: number | null, others: Record<string, number> = {}): LatestPrices {
  const latest: LatestPrices = {}
  if (eth !== null) latest.ETH = { micros: usd(eth), source: "oracle", blockNum: 400 }
  for (const [asset, price] of Object.entries(others)) latest[asset] = { micros: usd(price), source: "oracle", blockNum: 400 }
  return latest
}

function compare(legs: PricedLeg[], latest: LatestPrices, method: Method = "average"): HoldComparison {
  const positions = foldPositions(legs, method, latest)
  const totals = sumTotals(positions)
  return compareWithHoldingEth(positions, totals, pnlStatus(totals), latest, marks)
}

describe("comparing a wallet with holding ETH", () => {
  it("says when a wallet beat holding", () => {
    // $1,000 in at $1,000 an ETH would be 1 ETH. It went into AERO instead, which went up 4x while ETH went up 2x.
    const result = compare([deposit("USDC", 1000, 1000, 100), ...swap("USDC", 1000, "AERO", 1000, 1000, 100)], prices(2000, { USDC: 1, AERO: 4 }))
    assert.equal(result.status, "complete")
    assert.equal(result.walletMicros, usd(3000))
    assert.equal(result.putInMicros, usd(1000))
    assert.equal(result.ethQty, E18.toString())
    assert.equal(result.ethValueMicros, usd(2000))
    assert.equal(result.holdMicros, usd(1000))
    assert.equal(result.differenceMicros, usd(2000))
    assert.equal(holdDifferenceSentence(result.differenceMicros as string, "USD"), "$2,000.00 more than holding ETH.")
    assert.equal(holdCaveatSentence(result, "USD"), null)
  })

  it("says when a wallet lost to holding", () => {
    // The same $1,000 stayed in USDC while ETH doubled.
    const result = compare([deposit("USDC", 1000, 1000, 100)], prices(2000, { USDC: 1 }))
    assert.equal(result.status, "complete")
    assert.equal(result.walletMicros, usd(0))
    assert.equal(result.holdMicros, usd(1000))
    assert.equal(result.differenceMicros, usd(-1000))
    assert.equal(holdDifferenceSentence(result.differenceMicros as string, "USD"), "$1,000.00 less than holding ETH.")
  })

  it("converts each amount at its own moment's price", () => {
    // 1 ETH at $1,000, then $2,000 buys 1 more, and $4,000 buys 1 more.
    const result = compare([deposit("USDC", 1000, 1000, 100), deposit("USDC", 2000, 2000, 200), deposit("USDC", 4000, 4000, 300)], prices(4000, { USDC: 1 }))
    assert.equal(result.ethQty, (3n * E18).toString())
    assert.equal(result.putInMicros, usd(7000))
    assert.equal(result.holdMicros, usd(5000))
  })

  it("makes a wallet that only held ETH the same as holding, except for its fees", () => {
    const legs = [deposit("ETH", 1, 1000, 100)]
    assert.equal(compare(legs, prices(4000)).differenceMicros, usd(0))
    // 1 thousandth of an ETH at $2,000 cost $2, and is worth $4 at today's price.
    const paid = compare([...legs, gas(1, 2000, 200)], prices(4000))
    assert.equal(paid.status, "complete")
    assert.equal(paid.holdMicros, usd(3000))
    assert.equal(paid.walletMicros, usd(2996))
    assert.equal(paid.differenceMicros, usd(-4))
  })

  it("doesn't count an exchange inside the wallet as anything put in", () => {
    const result = compare([deposit("ETH", 1, 1000, 100), ...swap("ETH", 1, "USDC", 2000, 2000, 200)], prices(4000, { USDC: 1 }))
    assert.equal(result.putInMicros, usd(1000))
    assert.equal(result.holdMicros, usd(3000))
    assert.equal(result.walletMicros, usd(1000))
    assert.equal(result.differenceMicros, usd(-2000))
  })

  describe("with what left the wallet", () => {
    it("takes it out of the ETH too, at its value when it left", () => {
      // 1 ETH at $1,000. When ETH is $2,000, $500 of USDC leaves, which is 0.25 ETH. So 0.75 ETH left at $2,000 is $1,500.
      const result = compare([deposit("USDC", 1000, 1000, 100), send("USDC", 500, 1, 200)], prices(2000, { USDC: 1 }))
      assert.equal(result.takenOutMicros, usd(500))
      assert.equal(result.ethQty, ((3n * E18) / 4n).toString())
      assert.equal(result.ethValueMicros, usd(1500))
      // Holding ETH doubled the $1,000 either way.
      assert.equal(result.holdMicros, usd(1000))
      assert.equal(result.walletMicros, usd(0))
      assert.equal(result.differenceMicros, usd(-1000))
    })

    it("still matches a wallet that only held ETH", () => {
      const result = compare([deposit("ETH", 1, 1000, 100), leg("ETH", -E18 / 2n, 200, { priceMicros: usd(2000), priceSource: "oracle" })], prices(2000))
      // 0.5 ETH left at twice what it cost, which is a transfer to total PnL and not a sale, so this adds what it gained.
      assert.equal(result.gainThatLeftMicros, usd(500))
      assert.equal(result.walletMicros, usd(1000))
      assert.equal(result.holdMicros, usd(1000))
      assert.equal(result.differenceMicros, usd(0))
    })

    it("counts what left at its value on both sides, whatever it cost", () => {
      // $1,000 of AERO at $0.25 goes to $1 with ETH flat, and 400 AERO leaves. Holding made nothing, and this made $3,000.
      const result = compare([deposit("USDC", 1000, 1000, 100), ...swap("USDC", 1000, "AERO", 4000, 1000, 100), leg("AERO", -400n * E18, 100, { priceMicros: usd(1), priceSource: "oracle" })], prices(1000, { AERO: 1 }))
      assert.equal(result.holdMicros, usd(0))
      assert.equal(result.gainThatLeftMicros, usd(300))
      assert.equal(result.walletMicros, usd(3000))
      assert.equal(result.differenceMicros, usd(3000))
    })

    it("doesn't credit holding with what it couldn't have paid", () => {
      // $1,000 made $4,000 with ETH flat, and $2,000 left, but holding only ever had $1,000 to give.
      const result = compare([deposit("USDC", 1000, 1000, 100), ...swap("USDC", 1000, "AERO", 4000, 1000, 100), leg("AERO", -2000n * E18, 100, { priceMicros: usd(1), priceSource: "oracle" })], prices(1000, { AERO: 1 }))
      assert.equal(result.ranOut, true)
      assert.equal(result.ethQty, "0")
      assert.equal(result.holdMicros, usd(0))
      assert.equal(result.walletMicros, usd(3000))
    })

    it("has no answer when what left has no known value, because the ETH left would be too much", () => {
      const result = compare([deposit("USDC", 1000, 1000, 100), leg("USDC", -500n * E6, 200)], prices(2000, { USDC: 1 }))
      assert.equal(result.status, "unavailable")
      assert.equal(result.unavailable, "left with no known value")
      assert.equal(result.holdMicros, null)
      assert.match(holdCaveatSentence(result, "USD") as string, /Unavailable, because something left/)
    })

    it("takes nothing out for a part that was never known to be put in", () => {
      const unknown = leg("USDC", 1000n * E6, 100)
      const result = compare([unknown, send("USDC", 1000, 1, 200), deposit("ETH", 1, 2000, 200)], prices(2000, { USDC: 1 }))
      assert.equal(result.takenOutMicros, usd(0))
      assert.equal(result.ethQty, E18.toString())
      assert.equal(result.status, "partial")
    })
  })

  describe("with amounts of unknown value", () => {
    it("says it's partial, and never counts them as $0", () => {
      const legs = [deposit("USDC", 1000, 1000, 100), leg("AERO", 500n * E18, 200)]
      const result = compare(legs, prices(2000, { USDC: 1, AERO: 2 }))
      assert.equal(result.status, "partial")
      assert.equal(result.unknownAmounts, 1)
      assert.equal(result.putInMicros, usd(1000))
      // True of the $1,000 it covers, but there's no difference to show between two sums of different money.
      assert.equal(result.holdMicros, usd(1000))
      assert.equal(result.differenceMicros, null)
      assert.equal(holdCaveatSentence(result, "USD"), "Partial, so the two don't cover the same money. Holding ETH counts the $1,000.00 put in with a known value. 1 other amount has no known value, and isn't counted. This wallet's total leaves some things out.")
    })

    it("is unavailable when nothing put in has a known value", () => {
      const result = compare([leg("USDC", 1000n * E6, 100)], prices(2000, { USDC: 1 }))
      assert.equal(result.status, "unavailable")
      assert.equal(result.unavailable, "nothing known put in")
      assert.equal(result.holdMicros, null)
      assert.equal(result.walletMicros, null)
      assert.equal(result.differenceMicros, null)
      assert.match(holdCaveatSentence(result, "USD") as string, /nothing put in this wallet has a known value/)
    })

    it("treats an amount with no ETH price at its moment as unknown", () => {
      const result = compare([deposit("USDC", 1000, 1000, 100), deposit("USDC", 500, 500, 150)], prices(2000, { USDC: 1 }))
      assert.equal(result.status, "partial")
      assert.equal(result.unknownAmounts, 1)
      assert.equal(result.putInMicros, usd(1000))
    })

    it("treats what was already there as unknown, even with a cost, since it has no moment to convert at", () => {
      const result = compare([deposit("USDC", 1000, 1000, 100), { ...leg("USDC", 500n * E6, 100), opening: true, costMicros: usd(500), costLabel: "self-reported" }], prices(2000, { USDC: 1 }))
      assert.equal(result.status, "partial")
      assert.equal(result.unknownAmounts, 1)
    })

    it("counts the known parts of something that arrived in pieces", () => {
      const pieces = [
        { qty: (500n * E6).toString(), costMicros: usd(500), label: "inherited" as const, estimatedCostMicros: "0", acquiredBlock: 100, acquiredAt: "" },
        { qty: (500n * E6).toString(), costMicros: null, label: "unknown" as const, estimatedCostMicros: "0" },
      ]
      const result = compare([leg("USDC", 1000n * E6, 200, { pieces, costLabel: "inherited" })], prices(2000, { USDC: 1 }))
      assert.equal(result.status, "partial")
      assert.equal(result.putInMicros, usd(500))
      // At the $1,000 of block 100, when it was first paid for, not the $2,000 of block 200 when it got here.
      assert.equal(result.ethQty, (E18 / 2n).toString())
    })

    it("has no answer with no current ETH price, rather than an old one", () => {
      const result = compare([deposit("USDC", 1000, 1000, 100)], prices(null, { USDC: 1 }))
      assert.equal(result.status, "unavailable")
      assert.equal(result.unavailable, "no current eth price")
      assert.equal(result.holdMicros, null)
    })

    it("isn't complete when the wallet's own total leaves something out", () => {
      // Its deposit is known, but nothing says what its AERO is worth today, so its total isn't all of it.
      const result = compare([deposit("USDC", 1000, 1000, 100), ...swap("USDC", 1000, "AERO", 1000, 1000, 100)], prices(2000, { USDC: 1 }))
      assert.equal(result.walletLeavesOut, true)
      assert.equal(result.status, "partial")
      assert.equal(result.differenceMicros, null)
      assert.match(holdCaveatSentence(result, "USD") as string, /This wallet's total leaves some things out\.$/)
    })

    it("ignores tokens with no market, which are often spam and can't affect PnL", () => {
      const spam = leg("AERO", 500n * E18, 100)
      const positions = foldPositions([deposit("USDC", 1000, 1000, 100), spam], "average", prices(2000, { USDC: 1 })).map((p) => (p.asset === "AERO" ? { ...p, noMarket: true } : p))
      const totals = sumTotals(positions)
      const result = compareWithHoldingEth(positions, totals, pnlStatus(totals), prices(2000, { USDC: 1 }), marks)
      assert.equal(result.unknownAmounts, 0)
      assert.equal(result.status, "complete")
    })
  })

  it("comes out the same by either way of working out cost when nothing's left the wallet", () => {
    const legs = [deposit("USDC", 1000, 1000, 100), ...swap("USDC", 400, "AERO", 400, 400, 200)]
    const latest = prices(2000, { USDC: 1, AERO: 3 })
    assert.equal(compare(legs, latest, "average").holdMicros, compare(legs, latest, "fifo").holdMicros)
    assert.equal(compare(legs, latest, "average").differenceMicros, compare(legs, latest, "fifo").differenceMicros)
  })
})

describe("the card's states", () => {
  it("says the same on the Mac", () => {
    const usdc = { USDC: 1 }
    const cases: [CurrencyCode, HoldComparison][] = [
      ["USD", compare([deposit("USDC", 1000, 1000, 100), ...swap("USDC", 1000, "AERO", 1000, 1000, 100)], prices(2000, { USDC: 1, AERO: 4 }))],
      ["USD", compare([deposit("USDC", 1000, 1000, 100)], prices(2000, usdc))],
      ["USD", compare([deposit("ETH", 1, 1000, 100)], prices(1000))],
      ["USD", compare([deposit("USDC", 1000, 1000, 100), leg("AERO", 500n * E18, 200)], prices(2000, { USDC: 1, AERO: 2 }))],
      ["CAD", compare([deposit("USDC", 1000, 1000, 100), leg("AERO", 500n * E18, 200), leg("AERO", 500n * E18, 300)], prices(2000, { USDC: 1, AERO: 2 }))],
      ["USD", compare([leg("USDC", 1000n * E6, 100)], prices(2000, usdc))],
      ["USD", compare([deposit("USDC", 1000, 1000, 100), leg("USDC", -500n * E6, 200)], prices(2000, usdc))],
      ["USD", compare([deposit("USDC", 1000, 1000, 100)], prices(null, usdc))],
    ]
    const vectors = cases.map(([currency, comparison]) => ({ currency, comparison, difference: comparison.differenceMicros && holdDifferenceSentence(comparison.differenceMicros, currency), aboutDifference: comparison.differenceMicros && holdDifferenceSentence(comparison.differenceMicros, currency, true), caveat: holdCaveatSentence(comparison, currency) }))
    const url = new URL("../macos/PricetagKit/Tests/PricetagKitTests/Resources/hold-vectors.json", import.meta.url)
    const text = `${JSON.stringify(vectors, null, 2)}\n`
    if (process.env.UPDATE_FIXTURES) writeFileSync(url, text)
    assert.equal(readFileSync(url, "utf8"), text, "hold-vectors.json is out of date. Run with UPDATE_FIXTURES=1 if the change is on purpose.")
    assert.deepEqual(new Set(cases.map(([, c]) => c.status)), new Set(["complete", "partial", "unavailable"]))
  })
})

describe("the comparison in a read wallet", () => {
  const inCurrency = (currency: CurrencyCode): WalletResponse => ({ ...DEMO_WALLET, currency, rates: currency === "USD" ? null : demoRates(currency) })

  it("is partial for the demo wallet, which has unknown deposits", () => {
    const { holdComparison, totals } = foldBook(DEMO_WALLET, [], "average", emptyBook())
    assert.equal(holdComparison.status, "partial")
    assert.equal(holdComparison.differenceMicros, null)
    assert.equal(BigInt(holdComparison.walletMicros as string), BigInt(totals.pnlMicros as string) + BigInt(holdComparison.gainThatLeftMicros))
    assert.ok(holdComparison.unknownAmounts > 0)
  })

  it("gets to more of what was put in as people answer what it asks", () => {
    const before = foldBook(DEMO_WALLET, [], "average", emptyBook()).holdComparison
    const book = { ...emptyBook(), senders: { [DEMO_SAVINGS_ADDRESS]: { kind: "someone-else" as const } } }
    const after = foldBook(DEMO_WALLET, [], "average", book).holdComparison
    assert.ok(BigInt(after.putInMicros) > BigInt(before.putInMicros))
    assert.ok(after.unknownAmounts < before.unknownAmounts)
  })

  it("converts at each moment's rate in the main currency, not at today's", () => {
    const usdResult = foldBook(inCurrency("USD"), [], "average", emptyBook()).holdComparison
    const cad = foldBook(inCurrency("CAD"), [], "average", emptyBook()).holdComparison
    assert.equal(cad.status, usdResult.status)
    // The dollar's value fell over the demo, so what holding made in CAD isn't its USD gain at today's rate.
    const atTodaysRate = (BigInt(usdResult.holdMicros as string) * 1000n) / 715n
    assert.notEqual(cad.holdMicros, atTodaysRate.toString())
  })

  it("works in the main currency at each moment, by hand", () => {
    // $1,000 in when 1 USD = 1.3333 CAD and ETH is $1,000, so CA$1,333.33 buys 1 ETH. Today 1 USD = 2 CAD and ETH is $2,000.
    const deposited = deposit("USDC", 1000, 1000, 100)
    const at = (blockNum: number) => Date.parse(deposited.timestamp) / 1000 + (blockNum - 100) * 2
    const latest = { blockNum: 400, timestamp: new Date(at(400) * 1000).toISOString() }
    const wallet: WalletResponse = {
      ...DEMO_WALLET,
      legs: [deposited],
      references: [{ blockNum: 100, ethUsd: "100000000000", usdcUsd: "100000000" }],
      prices: prices(2000, { USDC: 1 }),
      latest,
      coverage: { fromBlock: 100, toBlock: 400 },
      balances: { blockNum: 400, amounts: { USDC: deposited.delta } },
      currency: "CAD",
      rates: { byBlock: { 100: { answer: "75000000", updatedAt: at(100) } }, latest: { blockNum: 400, round: { answer: "50000000", updatedAt: at(400) } } },
    }
    const { holdComparison, pnlStatus: status } = foldBook(wallet, [], "average", emptyBook())
    assert.equal(status, "complete")
    assert.equal(holdComparison.status, "complete")
    assert.equal(holdComparison.putInMicros, "1333333333")
    // 1 ETH, less at most a rounding unit, at CA$4,000.
    assert.ok(BigInt(holdComparison.ethValueMicros as string) >= 3_999_999_990n)
    assert.ok(BigInt(holdComparison.holdMicros as string) >= 2_666_666_650n)
    // The wallet's $1,000 of USDC is CA$2,000 today, so it gained CA$666.67, and holding gained CA$2,000 more.
    assert.equal(holdComparison.walletMicros, "666666667")
    assert.ok(BigInt(holdComparison.differenceMicros as string) <= -1_999_999_980n)
  })

  it("converts what came from a linked wallet at the moment it was paid for, from that wallet's price reads", () => {
    const book = { ...emptyBook(), linked: [DEMO_SAVINGS_ADDRESS] }
    const paidAt = 53_499_700
    assert.ok(DEMO_SAVINGS_WALLET.references.some((r) => r.blockNum === paidAt))
    const focus = { ...DEMO_WALLET, references: DEMO_WALLET.references.filter((r) => r.blockNum !== paidAt) }
    const linked = foldBook(focus, [DEMO_SAVINGS_WALLET], "average", book).holdComparison
    assert.deepEqual(linked, foldBook(DEMO_WALLET, [DEMO_SAVINGS_WALLET], "average", book).holdComparison)
    const alone = foldBook(focus, [], "average", emptyBook()).holdComparison
    assert.ok(BigInt(linked.putInMicros) > BigInt(alone.putInMicros))
  })

  it("is what the server sends", () => {
    const portfolio = portfolioOf(DEMO_WALLET, "average")
    assert.deepEqual(portfolio.holdComparison, foldBook(DEMO_WALLET, [], "average", { ...emptyBook(), linked: [] }).holdComparison)
  })

  it("explains itself, in plain language, with what it's made from", () => {
    assert.deepEqual(parseExplainTarget(new URLSearchParams("metric=hold")), { kind: "hold" })
    const fold = foldBook(DEMO_WALLET, [], "average", emptyBook())
    const explanation = explainTarget({ kind: "hold" }, fold)
    assert.ok(explanation)
    const text = explanation.lines.join(" ")
    assert.match(text, /turns it into ETH at that moment's price/)
    assert.match(text, /Put in means/)
    assert.match(text, /Past results don't predict future ones\./)
    assert.doesNotMatch(text, /\b(oracle|fifo|leg|legs|swap)\b/i)
    assert.ok(explanation.effects.length > 0)
    assert.ok(explanation.effects.every((e) => e.leg.kind === "transfer"))
    assert.equal(explainPortfolio(DEMO_WALLET, "average", { kind: "hold" })?.title, explanation.title)
  })

  it("explains itself in USD beside another currency", () => {
    const wallet = inCurrency("CAD")
    const explanation = explainPortfolio(wallet, "average", { kind: "hold" })
    assert.ok(explanation?.value?.includes("CA$") || explanation?.currency === "CAD")
    assert.match(explanation?.sourceValue ?? "", /USD$/)
  })
})
