// Reads a Coinbase transaction history CSV, to find what each withdrawal cost. A withdrawal it can't price exactly is left
// out rather than guessed: it stays a question. Nothing in a file says whether it starts at the account's beginning, and what
// was bought before it changes every cost in it, so only the person who downloaded it can vouch for that.

import { sha256 } from "@noble/hashes/sha2"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils"
import { ASSETS, decimalsOf, isAddress, normalizeAddress, type CurrencyCode } from "@pricetag/sdk/core"
import { MAX_EXCHANGE_LOTS, type Book, type ExchangeLot, type ExchangeWithdrawal } from "./book.ts"
import { unitsOfDecimal } from "./decimal.ts"

export type ExchangeImport = {
  withdrawals: ExchangeWithdrawal[]
  /** Withdrawals with no usable cost: bought in a currency this can't read, in several at once, or with a history it can't follow. */
  skipped: number
  /** When each asset first shows up in the file, since what came before that is out of its sight. */
  firstSeen: Record<string, string>
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
  if (!/^\d*(\.\d*)?$/.test(clean) || clean === "" || clean === ".") return null
  return unitsOfDecimal(clean, decimals)
}

const BUYS = new Set(["buy", "advanced trade buy", "advance trade buy"])
const SELLS = new Set(["sell", "advanced trade sell", "advance trade sell"])
const SENDS = new Set(["send", "withdrawal"])

/** Nobody has seen an export from a European account, and "1.234,50" would read as 1.2345 here, so those stay out rather than read wrong. */
const READABLE: ReadonlySet<string> = new Set(["USD", "CAD"])
const isReadable = (currency: string): currency is CurrencyCode => READABLE.has(currency)

/**
 * Bought at one moment, which is one lot however many rows it took, because a file doesn't say which of them came first. When
 * they were at different prices, what part of it cost depends on that, so only all of it has a cost. Null: part of it has gone.
 */
type Lot = { at: number; units: bigint; cost: bigint | null; tied: boolean }

/** A sale or a withdrawal waiting for the rest of its moment, since a file doesn't say which of those came first either. */
type Disposal = { at: number; units: bigint; withdrawal: ExchangeWithdrawal | null }

/** How many more steps can go on trying orders. Counted down, so it can be shared. */
type Budget = { left: number }

/** `oldest` is where the lots still left start. Moving it is what taking one costs, however many there are. */
type Pool = { units: bigint; cost: bigint; lots: Lot[]; oldest: number; disposals: Disposal[]; known: boolean; currency: CurrencyCode | null; budget: Budget }

function addLot(lots: Lot[], at: number, units: bigint, cost: bigint) {
  const last = lots.at(-1)
  if (last?.at !== at || last.cost === null) lots.push({ at, units, cost, tied: false })
  else {
    last.tied ||= last.cost * units !== cost * last.units
    last.units += units
    last.cost += cost
  }
}

/** Part of a lot, as taken: how much, what it cost, when it was bought, and whether a file says which came first within it. */
type Part = { at: number; units: bigint; cost: bigint; tied: boolean }

/** What these units cost lot by lot, this far along the lots. Null when that can't be said, or the budget ran out before it could. */
function partsAlong({ lots, oldest }: Pool, from: bigint, units: bigint, budget: Budget): Part[] | null {
  const parts: Part[] = []
  let known = true
  let skip = from
  let left = units
  for (let i = oldest; i < lots.length && left > 0n; i++) {
    if (--budget.left < 0) return null
    const lot = lots[i] as Lot
    if (skip >= lot.units) {
      skip -= lot.units
      continue
    }
    const taken = left < lot.units - skip ? left : lot.units - skip
    if (lot.cost === null || (lot.tied && taken < lot.units)) known = false
    else parts.push({ at: lot.at, units: taken, cost: (lot.cost * taken) / lot.units, tied: lot.tied })
    skip = 0n
    left -= taken
  }
  return known ? parts : null
}

const costOf = (parts: readonly Part[]) => parts.reduce((sum, { cost }) => sum + cost, 0n)

