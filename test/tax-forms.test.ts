import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { ETH_ADDRESS, type LegPart, type PricedLeg } from "@pricetag/sdk/core"
import type { WalletResponse } from "../src/core/api.ts"
import { costKey, emptyBook, type Book } from "../src/core/book.ts"
import { parseCoinbaseCsv } from "../src/core/exchange-import.ts"
import { DEMO_WALLET } from "../src/core/fixtures.ts"
import { termOf } from "../src/core/tax-forms.ts"
import { taxReportOf } from "../src/core/tax.ts"
import { E18 } from "./support/units.ts"

const A = `0x${"a".repeat(40)}`
const B = `0x${"b".repeat(40)}`
const SELLER = `0x${"5".repeat(40)}`
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
const part = (account: string, side: "credit" | "debit", amount: bigint, counterparty: string): LegPart => ({ logIndex: 0, token: ETH_ADDRESS, account, side, amount: amount.toString(), kind: "eth", counterparty })
/** One ETH from `from` to `to`, as `to` sees it. */
const arrived = (block: number, day: string, from: string, to = A) => leg(block, day, E18, { kind: "transfer", parts: [part(to, "credit", E18, from)] })
/** One ETH from `from` to `to`, as `from` sees it. */
const sent = (block: number, day: string, to: string, from = A) => leg(block, day, -E18, { kind: "transfer", parts: [part(from, "debit", E18, to)] })
const opening = (day: string) => leg(0, day, E18, { id: "opening:ETH", opening: true, kind: "transfer", txHash: "" })
const entered = (address: string, l: PricedLeg, amount: number): Book["costs"] => ({ [costKey(address, l.id)]: { micros: usd(amount), currency: "USD" } })
const coinbase = (...rows: string[]) => parseCoinbaseCsv(`Timestamp,Transaction Type,Asset,Quantity Transacted,Price Currency,Price at Transaction,Subtotal,Total (inclusive of fees and/or spread),Fees and/or Spread,Notes\n${rows.join("\n")}\n`)!.withdrawals
const coinbaseRow = (when: string, type: string, quantity: string, total = "$0") => `${when},${type},ETH,${quantity},USD,$0,$0,${total},$0,x`

function walletOf(legs: PricedLeg[], readThrough: string, address = A): WalletResponse {
  const amounts: Record<string, string> = {}
  for (const l of legs) amounts[l.asset] = (BigInt(amounts[l.asset] ?? 0) + BigInt(l.delta)).toString()
  return {
    ...DEMO_WALLET,
    address,
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
    assert.equal(termOf(null, "2026-03-02T00:00:00.000Z"), "unknown")
  })

  it("starts counting on March 1 for something acquired on February 29, so its year is up on February 28", () => {
    assert.equal(termOf("2024-02-29T00:00:00.000Z", "2025-02-28T23:00:00.000Z"), "short")
    assert.equal(termOf("2024-02-29T00:00:00.000Z", "2025-03-01T00:00:00.000Z"), "long")
    assert.equal(termOf("2024-02-28T00:00:00.000Z", "2025-02-28T23:00:00.000Z"), "short")
    assert.equal(termOf("2024-02-28T00:00:00.000Z", "2025-03-01T00:00:00.000Z"), "long")
    assert.equal(termOf("2023-02-28T00:00:00.000Z", "2024-02-29T00:00:00.000Z"), "long")
  })
})

