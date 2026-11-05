// The order the holdings table lists positions in. The Mac app has the same rules in `HoldingsSort.swift`.

import { returnBps, type Position } from "@pricetag/sdk/core"

export type HoldingsColumn = "asset" | "amount" | "average" | "price" | "value" | "return" | "realized" | "unrealized"
export type HoldingsSort = { column: HoldingsColumn; descending: boolean }

/** Largest first, the same as the menu bar's list. */
export const DEFAULT_HOLDINGS_SORT: HoldingsSort = { column: "value", descending: true }

export const HOLDINGS_COLUMNS: readonly HoldingsColumn[] = ["asset", "amount", "average", "price", "value", "return", "realized", "unrealized"]

/** Numbers start with the largest, and names with A. */
export const firstSort = (column: HoldingsColumn): HoldingsSort => ({ column, descending: column !== "asset" })

/** Amounts compared as whole tokens, whatever each token's decimals. */
const WHOLE = 36

/** What a column shows as a number, or null when it shows none: an unknown, no price, or a dash for what isn't held. */
function key(position: Position, column: Exclude<HoldingsColumn, "asset">): bigint | null {
  const { values, price, decimals } = position
  const held = BigInt(values.qty) > 0n
  const known = (micros: string | null) => (micros === null ? null : BigInt(micros))
  switch (column) {
    case "amount":
      return BigInt(values.qty) * 10n ** BigInt(WHOLE - decimals)
    case "price":
      return known(price?.micros ?? null)
    case "realized":
      return known(values.realizedMicros)
    case "average":
      return held ? known(values.averageCostMicros) : null
    case "value":
      return held ? known(values.valueMicros) : null
    case "return":
      return held ? known(returnBps(values)) : null
    case "unrealized":
      return held ? known(values.unrealizedMicros) : null
  }
}

/**
 * Positions in the order asked for. A row with no number in that column goes last whichever way it's sorted, because it
 * can't be ranked, and it's never treated as zero. Ties keep what's held first, then go by name.
 */
export function sortHoldings(positions: readonly Position[], { column, descending }: HoldingsSort): Position[] {
  const tie = (a: Position, b: Position) => Number(BigInt(b.values.qty) > 0n) - Number(BigInt(a.values.qty) > 0n) || a.asset.localeCompare(b.asset)
  return [...positions].sort((a, b) => {
    if (column === "asset") return (descending ? -1 : 1) * a.asset.localeCompare(b.asset)
    const x = key(a, column)
    const y = key(b, column)
    if (x === null || y === null) return x === y ? tie(a, b) : x === null ? 1 : -1
    if (x === y) return tie(a, b)
    return (x < y ? -1 : 1) * (descending ? -1 : 1)
  })
}

export function parseHoldingsSort(text: string | null): HoldingsSort {
  const [column, order] = (text ?? "").split(":")
  return HOLDINGS_COLUMNS.includes(column as HoldingsColumn) && (order === "asc" || order === "desc") ? { column: column as HoldingsColumn, descending: order === "desc" } : DEFAULT_HOLDINGS_SORT
}

export const formatHoldingsSort = ({ column, descending }: HoldingsSort) => `${column}:${descending ? "desc" : "asc"}`
