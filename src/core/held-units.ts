// What a wallet holds of an asset, one row per purchase, so a send can name which units it takes as it's signed. US rules only
// count units named no later than the sale (Treas. Reg. 1.1012-1(j)(2)), and a choice made before the transaction exists is one
// the app itself can vouch for. A row is named by when it was bought, which is what `UnitChoice.takes` and the fold go by.

import type { Lot, Method } from "@pricetag/sdk/core"
import { normalizeAddress } from "@pricetag/sdk/core"
import type { WalletResponse } from "./api.ts"
import { MAX_CHOICE_TAKES, type Book, type UnitChoice } from "./book.ts"
import { foldBook } from "./resolve.ts"

/** US rules go oldest first in each wallet unless units are named, so what's held is what that leaves. */
export const HELD_METHOD: Method = "fifo"

export type HeldPurchase = {
  /** When it was bought, as `toISOString` writes it: an exchange's purchase date when there is one, and otherwise when it arrived. */
  boughtAt: string
  units: bigint
  /** What all of it cost, or null when that's unknown. */
  costMicros: bigint | null
  /** Bought at that moment at different costs, so only all of it can be named, since naming part doesn't say which. */
  allOnly: boolean
}

export type Held = {
  /** Oldest first. */
  purchases: HeldPurchase[]
  /** Units nothing can name, because nothing says when they were bought, or where they come among the rest. */
  unnamed: bigint
}

/** Whether two lots cost the same per unit. Dividing a cost can round by a millionth each way, which isn't a different cost. */
function sameCost(a: Lot, b: Lot): boolean {
  if (a.costMicros === null || b.costMicros === null) return a.costMicros === b.costMicros
  const [aQty, bQty] = [BigInt(a.qty), BigInt(b.qty)]
  const gap = BigInt(a.costMicros) * bQty - BigInt(b.costMicros) * aQty
  return (gap < 0n ? -gap : gap) <= aQty + bQty
}

/** A lot that could have been bought any time before where it is. The fold refuses any name that covers one, whatever else it covers. */
const anyTimeBefore = (lot: Lot) => (lot.wholeCostOnly === true && !lot.boughtAt) || lot.unplaced === true

/** The lots a fold left open, as purchases someone could name. */
export function heldOf(lots: readonly Lot[]): Held {
  const byMoment = new Map<string, Lot[]>()
  let unnamed = 0n
  for (const lot of lots) {
    if (BigInt(lot.qty) <= 0n) continue
    const at = lot.boughtAt ?? lot.acquiredAt
    if (at === undefined) {
      unnamed += BigInt(lot.qty)
      continue
    }
    // Grouped first, with the lots nothing can name, since a name covers every lot of its moment, and then the whole moment can't be.
    byMoment.set(at, [...(byMoment.get(at) ?? []), lot])
  }
  const purchases: HeldPurchase[] = []
  for (const [boughtAt, group] of byMoment) {
    if (group.some(anyTimeBefore)) {
      unnamed += group.reduce((sum, lot) => sum + BigInt(lot.qty), 0n)
      continue
    }
    const units = group.reduce((sum, lot) => sum + BigInt(lot.qty), 0n)
    const costMicros = group.some((lot) => lot.costMicros === null) ? null : group.reduce((sum, lot) => sum + BigInt(lot.costMicros as string), 0n)
    purchases.push({ boughtAt, units, costMicros, allOnly: group.some((lot) => !sameCost(group[0] as Lot, lot)) })
  }
  purchases.sort((a, b) => Date.parse(a.boughtAt) - Date.parse(b.boughtAt))
  return { purchases, unnamed }
}

/** What `wallet` holds of `asset`, folded the way a US report does, with the choices already in the book. */
export function heldIn(wallet: WalletResponse, others: readonly WalletResponse[], book: Book, asset: string): Held {
  const position = foldBook(wallet, others, HELD_METHOD, book).positions.find((one) => one.asset === asset)
  return heldOf(position?.state.lots ?? [])
}

/** What `wallet` holds of each token, the same way, as JSON. A token nothing's held of is left out. */
export function heldByAsset(wallet: WalletResponse, others: readonly WalletResponse[], book: Book): Record<string, HeldJson> {
  const held: Record<string, HeldJson> = {}
  for (const position of foldBook(wallet, others, HELD_METHOD, book).positions) {
    const one = heldOf(position.state.lots)
    if (one.purchases.length > 0 || one.unnamed > 0n) held[position.asset] = heldToJson(one)
  }
  return held
}

