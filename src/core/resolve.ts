// Fills in what we can about each incoming movement's cost, across all of a user's linked wallets, and says what's left to ask.
//
// In order: paid, inherited, self-reported, received at market, unknown. `paid` comes from the transaction itself (legs.ts).
// The rest come from here, and the fold then runs on the result. An unanswered sender stays unknown: it could be the user's
// own wallet, so assuming otherwise would be a guess.

import { applyLegTaking, emptyPosition, foldPositions, normalizeAddress, pnlOverTime, pnlStatus, sumTotals, unconfirmedAssets, unreadAssets, worth, type CostPiece, type Method, type PnlPoint, type PnlStatus, type Position, type PositionState, type PricedLeg, type Totals } from "@pricetag/sdk/core"
import type { BookPreview, WalletResponse } from "./api.ts"
import { costKey, linkedWallets, type Book, type Money } from "./book.ts"
import { usableAnswer, usdView, viewWallet, type WalletView } from "./currency.ts"
import { matchWithdrawal } from "./exchange-import.ts"
import { formatAmount } from "./format.ts"
import { MINT_ADDRESS, knownSender, type KnownSender } from "./senders.ts"

/** What arrived with no cost, and who could say. A null sender means there's no one to ask about, only what it cost. */
type OpenItem = { wallet: string; leg: PricedLeg; sender: string | null; units: bigint }

export type Resolved = { legs: Map<string, PricedLeg[]>; open: OpenItem[] }

type Source = { address: string; units: bigint }

/** A wallet, and the amounts it's being folded in. */
type Side = { wallet: WalletResponse; view: WalletView }

const E8 = 10n ** 8n

/**
 * An entered amount in the currency being folded, at the rate when it arrived. Null when there's no such rate, which leaves
 * the cost unknown: a CAD amount read as USD would be quietly wrong.
 */
function moneyIn({ wallet, view }: Side, money: Money, leg: PricedLeg): string | null {
  if (money.currency === view.currency) return money.micros
  const answer = usableAnswer(wallet.rates?.byBlock[leg.blockNum], leg.timestamp)
  if (answer === null) return null
  if (money.currency === "USD") return ((BigInt(money.micros) * E8) / answer).toString()
  return view.currency === "USD" && money.currency === wallet.currency ? ((BigInt(money.micros) * answer) / E8).toString() : null
}

/** Who each part of a credit came from, or null when they can't be told apart, as when something also left. */
function sourcesOf(leg: PricedLeg): Source[] | null {
  const sources = new Map<string, bigint>()
  for (const part of leg.parts) {
    if (part.side === "debit" || !part.counterparty) return null
    const address = normalizeAddress(part.counterparty)
    sources.set(address, (sources.get(address) ?? 0n) + BigInt(part.amount))
  }
  return sources.size === 0 ? null : [...sources].map(([address, units]) => ({ address, units }))
}

const isOpenCredit = (leg: PricedLeg) => BigInt(leg.delta) > 0n && leg.costLabel === "unknown"

const sum = (pieces: readonly CostPiece[]) => pieces.reduce((total, p) => total + BigInt(p.costMicros ?? "0"), 0n)

function withPieces(leg: PricedLeg, pieces: CostPiece[]): PricedLeg {
  const known = pieces.filter((p) => p.costMicros !== null)
  if (known.length === 0) return { ...leg, pieces }
  const inherited = known.some((p) => p.label === "inherited")
  return {
    ...leg,
    pieces,
    costLabel: inherited ? "inherited" : (known[0] as CostPiece).label,
    costMicros: known.length === pieces.length ? sum(known).toString() : null,
    ...(known.some((p) => BigInt(p.estimatedCostMicros) > 0n) ? { estimated: true } : {}),
  }
}

const reported = (leg: PricedLeg, usdMicros: string): PricedLeg => ({ ...leg, costLabel: "self-reported", costMicros: usdMicros })

