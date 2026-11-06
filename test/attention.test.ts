// The one warning under a wallet's numbers, and what each row still flags. The expected sentences are the Mac's, from `HeadlineTests.swift` and `WordingTests.swift`.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Position, Totals } from "@pricetag/sdk/core"
import { allBalancesMatch, attentionOf, attentionTarget, balanceFlag, pastCostsNote, type AttentionFacts } from "../src/core/attention.ts"
import { emptyBook } from "../src/core/book.ts"
import { DEMO_WALLET } from "../src/core/fixtures.ts"
import { foldBook } from "../src/core/resolve.ts"
import { ALL_BALANCES_MATCH, PAST_COSTS_UNKNOWN, excludedSentence, holdSummarySentence } from "../src/core/wording.ts"

const totals = (changes: Partial<Totals> = {}): Totals =>
  ({
    valueMicros: "100000000",
    realizedMicros: "0",
    unrealizedMicros: "0",
    gasMicros: "0",
    pnlMicros: "0",
    unresolvedMicros: "0",
    estimatedMicros: "0",
    estimated: { value: false, realized: false, unrealized: false },
    coverage: { value: { known: 1, missing: 0 }, realized: { known: 1, missing: 0 }, unrealized: { known: 1, missing: 0 }, pnl: { known: 1, missing: 0 } },
    excluded: [],
    noMarket: [],
    unpricedGas: false,
    ...changes,
  }) as unknown as Totals

const position = (asset: string, changes: { status?: "reconciled" | "unchecked" | "incomplete"; shortfallQty?: string; valueMicros?: string | null; noMarket?: boolean } = {}): Position => {
  const { status = "reconciled", shortfallQty = "0", valueMicros = "1000000", noMarket = false } = changes
  const reconciliation =
    status === "unchecked" ? { status, reason: "The wallet's actual balance couldn't be read.", heldQty: null, heldIsCurrent: false } : { status, computedQty: "1000000", actualQty: status === "reconciled" ? "1000000" : "3000000", differenceQty: status === "reconciled" ? "0" : "2000000", blockNum: 1 }
  return { asset, decimals: 6, state: { shortfallQty }, values: { qty: "1000000", valueMicros, unknownCostQty: "0" }, reconciliation, noMarket, effects: [], price: null, estimates: {} } as unknown as Position
}

const facts = (changes: Partial<AttentionFacts> = {}): AttentionFacts => ({
  positions: [position("USDC")],
  unread: [],
  totals: totals(),
  pnlStatus: "complete",
  gasUnknownTxs: [],
  l1FeeUnknownTxs: [],
  withheld: [],
  currency: "USD",
  missingRateTxs: [],
  hasCurrentRate: true,
  ...changes,
})

