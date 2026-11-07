// The tax report in the shape of each country's own form, for whoever copies it over. The generic CSV stays the full record.
//
// What each layout rests on, from official sources only:
// - US, Form 8949: IRS Instructions for Form 8949 (2025). Columns (a) to (h). A digital asset sale reported on no Form 1099-DA
//   or 1099-B goes in box I (short-term, Part I) or box L (long-term, Part II), never C or F. Long-term is "more than 1 year",
//   counted from the day after it was acquired and including the day it was sold. "VARIOUS" in column (b) is allowed for
//   units bought in several purchases, with short and long terms still on separate rows.
// - Canada, Schedule 3: CRA guide T4037 (2025) reports crypto-assets on line 7 of Part 3, with total proceeds on line 15200
//   and the total gain or loss on line 15301. A gain is proceeds less adjusted cost base and outlays.
//
// Every amount comes from the generic report's rows, so the two files always agree. A gap stays a gap: what isn't known
// says "unknown", is never $0, and isn't in a total.

import { csvCell, microsCell, unitsCell } from "./csv.ts"
import type { Acquired, TaxCountryCode, TaxRow } from "./tax.ts"

export type TaxForm = {
  /** What it's called where it's filed. */
  name: string
  filename: string
  csv: string
}

export type Term = "short" | "long" | "unknown"

/** A UTC date as YYYY-MM-DD. */
const dateOf = (timestamp: string) => timestamp.slice(0, 10)

/**
 * Whether something held from `acquired` to `sold` was held more than a year: counting starts the day after it was acquired and
 * includes the day it was sold, so the year is up on its first anniversary, and it's long-term from the day after. One acquired on
 * February 29 starts counting on March 1, so its year is up on February 28, and it's long-term from March 1.
 */
export function termOf(acquired: string | null, sold: string): Term {
  if (acquired === null) return "unknown"
  const [year, month, day] = dateOf(acquired).split("-").map(Number) as [number, number, number]
  // The same day a year later, or the last day of that month when it has no such day.
  const lastDay = new Date(Date.UTC(year + 1, month, 0)).getUTCDate()
  const anniversary = `${year + 1}-${String(month).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`
  return dateOf(sold) > anniversary ? "long" : "short"
}

/** Part of a row, with what of it fits on one line of a form. */
type Line = { row: TaxRow; qty: bigint; proceeds: bigint | null; cost: bigint | null; gain: bigint | null; term: Term; acquired: string[] | "various" | null }

/** What fits on one line: the row whole, or its known pieces split by how long they were held, each with its share of the proceeds. */
function linesOf(row: TaxRow): Line[] {
  const qty = BigInt(row.amount)
  const proceeds = row.proceedsMicros === null ? null : BigInt(row.proceedsMicros)
  const cost = row.costMicros === null ? null : BigInt(row.costMicros)
  const whole = (acquired: Line["acquired"], term: Term): Line[] => [{ row, qty, proceeds, cost, gain: row.gainMicros === null ? null : BigInt(row.gainMicros), term, acquired }]
  if (row.acquired === null) return whole(row.costMicros === null ? null : "various", "unknown")
  const groups = new Map<Term, Acquired[]>()
  for (const piece of row.acquired) {
    const term = termOf(piece.at, row.timestamp)
    groups.set(term, [...(groups.get(term) ?? []), piece])
  }
  const dates = (pieces: Acquired[]) => (pieces.some((piece) => piece.at === null) ? null : [...new Set(pieces.map((piece) => dateOf(piece.at as string)))])
  if (groups.size === 1) {
    const [[term, pieces]] = [...groups] as [[Term, Acquired[]]]
    return whole(dates(pieces), term)
  }
  // Split by units, with the last part taking what rounding leaves, so the parts add up to the row exactly.
  let proceedsLeft = proceeds
  const order: Term[] = ["short", "long", "unknown"]
  const present = order.filter((term) => groups.has(term))
  return present.map((term, i) => {
    const pieces = groups.get(term) as Acquired[]
    const partQty = pieces.reduce((sum, piece) => sum + BigInt(piece.qty), 0n)
    const partCost = pieces.reduce((sum, piece) => sum + BigInt(piece.costMicros), 0n)
    const share = proceeds === null || proceedsLeft === null ? null : i === present.length - 1 ? proceedsLeft : (proceeds * partQty) / qty
    if (proceedsLeft !== null && share !== null) proceedsLeft -= share
    return { row, qty: partQty, proceeds: share, cost: partCost, gain: share === null ? null : share - partCost, term, acquired: dates(pieces) }
  })
}

