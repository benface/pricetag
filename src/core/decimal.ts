/** Plain digits like "12.5" or ".5" in units of 10^-`decimals`, without going through a float. Whoever calls this has checked they're digits, and anything finer is cut off. */
export function unitsOfDecimal(digits: string, decimals: number): bigint {
  const [whole = "", fraction = ""] = digits.split(".")
  return BigInt(`${whole || "0"}${fraction.slice(0, decimals).padEnd(decimals, "0")}`)
}
