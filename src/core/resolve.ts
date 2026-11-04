// Fills in what we can about each incoming movement's cost, across all of a user's linked wallets, and says what's left to ask.
//
// In order: paid, inherited, self-reported, received at market, unknown. `paid` comes from the transaction itself (legs.ts).
// The rest come from here, and the fold then runs on the result. An unanswered sender stays unknown: it could be the user's
// own wallet, so assuming otherwise would be a guess.

import { applyLegTaking, emptyPosition, foldPositions, normalizeAddress, pnlOverTime, pnlStatus, sumTotals, unconfirmedAssets, unreadAssets, worth, type CostPiece, type Method, type PnlPoint, type PnlStatus, type Position, type PositionState, type PricedLeg, type Totals } from "@pricetag/sdk/core"
import type { BookPreview, WalletResponse } from "./api.ts"
import { costKey, linkedWallets, type Book, type ExchangeCost, type Money, type Receipt } from "./book.ts"
import { usableAnswer, usdView, viewWallet, type WalletView } from "./currency.ts"
import { matchWithdrawals, type ExchangeArrival } from "./exchange-import.ts"
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

/** Part of a piece, with its share of the cost. Taking it all takes all of the cost, so rounding never loses any. */
function slice(piece: CostPiece, qty: bigint): CostPiece {
  const whole = BigInt(piece.qty)
  const share = (micros: string) => (qty === whole ? BigInt(micros) : (BigInt(micros) * qty) / whole).toString()
  return { ...piece, qty: qty.toString(), costMicros: piece.costMicros === null ? null : share(piece.costMicros), estimatedCostMicros: share(piece.estimatedCostMicros) }
}

/** What's left of a piece after a slice of it is gone. */
function without(piece: CostPiece, taken: CostPiece): CostPiece {
  const less = (micros: string | null, gone: string | null) => (micros === null ? null : (BigInt(micros) - BigInt(gone as string)).toString())
  return { ...piece, qty: (BigInt(piece.qty) - BigInt(taken.qty)).toString(), costMicros: less(piece.costMicros, taken.costMicros), estimatedCostMicros: less(piece.estimatedCostMicros, taken.estimatedCostMicros) as string }
}

/** Each transfer in a debit, in the order it went. Null when the leg isn't simply that, as when something also came back. */
function recipientsOf(leg: PricedLeg): Source[] | null {
  const transfers: Source[] = []
  // One per transfer, not per address: oldest first follows the order they went in, even to the same wallet twice.
  for (const part of [...leg.parts].sort((a, b) => a.log_index - b.log_index)) {
    if (part.side === "credit" || !part.counterparty) return null
    transfers.push({ address: normalizeAddress(part.counterparty), units: BigInt(part.amount) })
  }
  return transfers.reduce((sum, { units }) => sum + units, 0n) === -BigInt(leg.delta) ? transfers : null
}

/**
 * What a debit took, split between everyone it went to, whether or not their wallets are read. That way a recipient's cost
 * can't depend on which wallet is open, and nothing's counted twice or lost. Oldest first gives the first transfer the oldest
 * lots. Average gives each one the same mix, because that's what it means: every unit cost the same.
 */
