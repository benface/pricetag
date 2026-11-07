// Runs the fold over a wallet's priced legs, and adds up what can honestly be added up.

import { applyLeg, applyLegTaking, costCanBeAnswered, emptyPosition, tallyOf, worth, valuePosition, type KnownTaken, type LegApplied, type Method, type PositionState, type PositionTally, type PositionValues } from "./fold.ts"
import { timestampOfBlock } from "./chain.ts"
import type { RateRound } from "./currency.ts"
import { answerToMicros, isSanePrice, type PricedLeg, type Reference } from "./legs.ts"
import type { FeedMarks, MarketMarks } from "./market.ts"
import { decimalsOf, reconcile, type Onchain, type Reconciliation } from "./reconcile.ts"
import { TOKEN_FEEDS, tokenBySymbol } from "./tokens.ts"

export type Head = { blockNum: number; timestamp: string }

export type LatestPrice = {
  micros: string
  source: "oracle" | "swap" | "market"
  blockNum: number
  /** What `micros` was before converting, when it isn't already in USD. */
  usdMicros?: string
}
export type LatestPrices = Record<string, LatestPrice | undefined>

/**
 * What one leg did to its position. Only counters, and what a debit took, rather than every lot before and after: holding
 * those for every leg made oldest first's memory grow with the lots held times the legs.
 */
export type LegEffect = {
  leg: PricedLeg
  before: PositionTally
  after: PositionTally
  /** Whether an answer could fix any of this leg's unknown cost, going by what was held before it. */
  answerable: boolean
  /** Debits only: what it took with a known cost. Nothing a lot lost by this leg's taking part of it counts. */
  known: KnownTaken | null
}

/** What a leg did to a position, from what applying it already worked out, so no step goes through every lot again. */
export function effectOf(leg: PricedLeg, before: PositionState, { state: after, known, split }: LegApplied): LegEffect {
  return { leg, before: tallyOf(before), after: tallyOf(after), answerable: costCanBeAnswered(leg, before, split ?? undefined), known }
}

/** Which of a position's numbers rest on an estimate, so they can look different from exact ones. */
export type Estimates = { cost: boolean; value: boolean; realized: boolean; unrealized: boolean }

export type Position = {
  asset: string
  decimals: number
  state: PositionState
  values: PositionValues
  price: LatestPrice | null
  effects: LegEffect[]
  /** Null when there's nothing to compare against, as in a fold without onchain balances. */
  reconciliation: Reconciliation | null
  /** No price, in any form, at any block. Often spam. It's listed apart, and can't affect PnL. */
  noMarket: boolean
  estimates: Estimates
}

export type Exclusion = { asset: string; reason: "unknown cost" | "no current price" | "sold or spent at an unknown cost" | "sold or spent at an unknown price" | "incomplete history" | "doesn't match its actual balance" | "not checked against its actual balance" | "balance couldn't be read" }

/** What a sum is made of. A sum with something missing and nothing known has no answer, which isn't the same as $0. */
export type SumParts = { known: number; missing: number }

const hasAnswer = ({ known, missing }: SumParts) => known > 0 || missing === 0

export type Totals = {
  /** Each sums only what's known, and is null when nothing is. `excluded` says what isn't in it. */
  valueMicros: string | null
  realizedMicros: string | null
  unrealizedMicros: string | null
  gasMicros: string | null
  pnlMicros: string | null
  excluded: Exclusion[]
  /** Some gas had no price at its block, so it's not in `gasMicros`. */
  unpricedGas: boolean
  coverage: Record<"value" | "realized" | "unrealized" | "pnl", SumParts>
  /** What's held with an unknown cost, at today's price. It's not in any PnL. */
  unresolvedMicros: string
  /** How much of what these sums are made of is an estimate. */
  estimatedMicros: string
  /** Which sums rest on one. */
  estimated: Pick<Estimates, "value" | "realized" | "unrealized">
  /** Assets with no market, which aren't in any of this. */
  noMarket: string[]
}

/**
 * A position the chain hasn't confirmed. Anything about cost comes from legs that are incomplete, or may be, so it's
 * unavailable rather than wrong. PnL only ever shows for a position that matches: otherwise a failed read would bring
 * back a number we already knew was wrong. What it holds and what that's worth come from the chain whenever it's been read.
 */
function unconfirmedValues(values: PositionValues, qty: string, priceMicros: string | null, decimals: number): PositionValues {
  return {
    ...values,
    qty,
    unknownCostQty: qty,
    costMicros: null,
    averageCostMicros: null,
    valueMicros: priceMicros === null ? null : worth(BigInt(qty), BigInt(priceMicros), decimals).toString(),
    realizedMicros: null,
    unrealizedMicros: null,
  }
}

export const isUnconfirmed = ({ reconciliation }: Pick<Position, "reconciliation">) => reconciliation !== null && reconciliation.status !== "reconciled"

/**
 * Assets with no balance read and nothing else to go on, so they have no position. They might still hold something, so
 * they're missing from totals and the chart, rather than zero.
 */
