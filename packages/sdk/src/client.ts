// What another app builds on: a wallet's priced legs and a token's prices, read from the Pricetag dataset.
// Everything keeps its price source and transaction, and what can't be priced stays unknown.

import { createQuery, type Query } from "./amp.ts"
import { ORACLE_TABLES, SWAP_TABLES, WALLET_TABLES, datasetReader } from "./dataset.ts"
import { answerToMicros, buildPricedLegs, type LegRow, type PricedLeg, type PriceSource, type ReferenceRow } from "./legs.ts"
import { latestPrices, type LatestPrices } from "./portfolio.ts"
import { TOKENS, isAddress, normalizeAddress, tokenByAddress, type Token } from "./tokens.ts"

export type PricetagConfig = {
  /** Amp's query URL. */
  url: string
  /** Leave it out for an Amp that doesn't check tokens, like a local one. */
  token?: string | undefined
  /** The Pricetag dataset, like `benface/pricetag@0.0.1`. */
  dataset: string
  /** The raw dataset the chain's head is read from. */
  baseDataset?: string | undefined
}

/** Blocks to read, inclusive. Without `to`, it reads up to the chain's head. */
export type BlockRange = { from: number; to?: number | undefined }

/**
 * The blocks actually read, which `toBlock` can leave short of what was asked while a table this read uses catches up.
 * `toBlock` is below `fromBlock` when nothing in the range has been processed yet. No rows then doesn't mean nothing happened.
 */
export type BlocksRead = { fromBlock: number; toBlock: number }

export type WalletLegs = {
  address: string
  blocks: BlocksRead
  /** In order for the fold. Each has its `txHash`, `priceSource` and, when it has no price, a `priceNote` saying why. */
  legs: PricedLeg[]
  /** The oracle reads at the blocks of those legs, which `pnlOverTime` takes. */
  references: ReferenceRow[]
  /** Transactions this wallet sent whose gas couldn't be worked out, so ETH is overstated by that much. */
  gasUnknownTxs: string[]
}

export type PricePoint = {
  blockNum: number
  timestamp: string
  /** USD price of one whole token, or null when it's unknown. */
  usdMicros: string | null
  source: PriceSource | "unknown"
  /** The swap this price comes from. Null for an oracle, which is read at a block, not in a transaction. */
  txHash: string | null
  /** The account whose swap this is. One transaction can have several, like a trader and a pool. */
  account: string | null
  /** Why this price is unknown. */
  note: string | null
}

export type TokenPrices = {
  /** The allowlist's symbol for the token. */
  token: string
  blocks: BlocksRead
  prices: PricePoint[]
}

function checkRange({ from, to }: BlockRange) {
  const valid = Number.isSafeInteger(from) && from > 0 && (to === undefined || (Number.isSafeInteger(to) && to >= from))
  if (!valid) throw new Error(`Bad block range: from ${from} to ${to}. It needs a first block, and the dataset's start block is the earliest with data.`)
}

function findToken(token: string): Token {
  const found = isAddress(token) ? tokenByAddress(token) : TOKENS.find((t) => t.symbol === token)
  if (!found) throw new Error(`${token} isn't on the allowlist, so it has no price. See TOKENS.`)
  return found
}

export function createPricetag(config: PricetagConfig) {
  if (!config.url) throw new Error("Pricetag needs Amp's query URL")
  return pricetagClient(createQuery(config.url, config.token || undefined), config)
}

