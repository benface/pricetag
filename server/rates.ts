// Reads exchange rates at the blocks a wallet's numbers need. A settled block's rate never changes, so it's read once.
// USD stays the data's base, so this adds nothing to what's read for a wallet shown in USD.

import type { WalletResponse } from "../src/core/api.ts"
import { costKey, type Book } from "../src/core/book.ts"
import { fits } from "../src/core/exchange-import.ts"
import { CURRENCIES, normalizeAddress, type CurrencyCode, type PaidRates, type Rates, type RateRound } from "@pricetag/sdk/core"
import { settledThrough } from "@pricetag/sdk/internal"
import type { RoundReader } from "./source.ts"

/** `held` also reads the block a wallet's history starts from, which only a cost stored for what it already held needs. */
type ReadRates = (currency: CurrencyCode, wallet: Pick<WalletResponse, "legs" | "latest">, options?: { held?: boolean }) => Promise<Rates | null>

/** Reads rates, and forgets the ones from blocks a reorg replaced, when it can. */
export type RatesReader = ReadRates & { rewind?(block: number): void }

export function createRates(readRounds: RoundReader): RatesReader {
  const settled = new Map<CurrencyCode, Map<number, RateRound>>()
  const newest = new Map<CurrencyCode, NonNullable<Rates["latest"]>>()
  /** How many reorgs have been told about. A read that crossed one can't say which chain it got, so it isn't kept. */
  let rewinds = 0

  /** A read that fails throws. A block the feed had no answer for is just left out, and isn't remembered, so it's tried again. */
  const ratesFor: ReadRates = async (currency, wallet, { held = false } = {}) => {
    if (!CURRENCIES[currency].feed) return null
    const known = settled.get(currency) ?? new Map<number, RateRound>()
    settled.set(currency, known)
    const head = wallet.latest.blockNum
    const blocks = [...new Set(wallet.legs.filter((leg) => held || !leg.opening).map((leg) => leg.blockNum))]
    const current = newest.get(currency)
    const wanted = blocks.filter((block) => !known.has(block))
    if (current?.blockNum !== head) wanted.push(head)
    const startedAt = rewinds
    const read = wanted.length > 0 ? await readRounds(currency, wanted) : new Map<number, RateRound>()
    const isSameChain = startedAt === rewinds
    if (isSameChain) for (const [block, round] of read) if (block <= settledThrough(head)) known.set(block, round)

    const byBlock: Rates["byBlock"] = {}
    for (const block of blocks) {
      const round = read.get(block) ?? known.get(block)
      if (round) byBlock[block] = round
    }
    const headRound = read.get(head)
    const latest = headRound ? { blockNum: head, round: headRound } : current?.blockNum === head ? current : null
    if (latest && isSameChain) newest.set(currency, latest)
    return { byBlock, latest }
  }

  return Object.assign(ratesFor, {
    rewind(block: number) {
      rewinds += 1
      for (const known of settled.values()) for (const at of known.keys()) if (at >= block) known.delete(at)
      for (const [currency, latest] of newest) if (latest.blockNum >= block) newest.delete(currency)
    },
  })
}

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