export function unreadAssets(positions: readonly Position[], { unreadBalances }: Pick<Onchain, "unreadBalances">): string[] {
  const shown = new Set(positions.map((p) => p.asset))
  return (unreadBalances ?? []).filter((asset) => !shown.has(asset))
}

/** The assets `pnlOverTime` has to leave out. */
export const unconfirmedAssets = (positions: readonly Position[], unread: readonly string[] = []) => new Set([...positions.filter(isUnconfirmed).map((p) => p.asset), ...unread])

/**
 * Oldest first's lots, more than fit in this much memory. The check still counts them as if every step held all of them, which
 * it no longer does, so it refuses more than it needs to until it's measured again (WORK-673). Average has no such limit.
 */
export class OldestFirstTooBigError extends Error {
  constructor() {
    super("This history is too long to work out by oldest first in this much memory. Average cost still works.")
    this.name = "OldestFirstTooBigError"
  }
}

/** Wallets that each fit in memory, but not all at once. Each one can still be read on its own. */
export class WalletsTooBigError extends Error {
  constructor() {
    super("These wallets have too much history to add up in this much memory.")
    this.name = "WalletsTooBigError"
  }
}

/** No limit in a browser, where running out only costs that one tab. A process that others rely on sets one. */
let foldBytes = Number.POSITIVE_INFINITY
export function limitFolds(bytes: number) {
  foldBytes = bytes
}

// Measured through the server's API on a 640 MB heap.
/** What a leg costs at the peak of reading and folding it, the same as a row in the budget wallets are read under. */
const BYTES_PER_LEG = 10_000
/** What each wallet beyond the first adds to every leg, because each fold looks through all of them: 21 wallets of 1,000 legs fit, and of 1,400 didn't. */
const BYTES_PER_LEG_PER_OTHER_WALLET = 1_000
/** 8,000 incoming transfers fit and 9,000 didn't, which is about 12 bytes a lot. This leaves room for wallets kept in memory too. */
const BYTES_PER_LOT = 20
/** What a lot that arrived from another wallet costs on top, because the leg it arrived on keeps its own copy of it. */
const BYTES_PER_INHERITED_LOT = 500
/** 3,000 lots moved between two wallets 400 times fit by average, and 1,000 times didn't, which is 3 million of these. */
const BYTES_PER_MOVE_LINE = 150

type FoldedLeg = Pick<PricedLeg, "asset" | "delta" | "blockNum" | "txIndex" | "txHash" | "parts" | "pieces">
/** The address is what lets a transfer from one of these wallets to another carry its lots across. */
type FoldedHistory = { address?: string; legs: readonly FoldedLeg[] }
type OpenLot = { units: bigint; acquired: number }
type OpenLots = { lots: OpenLot[]; first: number }

/** Oldest first by when it was acquired, the way the fold keeps them. */
function openLot(open: OpenLots, lot: OpenLot) {
  const last = open.lots.at(-1)
  const at = !last || last.acquired <= lot.acquired ? -1 : open.lots.findIndex((other, index) => index >= open.first && other.acquired > lot.acquired)
  if (at < 0) open.lots.push(lot)
  else open.lots.splice(at, 0, lot)
}

/** Takes from the oldest lots, and says what it took. */
function closeLots(open: OpenLots, units: bigint): OpenLot[] {
  const taken: OpenLot[] = []
  for (let left = units; left > 0n && open.first < open.lots.length; ) {
    const lot = open.lots[open.first] as OpenLot
    const size = lot.units < left ? lot.units : left
    taken.push({ units: size, acquired: lot.acquired })
    lot.units -= size
    if (lot.units === 0n) open.first++
    left -= size
  }
  // Spent lots go once they're most of the list, so what's kept follows what's open however many times lots move.
  if (open.first * 2 > open.lots.length) {
    open.lots.splice(0, open.first)
    open.first = 0
  }
  return taken
}

const addressesOf = (histories: readonly FoldedHistory[]) => new Set(histories.flatMap(({ address }) => address ?? []))
const goesTo = ({ parts }: FoldedLeg, addresses: ReadonlySet<string>) => parts.some(({ counterparty }) => counterparty && addresses.has(counterparty.toLowerCase()))

/** With what left before what arrived, the way costs carry between wallets. */
const chainOrder = (histories: readonly FoldedHistory[]) =>
  histories
    .flatMap(({ address, legs }, wallet) => legs.map((leg) => ({ leg, wallet, address, delta: BigInt(leg.delta) })))
    .sort((a, b) => a.leg.blockNum - b.leg.blockNum || a.leg.txIndex - b.leg.txIndex || Number(a.delta > 0n) - Number(b.delta > 0n))

/**
 * A dry run of oldest first over wallets that can pass lots between them, cheap enough to run before any of the fold does.
 * A transfer it can't rule out counts as carrying its lots, so this can say more than the fold will hold, but not less.
 * `bytesFor` gets, for each wallet, the lots open after each leg, added up, and the lots that arrived from another wallet.
 * Neither ever goes down, so this stops as soon as they're past the limit, rather than counting a history that may not fit in memory just to count it.
 */
