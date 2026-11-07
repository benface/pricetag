// The UK's matching rules, which decide what each disposal cost before anything is averaged. From official sources only:
// - HMRC Cryptoassets Manual CRYPTO22200: a disposal is matched first to tokens of the same type acquired the same day
//   (TCGA 1992 s. 105), then to those acquired in the 30 days after it (s. 106A), earliest disposal first, and only what's
//   left comes from the section 104 pool, at its average cost (s. 104). All of one day's acquisitions count as one, and so do
//   all of one day's disposals. CRYPTO22253 matches the earliest acquisitions in the 30 days first, and CRYPTO22256 works an
//   example of all three together, which a test reproduces.
// - CRYPTO22280: a fee paid in tokens is a disposal of those tokens in its own right, so a network fee is matched like a sale.
// - CRYPTO22100: moving tokens between your own wallets isn't a disposal. Giving them away is, unless it's to a spouse or
//   civil partner, so a send is taken from the pool without being matched, and its row says it isn't a sale.
//
// Matching looks ahead, so it can't be a plain fold. It plans every match by quantity first, then reuses the fold's own
// pieces: each acquisition is held apart until what's matched to it is gone, the rest joins the pool, and each disposal
// takes what it's matched to and the rest from the pool. Whatever is unknown about a piece stays with it.

import { applyLegTaking, effectOf, emptyPosition, type CostPiece, type FoldLeg, type LegEffect, type PositionState, type PricedLeg } from "@pricetag/sdk/core"

const DAY_MS = 86_400_000

/** British civil time, which the Summer Time Act 1972 (ss. 1 and 3) makes the time for anything a statute dates, so a UK day and tax year go by it. */
export const UK_TIME_ZONE = "Europe/London"

const formatters = new Map<string, Intl.DateTimeFormat>()

/** The calendar date this happened on in a time zone, as YYYY-MM-DD, which sorts as text. */
export function localDate(timestamp: string, timeZone = "UTC"): string {
  if (timeZone === "UTC") return new Date(timestamp).toISOString().slice(0, 10)
  let format = formatters.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    formatters.set(timeZone, format)
  }
  return format.format(new Date(timestamp))
}

/** When a calendar date starts in a time zone, as `toISOString` writes it. */
export function startOfDate(date: string, timeZone = "UTC"): string {
  const midnight = Date.parse(`${date}T00:00:00.000Z`)
  if (timeZone === "UTC") return new Date(midnight).toISOString()
  // A zone's offset is how far its clock is from UTC at that moment, and it can differ either side of the date's start.
  const offsetAt = (ms: number) => {
    const local = new Date(ms).toLocaleString("sv-SE", { timeZone }).replace(" ", "T")
    return Date.parse(`${local}Z`) - Math.floor(ms / 1000) * 1000
  }
  let guess = midnight - offsetAt(midnight)
  guess = midnight - offsetAt(guess)
  return new Date(guess).toISOString()
}

/** A day in a time zone, counted from 1970, so 30 days after is 30 more. */
export const dayNumber = (timestamp: string, timeZone = "UTC") => Math.floor(Date.parse(localDate(timestamp, timeZone)) / DAY_MS)

export type MatchedEffect = {
  /** The leg as it came, since its effect's leg leaves out an order that doesn't matter here. */
  leg: PricedLeg
  effect: LegEffect
  /** Part of its cost is what was acquired in the 30 days after it. */
  laterBuys: boolean
  /**
   * Why its cost may still change: its own day isn't all read yet, and all of a day's acquisitions count as one, so another buy
   * that day changes what it's matched to; or the 30 days after it aren't all read yet, so more could still be matched to it.
   */
  tentative: "day" | "30 days" | null
}

const carrying = (decimals: number, qty: bigint, orderUnknown?: FoldLeg["orderUnknown"]): FoldLeg => ({
  id: "matching",
  delta: (-qty).toString(),
  decimals,
  kind: "transfer",
  priceMicros: null,
  costMicros: null,
  proceedsMicros: null,
  costLabel: "unknown",
  ...(orderUnknown ? { orderUnknown } : {}),
})

