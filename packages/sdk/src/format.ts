// Display only. Every value here was computed in BigInt. Converting to Number happens only to print it.
// Money can be null, which means unknown, and prints as that. It never prints as $0. Without a currency, it's USD.

import { CURRENCIES, atCurrentRate, type CurrencyCode } from "./currency.ts"

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

/** USD beside amounts in the main currency. If that's another kind of dollar, a bare "$" doesn't say which. Takes what's already formatted, sign and all. */
export function labelUsd(text: string, main: CurrencyCode): string {
  return main === "USD" ? text : text.replace("$", "US$")
}

/** A USD amount as someone should read it right now: in their currency, or in labelled USD when there's no current rate. */
export function formatUsdIn(usdMicros: string, main: CurrencyCode, rateMicros: string | null): string {
  return rateMicros !== null && main !== "USD" ? formatMoney(atCurrentRate(usdMicros, rateMicros), main) : labelUsd(formatMoney(usdMicros, "USD"), main)
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

/** Marks for a chart of these values and zero, each as precise as the distance between them, so a chart of fractions of a cent doesn't label every line $0. */
export function chartMoneyTicks(values: number[], currency: CurrencyCode = "USD"): { value: number; label: string }[] {
  const low = Math.min(0, ...values)
  const high = Math.max(0, ...values)
  const raw = (high - low || 1) / 4
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  // PnL comes in millionths of a dollar, so nothing's finer than that.
  const step = Math.max(1e-6, [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw)
  const digits = [0, 1, 2, 3, 4, 5, 6, 7, 8].find((d) => Math.abs(step * 10 ** d - Math.round(step * 10 ** d)) < 1e-6) ?? 8
  const { locale } = CURRENCIES[currency]
  const format = new Intl.NumberFormat(
    locale,
    step >= 1000
      ? { style: "currency", currency, notation: "compact", minimumFractionDigits: 0, maximumFractionDigits: 2 }
      : // Money doesn't read right with one decimal.
        { style: "currency", currency, minimumFractionDigits: digits === 1 ? 2 : digits, maximumFractionDigits: digits === 1 ? 2 : digits },
  ).format
  const ticks = []
  const last = Math.ceil(high / step)
  for (let i = Math.floor(low / step); i <= last; i++) {
    const value = Number((i * step).toFixed(9))
    ticks.push({ value, label: format(value) })
  }
  return ticks
}

/** A chart's first and last times, with as much of them as it takes to read differently. Narrow charts only say the date or the time, whichever tells them apart. */
export function formatChartSpan(startIso: string, endIso: string, narrow = false): [string, string] {
  const span = new Date(endIso).getTime() - new Date(startIso).getTime()
  const date = { month: "short", day: "numeric" } as const
  const clock = { hour: "numeric", minute: "2-digit" } as const
  const options = !narrow ? { ...date, ...clock } : span >= 86_400_000 ? date : clock
  const show = (iso: string, extra = {}) => new Date(iso).toLocaleString("en-US", { ...options, ...extra })
  if (span === 0 || show(startIso) !== show(endIso)) return [show(startIso), show(endIso)]
  // The same minute, or the hour that repeats when the clocks go back.
  const extra = span < 60_000 ? { second: "2-digit" } : { timeZoneName: "short" }
  return [show(startIso, extra), show(endIso, extra)]
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 120) return `${minutes} min`
  return `${Math.round(minutes / 60)} h`
}
