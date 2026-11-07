import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { ETH_ADDRESS, type LegPart, type PricedLeg } from "@pricetag/sdk/core"
import type { WalletResponse } from "../src/core/api.ts"
import { emptyBook } from "../src/core/book.ts"
import { parseCoinbaseCsv } from "../src/core/exchange-import.ts"
import { DEMO_WALLET } from "../src/core/fixtures.ts"
import { TAX_COUNTRIES, taxReportOf, taxRows, taxYearOf, yearLabel, type TaxRow } from "../src/core/tax.ts"
import { shares } from "../src/core/tax-matching.ts"
import { E18 } from "./support/units.ts"

const A = `0x${"a".repeat(40)}`
const B = `0x${"b".repeat(40)}`
const gbp = (pounds: number) => (BigInt(Math.round(pounds * 100)) * 10_000n).toString()
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`

let block = 0
/** A leg on a UTC day, each one in a later block than the last. */
function at(day: string, delta: bigint, fields: Partial<PricedLeg> = {}): PricedLeg {
  block++
  return {
    id: `${hash(block)}:ETH`,
    asset: "ETH",
    decimals: 18,
    delta: delta.toString(),
    kind: "swap",
    priceMicros: gbp(1),
    priceSource: "oracle",
    priceNote: null,
    costMicros: null,
    proceedsMicros: null,
    costLabel: "unknown",
    blockNum: block,
    timestamp: `${day}T${String(8 + (block % 12)).padStart(2, "0")}:00:00.000Z`,
    txHash: hash(block),
    txIndex: 0,
    parts: [],
    ...fields,
  }
}
const buy = (day: string, units: number, paid: number) => at(day, BigInt(units) * E18, { costMicros: gbp(paid), costLabel: "paid" })
const sell = (day: string, units: number, received: number) => at(day, -BigInt(units) * E18, { proceedsMicros: gbp(received) })

function walletOf(address: string, legs: PricedLeg[], latest = "2026-12-31T00:00:00.000Z", changes: Partial<WalletResponse> = {}): WalletResponse {
  const amounts: Record<string, string> = {}
  for (const l of legs) amounts[l.asset] = (BigInt(amounts[l.asset] ?? 0) + BigInt(l.delta)).toString()
  return {
    ...DEMO_WALLET,
    address,
    mode: "dataset",
    // About a year and three months of blocks, so history starts in the UK's 2025 to 2026 tax year.
    coverage: { fromBlock: 1, toBlock: 20_000_000 },
    latest: { blockNum: 20_000_000, timestamp: latest },
    legs,
    balances: { blockNum: 20_000_000, amounts },
    lastBalances: {},
    lastCheckableEth: null,
    unreadBalances: [],
    openingUnread: [],
    gasUnknownTxs: [],
    l1FeeUnknownTxs: [],
    currency: "GBP",
    rates: null,
    ...changes,
  }
}

const uk = (wallets: WalletResponse[], scope: "pooled" | "per-wallet" = "pooled") => taxRows(wallets, { method: "average", scope, country: "GB" })
/** Cost and gain in pounds, to the penny HMRC's examples round to. */
const pounds = (micros: string | null) => (micros === null ? null : Math.round(Number(micros) / 10_000) / 100)
const costs = (rows: readonly TaxRow[]) => rows.map((row) => [pounds(row.costMicros), pounds(row.gainMicros)])

describe("the UK's matching rules", () => {
  it("matches a day's disposals together to what was acquired that day, and pools the rest (CRYPTO22252)", () => {
    const rows = uk([walletOf(A, [buy("2026-01-05", 5000, 500), sell("2026-06-23", 1000, 800), buy("2026-06-23", 1600, 1000), sell("2026-06-23", 500, 600)])])
    // £1,000 × 1,500 / 1,600 = £937.50 between the two, by how much each sold. HMRC rounds the total to £938, and the gain to £462.
    assert.deepEqual(costs(rows), [[625, 175], [312.5, 287.5]])
    assert.equal(rows.reduce((sum, row) => sum + Number(row.gainMicros), 0) / 1e6, 462.5)
  })

  it("matches the earliest disposal first to what's acquired in the 30 days after it, earliest first (CRYPTO22253)", () => {
    const legs = [buy("2026-01-05", 2000, 1000), sell("2026-03-31", 1000, 400), sell("2026-04-20", 500, 150), buy("2026-04-21", 700, 175), buy("2026-04-28", 500, 100), buy("2026-05-01", 500, 150)]
    const rows = uk([walletOf(A, [...legs, sell("2026-09-01", 2200, 2200)])])
    // £175 + £60, then £40 + £90. What's left of May 1 goes in the pool: 2,200 for £1,060.
    assert.deepEqual(costs(rows), [[235, 165], [130, 20], [1060, 1140]])
    assert.match(rows[0]?.reason ?? "", /bought in the 30 days after it/)
  })

  it("puts the same day, the 30 days after and the pool together (CRYPTO22256)", () => {
    const legs = [buy("2026-05-01", 100_000, 300_000), buy("2026-07-31", 10_000, 45_000), sell("2026-07-31", 30_000, 150_000), sell("2026-08-05", 20_000, 100_000), buy("2026-08-06", 50_000, 225_000), sell("2026-08-07", 100_000, 150_000)]
    const rows = uk([walletOf(A, legs)])
    // HMRC rounds £345,000 × 100,000 / 110,000 to £313,637, and the loss to £163,637.
    assert.deepEqual(costs(rows), [[135_000, 15_000], [90_000, 10_000], [313_636.36, -163_636.36]])
    assert.ok(rows.every((row) => row.status === "resolved"))
  })

  it("only matches with Average, so Oldest first is still oldest first, and says it may not be accepted", () => {
    const wallet = walletOf(A, [buy("2026-05-01", 1, 100), sell("2026-05-02", 1, 300), buy("2026-05-03", 1, 200)])
    assert.deepEqual(costs(uk([wallet])), [[200, 100]])
    assert.deepEqual(costs(taxRows([wallet], { method: "fifo", scope: "pooled", country: "GB" })), [[100, 200]])
    const report = taxReportOf([wallet], { country: "GB", method: "fifo", scope: "pooled" })
    assert.ok(report.warnings.includes(TAX_COUNTRIES.GB.methodWarnings.fifo as string))
  })

  it("matches a network fee like a sale, since paying one is a disposal", () => {
    const rows = uk([walletOf(A, [buy("2026-05-01", 1, 1000), buy("2026-05-02", 1, 3000), at("2026-05-02", -E18 / 10n, { kind: "gas" })])])
    // Matched to what was bought that day at £3,000, not the pool's average of £2,000, and sold at its price of £1 an ETH.
    assert.deepEqual(costs(rows), [[300, -299.9]])
    assert.equal(rows[0]?.type, "Network fee")
  })

  it("takes a send from the pool without matching it, since it may be a move to your own wallet", () => {
    const rows = uk([walletOf(A, [buy("2026-05-01", 2, 2000), at("2026-05-02", -E18, { kind: "transfer" }), buy("2026-05-03", 1, 5000)])])
    assert.deepEqual([rows[0]?.type, pounds(rows[0]?.costMicros ?? null), rows[0]?.gainMicros], ["Sent", 1000, null])
  })

  it("keeps an unknown cost unknown when it's matched, never $0", () => {
    const rows = uk([walletOf(A, [buy("2026-05-01", 1, 1000), sell("2026-05-02", 1, 1500), at("2026-05-03", E18, { kind: "swap", costLabel: "unknown" })])])
    // The ETH that arrived the next day came from a swap whose cost isn't known, and the sale is matched to it.
    assert.deepEqual([rows[0]?.costMicros, rows[0]?.gainMicros, rows[0]?.status], [null, null, "unresolved"])
  })

  it("says a sale's cost may still change while the 30 days after it aren't all read", () => {
    const wallet = walletOf(A, [buy("2026-05-01", 2, 2000), sell("2026-12-20", 1, 3000)])
    const [row] = uk([wallet])
    assert.deepEqual(costs([row as TaxRow]), [[1000, 2000]])
    assert.match(row?.reason ?? "", /haven't all been read yet/)
    const report = taxReportOf([wallet], { country: "GB", method: "average", scope: "pooled", year: "all" })
    assert.ok(report.warnings.some((warning) => /1 sale or fee happened less than 30 days before the end/.test(warning)))
    // Fully matched the same day, once that day's all read, nothing later can change it.
    const [sameDay] = uk([walletOf(A, [buy("2026-05-01", 2, 2000), buy("2026-12-20", 1, 2500), sell("2026-12-20", 1, 3000)])])
    assert.doesNotMatch(sameDay?.reason ?? "", /haven't all been read|hasn't been read/)
  })

  it("says a sale matched the same day may still change while the rest of that day isn't read, and stops once it is", () => {
    const legs = [at("2026-12-20", E18, { costMicros: gbp(100), costLabel: "paid", timestamp: "2026-12-20T09:00:00.000Z" }), at("2026-12-20", -E18, { proceedsMicros: gbp(200), timestamp: "2026-12-20T10:00:00.000Z" })]
    const midday = walletOf(A, legs, "2026-12-20T14:00:00.000Z")
    const [row] = uk([midday])
    assert.deepEqual(costs([row as TaxRow]), [[100, 100]])
    assert.match(row?.reason ?? "", /rest of its day hasn't been read yet/)
    const report = taxReportOf([midday], { country: "GB", method: "average", scope: "pooled", year: "all" })
    assert.ok(report.warnings.some((warning) => /1 sale or fee happened less than 30 days before the end/.test(warning)))
    // Another buy that day would change it: all of a day's buys count as one, at their average.
    const [changed] = uk([walletOf(A, [...legs, at("2026-12-20", E18, { costMicros: gbp(300), costLabel: "paid", timestamp: "2026-12-20T13:00:00.000Z" })], "2026-12-20T14:00:00.000Z")])
    assert.deepEqual(costs([changed as TaxRow]), [[200, 0]])
    // Read past midnight in the UK, the day's done and nothing can change it.
    const [settled] = uk([walletOf(A, legs, "2026-12-21T00:30:00.000Z")])
    assert.doesNotMatch(settled?.reason ?? "", /hasn't been read|haven't all been read/)
    assert.ok(!taxReportOf([walletOf(A, legs, "2026-12-21T00:30:00.000Z")], { country: "GB", method: "average", scope: "pooled", year: "all" }).warnings.some((warning) => /less than 30 days/.test(warning)))
  })

  it("goes by days in UK time, so just after midnight in summer is the next day", () => {
    // 23:30 UTC on July 1 is 00:30 on July 2 in the UK, the same day as the sale, so the sale is matched to it.
    const summer = uk([walletOf(A, [buy("2026-05-01", 1, 1000), at("2026-07-01", E18, { costMicros: gbp(3000), costLabel: "paid", timestamp: "2026-07-01T23:30:00.000Z" }), at("2026-07-02", -E18, { proceedsMicros: gbp(2500), timestamp: "2026-07-02T10:00:00.000Z" })])])
    assert.deepEqual(costs(summer), [[3000, -500]])
    // In winter the UK is on UTC, so 23:30 on December 1 is still December 1, before the sale's day, and the sale takes the average.
    const winter = uk([walletOf(A, [buy("2026-05-01", 1, 1000), at("2026-12-01", E18, { costMicros: gbp(3000), costLabel: "paid", timestamp: "2026-12-01T23:30:00.000Z" }), at("2026-12-02", -E18, { proceedsMicros: gbp(2500), timestamp: "2026-12-02T10:00:00.000Z" })])])
    assert.deepEqual(costs(winter), [[2000, 500]])
    // Across the clocks going forward: 23:30 UTC on March 31 is April 1 in the UK, 31 days after March 1, so it's not matched.
    const spring = uk([walletOf(A, [buy("2026-01-05", 1, 1000), at("2026-03-01", -E18, { proceedsMicros: gbp(2500), timestamp: "2026-03-01T12:00:00.000Z" }), at("2026-03-31", E18, { costMicros: gbp(3000), costLabel: "paid", timestamp: "2026-03-31T23:30:00.000Z" })])])
    assert.deepEqual(costs(spring), [[1000, 1500]])
  })

  it("matches what an exchange file says was bought, by when it was bought, without counting the withdrawal as a purchase", () => {
    const SELLER = `0x${"5".repeat(40)}`
    const part: LegPart = { logIndex: 0, token: ETH_ADDRESS, account: A, side: "credit", amount: (2n * E18).toString(), kind: "eth", counterparty: SELLER }
    const usd = (dollars: number) => (BigInt(dollars) * 1_000_000n).toString()
    // Made in order, since each leg is in a later block than the last.
    const legs = [
      at("2026-01-01", 2n * E18, { priceMicros: usd(3000), costMicros: usd(6000), costLabel: "paid" }),
      at("2026-03-01", -E18, { priceMicros: usd(2000), proceedsMicros: usd(2000) }),
      at("2026-04-01", -E18, { priceMicros: usd(2400), proceedsMicros: usd(2400) }),
      at("2026-04-02", 2n * E18, { kind: "transfer", priceMicros: usd(2400), parts: [part], timestamp: "2026-04-02T12:00:00.000Z" }),
      at("2026-05-01", -2n * E18, { priceMicros: usd(3500), proceedsMicros: usd(7000) }),
    ]
    const arrival = legs[3] as PricedLeg
    const row = (when: string, type: string, quantity: string, total = "$0") => `${when},${type},ETH,${quantity},USD,$0,$0,${total},$0,x`
    const file = parseCoinbaseCsv(`Timestamp,Transaction Type,Asset,Quantity Transacted,Price Currency,Price at Transaction,Subtotal,Total (inclusive of fees and/or spread),Fees and/or Spread,Notes\n${[row("2026-03-10T10:00:00Z", "Buy", "1", "$2100"), row("2026-04-01T10:00:00Z", "Buy", "1", "$2500"), row(arrival.timestamp, "Send", "2")].join("\n")}\n`)
    assert.ok(file)
    const book = { ...emptyBook(), withdrawals: file.withdrawals }
    const wallet = walletOf(A, legs, undefined, { currency: "USD" })
    const rows = taxRows([wallet], { method: "average", scope: "pooled", country: "GB" }, { book })
    // March 1 is matched to the exchange's March 10 buy, April 1 to its buy that day, and May 1 takes the January pool.
    assert.deepEqual(rows.map((r) => [pounds(r.costMicros), pounds(r.gainMicros), r.status]), [[2100, -100, "self-reported"], [2500, -100, "self-reported"], [6000, 1000, "resolved"]])
    assert.match(rows[0]?.reason ?? "", /bought in the 30 days after it/)
  })

  it("pools what an exchange file says was bought from when it was bought, not from its withdrawal, and only once", () => {
    const SELLER = `0x${"5".repeat(40)}`
    const part: LegPart = { logIndex: 0, token: ETH_ADDRESS, account: A, side: "credit", amount: E18.toString(), kind: "eth", counterparty: SELLER }
    const usd = (dollars: number) => (BigInt(dollars) * 1_000_000n).toString()
    // Made in order, since each leg is in a later block than the last.
    const legs = [
      at("2026-01-01", 2n * E18, { priceMicros: usd(3000), costMicros: usd(6000), costLabel: "paid" }),
      at("2026-03-01", -E18, { priceMicros: usd(2500), proceedsMicros: usd(2500) }),
      at("2026-04-02", E18, { kind: "transfer", priceMicros: usd(2400), parts: [part], timestamp: "2026-04-02T12:00:00.000Z" }),
      at("2026-05-10", -2n * E18, { priceMicros: usd(2500), proceedsMicros: usd(5000) }),
    ]
    const arrival = legs[2] as PricedLeg
    const row = (when: string, type: string, quantity: string, total = "$0") => `${when},${type},ETH,${quantity},USD,$0,$0,${total},$0,x`
    const file = parseCoinbaseCsv(`Timestamp,Transaction Type,Asset,Quantity Transacted,Price Currency,Price at Transaction,Subtotal,Total (inclusive of fees and/or spread),Fees and/or Spread,Notes\n${[row("2026-02-01T10:00:00Z", "Buy", "1", "$1000"), row(arrival.timestamp, "Send", "1")].join("\n")}\n`)
    assert.ok(file)
    const book = { ...emptyBook(), withdrawals: file.withdrawals }
    const wallet = walletOf(A, legs, undefined, { currency: "USD" })
    const rows = taxRows([wallet], { method: "average", scope: "pooled", country: "GB" }, { book })
    // The February buy is in the pool by March 1, though it's withdrawn in April: 7,000 for 3, then the other two at the same average.
    assert.deepEqual(rows.map((r) => [pounds(r.costMicros), pounds(r.gainMicros), r.status]), [[2333.33, 166.67, "self-reported"], [4666.67, 333.33, "self-reported"]])
  })

  it("matches across all the wallets in a report, and each wallet on its own when asked", () => {
    const a = walletOf(A, [buy("2026-05-01", 1, 1000), sell("2026-05-02", 1, 1500)])
    const b = walletOf(B, [buy("2026-05-03", 1, 1200)])
    assert.deepEqual(costs(uk([a, b])), [[1200, 300]])
    assert.deepEqual(costs(uk([a, b], "per-wallet")), [[1000, 500]])
  })

  it("lists a UK tax year from April 6 to April 5, and names it the way HMRC does", () => {
    // April 6 starts at 23:00 UTC on April 5, since the UK is on summer time by then.
    assert.equal(taxYearOf("2026-04-05T22:59:59.000Z", TAX_COUNTRIES.GB), 2025)
    assert.equal(taxYearOf("2026-04-05T23:00:00.000Z", TAX_COUNTRIES.GB), 2026)
    assert.equal(taxYearOf("2026-04-05T23:59:59.000Z", TAX_COUNTRIES.US), 2026)
    assert.equal(taxYearOf("2026-12-31T23:30:00.000Z", TAX_COUNTRIES.US), 2026)
    assert.equal(yearLabel(2025, TAX_COUNTRIES.GB), "2025 to 2026")
    const wallet = walletOf(A, [buy("2026-01-05", 2, 2000), sell("2026-04-05", 1, 1500), sell("2026-04-06", 1, 1500)])
    const report = taxReportOf([wallet], { country: "GB", method: "average", scope: "pooled", year: 2026 })
    assert.deepEqual([report.year, report.yearLabel, report.years, report.yearLabels], [2026, "2026 to 2027", [2026, 2025], ["2026 to 2027", "2025 to 2026"]])
    assert.equal(report.soldCount, 1)
    assert.match(report.filename, /-2026-27-GB-average-GBP\.csv$/)
    assert.ok(report.notes.some((note) => note.includes("the 2026 to 2027 tax year (April 6, 2026 to April 5, 2027)")))
    assert.equal(report.form, null)
    // A sale at 00:30 on April 6 in the UK is in the year that starts then, and not the one before.
    const late = walletOf(A, [buy("2026-01-05", 2, 2000), at("2026-04-05", -E18, { proceedsMicros: gbp(1500), timestamp: "2026-04-05T23:30:00.000Z" })])
    const yearOf = (year: number) => taxReportOf([late], { country: "GB", method: "average", scope: "pooled", year }).soldCount
    assert.deepEqual([yearOf(2025), yearOf(2026)], [0, 1])
    // In pounds, with nothing to warn about the currency.
    assert.ok(!report.warnings.some((warning) => /reports in/.test(warning)))
  })
})

describe("shares", () => {
  it("adds up exactly, and never gives a part more than it has", () => {
    assert.deepEqual(shares([1n, 1n, 1n], 2n), [1n, 1n, 0n])
    assert.deepEqual(shares([1n, 1000n], 1000n), [1n, 999n])
    assert.deepEqual(shares([3n, 0n], 3n), [3n, 0n])
    assert.deepEqual(shares([], 0n), [])
  })
})
