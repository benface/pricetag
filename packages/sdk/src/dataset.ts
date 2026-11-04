// Reads the Pricetag dataset's tables into the shapes the pricing code takes.
//
// Every query is bounded by block, because a hosted Amp is shared.

import { asIso, asNumber, decimalString, hexOf, isNotStarted, prefixed, type Query } from "./amp.ts"
import { MULTICALL3, decodeEthBalance, encodeEthBalanceCall, readBalancesAt } from "./balances.ts"
import type { LegRow, PricedRow, Reference } from "./legs.ts"
import type { Head } from "./portfolio.ts"
import { blocksWithin, type PriceFeed } from "./tokens.ts"
import type { Source } from "./wallets.ts"

export type Row = Record<string, unknown>

const BLOCKS_PER_QUERY = 200

/**
 * WHERE clauses for a list of blocks, split so no query names too many.
 * Amp only skips files on a range: `block_num IN (...)` alone timed out on staging, and with the BETWEEN it took 1 s.
 */
export function blockFilters(blocks: readonly number[]): { filter: string; count: number }[] {
  const sorted = [...new Set(blocks)].sort((a, b) => a - b)
  const result: { filter: string; count: number }[] = []
  for (let i = 0; i < sorted.length; i += BLOCKS_PER_QUERY) {
    const part = sorted.slice(i, i + BLOCKS_PER_QUERY)
    result.push({ filter: `block_num BETWEEN ${part[0]} AND ${part[part.length - 1]} AND block_num IN (${part.join(", ")})`, count: part.length })
  }
  return result
}

/** WHERE clauses for a list of transactions, with the same block range for Amp to skip files on. */
export function txFilters(txs: readonly { block_num: number; tx_hash: string }[]): string[] {
  const sorted = [...txs].sort((a, b) => a.block_num - b.block_num)
  const result: string[] = []
  for (let i = 0; i < sorted.length; i += BLOCKS_PER_QUERY) {
    const part = sorted.slice(i, i + BLOCKS_PER_QUERY)
    const hashes = [...new Set(part.map((t) => `X'${hexOf(t.tx_hash)}'`))].join(", ")
    result.push(`block_num BETWEEN ${part[0]!.block_num} AND ${part[part.length - 1]!.block_num} AND tx_hash IN (${hashes})`)
  }
  return result
}

export async function readHead(query: Query, dataset: string, after: number | null): Promise<Head | null> {
  const where = after === null ? "" : `WHERE block_num >= ${after}`
  const rows = await query<Row>(`SELECT block_num, timestamp FROM "${dataset}".blocks ${where} ORDER BY block_num DESC LIMIT 1`, 15_000)
  const row = rows[0]
  return row ? { blockNum: asNumber(row.block_num), timestamp: asIso(row.timestamp) } : null
}

/** About 2 minutes. A derived table runs a block or two behind the head, and older than this isn't a current price. */
const MAX_PRICE_AGE_BLOCKS = 60

const LEG_COLUMNS = "block_num, timestamp, tx_hash, tx_index, log_index, token, account, side, amount, kind"
const PRICED_COLUMNS = "block_num, tx_hash, account, sold_token, sold_amount, bought_token, bought_amount, priced"
const ORACLE_COLUMNS = { eth: "eth_answer", usdc: "usdc_answer" }
const REFERENCE_COLUMNS = `block_num, ${ORACLE_COLUMNS.eth} AS eth_usd, ${ORACLE_COLUMNS.usdc} AS usdc_usd, eth_tx, usdc_tx`

const toReference = (r: Row): Reference => ({
  blockNum: asNumber(r.block_num),
  ethUsd: decimalString(r.eth_usd) ?? "",
  usdcUsd: decimalString(r.usdc_usd) ?? "",
  ethTx: r.eth_tx == null ? undefined : prefixed(String(r.eth_tx)),
  usdcTx: r.usdc_tx == null ? undefined : prefixed(String(r.usdc_tx)),
})

const toLegRow = (l: Row): LegRow => ({
  block_num: asNumber(l.block_num),
  timestamp: asIso(l.timestamp),
  tx_hash: prefixed(String(l.tx_hash)),
  tx_index: asNumber(l.tx_index),
  log_index: asNumber(l.log_index),
  token: prefixed(String(l.token)),
  account: prefixed(String(l.account)),
  side: l.side as LegRow["side"],
  amount: l.amount == null ? "" : String(l.amount),
  kind: l.kind as LegRow["kind"],
})