function dryRunFits(histories: readonly FoldedHistory[], bytesFor: (held: readonly number[], inherited: number) => number): boolean {
  const held = histories.map(() => 0)
  let inherited = 0
  const addresses = addressesOf(histories)
  const open = new Map<string, OpenLots>()
  const carried = new Map<string, OpenLot[]>()
  let at: FoldedLeg | null = null
  for (const { leg, wallet, address, delta } of chainOrder(histories)) {
    // What's carried is only for this transaction, the same as when costs carry for real.
    if (at && (at.blockNum !== leg.blockNum || at.txIndex !== leg.txIndex)) carried.clear()
    at = leg
    const key = `${wallet}:${leg.asset}`
    const lots = open.get(key) ?? { lots: [], first: 0 }
    open.set(key, lots)
    if (delta < 0n) {
      const taken = closeLots(lots, -delta)
      if (address && goesTo(leg, addresses)) carried.set(`${leg.txHash}:${address}:${leg.asset}`, taken)
    } else if (leg.pieces) {
      for (const piece of leg.pieces) openLot(lots, { units: BigInt(piece.qty), acquired: piece.acquiredBlock ?? leg.blockNum })
      inherited += leg.pieces.length
    } else if (delta > 0n) {
      let left = delta
      for (const part of leg.parts) {
        const pool = part.side === "credit" && part.counterparty ? carried.get(`${leg.txHash}:${part.counterparty.toLowerCase()}:${leg.asset}`) : undefined
        for (let need = pool ? BigInt(part.amount) : 0n; pool && need > 0n && pool.length > 0 && left > 0n; ) {
          const lot = pool[0] as OpenLot
          const size = lot.units < need ? lot.units : need
          openLot(lots, { units: size, acquired: lot.acquired })
          inherited++
          lot.units -= size
          if (lot.units === 0n) pool.shift()
          need -= size
          left -= size
        }
      }
      if (left > 0n) openLot(lots, { units: left, acquired: leg.blockNum })
    }
    held[wallet] = (held[wallet] as number) + lots.lots.length - lots.first
    if (bytesFor(held, inherited) > foldBytes) return false
  }
  return true
}

/**
 * What average's moves between wallets hold: each one's cost keeps a line for every block the wallet paid at, however little
 * moved. A line for each block it could have got from anywhere, since costs that aren't known yet may become known.
 */
function averageMoveLines(histories: readonly FoldedHistory[]): number {
  const addresses = addressesOf(histories)
  const lines = new Map<string, number>()
  const blocks = new Map<string, number>()
  const carried = new Map<string, number>()
  let total = 0
  for (const { leg, wallet, address, delta } of chainOrder(histories)) {
    const key = `${wallet}:${leg.asset}`
    const had = lines.get(key) ?? 0
    if (delta < 0n && address && goesTo(leg, addresses)) carried.set(`${leg.txHash}:${address}:${leg.asset}`, had)
    if (delta <= 0n) continue
    const arrived = leg.parts.reduce((sum, { side, counterparty }) => sum + ((side === "credit" && counterparty && carried.get(`${leg.txHash}:${counterparty.toLowerCase()}:${leg.asset}`)) || 0), 0)
    const paidAt = (blocks.get(leg.asset) ?? 0) + (arrived > 0 ? 0 : 1)
    blocks.set(leg.asset, paidAt)
    total += arrived
    lines.set(key, Math.min(had + (arrived > 0 ? arrived : 1), paidAt))
  }
  return total
}

const sumOf = (counts: readonly number[]) => counts.reduce((sum, count) => sum + count, 0)
const legsIn = (histories: readonly FoldedHistory[]) => sumOf(histories.map(({ legs }) => legs.length))

/** Throws unless folding all of these wallets' histories and keeping every result fits, before any of it is allocated. */
export function assertFoldsFit(histories: readonly FoldedHistory[], method: Method) {
  if (foldBytes === Number.POSITIVE_INFINITY) return
  const bytes = legsIn(histories) * (BYTES_PER_LEG + BYTES_PER_LEG_PER_OTHER_WALLET * (histories.length - 1))
  // One wallet's legs are what the budget it was read under already counted.
  if (histories.length > 1 && bytes > foldBytes) throw new WalletsTooBigError()
  if (method !== "fifo") {
    if (bytes + averageMoveLines(histories) * BYTES_PER_MOVE_LINE > foldBytes) throw new WalletsTooBigError()
    return
  }
  // Each fold is still held when the next starts, and a wallet's costs can look through another's whole history on top of that, so more than one wallet counts the biggest twice.
  const fits = dryRunFits(histories, (held, inherited) => bytes + (sumOf(held) + (held.length > 1 ? Math.max(...held) : 0)) * BYTES_PER_LOT + inherited * BYTES_PER_INHERITED_LOT)
  if (!fits) throw new OldestFirstTooBigError()
}

