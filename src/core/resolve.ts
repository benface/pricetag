// Fills in what we can about each incoming movement's cost, across all of a user's linked wallets, and says what's left to ask.
//
// In order: paid, inherited, self-reported, received at market, unknown. `paid` comes from the transaction itself (legs.ts),
// or from a provider's order that matches a movement exactly. The rest come from here, and the fold then runs on the result.
// An unanswered sender stays unknown: it could be the user's own wallet, so assuming otherwise would be a guess.

import { applyLegTaking, emptyPosition, foldWallet, unconfirmedAssets, formatAmount, formatPaid, historyGaps, lessPaidAt, normalizeAddress, orderMatters, plainAmount, sharePaidAt, shortHash, usableAnswer, usdView, viewWallet, withoutCurrency, worth, type CostPiece, type CurrencyCode, type HistoryGap, type HoldComparison, type MarkPrice, type Method, type PnlStatus, type Position, type PositionState, type PricedLeg, type Totals, type WalletView } from "@pricetag/sdk/core"
import { NO_FACTS, legsByTransaction, transactionFacts } from "./activity.ts"
import type { BookPoint, BookPreview, WalletResponse } from "./api.ts"
import { costKey, isDemoWallet, isOwnWallet, linkedWallets, walletsBehind, type Book, type ExchangeCost, type Money, type Purchase, type Receipt, type SenderAnswer } from "./book.ts"
import { matchWithdrawals, type ExchangeArrival } from "./exchange-import.ts"
import { MINT_ADDRESS, knownSender, type KnownSender } from "./senders.ts"
import { describeTransaction, purchaseSource } from "./wording.ts"

/** An amount as typed in `currency`, in millionths of it. Null when it isn't an amount, which includes one in another currency's symbol: `€46` isn't 46 dollars. */
export function microsOf(text: string, currency: CurrencyCode = "USD"): string | null {
  const clean = plainAmount(withoutCurrency(text, currency))
  if (clean === null || !/^(\d+(\.\d*)?|\.\d+)$/.test(clean)) return null
  const [whole = "", fraction = ""] = clean.split(".")
  return BigInt(`${whole || "0"}${fraction.slice(0, 6).padEnd(6, "0")}`).toString()
}

/** What arrived with no cost, and who could say. A null sender means there's no one to ask about, only what it cost. */
type OpenItem = { wallet: string; leg: PricedLeg; sender: string | null; units: bigint; evidence?: string[] }

export type Resolved = {
  legs: Map<string, PricedLeg[]>
  open: OpenItem[]
  purchases: PurchaseState[]
}

/**
 * What became of a purchase. recorded: it's the cost of what arrived. waiting: nothing's been seen arriving from its
 * transaction yet. unmatched: something was, and it isn't exactly what the order says, or it can't be shown in this currency.
 */
export type PurchaseState = { order: string; state: "recorded" | "waiting" | "unmatched" }

/** A wallet whose history of an asset can't be confirmed, so what it sent arrived with its cost unknown. */
export type Withheld = { wallet: string; asset: string }

/** Who's behind what's unknown in these legs, which only says what actually arrived in them, however many wallets it came through. */
export function withheldIn(legs: readonly PricedLeg[]): Withheld[] {
  const withheld = new Map<string, Withheld>()
  for (const { asset, pieces } of legs) {
    for (const wallet of (pieces ?? []).flatMap((piece) => piece.unconfirmedBy ?? [])) withheld.set(`${wallet}:${asset}`, { wallet, asset })
  }
  return [...withheld.values()]
}

type Source = { address: string; units: bigint }

/** A wallet, and the amounts it's being folded in. */
type Side = { wallet: WalletResponse; view: WalletView }

const E8 = 10n ** 8n

/** USD for one unit of a currency when this arrived, from the wallet's own rates or the ones read for what's stored in another. */
function answerAt({ wallet }: Side, currency: CurrencyCode, leg: PricedLeg): bigint | null {
  const own = currency === wallet.currency ? wallet.rates?.byBlock[leg.blockNum] : undefined
  return usableAnswer(own ?? wallet.paidRates?.[currency]?.[leg.blockNum], leg.timestamp)
}

/**
 * A stored amount in the currency being folded, through USD at the rates when it arrived. Null when either rate is missing,
 * which leaves the cost unknown: a CAD amount read as USD would be quietly wrong. The stored amount itself never changes.
 */
