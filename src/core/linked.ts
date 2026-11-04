// Cost carried between a user's own wallets. A transfer between them isn't a purchase: the receiver takes on what the
// sender paid, labeled `inherited`. Whatever was unknown on the way out stays unknown on the way in.

import { applyLeg, emptyPosition, type Method, type PositionState } from "./fold.ts"
import type { PricedLeg } from "./legs.ts"

type Carried = { wallet: string; qty: bigint; knownQty: bigint; knownCost: bigint }

function knownQty(state: PositionState): bigint {
  return state.lots.reduce((sum, lot) => (lot.costUsdMicros === null ? sum : sum + BigInt(lot.qty)), 0n)
}

function byTime(a: PricedLeg, b: PricedLeg): number {
  // Across wallets, what left in a transaction has to be folded before what arrived in it.
  return a.blockNum - b.blockNum || a.txIndex - b.txIndex || Number(BigInt(a.delta) > 0n) - Number(BigInt(b.delta) > 0n)
}

/**
 * Folds every wallet together in chain order, so a chain of wallets (a retired hot wallet, the new one, then savings) carries
 * cost all the way along. A credit only inherits from a debit of the same asset and the same size in the same transaction,
 * which is how a plain transfer looks: anything else, like a transaction paying several people, stays as it was.
 */
export function inheritCosts(wallets: ReadonlyMap<string, readonly PricedLeg[]>, method: Method): Map<string, PricedLeg[]> {
  const events = [...wallets].flatMap(([wallet, legs]) => legs.map((leg, index) => ({ wallet, leg, index })))
  events.sort((a, b) => byTime(a.leg, b.leg))

  const states = new Map<string, PositionState>()
  const carried = new Map<string, Carried[]>()
  const replaced = new Map<string, Map<number, PricedLeg[]>>()

  const apply = (wallet: string, leg: PricedLeg) => {
    const key = `${wallet}:${leg.asset}`
    const before = states.get(key) ?? emptyPosition(method, leg.decimals)
    const after = applyLeg(before, leg)
    states.set(key, after)
    return { before, after }
  }

  for (const { wallet, leg, index } of events) {
    const delta = BigInt(leg.delta)
    const key = `${leg.txHash}:${leg.asset}`

    if (delta > 0n && leg.kind === "transfer" && leg.costLabel === "unknown") {
      const candidates = carried.get(key) ?? []
      const source = candidates.find((c) => c.wallet !== wallet && c.qty === delta)
      if (source) {
        candidates.splice(candidates.indexOf(source), 1)
        const legs = splitCredit(leg, source)
        for (const part of legs) apply(wallet, part)
        const forWallet = replaced.get(wallet) ?? new Map<number, PricedLeg[]>()
        forWallet.set(index, legs)
        replaced.set(wallet, forWallet)
        continue
      }
    }

    const { before, after } = apply(wallet, leg)
    if (delta < 0n && leg.kind === "transfer") {
      const entry: Carried = {
        wallet,
        qty: -delta,
        knownQty: knownQty(before) - knownQty(after),
        knownCost: BigInt(after.transferredOutCostUsdMicros) - BigInt(before.transferredOutCostUsdMicros),
      }
      carried.set(key, [...(carried.get(key) ?? []), entry])
    }
  }

  return new Map(
    [...wallets].map(([wallet, legs]) => {
      const forWallet = replaced.get(wallet)
      return [wallet, legs.flatMap((leg, index) => forWallet?.get(index) ?? [leg])]
    }),
  )
}

/** The known part inherits its cost. A part that was unknown at the sender stays unknown, and is never counted as $0. */
function splitCredit(leg: PricedLeg, source: Carried): PricedLeg[] {
  const unknownQty = source.qty - source.knownQty
  if (source.knownQty === 0n) return [leg]
  const inherited: PricedLeg = {
    ...leg,
    id: unknownQty > 0n ? `${leg.id}:inherited` : leg.id,
    delta: source.knownQty.toString(),
    costLabel: "inherited",
    costUsdMicros: source.knownCost.toString(),
  }
  if (unknownQty === 0n) return [inherited]
  return [inherited, { ...leg, id: `${leg.id}:unknown`, delta: unknownQty.toString() }]
}
