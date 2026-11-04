// Every movement as a spreadsheet row, marked so an estimate or an unknown can't pass for an exact number.

import type { LegEffect, Position } from "@pricetag/sdk/core"
import type { CurrencyCode } from "./currency.ts"

const HEADER = ["time", "block", "transaction", "asset", "amount", "kind", "currency", "price", "price_source", "cost", "cost_source", "proceeds", "status"]

function statusOf({ leg, before, after }: LegEffect, noMarket: boolean): string {
  if (noMarket) return "no market"
  if (BigInt(leg.delta) > 0n) {
    if (leg.costLabel === "unknown" || leg.costMicros === null) return "unresolved"
    return leg.estimated ? "estimated" : "exact"
  }
  if (BigInt(after.unresolvedDisposedQty) > BigInt(before.unresolvedDisposedQty) || BigInt(after.unpricedGasQty) > BigInt(before.unpricedGasQty) || BigInt(after.shortfallQty) > BigInt(before.shortfallQty)) return "unresolved"
  return BigInt(after.estimatedRealizedMicros) > BigInt(before.estimatedRealizedMicros) ? "estimated" : "exact"
}

const money = (micros: string | null) => {
  if (micros === null) return ""
  const value = BigInt(micros)
  const size = value < 0n ? -value : value
  return `${value < 0n ? "-" : ""}${size / 1_000_000n}.${(size % 1_000_000n).toString().padStart(6, "0")}`
}

function amount(units: string, decimals: number): string {
  const value = BigInt(units)
  const size = (value < 0n ? -value : value).toString().padStart(decimals + 1, "0")
  const fraction = size.slice(size.length - decimals).replace(/0+$/, "")
  return `${value < 0n ? "-" : ""}${size.slice(0, size.length - decimals)}${fraction ? `.${fraction}` : ""}`
}

const quote = (cell: string) => (/[",\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell)

export function exportCsv(positions: readonly Position[], currency: CurrencyCode): string {
  const rows = positions
    .flatMap((position) => position.effects.map((effect) => ({ effect, noMarket: position.noMarket })))
    .sort((a, b) => a.effect.leg.blockNum - b.effect.leg.blockNum || a.effect.leg.txIndex - b.effect.leg.txIndex)
    .map(({ effect, noMarket }) => {
      const { leg } = effect
      const incoming = BigInt(leg.delta) > 0n
      return [
        leg.timestamp,
        String(leg.blockNum),
        leg.txHash,
        leg.asset,
        amount(leg.delta, leg.decimals),
        leg.opening ? "starting balance" : leg.kind,
        currency,
        money(leg.priceMicros),
        leg.priceSource ?? "",
        incoming ? money(leg.costMicros) : "",
        incoming ? leg.costLabel : "",
        money(leg.proceedsMicros),
        statusOf(effect, noMarket),
      ]
    })
  return [HEADER, ...rows].map((row) => row.map(quote).join(",")).join("\n") + "\n"
}