function moneyIn(side: Side, money: Money, leg: PricedLeg): string | null {
  const shown = side.view.currency
  if (money.currency === shown) return money.micros
  const from = money.currency === "USD" ? E8 : answerAt(side, money.currency, leg)
  const to = shown === "USD" ? E8 : answerAt(side, shown, leg)
  return from === null || to === null ? null : ((BigInt(money.micros) * from) / to).toString()
}

/** Part of a piece, with its share of the cost. Taking it all takes all of the cost, so rounding never loses any. */
function slice(piece: CostPiece, qty: bigint): CostPiece {
  const whole = BigInt(piece.qty)
  const share = (micros: string) => (qty === whole ? BigInt(micros) : (BigInt(micros) * qty) / whole).toString()
  const cost = piece.costMicros === null ? null : share(piece.costMicros)
  return {
    ...piece,
    qty: qty.toString(),
    costMicros: cost,
    estimatedCostMicros: share(piece.estimatedCostMicros),
    ...(piece.givenCostMicros === undefined ? {} : { givenCostMicros: share(piece.givenCostMicros) }),
    ...(piece.paidAt && cost !== null ? { paidAt: sharePaidAt(piece.paidAt, BigInt(cost), BigInt(piece.costMicros as string), qty, whole) } : {}),
  }
}

/** What's left of a piece after a slice of it is gone. */
function without(piece: CostPiece, taken: CostPiece): CostPiece {
  const less = (micros: string | null, gone: string | null) => (micros === null ? null : (BigInt(micros) - BigInt(gone as string)).toString())
  return {
    ...piece,
    qty: (BigInt(piece.qty) - BigInt(taken.qty)).toString(),
    costMicros: less(piece.costMicros, taken.costMicros),
    estimatedCostMicros: less(piece.estimatedCostMicros, taken.estimatedCostMicros) as string,
    ...(piece.givenCostMicros === undefined ? {} : { givenCostMicros: less(piece.givenCostMicros, taken.givenCostMicros as string) as string }),
    ...(piece.paidAt && taken.paidAt ? { paidAt: lessPaidAt(piece.paidAt, taken.paidAt) } : {}),
  }
}

