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
  /** What arrived, or left, with a cost nobody can work out yet. */
  unknownCost: string[]
  /** Those an answer could work out, which isn't all of them: nobody can answer which came first in a block, say. */
  answerableCost: string[]
}

export const NO_FACTS: TransactionFacts = { assets: [], counterparty: null, amount: null, gain: null, unknownCost: [], answerableCost: [] }

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
  // A sale is worth what it brought in, as the fold counts it, which needn't be the market price. Unknown proceeds stay unknown.
  if (left.every((leg) => leg.kind === "swap")) return { direction: "trade", micros: proceedsOf(left) }
  // Things went both ways without a trade, so what left is all there is to go on.
  return { direction: "trade", micros: sumOf(left) }
}

/** What sales brought in, or null when any of it isn't known. */
function proceedsOf(sales: readonly PricedLeg[]): string | null {
  let sum = 0n
  for (const leg of sales) {
    if (leg.proceedsMicros === null) return null
    sum += BigInt(leg.proceedsMicros)
  }
  return sum.toString()
}

function counterpartyOf(legs: readonly PricedLeg[], wallets: ReadonlySet<string>): string | null {
  const others = new Set<string>()
  for (const leg of legs) {
    if (leg.kind === "gas") continue
    for (const part of leg.parts) if (part.counterparty) others.add(normalizeAddress(part.counterparty))
  }
  for (const wallet of wallets) others.delete(wallet)
  return others.size === 1 ? ([...others][0] as string) : null
}

/**
 * What selling in this transaction realized, from the fold's own before and after. Only sales: a send or a fee realizes
 * nothing worth showing on its own. An asset whose balance doesn't match, or couldn't be checked, has no realized PnL
 * in the totals, so none of its sales has a gain here either.
 */
function gainOf(legs: readonly PricedLeg[], effects: ReadonlyMap<string, LegEffect>, unconfirmed: ReadonlySet<string>): TransactionGain | null {
  const sales = legs.filter((leg) => leg.kind === "swap" && BigInt(leg.delta) < 0n)
  if (sales.length === 0) return null
  if (sales.some((leg) => unconfirmed.has(leg.asset))) return { micros: null, estimated: false }
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

/**
 * A debit that took away units with no known cost, so what it realized or carried off isn't known. A missing price is a
 * different problem, which no answer about a cost fixes, so it isn't counted here. Fees are left to their own row's amount.
 */
function leftUnknown(leg: PricedLeg, effects: ReadonlyMap<string, LegEffect>): boolean {
  if (isIncoming(leg) || leg.kind === "gas" || BigInt(leg.delta) === 0n) return false
  const effect = effects.get(leg.id)
  if (!effect) return false
  const grew = (key: "unknownCostDisposedQty" | "transferredOutUnknownQty") => BigInt(effect.after[key]) > BigInt(effect.before[key])
  return grew("unknownCostDisposedQty") || grew("transferredOutUnknownQty")
}

/** Whether an answer could fix what a leg's cost is missing, going by what was held before it. */
function answerable(leg: PricedLeg, effects: ReadonlyMap<string, LegEffect>): boolean {
  const effect = effects.get(leg.id)
  return effect !== undefined && !leg.unsettledCredit && effect.answerable
}

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

/** The facts of each transaction, by hash. `unconfirmed` is what `unconfirmedAssets` gives, the assets whose PnL the totals leave out. */
export function transactionFacts(byTx: ReadonlyMap<string, readonly PricedLeg[]>, positions: readonly Position[], method: Method, wallet: string, unconfirmed: ReadonlySet<string> = new Set()): Map<string, TransactionFacts> {
  const effects = new Map<string, LegEffect>()
  for (const position of positions) for (const effect of position.effects) effects.set(effect.leg.id, effect)
  const me = new Set([normalizeAddress(wallet)])
  const facts = new Map<string, TransactionFacts>()
  for (const [txHash, txLegs] of byTx) {
    const moved = txLegs.filter((leg) => leg.kind !== "gas" && BigInt(leg.delta) !== 0n)
    const unknown = txLegs.filter((leg) => arrivedUnknown(leg, method) || leftUnknown(leg, effects))
    facts.set(txHash, {
      assets: [...new Set(moved.map((leg) => leg.asset))],
      counterparty: counterpartyOf(txLegs, me),
      amount: amountOf(txLegs),
      gain: gainOf(txLegs, effects, unconfirmed),
      unknownCost: [...new Set(unknown.map((leg) => leg.asset))],
      answerableCost: [...new Set(unknown.filter((leg) => answerable(leg, effects)).map((leg) => leg.asset))],
    })
  }
  return facts
}

/** Several wallets' gains from one transaction. Unknown if any of them is, and nil if none of them sold anything. */
function sumGains(gains: readonly (TransactionGain | null)[]): TransactionGain | null {
  const sold = gains.filter((gain) => gain !== null)
  if (sold.length === 0) return null
  if (sold.some((gain) => gain.micros === null)) return { micros: null, estimated: false }
  return { micros: sold.reduce((sum, gain) => sum + BigInt(gain.micros as string), 0n).toString(), estimated: sold.some((gain) => gain.estimated) }
}

/**
 * What one transaction did across several of a user's wallets, from what it did in each. `legs` are all of theirs in it, so
 * a move between them went both ways and has nobody on the other side, and gains are each wallet's own, added up.
 */
export function combinedFacts(legs: readonly PricedLeg[], each: readonly TransactionFacts[], wallets: ReadonlySet<string>): TransactionFacts {
  return {
    assets: [...new Set(each.flatMap((facts) => facts.assets))],
    counterparty: counterpartyOf(legs, wallets),
    amount: amountOf(legs),
    gain: sumGains(each.map((facts) => facts.gain)),
    unknownCost: [...new Set(each.flatMap((facts) => facts.unknownCost))],
    answerableCost: [...new Set(each.flatMap((facts) => facts.answerableCost))],
  }
}
