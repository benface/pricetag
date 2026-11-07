import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { PricedLeg } from "@pricetag/sdk/core"
import type { WalletResponse } from "../src/core/api.ts"
import { DEMO_WALLET } from "../src/core/fixtures.ts"
import { termOf } from "../src/core/tax-forms.ts"
import { taxReportOf } from "../src/core/tax.ts"
import { E18 } from "./support/units.ts"

const A = `0x${"a".repeat(40)}`
const usd = (amount: number) => (BigInt(amount) * 1_000_000n).toString()
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`

/** One leg a block, dated by the day, so a test can span years without millions of blocks. */
const leg = (block: number, day: string, delta: bigint, fields: Partial<PricedLeg> = {}): PricedLeg => ({
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
  timestamp: `${day}T12:00:00.000Z`,
  txHash: hash(block),
  txIndex: 0,
  parts: [],
  ...fields,
})
const buy = (block: number, day: string, units: bigint, paid: number) => leg(block, day, units * E18, { costMicros: usd(paid), costLabel: "paid" })
const sell = (block: number, day: string, units: bigint, received: number) => leg(block, day, -units * E18, { proceedsMicros: usd(received) })

function walletOf(legs: PricedLeg[], readThrough: string): WalletResponse {
  const amounts: Record<string, string> = {}
  for (const l of legs) amounts[l.asset] = (BigInt(amounts[l.asset] ?? 0) + BigInt(l.delta)).toString()
  return {
    ...DEMO_WALLET,
    address: A,
    mode: "dataset",
    coverage: { fromBlock: 1, toBlock: 1000 },
    latest: { blockNum: 1000, timestamp: readThrough },
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
  }
}

/** The lines after the notes, without the header. */
const linesOf = (csv: string) =>
  csv
    .trim()
    .split("\r\n")
    .slice(1)
    .map((line) => line.split(","))
    .filter(([first]) => first !== "Note")

describe("termOf", () => {
  it("is long-term only once more than a year has passed, counting from the day after", () => {
    assert.equal(termOf("2025-03-01T12:00:00.000Z", "2026-03-01T23:00:00.000Z"), "short")
    assert.equal(termOf("2025-03-01T12:00:00.000Z", "2026-03-02T00:00:00.000Z"), "long")
    assert.equal(termOf("2024-02-29T00:00:00.000Z", "2025-03-01T00:00:00.000Z"), "short")
    assert.equal(termOf(null, "2026-03-02T00:00:00.000Z"), "unknown")
  })
})

describe("Form 8949", () => {
  it("splits a sale across short and long terms, with each part's acquisition date, and totals each part", () => {
    const legs = [buy(1, "2024-01-10", 1n, 1000), buy(2, "2025-06-01", 1n, 3000), sell(3, "2025-09-01", 2n, 5000)]
    const report = taxReportOf([walletOf(legs, "2026-01-01T00:00:00.000Z")], { country: "US", method: "fifo", scope: "per-wallet" })
    assert.equal(report.form?.name, "Form 8949")
    assert.match(report.form?.filename ?? "", /^form-8949-/)
    const lines = linesOf(report.form?.csv ?? "")
    assert.deepEqual(
      lines.map((line) => line.slice(0, 10)),
      [
        ["Part I (short-term)", "I", "1 ETH", "06/01/2025", "09/01/2025", "2500.000000", "3000.000000", "", "", "-500.000000"],
        ["Part I (short-term)", "I", "Total", "", "", "2500.000000", "3000.000000", "", "", "-500.000000"],
        ["Part II (long-term)", "L", "1 ETH", "01/10/2024", "09/01/2025", "2500.000000", "1000.000000", "", "", "1500.000000"],
        ["Part II (long-term)", "L", "Total", "", "", "2500.000000", "1000.000000", "", "", "1500.000000"],
      ],
    )
  })

  it("keeps a sale with no known cost out of both parts and their totals", () => {
    const report = taxReportOf([walletOf([leg(1, "2025-01-01", E18, { opening: true }), sell(2, "2025-02-01", 1n, 2000)], "2026-01-01T00:00:00.000Z")], { country: "US", method: "fifo", scope: "per-wallet" })
    const lines = linesOf(report.form?.csv ?? "")
    assert.equal(lines.length, 1)
    assert.deepEqual(lines[0]?.slice(0, 10), ["How long it was held isn't known", "", "1 ETH", "unknown", "02/01/2025", "2000.000000", "unknown", "", "", "unknown"])
  })

  it("says VARIOUS for an average, which mixes purchases, and can't tell its holding period", () => {
    const legs = [buy(1, "2024-01-10", 1n, 1000), buy(2, "2025-06-01", 1n, 3000), sell(3, "2025-09-01", 1n, 2500)]
    const report = taxReportOf([walletOf(legs, "2026-01-01T00:00:00.000Z")], { country: "US", method: "average", scope: "pooled" })
    const [line] = linesOf(report.form?.csv ?? "")
    assert.deepEqual(line?.slice(0, 4), ["How long it was held isn't known", "", "1 ETH", "VARIOUS"])
  })
})

describe("Schedule 3", () => {
  it("lists each sale on line 7 with its year of acquisition, then the totals for lines 15200 and 15301", () => {
    const legs = [buy(1, "2024-01-10", 1n, 1000), buy(2, "2025-06-01", 1n, 3000), sell(3, "2025-09-01", 1n, 2500)]
    const report = taxReportOf([walletOf(legs, "2026-01-01T00:00:00.000Z")], { country: "CA", method: "average", scope: "pooled" })
    assert.equal(report.form?.name, "Schedule 3")
    const lines = linesOf(report.form?.csv ?? "")
    assert.deepEqual(lines[0]?.slice(0, 7), ["7", "1 ETH", "Various", "2500.000000", "2000.000000", "", "500.000000"])
    assert.equal(lines[1]?.[0], "Total")
    assert.deepEqual(lines[1]?.slice(3, 7), ["2500.000000", "2000.000000", "", "500.000000"])
  })
})

describe("superficial losses", () => {
  const ca = { country: "CA", method: "average", scope: "pooled" } as const

  it("flags a loss when more was acquired within 30 days and some was still held 30 days after", () => {
    const legs = [buy(1, "2025-01-01", 2n, 6000), sell(2, "2025-03-01", 1n, 2000), buy(3, "2025-03-20", 1n, 2100)]
    const report = taxReportOf([walletOf(legs, "2026-01-01T00:00:00.000Z")], ca)
    assert.ok(report.warnings.some((warning) => warning.startsWith("1 loss may be superficial")))
    assert.match(report.csv, /may be a superficial loss/)
  })

  it("doesn't flag a loss when nothing was acquired within 30 days, or nothing was held after them", () => {
    const later = [buy(1, "2025-01-01", 2n, 6000), sell(2, "2025-03-01", 1n, 2000), buy(3, "2025-04-15", 1n, 2100)]
    assert.ok(!taxReportOf([walletOf(later, "2026-01-01T00:00:00.000Z")], ca).warnings.some((warning) => warning.includes("superficial")))
    const soldAll = [buy(1, "2025-02-20", 2n, 6000), sell(2, "2025-03-01", 1n, 2000), sell(3, "2025-03-10", 1n, 2000)]
    assert.ok(!taxReportOf([walletOf(soldAll, "2026-01-01T00:00:00.000Z")], ca).warnings.some((warning) => warning.includes("superficial")))
  })

  it("says it may become one while the 30 days after aren't all read", () => {
    const legs = [buy(1, "2025-01-01", 2n, 6000), sell(2, "2025-03-01", 1n, 2000), buy(3, "2025-03-05", 1n, 2100)]
    const report = taxReportOf([walletOf(legs, "2025-03-10T00:00:00.000Z")], ca)
    assert.match(report.csv, /may turn out to be a superficial loss/)
  })

  it("only checks Canada's report", () => {
    const legs = [buy(1, "2025-01-01", 2n, 6000), sell(2, "2025-03-01", 1n, 2000), buy(3, "2025-03-20", 1n, 2100)]
    assert.doesNotMatch(taxReportOf([walletOf(legs, "2026-01-01T00:00:00.000Z")], { country: "US", method: "fifo", scope: "per-wallet" }).csv, /superficial loss\./)
  })
})
