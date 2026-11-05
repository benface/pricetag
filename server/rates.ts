// Reads exchange rates at the blocks a wallet's numbers need. A settled block's rate never changes, so it's read once.
// USD stays the data's base, so this adds nothing to what's read for a wallet shown in USD.

import type { WalletResponse } from "../src/core/api.ts"
import type { Book } from "../src/core/book.ts"
import { CURRENCIES, normalizeAddress, type CurrencyCode, type PaidRates, type Rates, type RateRound } from "@pricetag/sdk/core"
import { settledThrough } from "@pricetag/sdk/internal"
import type { ReadRound, RoundReader } from "./source.ts"

type ReadRates = (currency: CurrencyCode, wallet: Pick<WalletResponse, "legs" | "latest">) => Promise<Rates | null>

/** Reads rates, and forgets the ones from blocks a reorg replaced, when it can. */
export type RatesReader = ReadRates & { rewind?(block: number): void }

export function createRates(readRounds: RoundReader): RatesReader {
  const settled = new Map<CurrencyCode, Map<number, RateRound>>()
  const newest = new Map<CurrencyCode, NonNullable<Rates["latest"]>>()
  /** How many reorgs have been told about. A read that crossed one can't say which chain it got, so it isn't kept. */
  let rewinds = 0

  /** A read that fails throws. A block the feed had no answer for is just left out, and isn't remembered, so it's tried again. */
  const ratesFor: ReadRates = async (currency, wallet) => {
    if (!CURRENCIES[currency].feed) return null
    const known = settled.get(currency) ?? new Map<number, RateRound>()
    settled.set(currency, known)
    const head = wallet.latest.blockNum
    const blocks = [...new Set(wallet.legs.filter((leg) => !leg.opening).map((leg) => leg.blockNum))]
    const current = newest.get(currency)
    const wanted = blocks.filter((block) => !known.has(block))
    if (current?.blockNum !== head) wanted.push(head)
    const startedAt = rewinds
    const read = wanted.length > 0 ? await readRounds(currency, wanted) : new Map<number, ReadRound>()
    const isSameChain = startedAt === rewinds
    if (isSameChain) for (const [block, round] of read) if (block <= settledThrough(head) && !round.unconfirmed) known.set(block, round)

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
 * The rates to read a wallet's purchases in `shown` when they were paid in something else. Only at the blocks they could have
 * arrived in, because that's all that's needed. Undefined when none need one, so a wallet with no such purchase reads nothing more.
 */
export async function readPaidRates(readRates: ReadRates, wallet: Pick<WalletResponse, "address" | "legs" | "latest">, shown: CurrencyCode, books: readonly Book[]): Promise<PaidRates | undefined> {
  const address = normalizeAddress(wallet.address)
  const purchases = books.flatMap((book) => book.purchases ?? []).filter(({ wallet, cost }) => wallet === address && cost.currency !== shown && cost.currency !== "USD")
  const paidRates: PaidRates = {}
  for (const currency of new Set(purchases.map(({ cost }) => cost.currency))) {
    const mine = purchases.filter(({ cost }) => cost.currency === currency)
    const legs = wallet.legs.filter((leg) => mine.some(({ txHash, blockNum }) => leg.txHash.toLowerCase() === txHash || leg.blockNum === blockNum))
    if (legs.length === 0) continue
    const rates = await readRates(currency, { legs, latest: wallet.latest })
    if (rates) paidRates[currency] = rates.byBlock
  }
  return Object.keys(paidRates).length > 0 ? paidRates : undefined
}