describe("when what was sold was acquired", () => {
  const US = { country: "US", method: "fifo", scope: "per-wallet" } as const
  const READ = "2026-01-01T00:00:00.000Z"
  const formLines = (wallets: WalletResponse[], book: Book, wallet = A) => linesOf(taxReportOf(wallets, US, { book }).form?.csv ?? "").filter((line) => line[2] !== "Total" && line.includes(wallet))
  const undated = (cost: string, gain: string) => ["How long it was held isn't known", "", "1 ETH", "unknown", "09/01/2025", "2500.000000", cost, "", "", gain]

  it("isn't when an opening balance was first read, even with a cost entered for it", () => {
    const start = opening("2025-06-01")
    const lines = formLines([walletOf([start, sell(2, "2025-09-01", 1n, 2500)], READ)], { ...emptyBook(), costs: entered(A, start, 1000) })
    assert.deepEqual(lines.map((line) => line.slice(0, 10)), [undated("1000.000000", "1500.000000")])
  })

  it("isn't when something arrived with only an entered cost, or from an exchange that doesn't say when it was bought", () => {
    const transfer = arrived(1, "2025-06-01", SELLER)
    const wallet = walletOf([transfer, sell(2, "2025-09-01", 1n, 2500)], READ)
    assert.deepEqual(formLines([wallet], { ...emptyBook(), costs: entered(A, transfer, 1000) }).map((line) => line.slice(0, 10)), [undated("1000.000000", "1500.000000")])
    const withdrawal = { exchange: "Coinbase", asset: "ETH", units: E18.toString(), at: transfer.timestamp, cost: { micros: usd(1000), currency: "USD" }, fifoCostMicros: usd(1000), toAddress: A } as const
    assert.deepEqual(formLines([wallet], { ...emptyBook(), withdrawals: [withdrawal] }).map((line) => line.slice(0, 10)), [undated("1000.000000", "1500.000000")])
  })

  it("is when the exchange says it was bought, not when it was withdrawn", () => {
    const transfer = arrived(1, "2025-06-01", SELLER)
    const withdrawals = coinbase(coinbaseRow("2024-01-10T10:00:00Z", "Buy", "1", "$1000"), coinbaseRow(transfer.timestamp, "Send", "1"))
    const lines = formLines([walletOf([transfer, sell(2, "2025-09-01", 1n, 2500)], READ)], { ...emptyBook(), withdrawals })
    assert.deepEqual(lines.map((line) => line.slice(0, 10)), [["Part II (long-term)", "L", "1 ETH", "01/10/2024", "09/01/2025", "2500.000000", "1000.000000", "", "", "1500.000000"]])
  })

  it("stays what it was after a move between wallets, known or not", () => {
    const sale = sell(3, "2025-09-01", 1n, 2500)
    const move = [sent(2, "2025-07-01", B), arrived(2, "2025-07-01", A, B)] as const
    const bought = [walletOf([buy(1, "2024-01-10", 1n, 1000), move[0]], READ), walletOf([move[1], sale], READ, B)]
    assert.deepEqual(formLines(bought, emptyBook(), B).map((line) => line.slice(0, 4)), [["Part II (long-term)", "L", "1 ETH", "01/10/2024"]])
    const start = opening("2025-06-01")
    const opened = [walletOf([start, move[0]], READ), walletOf([move[1], sale], READ, B)]
    assert.deepEqual(formLines(opened, { ...emptyBook(), costs: entered(A, start, 1000) }, B).map((line) => line.slice(0, 10)), [undated("1000.000000", "1500.000000")])
    const transfer = arrived(1, "2025-06-01", SELLER)
    const withdrawal = { exchange: "Coinbase", asset: "ETH", units: E18.toString(), at: transfer.timestamp, cost: { micros: usd(1000), currency: "USD" }, fifoCostMicros: usd(1000), toAddress: A } as const
    const withdrawn = [walletOf([transfer, move[0]], READ), walletOf([move[1], sale], READ, B)]
    assert.deepEqual(formLines(withdrawn, { ...emptyBook(), withdrawals: [withdrawal] }, B).map((line) => line.slice(0, 10)), [undated("1000.000000", "1500.000000")])
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

  it("has no total for a part none of whose amounts are all known, rather than $0", () => {
    const legs = [buy(1, "2025-06-01", 1n, 3000), leg(2, "2025-09-01", -E18)]
    const lines = linesOf(taxReportOf([walletOf(legs, "2026-01-01T00:00:00.000Z")], { country: "US", method: "fifo", scope: "per-wallet" }).form?.csv ?? "")
    assert.deepEqual(lines.map((line) => line.slice(0, 10)), [
      ["Part I (short-term)", "I", "1 ETH", "06/01/2025", "09/01/2025", "unknown", "3000.000000", "", "", "unknown"],
      ["Part I (short-term)", "I", "Total", "", "", "unknown", "unknown", "", "", "unknown"],
    ])
    assert.match(lines[1]?.[11] ?? "", /^"?There's no total yet/)
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

describe("Schedule 3 totals", () => {
  it("has none when no sale's amounts are all known, rather than $0", () => {
    const report = taxReportOf([walletOf([leg(1, "2025-01-01", E18, { opening: true }), sell(2, "2025-02-01", 1n, 2000)], "2026-01-01T00:00:00.000Z")], { country: "CA", method: "average", scope: "pooled" })
    assert.equal(report.gainMicros, null)
    const total = linesOf(report.form?.csv ?? "").at(-1)
    assert.deepEqual(total?.slice(0, 7), ["Total", "Proceeds go on line 15200 and the gain (or loss) on line 15301", "", "unknown", "unknown", "", "unknown"])
    assert.match(total?.[9] ?? "", /^"?There's no total yet/)
  })

  it("still adds up what's known, and says what it leaves out", () => {
    const legs = [buy(1, "2025-01-01", 1n, 1000), sell(2, "2025-02-01", 1n, 2000), leg(3, "2025-03-01", E18, { opening: false, kind: "transfer" }), sell(4, "2025-04-01", 1n, 2000)]
    const total = linesOf(taxReportOf([walletOf(legs, "2026-01-01T00:00:00.000Z")], { country: "CA", method: "fifo", scope: "per-wallet" }).form?.csv ?? "").at(-1)
    assert.deepEqual(total?.slice(3, 7), ["2000.000000", "1000.000000", "", "1000.000000"])
    assert.match(total?.[9] ?? "", /^"?Leaves out 1 line/)
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

  it("doesn't count withdrawing what was bought earlier on an exchange, but does count what was bought there within 30 days", () => {
    const withdrawal = arrived(3, "2025-03-20", SELLER)
    const legs = [buy(1, "2025-01-01", 2n, 6000), sell(2, "2025-03-01", 1n, 2000), withdrawal]
    const flagged = (buys: string) => {
      const book: Book = { ...emptyBook(), withdrawals: coinbase(buys, coinbaseRow(withdrawal.timestamp, "Send", "1")), senders: { [SELLER]: { kind: "my-exchange" } } }
      return taxReportOf([walletOf(legs, "2026-01-01T00:00:00.000Z")], ca, { book }).warnings.some((warning) => warning.includes("superficial"))
    }
    assert.equal(flagged(coinbaseRow("2025-01-01T10:00:00Z", "Buy", "1", "$2500")), false)
    assert.equal(flagged(coinbaseRow("2025-03-10T10:00:00Z", "Buy", "1", "$2100")), true)
  })

  it("doesn't count something arriving from elsewhere as acquired then", () => {
    const legs = [buy(1, "2025-01-01", 2n, 6000), sell(2, "2025-03-01", 1n, 2000), arrived(3, "2025-03-20", SELLER)]
    assert.ok(!taxReportOf([walletOf(legs, "2026-01-01T00:00:00.000Z")], ca).warnings.some((warning) => warning.includes("superficial")))
  })

  it("only checks Canada's report", () => {
    const legs = [buy(1, "2025-01-01", 2n, 6000), sell(2, "2025-03-01", 1n, 2000), buy(3, "2025-03-20", 1n, 2100)]
    assert.doesNotMatch(taxReportOf([walletOf(legs, "2026-01-01T00:00:00.000Z")], { country: "US", method: "fifo", scope: "per-wallet" }).csv, /superficial loss\./)
  })
})