/** Throws unless folding this wallet fits, with the others only there to say what it inherits. Only its fold is kept, but working out what it inherits holds all of what they pass around. */
export function assertFoldFits(focus: FoldedHistory, others: readonly FoldedHistory[], method: Method) {
  if (foldBytes === Number.POSITIVE_INFINITY) return
  if (method !== "fifo") {
    if (focus.legs.length * BYTES_PER_LEG + averageMoveLines([focus, ...others]) * BYTES_PER_MOVE_LINE > foldBytes) throw new WalletsTooBigError()
    return
  }
  const fits = dryRunFits([focus, ...others], (held, inherited) => focus.legs.length * BYTES_PER_LEG + (held[0] as number) * BYTES_PER_LOT + inherited * BYTES_PER_INHERITED_LOT)
  if (!fits) throw new OldestFirstTooBigError()
}

export function foldPositions(legs: readonly PricedLeg[], method: Method, prices: LatestPrices, onchain?: Onchain): Position[] {
  if (method === "fifo") assertFoldsFit([{ legs }], method)
  const positions = new Map<string, { state: PositionState; effects: LegEffect[]; decimals: number }>()
  for (const leg of legs) {
    const position = positions.get(leg.asset) ?? { state: emptyPosition(method, leg.decimals), effects: [], decimals: leg.decimals }
    const applied = applyLegTaking(position.state, leg)
    position.effects.push(effectOf(leg, position.state, applied))
    position.state = applied.state
    positions.set(leg.asset, position)
  }
  // Whether something's held is a separate question from whether it can be checked. The chain says it's here, or said so
  // at its last read, and no leg explains it. A fresh wallet funded by an internal transfer looks like this.
  const discover = (asset: string, held: bigint) => {
    if (held > 0n && !positions.has(asset)) positions.set(asset, { state: emptyPosition(method, decimalsOf(asset)), effects: [], decimals: decimalsOf(asset) })
  }
  for (const [asset, amount] of Object.entries(onchain?.balances?.amounts ?? {})) discover(asset, BigInt(amount))
  for (const [asset, last] of Object.entries(onchain?.lastBalances ?? {})) discover(asset, BigInt(last.amount))
  return [...positions.entries()].map(([asset, { state, effects, decimals }]) => {
    const price = prices[asset] ?? null
    const values = valuePosition(state, price?.micros ?? null)
    const reconciliation = onchain ? reconcile(asset, effects.map((e) => e.leg), BigInt(state.shortfallQty), onchain) : null
    const confirmed = reconciliation === null || reconciliation.status === "reconciled"
    const cost = confirmed && BigInt(values.estimatedCostMicros) > 0n
    const value = price?.source === "market"
    const hasPrice =
      price !== null ||
      onchain?.prices?.[asset] !== undefined ||
      effects.some(({ leg }) => leg.priceMicros !== null || leg.costMicros !== null || leg.proceedsMicros !== null || leg.pieces?.some((piece) => piece.costMicros !== null) || leg.conversion?.priceUsdMicros != null || leg.conversion?.costUsdMicros != null || leg.conversion?.proceedsUsdMicros != null)
    return {
      asset,
      decimals,
      state,
      effects,
      price,
      reconciliation,
      noMarket: onchain?.marketChecked === true && !hasPrice && !tokenBySymbol(asset)?.oracle,
      estimates: { cost, value, realized: confirmed && BigInt(values.estimatedRealizedMicros) > 0n, unrealized: confirmed && (cost || value) },
      values:
        reconciliation === null || reconciliation.status === "reconciled"
          ? values
          : unconfirmedValues(values, reconciliation.status === "unchecked" ? (reconciliation.heldQty ?? values.qty) : reconciliation.actualQty, price?.micros ?? null, decimals),
    }
  })
}

/** Where an asset's legs stop adding up to its balance. */
export type HistoryGap = {
  /** The last block they're known to add up at, which is -Infinity when there's no such block. */
  through: number
  /** A balance they were compared with doesn't match, and nothing that's still unclear could be why, so it won't clear by itself. */
  mismatch: boolean
}

/**
 * Each asset whose legs don't currently add up to its balance. An asset that isn't here adds up.
 *
 * A read that failed says nothing about the history, so it falls back on the last one that worked, as of that block. That
 * way a failed read can't turn a known cost unknown and back, and can't bring back one a mismatch already ruled out. A wallet
 * with no read to go on stays unconfirmed until it has one, which only ever goes one way.
 */
