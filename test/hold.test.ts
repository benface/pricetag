// What a wallet made next to what simply holding ETH would have. One worked example per case, with the arithmetic by hand.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { PRICE_NOTES, compareWithHoldingEth, foldPositions, pnlStatus, sharePaidAt, sumTotals, type CostLabel, type CurrencyCode, type HoldComparison, type LatestPrices, type Method, type PricedLeg } from "@pricetag/sdk/core"
import type { WalletResponse } from "../src/core/api.ts"
import { emptyBook } from "../src/core/book.ts"
import { explainTarget } from "../src/core/explain.ts"
import { DEMO_SAVINGS_ADDRESS, DEMO_SAVINGS_WALLET, DEMO_WALLET, demoRates } from "../src/core/fixtures.ts"
import { foldBook } from "../src/core/resolve.ts"
import { holdCaveatSentence, holdDifferenceSentence } from "../src/core/wording.ts"
import { explainPortfolio, parseExplainTarget, portfolioOf } from "../src/core/portfolio.ts"
import { assertMatchesFixture } from "./support/fixtures.ts"
import { E18, E6 } from "./support/units.ts"

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
    txIndex: nextTx++,
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
  const txIndex = nextTx++
  return [leg(soldAsset, -sold, blockNum, { txHash, txIndex, kind: "swap", proceedsMicros: usd(dollars) }), leg(boughtAsset, bought, blockNum, { txHash, txIndex, kind: "swap", costMicros: usd(dollars), costLabel: "paid" })]
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

    it("leaves nothing out of what was put in for an amount with no ETH price at its moment", () => {
      // The USDC arrives at block 150, which has no ETH price, so it was never in the ETH, and its leaving takes none out.
      const known = deposit("ETH", 1, 1000, 100)
      const skipped = deposit("USDC", 1000, 1000, 150)
      const latest = prices(4000, { USDC: 1 })
      const before = compare([known, skipped], latest)
      const after = compare([known, skipped, send("USDC", 1000, 1, 200)], latest)
      assert.equal(before.holdMicros, usd(3000))
      assert.equal(after.holdMicros, usd(3000))
      assert.equal(after.ethQty, E18.toString())
      assert.equal(after.takenOutMicros, usd(0))
      assert.equal(after.status, "partial")
    })

    it("leaves nothing out of what was put in for an opening balance, even with a cost entered", () => {
      const opening = { ...leg("USDC", 1000n * E6, 90), opening: true, costMicros: usd(1000), costLabel: "self-reported" as const }
      const result = compare([opening, deposit("ETH", 1, 1000, 100), send("USDC", 1000, 1, 200)], prices(4000, { USDC: 1 }))
      assert.equal(result.ethQty, E18.toString())
      assert.equal(result.holdMicros, usd(3000))
      assert.equal(result.status, "partial")
    })

    it("follows an amount that wasn't in the ETH through an exchange", () => {
      // The AERO has a known cost, but it was paid for with USDC that was never in the ETH.
      const opening = { ...leg("USDC", 1000n * E6, 90), opening: true }
      const result = compare([opening, deposit("ETH", 1, 1000, 100), ...swap("USDC", 1000, "AERO", 1000, 1000, 150), leg("AERO", -1000n * E18, 200, { priceMicros: usd(1), priceSource: "oracle" })], prices(4000, { AERO: 1 }))
      assert.equal(result.ethQty, E18.toString())
      assert.equal(result.takenOutMicros, usd(0))
    })

    it("follows an amount that was in the ETH through an exchange", () => {
      const result = compare([deposit("USDC", 1000, 1000, 100), ...swap("USDC", 1000, "AERO", 1000, 1000, 150), leg("AERO", -500n * E18, 200, { priceMicros: usd(1), priceSource: "oracle" })], prices(4000, { AERO: 1 }))
      assert.equal(result.takenOutMicros, usd(500))
      assert.equal(result.ethQty, ((3n * E18) / 4n).toString())
    })

    it("takes out only the share of an exchange that came from an amount in the ETH", () => {
      // Half of the USDC was in the ETH, so half of the AERO was, and $500 of what leaves is $250 out of the ETH.
      const opening = { ...leg("USDC", 1000n * E6, 90), opening: true }
      const result = compare([opening, deposit("USDC", 1000, 1000, 100), ...swap("USDC", 2000, "AERO", 2000, 2000, 150), leg("AERO", -500n * E18, 200, { priceMicros: usd(1), priceSource: "oracle" })], prices(4000, { AERO: 1 }))
      assert.equal(result.takenOutMicros, usd(250))
      assert.equal(result.ethQty, ((7n * E18) / 8n).toString())
    })

    it("has no answer when an amount in the ETH left with no known value, even by way of an exchange with none", () => {
      const noValue = [leg("USDC", -1000n * E6, 150, { txHash: "0xfeed", txIndex: 5000, kind: "swap" }), leg("AERO", 1000n * E18, 150, { txHash: "0xfeed", txIndex: 5000, kind: "swap" })]
      const result = compare([deposit("USDC", 1000, 1000, 100), ...noValue, leg("AERO", -1000n * E18, 200)], prices(4000, { AERO: 1 }))
      assert.equal(result.status, "unavailable")
      assert.equal(result.unavailable, "left with no known value")
    })

    describe("after an exchange of several tokens at once", () => {
      /** 1 ETH that's in the ETH and $1,000 of USDC that isn't, together for 2,000 AERO. */
      function exchange(method: Method, leaving: Partial<PricedLeg> | null) {
        const txHash = "0xf00d"
        const txIndex = nextTx++
        const opening = { ...leg("USDC", 1000n * E6, 90), opening: true }
        const legs = [opening, deposit("ETH", 1, 1000, 100), leg("ETH", -E18, 150, { kind: "swap", txHash, txIndex }), leg("USDC", -1000n * E6, 150, { kind: "swap", txHash, txIndex }), leg("AERO", 2000n * E18, 150, { kind: "swap", txHash, txIndex })]
        return compare([...legs, ...(leaving ? [leg("AERO", -2000n * E18, 200, leaving)] : [])], prices(4000, { AERO: 1 }), method)
      }

      for (const method of ["average", "fifo"] as const) {
        it(`has no answer, by ${method}, when it leaves with no price`, () => {
          const result = exchange(method, {})
          assert.equal(result.status, "unavailable")
          assert.equal(result.unavailable, "left with no known value")
          assert.equal(result.holdMicros, null)
        })

        it(`has no answer, by ${method}, when it leaves with a price, because nobody can say how much of it was in the ETH`, () => {
          const result = exchange(method, { priceMicros: usd(1), priceSource: "oracle" })
          assert.equal(result.status, "unavailable")
          assert.equal(result.unavailable, "left with no known share")
          assert.equal(result.holdMicros, null)
          assert.match(holdCaveatSentence(result, "USD") as string, /several tokens at once/)
        })
      }

      it("still says what's known while it stays in the wallet", () => {
        const result = exchange("average", null)
        assert.equal(result.status, "partial")
        assert.equal(result.holdMicros, usd(3000))
      })

      it("goes by the one share there is when every token had it", () => {
        // Both were all in the ETH, so all of what they got was too.
        const txHash = "0xfeed1"
        const txIndex = nextTx++
        const legs = [deposit("ETH", 1, 1000, 100), deposit("USDC", 1000, 1000, 100), leg("ETH", -E18, 150, { kind: "swap", txHash, txIndex }), leg("USDC", -1000n * E6, 150, { kind: "swap", txHash, txIndex }), leg("AERO", 2000n * E18, 150, { kind: "swap", txHash, txIndex }), leg("AERO", -1000n * E18, 200, { priceMicros: usd(1), priceSource: "oracle" })]
        const result = compare(legs, prices(4000, { AERO: 1 }))
        assert.equal(result.takenOutMicros, usd(1000))
        assert.equal(result.unavailable, null)
      })

      it("can't say how much of an exchange was in the ETH when it also gave up a token nothing here can see", () => {
        const txHash = "0xfeed2"
        const txIndex = nextTx++
        const legs = [deposit("USDC", 1000, 1000, 100), leg("USDC", -1000n * E6, 150, { kind: "swap", txHash, txIndex, priceNote: PRICE_NOTES.unlisted }), leg("AERO", 2000n * E18, 150, { kind: "swap", txHash, txIndex, priceNote: PRICE_NOTES.unlisted }), leg("AERO", -2000n * E18, 200, { priceMicros: usd(1), priceSource: "oracle" })]
        assert.equal(compare(legs, prices(4000, { AERO: 1 })).unavailable, "left with no known share")
      })
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

describe("what came from a linked wallet", () => {
  const WALLET_A = `0x${"a".repeat(40)}`
  const WALLET_B = `0x${"b".repeat(40)}`
  const WALLET_C = `0x${"c".repeat(40)}`
  const part = (side: "debit" | "credit", counterparty: string, amount: bigint) => ({ side, counterparty, amount: amount.toString(), logIndex: 0, token: "", account: "", kind: "eth" as const })
  const ETH_NOW = 4000
  /** One transfer of ETH, as both wallets see it. */
  function transfer(from: string, to: string, amount: bigint, blockNum: number): [PricedLeg, PricedLeg] {
    const price = { priceMicros: usd(ETH_AT[blockNum] as number), priceSource: "oracle" as const }
    const sent = leg("ETH", -amount, blockNum, { ...price, parts: [part("debit", to, amount)] })
    return [sent, leg("ETH", amount, blockNum, { ...price, txHash: sent.txHash, txIndex: sent.txIndex, parts: [part("credit", from, amount)] })]
  }
  const walletOf = (address: string, legs: PricedLeg[], eth: bigint): WalletResponse => ({
    ...DEMO_WALLET,
    address,
    legs,
    references: Object.keys(ETH_AT).map((block) => ({ blockNum: Number(block), ethUsd: (BigInt(ETH_AT[Number(block)] as number) * 100_000_000n).toString(), usdcUsd: "100000000" })),
    prices: prices(ETH_NOW),
    latest: { blockNum: 400, timestamp: "2027-01-15T08:00:00.000Z" },
    coverage: { fromBlock: 100, toBlock: 400 },
    balances: { blockNum: 400, amounts: { ETH: eth.toString() } },
    marketChecked: false,
  })
  const bought = () => [deposit("ETH", 1, 1000, 100), deposit("ETH", 1, 2000, 200)]

  for (const method of ["average", "fifo"] as const) {
    it(`buys what each purchase bought, by ${method}, when all of it moves`, () => {
      const [sent, received] = transfer(WALLET_A, WALLET_B, 2n * E18, 300)
      const a = walletOf(WALLET_A, [...bought(), sent], 0n)
      const b = walletOf(WALLET_B, [received], 2n * E18)
      const { holdComparison } = foldBook(b, [a], method, { ...emptyBook(), linked: [WALLET_A] })
      assert.equal(holdComparison.status, "complete")
      assert.equal(holdComparison.putInMicros, usd(3000))
      assert.equal(holdComparison.ethQty, (2n * E18).toString())
      assert.equal(holdComparison.walletMicros, usd(5000))
      assert.equal(holdComparison.holdMicros, usd(5000))
      assert.equal(holdComparison.differenceMicros, usd(0))
    })

    it(`stays even with holding, by ${method}, when only part of it moves`, () => {
      const [sent, received] = transfer(WALLET_A, WALLET_B, E18, 300)
      const a = walletOf(WALLET_A, [...bought(), sent], E18)
      const b = walletOf(WALLET_B, [received], E18)
      const { holdComparison } = foldBook(b, [a], method, { ...emptyBook(), linked: [WALLET_A] })
      assert.equal(holdComparison.status, "complete")
      assert.equal(holdComparison.ethQty, E18.toString())
      assert.equal(holdComparison.differenceMicros, usd(0))
    })

    it(`keeps its dates, by ${method}, through a second linked wallet`, () => {
      const purchases = bought()
      const [first, firstIn] = transfer(WALLET_A, WALLET_B, 2n * E18, 200)
      const [second, secondIn] = transfer(WALLET_B, WALLET_C, 2n * E18, 300)
      const a = walletOf(WALLET_A, [...purchases, first], 0n)
      const b = walletOf(WALLET_B, [firstIn, second], 0n)
      const c = walletOf(WALLET_C, [secondIn], 2n * E18)
      const { holdComparison } = foldBook(c, [a, b], method, { ...emptyBook(), linked: [WALLET_A, WALLET_B] })
      assert.equal(holdComparison.ethQty, (2n * E18).toString())
      assert.equal(holdComparison.differenceMicros, usd(0))
    })
  }

  it("shares out what an average mixed together without losing or inventing any", () => {
    const parts = [{ costMicros: "1", qty: "40", blockNum: 1 }, { costMicros: "1", qty: "30", blockNum: 2 }, { costMicros: "1", qty: "29", blockNum: 3 }, { costMicros: "97", qty: "1", blockNum: 4 }]
    for (const share of [0n, 1n, 2n, 3n, 50n, 99n, 100n]) {
      const shares = sharePaidAt(parts, share, 100n, share, 100n)
      assert.equal(shares.reduce((sum, p) => sum + BigInt(p.costMicros), 0n), share)
      assert.equal(shares.reduce((sum, p) => sum + BigInt(p.qty), 0n), share)
      shares.forEach((p, i) => {
        const part = parts[i] as { costMicros: string; qty: string }
        assert.ok(BigInt(p.costMicros) >= 0n && BigInt(p.costMicros) <= BigInt(part.costMicros))
        assert.ok(BigInt(p.qty) >= 0n && BigInt(p.qty) <= BigInt(part.qty))
      })
    }
  })

  describe("bought at different prices, with no ETH price at the second", () => {
    /** 1 ETH at $1,000, and 1 ETH at $2,000 at a block with no price to convert it at, all moved to a linked wallet. */
    function linked(method: "average" | "fifo", leavingFromB: bigint) {
      const noPriceAt = 150
      const purchases = [deposit("ETH", 1, 1000, 100), deposit("ETH", 1, 2000, noPriceAt)]
      const [sent, received] = transfer(WALLET_A, WALLET_B, 2n * E18, 200)
      const leaving = leg("ETH", -leavingFromB, 300, { priceMicros: usd(4000), priceSource: "oracle" })
      const a = walletOf(WALLET_A, [...purchases, sent], 0n)
      const b = walletOf(WALLET_B, [received, leaving], 2n * E18 - leavingFromB)
      return foldBook(b, [a], method, { ...emptyBook(), linked: [WALLET_A] }).holdComparison
    }

    for (const method of ["average", "fifo"] as const) {
      it(`takes out all that was in the ETH, by ${method}, when all of it leaves`, () => {
        const result = linked(method, 2n * E18)
        // Only the first 1 ETH was ever in it, and it's all gone at $4,000.
        assert.equal(result.putInMicros, usd(1000))
        assert.equal(result.takenOutMicros, usd(4000))
        assert.equal(result.ethQty, "0")
        assert.equal(result.holdMicros, usd(3000))
      })
    }

    it("takes out half of what was in the ETH, by average, when half of it leaves", () => {
      const result = linked("average", E18)
      assert.equal(result.takenOutMicros, usd(2000))
      assert.equal(result.ethQty, (E18 / 2n).toString())
      assert.equal(result.holdMicros, usd(3000))
    })

    it("takes out what was in the ETH first, by oldest first, when part of it leaves", () => {
      const result = linked("fifo", E18)
      assert.equal(result.takenOutMicros, usd(4000))
      assert.equal(result.ethQty, "0")
      assert.equal(result.holdMicros, usd(3000))
    })
  })
})

describe("a position total PnL leaves out", () => {
  it("adds no gain that left to the wallet's side", () => {
    // 1 ETH at $1,000, and 0.5 ETH leaves at $2,000, but the chain says none is left, so this ETH's history can't be trusted.
    const legs = [deposit("ETH", 1, 1000, 100), leg("ETH", -E18 / 2n, 200, { priceMicros: usd(2000), priceSource: "oracle" }), deposit("USDC", 100, 100, 200)]
    const wallet: WalletResponse = {
      ...DEMO_WALLET,
      legs,
      references: [{ blockNum: 100, ethUsd: "100000000000", usdcUsd: "100000000" }, { blockNum: 200, ethUsd: "200000000000", usdcUsd: "100000000" }],
      prices: prices(4000, { USDC: 1 }),
      latest: { blockNum: 400, timestamp: "2027-01-15T08:00:00.000Z" },
      coverage: { fromBlock: 100, toBlock: 400 },
      balances: { blockNum: 400, amounts: { ETH: "0", USDC: (100n * E6).toString() } },
      marketChecked: false,
    }
    const { totals, holdComparison } = foldBook(wallet, [], "average", emptyBook())
    assert.deepEqual(totals.excluded, [{ asset: "ETH", reason: "doesn't match its actual balance" }])
    assert.equal(totals.pnlMicros, usd(0))
    assert.equal(holdComparison.gainThatLeftMicros, usd(0))
    assert.equal(holdComparison.walletMicros, usd(0))
    assert.equal(holdComparison.status, "partial")
    assert.equal(holdComparison.walletLeavesOut, true)
  })

  describe("when holding has no answer", () => {
    const sentAtTwice = () => [deposit("ETH", 1, 1000, 100, "self-reported"), leg("ETH", -E18, 200, { priceMicros: usd(2000), priceSource: "oracle" })]

    it("still counts the gain that left, which today's price can't change", () => {
      const result = compare(sentAtTwice(), prices(null))
      assert.equal(result.status, "unavailable")
      assert.equal(result.unavailable, "no current eth price")
      assert.equal(result.holdMicros, null)
      assert.equal(result.gainThatLeftMicros, usd(1000))
      assert.equal(result.walletMicros, usd(1000))
      assert.equal(result.walletLeavesOut, false)
    })

    it("gives the wallet's side the same number in every state", () => {
      // Nothing it's put in has a known ETH price, and the same wallet with one says the same about itself.
      const noMoment = [deposit("ETH", 1, 1000, 150, "self-reported"), leg("ETH", -E18, 200, { priceMicros: usd(2000), priceSource: "oracle" })]
      const unavailable = compare(noMoment, prices(2000))
      assert.equal(unavailable.unavailable, "nothing known put in")
      assert.equal(unavailable.walletMicros, compare(sentAtTwice(), prices(2000)).walletMicros)
      assert.equal(unavailable.gainThatLeftMicros, usd(1000))
    })

    it("keeps saying the wallet's side is an estimate", () => {
      const result = compare([deposit("ETH", 1, 1000, 100), leg("ETH", -E18, 200, { priceMicros: usd(2000), priceSource: "oracle" })], prices(null))
      assert.equal(result.status, "unavailable")
      assert.equal(result.walletEstimated, true)
    })
  })

  it("says the wallet's side leaves something out when what left has no price, rather than counting its gain as nothing", () => {
    // Its cost is known, so total PnL counts it as gone with no gain or loss, but what it was worth when it left isn't known.
    const result = compare([deposit("ETH", 1, 1000, 100, "self-reported"), leg("ETH", -E18, 200)], prices(2000))
    assert.equal(result.status, "unavailable")
    assert.equal(result.unavailable, "left with no known value")
    assert.equal(result.walletLeavesOut, true)
    assert.equal(result.walletMicros, usd(0))
    assert.equal(result.gainThatLeftMicros, usd(0))
  })

  it("keeps a send with no price from an amount that was never in the ETH from making it complete", () => {
    const skipped = deposit("USDC", 1000, 1000, 150, "self-reported")
    const result = compare([deposit("ETH", 1, 1000, 100, "self-reported"), skipped, leg("USDC", -1000n * E6, 200)], prices(2000))
    assert.equal(result.status, "partial")
    assert.equal(result.walletLeavesOut, true)
  })

  it("still adds the gain that left a position it includes", () => {
    const result = compare([deposit("ETH", 1, 1000, 100), leg("ETH", -E18 / 2n, 200, { priceMicros: usd(2000), priceSource: "oracle" })], prices(2000))
    assert.equal(result.gainThatLeftMicros, usd(500))
  })

  it("marks the wallet's side an estimate when what left carried an estimated cost, even with nothing left to show it", () => {
    const received = deposit("ETH", 1, 1000, 100)
    const result = compare([received, leg("ETH", -E18, 200, { priceMicros: usd(2000), priceSource: "oracle" })], prices(2000))
    assert.equal(result.walletMicros, usd(1000))
    assert.equal(result.walletEstimated, true)
  })

  it("doesn't mark the wallet's side an estimate when what left was exact at both ends", () => {
    const result = compare([deposit("ETH", 1, 1000, 100, "self-reported"), leg("ETH", -E18, 200, { priceMicros: usd(2000), priceSource: "oracle" })], prices(2000))
    assert.equal(result.walletMicros, usd(1000))
    assert.equal(result.walletEstimated, false)
  })

  it("marks the wallet's side an estimate when a market price valued what left", () => {
    const result = compare([deposit("USDC", 1000, 1000, 100), ...swap("USDC", 1000, "AERO", 1000, 1000, 100), leg("AERO", -500n * E18, 200, { priceMicros: usd(2), priceSource: "market" })], prices(2000, { AERO: 2 }))
    assert.equal(result.walletEstimated, true)
    assert.equal(result.estimated, true)
  })
})

describe("the card's states", () => {
  const manyForOne = () => {
    const [txHash, txIndex] = ["0xbeef", nextTx++]
    return [leg("ETH", -E18, 150, { kind: "swap", txHash, txIndex }), leg("USDC", -1000n * E6, 150, { kind: "swap", txHash, txIndex }), leg("AERO", 2000n * E18, 150, { kind: "swap", txHash, txIndex })]
  }

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
      ["USD", compare([deposit("ETH", 1, 1000, 100), { ...leg("USDC", 1000n * E6, 90), opening: true }, ...manyForOne(), leg("AERO", -2000n * E18, 200, { priceMicros: usd(1), priceSource: "oracle" })], prices(2000, { AERO: 1 }))],
    ]
    const vectors = cases.map(([currency, comparison]) => ({ currency, comparison, difference: comparison.differenceMicros && holdDifferenceSentence(comparison.differenceMicros, currency), aboutDifference: comparison.differenceMicros && holdDifferenceSentence(comparison.differenceMicros, currency, true), caveat: holdCaveatSentence(comparison, currency) }))
    assertMatchesFixture("hold-vectors.json", vectors)
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