export function resolveLegs(sides: readonly Side[], method: Method, book: Book): Resolved {
  const linked = new Set(linkedWallets(book))
  const read = new Set(sides.map(({ wallet }) => normalizeAddress(wallet.address)))
  const open: OpenItem[] = []

  // What each sender sent, by asset, so a total someone entered for it can be split across its transfers.
  const fromSender = new Map<string, bigint>()
  for (const { view } of sides) {
    for (const leg of view.legs) {
      if (leg.kind !== "transfer" || !isOpenCredit(leg)) continue
      for (const { address, units } of sourcesOf(leg) ?? []) fromSender.set(`${address}:${leg.asset}`, (fromSender.get(`${address}:${leg.asset}`) ?? 0n) + units)
    }
  }

  const steps = sides
    .flatMap((side) => side.view.legs.map((leg, index) => ({ side, leg, index })))
    // In chain order, with what left before what arrived, because a transfer's cost is whatever its debit took.
    .sort((a, b) => a.leg.blockNum - b.leg.blockNum || a.leg.txIndex - b.leg.txIndex || Number(BigInt(a.leg.delta) > 0n) - Number(BigInt(b.leg.delta) > 0n))

  const states = new Map<string, PositionState>()
  const carried = new Map<string, CostPiece[]>()
  const output = new Map(sides.map(({ wallet, view }) => [normalizeAddress(wallet.address), [...view.legs]]))

  const pull = (leg: PricedLeg, sender: string, units: bigint): CostPiece[] => {
    const key = `${leg.txHash}:${sender}:${leg.asset}`
    const pool = carried.get(key) ?? []
    const pieces: CostPiece[] = []
    let left = units
    while (left > 0n && pool.length > 0) {
      const next = pool[0] as CostPiece
      const qty = BigInt(next.qty)
      const size = qty < left ? qty : left
      const whole = size === qty
      const cost = next.costMicros === null ? null : whole ? BigInt(next.costMicros) : (BigInt(next.costMicros) * size) / qty
      const estimated = whole ? BigInt(next.estimatedCostMicros) : (BigInt(next.estimatedCostMicros) * size) / qty
      pieces.push({ ...next, qty: size.toString(), costMicros: cost === null ? null : cost.toString(), label: cost === null ? "unknown" : "inherited", estimatedCostMicros: estimated.toString() })
      if (whole) pool.shift()
      else pool[0] = { ...next, qty: (qty - size).toString(), costMicros: cost === null ? null : (BigInt(next.costMicros as string) - cost).toString(), estimatedCostMicros: (BigInt(next.estimatedCostMicros) - estimated).toString() }
      left -= size
    }
    // Nothing left that we can trace, so it stays unresolved here too.
    if (left > 0n) pieces.push({ qty: left.toString(), costMicros: null, label: "unknown", estimatedCostMicros: "0" })
    return pieces
  }

  const resolve = (side: Side, leg: PricedLeg): PricedLeg => {
    if (!isOpenCredit(leg)) return leg
    const { wallet } = side
    const address = normalizeAddress(wallet.address)
    const units = BigInt(leg.delta)
    const note = wallet.notes.filter((n) => n.txHash === leg.txHash && n.asset === leg.asset).at(-1)
    const sources = leg.kind === "transfer" && !leg.opening ? sourcesOf(leg) : null
    const reportedMoney: Money | undefined = book.costs[costKey(address, leg.id)] ?? (note ? { micros: note.usdMicros, currency: "USD" } : undefined) ?? (sources ? matchWithdrawal(book.withdrawals, address, leg.asset, units, leg.timestamp)?.cost : undefined)
    const report = reportedMoney ? moneyIn(side, reportedMoney, leg) : null

    const pending: OpenItem[] = []
    const pieces = (sources ?? []).flatMap(({ address: sender, units: part }): CostPiece[] => {
      const unknown: CostPiece = { qty: part.toString(), costMicros: null, label: "unknown", estimatedCostMicros: "0" }
      const answer = book.senders[sender]
      if (answer?.kind === "mine" || linked.has(sender) || sender === address) return read.has(sender) ? pull(leg, sender, part) : [unknown]
      if (answer?.kind === "my-exchange") {
        const entered = answer.costs?.[leg.asset]
        const total = entered ? moneyIn(side, entered, leg) : null
        const of = fromSender.get(`${sender}:${leg.asset}`) ?? 0n
        if (total !== null && of > 0n) return [{ qty: part.toString(), costMicros: ((BigInt(total) * part) / of).toString(), label: "self-reported", estimatedCostMicros: "0" }]
        pending.push({ wallet: address, leg, sender, units: part })
        return [unknown]
      }
      const someoneElse = answer?.kind === "someone-else" || knownSender(sender)?.kind === "bridge" || sender === MINT_ADDRESS
      if (someoneElse) {
        if (leg.priceMicros === null) return [unknown]
        const cost = worth(part, BigInt(leg.priceMicros), leg.decimals).toString()
        return [{ qty: part.toString(), costMicros: cost, label: "received at market", estimatedCostMicros: cost }]
      }
      pending.push({ wallet: address, leg, sender, units: part })
      return [unknown]
    })

    if (!pieces.some((p) => p.label === "inherited" && p.costMicros !== null) && report !== null) return reported(leg, report)
    if (sources === null) {
      open.push({ wallet: address, leg, sender: null, units })
      return leg
    }
    open.push(...pending)
    return withPieces(leg, pieces)
  }

  for (const { side, leg, index } of steps) {
    const address = normalizeAddress(side.wallet.address)
    const next = resolve(side, leg)
    ;(output.get(address) as PricedLeg[])[index] = next
    const key = `${address}:${next.asset}`
    const { state, taken } = applyLegTaking(states.get(key) ?? emptyPosition(method, next.decimals), next)
    states.set(key, state)
    if (next.kind === "transfer" && taken.length > 0) carried.set(`${next.txHash}:${address}:${next.asset}`, taken)
  }
  return { legs: output, open }
}

