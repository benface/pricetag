// Cost carried between a user's own wallets. A transfer between them isn't a purchase: the receiver takes on what the
// sender paid, labeled `inherited`. Whatever was unknown on the way out stays unknown on the way in.

import { applyLeg, emptyPosition, lotsTaken, type LegPart, type Method, type PositionState, type PricedLeg, type TakenLot } from "@pricetag/sdk/core"

type Debit = { wallet: string; leg: PricedLeg; lots: TakenLot[] }
type Credit = { wallet: string; leg: PricedLeg; index: number }
type Event = Credit

const isCredit = (leg: PricedLeg) => BigInt(leg.delta) > 0n
const qtyOf = (leg: PricedLeg) => (isCredit(leg) ? BigInt(leg.delta) : -BigInt(leg.delta))

function byTime(a: Event, b: Event): number {
  const [x, y] = [a.leg, b.leg]
  return x.blockNum - y.blockNum || x.txIndex - y.txIndex || (x.txHash < y.txHash ? -1 : x.txHash > y.txHash ? 1 : 0)
}

const sameLog = (a: LegPart, b: LegPart) => a.token === b.token && a.logIndex === b.logIndex && a.amount === b.amount

/**
 * Whether this debit and credit can be the same transfer. Each log names both sides, so when there are rows to compare,
 * every row behind the credit has to be a row behind the debit.
 */
function canBeSameTransfer(debit: Debit, credit: Credit): boolean {
  if (debit.wallet === credit.wallet || debit.leg.asset !== credit.leg.asset || qtyOf(debit.leg) !== qtyOf(credit.leg)) return false
  const [sent, received] = [debit.leg.parts, credit.leg.parts]
  return sent.length === 0 || received.length === 0 || received.every((row) => sent.some((other) => sameLog(row, other)))
}

/** The known parts inherit their cost, lot by lot and in order, so a later sale by FIFO takes the same lots it would have at the sender. */
function splitCredit(leg: PricedLeg, lots: readonly TakenLot[]): PricedLeg[] {
  if (lots.every((lot) => lot.costMicros === null)) return [leg]
  return lots.map((lot, i) => ({
    ...leg,
    id: lots.length === 1 ? leg.id : `${leg.id}:${i}`,
    delta: lot.qty.toString(),
    costLabel: lot.costMicros === null ? ("unknown" as const) : ("inherited" as const),
    costMicros: lot.costMicros?.toString() ?? null,
  }))
}

/**
 * Folds every wallet together in chain order, so a chain of wallets (a retired hot wallet, the new one, then savings) carries
 * cost all the way along. A credit only inherits from a debit it can only be matched to, and that can only be matched to it.
 * Anything else, like a transaction paying several people or two wallets sending the same amount, stays as it was: the answer
 * can't depend on which wallet happened to be read first.
 */
export function inheritCosts(wallets: ReadonlyMap<string, readonly PricedLeg[]>, method: Method): Map<string, PricedLeg[]> {
  const events = [...wallets].flatMap(([wallet, legs]) => legs.map((leg, index): Event => ({ wallet, leg, index })))
  events.sort(byTime)

  const states = new Map<string, PositionState>()
  const replaced = new Map<string, Map<number, PricedLeg[]>>()

  const apply = (wallet: string, leg: PricedLeg) => {
    const key = `${wallet}:${leg.asset}`
    const before = states.get(key) ?? emptyPosition(method, leg.decimals)
    states.set(key, applyLeg(before, leg))
  }

  for (let start = 0; start < events.length; ) {
    let end = start
    while (end < events.length && byTime(events[start] as Event, events[end] as Event) === 0) end += 1
    const tx = events.slice(start, end)
    start = end

    // What left is folded before what arrived, and each wallet's own legs stay in their order.
    const debits: Debit[] = []
    const credits: Credit[] = []
    for (const event of tx) {
      if (event.leg.kind === "transfer" && isCredit(event.leg) && event.leg.costLabel === "unknown") {
        credits.push(event)
        continue
      }
      if (isCredit(event.leg)) continue
      const state = states.get(`${event.wallet}:${event.leg.asset}`) ?? emptyPosition(method, event.leg.decimals)
      if (event.leg.kind === "transfer" && BigInt(event.leg.delta) < 0n) debits.push({ ...event, lots: lotsTaken(state, qtyOf(event.leg)) })
      apply(event.wallet, event.leg)
    }
    for (const event of tx) if (isCredit(event.leg) && !credits.includes(event)) apply(event.wallet, event.leg)

    for (const credit of credits) {
      const matches = debits.filter((debit) => canBeSameTransfer(debit, credit))
      const debit = matches.length === 1 ? matches[0] : undefined
      const isOnlyMatch = debit && credits.filter((other) => canBeSameTransfer(debit, other)).length === 1
      const legs = debit && isOnlyMatch ? splitCredit(credit.leg, debit.lots) : [credit.leg]
      for (const leg of legs) apply(credit.wallet, leg)
      if (legs[0] !== credit.leg) {
        const forWallet = replaced.get(credit.wallet) ?? new Map<number, PricedLeg[]>()
        forWallet.set(credit.index, legs)
        replaced.set(credit.wallet, forWallet)
      }
    }
  }

  return new Map(
    [...wallets].map(([wallet, legs]) => {
      const forWallet = replaced.get(wallet)
      return [wallet, legs.flatMap((leg, index) => forWallet?.get(index) ?? [leg])]
    }),
  )
}
