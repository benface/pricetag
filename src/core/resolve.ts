// Fills in what we can about each incoming movement's cost, across all of a user's linked wallets, and says what's left to ask.
//
// In order: paid, inherited, self-reported, received at market, unknown. `paid` comes from the transaction itself (legs.ts).
// The rest come from here, and the fold then runs on the result. An unanswered sender stays unknown: it could be the user's
// own wallet, so assuming otherwise would be a guess.

import { applyLegTaking, emptyPosition, usdOf, type CostPiece, type Method, type PositionState } from "./fold.ts"
import type { WalletResponse } from "./api.ts"
import { costKey, linkedWallets, type Book } from "./book.ts"
import { matchWithdrawal } from "./exchange-import.ts"
import { formatAmount } from "./format.ts"
import type { PricedLeg } from "./legs.ts"
import { MINT_ADDRESS, knownSender, type KnownSender } from "./senders.ts"
import { normalizeAddress } from "./tokens.ts"

/** What arrived with no cost, and who could say. A null sender means there's no one to ask about, only what it cost. */
type OpenItem = { wallet: string; leg: PricedLeg; sender: string | null; units: bigint }

export type Resolved = { legs: Map<string, PricedLeg[]>; open: OpenItem[] }

type Source = { address: string; units: bigint }

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

const sum = (pieces: readonly CostPiece[]) => pieces.reduce((total, p) => total + BigInt(p.costUsdMicros ?? "0"), 0n)

function withPieces(leg: PricedLeg, pieces: CostPiece[]): PricedLeg {
  const known = pieces.filter((p) => p.costUsdMicros !== null)
  if (known.length === 0) return { ...leg, pieces }
  const inherited = known.some((p) => p.label === "inherited")
  return {
    ...leg,
    pieces,
    costLabel: inherited ? "inherited" : (known[0] as CostPiece).label,
    costUsdMicros: known.length === pieces.length ? sum(known).toString() : null,
    ...(known.some((p) => BigInt(p.estimatedCostUsdMicros) > 0n) ? { estimated: true } : {}),
  }
}

const reported = (leg: PricedLeg, usdMicros: string): PricedLeg => ({ ...leg, costLabel: "self-reported", costUsdMicros: usdMicros })

export function resolveLegs(wallets: readonly WalletResponse[], method: Method, book: Book): Resolved {
  const linked = new Set(linkedWallets(book))
  const read = new Set(wallets.map((w) => normalizeAddress(w.address)))
  const open: OpenItem[] = []

  // What each sender sent, by asset, so a total someone entered for it can be split across its transfers.
  const fromSender = new Map<string, bigint>()
  for (const wallet of wallets) {
    for (const leg of wallet.legs) {
      if (leg.kind !== "transfer" || !isOpenCredit(leg)) continue
      for (const { address, units } of sourcesOf(leg) ?? []) fromSender.set(`${address}:${leg.asset}`, (fromSender.get(`${address}:${leg.asset}`) ?? 0n) + units)
    }
  }

  const steps = wallets
    .flatMap((wallet) => wallet.legs.map((leg, index) => ({ wallet, leg, index })))
    // In chain order, with what left before what arrived, because a transfer's cost is whatever its debit took.
    .sort((a, b) => a.leg.blockNum - b.leg.blockNum || a.leg.txIndex - b.leg.txIndex || Number(BigInt(a.leg.delta) > 0n) - Number(BigInt(b.leg.delta) > 0n))

  const states = new Map<string, PositionState>()
  const carried = new Map<string, CostPiece[]>()
  const output = new Map(wallets.map((w) => [normalizeAddress(w.address), [...w.legs]]))

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
      const cost = next.costUsdMicros === null ? null : whole ? BigInt(next.costUsdMicros) : (BigInt(next.costUsdMicros) * size) / qty
      const estimated = whole ? BigInt(next.estimatedCostUsdMicros) : (BigInt(next.estimatedCostUsdMicros) * size) / qty
      pieces.push({ ...next, qty: size.toString(), costUsdMicros: cost === null ? null : cost.toString(), label: cost === null ? "unknown" : "inherited", estimatedCostUsdMicros: estimated.toString() })
      if (whole) pool.shift()
      else pool[0] = { ...next, qty: (qty - size).toString(), costUsdMicros: cost === null ? null : (BigInt(next.costUsdMicros as string) - cost).toString(), estimatedCostUsdMicros: (BigInt(next.estimatedCostUsdMicros) - estimated).toString() }
      left -= size
    }
    // Nothing left that we can trace, so it stays unresolved here too.
    if (left > 0n) pieces.push({ qty: left.toString(), costUsdMicros: null, label: "unknown", estimatedCostUsdMicros: "0" })
    return pieces
  }

  const resolve = (wallet: WalletResponse, leg: PricedLeg): PricedLeg => {
    if (!isOpenCredit(leg)) return leg
    const address = normalizeAddress(wallet.address)
    const units = BigInt(leg.delta)
    const note = (wallet.notes ?? []).filter((n) => n.txHash === leg.txHash && n.asset === leg.asset).at(-1)?.usdMicros
    const entered = book.costs[costKey(address, leg.id)]
    const sources = leg.kind === "transfer" && !leg.opening ? sourcesOf(leg) : null
    const report = entered ?? note ?? (sources ? matchWithdrawal(book.withdrawals, address, leg.asset, units, leg.timestamp)?.costUsdMicros : undefined)

    const pending: OpenItem[] = []
    const pieces = (sources ?? []).flatMap(({ address: sender, units: part }): CostPiece[] => {
      const unknown: CostPiece = { qty: part.toString(), costUsdMicros: null, label: "unknown", estimatedCostUsdMicros: "0" }
      const answer = book.senders[sender]
      if (answer?.kind === "mine" || linked.has(sender) || sender === address) return read.has(sender) ? pull(leg, sender, part) : [unknown]
      if (answer?.kind === "my-exchange") {
        const total = answer.costs?.[leg.asset]
        const of = fromSender.get(`${sender}:${leg.asset}`) ?? 0n
        if (total !== undefined && of > 0n) return [{ qty: part.toString(), costUsdMicros: ((BigInt(total) * part) / of).toString(), label: "self-reported", estimatedCostUsdMicros: "0" }]
        pending.push({ wallet: address, leg, sender, units: part })
        return [unknown]
      }
      const someoneElse = answer?.kind === "someone-else" || knownSender(sender)?.kind === "bridge" || sender === MINT_ADDRESS
      if (someoneElse) {
        if (leg.priceUsdMicros === null) return [unknown]
        const cost = usdOf(part, BigInt(leg.priceUsdMicros), leg.decimals).toString()
        return [{ qty: part.toString(), costUsdMicros: cost, label: "received at market", estimatedCostUsdMicros: cost }]
      }
      pending.push({ wallet: address, leg, sender, units: part })
      return [unknown]
    })

    if (!pieces.some((p) => p.label === "inherited" && p.costUsdMicros !== null) && report !== undefined) return reported(leg, report)
    if (sources === null) {
      open.push({ wallet: address, leg, sender: null, units })
      return leg
    }
    open.push(...pending)
    return withPieces(leg, pieces)
  }

  for (const { wallet, leg, index } of steps) {
    const address = normalizeAddress(wallet.address)
    const next = resolve(wallet, leg)
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
  valueUsdMicros: string | null
}

