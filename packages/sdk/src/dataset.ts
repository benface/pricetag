// Reads the Pricetag dataset's tables into the shapes the pricing code takes.
//
// Every query is bounded by block, because a hosted Amp is shared.

import { asIso, asNumber, decimalString, hexOf, isNotStarted, prefixed, type BlockMark, type Query } from "./amp.ts"
import { blockBefore } from "./chain.ts"
import { MULTICALL3, decodeEthBalance, encodeEthBalanceCall, readBalancesAt } from "./balances.ts"
import type { RateRound } from "./currency.ts"
import type { LegRow, PayoutTx, PricedRow, Reference } from "./legs.ts"
import type { FeedRound, Head } from "./portfolio.ts"
import { TOKEN_FEEDS, type PriceFeed } from "./tokens.ts"
import type { Source } from "./wallets.ts"

export type Row = Record<string, unknown>

const BLOCKS_PER_QUERY = 200
/** `reference_prices` has one small row per block. 20,000 of them took 1 s on staging, against 0.3 s for 200 named blocks. */
const REFERENCE_SPAN = 20_000

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

/** How far apart blocks can be, on average, for a range to be the cheaper way to read them. */
const MAX_AVERAGE_GAP = 20

/**
 * WHERE clauses for a list of blocks, for reads that can ignore whatever else is in the range. Naming blocks takes a query
 * per 200, however close together they are, so a busy wallet's blocks are read as ranges of up to `span` blocks instead.
 */
