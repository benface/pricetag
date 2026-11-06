// Reads a Coinbase transaction history CSV, to find what each withdrawal cost. A withdrawal it can't price exactly is left
// out rather than guessed: it stays a question.

import { ASSETS, decimalsOf, isAddress, normalizeAddress, type CurrencyCode } from "@pricetag/sdk/core"
import type { ExchangeWithdrawal } from "./book.ts"

export type ExchangeImport = {
  withdrawals: ExchangeWithdrawal[]
  /** Withdrawals with no usable cost: bought in a currency this can't read, in several at once, or with a history it can't follow. */
  skipped: number
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let cell = ""
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted && c === '"' && line[i + 1] === '"') {
      cell += '"'
      i++
    } else if (c === '"') quoted = !quoted
    else if (c === "," && !quoted) {
      cells.push(cell)
      cell = ""
    } else cell += c
  }
  return [...cells, cell]
}

/** Whole units from a decimal string like "1,234.50", without going through a float. Null when it isn't one. */
function unitsOf(text: string, decimals: number): bigint | null {
  const clean = text.replace(/[$,\s]/g, "").replace(/^-/, "")
  const match = /^(\d*)(?:\.(\d*))?$/.exec(clean)
  if (!match || clean === "" || clean === ".") return null
  const fraction = (match[2] ?? "").slice(0, decimals).padEnd(decimals, "0")
  return BigInt(`${match[1] || "0"}${fraction}`)
}

const BUYS = new Set(["buy", "advanced trade buy", "advance trade buy"])
const SELLS = new Set(["sell", "advanced trade sell", "advance trade sell"])
const SENDS = new Set(["send", "withdrawal"])

/** Nobody has seen an export from a European account, and "1.234,50" would read as 1.2345 here, so those stay out rather than read wrong. */
const READABLE: ReadonlySet<string> = new Set(["USD", "CAD"])
const isReadable = (currency: string): currency is CurrencyCode => READABLE.has(currency)

type Pool = { units: bigint; cost: bigint; known: boolean; currency: CurrencyCode | null }

export function parseCoinbaseCsv(text: string): ExchangeImport | null {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/)
  // Coinbase puts a few lines about the account before the header.
  const headerAt = lines.findIndex((line) => /(^|,)Timestamp(,|$)/.test(line) && /Transaction Type/.test(line))
  if (headerAt < 0) return null
  const header = parseCsvLine(lines[headerAt] as string).map((h) => h.trim().toLowerCase())
  const column = (start: string) => header.findIndex((h) => h.startsWith(start))
  const at = { time: column("timestamp"), type: column("transaction type"), asset: column("asset"), qty: column("quantity"), currency: header.findIndex((h) => h.endsWith("currency")), total: column("total"), notes: column("notes") }
  if (at.time < 0 || at.type < 0 || at.asset < 0 || at.qty < 0 || at.total < 0) return null

  const rows = lines
    .slice(headerAt + 1)
    .filter((line) => line.trim() !== "")
    .map(parseCsvLine)
    .map((cells) => ({ cells, time: Date.parse((cells[at.time] ?? "").replace(" UTC", "Z").replace(" ", "T")) }))
    .filter((row) => !Number.isNaN(row.time))
    .sort((a, b) => a.time - b.time)

  const pools = new Map<string, Pool>()
  const withdrawals: ExchangeWithdrawal[] = []
  let skipped = 0
  for (const { cells, time } of rows) {
    const symbol = (cells[at.asset] ?? "").trim()
    const asset = symbol === "WETH" ? "ETH" : symbol
    if (!ASSETS.includes(asset)) continue
    const decimals = decimalsOf(asset)
    const units = unitsOf(cells[at.qty] ?? "", decimals)
    const type = (cells[at.type] ?? "").trim().toLowerCase()
    const pool = pools.get(asset) ?? { units: 0n, cost: 0n, known: true, currency: null }
    pools.set(asset, pool)
    const currency = at.currency < 0 ? "USD" : (cells[at.currency] ?? "").trim().toUpperCase()
    if (units === null || units === 0n) continue
    if (BUYS.has(type)) {
      const total = unitsOf(cells[at.total] ?? "", 6)
      // Adding up two currencies would need a rate at each purchase, so a mix has no usable cost.
      if (total === null || !isReadable(currency) || (pool.currency !== null && pool.currency !== currency)) pool.known = false
      else {
        pool.cost += total
        pool.currency = currency
      }
      pool.units += units
    } else if (SELLS.has(type) || SENDS.has(type)) {
      const enough = pool.known && pool.currency !== null && units <= pool.units && pool.units > 0n
      const cost = enough ? (pool.cost * units) / pool.units : 0n
      if (SENDS.has(type)) {
        if (enough) {
          const to = (cells[at.notes] ?? "").match(/0x[0-9a-fA-F]{40}/)?.[0]
          withdrawals.push({ exchange: "Coinbase", asset, units: units.toString(), at: new Date(time).toISOString(), cost: { micros: cost.toString(), currency: pool.currency as CurrencyCode }, toAddress: to && isAddress(to) ? normalizeAddress(to) : null })
        } else skipped++
      }
      pool.cost -= cost
      pool.units = units <= pool.units ? pool.units - units : 0n
    } else {
      // A receive, a conversion or a reward: units whose cost this history doesn't say, so what follows can't be priced.
      pool.known = false
      pool.units += units
    }
  }
  return { withdrawals, skipped }
}

const MATCH_BEFORE_MS = 5 * 60_000
const MATCH_AFTER_MS = 60 * 60_000

/** Something that arrived and might be a withdrawal. */
export type ExchangeArrival = { key: string; wallet: string; asset: string; units: bigint; timestamp: string }

export function fits(withdrawal: ExchangeWithdrawal, { wallet, asset, units, timestamp }: Omit<ExchangeArrival, "key">): boolean {
  const sent = BigInt(withdrawal.units)
  const after = Date.parse(timestamp) - Date.parse(withdrawal.at)
  if (withdrawal.asset !== asset || after < -MATCH_BEFORE_MS || after > MATCH_AFTER_MS) return false
  if (withdrawal.toAddress !== null && withdrawal.toAddress !== normalizeAddress(wallet)) return false
  return units <= sent && units * 100n >= sent * 99n
}

/**
 * Which withdrawal explains what arrived: same asset, close in time, and the same amount less at most 1% for the network fee.
 * Each withdrawal explains one arrival, and only when neither has another that fits. Choosing between them would be a guess,
 * and letting a withdrawal explain two would count what it cost twice.
 */
export function matchWithdrawals(withdrawals: readonly ExchangeWithdrawal[], arrivals: readonly ExchangeArrival[]): Map<string, ExchangeWithdrawal> {
  const matches = new Map<string, ExchangeWithdrawal>()
  for (const arrival of arrivals) {
    const fitting = withdrawals.filter((w) => fits(w, arrival))
    const [withdrawal] = fitting
    if (withdrawal && fitting.length === 1 && arrivals.filter((a) => fits(withdrawal, a)).length === 1) matches.set(arrival.key, withdrawal)
  }
  return matches
}
