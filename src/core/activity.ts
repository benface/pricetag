// What a transaction did to a wallet, as a row in a list of them: what moved, who with, what it was worth and what it
// realized. Like every other number, the server works it out, and a client only shows it.

import { normalizeAddress, orderMatters, worth, type LegEffect, type Method, type Position, type PricedLeg } from "@pricetag/sdk/core"

/**
 * in or out: something only arrived, or only left. trade: things went both ways. fee: only a network fee was paid.
 * `micros` is what moved, in the portfolio's currency, and null when part of it has no price, which isn't $0.
 */
export type TransactionAmount = { direction: "in" | "out" | "trade" | "fee"; micros: string | null }

/** The gain or loss a sale in a transaction realized. `micros` is null when what was sold has an unknown cost or price. */
export type TransactionGain = { micros: string | null; estimated: boolean }

export type TransactionFacts = {
  /** What moved, apart from network fees, in the order it moved. */
  assets: string[]
  /** The one address on the other side, or null when there's none or more than one. */
  counterparty: string | null
  amount: TransactionAmount | null
  /** null when nothing was sold. */
  gain: TransactionGain | null
  /** What arrived with a cost nobody can work out yet. */
  unknownCost: string[]
}

export const NO_FACTS: TransactionFacts = { assets: [], counterparty: null, amount: null, gain: null, unknownCost: [] }

const isIncoming = (leg: PricedLeg) => BigInt(leg.delta) > 0n

/** What a leg moved was worth, or null when that isn't known. A claim's amount isn't known until the chain confirms it. */
function valueOf(leg: PricedLeg): bigint | null {
  if (leg.priceMicros === null || (leg.unsettledCredit && isIncoming(leg))) return null
  const units = BigInt(leg.delta)
  return worth(units < 0n ? -units : units, BigInt(leg.priceMicros), leg.decimals)
}

/** All of them added up, or null when any one is unknown. */
function sumOf(legs: readonly PricedLeg[]): string | null {
  let sum = 0n
  for (const leg of legs) {
    const value = valueOf(leg)
    if (value === null) return null
    sum += value
  }
  return sum.toString()
}

function amountOf(legs: readonly PricedLeg[]): TransactionAmount | null {
  const moved = legs.filter((leg) => leg.kind !== "gas" && BigInt(leg.delta) !== 0n)
  if (moved.length === 0) {
    const fees = legs.filter((leg) => leg.kind === "gas")
    return fees.length === 0 ? null : { direction: "fee", micros: sumOf(fees) }
  }
  const arrived = moved.filter(isIncoming)
  const left = moved.filter((leg) => !isIncoming(leg))
  if (left.length === 0) return { direction: "in", micros: sumOf(arrived) }
  if (arrived.length === 0) return { direction: "out", micros: sumOf(left) }
  // Either side says what the trade was worth. What was given up comes first, because what arrived can be something with only a market price.
  return { direction: "trade", micros: sumOf(left) ?? sumOf(arrived) }
}

function counterpartyOf(legs: readonly PricedLeg[], wallet: string): string | null {
  const others = new Set<string>()
  for (const leg of legs) {
    if (leg.kind === "gas") continue
    for (const part of leg.parts) if (part.counterparty) others.add(normalizeAddress(part.counterparty))
  }
  others.delete(wallet)
  return others.size === 1 ? ([...others][0] as string) : null
}

/** What selling in this transaction realized, from the fold's own before and after. Only sales: a send or a fee realizes nothing worth showing on its own. */
function gainOf(legs: readonly PricedLeg[], effects: ReadonlyMap<string, LegEffect>): TransactionGain | null {
  const sales = legs.filter((leg) => leg.kind === "swap" && BigInt(leg.delta) < 0n)
  if (sales.length === 0) return null
  let gain = 0n
  let known = true
  let estimated = false
  for (const leg of sales) {
    const effect = effects.get(leg.id)
    if (!effect) return { micros: null, estimated: false }
    const { before, after } = effect
    if (BigInt(after.unresolvedDisposedQty) > BigInt(before.unresolvedDisposedQty)) known = false
    gain += BigInt(after.realizedMicros) - BigInt(before.realizedMicros)
    if (BigInt(after.estimatedRealizedMicros) > BigInt(before.estimatedRealizedMicros)) estimated = true
  }
  return known ? { micros: gain.toString(), estimated } : { micros: null, estimated: false }
}

/** A credit that takes no cost: nobody knows what was paid, or where it falls among what else moved in its block. */
const arrivedUnknown = (leg: PricedLeg, method: Method) =>
  isIncoming(leg) && leg.kind !== "gas" && (orderMatters(leg, method) || (leg.pieces ? leg.pieces.some((piece) => piece.costMicros === null) : leg.costLabel === "unknown"))

/** A wallet's legs, by the transaction they're in. What it held before the first block read isn't in one. */
export function legsByTransaction(legs: readonly PricedLeg[]): Map<string, PricedLeg[]> {
  const byTx = new Map<string, PricedLeg[]>()
  for (const leg of legs) {
    if (leg.opening || !leg.txHash) continue
    const txLegs = byTx.get(leg.txHash)
    if (txLegs) txLegs.push(leg)
    else byTx.set(leg.txHash, [leg])
  }
  return byTx
}

/** The facts of each transaction, by hash. */
export function transactionFacts(byTx: ReadonlyMap<string, readonly PricedLeg[]>, positions: readonly Position[], method: Method, wallet: string): Map<string, TransactionFacts> {
  const effects = new Map<string, LegEffect>()
  for (const position of positions) for (const effect of position.effects) effects.set(effect.leg.id, effect)
  const me = normalizeAddress(wallet)
  const facts = new Map<string, TransactionFacts>()
  for (const [txHash, txLegs] of byTx) {
    const moved = txLegs.filter((leg) => leg.kind !== "gas" && BigInt(leg.delta) !== 0n)
    facts.set(txHash, {
      assets: [...new Set(moved.map((leg) => leg.asset))],
      counterparty: counterpartyOf(txLegs, me),
      amount: amountOf(txLegs),
      gain: gainOf(txLegs, effects),
      unknownCost: [...new Set(txLegs.filter((leg) => arrivedUnknown(leg, method)).map((leg) => leg.asset))],
    })
  }
  return facts
}
