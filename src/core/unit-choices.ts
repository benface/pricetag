// Reads records the user kept of which units each sale or send took, so a US tax report can use them. US rules only count units
// named no later than the date and time of the sale (Treas. Reg. 1.1012-1(j)(2)), so each record says when it was made, and the
// report only uses one made in time. The chain can't confirm that moment, so the records are the user's to keep.
//
// One row per purchase a sale or send took from:
//   Recorded at, Wallet, Transaction, Asset, Bought on, Amount
// "Bought on" is a UTC day (2026-03-01), which means everything bought that day, or a moment (2026-03-01T14:05:09Z). "Amount" is
// in whole tokens, like 0.25. Rows with the same wallet, transaction and asset are one record.

import { isAddress, normalizeAddress, tokenBySymbol } from "@pricetag/sdk/core"
import { MAX_CHOICE_TAKES, onCalendar, parseUnitChoice, type UnitChoice } from "./book.ts"
import { parseCsvLine } from "./exchange-import.ts"

export const UNIT_CHOICE_COLUMNS = ["Recorded at", "Wallet", "Transaction", "Asset", "Bought on", "Amount"] as const

export type UnitChoiceImport = {
  choices: UnitChoice[]
  /** Rows that couldn't be read, by their line number in the file. A record with one of them is left out whole, never used in part. */
  skipped: number[]
}

/** Whole tokens like "0.25" in the token's smallest units, or null when it isn't an amount, or is finer than the token goes. */
function unitsOf(text: string, decimals: number): bigint | null {
  const clean = text.replace(/[,\s]/g, "")
  const match = /^(\d*)(?:\.(\d*))?$/.exec(clean)
  if (!match || clean === "" || clean === ".") return null
  const [, whole = "", fraction = ""] = match
  if (fraction.length > decimals) return null
  const units = BigInt(`${whole || "0"}${fraction.padEnd(decimals, "0")}`)
  return units > 0n ? units : null
}

/** A moment as `toISOString` writes it, or a UTC day as it was given. */
function boughtAtOf(text: string): string | null {
  const clean = text.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) return onCalendar(clean) ? clean : null
  return momentOf(clean)
}

/** Only with a time zone, since a moment without one could be any of a day's worth of them. */
function momentOf(text: string): string | null {
  const clean = text.trim()
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(clean) || !onCalendar(clean)) return null
  const ms = Date.parse(clean.replace(" ", "T"))
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

type Draft = { choice: UnitChoice; lines: number[]; bad: boolean }

/** The records in a CSV file, or null when it isn't one with these columns. */
export function parseUnitChoicesCsv(text: string): UnitChoiceImport | null {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/)
  const headerAt = lines.findIndex((line) => line.trim() !== "")
  if (headerAt < 0) return null
  const header = parseCsvLine(lines[headerAt] as string).map((cell) => cell.trim().toLowerCase())
  const column = UNIT_CHOICE_COLUMNS.map((name) => header.indexOf(name.toLowerCase()))
  if (column.some((at) => at < 0)) return null
  const [recordedCol, walletCol, txCol, assetCol, boughtCol, amountCol] = column as [number, number, number, number, number, number]

  const drafts = new Map<string, Draft>()
  const skipped: number[] = []
  for (let i = headerAt + 1; i < lines.length; i++) {
    const line = lines[i] as string
    if (line.trim() === "") continue
    const cells = parseCsvLine(line).map((cell) => cell.trim())
    const wallet = cells[walletCol] ?? ""
    const txHash = (cells[txCol] ?? "").toLowerCase()
    const asset = cells[assetCol] ?? ""
    const token = tokenBySymbol(asset)
    const recordedAt = momentOf(cells[recordedCol] ?? "")
    const boughtAt = boughtAtOf(cells[boughtCol] ?? "")
    const units = token ? unitsOf(cells[amountCol] ?? "", token.decimals) : null
    if (!isAddress(wallet) || !/^0x[0-9a-f]{64}$/.test(txHash) || !token) {
      skipped.push(i + 1)
      continue
    }
    const key = `${normalizeAddress(wallet)}:${txHash}:${token.asset}`
    const draft = drafts.get(key) ?? { choice: { wallet: normalizeAddress(wallet), txHash, asset: token.asset, recordedAt: recordedAt ?? "", takes: [] }, lines: [], bad: false }
    draft.lines.push(i + 1)
    if (recordedAt === null || boughtAt === null || units === null) draft.bad = true
    else {
      // A record isn't whole until its last row is, so it was made when the latest of them was.
      if (recordedAt > draft.choice.recordedAt) draft.choice.recordedAt = recordedAt
      draft.choice.takes.push({ boughtAt, units: units.toString() })
    }
    drafts.set(key, draft)
  }

  const choices: UnitChoice[] = []
  for (const { choice, lines: at, bad } of drafts.values()) {
    const parsed = bad || choice.takes.length > MAX_CHOICE_TAKES ? null : parseUnitChoice(choice)
    if (parsed) choices.push(parsed)
    else skipped.push(...at)
  }
  return { choices, skipped: skipped.sort((a, b) => a - b) }
}
