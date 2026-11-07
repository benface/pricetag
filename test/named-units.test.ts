import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { applyLeg, applyLegTaking, emptyPosition, type FoldLeg, type Method, type PricedLeg } from "@pricetag/sdk/core"
import type { WalletResponse } from "../src/core/api.ts"
import { emptyBook, forgetUnitChoices, parseBook, recordUnitChoices, type Book, type UnitChoice } from "../src/core/book.ts"
import { DEMO_WALLET } from "../src/core/fixtures.ts"
import { TAX_COUNTRIES, taxReportOf, taxRows } from "../src/core/tax.ts"
import { parseUnitChoicesCsv } from "../src/core/unit-choices.ts"

const USD = 1_000_000n
const ETH = 10n ** 18n
const day = (block: number) => `2026-10-${String(block).padStart(2, "0")}T00:00:00.000Z`

const bought = (id: string, block: number, usd: bigint | null, qty = ETH, fields: Partial<FoldLeg> = {}): FoldLeg => ({
  id,
  delta: qty.toString(),
  decimals: 18,
  kind: "swap",
  priceMicros: null,
  costMicros: usd === null ? null : (usd * USD).toString(),
  proceedsMicros: null,
  costLabel: usd === null ? "unknown" : "paid",
  blockNum: block,
  timestamp: day(block),
  ...fields,
})
const sold = (qty: bigint, usd: bigint, takes?: FoldLeg["takes"]): FoldLeg => ({ id: "out", delta: (-qty).toString(), decimals: 18, kind: "swap", priceMicros: null, costMicros: null, proceedsMicros: ((qty * usd * USD) / ETH).toString(), costLabel: "unknown", blockNum: 20, timestamp: day(20), ...(takes ? { takes } : {}) })
const hold = (method: Method, ...legs: FoldLeg[]) => legs.reduce(applyLeg, emptyPosition(method, 18))

describe("units a sale's records named", () => {
  // Bought at $100, then $300, then $200, one ETH each.
  const legs = [bought("a", 1, 100n), bought("b", 2, 300n), bought("c", 3, 200n)]

  for (const method of ["fifo", "lifo", "hifo"] as const) {
    it(`takes what they name instead of ${method}'s order, and leaves the rest oldest first`, () => {
      const { state, chosen, taken } = applyLegTaking(hold(method, ...legs), sold(ETH, 500n, [{ at: day(3), qty: ETH.toString() }]))
      assert.equal(chosen, "used")
      assert.equal(state.realizedMicros, (300n * USD).toString())
      assert.deepEqual(taken.map((piece) => piece.acquiredAt), [day(3)])
      assert.deepEqual(state.lots.map((lot) => lot.legId), ["a", "b"])
    })
  }

  it("names purchases by their UTC day, and takes from several in the order given", () => {
    const { state, taken } = applyLegTaking(hold("fifo", ...legs), sold(ETH + ETH / 2n, 500n, [{ at: "2026-10-02", qty: (ETH / 2n).toString() }, { at: "2026-10-03", qty: ETH.toString() }]))
    assert.deepEqual(taken.map((piece) => [piece.acquiredAt, piece.costMicros]), [[day(2), (150n * USD).toString()], [day(3), (200n * USD).toString()]])
    assert.deepEqual(state.lots.map((lot) => [lot.legId, lot.qty]), [["a", ETH.toString()], ["b", (ETH / 2n).toString()]])
  })

  it("refuses what isn't held, more than is, or what doesn't add up to the sale, and goes by the method instead", () => {
    const refusals: FoldLeg["takes"][] = [
      [{ at: day(9), qty: ETH.toString() }],
      [{ at: day(3), qty: (2n * ETH).toString() }],
      [{ at: day(3), qty: (ETH / 2n).toString() }],
      [{ at: day(3), qty: ETH.toString() }, { at: day(3), qty: ETH.toString() }],
    ]
    for (const takes of refusals) {
      const qty = (takes ?? []).reduce((sum, take) => sum + BigInt(take.qty), 0n) === 2n * ETH ? 2n * ETH : ETH
      const { state, chosen } = applyLegTaking(hold("fifo", ...legs), sold(qty, 500n, takes))
      assert.equal(chosen, "refused", JSON.stringify(takes))
      assert.deepEqual(state, applyLeg(hold("fifo", ...legs), sold(qty, 500n)))
    }
  })

  it("refuses part of a day whose purchases cost different amounts, since that doesn't say which", () => {
    const sameDay = [bought("a", 1, 100n), bought("b", 1, 300n, ETH, { timestamp: "2026-10-01T05:00:00.000Z" })]
    assert.equal(applyLegTaking(hold("fifo", ...sameDay), sold(ETH, 500n, [{ at: "2026-10-01", qty: ETH.toString() }])).chosen, "refused")
    // All of that day is fine, and so is naming the moment.
    assert.equal(applyLegTaking(hold("fifo", ...sameDay), sold(2n * ETH, 500n, [{ at: "2026-10-01", qty: (2n * ETH).toString() }])).chosen, "used")
    const moment = applyLegTaking(hold("fifo", ...sameDay), sold(ETH, 500n, [{ at: "2026-10-01T05:00:00.000Z", qty: ETH.toString() }]))
    assert.equal(moment.chosen, "used")
    assert.equal(moment.state.realizedMicros, (200n * USD).toString())
  })

  it("keeps an unknown cost unknown when that's what was named", () => {
    const { state, chosen } = applyLegTaking(hold("fifo", bought("a", 1, 100n), bought("b", 2, null)), sold(ETH, 500n, [{ at: day(2), qty: ETH.toString() }]))
    assert.equal(chosen, "used")
    assert.equal(state.unknownCostDisposedQty, ETH.toString())
    assert.equal(state.realizedMicros, "0")
    assert.equal(state.lots[0]?.costMicros, (100n * USD).toString())
  })

  it("isn't used by average, which mixes everything", () => {
    const applied = applyLegTaking(hold("average", ...legs), sold(ETH, 500n, [{ at: day(3), qty: ETH.toString() }]))
    assert.equal(applied.chosen, undefined)
    assert.equal(applied.state.realizedMicros, (300n * USD).toString())
  })
})