/** Sales and fees are what a form lists. Sending something away isn't a sale, so it stays in the generic report only. */
const listed = (rows: readonly TaxRow[]) => rows.filter((row) => row.type !== "Sent")

const money = (micros: bigint | null) => (micros === null ? "unknown" : microsCell(micros.toString()))

const usDate = (date: string) => `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`

const toCsv = (cells: string[][]) => `${cells.map((line) => line.map(csvCell).join(",")).join("\r\n")}\r\n`

/**
 * The total of the lines whose amounts are all known, and how many it leaves out. With lines and none of them known, there's no
 * total at all: adding up nothing would say $0, which nothing here says.
 */
function totalOf(lines: readonly Line[]) {
  const known = lines.filter((line) => line.proceeds !== null && line.cost !== null && line.gain !== null)
  const sum = (field: "proceeds" | "cost" | "gain") => (known.length === 0 && lines.length > 0 ? null : known.reduce((total, line) => total + (line[field] as bigint), 0n))
  return { proceeds: sum("proceeds"), cost: sum("cost"), gain: sum("gain"), counted: known.length, left: lines.length - known.length }
}

function leftOut({ counted, left }: { counted: number; left: number }): string {
  if (left === 0) return ""
  if (counted === 0) return `There's no total yet, because ${left === 1 ? "this line has" : `all ${left} lines have`} an unknown amount, which ${left === 1 ? "has" : "have"} to be worked out first.`
  return `Leaves out ${left} ${left === 1 ? "line" : "lines"} with an unknown amount, which ${left === 1 ? "has" : "have"} to be worked out first.`
}

const FORM_8949_HEADER = ["Part", "Box", "(a) Description of property", "(b) Date acquired", "(c) Date sold or disposed of", "(d) Proceeds", "(e) Cost or other basis", "(f) Code", "(g) Amount of adjustment", "(h) Gain or (loss)", "Status", "Notes", "Wallet", "Transaction"]

const PARTS: Record<Term, { part: string; box: string }> = {
  short: { part: "Part I (short-term)", box: "I" },
  long: { part: "Part II (long-term)", box: "L" },
  unknown: { part: "How long it was held isn't known", box: "" },
}

const FORM_8949_NOTES = [
  "Lines follow Form 8949. Box I and box L are for digital assets reported on no Form 1099-DA or 1099-B, which is usual for a wallet you hold yourself. If a broker sent you a Form 1099-DA for any of these, use the box it names instead.",
  "A sale of units held for different lengths of time is split into a short-term and a long-term line, with its proceeds shared by units. VARIOUS means several purchases.",
  "Dates are in UTC, so a sale late in the day may fall on the next day where you live.",
  "Sends to other addresses aren't sales, so they're only in the full report.",
]

const SCHEDULE_3_HEADER = ["Line", "Number of units and description", "Year of acquisition", "Proceeds of disposition", "Adjusted cost base", "Outlays and expenses", "Gain (or loss)", "Date of disposition (UTC)", "Status", "Notes", "Wallet", "Transaction"]

const SCHEDULE_3_NOTES = [
  "Lines follow Part 3 of Schedule 3: crypto-assets go on line 7, with total proceeds on line 15200 and the total gain or loss on line 15301.",
  "Network fees are their own lines rather than outlays and expenses, as in the full report, so that column is empty.",
  "Sends to other addresses aren't sales, so they're only in the full report.",
]