export type Meter = { open: number; answered: number }

const day = (timestamp: string) => new Date(timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })

function evidenceFor(sender: string, wallets: readonly WalletResponse[], known: KnownSender | null): string[] {
  const evidence = known ? [`From a ${known.name} address`] : []
  const sends = wallets
    .flatMap((w) => w.legs)
    .filter((leg) => BigInt(leg.delta) < 0n && leg.kind === "transfer" && leg.parts.some((p) => p.counterparty && normalizeAddress(p.counterparty) === sender))
    .sort((a, b) => b.blockNum - a.blockNum)
  const last = sends[0]
  if (!last) return evidence
  const part = last.parts.find((p) => p.counterparty && normalizeAddress(p.counterparty) === sender)
  return [...evidence, `You sent this address ${formatAmount(part?.amount ?? "0", last.decimals)} ${last.asset} on ${day(last.timestamp)}`]
}

/** One card per address, however many transfers it covers. A token with no price anywhere isn't worth asking about. */
export function questionsOf(open: readonly OpenItem[], wallets: readonly WalletResponse[], book: Book): Question[] {
  const walletOf = new Map(wallets.map((w) => [normalizeAddress(w.address), w]))
  const questions = new Map<string, Question & { arrived: Map<string, Arrival>; value: bigint; priced: boolean }>()
  for (const { wallet, leg, sender, units } of open) {
    const owner = walletOf.get(wallet) as WalletResponse
    if (leg.priceUsdMicros === null && owner.prices[leg.asset] === undefined && owner.marketChecked) continue
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
      evidence: sender ? evidenceFor(sender, wallets, known) : [],
      valueUsdMicros: null,
      arrived: new Map<string, Arrival>(),
      value: 0n,
      priced: false,
    }
    const arrival = question.arrived.get(leg.asset) ?? { asset: leg.asset, decimals: leg.decimals, units: "0" }
    question.arrived.set(leg.asset, { ...arrival, units: (BigInt(arrival.units) + units).toString() })
    question.transfers++
    if (leg.timestamp < question.firstAt) question.firstAt = leg.timestamp
    if (leg.timestamp > question.lastAt) question.lastAt = leg.timestamp
    const price = leg.priceUsdMicros ?? owner.prices[leg.asset]?.usdMicros
    if (price) {
      question.value += usdOf(units, BigInt(price), leg.decimals)
      question.priced = true
    }
    questions.set(id, question)
  }
  return [...questions.values()]
    .map(({ arrived, value, priced, ...question }) => ({ ...question, arrivals: [...arrived.values()], valueUsdMicros: priced ? value.toString() : null }))
    .sort((a, b) => {
      const [x, y] = [BigInt(a.valueUsdMicros ?? "0"), BigInt(b.valueUsdMicros ?? "0")]
      return x === y ? a.id.localeCompare(b.id) : x > y ? -1 : 1
    })
}

export function meterOf(questions: readonly Question[], book: Book, focus: string): Meter {
  const open = new Set(questions.map((q) => q.sender).filter((s) => s !== null))
  const senders = Object.keys(book.senders).filter((address) => address !== normalizeAddress(focus) && !open.has(address)).length
  return { open: questions.length, answered: senders + Object.keys(book.costs).length }
}