export function historyGaps(legs: readonly PricedLeg[], method: Method, onchain: Onchain): Map<string, HistoryGap> {
  const gaps = new Map<string, HistoryGap>()
  const l1FeeUnknown = new Set(onchain.l1FeeUnknownTxs)
  for (const { asset, reconciliation } of foldPositions(legs, method, {}, onchain)) {
    if (reconciliation === null || reconciliation.status === "reconciled") continue
    const incomplete = reconciliation.status === "incomplete"
    const unreadStart = onchain.openingUnread?.includes(asset) ?? false
    const last = asset === "ETH" && onchain.l1FeeUnknownTxs.length > 0 ? onchain.lastCheckableEth : onchain.lastBalances?.[asset]
    const adds = ({ blockNum, amount }: { blockNum: number; amount: string }) => {
      const then = legs.filter((leg) => leg.asset === asset && leg.blockNum <= blockNum)
      const [position] = foldPositions(then, method, {}, { balances: { blockNum, amounts: { [asset]: amount } }, l1FeeUnknownTxs: [] })
      // With nothing moved by then and nothing held, there's no position, and nothing to disagree with.
      return !position || position.reconciliation?.status === "reconciled"
    }
    // A mismatch is a mismatch, and without the starting balance there are no legs to compare, whatever a read says.
    if (!incomplete && !unreadStart && last && adds(last)) {
      gaps.set(asset, { through: last.blockNum, mismatch: false })
      continue
    }
    // ETH's legs can still be wrong where a claim hasn't settled, or a fee is missing. What happened after a balance can't explain it.
    const clearAt = (block: number) =>
      asset !== "ETH" || !((onchain.gasUnknownBlocks ?? []).some((gas) => gas <= block) || legs.some((leg) => leg.asset === "ETH" && leg.blockNum <= block && (leg.unsettledCredit || l1FeeUnknown.has(leg.txHash))))
    const compared = incomplete ? reconciliation.blockNum : last?.blockNum
    const clear = asset === "ETH" ? onchain.lastCheckableEth : null
    const mismatch = !unreadStart && ((compared !== undefined && clearAt(compared)) || (!!clear && clearAt(clear.blockNum) && !adds(clear)))
    gaps.set(asset, { through: Number.NEGATIVE_INFINITY, mismatch })
  }
  return gaps
}

/** Without a recent read, the price is gone rather than old: an old one would quietly mark the position wrong. */
export function latestPrices(reference: Reference | null): LatestPrices {
  const prices: LatestPrices = {}
  const eth = answerToMicros(reference?.ethUsd)
  const usdc = answerToMicros(reference?.usdcUsd)
  if (reference && eth) prices.ETH = { micros: eth, source: "oracle", blockNum: reference.blockNum }
  if (reference && usdc) prices.USDC = { micros: usdc, source: "oracle", blockNum: reference.blockNum }
  return prices
}

/** A feed's latest answer at a block, and when that block was. */
export type FeedRound = RateRound & { blockNum: number; timestamp: string }

/**
 * What a feed in `TOKEN_FEEDS` makes this asset worth at its block, or null when it's too old or implausible. `Oracle.price`
 * in `Chain.swift` does the same for the hot wallet. An answer or bound in ETH means no price without ETH's.
 */
export function feedPrice(asset: string, round: FeedRound, ethUsdMicros: string | null): string | null {
  const feed = TOKEN_FEEDS[asset]
  const token = tokenBySymbol(asset)
  if (!feed || !token) return null
  const age = Math.floor(new Date(round.timestamp).getTime() / 1000) - round.updatedAt
  if (!(age >= 0 && age <= feed.maxAgeSeconds)) return null
  if (feed.answersInEth && ethUsdMicros === null) return null
  const unit = feed.answersInEth ? BigInt(ethUsdMicros as string) : 1_000_000n
  const micros = worth(BigInt(round.answer), unit, feed.decimals).toString()
  return isSanePrice(token, micros, ethUsdMicros) ? micros : null
}

const answer = (sum: bigint, coverage: SumParts) => (hasAnswer(coverage) ? sum.toString() : null)