describe("attentionOf", () => {
  it("says nothing when the numbers leave out nothing and rest on nothing estimated", () => {
    assert.equal(attentionOf(facts()), null)
  })

  it("says the same as the Mac about the demo wallet, and keeps the full list a hover away", () => {
    const fold = foldBook(DEMO_WALLET, [], "average", emptyBook())
    const attention = attentionOf(facts({ positions: fold.positions, unread: fold.unread, totals: fold.totals, pnlStatus: fold.pnlStatus, withheld: fold.withheld }))
    assert.ok(attention?.title.startsWith("$3,603.42 has an unknown cost, so it isn't in the PnL."), String(attention?.title))
    assert.ok(attention?.title.endsWith("$899.98 is estimated."), String(attention?.title))
    assert.equal(attention?.fullList, excludedSentence(fold.totals.excluded))
  })

  it("doesn't repeat an unknown cost the title already says", () => {
    const attention = attentionOf(facts({ totals: totals({ unresolvedMicros: "3603420000", excluded: [{ asset: "USDC", reason: "unknown cost" }] }), pnlStatus: "partial" }))
    assert.equal(attention?.title, "$3,603.42 has an unknown cost, so it isn't in the PnL.")
    assert.ok(!attention?.details.some((line) => line.includes("leaves out")))
  })

  it("names what else the PnL leaves out", () => {
    const attention = attentionOf(facts({ totals: totals({ unresolvedMicros: "1000000", excluded: [{ asset: "USDC", reason: "unknown cost" }, { asset: "AERO", reason: "no current price" }] }), pnlStatus: "partial" }))
    assert.deepEqual(attention?.details, ["PnL also leaves out AERO."])
  })

  it("keeps a balance that couldn't be read, which has no row to say so", () => {
    const attention = attentionOf(facts({ unread: ["USDC"], totals: totals({ unresolvedMicros: "250000000", valueMicros: null, excluded: [{ asset: "DAI", reason: "unknown cost" }, { asset: "USDC", reason: "balance couldn't be read" }] }), pnlStatus: "partial" }))
    assert.ok(attention?.details.includes("Couldn't read the USDC balance."), JSON.stringify(attention))
  })

  it("says why a partial value is partial", () => {
    const attention = attentionOf(facts({ positions: [position("AERO", { valueMicros: null }), position("USDC")], totals: totals({ unresolvedMicros: "1000000", coverage: { ...totals().coverage, value: { known: 1, missing: 1 } } }), pnlStatus: "partial" }))
    assert.equal(attention?.details[0], "The value leaves out AERO, which has no price right now.")
  })

  it("only calls an unchecked balance an estimate, since it's still in the value", () => {
    const attention = attentionOf(facts({ positions: [position("USDC", { status: "unchecked" })], totals: totals({ estimatedMicros: "1000000", coverage: { ...totals().coverage, value: { known: 1, missing: 1 } } }) }))
    assert.equal(attention?.details[0], "Couldn't check the balance of USDC, so its value is an estimate.")
  })

  it("moves what used to be separate notices into one place", () => {
    const attention = attentionOf(facts({ gasUnknownTxs: ["0x1"], l1FeeUnknownTxs: ["0x2", "0x3"], withheld: [{ wallet: "0x1234567890abcdef1234567890abcdef12345678", asset: "ETH" }], currency: "CAD", missingRateTxs: ["0x4"], hasCurrentRate: false, totals: totals({ unpricedGas: true }), pnlStatus: "partial" }))
    assert.equal(attention?.details.length, 5)
    assert.match(attention?.title ?? "", /no price at the time/)
    assert.ok(attention?.details.some((line) => line.startsWith("There's no current USD to CAD rate")))
  })

  it("mentions market estimates only when the sentence about estimates can't", () => {
    const attention = attentionOf(facts({ totals: totals({ estimated: { value: true, realized: false, unrealized: false } as Totals["estimated"] }) }))
    assert.equal(attention?.title, "Some prices are estimates, from the market.")
  })

  it("never leaves a partial PnL unsaid", () => {
    assert.equal(attentionOf(facts({ pnlStatus: "partial" }))?.title, "PnL isn't complete.")
  })
})

describe("pastCostsNote", () => {
  it("keeps a question reachable when everything it asks about has left and the totals are complete", () => {
    const received = DEMO_WALLET.legs.find((leg) => leg.asset === "USDC" && BigInt(leg.delta) > 0n)
    assert.ok(received)
    const sent = { ...received, id: `${received.id}-out`, delta: `-${received.delta}`, blockNum: received.blockNum + 1 }
    const wallet = { ...DEMO_WALLET, legs: [received, sent], balances: { blockNum: DEMO_WALLET.latest.blockNum, amounts: { USDC: "0" } } }
    const fold = foldBook(wallet, [], "average", emptyBook())
    const attention = attentionOf(facts({ positions: fold.positions, unread: fold.unread, totals: fold.totals, pnlStatus: fold.pnlStatus, withheld: fold.withheld }))
    assert.equal(fold.pnlStatus, "complete")
    assert.equal(attention, null)
    assert.equal(fold.questions.length, 1)
    assert.equal(pastCostsNote(attention, fold.questions.length), PAST_COSTS_UNKNOWN)
  })

  it("leaves the questions to the warning when there is one, and says nothing with none", () => {
    assert.equal(pastCostsNote({ title: "PnL isn't complete.", details: [], fullList: null }, 2), null)
    assert.equal(pastCostsNote(null, 0), null)
  })
})

