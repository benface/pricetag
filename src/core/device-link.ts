// What a link can ask the hardware wallet flow to do. The Mac app has no device code, so its Add, Top Up and Publish buttons open
// these. Anyone can make a link, so a link only ever fills in a form: nothing here is treated as true until the person says so.

import { isAddress, normalizeAddress, plainAmount, type CurrencyCode } from "@pricetag/sdk/core"
import { unitsOfDecimal } from "./decimal.ts"

export type DeviceLink =
  | { kind: "add-savings"; device: "ledger" | null }
  | { kind: "top-up"; to: string; usdMicros: string | null }
  | { kind: "publish"; wallet: string; txHash: string; asset: string; usdMicros: string | null; amount: { units: string; decimals: number } | null }

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
  if (to !== null) return isAddress(to) ? { kind: "top-up", to: normalizeAddress(to), usdMicros: usdMicrosOf(params.get("usd")) } : null
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