/** Each transfer in a debit, in the order it went. Null when the leg isn't simply that, as when something also came back. */
function recipientsOf(leg: PricedLeg): Source[] | null {
  const transfers: Source[] = []
  // One per transfer, not per address: oldest first follows the order they went in, even to the same wallet twice.
  for (const part of [...leg.parts].sort((a, b) => a.logIndex - b.logIndex)) {
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

/** A credit the chain hasn't confirmed yet stays unknown: its amount is only what the transaction claims, so nothing can rest on it, and there's nothing to ask until it settles. */
/**
 * Whether a note about this leg's transaction and asset would be about more than this leg. A note gives one cost for what
 * arrived in a transaction, and what its balance says arrived may not be part of that, so it can't be shared out or given to either.
 */
const noteIsAmbiguous = (leg: PricedLeg, legs: readonly PricedLeg[]) => legs.filter((other) => other.txHash === leg.txHash && other.asset === leg.asset && BigInt(other.delta) > 0n).length > 1

const isOpenCredit = (leg: PricedLeg) => BigInt(leg.delta) > 0n && leg.costLabel === "unknown" && !leg.unsettledCredit

const sum = (pieces: readonly CostPiece[]) => pieces.reduce((total, p) => total + BigInt(p.costMicros ?? "0"), 0n)

function withPieces(leg: PricedLeg, pieces: CostPiece[]): PricedLeg {
  const known = pieces.filter((p) => p.costMicros !== null)
  if (known.length === 0) return { ...leg, pieces }
  const inherited = known.some((p) => p.label === "inherited")
  // Bought and then moved here, all of it, so who says what it cost still holds.
  const source = known.length === pieces.length && known.every((p) => p.purchaseSource === known[0]?.purchaseSource && !p.purchasePartly) ? known[0]?.purchaseSource : undefined
  return {
    ...leg,
    ...(source ? { purchaseSource: source } : {}),
    pieces,
    costLabel: inherited ? "inherited" : (known[0] as CostPiece).label,
    costMicros: known.length === pieces.length ? sum(known).toString() : null,
    ...(known.some((p) => BigInt(p.estimatedCostMicros) > 0n) ? { estimated: true } : {}),
  }
}

const reported = (leg: PricedLeg, usdMicros: string): PricedLeg => ({ ...leg, costLabel: "self-reported", costMicros: usdMicros })

/**
 * Whether this movement came from this purchase's transaction. ETH inside a batched payout has no row and may not name its
 * transaction, so it's found by the block its balance rose in, and the exact amount still has to agree.
 */
const cameFrom = (purchase: Purchase, leg: PricedLeg) =>
  leg.asset === purchase.asset && leg.kind === "transfer" && !leg.opening && BigInt(leg.delta) > 0n && (leg.txHash.toLowerCase() === purchase.txHash || (leg.blockNum === purchase.blockNum && leg.parts.some((part) => part.kind === "unseen_eth")))

/** Which movement each purchase paid for, by `costKey`. Only one exact match counts, and a movement only has one cost. */
function purchasedLegs(sides: readonly Side[], book: Book): Map<string, Purchase> {
  const purchased = new Map<string, Purchase>()
  for (const purchase of book.purchases ?? []) {
    const side = sides.find(({ wallet }) => normalizeAddress(wallet.address) === purchase.wallet)
    const exact = side?.view.legs.filter((leg) => cameFrom(purchase, leg) && leg.delta === purchase.units) ?? []
    const key = exact.length === 1 ? costKey(purchase.wallet, (exact[0] as PricedLeg).id) : null
    if (key && !purchased.has(key)) purchased.set(key, purchase)
  }
  return purchased
}

/** What a purchase cost in the currency being folded. Null when that can't be said, which leaves it unknown. */
const purchaseCost = (side: Side, { cost, costUsdMicros }: Purchase, leg: PricedLeg) => moneyIn(side, cost, leg) ?? (costUsdMicros === null ? null : moneyIn(side, { micros: costUsdMicros, currency: "USD" }, leg))

export function resolveLegs(sides: readonly Side[], method: Method, book: Book): Resolved {
  const linked = new Set(linkedWallets(book))
  const read = new Map(sides.map((side) => [normalizeAddress(side.wallet.address), side]))
  const purchased = purchasedLegs(sides, book)
  const open: OpenItem[] = []
  const gaps = new Map<string, Map<string, HistoryGap>>()
  /**
   * A cost can only carry over from a wallet whose history of that asset is confirmed as of when it left. Otherwise it could
   * be anything, however well the wallet it arrived in adds up. Only worked out for wallets that sent something, since most don't.
   */
  const gapAt = (sender: string, { asset, blockNum }: PricedLeg) => {
    const { wallet, view } = read.get(sender) as Side
    const known = gaps.get(sender) ?? historyGaps(view.legs, method, wallet)
    gaps.set(sender, known)
    const gap = known.get(asset)
    return gap && blockNum > gap.through ? gap : null
  }
  // Everything that could be an exchange withdrawal, across every wallet read, so one withdrawal can't explain two of them.
  const arrivals: ExchangeArrival[] = sides.flatMap(({ wallet, view }) =>
    view.legs.flatMap((leg) => {
      const sources = leg.kind === "transfer" && !leg.opening && isOpenCredit(leg) && !purchased.has(costKey(wallet.address, leg.id)) ? sourcesOf(leg) : null
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
    // Nothing can be answered about one whose cost depends on an order nothing says, and what it paid doesn't settle that.
    if (BigInt(leg.delta) > 0n && orderMatters(leg, method)) {
      const { estimated: _, ...rest } = leg
      return { ...rest, costLabel: "unknown", costMicros: null }
    }
    if (!isOpenCredit(leg)) return leg
    const { wallet } = side
    const address = normalizeAddress(wallet.address)
    const units = BigInt(leg.delta)
    // What the provider says was paid for exactly this, which nothing anyone entered can know better.
    const purchase = purchased.get(costKey(address, leg.id))
    const bought = purchase ? purchaseCost(side, purchase, leg) : null
    if (purchase && bought !== null) return { ...leg, costLabel: "paid", costMicros: bought, purchaseSource: purchaseSource(purchase.provider, purchase.cost.currency === side.view.currency ? undefined : formatPaid(purchase.cost.micros, purchase.cost.currency)) }
    const latestNote = wallet.notes.filter((n) => n.txHash === leg.txHash && n.asset === leg.asset).at(-1)
    const note = latestNote && !noteIsAmbiguous(leg, side.view.legs) ? latestNote : undefined
    const sources = leg.kind === "transfer" && !leg.opening ? sourcesOf(leg) : null
    const reportedMoney: Money | undefined = book.costs[costKey(address, leg.id)] ?? (note ? { micros: note.usdMicros, currency: "USD" } : undefined) ?? withdrawals.get(costKey(address, leg.id))?.cost
    const report = reportedMoney ? moneyIn(side, reportedMoney, leg) : null

    const pending: OpenItem[] = []
    const unvouched: { sender: string; settled: boolean }[] = []
    const outsideDemo: string[] = []
    const pieces = (sources ?? []).flatMap(({ address: sender, units: part }): CostPiece[] => {
      const unknown: CostPiece = { qty: part.toString(), costMicros: null, label: "unknown", estimatedCostMicros: "0" }
      const answer = book.senders[sender]
      if (sender === address || walletsBehind(book, wallet).includes(sender)) {
        if (!read.has(sender)) {
          unvouched.push({ sender, settled: false })
          return [unknown]
        }
        const gap = sender === address ? null : gapAt(sender, leg)
        if (gap) {
          unvouched.push({ sender, settled: gap.mismatch })
          return [{ ...unknown, unconfirmedBy: [sender] }]
        }
        return pull(leg, sender, address, part)
      }
      if (answer?.kind === "my-exchange") {
        const share = exchangeShare(answer.costs ?? [], address, leg.id, part)
        const cost = share ? moneyIn(side, share, leg) : null
        if (cost !== null) return [{ qty: part.toString(), costMicros: cost, label: "self-reported", estimatedCostMicros: "0" }]
        pending.push({ wallet: address, leg, sender, units: part })
        return [unknown]
      }
      // A bridge or a mint could be the user's own money arriving from elsewhere. Only an answer says it came from someone else.
      // Their wallet sent it to a wallet they've said isn't theirs, so that wallet got it from someone else.
      const given = answer?.kind === "someone-else" || (answer?.kind === "mine" && book.senders[address]?.kind === "someone-else")
      const someoneElse = given || knownSender(sender)?.kind === "bridge" || sender === MINT_ADDRESS
      if (someoneElse) {
        if (leg.priceMicros === null) return [unknown]
        const cost = worth(part, BigInt(leg.priceMicros), leg.decimals).toString()
        return [{ qty: part.toString(), costMicros: cost, label: "received at market", estimatedCostMicros: cost, ...(given ? { givenCostMicros: cost } : {}) }]
      }
      // Answered already, and answering again wouldn't change anything, because the demo never reads this wallet.
      if (answer?.kind === "mine" && isDemoWallet(address)) outsideDemo.push(sender)
      else pending.push({ wallet: address, leg, sender, units: part })
      return [unknown]
    })

    // What's inherited wins, unless part of it can't be, or can't be yet, since an entered cost is for all of what arrived.
    if ((unvouched.length > 0 || !pieces.some((p) => p.label === "inherited" && p.costMicros !== null)) && report !== null) {
      // When what was already held got paid for isn't known, so there's no rate for that day, only the one when the history starts.
      const approximate = leg.opening && reportedMoney && reportedMoney.currency !== side.view.currency
      return approximate ? { ...reported(leg, report), estimated: true, enteredAs: reportedMoney } : reported(leg, report)
    }
    if (sources === null) {
      // What it cost is known, in USD, and only the rate is missing. Nobody can answer that, and it may yet be read.
      if (leg.conversion?.rateMicros !== null || leg.conversion.costUsdMicros === null) open.push({ wallet: address, leg, sender: null, units })
      return leg
    }
    open.push(...pending)
    // Only once it's settled, or a card could appear for an unread balance and vanish when it's read.
    const settled = unvouched.filter((w) => w.settled)
    if (settled.length > 0) open.push({ wallet: address, leg, sender: null, units, evidence: settled.map((w) => `${shortHash(w.sender)}, your wallet, sent ${sources.length === 1 ? "" : "some of "}this, and its ${leg.asset} history can't be confirmed`) })
    if (outsideDemo.length > 0) open.push({ wallet: address, leg, sender: null, units, evidence: outsideDemo.map((sender) => `You've said ${shortHash(sender)} is your wallet, but the demo only reads its own wallets, so what it paid can't carry over`) })
    return withPieces(leg, pieces)
  }

  for (const { side, leg, index } of steps) {
    const address = normalizeAddress(side.wallet.address)
    const next = resolve(side, leg)
    ;(output.get(address) as PricedLeg[])[index] = next
    const key = `${address}:${next.asset}`
    const { state, taken } = applyLegTaking(states.get(key) ?? emptyPosition(method, next.decimals, sides.length > 1), next)
    states.set(key, state)
    const recipients = next.kind === "transfer" && taken.length > 0 ? recipientsOf(next) : null
    for (const [recipient, pieces] of allocateTaken(taken, recipients ?? [], method)) carried.set(`${next.txHash}:${address}:${next.asset}:${recipient}`, pieces)
  }
  const legsOf = (wallet: string) => output.get(wallet) ?? []
  const purchases = (book.purchases ?? []).filter(({ wallet }) => read.has(wallet)).map((purchase): PurchaseState => {
    const legs = legsOf(purchase.wallet).filter((leg) => cameFrom(purchase, leg))
    const recorded = [...purchased].some(([key, match]) => match === purchase && legs.some((leg) => costKey(purchase.wallet, leg.id) === key && leg.purchaseSource))
    return { order: purchase.order, state: recorded ? "recorded" : legs.length === 0 ? "waiting" : "unmatched" }
  })
  return { legs: output, open, purchases }
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
  /** The transaction a note could answer this about. A note says what all of one token cost in one transaction, so this is null unless that's what's being asked. */
  noteAbout: string | null
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

/** Why this is being asked about at all, when no transaction shows it arriving. A balance can't say who sent it, so an address is only the likeliest. */
const unseenEvidence = (sender: string | null) => `This wallet's ETH rose in this block with no transaction showing it${sender ? ". This is the contract most likely behind it." : ""}`

function evidenceFor(sender: string, sides: readonly Side[], known: KnownSender | null, book: Book): string[] {
  const evidence = [...(known ? [`From a ${known.name} address`] : []), ...(book.senders[sender]?.kind === "mine" ? ["You've said this is your wallet. Choose My wallet if the one you're looking at is yours too, or Someone else if it isn't."] : [])]
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
  const questions = new Map<string, Omit<Question, "noteAbout"> & { arrived: Map<string, Arrival>; value: bigint; priced: boolean; first: { leg: PricedLeg; units: bigint } }>()
  for (const { wallet, leg, sender, units, evidence } of open) {
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
      evidence: [...(sender ? evidenceFor(sender, sides, known, book) : (evidence ?? [])), ...(leg.parts.some((p) => p.kind === "unseen_eth") ? [unseenEvidence(sender)] : [])],
      valueMicros: null,
      first: { leg, units },
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
    .map(({ arrived, value, priced, first, ...question }) => ({
      ...question,
      arrivals: [...arrived.values()],
      valueMicros: priced ? value.toString() : null,
      noteAbout: question.receipts.length === 1 && !first.leg.opening && first.units === BigInt(first.leg.delta) && first.leg.txHash && !noteIsAmbiguous(first.leg, (sideOf.get(question.wallet) as Side).view.legs) ? first.leg.txHash : null,
    }))
    .sort((a, b) => {
      const [x, y] = [BigInt(a.valueMicros ?? "0"), BigInt(b.valueMicros ?? "0")]
      return x === y ? a.id.localeCompare(b.id) : x > y ? -1 : 1
    })
}

export function meterOf(questions: readonly Question[], book: Book, focus: WalletResponse, waiting: number): Meter {
  const open = new Set(questions.map((q) => q.sender).filter((s) => s !== null))
  // Saying a wallet's yours has no bearing on one that isn't, so it can't make this one's books balance. This one being yours is what follows from an answer, not an answer.
  const counts = (address: string, answer: SenderAnswer) => answer.kind !== "mine" || (isOwnWallet(book, focus) && address !== normalizeAddress(focus.address))
  const senders = Object.entries(book.senders).filter(([address, answer]) => !open.has(address) && counts(address, answer)).length
  return { open: questions.length, answered: senders + Object.keys(book.costs).length, waiting }
}

export type BookFold = {
  view: WalletView
  legs: PricedLeg[]
  positions: Position[]
  unread: string[]
  totals: Totals
  pnlStatus: PnlStatus
  points: BookPoint[]
  holdComparison: HoldComparison
  questions: Question[]
  meter: Meter
  /** Other wallets' history that can't be confirmed, and that's why some of what arrived in this wallet has an unknown cost. */
  withheld: Withheld[]
  purchases: PurchaseState[]
}

/**
 * Everything a wallet's numbers come from: the chain, plus what the user has said. Both the browser and the server run this.
 * It runs after conversion, because a cost carried between wallets has to stay in the currency gains are reported in.
 */
export function foldBook(focus: WalletResponse, others: readonly WalletResponse[], method: Method, book: Book, { usd = false } = {}): BookFold {
  const address = normalizeAddress(focus.address)
  const linked = new Set(walletsBehind(book, focus))
  const sideOf = (wallet: WalletResponse): Side => ({ wallet, view: usd ? usdView(wallet) : viewWallet(wallet) })
  const sides = [focus, ...others.filter((w) => normalizeAddress(w.address) !== address && linked.has(normalizeAddress(w.address)) && sameRead(w, focus))].map(sideOf)
  const view = (sides[0] as Side).view
  const { legs: resolved, open, purchases } = resolveLegs(sides, method, book)
  const legs = resolved.get(address) as PricedLeg[]
  // What came from a linked wallet was first paid for in its blocks, which only its oracle reads have.
  const markPrice: MarkPrice = (blockNum, asset) => sides.map((side) => side.view.markPrice(blockNum, asset)).find((price) => price !== null) ?? null
  const { positions, unreadAssets: unread, totals, pnlStatus, points, holdComparison } = foldWallet(focus, method, { ...view, legs, markPrice })
  const questions = questionsOf(open, sides, book)
  const legsByTx = legsByTransaction(legs)
  const facts = transactionFacts(legsByTx, positions, method, address, unconfirmedAssets(positions, unread))
  return {
    view,
    legs,
    positions,
    unread,
    totals,
    pnlStatus,
    points: points.map((point) => ({ ...point, summary: point.txHash ? describeTransaction(legsByTx.get(point.txHash) ?? [], view.currency) : null, ...((point.txHash && facts.get(point.txHash)) || NO_FACTS) })),
    holdComparison,
    questions,
    meter: meterOf(questions, book, focus, missingWallets(book, focus, others).length),
    withheld: withheldIn(legs).filter(({ wallet }) => wallet !== address),
    purchases,
  }
}

/** How a wallet was read. Its money only adds up with another wallet's when this is the same. */
type HowRead = Pick<WalletResponse, "rule" | "currency">

/**
 * A cost by one pricing rule against a value by another is a gain nobody made, and so is one currency's against another's.
 * So a wallet read another way counts as not read at all, which leaves what came from it unresolved.
 */
const sameRead = (a: HowRead, b: HowRead) => (a.rule ?? null) === (b.rule ?? null) && a.currency === b.currency

/** Where a client keeps a read, so one set of wallets stays whole while the next set is on its way. */
export const readKey = (address: string, read: HowRead) => `${normalizeAddress(address)}:${read.rule ?? ""}:${read.currency}`

/** The reads that go with what's on screen. Never a newer rule's, however soon it arrives: those wait until the numbers on screen change too. */
export const readsMatching = (reads: Readonly<Record<string, WalletResponse>>, addresses: readonly string[], shown: HowRead | null): WalletResponse[] =>
  shown ? addresses.flatMap((address) => reads[readKey(address, shown)] ?? []) : []

/** The linked wallets a book needs that aren't in `read`, or were read another way. */
export const missingWallets = (book: Book, focus: WalletResponse, read: readonly WalletResponse[]) => {
  const have = new Set([normalizeAddress(focus.address), ...read.filter((w) => sameRead(w, focus)).map((w) => normalizeAddress(w.address))])
  return walletsBehind(book, focus).filter((address) => !have.has(address))
}

/** What a different set of answers would make the headline say, before any of them is final. */
export function previewBook(focus: WalletResponse, others: readonly WalletResponse[], method: Method, book: Book, failed: readonly string[] = []): BookPreview {
  const { totals, pnlStatus: status, questions } = foldBook(focus, others, method, book)
  return { pnlMicros: totals.pnlMicros, pnlStatus: status, estimatedMicros: totals.estimatedMicros, unresolvedMicros: totals.unresolvedMicros, open: questions.length, pending: missingWallets(book, focus, others).length > 0, failed: walletsBehind(book, focus).some((address) => failed.includes(address)) }
}
