// Display only. Every value here was computed in BigInt. Converting to Number happens only to print it.
// Values in USD can be null, which means unknown, and prints as that. It never prints as $0.

const UNKNOWN = "unknown"

const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

export function formatUsd(micros: string | bigint | null): string {
  if (micros === null) return UNKNOWN
  const value = Number(micros) / 1e6
  const size = Math.abs(value)
  if (size === 0) return "$0.00"
  // Small amounts matter here: gas is often a fraction of a cent, and "$0.00" would read as nothing.
  if (size < 0.01) return `${value < 0 ? "-" : ""}$${size.toLocaleString("en-US", { maximumSignificantDigits: 2, maximumFractionDigits: 6 })}`
  return usd2.format(value)
}

export function formatPrice(micros: string | null): string {
  if (micros === null) return UNKNOWN
  const value = Number(micros) / 1e6
  if (value >= 1) return usd2.format(value)
  return `$${value.toLocaleString("en-US", { maximumSignificantDigits: 4 })}`
}

export function formatSignedUsd(micros: string | bigint | null): string {
  if (micros === null) return UNKNOWN
  const value = BigInt(micros)
  return value > 0n ? `+${formatUsd(value)}` : formatUsd(value)
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
