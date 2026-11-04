// Reads exchange rates at the blocks a wallet's numbers need. A settled block's rate never changes, so it's read once.
// USD stays the data's base, so this adds nothing to what's read for a wallet shown in USD.

import type { WalletResponse } from "../src/core/api.ts"
import { CURRENCIES, type CurrencyCode, type Rates, type RateRound } from "../src/core/currency.ts"
import type { RoundReader } from "./source.ts"
import { REORG_BLOCKS } from "./wallets.ts"

export function createRates(readRounds: RoundReader) {
  const settled = new Map<CurrencyCode, Map<number, RateRound>>()
  const newest = new Map<CurrencyCode, NonNullable<Rates["latest"]>>()

  /** A read that fails throws. A block the feed had no answer for is just left out, and isn't remembered, so it's tried again. */
  return async function ratesFor(currency: CurrencyCode, wallet: Pick<WalletResponse, "legs" | "latest">): Promise<Rates | null> {
    const feed = CURRENCIES[currency].feed
    if (!feed) return null
    const known = settled.get(currency) ?? new Map<number, RateRound>()
    settled.set(currency, known)
    const head = wallet.latest.blockNum
    const blocks = [...new Set(wallet.legs.filter((leg) => !leg.opening).map((leg) => leg.blockNum))]
    const current = newest.get(currency)
    const wanted = blocks.filter((block) => !known.has(block))
    if (current?.blockNum !== head) wanted.push(head)
    const read = wanted.length > 0 ? await readRounds(feed.address, wanted) : new Map<number, RateRound>()
    for (const [block, round] of read) if (block <= head - REORG_BLOCKS) known.set(block, round)

    const byBlock: Rates["byBlock"] = {}
    for (const block of blocks) {
      const round = read.get(block) ?? known.get(block)
      if (round) byBlock[block] = round
    }
    const headRound = read.get(head)
    const latest = headRound ? { blockNum: head, round: headRound } : current?.blockNum === head ? current : null
    if (latest) newest.set(currency, latest)
    return { byBlock, latest }
  }
}