describe("balanceFlag", () => {
  it("says a shortfall of the wallets together, not of one wallet", () => {
    assert.match(balanceFlag(position("USDC", { shortfallQty: "1" }))?.help ?? "", /left this wallet than we saw arrive, so its history/)
    assert.match(balanceFlag(position("USDC", { shortfallQty: "1" }), { combined: true })?.help ?? "", /left your wallets than we saw arrive, so their history/)
  })

  it("says nothing about a balance that matches", () => {
    assert.equal(balanceFlag(position("USDC")), null)
  })

  it("explains what doesn't match in its tooltip, and opens the check", () => {
    const flag = balanceFlag(position("cbBTC", { status: "incomplete" }))
    assert.equal(flag?.label, "Doesn't match")
    assert.equal(flag?.metric, "onchain")
    assert.match(flag?.help ?? "", /Worked out 1(\.0+)?, actual 3(\.0+)?, difference \+2(\.0+)? cbBTC\. PnL is unavailable\./)
  })

  it("says why a balance wasn't checked", () => {
    assert.match(balanceFlag(position("USDC", { status: "unchecked" }))?.help ?? "", /couldn't be read/)
  })

  it("opens the amount for an incomplete history, which only the amount explains", () => {
    assert.equal(balanceFlag(position("USDC", { shortfallQty: "1" }))?.metric, "amount")
  })
})

describe("attentionTarget", () => {
  it("goes to the balance that's the reason, or else to the total", () => {
    assert.deepEqual(attentionTarget([position("USDC"), position("AERO", { status: "incomplete" })]), { kind: "asset", asset: "AERO", metric: "onchain" })
    assert.deepEqual(attentionTarget([position("USDC")]), { kind: "total", metric: "pnl" })
    assert.deepEqual(attentionTarget([position("SPAM", { status: "incomplete", noMarket: true })]), { kind: "total", metric: "pnl" })
  })
})

describe("allBalancesMatch", () => {
  it("only says so when every listed balance was checked and matches", () => {
    assert.equal(allBalancesMatch([position("USDC")], []), ALL_BALANCES_MATCH)
    assert.equal(allBalancesMatch([position("USDC"), position("AERO", { status: "unchecked" })], []), null)
    assert.equal(allBalancesMatch([], []), null)
  })

  it("doesn't claim a balance that couldn't be read", () => {
    assert.equal(allBalancesMatch([position("DAI")], ["USDC"]), null)
  })
})

describe("holdSummarySentence", () => {
  const base = { walletEstimated: false, estimated: false, differenceMicros: null, holdMicros: null, unknownAmounts: 0 }
  it("says the comparison in a few words", () => {
    assert.equal(holdSummarySentence({ ...base, status: "unavailable" }, "USD"), "Not available yet")
    assert.equal(holdSummarySentence({ ...base, status: "partial", holdMicros: "12000000", unknownAmounts: 2 }, "USD"), "Partial: +$12.00 holding ETH, leaving out 2 amounts")
    assert.equal(holdSummarySentence({ ...base, status: "partial", holdMicros: "-12000000", unknownAmounts: 1, estimated: true }, "USD"), "Partial: about -$12.00 holding ETH, leaving out 1 amount")
    assert.equal(holdSummarySentence({ ...base, status: "partial", holdMicros: "12000000" }, "USD"), "Partial: +$12.00 holding ETH, and the total PnL leaves some things out")
    assert.equal(holdSummarySentence({ ...base, status: "complete", differenceMicros: "-5000000" }, "USD"), "$5.00 less than holding ETH.")
    assert.equal(holdSummarySentence({ ...base, status: "complete", differenceMicros: "5000000", estimated: true }, "USD"), "About $5.00 more than holding ETH.")
  })
})
