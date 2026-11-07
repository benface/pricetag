// Every movement as a spreadsheet row, marked so an estimate or an unknown can't pass for an exact number.

import type { CurrencyCode, LegEffect, Position } from "@pricetag/sdk/core"
import { csvCell, microsCell, unitsCell } from "./csv.ts"
import { COST_WORDS, actionLabel, priceSourceLabel } from "./wording.ts"

const HEADER = ["time", "block", "transaction", "asset", "amount", "kind", "currency", "price", "price_source", "cost", "cost_source", "proceeds", "status"]

function statusOf({ leg, before, after }: LegEffect, noMarket: boolean): string {
  if (noMarket) return "no market"
  if (BigInt(leg.delta) > 0n) {
    if (leg.costLabel === "unknown" || leg.costMicros === null) return "unknown"
    return leg.estimated ? "estimated" : "exact"
  }
  const grew = (field: "unresolvedDisposedQty" | "unpricedGasQty" | "shortfallQty" | "transferredOutUnknownQty" | "estimatedRealizedMicros" | "transferredOutEstimatedMicros") => BigInt(after[field]) > BigInt(before[field])
  if (grew("unresolvedDisposedQty") || grew("unpricedGasQty") || grew("shortfallQty") || grew("transferredOutUnknownQty")) return "unknown"
  return grew("estimatedRealizedMicros") || grew("transferredOutEstimatedMicros") ? "estimated" : "exact"
}

const money = (micros: string | null) => (micros === null ? "" : microsCell(micros))

/** `walletOf` adds a column saying which wallet each row is in, for an export of several wallets at once. */
export function exportCsv(positions: readonly Position[], currency: CurrencyCode, walletOf?: (leg: LegEffect["leg"]) => string): string {
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
        unitsCell(leg.delta, leg.decimals),
        leg.opening ? "starting balance" : actionLabel(leg.kind, incoming).toLowerCase(),
        currency,
        money(leg.priceMicros),
        leg.priceSource ? priceSourceLabel(leg.priceSource) : "",
        incoming ? money(leg.costMicros) : "",
        incoming ? (leg.purchaseSource ? (leg.costLabel === "inherited" ? `${leg.purchaseSource}, from your other wallet` : leg.purchaseSource) : COST_WORDS[leg.costLabel]) : "",
        money(leg.proceedsMicros),
        statusOf(effect, noMarket),
        ...(walletOf ? [walletOf(leg)] : []),
      ]
    })
  return [walletOf ? [...HEADER, "wallet"] : HEADER, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n"
}
