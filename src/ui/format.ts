// Display only. Every value here was computed in BigInt. Converting to Number happens only to print it.

const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

export function formatUsd(micros: string | bigint): string {
  const value = Number(micros) / 1e6
  const size = Math.abs(value)
  if (size === 0) return "$0.00"
  if (size < 0.01) return `${value < 0 ? "-" : ""}<$0.01`
  return usd2.format(value)
}

export function formatPrice(micros: string): string {
  const value = Number(micros) / 1e6
  if (value >= 1) return usd2.format(value)
  return `$${value.toLocaleString("en-US", { maximumSignificantDigits: 4 })}`
}

export function formatSignedUsd(micros: string | bigint): string {
  const value = BigInt(micros)
  return value > 0n ? `+${formatUsd(value)}` : formatUsd(value)
}

/** Whole tokens from smallest units, cut to a readable length. Never rounds up to look like more. */
export function formatAmount(units: string | bigint, decimals: number): string {
  const value = BigInt(units)
  const size = value < 0n ? -value : value
  const scale = 10n ** BigInt(decimals)
  const whole = size / scale
  const fraction = (size % scale).toString().padStart(decimals, "0")
  const shown = whole >= 1000n ? 2 : whole >= 1n ? 4 : 6
  const cut = fraction.slice(0, shown).replace(/0+$/, "")
  const body = `${whole.toLocaleString("en-US")}${cut ? `.${cut}` : ""}`
  if (size > 0n && whole === 0n && !cut) return `${value < 0n ? "-" : ""}<0.000001`
  return `${value < 0n ? "-" : ""}${body}`
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

export function formatDuration(blocks: number): string {
  const minutes = Math.round((blocks * 2) / 60)
  if (minutes < 120) return `${minutes} min`
  return `${Math.round(minutes / 60)} h`
}
