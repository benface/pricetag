import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { PricedLeg } from "@pricetag/sdk/core"
import type { WalletResponse } from "../src/core/api.ts"
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
    assert.ok(report.warnings.includes(TAX_COUNTRIES.GB.methodWarning))
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
    // Fully matched the same day, nothing later can change it.
    const [sameDay] = uk([walletOf(A, [buy("2026-05-01", 2, 2000), buy("2026-12-20", 1, 2500), sell("2026-12-20", 1, 3000)])])
    assert.doesNotMatch(sameDay?.reason ?? "", /haven't all been read/)
  })

  it("matches across all the wallets in a report, and each wallet on its own when asked", () => {
    const a = walletOf(A, [buy("2026-05-01", 1, 1000), sell("2026-05-02", 1, 1500)])
    const b = walletOf(B, [buy("2026-05-03", 1, 1200)])
    assert.deepEqual(costs(uk([a, b])), [[1200, 300]])
    assert.deepEqual(costs(uk([a, b], "per-wallet")), [[1000, 500]])
  })

  it("lists a UK tax year from April 6 to April 5, and names it the way HMRC does", () => {
    assert.equal(taxYearOf("2026-04-05T23:59:59.000Z", TAX_COUNTRIES.GB), 2025)
    assert.equal(taxYearOf("2026-04-06T00:00:00.000Z", TAX_COUNTRIES.GB), 2026)
    assert.equal(taxYearOf("2026-04-05T23:59:59.000Z", TAX_COUNTRIES.US), 2026)
    assert.equal(yearLabel(2025, TAX_COUNTRIES.GB), "2025 to 2026")
    const wallet = walletOf(A, [buy("2026-01-05", 2, 2000), sell("2026-04-05", 1, 1500), sell("2026-04-06", 1, 1500)])
    const report = taxReportOf([wallet], { country: "GB", method: "average", scope: "pooled", year: 2026 })
    assert.deepEqual([report.year, report.yearLabel, report.years, report.yearLabels], [2026, "2026 to 2027", [2026, 2025], ["2026 to 2027", "2025 to 2026"]])
    assert.equal(report.soldCount, 1)
    assert.match(report.filename, /-2026-27-GB-average-GBP\.csv$/)
    assert.ok(report.notes.some((note) => note.includes("the 2026 to 2027 tax year (April 6, 2026 to April 5, 2027)")))
    assert.equal(report.form, null)
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
