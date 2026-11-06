import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { after, before, describe, it } from "node:test"
import { ASSETS, ETH_ADDRESS, foldPositions, type LegPart, type LegRow, type PricedLeg } from "@pricetag/sdk/core"
import type { Source } from "@pricetag/sdk/internal"
import type { PortfolioResponse, TaxReportResponse, WalletResponse } from "../src/core/api.ts"
import { costKey, emptyBook, type Book } from "../src/core/book.ts"
import { DEMO_ADDRESS, DEMO_SAVINGS_ADDRESS, DEMO_WALLET, demoRates } from "../src/core/fixtures.ts"
import { foldBook } from "../src/core/resolve.ts"
import { TAX_COUNTRIES, parseTaxYear, readOtherWallets, savedOtherWallets, taxReportOf, taxRows, type TaxYear } from "../src/core/tax.ts"
import { createApi } from "../server/app.ts"

const E18 = 10n ** 18n
const A = `0x${"a".repeat(40)}`
const B = `0x${"b".repeat(40)}`
const usd = (amount: number) => (BigInt(amount) * 1_000_000n).toString()
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`

const leg = (block: number, delta: bigint, fields: Partial<PricedLeg> = {}): PricedLeg => ({
  id: `${hash(block)}:ETH`,
  asset: "ETH",
  decimals: 18,
  delta: delta.toString(),
  kind: "swap",
  priceMicros: usd(2000),
  priceSource: "oracle",
  priceNote: null,
  costMicros: null,
  proceedsMicros: null,
  costLabel: "unknown",
  blockNum: block,
  timestamp: new Date(Date.UTC(2026, 10, 4) + block * 2000).toISOString(),
  txHash: hash(block),
  txIndex: 0,
  parts: [],
  ...fields,
})
const buy = (block: number, units: bigint, paid: number) => leg(block, units * E18, { costMicros: usd(paid), costLabel: "paid" })
const sell = (block: number, units: bigint, received: number) => leg(block, -units * E18, { proceedsMicros: usd(received) })

/** A wallet whose balances match its legs, so a test about something else isn't also a test of a mismatch. */
function walletOf(address: string, legs: PricedLeg[], changes: Partial<WalletResponse> = {}): WalletResponse {
  const amounts: Record<string, string> = {}
  for (const l of legs) amounts[l.asset] = (BigInt(amounts[l.asset] ?? 0) + BigInt(l.delta)).toString()
  return {
    ...DEMO_WALLET,
    address,
    mode: "dataset",
    coverage: { fromBlock: 1, toBlock: 1000 },
    latest: { blockNum: 1000, timestamp: new Date(Date.UTC(2026, 10, 4) + 2_000_000).toISOString() },
    legs,
    balances: { blockNum: 1000, amounts },
    lastBalances: {},
    lastCheckableEth: null,
    unreadBalances: [],
    openingUnread: [],
    gasUnknownTxs: [],
    l1FeeUnknownTxs: [],
    currency: "USD",
    rates: null,
    ...changes,
  }
}

/** Enough of RFC 4180 to read back what's written. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ",") {
      row.push(cell)
      cell = ""
    } else if (c === "\r") {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ""
      i++
    } else cell += c
  }
  return rows
}

const cellsOf = (report: TaxReportResponse) => {
  const [header, ...rows] = parseCsv(report.csv) as [string[], ...string[][]]
  return rows.map((row) => Object.fromEntries(header.map((name, i) => [name, row[i]])) as Record<string, string>)
}
const eventsOf = (report: TaxReportResponse) => cellsOf(report).filter((row) => row.Type !== "Note")

describe("taxRows", () => {
  const legs = [buy(10, 1n, 1000), buy(20, 1n, 3000), sell(30, 1n, 2500)]

  it("works out each method's cost, and matches what the fold calls Realized", () => {
    const fifo = taxRows([walletOf(A, legs)], { method: "fifo", scope: "per-wallet" })
    assert.equal(fifo.length, 1)
    assert.deepEqual([fifo[0]?.proceedsMicros, fifo[0]?.costMicros, fifo[0]?.gainMicros, fifo[0]?.status], [usd(2500), usd(1000), usd(1500), "resolved"])
    const average = taxRows([walletOf(A, legs)], { method: "average", scope: "per-wallet" })
    assert.deepEqual([average[0]?.costMicros, average[0]?.gainMicros], [usd(2000), usd(500)])
    for (const method of ["fifo", "average"] as const) {
      const rows = taxRows([walletOf(A, legs)], { method, scope: "per-wallet" })
      const realized = foldPositions(legs, method, {})[0]?.state.realizedMicros
      assert.equal(rows.reduce((sum, row) => sum + BigInt(row.gainMicros as string), 0n).toString(), realized)
    }
  })

  it("splits a sale that's part known and part unknown, so the known part still adds up", () => {
    const wallet = walletOf(A, [leg(5, E18), buy(10, 1n, 1000), sell(30, 2n, 5000)])
    const rows = taxRows([wallet], { method: "fifo", scope: "per-wallet" })
    assert.deepEqual(
      rows.map((row) => [row.amount, row.proceedsMicros, row.costMicros, row.gainMicros, row.status]),
      [
        [E18.toString(), usd(2500), usd(1000), usd(1500), "resolved"],
        [E18.toString(), usd(2500), null, null, "unresolved"],
      ],
    )
  })

  it("never shows a gain when proceeds or cost are unknown", () => {
    const unpriced = leg(30, -E18)
    const [noProceeds] = taxRows([walletOf(A, [buy(10, 1n, 1000), unpriced])], { method: "fifo", scope: "per-wallet" })
    assert.deepEqual([noProceeds?.proceedsMicros, noProceeds?.costMicros, noProceeds?.gainMicros, noProceeds?.status], [null, usd(1000), null, "unresolved"])
    const [noCost] = taxRows([walletOf(A, [leg(10, E18), sell(30, 1n, 2000)])], { method: "average", scope: "per-wallet" })
    assert.deepEqual([noCost?.proceedsMicros, noCost?.costMicros, noCost?.gainMicros, noCost?.status], [usd(2000), null, null, "unresolved"])
  })

  it("lists a fee as a sale of the ETH that paid it", () => {
    const rows = taxRows([walletOf(A, [buy(10, 2n, 2000), leg(30, -E18, { kind: "gas" })])], { method: "fifo", scope: "per-wallet" })
    assert.deepEqual([rows[0]?.type, rows[0]?.proceedsMicros, rows[0]?.costMicros, rows[0]?.gainMicros], ["Network fee", usd(2000), usd(1000), usd(1000)])
  })

  it("flags what was sent, because it might be a gift or a payment", () => {
    const [row] = taxRows([walletOf(A, [buy(10, 1n, 1000), leg(30, -E18, { kind: "transfer" })])], { method: "fifo", scope: "per-wallet" })
    assert.deepEqual([row?.type, row?.costMicros, row?.gainMicros, row?.status], ["Sent", usd(1000), null, "unresolved"])
  })

  it("takes the cost away from an asset the chain doesn't confirm, and keeps what it sold for", () => {
    const wallet = walletOf(A, [buy(10, 2n, 2000), sell(30, 1n, 3000)], { balances: { blockNum: 1000, amounts: { ETH: (5n * E18).toString() } } })
    const [row] = taxRows([wallet], { method: "fifo", scope: "per-wallet" })
    assert.deepEqual([row?.proceedsMicros, row?.costMicros, row?.gainMicros, row?.status], [usd(3000), null, null, "unresolved"])
    assert.match(row?.reason ?? "", /doesn't match/)
  })

  it("marks a cost that came from an estimate", () => {
    const wallet = walletOf(A, [leg(10, E18, { costMicros: usd(1000), costLabel: "received at market" }), sell(30, 1n, 2000)])
    const [row] = taxRows([wallet], { method: "fifo", scope: "per-wallet" })
    assert.deepEqual([row?.status, row?.gainMicros], ["estimated", usd(1000)])
  })

  it("marks a trade valued from the market as estimated, in what was paid and what was received", () => {
    // 100 AERO bought for $100, traded for 100 VIRTUAL worth an estimated $100, then sold for $150.
    const legs = [
      leg(10, 100n * E18, { asset: "AERO", id: "a", costMicros: usd(100), costLabel: "paid" }),
      leg(20, -100n * E18, { asset: "AERO", id: "b", proceedsMicros: usd(100), estimated: true }),
      leg(20, 100n * E18, { asset: "VIRTUAL", id: "c", kind: "swap", costMicros: usd(100), costLabel: "paid", estimated: true }),
      leg(30, -100n * E18, { asset: "VIRTUAL", id: "d", proceedsMicros: usd(150) }),
    ]
    const rows = taxRows([walletOf(A, legs, { balances: { blockNum: 1000, amounts: { AERO: "0", VIRTUAL: "0" } } })], { method: "fifo", scope: "per-wallet" })
    assert.deepEqual(rows.map((row) => [row.asset, row.status, row.gainMicros]), [["AERO", "estimated", usd(0)], ["VIRTUAL", "estimated", usd(50)]])
    assert.match(rows[0]?.reason ?? "", /^What it sold for is an estimate/, "AERO was really paid for, and only what it fetched is estimated")
    assert.match(rows[1]?.reason ?? "", /^Part of its cost is an estimate/, "VIRTUAL really sold for $150, and only what it cost is estimated")
  })

  it("says which side of a sale is the estimate", () => {
    const reason = (legs: PricedLeg[]) => taxRows([walletOf(A, legs, { balances: { blockNum: 1000, amounts: { ETH: "0" } } })], { method: "fifo", scope: "per-wallet" })[0]?.reason
    assert.equal(reason([buy(10, 1n, 1000), sell(30, 1n, 1500)]), null, "neither")
    assert.match(reason([buy(10, 1n, 1000), leg(30, -E18, { proceedsMicros: usd(1500), estimated: true })]) ?? "", /^What it sold for is an estimate/)
    assert.match(reason([leg(10, E18, { costMicros: usd(1000), costLabel: "received at market" }), sell(30, 1n, 1500)]) ?? "", /^Part of its cost is an estimate/)
    assert.match(reason([leg(10, E18, { costMicros: usd(1000), costLabel: "received at market" }), leg(30, -E18, { proceedsMicros: usd(1500), estimated: true })]) ?? "", /^What it sold for and part of its cost are estimates/)
  })

  it("doesn't call a real cost estimated because it was mixed with another real one", () => {
    const legs = [buy(10, 1n, 1000), leg(20, E18, { costMicros: usd(1000), costLabel: "self-reported" }), sell(30, 1n, 2000)]
    const [row] = taxRows([walletOf(A, legs, { balances: { blockNum: 1000, amounts: { ETH: E18.toString() } } })], { method: "average", scope: "per-wallet" })
    assert.equal(row?.status, "self-reported", "someone entered part of it, and the file says so")
    const [plain] = taxRows([walletOf(A, [buy(10, 1n, 1000), buy(20, 1n, 1000), sell(30, 1n, 2000)], { balances: { blockNum: 1000, amounts: { ETH: E18.toString() } } })], { method: "average", scope: "per-wallet" })
    assert.equal(plain?.status, "resolved")
  })

  describe("across wallets", () => {
    // A buys, moves it to B, and B sells.
    const move = 20
    const a = walletOf(A, [buy(10, 1n, 1000), leg(move, -E18, { kind: "transfer" })])
    const b = walletOf(B, [leg(move, E18, { kind: "transfer" }), sell(30, 1n, 2500)])

    it("pooled, ETH found from a balance and named after the move's transaction doesn't stop it being a move", () => {
      const found = leg(move, E18 / 10n, { id: `unseen:${move}:ETH`, kind: "transfer", parts: [{ token: "0x0", account: B, side: "credit", amount: (E18 / 10n).toString(), kind: "unseen_eth", logIndex: 0 }] })
      const withFound = walletOf(B, [found, leg(move, E18, { kind: "transfer" }), sell(30, 1n, 2500)])
      const rows = taxRows([a, withFound], { method: "average", scope: "pooled" })
      assert.ok(!rows.some((row) => row.type === "Sent"))
      assert.ok(rows.every((row) => row.costMicros !== usd(0)))
    })

    it("pooled, a move between them isn't a sale, and the cost goes along", () => {
      const rows = taxRows([a, b], { method: "average", scope: "pooled" })
      assert.deepEqual(
        rows.map((row) => [row.type, row.costMicros, row.gainMicros, row.wallet]),
        [["Sold", usd(1000), usd(1500), B]],
      )
    })

    it("per wallet, the move still isn't a sale, and a cost that can't be traced stays unknown", () => {
      const rows = taxRows([a, b], { method: "fifo", scope: "per-wallet" })
      assert.deepEqual(
        rows.map((row) => [row.type, row.costMicros, row.gainMicros, row.status, row.wallet]),
        [["Sold", null, null, "unresolved", B]],
      )
    })

    it("without the other wallet, the same move stays flagged", () => {
      const rows = taxRows([a], { method: "average", scope: "pooled" })
      assert.deepEqual(rows.map((row) => row.status), ["unresolved"])
    })

    it("a move that lost some on the way isn't treated as one", () => {
      const short = walletOf(B, [leg(move, E18 / 2n, { kind: "transfer" })])
      assert.deepEqual(taxRows([a, short], { method: "average", scope: "pooled" }).map((row) => row.type), ["Sent"])
    })

    it("one wallet can't confirm an asset, so the pool can't give it a cost", () => {
      const off = walletOf(B, b.legs, { balances: { blockNum: 1000, amounts: { ETH: E18.toString() } } })
      const [row] = taxRows([a, off], { method: "average", scope: "pooled" })
      assert.deepEqual([row?.costMicros, row?.gainMicros, row?.status], [null, null, "unresolved"])
    })

    describe("read up to different blocks", () => {
      // A's buy at 102 is past where A was read. B's sale at 105 would take A's older, cheaper buy instead of the right average.
      const buys = [buy(10, 1n, 1000), buy(102, 1n, 5000)]
      const seller = [buy(20, 1n, 3000), sell(105, 1n, 4000)]
      const behind = walletOf(A, buys.slice(0, 1), { coverage: { fromBlock: 1, toBlock: 100 }, balances: { blockNum: 100, amounts: { ETH: E18.toString() } } })
      const ahead = walletOf(B, seller, { coverage: { fromBlock: 1, toBlock: 110 }, balances: { blockNum: 110, amounts: { ETH: "0" } } })

      it("pooled, stops at the last block they've all reached, rather than show a wrong gain as known", () => {
        const report = taxReportOf([behind, ahead], { country: "CA", method: "average", scope: "pooled" })
        assert.equal(report.rowCount, 0)
        assert.equal(report.gainMicros, null)
        assert.ok(report.warnings.some((warning) => /stops at block 100.*1 newer transaction isn't here/.test(warning)))
      })

      it("pooled, gives the right gain once they've caught up", () => {
        const caughtUp = walletOf(A, buys, { coverage: { fromBlock: 1, toBlock: 110 }, balances: { blockNum: 110, amounts: { ETH: (2n * E18).toString() } } })
        const rows = taxRows([caughtUp, ahead], { method: "average", scope: "pooled" })
        // 1,000 + 3,000 + 5,000 over 3 is 3,000 each, for a gain of 1,000.
        assert.deepEqual(rows.map((row) => [row.costMicros, row.gainMicros, row.status]), [[usd(3000), usd(1000), "resolved"]])
        const report = taxReportOf([caughtUp, ahead], { country: "CA", method: "average", scope: "pooled" })
        assert.ok(!report.warnings.some((warning) => /stops at block/.test(warning)))
      })

      it("a move between them is only left out once both sides are in", () => {
        const from = walletOf(A, [buy(10, 1n, 1000), leg(105, -E18, { kind: "transfer" })], { coverage: { fromBlock: 1, toBlock: 110 }, balances: { blockNum: 110, amounts: { ETH: "0" } } })
        const to = walletOf(B, [], { coverage: { fromBlock: 1, toBlock: 100 }, balances: { blockNum: 100, amounts: { ETH: "0" } } })
        assert.deepEqual(taxRows([from, to], { method: "average", scope: "pooled" }), [])
      })

      it("per wallet, each keeps everything it has, because one's cost doesn't depend on another", () => {
        const rows = taxRows([behind, ahead], { method: "fifo", scope: "per-wallet" })
        assert.deepEqual(rows.map((row) => [row.blockNum, row.costMicros, row.gainMicros, row.wallet]), [[105, usd(3000), usd(1000), B]])
      })
    })

    describe("with histories that start at different blocks", () => {
      const late = walletOf(A, [leg(49, E18, { opening: true, txHash: "", txIndex: -1, kind: "transfer" })], { coverage: { fromBlock: 50, toBlock: 100 }, balances: { blockNum: 100, amounts: { ETH: E18.toString() } } })
      const early = walletOf(B, [buy(10, 1n, 1000), sell(60, 1n, 2000)], { coverage: { fromBlock: 1, toBlock: 100 }, balances: { blockNum: 100, amounts: { ETH: "0" } } })

      it("pooled, keeps every cost and gain unknown, and says why", () => {
        const report = taxReportOf([late, early], { country: "CA", method: "average", scope: "pooled" })
        const [row] = eventsOf(report)
        assert.deepEqual([row?.Proceeds, row?.Cost, row?.Gain, row?.Status], ["2000.000000", "unknown", "unknown", "UNKNOWN GAIN"])
        assert.match(row?.Notes ?? "", /start at different blocks/)
        assert.equal(report.gainMicros, null)
        assert.ok(report.warnings.some((warning) => /start at different blocks/.test(warning)))
      })

      it("per wallet, doesn't mind", () => {
        const rows = taxRows([late, early], { method: "fifo", scope: "per-wallet" })
        assert.deepEqual(rows.map((row) => [row.gainMicros, row.status]), [[usd(1000), "resolved"]])
      })
    })

    it("pooled, an asset one wallet couldn't read at its start has no cost, even if that wallet never moved it", () => {
      const unread = walletOf(A, [], { openingUnread: ["ETH"], balances: { blockNum: 1000, amounts: {} } })
      const seller = walletOf(B, [buy(10, 1n, 1000), sell(30, 1n, 2000)])
      const [row] = taxRows([unread, seller], { method: "average", scope: "pooled" })
      assert.deepEqual([row?.costMicros, row?.gainMicros, row?.status], [null, null, "unresolved"])
    })

    it("pooled keeps sales in order across wallets", () => {
      const first = walletOf(A, [buy(10, 1n, 1000), sell(40, 1n, 2000)])
      const second = walletOf(B, [buy(20, 1n, 3000), sell(30, 1n, 2000)])
      const rows = taxRows([first, second], { method: "fifo", scope: "pooled" })
      // Oldest first across both, so B's sale at block 30 takes A's lot from block 10.
      assert.deepEqual(rows.map((row) => [row.blockNum, row.costMicros]), [[30, usd(1000)], [40, usd(3000)]])
    })
  })

  it("gives one wallet the same rows either way", () => {
    const wallet = walletOf(A, [buy(10, 1n, 1000), sell(30, 1n, 2000), leg(40, -1n, { kind: "transfer" })])
    assert.deepEqual(taxRows([wallet], { method: "fifo", scope: "pooled" }), taxRows([wallet], { method: "fifo", scope: "per-wallet" }))
  })
})

describe("readOtherWallets", () => {
  it("reads several however they're separated, and finds the first typo", () => {
    const upper = `0x${"A".repeat(40)}`
    assert.deepEqual(readOtherWallets(`${upper}\n ${B}, `, A), { others: [A, B], bad: null })
    assert.equal(readOtherWallets(`${B}\n0xnope`, A).bad, "0xnope")
  })

  it("ignores what's saved on the demo wallet, where the field for fixing it isn't shown", () => {
    assert.deepEqual(readOtherWallets(`0xnope\n${B}`, "demo"), { others: [], bad: null })
  })
})

describe("savedOtherWallets", () => {
  it("keeps only the addresses, once each", () => {
    const upper = `0x${"A".repeat(40)}`
    assert.equal(savedOtherWallets(`${upper}\n ${B}, ${A}`), `${A}\n${B}`)
  })

  it("keeps nothing of what isn't an address", () => {
    assert.equal(savedOtherWallets("some words pasted by mistake"), "")
    assert.equal(savedOtherWallets(`0x${"a".repeat(64)}`), "")
    assert.equal(savedOtherWallets(`words ${B} 0x${B.slice(2, 10)}`), B)
    assert.equal(savedOtherWallets(""), "")
  })
})

describe("taxReportOf", () => {
  const wallet = walletOf(A, [buy(10, 1n, 1000), sell(30, 1n, 2000)])
  const cad = (changes: Partial<WalletResponse> = {}) => ({ ...wallet, currency: "CAD" as const, ...changes })

  it("has every column on every row, starting with what it isn't", () => {
    const report = taxReportOf([DEMO_WALLET], { country: "US", method: "fifo", scope: "per-wallet" })
    const rows = parseCsv(report.csv)
    assert.ok(rows.every((row) => row.length === rows[0]?.length))
    assert.deepEqual(rows[0], ["Date (UTC)", "Type", "Asset", "Amount", "Proceeds", "Cost", "Gain", "Currency", "Method", "Calculation", "Price source", "Status", "Notes", "Wallet", "Transaction"])
    assert.match(cellsOf(report)[0]?.Notes ?? "", /^Not tax advice/)
    assert.equal(eventsOf(report).length, report.rowCount)
  })

  it("writes unknown where there's a gap, and never 0", () => {
    const report = taxReportOf([DEMO_WALLET], { country: "US", method: "fifo", scope: "per-wallet" })
    const unresolved = eventsOf(report).filter((row) => row.Status === "UNKNOWN GAIN")
    assert.equal(unresolved.length, report.unresolvedCount)
    assert.ok(report.unresolvedCount > 0)
    for (const row of unresolved) {
      assert.equal(row.Gain, "unknown")
      assert.notEqual(row.Notes, "")
    }
    assert.match(report.warnings[0] ?? "", /unknown gain/)
  })

  it("adds up only the rows it knows", () => {
    const report = taxReportOf([walletOf(A, [buy(10, 1n, 1000), sell(20, 1n, 2000), leg(30, E18), sell(40, 1n, 2000)])], { country: "US", method: "fifo", scope: "per-wallet" })
    assert.deepEqual([report.gainMicros, report.unresolvedCount], [usd(1000), 1])
    const nothing = taxReportOf([walletOf(A, [leg(30, E18), sell(40, 1n, 2000)])], { country: "US", method: "fifo", scope: "per-wallet" })
    assert.equal(nothing.gainMicros, null)
  })

  it("prints exact amounts, with no symbols or separators", () => {
    const report = taxReportOf([walletOf(A, [buy(10, 2n, 1000), leg(30, -(E18 + 1n), { proceedsMicros: "2000000001" })])], { country: "US", method: "fifo", scope: "per-wallet" })
    const [row] = eventsOf(report)
    assert.equal(row?.Amount, "1.000000000000000001")
    assert.equal(row?.Proceeds, "2000.000001")
    assert.equal(row?.["Date (UTC)"], "2026-11-04 00:01:00")
    assert.equal(row?.Transaction, `https://basescan.org/tx/${hash(30)}`)
  })

  it("says nothing extra on a country's own defaults, and warns on an override", () => {
    const quiet = taxReportOf([wallet], { country: "US", method: "fifo", scope: "per-wallet" })
    assert.deepEqual(quiet.warnings, [])
    const us = taxReportOf([wallet], { country: "US", method: "average", scope: "pooled" })
    assert.ok(us.warnings.includes(TAX_COUNTRIES.US.methodWarning))
    assert.ok(us.warnings.includes(TAX_COUNTRIES.US.scopeWarning))
    const ca = taxReportOf([cad({ rates: demoRates("CAD") })], { country: "CA", method: "fifo", scope: "per-wallet" })
    assert.ok(ca.warnings.includes(TAX_COUNTRIES.CA.methodWarning))
    assert.ok(ca.warnings.includes(TAX_COUNTRIES.CA.scopeWarning))
  })

  it("says so when the currency isn't the country's", () => {
    const report = taxReportOf([wallet], { country: "CA", method: "average", scope: "pooled" })
    assert.ok(report.warnings.some((warning) => /Canada reports in CAD/.test(warning)))
  })

  it("says first that its rules may not apply in a currency neither country reports in, and doesn't suggest switching to one", () => {
    for (const country of ["CA", "US"] as const) {
      const report = taxReportOf([{ ...wallet, currency: "EUR", rates: demoRates("EUR") }], { country, method: TAX_COUNTRIES[country].method, scope: TAX_COUNTRIES[country].scope })
      assert.equal(report.currency, "EUR")
      assert.match(report.warnings[0] ?? "", /only knows Canada and the US, and neither reports in EUR\. If you report in EUR, these rules and this layout may not apply/)
      assert.ok(!report.warnings.some((warning) => /Change your main currency/.test(warning)))
    }
  })

  it("converts at each transaction's rate, and a missing rate is unknown rather than guessed", () => {
    // USD for one CAD, with 8 decimals: 0.50 at the buy and 0.25 at the sale.
    const round = (answer: string, block: number) => ({ answer, updatedAt: Date.parse(leg(block, 0n).timestamp) / 1000 })
    const rates = { byBlock: { 10: round("50000000", 10), 30: round("25000000", 30) }, latest: { blockNum: 1000, round: round("25000000", 30) } }
    const [row] = eventsOf(taxReportOf([cad({ rates })], { country: "CA", method: "average", scope: "pooled" }))
    assert.deepEqual([row?.Proceeds, row?.Cost, row?.Gain, row?.Currency], ["8000.000000", "2000.000000", "6000.000000", "CAD"])

    const missing = taxReportOf([cad({ rates: { byBlock: { 10: round("50000000", 10) }, latest: rates.latest } })], { country: "CA", method: "average", scope: "pooled" })
    const [gap] = eventsOf(missing)
    assert.deepEqual([gap?.Proceeds, gap?.Gain, gap?.Status], ["unknown", "unknown", "UNKNOWN GAIN"])
    assert.match(gap?.Notes ?? "", /no exchange rate/)
    assert.ok(missing.warnings.some((warning) => /no exchange rate/.test(warning)))
  })

  it("warns about moves whose cost couldn't be carried over", () => {
    const a = walletOf(A, [buy(10, 1n, 1000), leg(20, -E18, { kind: "transfer" })])
    const b = walletOf(B, [leg(20, E18, { kind: "transfer" })])
    const report = taxReportOf([a, b], { country: "US", method: "fifo", scope: "per-wallet" })
    assert.ok(report.warnings.some((warning) => /no known cost to carry over/.test(warning)))
    assert.equal(report.rowCount, 0)
    assert.equal(report.gainMicros, null)
  })

  describe("a year", () => {
    // History from August 2025: a buy in December 2025 and a sale in March 2026.
    const head = 20_000_000
    const spanning = walletOf(A, [buy(10, 1n, 1000), sell(30, 1n, 2000)].map((l, i) => ({ ...l, timestamp: ["2025-12-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"][i] as string })), {
      coverage: { fromBlock: 1, toBlock: head },
      latest: { blockNum: head, timestamp: "2026-11-27T00:00:00.000Z" },
    })
    const report = (year: TaxYear) => taxReportOf([spanning], { country: "US", method: "fifo", scope: "per-wallet", year })

    it("lists only that year, with costs from the years before it", () => {
      const year = report(2026)
      assert.deepEqual([year.year, year.years, year.rowCount, year.gainMicros, year.partialYear], [2026, [2026, 2025], 1, usd(1000), null])
      assert.equal(eventsOf(year).length, 1)
      assert.match(year.filename, /-2026-US-/)
      const before = report(2025)
      assert.deepEqual([before.rowCount, before.gainMicros, before.preview], [0, null, []])
    })

    it("says when a year's history isn't all there", () => {
      assert.match(report(2025).partialYear ?? "", /^Records start on August \d+, 2025, so 2025 is missing everything before then\.$/)
      assert.equal(report(2025).warnings[0], report(2025).partialYear)
      assert.match(report(2024).partialYear ?? "", /so nothing from 2024 is here/)
      const recent = taxReportOf([wallet], { country: "US", method: "fifo", scope: "per-wallet", year: "latest" })
      assert.deepEqual([recent.year, recent.partialYear], [2026, "Records start on November 4, 2026, so 2026 is missing everything before then."])
    })

    it("is everything without one, as before", () => {
      const all = report("all")
      assert.deepEqual([all.year, all.partialYear, all.rowCount], [null, null, 1])
      assert.equal(taxReportOf([spanning], { country: "US", method: "fifo", scope: "per-wallet" }).csv, all.csv)
    })

    it("reads what's asked for", () => {
      assert.deepEqual([parseTaxYear(undefined), parseTaxYear("all"), parseTaxYear("latest"), parseTaxYear("2026"), parseTaxYear(2025)], ["all", "all", "latest", 2026, 2025])
      for (const bad of ["26", "nope", 1999, 2026.5, "2026a"]) assert.equal(parseTaxYear(bad), null, String(bad))
    })
  })

  it("counts what happened once, even when the file splits it into a known and an unknown part", () => {
    const gas = (block: number, units: bigint) => leg(block, -units, { kind: "gas" })
    // Oldest first: a fee from the known ETH, a sale of the known half and the unknown half, then a fee from both.
    const half = E18 / 2n
    const legs = [buy(10, 1n, 1000), leg(20, E18), gas(25, half), sell(30, 1n, 2000), buy(35, 1n, 2000), gas(40, E18)]
    const report = taxReportOf([walletOf(A, legs)], { country: "US", method: "fifo", scope: "per-wallet" })
    assert.deepEqual(eventsOf(report).map((row) => [row.Type, row.Status]), [
      ["Network fee", "OK"],
      ["Sold", "OK"],
      ["Sold", "UNKNOWN GAIN"],
      ["Network fee", "OK"],
      ["Network fee", "UNKNOWN GAIN"],
    ])
    assert.deepEqual([report.soldCount, report.feeCount, report.sentCount, report.unknownCount], [1, 2, 0, 2])
    assert.deepEqual([report.rowCount, report.unresolvedCount], [5, 2], "The file's own counts are still by row")
    // $500 on the first fee, $500 on the known half of the sale, and $0 on the known half of the last fee.
    assert.equal(report.gainMicros, usd(1000), "Known parts are in the total")
  })

  it("names the wallets with something unknown, even when only an added one has it", () => {
    const known = walletOf(A, [buy(10, 1n, 1000), sell(20, 1n, 2000)])
    const unknown = walletOf(B, [leg(30, E18), sell(40, 1n, 2000)])
    const report = taxReportOf([known, unknown], { country: "US", method: "fifo", scope: "per-wallet" })
    assert.deepEqual([report.unknownCount, report.unknownWallets], [1, [B]])
    // Answering that wallet's question is what the button leads to, and the report picks it up.
    const book: Book = { ...emptyBook(), costs: { [costKey(B, `${hash(30)}:ETH`)]: { micros: usd(1500), currency: "USD" } } }
    const answered = taxReportOf([known, unknown], { country: "US", method: "fifo", scope: "per-wallet" }, { book })
    assert.deepEqual([answered.unknownCount, answered.unknownWallets, answered.gainMicros], [0, [], usd(1500)])
    assert.deepEqual(taxReportOf([known], { country: "US", method: "fifo", scope: "per-wallet" }).unknownWallets, [])
  })

  it("names a wallet whose unknown cost is part of another wallet's sale", () => {
    // Pooled: B's ETH, of unknown cost, averages into what A's sale cost, and only B has a question about it.
    const a = walletOf(A, [buy(10, 1n, 1000), sell(30, 1n, 2000)])
    const b = walletOf(B, [leg(20, E18)])
    const ca = { country: "CA", method: "average", scope: "pooled" } as const
    const report = taxReportOf([a, b], ca)
    assert.deepEqual([report.unknownCount, report.unknownWallets], [1, [A, B]])
    const book: Book = { ...emptyBook(), costs: { [costKey(B, `${hash(20)}:ETH`)]: { micros: usd(1500), currency: "USD" } } }
    const answered = taxReportOf([a, b], ca, { book })
    assert.deepEqual([answered.unknownCount, answered.unknownWallets, answered.gainMicros], [0, [], usd(750)])
  })

  it("previews the file's first rows", () => {
    const report = taxReportOf([DEMO_WALLET], { country: "US", method: "fifo", scope: "per-wallet" })
    assert.equal(report.preview.length, Math.min(5, report.rowCount))
    assert.deepEqual(report.preview.map((row) => row.type), eventsOf(report).slice(0, 5).map((row) => row.Type))
    assert.deepEqual(report.unknownWallets, [DEMO_WALLET.address.toLowerCase()])
  })

  it("keeps the words people read plain", () => {
    const JARGON = /\b(legs?|oracle|FIFO|traces?|rebas\w*|L1|L2|allowlist)\b/i
    for (const report of [taxReportOf([DEMO_WALLET], { country: "US", method: "average", scope: "pooled" }), taxReportOf([{ ...DEMO_WALLET, currency: "CAD", rates: demoRates("CAD") }], { country: "CA", method: "fifo", scope: "per-wallet" })]) {
      assert.doesNotMatch(report.csv.replace(/https:\S+/g, ""), JARGON)
      assert.doesNotMatch([...report.warnings, ...report.notes].join(" "), JARGON)
    }
  })

  it("matches what the Swift tests read", () => {
    const url = new URL("../macos/PricetagKit/Tests/PricetagKitTests/Resources/demo-tax-report.json", import.meta.url)
    // The newest year, as the app asks for it.
    const text = `${JSON.stringify(taxReportOf([{ ...DEMO_WALLET, currency: "CAD", rates: demoRates("CAD") }], { country: "CA", method: "average", scope: "pooled", year: "latest" }), null, 2)}\n`
    if (process.env.UPDATE_FIXTURES) writeFileSync(url, text)
    assert.equal(readFileSync(url, "utf8"), text, "demo-tax-report.json is out of date. Run with UPDATE_FIXTURES=1 if the change is on purpose.")
  })
})

