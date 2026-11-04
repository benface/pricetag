import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { after, before, describe, it } from "node:test"
import { foldPositions, type PricedLeg } from "@pricetag/sdk/core"
import type { TaxReportResponse, WalletResponse } from "../src/core/api.ts"
import { DEMO_ADDRESS, DEMO_WALLET, demoRates } from "../src/core/fixtures.ts"
import { TAX_COUNTRIES, readOtherWallets, taxReportOf, taxRows } from "../src/core/tax.ts"
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
  })

  it("doesn't call a real cost estimated because it was mixed with another real one", () => {
    const legs = [buy(10, 1n, 1000), leg(20, E18, { costMicros: usd(1000), costLabel: "self-reported" }), sell(30, 1n, 2000)]
    const [row] = taxRows([walletOf(A, legs, { balances: { blockNum: 1000, amounts: { ETH: E18.toString() } } })], { method: "average", scope: "per-wallet" })
    assert.equal(row?.status, "resolved")
  })

  describe("across wallets", () => {
    // A buys, moves it to B, and B sells.
    const move = 20
    const a = walletOf(A, [buy(10, 1n, 1000), leg(move, -E18, { kind: "transfer" })])
    const b = walletOf(B, [leg(move, E18, { kind: "transfer" }), sell(30, 1n, 2500)])

    it("pooled, a move between them isn't a sale, and the cost goes along", () => {
      const rows = taxRows([a, b], { method: "average", scope: "pooled" })
      assert.deepEqual(
        rows.map((row) => [row.type, row.costMicros, row.gainMicros, row.wallet]),
        [["Sold", usd(1000), usd(1500), B]],
      )
    })

    it("per wallet, the move still isn't a sale, and what arrived has an unknown cost until costs carry over", () => {
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
        assert.deepEqual([row?.Proceeds, row?.Cost, row?.Gain, row?.Status], ["2000.000000", "unknown", "unknown", "UNRESOLVED"])
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
    const unresolved = eventsOf(report).filter((row) => row.Status === "UNRESOLVED")
    assert.equal(unresolved.length, report.unresolvedCount)
    assert.ok(report.unresolvedCount > 0)
    for (const row of unresolved) {
      assert.equal(row.Gain, "unknown")
      assert.notEqual(row.Notes, "")
    }
    assert.match(report.warnings[0] ?? "", /unresolved/)
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

  it("converts at each transaction's rate, and a missing rate is unknown rather than guessed", () => {
    // USD for one CAD, with 8 decimals: 0.50 at the buy and 0.25 at the sale.
    const round = (answer: string, block: number) => ({ answer, updatedAt: Date.parse(leg(block, 0n).timestamp) / 1000 })
    const rates = { byBlock: { 10: round("50000000", 10), 30: round("25000000", 30) }, latest: { blockNum: 1000, round: round("25000000", 30) } }
    const [row] = eventsOf(taxReportOf([cad({ rates })], { country: "CA", method: "average", scope: "pooled" }))
    assert.deepEqual([row?.Proceeds, row?.Cost, row?.Gain, row?.Currency], ["8000.000000", "2000.000000", "6000.000000", "CAD"])

    const missing = taxReportOf([cad({ rates: { byBlock: { 10: round("50000000", 10) }, latest: rates.latest } })], { country: "CA", method: "average", scope: "pooled" })
    const [gap] = eventsOf(missing)
    assert.deepEqual([gap?.Proceeds, gap?.Gain, gap?.Status], ["unknown", "unknown", "UNRESOLVED"])
    assert.match(gap?.Notes ?? "", /no exchange rate/)
    assert.ok(missing.warnings.some((warning) => /no exchange rate/.test(warning)))
  })

  it("warns about moves whose cost doesn't carry over yet", () => {
    const a = walletOf(A, [buy(10, 1n, 1000), leg(20, -E18, { kind: "transfer" })])
    const b = walletOf(B, [leg(20, E18, { kind: "transfer" })])
    const report = taxReportOf([a, b], { country: "US", method: "fifo", scope: "per-wallet" })
    assert.ok(report.warnings.some((warning) => /cost doesn't carry over/.test(warning)))
    assert.equal(report.rowCount, 0)
    assert.equal(report.gainMicros, null)
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
    const text = `${JSON.stringify(taxReportOf([{ ...DEMO_WALLET, currency: "CAD", rates: demoRates("CAD") }], { country: "CA", method: "average", scope: "pooled" }), null, 2)}\n`
    if (process.env.UPDATE_FIXTURES) writeFileSync(url, text)
    assert.equal(readFileSync(url, "utf8"), text, "demo-tax-report.json is out of date. Run with UPDATE_FIXTURES=1 if the change is on purpose.")
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

  it("turns down what it can't do", async () => {
    assert.equal((await get("demo")).status, 400)
    assert.equal((await get("demo?country=FR")).status, 400)
    assert.equal((await get("demo?country=CA&method=lifo")).status, 400)
    assert.equal((await get("demo?country=CA&scope=everything")).status, 400)
    assert.equal((await get("demo?country=CA&currency=EUR")).status, 400)
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