/** Takes this much out, as pieces that keep what's known about their cost. Past what's held, a piece has no cost. */
function takeOut(state: PositionState, qty: bigint, orderUnknown?: FoldLeg["orderUnknown"]): { state: PositionState; pieces: CostPiece[]; shortfall: bigint } {
  if (qty <= 0n) return { state, pieces: [], shortfall: 0n }
  const applied = applyLegTaking(state, carrying(state.decimals, qty, orderUnknown))
  return { state: applied.state, pieces: applied.taken, shortfall: BigInt(applied.state.shortfallQty) - BigInt(state.shortfallQty) }
}

function putIn(state: PositionState, pieces: readonly CostPiece[]): PositionState {
  if (pieces.length === 0) return state
  const qty = pieces.reduce((sum, piece) => sum + BigInt(piece.qty), 0n)
  return applyLegTaking(state, { id: "matching", delta: qty.toString(), decimals: state.decimals, kind: "transfer", priceMicros: null, costMicros: null, proceedsMicros: null, costLabel: "inherited", pieces: [...pieces] }).state
}

function groupBy<T extends { day: number }>(items: readonly T[]): Map<number, T[]> {
  const days = new Map<number, T[]>()
  for (const item of items) {
    const list = days.get(item.day)
    if (list) list.push(item)
    else days.set(item.day, [item])
  }
  return days
}

const held = (state: PositionState) => state.lots.reduce((sum, lot) => sum + BigInt(lot.qty), 0n)

/** Acquired here, rather than already held or arriving from somewhere that knows when it was acquired. */
const acquiredHere = (leg: PricedLeg, label: string) => !leg.opening && (leg.kind === "swap" || label === "paid" || label === "received at market")

/**
 * What a credit brought that was acquired on a known day, which can be matched, and the rest, which only joins the pool. Order in a
 * block doesn't matter to a day's matching, so what's matched drops it. What joins the pool keeps it, since there it can.
 */
function splitCredit(leg: PricedLeg, timeZone: string): { acquired: { day: number; at: string; leg: PricedLeg }[]; pooled: PricedLeg | null } {
  const { orderUnknown: _, ...plain } = leg
  if (!leg.pieces) return acquiredHere(leg, leg.costLabel) ? { acquired: [{ day: dayNumber(leg.timestamp, timeZone), at: leg.timestamp, leg: plain }], pooled: null } : { acquired: [], pooled: leg }
  const acquired: { day: number; at: string; leg: PricedLeg }[] = []
  const pooled: CostPiece[] = []
  for (const piece of leg.pieces) {
    const at = piece.boughtAt || (piece.acquiredAt && !piece.undated ? piece.acquiredAt : null) || (!piece.undated && acquiredHere(leg, piece.label) ? leg.timestamp : null)
    if (at) acquired.push({ day: dayNumber(at, timeZone), at, leg: { ...plain, delta: piece.qty, pieces: [piece] } })
    else pooled.push(piece)
  }
  const pooledQty = pooled.reduce((sum, piece) => sum + BigInt(piece.qty), 0n)
  return { acquired, pooled: pooled.length === 0 ? null : { ...leg, delta: pooledQty.toString(), pieces: pooled } }
}

/** Shares of `total` in proportion to `parts`, each at most its part, adding up to `total` exactly. */
export function shares(parts: readonly bigint[], total: bigint): bigint[] {
  const whole = parts.reduce((sum, part) => sum + part, 0n)
  if (whole === 0n) return parts.map(() => 0n)
  const out = parts.map((part) => (part * total) / whole)
  let left = total - out.reduce((sum, share) => sum + share, 0n)
  for (let i = 0; left > 0n && i < out.length; i++) {
    const room = (parts[i] as bigint) - (out[i] as bigint)
    const more = room < left ? room : left
    out[i] = (out[i] as bigint) + more
    left -= more
  }
  return out
}