export type Arrival = { asset: string; decimals: number; units: string }

export type Question = {
  id: string
  /** sender: who is this? cost: there's nobody to ask about, so what did it cost? */
  kind: "sender" | "cost"
  /** The wallet it arrived in. */
  wallet: string
  sender: string | null
  known: KnownSender | null
  /** The cost to enter, for a `cost` question. */
  costKey: string | null
  /** They said it's their exchange account, and it still needs a cost. */
  needsCost: boolean
  arrivals: Arrival[]
  transfers: number
  firstAt: string
  lastAt: string
  /** Facts that might help. Never a preselected answer. */
  evidence: string[]
  /** What arrived, at its price then, which is how the most useful questions come first. Null when none of it has a price. */
  valueMicros: string | null
}

export type Meter = { open: number; answered: number }

const day = (timestamp: string) => new Date(timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })

function evidenceFor(sender: string, sides: readonly Side[], known: KnownSender | null): string[] {
  const evidence = known ? [`From a ${known.name} address`] : []
  const sends = sides
    .flatMap(({ view }) => view.legs)
    .filter((leg) => BigInt(leg.delta) < 0n && leg.kind === "transfer" && leg.parts.some((p) => p.counterparty && normalizeAddress(p.counterparty) === sender))
    .sort((a, b) => b.blockNum - a.blockNum)
  const last = sends[0]
  if (!last) return evidence
  const part = last.parts.find((p) => p.counterparty && normalizeAddress(p.counterparty) === sender)
  return [...evidence, `You sent this address ${formatAmount(part?.amount ?? "0", last.decimals)} ${last.asset} on ${day(last.timestamp)}`]
}