export function blockRanges(blocks: readonly number[], span: number): string[] {
  const sorted = [...new Set(blocks)].sort((a, b) => a - b)
  const [first, last] = [sorted[0] ?? 0, sorted.at(-1) ?? 0]
  if (sorted.length <= BLOCKS_PER_QUERY || last - first > sorted.length * MAX_AVERAGE_GAP) return blockFilters(sorted).map(({ filter }) => filter)
  const result: string[] = []
  for (let i = 0; i < sorted.length; ) {
    const from = sorted[i] as number
    let to = from
    for (; i < sorted.length && (sorted[i] as number) < from + span; i++) to = sorted[i] as number
    result.push(`block_num BETWEEN ${from} AND ${to}`)
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

/**
 * The newest block from `after` on. With no newer block to go from, pass the dataset's start block if there is one:
 * Amp only skips files on a range, and on staging this query took 8 s with no bound and 0.4 s with one.
 */
export async function readHead(query: Query, dataset: string, after: number | null): Promise<Head | null> {
  const where = after === null ? "" : `WHERE block_num >= ${after}`
  const rows = await query<Row>(`SELECT block_num, timestamp FROM "${dataset}".blocks ${where} ORDER BY block_num DESC LIMIT 1`, 15_000)
  const row = rows[0]
  return row ? { blockNum: asNumber(row.block_num), timestamp: asIso(row.timestamp) } : null
}

/** The head with its hash, which a stream resumes from. */
export async function readHeadMark(query: Query, dataset: string, after: number | null): Promise<BlockMark | null> {
  const where = after === null ? "" : `WHERE block_num >= ${after}`
  const rows = await query<Row>(`SELECT block_num, hash FROM "${dataset}".blocks ${where} ORDER BY block_num DESC LIMIT 1`, 15_000)
  const row = rows[0]
  return row ? { blockNum: asNumber(row.block_num), hash: prefixed(hexOf(String(row.hash))) } : null
}

/** The hash the chain has at each of these blocks, leaving out any it doesn't have. */
export async function readBlockHashes(query: Query, dataset: string, blocks: readonly number[]): Promise<Map<number, string>> {
  const hashes = new Map<number, string>()
  for (const { filter } of blockFilters(blocks)) {
    const rows = await query<Row>(`SELECT block_num, hash FROM "${dataset}".blocks WHERE ${filter}`, 15_000)
    for (const row of rows) hashes.set(asNumber(row.block_num), prefixed(hexOf(String(row.hash))))
  }
  return hashes
}

/**
 * What to stream to know a block has been processed. `priced_legs` is the last table to finish one, so a wallet read can
 * reach that block by then. No row matches: rows come from bounded queries, and a stream's progress is in its metadata.
 */
export const followSql = (dataset: string) => `SELECT block_num FROM "${dataset}".priced_legs WHERE block_num < 0`

/** The same for reading the raw dataset, which has no tables to wait for. */
export const followRawSql = (baseDataset: string) => `SELECT block_num FROM "${baseDataset}".blocks WHERE block_num < 0`

/** A derived table runs a few seconds behind the head, and older than this isn't a current price. */
const MAX_PRICE_AGE_MS = 120_000

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

export function datasetReader(query: Query, config: { baseDataset: string; dataset: string; priceDataset?: string | undefined; startBlock?: number | null | undefined }) {
  const ds = `"${config.dataset}"`
  // A fork of the pricing rule only needs the tables the rule reaches, so these can come from somewhere else.
  const prices = `"${config.priceDataset ?? config.dataset}"`
  const readOrEmpty = (sql: string) =>
    query<Row>(sql).catch((error: unknown) => {
      if (isNotStarted(error)) return []
      throw error
    })

  /** What moved in a wallet, which no pricing rule changes. */
  async function readLegs(address: string, from: number, to: number) {
    const me = hexOf(address)
    const range = `block_num BETWEEN ${from} AND ${to}`
    const legRows = await query<Row>(`SELECT ${LEG_COLUMNS} FROM ${ds}.legs WHERE ${range} AND account = X'${me}'`)
    const unlistedRows = await query<Row>(`SELECT ${LEG_COLUMNS} FROM ${ds}.unlisted_legs WHERE ${range} AND account = X'${me}'`)
    const rows = legRows.map(toLegRow)
    return {
      // pt_gas leaves the amount empty when the gas can't be worked out, and BigInt can't read that.
      // An unlisted row stays either way, because it's evidence that something moved.
      rows: [...rows.filter((r) => r.amount !== "" && r.amount !== "0"), ...unlistedRows.map(toLegRow)],
      gasUnknown: rows.filter((r) => r.kind === "gas" && r.amount === "").map(({ tx_hash, block_num }) => ({ tx_hash, block_num })),
    }
  }

  /** What this rule's `priced_legs` says about a wallet. */
  async function readPriced(address: string, from: number, to: number) {
    const pricedRows = await query<Row>(`SELECT ${PRICED_COLUMNS} FROM ${prices}.priced_legs WHERE block_num BETWEEN ${from} AND ${to} AND account = X'${hexOf(address)}'`)
    return pricedRows.map(toPricedRow)
  }

  return {
    head: (after: number | null) => readHead(query, config.baseDataset, after ?? config.startBlock ?? null),

    /**
     * The newest block, in `after`..`head`, that all these tables have processed, or null if one has none.
     * Reads never go past this. A derived table can lag the chain, and a block read before it's processed looks empty.
     */
    async processedThrough(after: number, head: number, tables: readonly string[] = WALLET_TABLES): Promise<number | null> {
      const tableOf = (table: string) => `${PRICE_TABLES.includes(table) ? prices : ds}.${table}`
      // One query matching no rows: Amp says how far all its tables have got, and a table can be done with a block it has no row for.
      const end = await query.snapshotEnd?.(tables.map((table) => `SELECT block_num FROM ${tableOf(table)} WHERE false`).join(" UNION ALL ")).catch((error: unknown) => {
        if (isNotStarted(error)) return after - 1
        throw error
      })
      if (end !== undefined && end !== null) return end < after ? null : Math.min(end, head)
      // Without that, a table's newest row is as far as it can be shown to have got.
      const newest = await Promise.all(tables.map((table) => readOrEmpty(`SELECT block_num FROM ${tableOf(table)} WHERE block_num >= ${after} ORDER BY block_num DESC LIMIT 1`)))
      let through = head
      for (const rows of newest) {
        if (!rows[0]) return null
        through = Math.min(through, asNumber(rows[0].block_num))
      }
      return through
    },

    readLegs,

    readPriced,

    async readWindow(address: string, from: number, to: number) {
      return { ...(await readLegs(address, from, to)), priced: await readPriced(address, from, to) }
    },

    async readReferences(blocks: readonly number[]): Promise<Reference[]> {
      const wanted = new Set(blocks)
      const result: Reference[] = []
      for (const filter of blockRanges(blocks, REFERENCE_SPAN)) {
        const rows = await query<Row>(`SELECT ${REFERENCE_COLUMNS} FROM ${prices}.reference_prices WHERE ${filter}`)
        for (const row of rows) if (wanted.has(asNumber(row.block_num))) result.push(toReference(row))
      }
      return result
    },

    /** The newest oracle read at or just before `head`, or null if there's none recent enough to call current. */
    async readLatestReference(head: number): Promise<Reference | null> {
      const rows = await readOrEmpty(`SELECT ${REFERENCE_COLUMNS} FROM ${prices}.reference_prices WHERE block_num BETWEEN ${blockBefore(head, MAX_PRICE_AGE_MS)} AND ${head} ORDER BY block_num DESC LIMIT 1`)
      return rows[0] ? toReference(rows[0]) : null
    },

    async readOracle(oracle: "eth" | "usdc", from: number, to: number): Promise<OracleRow[]> {
      const rows = await query<Row>(`SELECT block_num, timestamp, ${ORACLE_COLUMNS[oracle]} AS answer FROM ${prices}.reference_prices WHERE block_num BETWEEN ${from} AND ${to} ORDER BY block_num`)
      return rows.map((r) => ({ block_num: asNumber(r.block_num), timestamp: asIso(r.timestamp), answer: decimalString(r.answer) ?? "" }))
    },

    /** The update a `reference_prices` row at `block` names, or null if the feed's window doesn't reach it. */
    async readPriceUpdate(feed: PriceFeed, txHash: string, block: number): Promise<PriceUpdate | null> {
      const rows = await query<Row>(
        `SELECT block_num, tx_hash, log_index, answer FROM ${ds}.price_updates WHERE block_num BETWEEN ${blockBefore(block, feed.validSeconds * 1000)} AND ${block} AND feed = '${feed.name}' AND tx_hash = X'${hexOf(txHash)}' ORDER BY block_num DESC, log_index DESC LIMIT 1`,
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

/** The successful transactions that name this wallet in their calldata, or that it sent, in these blocks. */
export async function readPayoutTxsAt(query: Query, baseDataset: string, address: string, blocks: readonly number[]): Promise<PayoutTx[]> {
  const me = hexOf(address)
  const txs: PayoutTx[] = []
  for (const { filter } of blockFilters(blocks)) {
    const rows = await query<Row>(`SELECT block_num, tx_hash, "from", "to", input FROM "${baseDataset}".transactions WHERE ${filter} AND status AND ("from" = X'${me}' OR strpos(encode(input, 'hex'), '${me}') > 0)`)
    for (const row of rows) {
      txs.push({
        blockNum: asNumber(row.block_num),
        txHash: prefixed(String(row.tx_hash)),
        from: prefixed(String(row.from)),
        to: row.to == null ? null : prefixed(String(row.to)),
        input: String(row.input ?? ""),
      })
    }
  }
  return txs
}

/** The `answer` word of a `latestRoundData()` result, or "" when the read failed. */
export function decodeRoundAnswer(data: string | null | undefined): string {
  const word = data?.slice(64, 128)
  if (!word || word.length !== 64) return ""
  const answer = BigInt(`0x${word}`)
  return answer >> 255n === 1n ? "" : answer.toString()
}

/** A `latestRoundData()` result's answer and when it last updated, or null when the read failed or it isn't a positive answer. */
export function decodeRound(data: string | null | undefined): RateRound | null {
  const answer = decodeRoundAnswer(data)
  const updatedAt = data?.slice(192, 256)
  if (!answer || answer === "0" || !updatedAt || updatedAt.length !== 64) return null
  return { answer, updatedAt: Number(BigInt(`0x${updatedAt}`)) }
}

/**
 * One query however many feeds: a wallet that holds several asks for them all at once. The filter sits in an inner subquery
 * with a LIMIT, and the outer query reads no field of the result. WORK-320 found the other shapes can run eth_call on every block on the chain.
 */
export function readFeedRoundsAt(query: Query, config: { baseDataset: string; network: string }): NonNullable<Source["readFeedRounds"]> {
  return async (assets, block) => {
    const feeds = assets.flatMap((asset) => {
      const feed = TOKEN_FEEDS[asset]
      return feed ? [{ asset, address: feed.address }] : []
    })
    if (feeds.length === 0) return {}
    const calls = feeds.map(({ address }, i) => `rpc.${config.network}.eth_call(NULL, evm_encode_hex('${address}'), evm_encode_params('latestRoundData()'), block_num) AS f${i}`)
    const { filter, count } = blockFilters([block])[0] as { filter: string; count: number }
    const [row] = await query<Row>(`SELECT block_num, timestamp, ${calls.join(", ")} FROM (SELECT block_num, timestamp FROM "${config.baseDataset}".blocks WHERE ${filter} LIMIT ${count})`)
    if (!row) return {}
    const rounds: Record<string, FeedRound> = {}
    feeds.forEach(({ asset }, i) => {
      const round = decodeRound((row[`f${i}`] as { data?: string } | null)?.data)
      if (round) rounds[asset] = { ...round, blockNum: asNumber(row.block_num), timestamp: asIso(row.timestamp) }
    })
    return rounds
  }
}

export function datasetSource(query: Query, config: { baseDataset: string; dataset: string; priceDataset?: string | undefined; startBlock: number | null; network: string }): Source {
  return {
    mode: "dataset",
    startBlock: config.startBlock,
    historyFrom: null,
    readBalances: (address, block) => readBalancesAt(query, config.network, address, block),
    readEthBalances: (address, blocks) => readEthBalancesAt(query, config.network, config.baseDataset, address, blocks),
    readPayoutTxs: (address, blocks) => readPayoutTxsAt(query, config.baseDataset, address, blocks),
    readFeedRounds: readFeedRoundsAt(query, config),
    ...datasetReader(query, config),
  }
}