/** `joins` is the leg it joins the pool before: the first one after it was acquired, so what an exchange bought counts from its purchase, not its withdrawal. */
type Acquisition = { day: number; joins: number; leg: PricedLeg; qty: bigint }
type Disposal = { index: number; day: number; qty: bigint }

/**
 * Each debit's effect, in order, for one asset's legs in the order they happened. `readThroughDay` is the last day every wallet
 * here has been read to the end of, which says whether a disposal's day and the 30 days after it are all known. Days are in `timeZone`.
 */
function matchAsset(legs: readonly PricedLeg[], readThroughDay: number, timeZone: string): MatchedEffect[] {
  const decimals = (legs[0] as PricedLeg).decimals
  const empty = () => emptyPosition("average", decimals)
  const acquisitions: Acquisition[] = []
  const pooledCredits = new Map<number, PricedLeg>()
  const disposals: Disposal[] = []
  // The latest time up to each leg, which never decreases, so the first leg after a time is a binary search.
  const latest: number[] = []
  for (const leg of legs) latest.push(Math.max(Date.parse(leg.timestamp), latest.at(-1) ?? -Infinity))
  // The first leg after `at`, but never after the credit that brought it, which is where something acquired here joins.
  const joinsBefore = (at: string, arrival: number) => {
    const ms = Date.parse(at)
    if (!(ms < (latest[arrival] as number))) return arrival
    let low = 0
    let high = arrival
    while (low < high) {
      const mid = (low + high) >> 1
      if ((latest[mid] as number) > ms) high = mid
      else low = mid + 1
    }
    return low
  }
  legs.forEach((leg, index) => {
    const delta = BigInt(leg.delta)
    if (delta > 0n) {
      const { acquired, pooled } = splitCredit(leg, timeZone)
      for (const { at, ...part } of acquired) acquisitions.push({ ...part, joins: joinsBefore(at, index), qty: BigInt(part.leg.delta) })
      if (pooled) pooledCredits.set(index, pooled)
    } else if (delta < 0n && leg.kind !== "transfer") disposals.push({ index, day: dayNumber(leg.timestamp, timeZone), qty: -delta })
  })

  // The plan, by quantity: each day's acquisitions and disposals, then what's matched the same day and in the 30 days after.
  const sumBy = <T extends { day: number; qty: bigint }>(items: readonly T[]) => items.reduce((days, item) => days.set(item.day, (days.get(item.day) ?? 0n) + item.qty), new Map<number, bigint>())
  const acquiredOn = sumBy(acquisitions)
  const disposedOn = sumBy(disposals)
  const acquiredLeft = new Map(acquiredOn)
  const disposedLeft = new Map(disposedOn)
  const sameDay = new Map<number, bigint>()
  for (const [day, disposed] of disposedOn) {
    const acquired = acquiredOn.get(day) ?? 0n
    const matched = acquired < disposed ? acquired : disposed
    sameDay.set(day, matched)
    acquiredLeft.set(day, acquired - matched)
    disposedLeft.set(day, disposed - matched)
  }
  const acquisitionDays = [...acquiredOn.keys()].sort((a, b) => a - b)
  const later = new Map<number, { day: number; qty: bigint }[]>()
  for (const day of [...disposedOn.keys()].sort((a, b) => a - b)) {
    for (const next of acquisitionDays) {
      const want = disposedLeft.get(day) as bigint
      if (want === 0n || next > day + 30) break
      if (next <= day) continue
      const free = acquiredLeft.get(next) as bigint
      const matched = free < want ? free : want
      if (matched === 0n) continue
      later.set(day, (later.get(day) ?? []).concat({ day: next, qty: matched }))
      acquiredLeft.set(next, free - matched)
      disposedLeft.set(day, want - matched)
    }
  }

  // Each acquisition splits into what joins the pool when it's acquired, and what's held for its day's matches, which all of
  // that day's acquisitions share, as one acquisition.
  const toPool = new Map<number, CostPiece[]>()
  const forMatches = new Map<number, PositionState>()
  for (const [day, ofDay] of groupBy(acquisitions)) {
    const leftovers = shares(ofDay.map(({ qty }) => qty), acquiredLeft.get(day) as bigint)
    let reserved = empty()
    ofDay.forEach((acquisition, i) => {
      const alone = applyLegTaking(empty(), acquisition.leg).state
      const pooled = takeOut(alone, leftovers[i] as bigint)
      toPool.set(acquisition.joins, (toPool.get(acquisition.joins) ?? []).concat(pooled.pieces))
      reserved = putIn(reserved, takeOut(pooled.state, held(pooled.state)).pieces)
    })
    forMatches.set(day, reserved)
  }
  const draw = (day: number, qty: bigint): CostPiece[] => {
    if (qty === 0n) return []
    const taken = takeOut(forMatches.get(day) as PositionState, qty)
    forMatches.set(day, taken.state)
    return taken.pieces
  }

  // What each disposal is matched to, shared among a day's disposals by how much each disposed of, since they count as one.
  const matchedFor = new Map<number, { pieces: CostPiece[]; laterBuys: boolean; tentative: MatchedEffect["tentative"] }>()
  const disposalsOn = groupBy(disposals)
  for (const day of [...disposedOn.keys()].sort((a, b) => a - b)) {
    const matches = later.get(day) ?? []
    let matched = putIn(empty(), draw(day, sameDay.get(day) as bigint))
    for (const match of matches) matched = putIn(matched, draw(match.day, match.qty))
    const ofDay = disposalsOn.get(day) as Disposal[]
    const parts = shares(ofDay.map(({ qty }) => qty), held(matched))
    const tentative = day > readThroughDay ? "day" : (disposedOn.get(day) as bigint) > (sameDay.get(day) as bigint) && day + 30 > readThroughDay ? "30 days" : null
    ofDay.forEach((disposal, i) => {
      const taken = takeOut(matched, parts[i] as bigint)
      matched = taken.state
      matchedFor.set(disposal.index, { pieces: taken.pieces, laterBuys: matches.length > 0 && (parts[i] as bigint) > 0n, tentative })
    })
  }

  // Then in order, so the pool is what was held at each moment.
  let pool = empty()
  const effects: MatchedEffect[] = []
  legs.forEach((leg, index) => {
    const delta = BigInt(leg.delta)
    // What was acquired before this leg joins first, whatever this leg is, and is only ever added once.
    pool = putIn(pool, toPool.get(index) ?? [])
    if (delta > 0n) {
      const pooled = pooledCredits.get(index)
      if (pooled) pool = applyLegTaking(pool, pooled).state
      return
    }
    if (delta === 0n) return
    const matched = matchedFor.get(index) ?? { pieces: [], laterBuys: false, tentative: null }
    const matchedQty = matched.pieces.reduce((sum, piece) => sum + BigInt(piece.qty), 0n)
    const fromPool = takeOut(pool, -delta - matchedQty, leg.orderUnknown === "always" ? "always" : undefined)
    pool = fromPool.state
    const { orderUnknown: _, ...plain } = leg
    const before = putIn(empty(), [...matched.pieces, ...fromPool.pieces])
    const effect = effectOf(plain, before, applyLegTaking(before, plain))
    effects.push({ leg, effect: { ...effect, after: { ...effect.after, shortfallQty: (BigInt(effect.after.shortfallQty) + fromPool.shortfall).toString() } }, laterBuys: matched.laterBuys, tentative: matched.tentative })
  })
  return effects
}

/** Every debit's effect under the UK's rules, by asset, with days in UK time. Legs are in the order they happened, as the fold reads them. */
export function matchUk(legs: readonly PricedLeg[], readThroughDay: number, timeZone = UK_TIME_ZONE): { asset: string; effects: MatchedEffect[] }[] {
  const byAsset = new Map<string, PricedLeg[]>()
  for (const leg of legs) {
    const list = byAsset.get(leg.asset)
    if (list) list.push(leg)
    else byAsset.set(leg.asset, [leg])
  }
  return [...byAsset].map(([asset, assetLegs]) => ({ asset, effects: matchAsset(assetLegs, readThroughDay, timeZone) }))
}