export type Picks = ReadonlyMap<string, bigint>

/** Why these picks can't go with a send of `units`, or null when they can. No picks at all is fine: the oldest go first. */
export function picksProblem(held: Held, picks: Picks, units: bigint, format: (units: bigint) => string): string | null {
  const named = [...picks.values()].reduce((sum, n) => sum + n, 0n)
  if (named === 0n) return null
  if ([...picks.values()].filter((n) => n > 0n).length > MAX_CHOICE_TAKES) return `A send can name up to ${MAX_CHOICE_TAKES} purchases.`
  for (const [at, n] of picks) {
    // Nothing from a purchase isn't a choice of it, whether it's still held or not.
    if (n === 0n) continue
    const purchase = held.purchases.find((one) => one.boughtAt === at)
    if (!purchase) return "One of those purchases isn't held anymore."
    if (n > purchase.units) return `That's more than is left of one purchase, which has ${format(purchase.units)}.`
    if (purchase.allOnly && n > 0n && n !== purchase.units) return `One purchase was bought at different prices at the same moment, so it's all ${format(purchase.units)} or none of it.`
  }
  if (named !== units) return `Those add up to ${format(named)}, and this sends ${format(units)}.`
  return null
}

/** The record of which units a send takes, made now, before it's signed. Null when nothing's named. */
export function choiceOf(wallet: string, txHash: string, asset: string, recordedAt: string, picks: Picks): UnitChoice | null {
  const takes = [...picks].filter(([, n]) => n > 0n).sort(([a], [b]) => Date.parse(a) - Date.parse(b)).map(([boughtAt, n]) => ({ boughtAt, units: n.toString() }))
  return takes.length === 0 ? null : { wallet: normalizeAddress(wallet), txHash: txHash.toLowerCase(), asset, recordedAt, takes }
}

/** `Held` as JSON, which has no bigints, for a client that doesn't fold its own, like the Mac app. */
export type HeldJson = { purchases: { boughtAt: string; units: string; costMicros: string | null; allOnly: boolean }[]; unnamed: string }

export const heldToJson = (held: Held): HeldJson => ({
  purchases: held.purchases.map((p) => ({ boughtAt: p.boughtAt, units: p.units.toString(), costMicros: p.costMicros === null ? null : p.costMicros.toString(), allOnly: p.allOnly })),
  unnamed: held.unnamed.toString(),
})

/** The most purchases of one token a link can list for one wallet. `NamedUnits` in the Mac app keeps to the same. */
export const MOST_LISTED_PURCHASES = 500

const DIGITS = /^\d{1,78}$/
const MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** What someone else said is held, or null when it isn't that. Anyone can make a link, so this only reads what fits. */
export function heldFromJson(value: unknown): Held | null {
  if (typeof value !== "object" || value === null) return null
  const { purchases, unnamed } = value as Record<string, unknown>
  if (!Array.isArray(purchases) || typeof unnamed !== "string" || !DIGITS.test(unnamed) || purchases.length > MOST_LISTED_PURCHASES) return null
  const read: HeldPurchase[] = []
  for (const one of purchases as unknown[]) {
    if (typeof one !== "object" || one === null) return null
    // The Mac app leaves out a cost nobody knows.
    const { boughtAt, units, costMicros = null, allOnly } = one as Record<string, unknown>
    if (typeof boughtAt !== "string" || !MOMENT.test(boughtAt) || typeof units !== "string" || !DIGITS.test(units) || BigInt(units) === 0n) return null
    if (costMicros !== null && (typeof costMicros !== "string" || !DIGITS.test(costMicros))) return null
    if (typeof allOnly !== "boolean" || read.some((p) => p.boughtAt === boughtAt)) return null
    read.push({ boughtAt, units: BigInt(units), costMicros: costMicros === null ? null : BigInt(costMicros), allOnly })
  }
  read.sort((a, b) => Date.parse(a.boughtAt) - Date.parse(b.boughtAt))
  return { purchases: read, unnamed: BigInt(unnamed) }
}
