// Reads exchange rates at the blocks a wallet's numbers need. A settled block's rate never changes, so it's read once.
// USD stays the data's base, so this adds nothing to what's read for a wallet shown in USD.

import { asNumber, isNotStarted, type Query } from "./amp.ts"
import { blockBefore } from "./chain.ts"
import { CURRENCIES, MAX_ROUND_AGE_SECONDS, type CurrencyCode, type Rates, type RateRound } from "./currency.ts"
import { blockFilters, decodeRound, type Row } from "./dataset.ts"
import type { WalletData } from "./wallet-data.ts"
import { settledThrough } from "./wallets.ts"

/** A currency's answer at each block, leaving out blocks where the read failed. */
export type RoundReader = (currency: CurrencyCode, blocks: readonly number[]) => Promise<Map<number, RateRound>>

/**
 * Exchange rates read from each feed's contract, the way `rawSource` reads the oracle, for an Amp with no rates dataset. It leans on
 * an RPC, and it's what a local Amp has to do, because it has no logs from before its start. See the note on the query's shape in `readReferences`, in `server/source.ts`.
 */
export function feedRounds(query: Query, config: { baseDataset: string; network: string }): RoundReader {
  return async (currency, blocks) => {
    const rounds = new Map<number, RateRound>()
    const address = CURRENCIES[currency].feed?.address
    if (!address) return rounds
    for (const { filter, count } of blockFilters(blocks)) {
      const rows = await query<Row>(
        `SELECT block_num, rpc.${config.network}.eth_call(NULL, evm_encode_hex('${address}'), evm_encode_params('latestRoundData()'), block_num) AS round
         FROM (SELECT block_num FROM "${config.baseDataset}".blocks WHERE ${filter} LIMIT ${count})`,
      )
      for (const row of rows) {
        const round = decodeRound((row.round as { data?: string } | null)?.data)
        if (round) rounds.set(asNumber(row.block_num), round)
      }
    }
    return rounds
  }
}

/**
 * Exchange rates from Chainlink's `AnswerUpdated` logs, in the rates dataset. A rate at a block is the feed's latest update at or
 * before it, which is what the contract answers there, so it needs no RPC.
 *
 * The table only has a row when a feed updates, so its newest row, from any feed, is the only sign of how far it's reached. It
 * writes in block order, so before that row it's complete. From that row on, an update could still be on its way, and an old
 * answer would quietly be wrong, so those blocks go to `exact`, which reads the contract. That's usually the head and a few
 * recent blocks. If the table stops, everything after it does, which is slower but still right.
 */
export function updateRounds(query: Query, dataset: string, exact: RoundReader): RoundReader {
  return async (currency, blocks) => {
    const rounds = new Map<number, RateRound>()
    const wanted = [...blocks].sort((a, b) => a - b)
    const first = wanted[0]
    if (first === undefined) return rounds
    const sql = `SELECT block_num, currency, answer, updated_at FROM "${dataset}".rate_updates WHERE block_num >= ${blockBefore(first, MAX_ROUND_AGE_SECONDS * 1000)} ORDER BY block_num, log_index`
    const rows = await query<Row>(sql).catch((error: unknown) => {
      if (isNotStarted(error)) return [] as Row[]
      throw error
    })
    const covered = asNumber(rows.at(-1)?.block_num ?? 0)
    let at = 0
    let latest: Row | null = null
    for (const block of wanted.filter((block) => block < covered)) {
      while (at < rows.length && asNumber((rows[at] as Row).block_num) <= block) {
        const row = rows[at++] as Row
        if (row.currency === currency) latest = row
      }
      if (latest) rounds.set(block, { answer: String(latest.answer), updatedAt: Number(latest.updated_at) })
    }
    const past = wanted.filter((block) => block >= covered)
    if (past.length > 0) for (const [block, round] of await exact(currency, past)) rounds.set(block, round)
    return rounds
  }
}

/**
 * `held` also reads the block a wallet's history starts from, which only a cost stored for what it already held needs.
 * `chainHead` is the chain's head, for a wallet read as of an earlier block, whose `latest` can't say what's settled. It defaults to `latest`.
 */
export type ReadRates = (currency: CurrencyCode, wallet: Pick<WalletData, "legs" | "latest" | "priceSamples">, options?: { held?: boolean; chainHead?: number | undefined }) => Promise<Rates | null>

/** Reads rates, and forgets the ones from blocks a reorg replaced, when it can. */
export type RatesReader = ReadRates & { rewind?(block: number): void }

export function createRates(readRounds: RoundReader): RatesReader {
  const settled = new Map<CurrencyCode, Map<number, RateRound>>()
  /** With the chain's head when it was read. Anything not yet settled could have changed once that moves. */
  const newest = new Map<CurrencyCode, NonNullable<Rates["latest"]> & { readAt: number }>()
  /** How many reorgs have been told about. A read that crossed one can't say which chain it got, so it isn't kept. */
  let rewinds = 0

  /** A read that fails throws. A block the feed had no answer for is just left out, and isn't remembered, so it's tried again. */
  const ratesFor: ReadRates = async (currency, wallet, { held = false, chainHead } = {}) => {
    if (!CURRENCIES[currency].feed) return null
    const known = settled.get(currency) ?? new Map<number, RateRound>()
    settled.set(currency, known)
    const asOf = wallet.latest.blockNum
    const chain = chainHead ?? asOf
    const blocks = [...new Set([...wallet.legs.filter((leg) => held || !leg.opening).map((leg) => leg.blockNum), ...(wallet.priceSamples ?? []).map((sample) => sample.blockNum)])]
    const current = newest.get(currency)
    const wanted = new Set(blocks.filter((block) => !known.has(block)))
    if (!known.has(asOf) && (current?.blockNum !== asOf || current.readAt !== chain)) wanted.add(asOf)
    const startedAt = rewinds
    const read = wanted.size > 0 ? await readRounds(currency, [...wanted]) : new Map<number, RateRound>()
    const isSameChain = startedAt === rewinds
    if (isSameChain) for (const [block, round] of read) if (block <= settledThrough(chain)) known.set(block, round)

    const byBlock: Rates["byBlock"] = {}
    for (const block of blocks) {
      const round = read.get(block) ?? known.get(block)
      if (round) byBlock[block] = round
    }
    // A read that found no answer means there's none now. An older one could be from a block a reorg replaced.
    const round = wanted.has(asOf) ? read.get(asOf) : (known.get(asOf) ?? current?.round)
    if (isSameChain) {
      if (round) newest.set(currency, { blockNum: asOf, round, readAt: chain })
      else newest.delete(currency)
    }
    return { byBlock, latest: round ? { blockNum: asOf, round } : null }
  }

  return Object.assign(ratesFor, {
    rewind(block: number) {
      rewinds += 1
      for (const known of settled.values()) for (const at of known.keys()) if (at >= block) known.delete(at)
      for (const [currency, latest] of newest) if (latest.blockNum >= block) newest.delete(currency)
    },
  })
}