const toPricedRow = (p: Row): PricedRow => ({
  block_num: asNumber(p.block_num),
  tx_hash: prefixed(String(p.tx_hash)),
  account: prefixed(String(p.account)),
  sold_token: prefixed(String(p.sold_token)),
  sold_amount: String(p.sold_amount),
  bought_token: prefixed(String(p.bought_token)),
  bought_amount: String(p.bought_amount),
  priced: p.priced as PricedRow["priced"],
})

/** A `priced_legs` row, with the timestamp and oracle reads of its block. */
export type SwapRow = { row: PricedRow; timestamp: string; reference: Reference }

export type OracleRow = { block_num: number; timestamp: string; answer: string }

/** A row of `price_updates`: one `AnswerUpdated` log from a feed's aggregator, or on a local Amp, a price read when it started (`SEED_TX`). */
export type PriceUpdate = { block_num: number; tx_hash: string; log_index: number; answer: string }

/** Each read only waits for the tables it uses, so a lagging table doesn't hide what's ready in another. */
export const WALLET_TABLES = ["legs", "unlisted_legs", "priced_legs", "reference_prices"]
export const ORACLE_TABLES = ["reference_prices"]
export const SWAP_TABLES = ["legs", "unlisted_legs", "priced_legs"]

/** The tables a pricing rule decides. Everything else is what happened on the chain, whichever rule prices it. */
const PRICE_TABLES = ["priced_legs", "reference_prices"]

export function datasetReader(query: Query, config: { baseDataset: string; dataset: string; priceDataset?: string | undefined }) {
  const ds = `"${config.dataset}"`
  // A fork of the pricing rule only needs the tables the rule reaches, so these can come from somewhere else.
  const prices = `"${config.priceDataset ?? config.dataset}"`
  const readOrEmpty = (sql: string) =>
    query<Row>(sql).catch((error: unknown) => {
      if (isNotStarted(error)) return []
      throw error
    })
  return {
    head: (after: number | null) => readHead(query, config.baseDataset, after),

    /**
     * The newest block, in `after`..`head`, that all these tables have processed, or null if one has none.
     * Reads never go past this. A derived table can lag the chain, and a block read before it's processed looks empty.
     */
    async processedThrough(after: number, head: number, tables: readonly string[] = WALLET_TABLES): Promise<number | null> {
      let through = head
      for (const table of tables) {
        const rows = await readOrEmpty(`SELECT block_num FROM ${PRICE_TABLES.includes(table) ? prices : ds}.${table} WHERE block_num >= ${after} ORDER BY block_num DESC LIMIT 1`)
        if (!rows[0]) return null
        through = Math.min(through, asNumber(rows[0].block_num))
      }
      return through
    },

    async readWindow(address: string, from: number, to: number) {
      const me = hexOf(address)
      const range = `block_num BETWEEN ${from} AND ${to}`
      const legRows = await query<Row>(`SELECT ${LEG_COLUMNS} FROM ${ds}.legs WHERE ${range} AND account = X'${me}'`)
      const unlistedRows = await query<Row>(`SELECT ${LEG_COLUMNS} FROM ${ds}.unlisted_legs WHERE ${range} AND account = X'${me}'`)
      const pricedRows = await query<Row>(`SELECT ${PRICED_COLUMNS} FROM ${prices}.priced_legs WHERE ${range} AND account = X'${me}'`)
      const rows = legRows.map(toLegRow)
      return {
        // pt_gas leaves the amount empty when the gas can't be worked out, and BigInt can't read that.
        // An unlisted row stays either way, because it's evidence that something moved.
        rows: [...rows.filter((r) => r.amount !== "" && r.amount !== "0"), ...unlistedRows.map(toLegRow)],
        gasUnknown: rows.filter((r) => r.kind === "gas" && r.amount === "").map(({ tx_hash, block_num }) => ({ tx_hash, block_num })),
        priced: pricedRows.map(toPricedRow),
      }
    },

    async readReferences(blocks: readonly number[]): Promise<Reference[]> {
      const result: Reference[] = []
      for (const { filter } of blockFilters(blocks)) {
        const rows = await query<Row>(`SELECT ${REFERENCE_COLUMNS} FROM ${prices}.reference_prices WHERE ${filter}`)
        result.push(...rows.map(toReference))
      }
      return result
    },

    /** The newest oracle read at or just before `head`, or null if there's none recent enough to call current. */
    async readLatestReference(head: number): Promise<Reference | null> {
      const rows = await readOrEmpty(`SELECT ${REFERENCE_COLUMNS} FROM ${prices}.reference_prices WHERE block_num BETWEEN ${head - MAX_PRICE_AGE_BLOCKS} AND ${head} ORDER BY block_num DESC LIMIT 1`)
      return rows[0] ? toReference(rows[0]) : null
    },

    async readOracle(oracle: "eth" | "usdc", from: number, to: number): Promise<OracleRow[]> {
      const rows = await query<Row>(`SELECT block_num, timestamp, ${ORACLE_COLUMNS[oracle]} AS answer FROM ${prices}.reference_prices WHERE block_num BETWEEN ${from} AND ${to} ORDER BY block_num`)
      return rows.map((r) => ({ block_num: asNumber(r.block_num), timestamp: asIso(r.timestamp), answer: decimalString(r.answer) ?? "" }))
    },

    /** The update a `reference_prices` row at `block` names, or null if the feed's window doesn't reach it. */
    async readPriceUpdate(feed: PriceFeed, txHash: string, block: number): Promise<PriceUpdate | null> {
      const rows = await query<Row>(
        `SELECT block_num, tx_hash, log_index, answer FROM ${ds}.price_updates WHERE block_num BETWEEN ${block - blocksWithin(feed.validSeconds, block)} AND ${block} AND feed = '${feed.name}' AND tx_hash = X'${hexOf(txHash)}' ORDER BY block_num DESC, log_index DESC LIMIT 1`,
      )
      const row = rows[0]
      return row ? { block_num: asNumber(row.block_num), tx_hash: prefixed(String(row.tx_hash)), log_index: asNumber(row.log_index), answer: decimalString(row.answer) ?? "" } : null
    },

    /** Every swap in the range that sold or bought this token, whichever account made it. */
    async readSwaps(token: string, from: number, to: number): Promise<SwapRow[]> {
      const hex = `X'${hexOf(token)}'`
      const rows = await query<Row>(
        `SELECT ${PRICED_COLUMNS}, timestamp, eth_usd, usdc_usd, eth_tx, usdc_tx FROM ${prices}.priced_legs WHERE block_num BETWEEN ${from} AND ${to} AND (sold_token = ${hex} OR bought_token = ${hex}) ORDER BY block_num`,
      )
      return rows.map((r) => ({ row: toPricedRow(r), timestamp: asIso(r.timestamp), reference: toReference(r) }))
    },

    /** Everything these transactions moved, for every account, leaving out gas: what a swap's price has to be checked against. */
    async readTxRows(txs: readonly { block_num: number; tx_hash: string }[]): Promise<LegRow[]> {
      const result: LegRow[] = []
      for (const filter of txFilters(txs)) {
        const legs = await query<Row>(`SELECT ${LEG_COLUMNS} FROM ${ds}.legs WHERE ${filter} AND kind <> 'gas'`)
        const unlisted = await query<Row>(`SELECT ${LEG_COLUMNS} FROM ${ds}.unlisted_legs WHERE ${filter}`)
        result.push(...legs.map(toLegRow), ...unlisted.map(toLegRow))
      }
      return result
    },
  }
}