const within = (a: bigint, b: bigint, rounding: bigint) => a - b <= rounding && b - a <= rounding

const sameParts = (a: readonly Part[], b: readonly Part[], rounding: bigint) => a.length === b.length && a.every(({ at, units, cost, tied }, i) => at === b[i]?.at && units === b[i]?.units && tied === b[i]?.tied && within(cost, b[i].cost, rounding))

/** Takes the oldest of these units, which leaves the rest. Rounding never loses any, because taking a whole lot takes all of its cost. */
function takeOldest(pool: Pool, units: bigint) {
  for (let left = units; left > 0n; ) {
    const lot = pool.lots[pool.oldest] as Lot
    const taken = left < lot.units ? left : lot.units
    const cost = lot.cost === null || (lot.tied && taken < lot.units) ? null : (lot.cost * taken) / lot.units
    lot.cost = lot.cost === null || cost === null ? null : lot.cost - cost
    lot.units -= taken
    left -= taken
    if (lot.units === 0n) pool.oldest++
  }
}

/** Past this many, a moment has too many possible orders to try, so what's in it has no oldest-first cost unless it's alone. */
const MAX_POSITIONS = 4096

/**
 * How much trying orders an asset gets in one file, so a crowded file can't hold up whoever's reading it. It's per asset and in
 * size order, so neither another asset nor the file's order can change an answer. Far more than any real history should need.
 */
const MAX_STEPS = 500_000

/**
 * How far along the lots something this size could start, depending on which of its moment's others went before it. Null when
 * that's too many to try. Each round only goes on from what the last one newly reached, so many of one size cost little.
 */
function positionsAfter(moment: ReadonlyMap<bigint, number>, size: bigint, budget: Budget): bigint[] | null {
  const positions = new Set([0n])
  for (const [units, count] of moment) {
    let newest = [...positions]
    for (let round = units === size ? 1 : 0; round < count && newest.length > 0; round++) {
      const reached: bigint[] = []
      for (const position of newest) {
        if (--budget.left < 0) return null
        if (positions.has(position + units)) continue
        positions.add(position + units)
        reached.push(position + units)
      }
      if (positions.size > MAX_POSITIONS) return null
      newest = reached
    }
  }
  return [...positions]
}

/**
 * What a withdrawal this size cost oldest first, when that's the same whichever of its moment's other disposals went first.
 * Otherwise null. Dividing a lot can round differently from one position to the next, by up to a millionth per lot, which isn't
 * a different cost. The same total can come from different purchases, and then only all of it has that cost, with no one date,
 * as it does when there are too many lots to keep.
 */
function costInAnyOrder(pool: Pool, moment: ReadonlyMap<bigint, number>, size: bigint, budget: Budget): { cost: bigint; lots: ExchangeLot[] } | null {
  const positions = positionsAfter(moment, size, budget)
  if (positions === null) return null
  const first = partsAlong(pool, 0n, size, budget)
  if (first === null) return null
  const cost = costOf(first)
  const rounding = BigInt(pool.lots.length - pool.oldest)
  let settled = first.length <= MAX_EXCHANGE_LOTS
  for (const position of positions) {
    const parts = partsAlong(pool, position, size, budget)
    if (parts === null || !within(costOf(parts), cost, rounding)) return null
    settled &&= sameParts(first, parts, rounding)
  }
  const lots = settled ? first.map((part) => ({ units: part.units.toString(), micros: part.cost.toString(), at: new Date(part.at).toISOString(), ...(part.tied ? { wholeCostOnly: true as const } : {}) })) : [{ units: size.toString(), micros: cost.toString(), wholeCostOnly: true as const }]
  return { cost, lots }
}

/**
 * Settles a moment once all of it is in, purchases included, which are the newest lot by then. Whatever order its disposals went
 * in, together they took the oldest of what was there, so what's left is the same, even when the budget ran out on what each of
 * them cost. Withdrawals the same size have the same answer, so it's only worked out once. A disposal alone has no orders to try,
 * and only looks at lots it's about to take, so it needs no budget. An asset whose history stopped adding up has no costs from
 * here on, so there's nothing left to work out, and its lots may not cover what went out.
 */