export function sumTotals(positions: readonly Position[], unread: readonly string[] = []): Totals {
  let value = 0n
  let realized = 0n
  let unrealized = 0n
  let gas = 0n
  let unpricedGas = false
  let unresolved = 0n
  let estimatedTotal = 0n
  const estimated = { value: false, realized: false, unrealized: false }
  const noMarket: string[] = []
  const excluded: Exclusion[] = []
  const coverage = { value: { known: 0, missing: 0 }, realized: { known: 0, missing: 0 }, unrealized: { known: 0, missing: 0 }, pnl: { known: 0, missing: 0 } }
  for (const position of positions) {
    const { asset, values, state, reconciliation, estimates, price, decimals } = position
    if (position.noMarket) {
      noMarket.push(asset)
      continue
    }
    if (price !== null) unresolved += worth(BigInt(values.unknownCostQty), BigInt(price.micros), decimals)
    const marketValue = estimates.value && values.valueMicros !== null ? BigInt(values.valueMicros) : 0n
    const heldEstimate = estimates.cost && BigInt(values.estimatedCostMicros) > marketValue ? BigInt(values.estimatedCostMicros) : marketValue
    if (estimates.value && values.valueMicros !== null && BigInt(values.qty) > 0n) estimated.value = true
    if (estimates.realized) estimated.realized = true
    if (estimates.unrealized && values.unrealizedMicros !== null) estimated.unrealized = true
    // Only what's in the PnL counts as resting on an estimate. A position that's left out adds nothing to it.
    if (estimates.unrealized && values.unrealizedMicros !== null) estimatedTotal += heldEstimate
    if (estimates.realized && values.realizedMicros !== null) estimatedTotal += BigInt(values.estimatedRealizedMicros)
    gas += BigInt(state.gasMicros)
    if (BigInt(state.gasMicros) > 0n) coverage.pnl.known++
    if (BigInt(state.unpricedGasQty) > 0n) {
      unpricedGas = true
      coverage.pnl.missing++
    }
    const held = BigInt(values.qty) > 0n
    if (isUnconfirmed(position)) {
      excluded.push({ asset, reason: reconciliation?.status === "incomplete" ? "doesn't match its actual balance" : "not checked against its actual balance" })
      coverage.realized.missing++
      coverage.unrealized.missing++
      // The chain didn't say what it holds right now, so its value is our best estimate, and that isn't a known value.
      if (reconciliation?.status === "unchecked" && !reconciliation.heldIsCurrent) {
        coverage.value.missing++
        if (BigInt(state.shortfallQty) > 0n) excluded.push({ asset, reason: "incomplete history" })
      }
      if (values.valueMicros !== null) {
        value += BigInt(values.valueMicros)
        if (held) coverage.value.known++
      } else if (held) {
        coverage.value.missing++
        excluded.push({ asset, reason: "no current price" })
      }
      continue
    }
    // More left than we saw arrive, so there are units we can't see. Whatever this position shows, it isn't all of it.
    if (BigInt(state.shortfallQty) > 0n) {
      coverage.value.missing++
      coverage.unrealized.missing++
      excluded.push({ asset, reason: "incomplete history" })
    }
    if (values.valueMicros !== null) {
      value += BigInt(values.valueMicros)
      if (held) coverage.value.known++
    } else if (held) {
      coverage.value.missing++
      excluded.push({ asset, reason: "no current price" })
    }
    if (values.realizedMicros !== null) {
      realized += BigInt(values.realizedMicros)
    } else {
      coverage.realized.missing++
      if (BigInt(state.unknownCostDisposedQty) > 0n) excluded.push({ asset, reason: "sold or spent at an unknown cost" })
      if (BigInt(state.unknownProceedsQty) > 0n) excluded.push({ asset, reason: "sold or spent at an unknown price" })
    }
    // Only what the sum actually includes counts as known. A position with an unresolved sale is left out whole.
    if (values.realizedMicros !== null && BigInt(state.resolvedDisposedQty) > 0n) coverage.realized.known++
    if (values.unrealizedMicros !== null) {
      unrealized += BigInt(values.unrealizedMicros)
      if (held) coverage.unrealized.known++
    } else if (held) {
      coverage.unrealized.missing++
      if (BigInt(values.unknownCostQty) > 0n) excluded.push({ asset, reason: "unknown cost" })
    }
  }
  for (const asset of unread) {
    excluded.push({ asset, reason: "balance couldn't be read" })
    coverage.value.missing++
    coverage.unrealized.missing++
  }
  coverage.pnl.known += coverage.realized.known + coverage.unrealized.known
  coverage.pnl.missing += coverage.realized.missing + coverage.unrealized.missing
  return {
    valueMicros: answer(value, coverage.value),
    realizedMicros: answer(realized, coverage.realized),
    unrealizedMicros: answer(unrealized, coverage.unrealized),
    gasMicros: gas === 0n && unpricedGas ? null : gas.toString(),
    pnlMicros: answer(realized + unrealized - gas, coverage.pnl),
    excluded,
    unpricedGas,
    coverage,
    unresolvedMicros: unresolved.toString(),
    estimatedMicros: estimatedTotal.toString(),
    estimated,
    noMarket,
  }
}

/** A token's price at a block, in the currency being folded, for marking what's held at that moment. */
export type MarkPrice = (blockNum: number, asset: string) => string | null

/** Each block's prices, in USD, from the oracle reads that come with a wallet's legs, and what other tokens traded at, if that's known. */
export function referenceMarks(references: readonly Reference[], market: MarketMarks = {}): MarkPrice {
  const refs = new Map(references.map((r) => [r.blockNum, r]))
  return (blockNum, asset) => {
    const ref = refs.get(blockNum)
    if (asset === "ETH") return answerToMicros(ref?.ethUsd)
    if (asset === "USDC") return answerToMicros(ref?.usdcUsd)
    return market[blockNum]?.[asset] ?? null
  }
}

/** Whether a token's price at a block is an estimate, so a chart can say so. It's only asked about a price there is. */
export type MarkEstimated = (blockNum: number, asset: string) => boolean

/** Whether `referenceMarks` got a price from a market. Oracle reads and feeds aren't estimates. */
export function marketMarked(market: MarketMarks = {}, feeds: FeedMarks = {}): MarkEstimated {
  return (blockNum, asset) => asset !== "ETH" && asset !== "USDC" && market[blockNum]?.[asset] !== undefined && !feeds[blockNum]?.includes(asset)
}
export type Portfolio = { method: Method; positions: Position[]; totals: Totals }