/**
 * One query per 200 blocks, in the shape the raw source's `readReferences` explains. A block the table doesn't have, like
 * the one before a local dataset's start, is read on its own.
 */
export async function readEthBalancesAt(query: Query, network: string, baseDataset: string, address: string, blocks: readonly number[]): Promise<Map<number, string>> {
  const balances = new Map<number, string>()
  const call = (block: string) => `rpc.${network}.eth_call(NULL, evm_encode_hex('${MULTICALL3}'), X'${encodeEthBalanceCall(address)}', ${block}) AS r`
  const dataOf = (row: Row | undefined) => (row?.r as { data?: string } | null | undefined)?.data
  const returned = new Set<number>()
  for (const { filter, count } of blockFilters(blocks)) {
    for (const row of await query<Row>(`SELECT block_num, ${call("block_num")} FROM (SELECT block_num FROM "${baseDataset}".blocks WHERE ${filter} LIMIT ${count})`)) {
      const block = asNumber(row.block_num)
      const balance = decodeEthBalance(dataOf(row))
      returned.add(block)
      if (balance !== null) balances.set(block, balance)
    }
  }
  for (const block of blocks) {
    if (returned.has(block)) continue
    const [row] = await query<Row>(`SELECT ${call(String(block))}`)
    const balance = decodeEthBalance(dataOf(row))
    if (balance !== null) balances.set(block, balance)
  }
  return balances
}

export function datasetSource(query: Query, config: { baseDataset: string; dataset: string; priceDataset?: string | undefined; startBlock: number | null; network: string }): Source {
  return {
    mode: "dataset",
    startBlock: config.startBlock,
    historyBlocks: null,
    readBalances: (address, block) => readBalancesAt(query, config.network, address, block),
    readEthBalances: (address, blocks) => readEthBalancesAt(query, config.network, config.baseDataset, address, blocks),
    ...datasetReader(query, config),
  }
}