export function pricetagClient(query: Query, config: Pick<PricetagConfig, "dataset" | "baseDataset">) {
  if (!config.dataset) throw new Error("Pricetag needs a dataset, like benface/pricetag@0.0.1")
  const reader = datasetReader(query, { dataset: config.dataset, baseDataset: config.baseDataset ?? "edgeandnode/base_mainnet@0.0.2" })

  async function blocksRead(range: BlockRange, tables: readonly string[]): Promise<BlocksRead> {
    checkRange(range)
    const nothing = { fromBlock: range.from, toBlock: range.from - 1 }
    const head = range.to ?? (await reader.head(range.from))?.blockNum
    if (head === undefined) return nothing
    const processed = await reader.processedThrough(range.from, head, tables)
    return processed === null ? nothing : { fromBlock: range.from, toBlock: processed }
  }

  return {
    /** A wallet's legs in the range, priced and labeled the same way the app's are. Feed them to `buildPortfolio`. */
    async getLegs(address: string, range: BlockRange): Promise<WalletLegs> {
      if (!isAddress(address)) throw new Error(`${address} isn't a Base address`)
      const account = normalizeAddress(address)
      const blocks = await blocksRead(range, WALLET_TABLES)
      if (blocks.toBlock < blocks.fromBlock) return { address: account, blocks, legs: [], references: [], gasUnknownTxs: [] }
      const { rows, priced, gasUnknownTxs } = await reader.readWindow(account, blocks.fromBlock, blocks.toBlock)
      const references = await reader.readReferences(rows.map((r) => r.block_num))
      return { address: account, blocks, legs: buildPricedLegs({ account, rows, references, priced }), references, gasUnknownTxs }
    },

    /**
     * A token's prices in the range, by symbol or address. A token with an oracle has one price a block, and any other
     * token has one for each swap that gave one. A swap that couldn't be priced is still there, as unknown.
     */
    async getPrices(token: string, range: BlockRange): Promise<TokenPrices> {
      const found = findToken(token)
      const blocks = await blocksRead(range, found.oracle ? ORACLE_TABLES : SWAP_TABLES)
      const result = { token: found.symbol, blocks }
      if (blocks.toBlock < blocks.fromBlock) return { ...result, prices: [] }

      if (found.oracle) {
        const rows = await reader.readOracle(found.oracle, blocks.fromBlock, blocks.toBlock)
        const prices = rows.map(({ block_num, timestamp, answer }): PricePoint => {
          const usdMicros = answerToMicros(answer)
          return { blockNum: block_num, timestamp, usdMicros, source: usdMicros === null ? "unknown" : "oracle", txHash: null, account: null, note: usdMicros === null ? "The oracle read failed at this block." : null }
        })
        return { ...result, prices }
      }

      const swaps = await reader.readSwaps(found.address, blocks.fromBlock, blocks.toBlock)
      const moved = new Map<string, LegRow[]>()
      for (const r of await reader.readTxRows(swaps.map((s) => s.row))) moved.set(r.tx_hash, [...(moved.get(r.tx_hash) ?? []), r])
      const prices = swaps.map(({ row, timestamp, reference }): PricePoint => {
        // The same path a wallet's legs take, so a price the app would reject, like one from a swap that also moved a
        // token off the allowlist, is unknown here too. `priced_legs` alone can't tell those apart.
        const legs = buildPricedLegs({ account: row.account, rows: moved.get(row.tx_hash) ?? [], references: [reference], priced: [row] })
        const leg = legs.find((l) => l.asset === found.asset)
        const usdMicros = leg?.priceSource === "swap" ? leg.priceUsdMicros : null
        const base = { blockNum: row.block_num, timestamp, txHash: row.tx_hash, account: row.account }
        if (usdMicros !== null) return { ...base, usdMicros, source: "swap", note: null }
        return { ...base, usdMicros: null, source: "unknown", note: leg?.priceNote ?? "This swap didn't give a usable price for this token." }
      })
      return { ...result, prices }
    },

    /** The current prices `buildPortfolio` values positions at. Only tokens with a recent oracle read have one. */
    async getLatestPrices(): Promise<LatestPrices> {
      const head = await reader.head(null)
      return latestPrices(head && (await reader.readLatestReference(head.blockNum)))
    },
  }
}

export type Pricetag = ReturnType<typeof pricetagClient>
