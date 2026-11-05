// Reads exchange rates at the blocks a wallet's numbers need. A settled block's rate never changes, so it's read once.
// USD stays the data's base, so this adds nothing to what's read for a wallet shown in USD.

import type { WalletResponse } from "../src/core/api.ts"
import { CURRENCIES, type CurrencyCode, type Rates, type RateRound } from "@pricetag/sdk/core"
import { REORG_BLOCKS } from "@pricetag/sdk/internal"
import type { RoundReader } from "./source.ts"

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
    const feed = CURRENCIES[currency].feed
    if (!feed) return null
    const known = settled.get(currency) ?? new Map<number, RateRound>()
    settled.set(currency, known)
    const head = wallet.latest.blockNum
    const blocks = [...new Set(wallet.legs.filter((leg) => !leg.opening).map((leg) => leg.blockNum))]
    const current = newest.get(currency)
    const wanted = blocks.filter((block) => !known.has(block))
    if (current?.blockNum !== head) wanted.push(head)
    const startedAt = rewinds
    const read = wanted.length > 0 ? await readRounds(feed.address, wanted) : new Map<number, RateRound>()
    const isSameChain = startedAt === rewinds
    if (isSameChain) for (const [block, round] of read) if (block <= head - REORG_BLOCKS) known.set(block, round)

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