function settleDisposals(pool: Pool) {
  const { disposals } = pool
  pool.disposals = []
  if (!pool.known) return
  const counts = new Map<bigint, number>()
  for (const { units } of disposals) counts.set(units, (counts.get(units) ?? 0) + 1)
  const moment = new Map([...counts].sort(([a], [b]) => (a < b ? -1 : 1)))
  const withdrawn = new Set(disposals.filter(({ withdrawal }) => withdrawal).map(({ units }) => units))
  const budget = disposals.length > 1 ? pool.budget : { left: Infinity }
  const costs = new Map<bigint, { cost: bigint; lots: ExchangeLot[] } | null>()
  for (const size of moment.keys()) if (withdrawn.has(size)) costs.set(size, costInAnyOrder(pool, moment, size, budget))
  for (const { units, withdrawal } of disposals) {
    const found = costs.get(units) ?? null
    if (withdrawal && found) {
      withdrawal.fifoCostMicros = found.cost.toString()
      withdrawal.fifoLots = found.lots
    }
  }
  takeOldest(pool, disposals.reduce((sum, { units }) => sum + units, 0n))
}

export function parseCoinbaseCsv(text: string): ExchangeImport | null {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/)
  // Coinbase puts a few lines about the account before the header.
  const headerAt = lines.findIndex((line) => /(^|,)Timestamp(,|$)/.test(line) && /Transaction Type/.test(line))
  if (headerAt < 0) return null
  const fileId = bytesToHex(sha256(utf8ToBytes(text)))
  const header = parseCsvLine(lines[headerAt] as string).map((h) => h.trim().toLowerCase())
  const column = (start: string) => header.findIndex((h) => h.startsWith(start))
  const at = { time: column("timestamp"), type: column("transaction type"), asset: column("asset"), qty: column("quantity"), currency: header.findIndex((h) => h.endsWith("currency")), total: column("total"), notes: column("notes") }
  if (at.time < 0 || at.type < 0 || at.asset < 0 || at.qty < 0 || at.total < 0) return null

  const parsed = lines
    .slice(headerAt + 1)
    .filter((line) => line.trim() !== "")
    .map(parseCsvLine)
    .map((cells) => ({ cells, time: Date.parse((cells[at.time] ?? "").replace(" UTC", "Z").replace(" ", "T")) }))

  const pools = new Map<string, Pool>()
  const firstSeen: Record<string, string> = {}
  const withdrawals: ExchangeWithdrawal[] = []
  let skipped = 0
  const assetOf = (cells: string[]) => {
    const symbol = (cells[at.asset] ?? "").trim()
    return symbol === "WETH" ? "ETH" : symbol
  }
  const typeOf = (cells: string[]) => (cells[at.type] ?? "").trim().toLowerCase()
  const poolOf = (asset: string) => {
    const pool = pools.get(asset) ?? { units: 0n, cost: 0n, lots: [], oldest: 0, disposals: [], known: true, currency: null, budget: { left: MAX_STEPS } }
    pools.set(asset, pool)
    return pool
  }
  // A row with no readable time can't be put in order, so it could be behind any of that asset's costs.
  for (const { cells } of parsed.filter((row) => Number.isNaN(row.time))) {
    if (!ASSETS.includes(assetOf(cells))) continue
    poolOf(assetOf(cells)).known = false
    if (SENDS.has(typeOf(cells))) skipped++
  }
  for (const { cells, time } of parsed.filter((row) => !Number.isNaN(row.time)).sort((a, b) => a.time - b.time)) {
    const asset = assetOf(cells)
    if (!ASSETS.includes(asset)) continue
    firstSeen[asset] ??= new Date(time).toISOString()
    const decimals = decimalsOf(asset)
    const units = unitsOf(cells[at.qty] ?? "", decimals)
    const type = typeOf(cells)
    const pool = poolOf(asset)
    if (pool.disposals[0]?.at !== time) settleDisposals(pool)
    const currency = at.currency < 0 ? "USD" : (cells[at.currency] ?? "").trim().toUpperCase()
    if (units === 0n) continue
    if (units === null) {
      // How much moved is anyone's guess, and so is what's left and what it cost.
      pool.known = false
      if (SENDS.has(type)) skipped++
      continue
    }
    if (BUYS.has(type)) {
      const total = unitsOf(cells[at.total] ?? "", 6)
      // Adding up two currencies would need a rate at each purchase, so a mix has no usable cost.
      if (total === null || !isReadable(currency) || (pool.currency !== null && pool.currency !== currency)) pool.known = false
      else {
        pool.cost += total
        pool.currency = currency
        addLot(pool.lots, time, units, total)
      }
      pool.units += units
    } else if (SELLS.has(type) || SENDS.has(type)) {
      const enough = pool.known && pool.currency !== null && units <= pool.units && pool.units > 0n
      const cost = enough ? (pool.cost * units) / pool.units : 0n
      let withdrawal: ExchangeWithdrawal | null = null
      if (SENDS.has(type)) {
        if (enough) {
          const to = (cells[at.notes] ?? "").match(/0x[0-9a-fA-F]{40}/)?.[0]
          withdrawal = { exchange: "Coinbase", asset, units: units.toString(), at: new Date(time).toISOString(), cost: { micros: cost.toString(), currency: pool.currency as CurrencyCode }, fifoCostMicros: null, fileId, toAddress: to && isAddress(to) ? normalizeAddress(to) : null }
          withdrawals.push(withdrawal)
        } else skipped++
      }
      pool.disposals.push({ at: time, units, withdrawal })
      // More went out than this history shows coming in, so it's missing something, and no cost after this can be trusted.
      if (units > pool.units) pool.known = false
      pool.cost -= cost
      pool.units = units <= pool.units ? pool.units - units : 0n
    } else {
      // A receive, a conversion or a reward: units whose cost this history doesn't say, so what follows can't be priced.
      pool.known = false
      pool.units += units
    }
  }
  for (const pool of pools.values()) settleDisposals(pool)
  return { withdrawals, skipped, firstSeen }
}