describe("the user's answers in a report", () => {
  // Where a transfer came from or went to, which is what lets the answers apply to it.
  const part = (account: string, side: "credit" | "debit", amount: bigint, counterparty: string): LegPart => ({ logIndex: 0, token: ETH_ADDRESS, account, side, amount: amount.toString(), kind: "eth", counterparty })
  const arrived = (block: number, from: string, to = A) => leg(block, E18, { kind: "transfer", parts: [part(to, "credit", E18, from)] })
  const sent = (block: number, to: string, from = A) => leg(block, -E18, { kind: "transfer", parts: [part(from, "debit", E18, to)] })
  const held = (legs: PricedLeg[]) => walletOf(A, legs)
  const US = { country: "US", method: "fifo", scope: "per-wallet" } as const
  const CA = { country: "CA", method: "average", scope: "pooled" } as const
  const answering = (senders: Book["senders"], costs: Book["costs"] = {}): Book => ({ ...emptyBook(), senders, costs })
  const SELLER = `0x${"5".repeat(40)}`

  describe("a cost entered in the app", () => {
    const wallet = held([arrived(10, SELLER), sell(30, 1n, 2500)])
    const book = answering({}, { [costKey(A, wallet.legs[0]?.id as string)]: { micros: usd(1000), currency: "USD" } })

    it("fills in what would be unknown, and is marked as the user's word", () => {
      assert.equal(eventsOf(taxReportOf([wallet], US))[0]?.Status, "UNKNOWN GAIN")
      const report = taxReportOf([wallet], US, { book })
      const [row] = eventsOf(report)
      assert.deepEqual([row?.Cost, row?.Gain, row?.Status], ["1000.000000", "1500.000000", "SELF-REPORTED"])
      assert.match(row?.Notes ?? "", /what you entered or imported/)
      assert.deepEqual([report.selfReportedCount, report.gainMicros], [1, usd(1500)])
      assert.ok(report.warnings.some((warning) => /1 row of 1 uses a cost you entered/.test(warning)))
    })

    it("says the same as the screen", () => {
      const { positions } = foldBook(wallet, [], "fifo", book)
      assert.equal(positions[0]?.values.realizedMicros, taxReportOf([wallet], US, { book }).gainMicros)
    })

    it("is converted at the rate when it arrived, and a missing rate leaves it unknown", () => {
      const round = (answer: string, block: number) => ({ answer, updatedAt: Date.parse(leg(block, 0n).timestamp) / 1000 })
      const rates = { byBlock: { 10: round("50000000", 10), 30: round("50000000", 30) }, latest: { blockNum: 1000, round: round("50000000", 30) } }
      const [row] = eventsOf(taxReportOf([{ ...wallet, currency: "CAD", rates }], CA, { book }))
      assert.deepEqual([row?.Cost, row?.Status], ["2000.000000", "SELF-REPORTED"])
      const [gap] = eventsOf(taxReportOf([{ ...wallet, currency: "CAD", rates: { byBlock: { 30: round("50000000", 30) }, latest: rates.latest } }], CA, { book }))
      assert.deepEqual([gap?.Cost, gap?.Status], ["unknown", "UNKNOWN GAIN"])
    })

    it("only marks the row that used it", () => {
      const both = held([buy(5, 1n, 1000), arrived(10, SELLER), sell(30, 1n, 2500), sell(40, 1n, 2500)])
      const rows = eventsOf(taxReportOf([both], US, { book: answering({}, { [costKey(A, both.legs[1]?.id as string)]: { micros: usd(1000), currency: "USD" } }) }))
      assert.deepEqual(rows.map((row) => row.Status), ["OK", "SELF-REPORTED"])
    })
  })

  it("uses what was imported from an exchange, and marks it", () => {
    const wallet = held([arrived(10, SELLER), sell(30, 1n, 2500)])
    const at = wallet.legs[0]?.timestamp as string
    const book: Book = { ...emptyBook(), withdrawals: [{ exchange: "Coinbase", asset: "ETH", units: E18.toString(), at, cost: { micros: usd(1200), currency: "USD" }, toAddress: A }] }
    const [row] = eventsOf(taxReportOf([wallet], US, { book }))
    assert.deepEqual([row?.Cost, row?.Status], ["1200.000000", "SELF-REPORTED"])
  })

  it("uses a cost entered for an exchange account, and marks it", () => {
    const wallet = held([arrived(10, SELLER), sell(30, 1n, 2500)])
    const receipts = [{ wallet: A, legId: wallet.legs[0]?.id as string, asset: "ETH", units: E18.toString() }]
    const [row] = eventsOf(taxReportOf([wallet], US, { book: answering({ [SELLER]: { kind: "my-exchange", costs: [{ asset: "ETH", micros: usd(900), currency: "USD", receipts }] } }) }))
    assert.deepEqual([row?.Cost, row?.Status], ["900.000000", "SELF-REPORTED"])
  })

  it("uses what was noted onchain, even with no answers", () => {
    const wallet = held([arrived(10, SELLER), sell(30, 1n, 2500)])
    const [row] = eventsOf(taxReportOf([{ ...wallet, notes: [{ noteTx: hash(99), blockNum: 11, txHash: hash(10), asset: "ETH", usdMicros: usd(700) }] }], US))
    assert.deepEqual([row?.Cost, row?.Status], ["700.000000", "SELF-REPORTED"])
  })

  describe("a market price from when it arrived", () => {
    const wallet = held([arrived(10, SELLER), sell(30, 1n, 2500)])
    const book = answering({ [SELLER]: { kind: "someone-else" } })

    it("is the cost in Canada, and the row says where it came from", () => {
      const report = taxReportOf([wallet], CA, { book })
      const [row] = eventsOf(report)
      assert.deepEqual([row?.Cost, row?.Gain, row?.Status], ["2000.000000", "500.000000", "OK"])
      assert.match(row?.Notes ?? "", /worth when it arrived/)
      assert.equal(report.estimatedCount, 0)
      assert.ok(report.warnings.some((warning) => warning.includes(TAX_COUNTRIES.CA.marketWarning)))
    })

    it("stays an estimate in the US, because a gift's cost is the giver's", () => {
      const report = taxReportOf([wallet], US, { book })
      const [row] = eventsOf(report)
      assert.deepEqual([row?.Cost, row?.Status], ["2000.000000", "ESTIMATED"])
      assert.match(row?.Notes ?? "", /^Part of its cost is an estimate.*giver's/)
      assert.equal(report.estimatedCount, 1)
      assert.ok(report.warnings.some((warning) => warning.includes(TAX_COUNTRIES.US.marketWarning)))
    })

    it("is what the user said it was, so nothing says it might be theirs", () => {
      assert.ok(!Object.values(TAX_COUNTRIES).some((country) => /moved from elsewhere/.test(country.marketWarning + country.marketRowNote)))
    })

    it("in Canada, doesn't excuse a different estimate on the same row", () => {
      const legs = [arrived(10, SELLER), leg(30, -E18, { proceedsMicros: usd(2500), estimated: true })]
      const [row] = eventsOf(taxReportOf([held(legs)], CA, { book }))
      assert.equal(row?.Status, "ESTIMATED")
      assert.match(row?.Notes ?? "", /^What it sold for is an estimate/)
      const traded = [leg(5, E18, { kind: "swap", costMicros: usd(1000), costLabel: "paid", estimated: true }), sell(30, 1n, 2500)]
      assert.match(eventsOf(taxReportOf([held(traded)], CA))[0]?.Notes ?? "", /^Part of its cost is an estimate/)
    })
  })

  describe("a market price nobody's answered for", () => {
    const BRIDGE = "0x4200000000000000000000000000000000000010"
    const MINT = `0x${"0".repeat(40)}`

    for (const [name, sender] of [["a bridge", BRIDGE], ["a mint", MINT]] as const) {
      it(`from ${name}, stays an estimate in every country, because it could be the user's own money`, () => {
        for (const settings of [CA, US, { ...CA, scope: "per-wallet" as const }]) {
          const report = taxReportOf([held([arrived(10, sender), sell(30, 1n, 2500)])], settings)
          const [row] = eventsOf(report)
          assert.deepEqual([row?.Cost, row?.Gain, row?.Status], ["2000.000000", "500.000000", "ESTIMATED"], JSON.stringify(settings))
          assert.equal(report.estimatedCount, 1)
          assert.ok(!report.warnings.some((warning) => warning.includes(TAX_COUNTRIES[settings.country].marketWarning)))
          assert.ok(report.notes.some((note) => /moved from elsewhere, its cost is what you first paid/.test(note)))
        }
      })
    }

    it("is the cost in Canada once someone says it came from someone else", () => {
      const [row] = eventsOf(taxReportOf([held([arrived(10, BRIDGE), sell(30, 1n, 2500)])], CA, { book: answering({ [BRIDGE]: { kind: "someone-else" } }) }))
      assert.equal(row?.Status, "OK")
    })

    it("stays an estimate after moving to another wallet", () => {
      const a = walletOf(A, [arrived(10, BRIDGE), sent(20, B)])
      const b = walletOf(B, [arrived(20, A, B), sell(30, 1n, 2500)])
      for (const settings of [CA, { ...CA, scope: "per-wallet" as const }]) assert.equal(eventsOf(taxReportOf([a, b], settings))[0]?.Status, "ESTIMATED", JSON.stringify(settings))
    })

    it("in a pool with what someone gave, the unanswered part still makes it an estimate", () => {
      const wallet = held([arrived(10, BRIDGE), arrived(11, SELLER), leg(30, -2n * E18, { proceedsMicros: usd(5000) })])
      const [row] = eventsOf(taxReportOf([wallet], CA, { book: answering({ [SELLER]: { kind: "someone-else" } }) }))
      assert.deepEqual([row?.Cost, row?.Status], ["4000.000000", "ESTIMATED"])
      assert.match(row?.Notes ?? "", /worth when it arrived/, "and says the rest is what it was worth")
    })
  })

  describe("a cost of $0 someone entered", () => {
    const free = (micros = "0") => {
      const first = arrived(10, SELLER)
      return { first, book: answering({}, { [costKey(A, first.id)]: { micros, currency: "USD" as const } }) }
    }

    it("is still their word, not something confirmed", () => {
      const { first, book } = free()
      const report = taxReportOf([held([first, sell(30, 1n, 2500)])], US, { book })
      const [row] = eventsOf(report)
      assert.deepEqual([row?.Cost, row?.Gain, row?.Status], ["0.000000", "2500.000000", "SELF-REPORTED"])
      assert.match(row?.Notes ?? "", /what you entered or imported/)
      assert.equal(report.selfReportedCount, 1)
      assert.ok(report.warnings.some((warning) => /a cost you entered/.test(warning)))
    })

    it("keeps its mark after moving, either way of working it out", () => {
      const { first, book } = free()
      const a = walletOf(A, [first, sent(20, B)])
      const b = walletOf(B, [arrived(20, A, B), sell(30, 1n, 2500)])
      for (const settings of [US, CA, { ...US, method: "average" as const }, { ...CA, scope: "per-wallet" as const }]) {
        const [row] = eventsOf(taxReportOf([a, b], settings, { book }))
        assert.deepEqual([row?.Cost, row?.Status], ["0.000000", "SELF-REPORTED"], JSON.stringify(settings))
      }
    })

    it("marks every sale from an average that includes it, and only the sales of it when oldest first", () => {
      const { first, book } = free()
      const legs = [first, buy(20, 1n, 1000), sell(30, 1n, 2500), sell(40, 1n, 2500)]
      assert.deepEqual(eventsOf(taxReportOf([held(legs)], { ...US, method: "average" }, { book })).map((row) => row.Status), ["SELF-REPORTED", "SELF-REPORTED"])
      assert.deepEqual(eventsOf(taxReportOf([held(legs)], US, { book })).map((row) => row.Status), ["SELF-REPORTED", "OK"])
    })

    it("counts for an exchange account too", () => {
      const wallet = held([arrived(10, SELLER), sell(30, 1n, 2500)])
      const receipts = [{ wallet: A, legId: wallet.legs[0]?.id as string, asset: "ETH", units: E18.toString() }]
      const [row] = eventsOf(taxReportOf([wallet], US, { book: answering({ [SELLER]: { kind: "my-exchange", costs: [{ asset: "ETH", micros: "0", currency: "USD", receipts }] } }) }))
      assert.deepEqual([row?.Cost, row?.Status], ["0.000000", "SELF-REPORTED"])
    })
  })

  describe("a cost from a wallet the chain can't confirm", () => {
    const hop = 20
    const mine = answering({ [A]: { kind: "mine" }, [B]: { kind: "mine" } })
    const legs = () => [buy(10, 1n, 1000), sent(hop, B)]
    // Its history says the ETH left, and the chain says it's still there.
    const mismatched = () => walletOf(A, legs(), { balances: { blockNum: 1000, amounts: { ETH: E18.toString() } } })
    const unread = () => walletOf(A, legs(), { balances: { blockNum: 1000, amounts: {} }, unreadBalances: ["ETH"] })
    const openingUnread = () => walletOf(A, legs(), { openingUnread: ["ETH"] })
    const b = walletOf(B, [arrived(hop, A, B), sell(30, 1n, 2500)])

    for (const [name, source] of [["doesn't match its balance", mismatched], ["has an unread balance", unread], ["has an unread starting balance", openingUnread]] as const) {
      it(`isn't known when the sender ${name}`, () => {
        const report = taxReportOf([source(), b], US, { book: mine })
        const row = eventsOf(report).find((event) => event.Wallet === B)
        assert.deepEqual([row?.Proceeds, row?.Cost, row?.Gain, row?.Status], ["2500.000000", "unknown", "unknown", "UNKNOWN GAIN"])
        assert.ok(report.warnings.some((warning) => /ETH history can't be confirmed/.test(warning)), "and says which wallet")
      })

      it(`isn't known when the sender ${name}, and only supplies costs`, () => {
        const report = taxReportOf([b], US, { book: mine, costsFrom: [source()] })
        assert.deepEqual([eventsOf(report)[0]?.Cost, eventsOf(report)[0]?.Status, report.gainMicros], ["unknown", "UNKNOWN GAIN", null])
        assert.ok(report.warnings.some((warning) => /ETH history can't be confirmed/.test(warning)))
      })

      it(`stays unknown through another wallet when the sender ${name}`, () => {
        const C = `0x${"c".repeat(40)}`
        const middle = walletOf(B, [arrived(hop, A, B), sent(25, C, B)])
        const last = walletOf(C, [arrived(25, B, C), sell(30, 1n, 2500)])
        const book = answering({ [A]: { kind: "mine" }, [B]: { kind: "mine" }, [C]: { kind: "mine" } })
        const [row] = eventsOf(taxReportOf([last], US, { book, costsFrom: [source(), middle] }))
        assert.deepEqual([row?.Cost, row?.Status], ["unknown", "UNKNOWN GAIN"])
      })
    }

    it("says the same as the screen", () => {
      const bought = walletOf(B, [arrived(hop, A, B), sell(30, 1n, 2500)])
      const onScreen = foldBook(bought, [mismatched()], "fifo", mine).positions[0]
      const row = eventsOf(taxReportOf([bought], US, { book: mine, costsFrom: [mismatched()] }))[0]
      assert.deepEqual([onScreen?.values.realizedMicros, onScreen?.reconciliation?.status], [null, "reconciled"])
      assert.deepEqual([row?.Cost, row?.Status], ["unknown", "UNKNOWN GAIN"])
    })

    it("goes by the last read that worked, like the screen, when the latest one failed", () => {
      const failed = walletOf(A, legs(), { balances: null, unreadBalances: ["ETH"], lastBalances: { ETH: { blockNum: hop, amount: "0" } } })
      const bought = walletOf(B, [arrived(hop, A, B), sell(30, 1n, 2500)])
      const screen = foldBook(bought, [failed], "fifo", mine).positions[0]
      const row = eventsOf(taxReportOf([bought], US, { book: mine, costsFrom: [failed] }))[0]
      assert.equal(screen?.values.realizedMicros, usd(1500))
      assert.deepEqual([row?.Gain, row?.Status], ["1500.000000", "OK"])
    })

    it("only touches what came from there", () => {
      const legs = [buy(5, 1n, 500), arrived(hop, A, B), sell(30, 1n, 2500), sell(40, 1n, 2500)]
      const rows = eventsOf(taxReportOf([walletOf(B, legs)], US, { book: mine, costsFrom: [mismatched()] }))
      assert.deepEqual(rows.map((row) => [row.Cost, row.Status]), [["500.000000", "OK"], ["unknown", "UNKNOWN GAIN"]])
    })

    it("only touches that asset", () => {
      const report = taxReportOf([walletOf(A, [buy(10, 1n, 1000), sent(hop, B)], { balances: { blockNum: 1000, amounts: { ETH: "0", USDC: "5" } } }), b], US, { book: mine })
      assert.equal(eventsOf(report).find((event) => event.Wallet === B)?.Status, "OK")
    })

    it("can still be answered with what it cost", () => {
      const first = arrived(hop, A, B)
      const [row] = eventsOf(taxReportOf([walletOf(B, [first, sell(30, 1n, 2500)])], US, { book: { ...mine, costs: { [costKey(B, first.id)]: { micros: usd(900), currency: "USD" } } }, costsFrom: [mismatched()] }))
      assert.deepEqual([row?.Cost, row?.Status], ["900.000000", "SELF-REPORTED"])
      const answered = taxReportOf([walletOf(B, [first, sell(30, 1n, 2500)])], US, { book: { ...mine, costs: { [costKey(B, first.id)]: { micros: usd(900), currency: "USD" } } }, costsFrom: [mismatched()] })
      assert.ok(!answered.warnings.some((warning) => /history can't be confirmed/.test(warning)), "so there's nothing to warn about")
    })

    it("doesn't blame a wallet for an unknown cost that didn't come from it", () => {
      const C = `0x${"c".repeat(40)}`
      const elsewhere = () => walletOf(A, [buy(10, 1n, 1000), sent(hop, C)], { balances: { blockNum: 1000, amounts: { ETH: E18.toString() } } })
      const book = answering({ [A]: { kind: "mine" }, [C]: { kind: "mine" } })
      const unrelated = taxReportOf([walletOf(B, [arrived(hop, SELLER, B), sell(30, 1n, 2500)])], US, { book, costsFrom: [elsewhere(), walletOf(C, [arrived(hop, A, C)])] })
      assert.equal(eventsOf(unrelated)[0]?.Status, "UNKNOWN GAIN", "it has an unknown cost of its own")
      assert.ok(!unrelated.warnings.some((warning) => /history can't be confirmed/.test(warning)))
      const reached = taxReportOf([walletOf(C, [arrived(hop, A, C)])], US, { book, costsFrom: [elsewhere()] })
      assert.ok(reached.warnings.some((warning) => /ETH history can't be confirmed/.test(warning)), "the wallet it did reach still says so")
    })

    it("doesn't change what a wallet's own history says about itself", () => {
      const self = walletOf(A, [buy(10, 1n, 1000), sell(30, 1n, 2500)], { balances: { blockNum: 1000, amounts: { ETH: E18.toString() } } })
      const report = taxReportOf([self], US)
      assert.ok(!report.warnings.some((warning) => /history can't be confirmed/.test(warning)))
      assert.equal(eventsOf(report)[0]?.Status, "UNKNOWN GAIN")
    })
  })

  describe("between wallets", () => {
    const hop = 20
    const a = (first: PricedLeg) => walletOf(A, [first, sent(hop, B)])
    const b = walletOf(B, [arrived(hop, A, B), sell(30, 1n, 2500)])
    const cost = usd(1000)

    it("carries a cost over, each on its own, without warning about it", () => {
      for (const context of [{}, { book: answering({ [A]: { kind: "mine" }, [B]: { kind: "mine" } }) }]) {
        const report = taxReportOf([a(buy(10, 1n, 1000)), b], US, context)
        const [row] = eventsOf(report)
        assert.deepEqual([row?.Cost, row?.Gain, row?.Status, row?.Wallet], ["1000.000000", "1500.000000", "OK", B])
        assert.ok(!report.warnings.some((warning) => /carry over/.test(warning)))
      }
    })

    it("still warns when what moved has no cost to carry", () => {
      const report = taxReportOf([a(leg(10, E18)), b], US)
      assert.equal(eventsOf(report)[0]?.Status, "UNKNOWN GAIN")
      assert.ok(report.warnings.some((warning) => /no known cost to carry over/.test(warning)))
    })

    it("keeps marking a cost the user entered, however far it's moved", () => {
      const first = arrived(10, SELLER)
      const book = answering({}, { [costKey(A, first.id)]: { micros: cost, currency: "USD" } })
      for (const settings of [US, CA, { ...US, method: "average" as const }]) {
        const [row] = eventsOf(taxReportOf([a(first), b], settings, { book }))
        assert.deepEqual([row?.Cost, row?.Status], ["1000.000000", "SELF-REPORTED"], JSON.stringify(settings))
      }
    })

    it("keeps reading a market price as one, however far it's moved", () => {
      const book = answering({ [SELLER]: { kind: "someone-else" } })
      assert.equal(eventsOf(taxReportOf([a(arrived(10, SELLER)), b], US, { book }))[0]?.Status, "ESTIMATED")
      for (const settings of [CA, { ...CA, scope: "per-wallet" as const }]) {
        assert.equal(eventsOf(taxReportOf([a(arrived(10, SELLER)), b], settings, { book }))[0]?.Status, "OK", JSON.stringify(settings))
      }
    })

    it("gives each sale its share of what was entered", () => {
      const first = arrived(10, SELLER)
      const book = answering({}, { [costKey(A, first.id)]: { micros: cost, currency: "USD" } })
      const half = walletOf(A, [first, leg(30, -E18 / 2n, { proceedsMicros: usd(1000) }), leg(40, -E18 / 2n, { proceedsMicros: usd(1000) })])
      const rows = taxRows([half], { method: "fifo", scope: "per-wallet" }, { book })
      assert.deepEqual(rows.map((row) => [row.costMicros, row.status]), [[usd(500), "self-reported"], [usd(500), "self-reported"]])
    })

    it("can take costs from a wallet without listing its sales", () => {
      const giver = walletOf(B, [buy(10, 1n, 1000), sent(hop, A, B)])
      const here = walletOf(A, [arrived(hop, B), sell(30, 1n, 2500)])
      const report = taxReportOf([here], US, { book: answering({ [A]: { kind: "mine" }, [B]: { kind: "mine" } }), costsFrom: [giver] })
      assert.deepEqual(report.wallets, [A])
      assert.deepEqual(eventsOf(report).map((row) => [row.Cost, row.Wallet]), [["1000.000000", A]])
      const notTheirs = taxReportOf([here], US, { book: answering({ [B]: { kind: "mine" } }), costsFrom: [giver] })
      assert.deepEqual(eventsOf(notTheirs).map((row) => [row.Cost, row.Status]), [["unknown", "UNKNOWN GAIN"]], "being paid by their wallet doesn't make it theirs")
    })
  })

  it("names the wallets it added because of an answer", () => {
    const report = taxReportOf([walletOf(A, [buy(10, 1n, 1000)]), walletOf(B, [buy(10, 1n, 1000)])], US, { book: answering({ [B]: { kind: "mine" } }) })
    assert.ok(report.notes.some((note) => /wallets you've said are yours/.test(note)))
    const typed = taxReportOf([walletOf(A, [buy(10, 1n, 1000)]), walletOf(B, [buy(10, 1n, 1000)])], US)
    assert.ok(!typed.notes.some((note) => /wallets you've said are yours/.test(note)))
  })

  it("keeps the words people read plain", () => {
    const JARGON = /\b(legs?|oracle|FIFO|traces?|rebas\w*|L1|L2|allowlist)\b/i
    for (const country of [TAX_COUNTRIES.CA, TAX_COUNTRIES.US]) assert.doesNotMatch(`${country.marketRowNote} ${country.marketWarning}`, JARGON)
  })
})

describe("POST /api/tax-report", () => {
  let server: Server
  let base = ""
  before(async () => {
    const handle = createApi({})
    server = createServer((req, res) => void handle(req, res))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(() => server.close())

  const post = async (address: string, body: unknown) => {
    const response = await fetch(`${base}/api/tax-report/${address}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    return { status: response.status, body: (await response.json()) as TaxReportResponse & { error?: string } }
  }

  it("is the same report as a GET with no answers", async () => {
    const got = (await (await fetch(`${base}/api/tax-report/demo?country=CA&currency=CAD`)).json()) as TaxReportResponse
    assert.deepEqual((await post("demo", { country: "CA", currency: "CAD" })).body, got)
    assert.deepEqual((await post("demo", { country: "CA", currency: "CAD", also: [], book: emptyBook() })).body, got)
  })

  it("applies a cost someone entered", async () => {
    const open = DEMO_WALLET.legs.find((l) => l.asset === "ETH" && BigInt(l.delta) > 0n && l.costLabel === "unknown") as PricedLeg
    const plain = (await post("demo", { country: "US" })).body
    const answered = (await post("demo", { country: "US", book: { costs: { [costKey(DEMO_ADDRESS, open.id)]: { micros: usd(1), currency: "USD" } } } })).body
    assert.ok(answered.unresolvedCount < plain.unresolvedCount, "an answered cost resolves rows")
    assert.ok(answered.selfReportedCount > 0)
  })

  it("on the demo, takes costs from its other wallet without listing that wallet's rows", async () => {
    const book = { senders: { [DEMO_SAVINGS_ADDRESS]: { kind: "mine" } } }
    const { status, body } = await post("demo", { country: "CA", book })
    assert.equal(status, 200)
    assert.deepEqual(body.wallets, [DEMO_ADDRESS])
    assert.ok(!body.warnings.some((warning) => /start at different blocks/.test(warning)))
    assert.ok(!eventsOf(body).some((row) => row.Wallet === DEMO_SAVINGS_ADDRESS))
  })

  it("never lets an answer put demo data in a report on a real wallet", async () => {
    const book = { senders: { [DEMO_ADDRESS]: { kind: "mine" }, [DEMO_SAVINGS_ADDRESS]: { kind: "mine" }, [A]: { kind: "mine" } } }
    const { status, body } = await post(A, { country: "CA", book })
    assert.equal(status, 503, "only the real wallet is read, and it has no data source here")
    assert.doesNotMatch(body.error ?? "", /demo wallet can't/)
    for (const also of [[DEMO_SAVINGS_ADDRESS], [DEMO_ADDRESS]]) assert.equal((await post(A, { country: "CA", also })).status, 400, String(also[0]))
  })

  it("turns down what it can't read", async () => {
    assert.equal((await post("demo", {})).status, 400)
    assert.equal((await post("demo", { country: "FR" })).status, 400)
    assert.equal((await post("demo", { country: 1 })).status, 400)
    assert.equal((await post("demo", { country: "CA", method: "lifo" })).status, 400)
    assert.equal((await post("demo", { country: "CA", method: 1 })).status, 400)
    assert.equal((await post("demo", { country: "CA", scope: "everything" })).status, 400)
    assert.equal((await post("demo", { country: "CA", currency: "SEK" })).status, 400)
    assert.equal((await post("demo", { country: "CA", book: { costs: { x: "nope" } } })).status, 400)
    assert.equal((await post(A, { country: "CA", also: "nope" })).status, 400)
    assert.equal((await post(A, { country: "CA", also: [1] })).status, 400)
    assert.equal((await post(A, { country: "CA", also: ["nope"] })).status, 400)
    assert.equal((await post(A, { country: "CA", also: Array(21).fill(B) })).status, 400)
    const senders = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`0x${i.toString(16).padStart(40, "c")}`, { kind: "mine" }]))
    assert.equal((await post(A, { country: "CA", book: { senders: { ...senders, [A]: { kind: "mine" } } } })).status, 400)
  })

  it("fails rather than leave out a wallet the answers named", async () => {
    assert.equal((await post(A, { country: "CA", book: { senders: { [A]: { kind: "mine" }, [B]: { kind: "mine" } } } })).status, 503)
  })
})

describe("POST /api/tax-report on real wallets", () => {
  // A buys 1 ETH with USDC, then sends it to B. C is someone being watched, who also got some from A.
  const C = `0x${"c".repeat(40)}`
  const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
  const row = (block_num: number, tx_hash: string, account: string, side: LegRow["side"], amount: bigint): LegRow => ({ block_num, timestamp: "2026-11-04T00:00:00.000Z", tx_hash, tx_index: 1, log_index: block_num, token: ETH_ADDRESS, account, side, amount: amount.toString(), kind: "eth" })
  const rows: Record<string, LegRow[]> = {
    [A]: [row(10, "0x1", A, "credit", E18), { ...row(11, "0x1", A, "debit", 3_000_000_000n), block_num: 10, token: USDC, kind: "erc20" }, { ...row(12, "0x2", A, "debit", E18), counterparty: B }],
    [B]: [{ ...row(12, "0x2", B, "credit", E18), counterparty: A }, row(14, "0x3", B, "debit", E18 / 2n), { ...row(15, "0x3", B, "credit", 1_600_000_000n), block_num: 14, token: USDC, kind: "erc20" }],
    [C]: [],
  }
  const source: Source = {
    mode: "raw",
    startBlock: 1,
    historyFrom: null,
    head: async () => ({ blockNum: 20, timestamp: "2026-11-04T00:00:00.000Z" }),
    processedThrough: async (_, head) => head,
    readWindow: async (address) => ({ rows: rows[address] ?? [], priced: null, gasUnknown: [] }),
    readReferences: async (blocks) => blocks.map((block_num) => ({ blockNum: block_num, ethUsd: "300000000000", usdcUsd: "100000000" })),
    readLatestReference: async () => ({ blockNum: 20, ethUsd: "400000000000", usdcUsd: "100000000" }),
    readEthBalances: async () => new Map(),
    readBalances: async (address, block) => {
      const amounts: Record<string, string> = Object.fromEntries(ASSETS.map((asset) => [asset, "0"]))
      for (const r of rows[address] ?? []) {
        if (r.block_num > block) continue
        const asset = r.token === USDC ? "USDC" : "ETH"
        amounts[asset] = (BigInt(amounts[asset] as string) + (r.side === "credit" ? BigInt(r.amount) : -BigInt(r.amount))).toString()
      }
      return { blockNum: block, amounts }
    },
  }
  let server: Server
  let base = ""
  before(async () => {
    const handle = createApi({}, { source, readRates: async () => ({ byBlock: {}, latest: null }), proofs: { datasets: async () => [], priceBehind: async () => null, readBlock: async () => null } })
    server = createServer((req, res) => void handle(req, res))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(() => server.close())
  const post = async (address: string, body: unknown) => (await (await fetch(`${base}/api/tax-report/${address}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as TaxReportResponse
  const sale = (report: TaxReportResponse) => eventsOf(report).find((event) => event.Type === "Sold" && event.Wallet === B)
  const mine = { senders: { [A]: { kind: "mine" }, [B]: { kind: "mine" } } }

  it("without answers, a wallet on its own doesn't know what came to it cost", async () => {
    const report = await post(B, { country: "US" })
    assert.deepEqual(report.wallets, [B])
    assert.deepEqual([sale(report)?.Cost, sale(report)?.Status], ["unknown", "UNKNOWN GAIN"])
  })

  it("adds the wallets the answers say are the user's, and carries their costs", async () => {
    for (const country of ["US", "CA"]) {
      const report = await post(B, { country, book: mine })
      assert.deepEqual(report.wallets, [B, A], country)
      assert.deepEqual([sale(report)?.Cost, sale(report)?.Gain, sale(report)?.Status], ["1500.000000", "100.000000", "OK"], country)
      assert.ok(report.notes.some((note) => /wallets you've said are yours/.test(note)), country)
    }
  })

  it("agrees with the portfolio the same answers give", async () => {
    const report = await post(B, { country: "US", book: mine })
    const portfolio = (await (await fetch(`${base}/api/portfolio/${B}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "fifo", book: mine }) })).json()) as PortfolioResponse
    assert.equal(portfolio.positions.find((p) => p.asset === "ETH")?.values.realizedMicros, usd(100))
    assert.equal(sale(report)?.Gain, "100.000000")
  })

  it("adds them when wallets are typed too, since that says this one is the user's", async () => {
    const report = await post(C, { country: "US", also: [A], book: { senders: { [B]: { kind: "mine" } } } })
    assert.deepEqual(report.wallets, [C, A, B])
  })

  it("on a wallet nobody's said is theirs, doesn't use the answers' wallets or list them", async () => {
    const report = await post(C, { country: "US", book: mine })
    assert.deepEqual(report.wallets, [C])
    assert.equal(report.rowCount, 0)
    assert.ok(!report.notes.some((note) => /wallets you've said are yours/.test(note)))
    const stranger = await post(B, { country: "US", book: { senders: { [A]: { kind: "mine" }, [C]: { kind: "mine" } } } })
    assert.deepEqual([stranger.wallets, sale(stranger)?.Cost, sale(stranger)?.Status], [[B], "unknown", "UNKNOWN GAIN"])
  })

  it("doesn't let an answered demo wallet in", async () => {
    const report = await post(A, { country: "US", book: { senders: { [A]: { kind: "mine" }, [DEMO_ADDRESS]: { kind: "mine" }, [DEMO_SAVINGS_ADDRESS]: { kind: "mine" } } } })
    assert.deepEqual(report.wallets, [A])
  })
})

describe("GET /api/tax-report", () => {
  let server: Server
  let base = ""
  before(async () => {
    const handle = createApi({})
    server = createServer((req, res) => void handle(req, res))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(() => server.close())

  const get = async (query: string) => {
    const response = await fetch(`${base}/api/tax-report/${query}`)
    return { status: response.status, body: (await response.json()) as TaxReportResponse & { error?: string } }
  }

  it("uses the country's defaults, unless told otherwise", async () => {
    const ca = await get("demo?country=CA&currency=CAD")
    assert.deepEqual([ca.status, ca.body.method, ca.body.scope, ca.body.currency], [200, "average", "pooled", "CAD"])
    const us = await get("demo?country=US")
    assert.deepEqual([us.body.method, us.body.scope], ["fifo", "per-wallet"])
    const override = await get("demo?country=US&method=average&scope=pooled")
    assert.deepEqual([override.body.method, override.body.scope, override.body.defaults.method], ["average", "pooled", "fifo"])
  })

  it("lists a year when asked", async () => {
    const latest = await get("demo?country=US&year=latest")
    assert.deepEqual([latest.status, latest.body.year], [200, 2026])
    assert.equal((await get("demo?country=US&year=2026")).body.year, 2026)
    assert.equal((await get("demo?country=US")).body.year, null)
  })

  it("turns down what it can't do", async () => {
    assert.equal((await get("demo")).status, 400)
    assert.equal((await get("demo?country=CA&year=last")).status, 400)
    assert.equal((await get("demo?country=FR")).status, 400)
    assert.equal((await get("demo?country=CA&method=lifo")).status, 400)
    assert.equal((await get("demo?country=CA&scope=everything")).status, 400)
    assert.equal((await get("demo?country=CA&currency=SEK")).status, 400)
    assert.equal((await get(`demo?country=CA&also=${A}`)).status, 400)
    assert.equal((await get(`${DEMO_ADDRESS}?country=CA&also=${A}`)).status, 400)
    assert.equal((await get(`${A}?country=CA&also=nope`)).status, 400)
    assert.equal((await get(`${A}?country=CA&also=${Array(21).fill(B).join(",")}`)).status, 400)
  })

  it("never puts demo data in a report on a real wallet, whichever way round they're asked for", async () => {
    for (const query of [`${A}?country=CA&also=${DEMO_ADDRESS}`, `${A}?country=CA&also=${B},${DEMO_ADDRESS}`, `${DEMO_ADDRESS}?country=CA&also=${A}`, `demo?country=CA&also=${DEMO_ADDRESS}`]) {
      const { status, body } = await get(query)
      assert.equal(status, 400, query)
      assert.match(body.error ?? "", /demo wallet can't be combined/)
    }
  })

  it("fails rather than leave a wallet out", async () => {
    assert.equal((await get(`${A}?country=CA`)).status, 503)
  })
})