/** One card per address, however many transfers it covers. A token with no price anywhere isn't worth asking about. */
export function questionsOf(open: readonly OpenItem[], sides: readonly Side[], book: Book): Question[] {
  const sideOf = new Map(sides.map((side) => [normalizeAddress(side.wallet.address), side]))
  const questions = new Map<string, Question & { arrived: Map<string, Arrival>; value: bigint; priced: boolean }>()
  for (const { wallet, leg, sender, units } of open) {
    const owner = sideOf.get(wallet) as Side
    if (leg.priceMicros === null && owner.wallet.prices[leg.asset] === undefined && owner.wallet.marketChecked) continue
    const id = sender ? `sender:${sender}` : `cost:${wallet}:${leg.id}`
    const known = sender ? knownSender(sender) : null
    const question = questions.get(id) ?? {
      id,
      kind: sender ? ("sender" as const) : ("cost" as const),
      wallet,
      sender,
      known,
      costKey: sender ? null : costKey(wallet, leg.id),
      needsCost: sender ? book.senders[sender]?.kind === "my-exchange" : false,
      arrivals: [],
      transfers: 0,
      firstAt: leg.timestamp,
      lastAt: leg.timestamp,
      evidence: sender ? evidenceFor(sender, sides, known) : [],
      valueMicros: null,
      arrived: new Map<string, Arrival>(),
      value: 0n,
      priced: false,
    }
    const arrival = question.arrived.get(leg.asset) ?? { asset: leg.asset, decimals: leg.decimals, units: "0" }
    question.arrived.set(leg.asset, { ...arrival, units: (BigInt(arrival.units) + units).toString() })
    question.transfers++
    if (leg.timestamp < question.firstAt) question.firstAt = leg.timestamp
    if (leg.timestamp > question.lastAt) question.lastAt = leg.timestamp
    const price = leg.priceMicros ?? owner.view.prices[leg.asset]?.micros
    if (price) {
      question.value += worth(units, BigInt(price), leg.decimals)
      question.priced = true
    }
    questions.set(id, question)
  }
  return [...questions.values()]
    .map(({ arrived, value, priced, ...question }) => ({ ...question, arrivals: [...arrived.values()], valueMicros: priced ? value.toString() : null }))
    .sort((a, b) => {
      const [x, y] = [BigInt(a.valueMicros ?? "0"), BigInt(b.valueMicros ?? "0")]
      return x === y ? a.id.localeCompare(b.id) : x > y ? -1 : 1
    })
}

export function meterOf(questions: readonly Question[], book: Book, focus: string): Meter {
  const open = new Set(questions.map((q) => q.sender).filter((s) => s !== null))
  const senders = Object.keys(book.senders).filter((address) => address !== normalizeAddress(focus) && !open.has(address)).length
  return { open: questions.length, answered: senders + Object.keys(book.costs).length }
}

export type BookFold = {
  view: WalletView
  legs: PricedLeg[]
  positions: Position[]
  unread: string[]
  totals: Totals
  pnlStatus: PnlStatus
  points: PnlPoint[]
  questions: Question[]
  meter: Meter
}

/**
 * Everything a wallet's numbers come from: the chain, plus what the user has said. Both the browser and the server run this.
 * It runs after conversion, because a cost carried between wallets has to stay in the currency gains are reported in.
 */
export function foldBook(focus: WalletResponse, others: readonly WalletResponse[], method: Method, book: Book, { usd = false } = {}): BookFold {
  const address = normalizeAddress(focus.address)
  const linked = new Set(linkedWallets(book))
  const sideOf = (wallet: WalletResponse): Side => ({ wallet, view: usd ? usdView(wallet) : viewWallet(wallet) })
  const sides = [focus, ...others.filter((w) => normalizeAddress(w.address) !== address && linked.has(normalizeAddress(w.address)))].map(sideOf)
  const view = (sides[0] as Side).view
  const { legs: resolved, open } = resolveLegs(sides, method, book)
  const legs = resolved.get(address) as PricedLeg[]
  const positions = foldPositions(legs, method, view.prices, focus)
  const unread = unreadAssets(positions, focus)
  const totals = sumTotals(positions, unread)
  const questions = questionsOf(open, sides, book)
  return {
    view,
    legs,
    positions,
    unread,
    totals,
    pnlStatus: pnlStatus(totals, focus.gasUnknownTxs),
    points: pnlOverTime(legs, method, view.prices, view.markPrice, focus.latest, unconfirmedAssets(positions, unread), new Set(totals.noMarket)),
    questions,
    meter: meterOf(questions, book, address),
  }
}

/** The linked wallets a book needs that aren't in `read`. */
export const missingWallets = (book: Book, focus: string, read: readonly WalletResponse[]) => {
  const have = new Set([normalizeAddress(focus), ...read.map((w) => normalizeAddress(w.address))])
  return linkedWallets(book).filter((address) => !have.has(address))
}

/** What a different set of answers would make the headline say, before any of them is final. */
export function previewBook(focus: WalletResponse, others: readonly WalletResponse[], method: Method, book: Book): BookPreview {
  const { totals, pnlStatus: status, questions } = foldBook(focus, others, method, book)
  return { pnlMicros: totals.pnlMicros, pnlStatus: status, estimatedMicros: totals.estimatedMicros, unresolvedMicros: totals.unresolvedMicros, open: questions.length, pending: missingWallets(book, focus.address, others).length > 0 }
}

