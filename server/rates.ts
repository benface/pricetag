// Which exchange rates a wallet's stored costs need. Reading them is `createRates`, in the SDK.

import type { WalletResponse } from "../src/core/api.ts"
import { costKey, type Book } from "../src/core/book.ts"
import { fits } from "../src/core/exchange-import.ts"
import { normalizeAddress, type CurrencyCode, type PaidRates } from "@pricetag/sdk/core"
import type { ReadRates } from "@pricetag/sdk/internal"

/**
 * The rates to read what's stored in another currency in `shown`: purchases, entered costs, exchange answers and imported
 * withdrawals. Only at the blocks they could have arrived in, because that's all that's needed. `paidIn` is for a client that
 * folds its own answers and doesn't send them, and reads those currencies at everything that arrived. A cost for what the wallet
 * already held also needs `shown` at the block its history starts from, since the wallet's own rates leave that block out.
 * Undefined when none need one, so a wallet with nothing stored reads nothing more.
 */
export async function readPaidRates(readRates: ReadRates, wallet: Pick<WalletResponse, "address" | "legs" | "latest">, shown: CurrencyCode, books: readonly Book[], paidIn: readonly CurrencyCode[] = []): Promise<PaidRates | undefined> {
  const address = normalizeAddress(wallet.address)
  const arrivals = wallet.legs.filter((leg) => !leg.opening && BigInt(leg.delta) > 0n)
  const wanted = new Map<CurrencyCode, Set<WalletResponse["legs"][number]>>()
  const add = (currency: CurrencyCode, legs: WalletResponse["legs"]) => {
    if (currency === "USD" || legs.length === 0) return
    wanted.set(currency, new Set([...(wanted.get(currency) ?? []), ...legs]))
  }
  const want = (currency: CurrencyCode, legs: WalletResponse["legs"]) => {
    if (currency !== shown) add(currency, legs)
  }
  // Both, even when they're the same: what's in `shown` can still be folded in USD, as the apps do alongside it.
  const wantHeld = (currency: CurrencyCode, legs: WalletResponse["legs"]) => {
    add(currency, legs)
    add(shown, legs)
  }
  const held = wallet.legs.filter((leg) => leg.opening)
  for (const currency of paidIn) {
    want(currency, arrivals)
    wantHeld(currency, held)
  }
  for (const book of books) {
    for (const { wallet: to, cost, txHash, blockNum } of book.purchases ?? []) {
      if (to === address) want(cost.currency, wallet.legs.filter((leg) => leg.txHash.toLowerCase() === txHash || leg.blockNum === blockNum))
    }
    for (const leg of arrivals) {
      const cost = book.costs[costKey(address, leg.id)]
      if (cost) want(cost.currency, [leg])
    }
    for (const leg of held) {
      const cost = book.costs[costKey(address, leg.id)]
      if (cost) wantHeld(cost.currency, [leg])
    }
    for (const answer of Object.values(book.senders)) {
      if (answer.kind !== "my-exchange") continue
      for (const { currency, receipts } of answer.costs ?? []) want(currency, arrivals.filter((leg) => receipts.some((r) => r.wallet === address && r.legId === leg.id)))
    }
    for (const withdrawal of book.withdrawals) {
      want(withdrawal.cost.currency, arrivals.filter((leg) => fits(withdrawal, { wallet: address, asset: leg.asset, units: BigInt(leg.delta), timestamp: leg.timestamp })))
    }
  }
  const paidRates: PaidRates = {}
  for (const [currency, legs] of wanted) {
    const rates = await readRates(currency, { legs: [...legs], latest: wallet.latest }, { held: true })
    if (rates) paidRates[currency] = rates.byBlock
  }
  return Object.keys(paidRates).length > 0 ? paidRates : undefined
}