/** Where the file starts: the first date to ask someone about. */
export const importStart = ({ firstSeen }: ExchangeImport): string | null => Object.values(firstSeen).sort()[0] ?? null

/** A withdrawal already imported from before the file starts proves the file isn't the whole history, whatever anyone says about it. */
export const startsAfterImported = (earlier: readonly ExchangeWithdrawal[], { withdrawals, firstSeen }: ExchangeImport): boolean =>
  withdrawals.some(({ asset }) => earlier.some((withdrawal) => withdrawal.asset === asset && Date.parse(withdrawal.at) < Date.parse(firstSeen[asset] as string)))

const withdrawalKey = ({ exchange, asset, units, at, toAddress }: ExchangeWithdrawal) => JSON.stringify([exchange, asset, units, at, toAddress])

/**
 * What an import adds to what earlier ones found. A file that has the same withdrawal again takes over for it, since it's the
 * latest word on what it cost. Two alike in one file are two withdrawals, so both stay.
 */
export function mergeWithdrawals(earlier: readonly ExchangeWithdrawal[], found: readonly ExchangeWithdrawal[]): ExchangeWithdrawal[] {
  const again = new Set(found.map(withdrawalKey))
  return [...earlier.filter((withdrawal) => !again.has(withdrawalKey(withdrawal))), ...found]
}

/**
 * What the book becomes once someone vouches for a file. It's checked against the book as it is now, since what proves the file
 * partial can have been saved while it waited for an answer, and then the book stays as it is.
 */
export const keepingImport = (latest: Book, imported: ExchangeImport): Book => (startsAfterImported(latest.withdrawals, imported) ? latest : { ...latest, withdrawals: mergeWithdrawals(latest.withdrawals, imported.withdrawals) })

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
