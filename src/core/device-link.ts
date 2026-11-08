// What a link can ask the hardware wallet flow to do. The Mac app has no device code, so its Add, Top Up and Publish buttons open
// these. Anyone can make a link, so a link only ever fills in a form: nothing here is treated as true until the person says so.

import { isAddress, normalizeAddress, plainAmount, type CurrencyCode } from "@pricetag/sdk/core"
import type { UnitChoice } from "./book.ts"
import { unitsOfDecimal } from "./decimal.ts"
import { heldFromJson, type Held } from "./held-units.ts"

export type DeviceLink =
  | { kind: "add-savings"; device: "ledger" | null }
  | { kind: "top-up"; to: string; usdMicros: string | null; held: HeldByWallet | null }
  | { kind: "publish"; wallet: string; txHash: string; asset: string; usdMicros: string | null; amount: { units: string; decimals: number } | null }

/**
 * What the Mac app says each of its savings wallets holds, by token and purchase, so a top-up can name the units it takes. The Mac only
 * sends it under US rules, folded with its own answers, which this page doesn't have. It's only a list to choose from: the Mac checks
 * what comes back, and its tax report refuses a choice that doesn't fit what was held.
 */
export type HeldByWallet = ReadonlyMap<string, ReadonlyMap<string, Held>>

const MOST_HELD_WALLETS = 16

function heldByWalletOf(text: string | null): HeldByWallet | null {
  if (text === null || text.length > 200_000) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const entries = Object.entries(value)
  if (entries.length > MOST_HELD_WALLETS) return null
  const byWallet = new Map<string, Map<string, Held>>()
  for (const [wallet, assets] of entries) {
    if (!isAddress(wallet) || typeof assets !== "object" || assets === null || Array.isArray(assets)) return null
    const byAsset = new Map<string, Held>()
    for (const [asset, one] of Object.entries(assets)) {
      const held = ASSET.test(asset) ? heldFromJson(one) : null
      if (!held) return null
      byAsset.set(asset, held)
    }
    byWallet.set(normalizeAddress(wallet), byAsset)
  }
  return byWallet
}

/** Dollars as a link or a person writes them, as micro-USD. Null when it isn't an amount above zero. */
export function usdMicrosOf(text: string | null): string | null {
  const clean = plainAmount(text?.replaceAll("$", "") ?? "")
  if (clean === null || !/^(\d{1,12}(\.\d*)?|\.\d+)$/.test(clean)) return null
  const micros = unitsOfDecimal(clean, 6)
  return micros > 0n ? micros.toString() : null
}

const TX_HASH = /^0x[0-9a-f]{64}$/
const ASSET = /^[A-Za-z0-9]{1,16}$/
const UNITS = /^\d{1,78}$/
const DECIMALS = /^\d{1,2}$/

/** The request in a page's address, or null if there's none or it doesn't make sense. */
export function parseDeviceLink(search: string): DeviceLink | null {
  const params = new URLSearchParams(search)
  if (params.has("addsavings")) return { kind: "add-savings", device: params.get("addsavings") === "ledger" ? "ledger" : null }
  const to = params.get("topup")
  if (to !== null) return isAddress(to) ? { kind: "top-up", to: normalizeAddress(to), usdMicros: usdMicrosOf(params.get("usd")), held: heldByWalletOf(params.get("held")) } : null
  const txHash = params.get("publish")?.toLowerCase()
  if (txHash === undefined) return null
  const wallet = params.get("wallet")
  const asset = params.get("asset")
  if (!TX_HASH.test(txHash) || !wallet || !isAddress(wallet) || !asset || !ASSET.test(asset)) return null
  const units = params.get("units")
  const decimals = params.get("decimals")
  const amount = units && decimals && UNITS.test(units) && DECIMALS.test(decimals) ? { units, decimals: Number(decimals) } : null
  return { kind: "publish", wallet: normalizeAddress(wallet), txHash, asset, usdMicros: usdMicrosOf(params.get("usd")), amount }
}

type NoteQuestion = { wallet: string; noteAbout: string | null; arrivals: readonly { asset: string; units: string; decimals: number }[]; receipts: readonly unknown[] }

/**
 * What publishing this answer would be, if a note can say it. One that covered less than what it names would replace the cost of the rest.
 * A note's always in USD, so what was typed only carries over if it was typed in USD. 250 in another currency isn't 250 dollars.
 */
export function noteLinkFor(question: NoteQuestion, typed: string | null, currency: CurrencyCode): Extract<DeviceLink, { kind: "publish" }> | null {
  const arrival = question.arrivals[0]
  if (!question.noteAbout || !TX_HASH.test(question.noteAbout) || !arrival || question.arrivals.length !== 1 || question.receipts.length !== 1 || !ASSET.test(arrival.asset)) return null
  return { kind: "publish", wallet: normalizeAddress(question.wallet), txHash: question.noteAbout, asset: arrival.asset, usdMicros: currency === "USD" ? usdMicrosOf(typed) : null, amount: { units: arrival.units, decimals: arrival.decimals } }
}

/** How the page tells the Mac app about an account. The app still asks the person to check it on the device before anything's saved. */
export function addToMacLink(address: string, name: string, others: readonly string[]): string {
  const params = new URLSearchParams({ address: normalizeAddress(address), name })
  if (others.length > 0) params.set("linked", others.map(normalizeAddress).join(","))
  return `patina://add-savings?${params}`
}

/**
 * How the page hands the Mac app a record of which units a top-up took. The Mac only keeps one while it's waiting on a top-up it opened,
 * from one of its savings wallets, and made since it opened it, because anyone can make this link too.
 */
export function unitChoiceLink(choice: UnitChoice): string {
  const params = new URLSearchParams({ wallet: choice.wallet, tx: choice.txHash, asset: choice.asset, recorded: choice.recordedAt, takes: choice.takes.map((take) => `${take.boughtAt}~${take.units}`).join(",") })
  return `patina://unit-choice?${params}`
}