export function allocateTaken(taken: readonly CostPiece[], recipients: readonly Source[], method: Method): Map<string, CostPiece[]> {
  let left = [...taken]
  const allocated = new Map<string, CostPiece[]>()
  for (const { address, units } of recipients) {
    const pieces: CostPiece[] = []
    const remaining = left.reduce((sum, piece) => sum + BigInt(piece.qty), 0n)
    let need = units
    const takeFrom = (index: number, qty: bigint) => {
      const piece = left[index] as CostPiece
      const size = qty < BigInt(piece.qty) ? qty : BigInt(piece.qty)
      if (size === 0n) return
      const part = slice(piece, size)
      pieces.push(part)
      left[index] = without(piece, part)
      need -= size
    }
    if (method === "average" && remaining > 0n) left.forEach((piece, index) => takeFrom(index, (BigInt(piece.qty) * units) / remaining))
    // What rounding left over, or for oldest first, all of it, in order.
    left.forEach((_, index) => takeFrom(index, need))
    left = left.filter((piece) => BigInt(piece.qty) > 0n)
    allocated.set(address, [...(allocated.get(address) ?? []), ...pieces])
  }
  return allocated
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

/**
 * This receipt's share of what was last entered for it, or null when nothing covers it, or the chain no longer says what was
 * answered. A newer answer takes over for the receipts it covers. The rest keep their shares, which only depend on the
 * receipts their own answer was for, and add up to its whole amount.
 */
function exchangeShare(costs: readonly ExchangeCost[], wallet: string, legId: string, units: bigint): Money | null {
  for (const { micros, currency, receipts } of [...costs].reverse()) {
    const at = receipts.findIndex((r) => r.wallet === wallet && r.legId === legId)
    if (at < 0) continue
    if (BigInt((receipts[at] as Receipt).units) !== units) return null
    const total = receipts.reduce((sum, r) => sum + BigInt(r.units), 0n)
    const upTo = (end: number) => (BigInt(micros) * receipts.slice(0, end).reduce((sum, r) => sum + BigInt(r.units), 0n)) / total
    return { micros: (upTo(at + 1) - upTo(at)).toString(), currency }
  }
  return null
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

  // Everything that could be an exchange withdrawal, across every wallet read, so one withdrawal can't explain two of them.
  const arrivals: ExchangeArrival[] = sides.flatMap(({ wallet, view }) =>
    view.legs.flatMap((leg) => {
      const sources = leg.kind === "transfer" && !leg.opening && isOpenCredit(leg) ? sourcesOf(leg) : null
      const someoneElses = sources?.some(({ address }) => book.senders[address]?.kind === "someone-else" || linked.has(address) || address === normalizeAddress(wallet.address))
      return sources && !someoneElses ? [{ key: costKey(wallet.address, leg.id), wallet: wallet.address, asset: leg.asset, units: BigInt(leg.delta), timestamp: leg.timestamp }] : []
    }),
  )
  const withdrawals = matchWithdrawals(book.withdrawals, arrivals)

  const steps = sides
    .flatMap((side) => side.view.legs.map((leg, index) => ({ side, leg, index })))
    // In chain order, with what left before what arrived, because a transfer's cost is whatever its debit took.
    .sort((a, b) => a.leg.blockNum - b.leg.blockNum || a.leg.txIndex - b.leg.txIndex || Number(BigInt(a.leg.delta) > 0n) - Number(BigInt(b.leg.delta) > 0n))

  const states = new Map<string, PositionState>()
  const carried = new Map<string, CostPiece[]>()
  const output = new Map(sides.map(({ wallet, view }) => [normalizeAddress(wallet.address), [...view.legs]]))

  /** What a sender's debit in this transaction allotted this wallet. Whatever isn't there can't be traced, so it stays unresolved. */
  const pull = (leg: PricedLeg, sender: string, recipient: string, units: bigint): CostPiece[] => {
    const pool = carried.get(`${leg.txHash}:${sender}:${leg.asset}:${recipient}`) ?? []
    const [pieces] = allocateTaken(pool, [{ address: recipient, units }], "fifo").values()
    const traced = (pieces ?? []).map((piece): CostPiece => ({ ...piece, label: piece.costMicros === null ? "unknown" : "inherited" }))
    const left = traced.reduce((rest, piece) => rest - BigInt(piece.qty), units)
    return left > 0n ? [...traced, { qty: left.toString(), costMicros: null, label: "unknown", estimatedCostMicros: "0" }] : traced
  }

  const resolve = (side: Side, leg: PricedLeg): PricedLeg => {
    if (!isOpenCredit(leg)) return leg
    const { wallet } = side
    const address = normalizeAddress(wallet.address)
    const units = BigInt(leg.delta)
    const note = wallet.notes.filter((n) => n.txHash === leg.txHash && n.asset === leg.asset).at(-1)
    const sources = leg.kind === "transfer" && !leg.opening ? sourcesOf(leg) : null
    const reportedMoney: Money | undefined = book.costs[costKey(address, leg.id)] ?? (note ? { micros: note.usdMicros, currency: "USD" } : undefined) ?? withdrawals.get(costKey(address, leg.id))?.cost
    const report = reportedMoney ? moneyIn(side, reportedMoney, leg) : null

    const pending: OpenItem[] = []
    const pieces = (sources ?? []).flatMap(({ address: sender, units: part }): CostPiece[] => {
      const unknown: CostPiece = { qty: part.toString(), costMicros: null, label: "unknown", estimatedCostMicros: "0" }
      const answer = book.senders[sender]
      if (answer?.kind === "mine" || linked.has(sender) || sender === address) return read.has(sender) ? pull(leg, sender, address, part) : [unknown]
      if (answer?.kind === "my-exchange") {
        const share = exchangeShare(answer.costs ?? [], address, leg.id, part)
        const cost = share ? moneyIn(side, share, leg) : null
        if (cost !== null) return [{ qty: part.toString(), costMicros: cost, label: "self-reported", estimatedCostMicros: "0" }]
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
      // What it cost is known, in USD, and only the rate is missing. Nobody can answer that, and it may yet be read.
      if (leg.conversion?.rateMicros !== null || leg.conversion.costUsdMicros === null) open.push({ wallet: address, leg, sender: null, units })
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
    const recipients = next.kind === "transfer" && taken.length > 0 ? recipientsOf(next) : null
    for (const [recipient, pieces] of allocateTaken(taken, recipients ?? [], method)) carried.set(`${next.txHash}:${address}:${next.asset}:${recipient}`, pieces)
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
  /** What an answer about cost would cover. It's kept with the answer, so what arrives later is asked about in turn. */
  receipts: Receipt[]
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

export type Meter = {
  open: number
  answered: number
  /** Linked wallets not read yet. What came from them is still unresolved, though nothing's left to ask about it. */
  waiting: number
}

export const isBalanced = ({ open, answered, waiting }: Meter) => open === 0 && answered > 0 && waiting === 0

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
    // A missing exchange rate takes the price away in this currency, but it's still a real token worth asking about.
    if (leg.priceMicros === null && leg.conversion?.priceUsdMicros == null && owner.wallet.prices[leg.asset] === undefined && owner.wallet.marketChecked) continue
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
      receipts: [],
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
    question.receipts.push({ wallet, legId: leg.id, asset: leg.asset, units: units.toString() })
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

export function meterOf(questions: readonly Question[], book: Book, focus: string, waiting: number): Meter {
  const open = new Set(questions.map((q) => q.sender).filter((s) => s !== null))
  const senders = Object.keys(book.senders).filter((address) => address !== normalizeAddress(focus) && !open.has(address)).length
  return { open: questions.length, answered: senders + Object.keys(book.costs).length, waiting }
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
    meter: meterOf(questions, book, address, missingWallets(book, address, others).length),
  }
}

/** The linked wallets a book needs that aren't in `read`. */
export const missingWallets = (book: Book, focus: string, read: readonly WalletResponse[]) => {
  const have = new Set([normalizeAddress(focus), ...read.map((w) => normalizeAddress(w.address))])
  return linkedWallets(book).filter((address) => !have.has(address))
}

/** What a different set of answers would make the headline say, before any of them is final. */
export function previewBook(focus: WalletResponse, others: readonly WalletResponse[], method: Method, book: Book, failed: readonly string[] = []): BookPreview {
  const { totals, pnlStatus: status, questions } = foldBook(focus, others, method, book)
  return { pnlMicros: totals.pnlMicros, pnlStatus: status, estimatedMicros: totals.estimatedMicros, unresolvedMicros: totals.unresolvedMicros, open: questions.length, pending: missingWallets(book, focus.address, others).length > 0, failed: linkedWallets(book).some((address) => failed.includes(address)) }
}