/** cost = fold(pricedLegs, method). Without `prices`, every position's value and unrealized PnL stay unknown. */
export function buildPortfolio(legs: readonly PricedLeg[], method: Method, prices: LatestPrices = {}): Portfolio {
  const positions = foldPositions(legs, method, prices)
  return { method, positions, totals: sumTotals(positions) }
}

/**
 * Whether `totals.pnlMicros` can be read as the wallet's PnL.
 * partial: it leaves something out. unavailable: it's null, because nothing in it is known.
 */
export type PnlStatus = "complete" | "partial" | "unavailable"

/** `gasUnknownTxs` comes with a wallet's legs. The fold never sees that gas, so `totals` alone can't tell it's missing. */
export function pnlStatus(totals: Totals, gasUnknownTxs: readonly string[] = []): PnlStatus {
  if (totals.pnlMicros === null) return "unavailable"
  return totals.excluded.length === 0 && !totals.unpricedGas && gasUnknownTxs.length === 0 ? "complete" : "partial"
}

export type PnlPoint = {
  blockNum: number
  timestamp: string
  txHash: string | null
  /** Realized, plus unrealized at that moment's prices, less gas. Only what's known, and null when nothing is. */
  pnlMicros: string | null
  /** What `pnlMicros` is made of includes an estimated cost or proceeds, or a price from a market at that moment. Only there when it's true. */
  pnlEstimated?: boolean
  excludedCount: number
  /** What was held right after it, at that moment's prices. Only what's known, and null when nothing is. */
  valueMicros: string | null
  /** What was held right before it, at the same prices, so a deposit shows as a jump and not a slope. */
  valueBeforeMicros: string | null
  /** What `valueMicros` leaves out. `valueBeforeMicros` can leave out other things, and then it's null. */
  valueExcludedCount: number
  /**
   * Whether only prices moved since the point before: what's held is the same, and so is what's left out, which a count
   * can't say. Otherwise `valueBeforeMicros` can't be compared to that point's `valueMicros`.
   */
  valueContinues: boolean
  /**
   * Prices were read as often as a chart can show all the way from the point before, so what's between them is known and
   * not a guess. Only there when it's true.
   */
  valueRead?: boolean
}

/**
 * Total PnL after each transaction, plus a last point at `latest` and current prices, matching the headline.
 * Tokens are marked to that block's oracle or market price, and never to a trade's own price, so a trade can't make a
 * spike. Without one, like in the headline, a token adds no unrealized PnL and counts in `excludedCount`.
 *
 * Each of `sampleBlocks` adds a point with no transaction, between two that have one, wherever it can price what those
 * can. Only for value: PnL holds still between transactions, so those points say what it was at the one before. One it
 * can't price, or that nobody's read yet, adds nothing, and that stretch stays a guess. One that prices more than the point
 * before can't be joined to it, so it starts a new stretch.
 */
