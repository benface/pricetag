// What every CSV this app writes has in common.

/** One cell, quoted when it has to be. */
export const csvCell = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value)

/** Millionths as a plain number, with every digit and no symbol. */
export function microsCell(micros: string): string {
  const value = BigInt(micros)
  const size = value < 0n ? -value : value
  return `${value < 0n ? "-" : ""}${size / 1_000_000n}.${(size % 1_000_000n).toString().padStart(6, "0")}`
}

/** A token amount with every digit, because a file shouldn't round what it's given. */
export function unitsCell(units: string, decimals: number): string {
  const value = BigInt(units)
  const size = (value < 0n ? -value : value).toString().padStart(decimals + 1, "0")
  const fraction = size.slice(size.length - decimals).replace(/0+$/, "")
  return `${value < 0n ? "-" : ""}${size.slice(0, size.length - decimals)}${fraction ? `.${fraction}` : ""}`
}