const statusOf = (row: TaxRow) => ({ resolved: "OK", estimated: "ESTIMATED", "self-reported": "SELF-REPORTED", unresolved: "UNKNOWN GAIN" })[row.status]

function form8949(rows: readonly TaxRow[], notes: readonly string[]): string {
  const lines = listed(rows).flatMap(linesOf)
  const noteLine = (note: string) => FORM_8949_HEADER.map((column) => (column === "Part" ? "Note" : column === "Notes" ? note : ""))
  const out: string[][] = [FORM_8949_HEADER, ...[...notes, ...FORM_8949_NOTES].map(noteLine)]
  for (const term of ["short", "long", "unknown"] as const) {
    const part = lines.filter((line) => line.term === term)
    if (part.length === 0) continue
    const { part: name, box } = PARTS[term]
    for (const line of part) {
      const acquired = line.acquired === null ? "unknown" : line.acquired === "various" || line.acquired.length > 1 ? "VARIOUS" : usDate(line.acquired[0] as string)
      out.push([name, box, `${unitsCell(line.qty.toString(), line.row.decimals)} ${line.row.asset}${line.row.type === "Network fee" ? " (network fee)" : ""}`, acquired, usDate(dateOf(line.row.timestamp)), money(line.proceeds), money(line.cost), "", "", money(line.gain), statusOf(line.row), line.row.reason ?? "", line.row.wallet, line.row.txHash])
    }
    // Lines whose holding period isn't known can't be added to either part.
    if (term === "unknown") continue
    const total = totalOf(part)
    out.push([name, box, "Total", "", "", money(total.proceeds), money(total.cost), "", "", money(total.gain), "", leftOut(total), "", ""])
  }
  return toCsv(out)
}

function schedule3(rows: readonly TaxRow[], notes: readonly string[]): string {
  const lines = listed(rows).flatMap(linesOf)
  const noteLine = (note: string) => SCHEDULE_3_HEADER.map((column) => (column === "Line" ? "Note" : column === "Notes" ? note : ""))
  const out: string[][] = [SCHEDULE_3_HEADER, ...[...notes, ...SCHEDULE_3_NOTES].map(noteLine)]
  for (const line of lines) {
    const years = Array.isArray(line.acquired) ? [...new Set(line.acquired.map((date) => date.slice(0, 4)))] : null
    const year = line.acquired === null ? "unknown" : years === null || years.length > 1 ? "Various" : (years[0] as string)
    out.push(["7", `${unitsCell(line.qty.toString(), line.row.decimals)} ${line.row.asset}${line.row.type === "Network fee" ? " (network fee)" : ""}`, year, money(line.proceeds), money(line.cost), "", money(line.gain), line.row.timestamp.slice(0, 19).replace("T", " "), statusOf(line.row), line.row.reason ?? "", line.row.wallet, line.row.txHash])
  }
  const total = totalOf(lines)
  const superficial = lines.filter((line) => line.row.lossRule !== undefined).length
  const totalNotes = [leftOut(total), superficial === 0 ? "" : `Includes ${superficial} ${superficial === 1 ? "loss that" : "losses that"} may be superficial, which may not be deductible.`].filter(Boolean).join(" ")
  out.push(["Total", "Proceeds go on line 15200 and the gain (or loss) on line 15301", "", money(total.proceeds), money(total.cost), "", money(total.gain), "", "", totalNotes, "", ""])
  return toCsv(out)
}

/**
 * The file in the shape of this country's form, or null when there's none. It's in the report's currency, which the
 * report warns about when that's not the country's.
 */
export function taxFormOf(country: TaxCountryCode, rows: readonly TaxRow[], notes: readonly string[], filename: string): TaxForm | null {
  const named = (form: string) => filename.replace(/^tax-report-/, `${form}-`)
  if (country === "US") return { name: "Form 8949", filename: named("form-8949"), csv: form8949(rows, notes) }
  if (country === "CA") return { name: "Schedule 3", filename: named("schedule-3"), csv: schedule3(rows, notes) }
  return null
}
