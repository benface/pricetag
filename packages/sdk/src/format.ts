// Display only. Every value here was computed in BigInt. Converting to Number happens only to print it.
// Money can be null, which means unknown, and prints as that. It never prints as $0. Without a currency, it's USD.

import { CURRENCIES, type CurrencyCode } from "./currency.ts"

const UNKNOWN = "unknown"

const whole = new Map(Object.values(CURRENCIES).map((c) => [c.code, new Intl.NumberFormat(c.locale, { style: "currency", currency: c.code })]))

const twoDecimals = (value: number, currency: CurrencyCode) => (whole.get(currency) as Intl.NumberFormat).format(value)

export function formatMoney(micros: string | bigint | null, currency: CurrencyCode = "USD"): string {
  if (micros === null) return UNKNOWN
  const value = Number(micros) / 1e6
  const size = Math.abs(value)
  if (size === 0) return twoDecimals(0, currency)
  const { locale, symbol } = CURRENCIES[currency]
  // Small amounts matter here: gas is often a fraction of a cent, and "$0.00" would read as nothing.
  if (size < 0.01) return `${value < 0 ? "-" : ""}${symbol}${size.toLocaleString(locale, { maximumSignificantDigits: 2, maximumFractionDigits: 6 })}`
  return twoDecimals(value, currency)
}

export function formatPrice(micros: string | null, currency: CurrencyCode = "USD"): string {
  if (micros === null) return UNKNOWN
  const value = Number(micros) / 1e6
  if (value >= 1) return twoDecimals(value, currency)
  const { locale, symbol } = CURRENCIES[currency]
  return `${symbol}${value.toLocaleString(locale, { maximumSignificantDigits: 4 })}`
}

export function formatSignedMoney(micros: string | bigint | null, currency: CurrencyCode = "USD"): string {
  if (micros === null) return UNKNOWN
  const value = BigInt(micros)
  return value > 0n ? `+${formatMoney(value, currency)}` : formatMoney(value, currency)
}

/** What one USD buys, to four decimals, which is how far exchange rates are usually quoted. */
export function formatRate(rateMicros: string, currency: CurrencyCode): string {
  const { locale, symbol } = CURRENCIES[currency]
  return `${symbol}${(Number(rateMicros) / 1e6).toLocaleString(locale, { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`
}

/** Whole tokens from smallest units, cut to a readable length. Cuts instead of rounding, so it never shows more than there is. */
export function formatAmount(units: string | bigint, decimals: number): string {
  const value = BigInt(units)
  const size = value < 0n ? -value : value
  const scale = 10n ** BigInt(decimals)
  const whole = size / scale
  const fraction = (size % scale).toString().padStart(decimals, "0")
  const leadingZeros = fraction.length - fraction.replace(/^0+/, "").length
  const shown = whole >= 1000n ? 2 : whole >= 1n ? 4 : leadingZeros + 3
  const cut = fraction.slice(0, shown).replace(/0+$/, "")
  return `${value < 0n ? "-" : ""}${whole.toLocaleString("en-US")}${cut ? `.${cut}` : ""}`
}

export function formatSignedAmount(units: string, decimals: number): string {
  return BigInt(units) > 0n ? `+${formatAmount(units, decimals)}` : formatAmount(units, decimals)
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

export function formatClock(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { hour: "numeric", minute: "2-digit" })
}

export function formatDuration(blocks: number): string {
  const minutes = Math.round((blocks * 2) / 60)
  if (minutes < 120) return `${minutes} min`
  return `${Math.round(minutes / 60)} h`
}