export function pnlOverTime(
  legs: readonly PricedLeg[],
  method: Method,
  prices: LatestPrices,
  markPrice: MarkPrice,
  latest: { blockNum: number; timestamp: string } | null,
  /** Assets the chain hasn't confirmed. We can't tell when that started, so their PnL is left out of every point. */
  unconfirmed: ReadonlySet<string> = new Set(),
  /** Assets with no market, which can't affect PnL. */
  noMarket: ReadonlySet<string> = new Set(),
  /** Blocks with prices that aren't there for a transaction. */
  sampleBlocks: readonly number[] = [],
  /** Which of `markPrice`'s prices are estimates. */
  markEstimated: MarkEstimated = () => false,
): PnlPoint[] {
  const states = new Map<string, PositionState>()
  const points: PnlPoint[] = []
  const measure = (priceOf: (asset: string) => string | null, priceEstimated: (asset: string) => boolean) => {
    const coverage: SumParts = { known: 0, missing: 0 }
    let pnl = 0n
    let excludedCount = 0
    let pnlEstimated = false
    for (const [asset, state] of states) {
      if (noMarket.has(asset)) continue
      const v = valuePosition(state, priceOf(asset))
      pnl -= BigInt(state.gasMicros)
      if (BigInt(state.gasMicros) > 0n) coverage.known++
      if (BigInt(state.unpricedGasQty) > 0n) coverage.missing++
      if (unconfirmed.has(asset)) {
        excludedCount++
        coverage.missing++
        continue
      }
      if (BigInt(state.shortfallQty) > 0n) coverage.missing++
      if (v.realizedMicros === null) {
        excludedCount++
        coverage.missing++
      } else {
        pnl += BigInt(v.realizedMicros)
        if (BigInt(v.estimatedRealizedMicros) > 0n) pnlEstimated = true
        if (BigInt(state.resolvedDisposedQty) > 0n) coverage.known++
      }
      if (v.unrealizedMicros !== null) {
        pnl += BigInt(v.unrealizedMicros)
        if (BigInt(v.qty) > 0n) {
          coverage.known++
          if (BigInt(v.estimatedCostMicros) > 0n || priceEstimated(asset)) pnlEstimated = true
        }
      } else if (BigInt(v.qty) > 0n) {
        excludedCount++
        coverage.missing++
      }
    }
    // One that no leg touches yet, or ever, like a wallet funded only by an internal transfer, still counts.
    for (const asset of unconfirmed) {
      if (states.has(asset)) continue
      excludedCount++
      coverage.missing++
    }
    return { pnlMicros: answer(pnl, coverage), excludedCount, ...(pnlEstimated ? { pnlEstimated } : {}) }
  }
  // What's held, and nothing about cost. A quantity history can't vouch for is left out, like one with no price.
  const worthNow = (priceOf: (asset: string) => string | null) => {
    const coverage: SumParts = { known: 0, missing: 0 }
    let value = 0n
    const excluded: string[] = []
    for (const [asset, state] of states) {
      if (noMarket.has(asset)) continue
      const v = valuePosition(state, priceOf(asset))
      if (unconfirmed.has(asset) || BigInt(state.shortfallQty) > 0n || (v.valueMicros === null && BigInt(v.qty) > 0n)) {
        excluded.push(asset)
        coverage.missing++
      } else if (v.valueMicros !== null && BigInt(v.qty) > 0n) {
        value += BigInt(v.valueMicros)
        coverage.known++
      }
    }
    for (const asset of unconfirmed) {
      if (states.has(asset)) continue
      excluded.push(asset)
      coverage.missing++
    }
    return { valueMicros: answer(value, coverage), excluded: excluded.sort() }
  }
  let before: Worth | null = null
  let previous: Worth | null = null
  let arrivedUnnamed = false
  let sampleMissed = false
  const valueAround = (before: Worth | null, after: Worth) => {
    const valueContinues = previous !== null && before !== null && !arrivedUnnamed && leavesOutTheSame(previous, before)
    const value = {
      valueMicros: after.valueMicros,
      valueBeforeMicros: before !== null && leavesOutTheSame(before, after) ? before.valueMicros : null,
      valueExcludedCount: after.excluded.length,
      valueContinues,
      ...(valueContinues && sampleBlocks.length > 0 && !sampleMissed ? { valueRead: true } : {}),
    }
    previous = after
    arrivedUnnamed = false
    sampleMissed = false
    return value
  }
  const samples = [...new Set(sampleBlocks)].sort((a, b) => a - b)
  let nextSample = 0
  let lastPoint: PnlPoint | undefined
  const sampleBefore = (block: number) => {
    for (; (samples[nextSample] ?? Number.POSITIVE_INFINITY) < block; nextSample++) {
      const blockNum = samples[nextSample] as number
      if (!lastPoint || !latest || !previous) continue
      const now = worthNow((asset) => markPrice(blockNum, asset))
      if (!leavesOutTheSame(previous, now) && !leavesOutLess(now, previous)) {
        sampleMissed = true
        continue
      }
      lastPoint = { blockNum, timestamp: timestampOfBlock(blockNum, latest), txHash: null, pnlMicros: lastPoint.pnlMicros, excludedCount: lastPoint.excludedCount, ...valueAround(now, now) }
      points.push(lastPoint)
    }
  }
  legs.forEach((leg, i) => {
    sampleBefore(leg.blockNum)
    const at = (asset: string) => markPrice(leg.blockNum, asset)
    if (!leg.opening && leg.txHash && legs[i - 1]?.txHash !== leg.txHash) before = worthNow(at)
    states.set(leg.asset, applyLeg(states.get(leg.asset) ?? emptyPosition(method, leg.decimals), leg))
    // ETH that arrived with no transaction to name has nothing to click, and the next point counts it, but what's held did change.
    if (leg.opening || !leg.txHash) {
      arrivedUnnamed = true
      return
    }
    if (legs[i + 1]?.txHash === leg.txHash) return
    const after = worthNow(at)
    lastPoint = { blockNum: leg.blockNum, timestamp: leg.timestamp, txHash: leg.txHash, ...measure(at, (asset) => markEstimated(leg.blockNum, asset)), ...valueAround(before, after) }
    points.push(lastPoint)
  })
  if (latest && (states.size > 0 || unconfirmed.size > 0)) {
    sampleBefore(latest.blockNum)
    const now = worthNow((asset) => prices[asset]?.micros ?? null)
    points.push({ blockNum: latest.blockNum, timestamp: latest.timestamp, txHash: null, ...measure((asset) => prices[asset]?.micros ?? null, (asset) => prices[asset]?.source === "market"), ...valueAround(now, now) })
  }
  return points
}

type Worth = { valueMicros: string | null; excluded: string[] }

/** Two values can only be compared when they leave out the same things. */
const leavesOutTheSame = (a: Worth, b: Worth) => a.excluded.join() === b.excluded.join()

/** Everything `a` leaves out, `than` does too, and it leaves out more. */
const leavesOutLess = (a: Worth, than: Worth) => a.excluded.length < than.excluded.length && a.excluded.every((asset) => than.excluded.includes(asset))