const A = `0x${"a".repeat(40)}`
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`
const at = (block: number) => new Date(Date.UTC(2026, 10, 4) + block * 2000).toISOString()

const leg = (block: number, delta: bigint, fields: Partial<PricedLeg> = {}): PricedLeg => ({
  id: `${hash(block)}:ETH`,
  asset: "ETH",
  decimals: 18,
  delta: delta.toString(),
  kind: "swap",
  priceMicros: (2000n * USD).toString(),
  priceSource: "oracle",
  priceNote: null,
  costMicros: null,
  proceedsMicros: null,
  costLabel: "unknown",
  blockNum: block,
  timestamp: at(block),
  txHash: hash(block),
  txIndex: 0,
  parts: [],
  ...fields,
})
const buy = (block: number, units: bigint, paid: bigint) => leg(block, units * ETH, { costMicros: (paid * USD).toString(), costLabel: "paid" })
const sell = (block: number, units: bigint, received: bigint) => leg(block, -units * ETH, { proceedsMicros: (received * USD).toString() })

function walletOf(address: string, legs: PricedLeg[]): WalletResponse {
  const amounts: Record<string, string> = {}
  for (const l of legs) amounts[l.asset] = (BigInt(amounts[l.asset] ?? 0) + BigInt(l.delta)).toString()
  return {
    ...DEMO_WALLET,
    address,
    mode: "dataset",
    coverage: { fromBlock: 1, toBlock: 1000 },
    latest: { blockNum: 1000, timestamp: at(1000) },
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

describe("a US tax report with named units", () => {
  // Bought 1 ETH at $1,000, then 1 at $3,000, then sold 1 for $2,000.
  const wallet = walletOf(A, [buy(10, 1n, 1000n), buy(20, 1n, 3000n), sell(30, 1n, 2000n)])
  const choice = (recordedAt: string, boughtAt = at(20)): UnitChoice => ({ wallet: A, txHash: hash(30), asset: "ETH", recordedAt, takes: [{ boughtAt, units: ETH.toString() }] })
  const book = (...choices: UnitChoice[]): Book => recordUnitChoices(emptyBook(), choices)
  const US = { country: "US", method: "fifo", scope: "per-wallet" } as const
  const sale = (report: ReturnType<typeof taxReportOf>) => report.csv.split("\r\n").find((line) => line.includes(",Sold,")) as string

  it("uses them when they were named no later than the sale, and says so on the row", () => {
    const [row] = taxRows([wallet], { ...US }, { book: book(choice(at(30))) }).filter((r) => r.type === "Sold")
    assert.equal(row?.gainMicros, (-1000n * USD).toString())
    assert.equal(row?.chosenUnits, "used")
    assert.match(row?.reason ?? "", /units your records named/)
    const report = taxReportOf([wallet], US, { book: book(choice(at(29))) })
    assert.equal(report.gainMicros, (-1000n * USD).toString())
    assert.match(sale(report), /Units you named/)
    assert.ok(report.notes.some((note) => /1 sale or send uses the units your records named/.test(note)))
  })

  it("doesn't use them when they were named after the sale, and says why", () => {
    const report = taxReportOf([wallet], US, { book: book(choice(at(31))) })
    assert.equal(report.gainMicros, (1000n * USD).toString())
    assert.ok(report.warnings.some((warning) => /only named units for 1 sale or send after it happened/.test(warning)))
    assert.match(sale(report), /Oldest first/)
  })

  it("says when they don't match what was held, or name nothing here", () => {
    const refused = taxReportOf([wallet], US, { book: book(choice(at(29), at(25))) })
    assert.equal(refused.gainMicros, (1000n * USD).toString())
    assert.ok(refused.warnings.some((warning) => /don't match what was held then/.test(warning)))
    const elsewhere = taxReportOf([wallet], US, { book: book({ ...choice(at(29)), txHash: hash(31) }) })
    assert.ok(elsewhere.warnings.some((warning) => /1 record of the units you named is about a sale or send that isn't in this wallet/.test(warning)))
  })

  it("aren't used under Average, or for Canada, whose rules average", () => {
    const average = taxReportOf([wallet], { ...US, method: "average" }, { book: book(choice(at(29))) })
    assert.ok(average.warnings.some((warning) => /Average mixes everything bought/.test(warning)))
    const canada = taxReportOf([wallet], { country: "CA", method: "fifo", scope: "per-wallet" }, { book: book(choice(at(29))) })
    assert.equal(canada.gainMicros, (1000n * USD).toString())
    assert.ok(![...canada.warnings, ...canada.notes].some((line) => /named/.test(line)))
  })

  it("no longer says choosing units isn't available, and stays in plain words", () => {
    assert.ok(!TAX_COUNTRIES.US.notes.some((note) => /isn't available/.test(note)))
    const JARGON = /\b(legs?|oracle|FIFO|LIFO|HIFO|lots?|traces?|allowlist)\b/i
    for (const recordedAt of [at(29), at(31)]) {
      const report = taxReportOf([wallet], US, { book: book(choice(recordedAt)) })
      assert.doesNotMatch([...report.warnings, ...report.notes].join(" "), JARGON)
    }
  })
})

describe("records of named units in the book", () => {
  const choice: UnitChoice = { wallet: A, txHash: hash(30), asset: "ETH", recordedAt: at(29), takes: [{ boughtAt: "2026-11-04", units: ETH.toString() }] }

  it("go through a request, and anything malformed refuses the book", () => {
    assert.deepEqual(parseBook({ unitChoices: [choice] })?.unitChoices, [choice])
    for (const bad of [{ ...choice, txHash: "0x12" }, { ...choice, recordedAt: "yesterday" }, { ...choice, takes: [] }, { ...choice, takes: [{ boughtAt: "soon", units: "1" }] }, { ...choice, takes: [{ boughtAt: "2026-11-04", units: "0" }] }]) {
      assert.equal(parseBook({ unitChoices: [bad] }), null, JSON.stringify(bad))
    }
  })

  it("take over for an earlier record of the same sale, and can be forgotten for a wallet", () => {
    const later = { ...choice, recordedAt: at(28) }
    const both = recordUnitChoices(recordUnitChoices(emptyBook(), [choice]), [later])
    assert.deepEqual(both.unitChoices, [later])
    assert.equal(recordUnitChoices(both, [later]), both)
    assert.deepEqual(forgetUnitChoices(both, [A.toUpperCase().replace("0X", "0x")]), emptyBook())
  })
})

describe("importing named units from a file", () => {
  const header = "Recorded at,Wallet,Transaction,Asset,Bought on,Amount"

  it("makes one record of a sale's rows, recorded when the last of them was", () => {
    const csv = [header, `2026-11-04T10:00:00Z,${A},${hash(30)},ETH,2026-11-01,0.5`, `2026-11-04 11:00:00+00:00,${A},${hash(30)},WETH,2026-11-02T08:00:00Z,"1,000.25"`, `2026-11-04T09:00:00Z,${A},${hash(31)},USDC,2026-11-01,10`].join("\r\n")
    const imported = parseUnitChoicesCsv(csv)
    assert.deepEqual(imported?.skipped, [])
    assert.deepEqual(imported?.choices, [
      { wallet: A, txHash: hash(30), asset: "ETH", recordedAt: "2026-11-04T11:00:00.000Z", takes: [{ boughtAt: "2026-11-01", units: (ETH / 2n).toString() }, { boughtAt: "2026-11-02T08:00:00.000Z", units: (100025n * ETH / 100n).toString() }] },
      { wallet: A, txHash: hash(31), asset: "USDC", recordedAt: "2026-11-04T09:00:00.000Z", takes: [{ boughtAt: "2026-11-01", units: "10000000" }] },
    ])
  })

  it("leaves out a whole record when any of its rows can't be read, and isn't fooled by other files", () => {
    const csv = [header, `2026-11-04T10:00:00Z,${A},${hash(30)},ETH,2026-11-01,0.5`, `2026-11-04T10:00:00,${A},${hash(30)},ETH,2026-11-02,0.5`, `2026-11-04T10:00:00Z,${A},${hash(31)},USDC,2026-11-01,0.0000001`, `2026-11-04T10:00:00Z,${A},${hash(32)},PEPE,2026-11-01,1`].join("\n")
    const imported = parseUnitChoicesCsv(csv)
    assert.deepEqual(imported?.choices, [])
    assert.deepEqual(imported?.skipped, [2, 3, 4, 5])
    assert.equal(parseUnitChoicesCsv("Timestamp,Transaction Type,Asset\n"), null)
  })
})
