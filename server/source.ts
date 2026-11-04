// Where a wallet's rows come from: the Pricetag dataset when it's deployed, otherwise the raw Base dataset,
// read through the same shapes so everything after this file doesn't care which one it was.
//
// Every query is bounded by block, because staging is shared.

import { ERC20_ADDRESSES, ETH_USD_FEED, USDC_USD_FEED, WETH_ADDRESS, asIso, asNumber, blockFilters, datasetReader, decimalString, describeError, hexOf, isNotStarted, prefixed, readHead, type LegRow, type PricedRow, type Query, type ReferenceRow, type Row, type BalanceSnapshot } from "@pricetag/sdk"
import type { Head, Mode } from "../src/core/api.ts"
import type { RateRound } from "../src/core/currency.ts"
import { marketTrades, type MarketTrade } from "../src/core/market.ts"
import { parseNote, type CostNote } from "../src/core/notes.ts"
import { MULTICALL3, balancesByAsset, decodeBalanceResults, encodeBalanceCalls } from "./balances.ts"
import { DEPOSIT_TOPIC, TRANSFER_BATCH_TOPIC, TRANSFER_SINGLE_TOPIC, TRANSFER_TOPIC, WITHDRAWAL_TOPIC, counterpartyBlocks, decodeRound, decodeRoundAnswer, legRowsFromRaw, withCounterparties, type RawLog, type RawTx } from "./raw.ts"

export type WindowRows = { rows: LegRow[]; priced: PricedRow[] | null; gasUnknownTxs: string[] }

export type Source = {
  mode: Mode
  /** The first block a wallet's history can start from, or null to count back from the head. */
  startBlock: number | null
  historyBlocks: number | null
  head(after: number | null): Promise<Head | null>
  /**
   * The newest block, in `after`..`head`, that every table a wallet read needs has processed, or null if none has.
   * Reads never go past this. A derived table can lag the chain, and a block read before it's processed looks empty.
   */
  processedThrough(after: number, head: number): Promise<number | null>
  readWindow(address: string, from: number, to: number): Promise<WindowRows>
  readReferences(blocks: readonly number[]): Promise<ReferenceRow[]>
  /** The newest oracle read at or just before `head`, or null if there's none recent enough to call current. */
  readLatestReference(head: number): Promise<ReferenceRow | null>
  /** What the chain says this wallet holds at `block`, or null when the read gave nothing usable. */
  readBalances(address: string, block: number): Promise<BalanceSnapshot | null>
  /** The cost notes this wallet published in these blocks: zero-value transactions from itself to itself. */
  readNotes?(address: string, blocks: readonly number[]): Promise<CostNote[]>
  /** Whether `readMarketTrades` can be trusted. An older dataset's `priced_legs` has wrong rows, so it can't. */
  marketReady?(): Promise<boolean>
  /** An asset's latest trades in a block range, newest first. Only a dataset's `priced_legs` has them. */
  readMarketTrades?(asset: string, from: number, to: number): Promise<MarketTrade[]>
}

/**
 * With no table in the query, this makes exactly one `eth_call`, and it can read a block no table has, like the one
 * before a local dataset's start.
 */
async function readBalancesAt(query: Query, network: string, address: string, block: number): Promise<BalanceSnapshot | null> {
  const [row] = await query<Row>(`SELECT rpc.${network}.eth_call(NULL, evm_encode_hex('${MULTICALL3}'), X'${encodeBalanceCalls(address)}', ${block}) AS r`)
  const results = decodeBalanceResults((row?.r as { data?: string } | null | undefined)?.data)
  return results && { blockNum: block, amounts: balancesByAsset(results) }
}

/** A feed's answer at each block, leaving out blocks where the read failed. */
export type RoundReader = (feed: string, blocks: readonly number[]) => Promise<Map<number, RateRound>>

/**
 * Exchange rates read the way `rawSource` reads the oracle, whichever source a wallet comes from: the Pricetag dataset's
 * base is USD, so it doesn't hold them. See the note on the query's shape in `readReferences`.
 */
export function feedRounds(query: Query, config: { baseDataset: string; network: string }): RoundReader {
  return async (feed, blocks) => {
    const rounds = new Map<number, RateRound>()
    for (const { filter, count } of blockFilters(blocks)) {
      const rows = await query<Row>(
        `SELECT block_num, rpc.${config.network}.eth_call(NULL, evm_encode_hex('${feed}'), evm_encode_params('latestRoundData()'), block_num) AS round
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

async function readNotesAt(query: Query, dataset: string, address: string, blocks: readonly number[]): Promise<CostNote[]> {
  const me = hexOf(address)
  const notes: CostNote[] = []
  for (const { filter } of blockFilters(blocks)) {
    const rows = await query<Row>(`SELECT block_num, tx_hash, input FROM "${dataset}".transactions WHERE ${filter} AND "from" = X'${me}' AND "to" = X'${me}' AND status AND value = '0'`)
    for (const row of rows) {
      const note = parseNote(String(row.input ?? ""))
      if (note) notes.push({ ...note, noteTx: prefixed(String(row.tx_hash)), blockNum: asNumber(row.block_num) })
    }
  }
  return notes.sort((a, b) => a.blockNum - b.blockNum)
}

export function rawSource(query: Query, config: { baseDataset: string; network: string; historyBlocks: number }): Source {
  const ds = `"${config.baseDataset}"`

  async function inBlocks<T>(blocks: readonly number[], sql: (filter: string, count: number) => string): Promise<T[]> {
    const result: T[] = []
    for (const { filter, count } of blockFilters(blocks)) result.push(...(await query<T>(sql(filter, count))))
    return result
  }

  const readReferences = (blocks: readonly number[]) =>
    inBlocks<Row>(
      blocks,
      // The filter sits in an inner subquery with a LIMIT, and the outer query reads no field of the result.
      // WORK-320 found the other shapes can run eth_call on every block on the chain.
      (filter, count) =>
        `SELECT block_num,
           rpc.${config.network}.eth_call(NULL, evm_encode_hex('${ETH_USD_FEED}'), evm_encode_params('latestRoundData()'), block_num) AS e,
           rpc.${config.network}.eth_call(NULL, evm_encode_hex('${USDC_USD_FEED}'), evm_encode_params('latestRoundData()'), block_num) AS u
         FROM (SELECT block_num FROM ${ds}.blocks WHERE ${filter} LIMIT ${count})`,
    ).then((rows) =>
      rows.map((r) => ({
        block_num: asNumber(r.block_num),
        eth_usd: decodeRoundAnswer((r.e as { data?: string } | null)?.data),
        usdc_usd: decodeRoundAnswer((r.u as { data?: string } | null)?.data),
      })),
    )

  return {
    mode: "raw",
    startBlock: null,
    historyBlocks: config.historyBlocks,
    head: (after) => readHead(query, config.baseDataset, after),
    // The raw tables are what the head is read from, so they've always reached it.
    processedThrough: async (_after, head) => head,
    readReferences,
    readLatestReference: async (head) => (await readReferences([head]))[0] ?? null,
    readBalances: (address, block) => readBalancesAt(query, config.network, address, block),
    readNotes: (address, blocks) => readNotesAt(query, config.baseDataset, address, blocks),

    async readWindow(address, from, to) {
      const me = hexOf(address)
      const topic = `X'${me.padStart(64, "0")}'`
      const range = `block_num BETWEEN ${from} AND ${to}`
      const txRows = await query<Row>(
        `SELECT block_num, timestamp, tx_hash, tx_index, "from", "to", value, gas_used, gas_price, max_fee_per_gas, max_priority_fee_per_gas, status, type
         FROM ${ds}.transactions WHERE ${range} AND ("from" = X'${me}' OR "to" = X'${me}')`,
      )
      const txs: RawTx[] = txRows.map((t) => ({
        block_num: asNumber(t.block_num),
        timestamp: asIso(t.timestamp),
        tx_hash: prefixed(String(t.tx_hash)),
        tx_index: asNumber(t.tx_index),
        from: String(t.from),
        to: t.to == null ? null : String(t.to),
        value: String(t.value),
        gas_used: String(t.gas_used),
        gas_price: decimalString(t.gas_price),
        max_fee_per_gas: decimalString(t.max_fee_per_gas),
        max_priority_fee_per_gas: decimalString(t.max_priority_fee_per_gas),
        status: Boolean(t.status),
        type: asNumber(t.type),
      }))
      const toLog = (l: Row): RawLog => ({
        block_num: asNumber(l.block_num),
        timestamp: asIso(l.timestamp),
        tx_hash: prefixed(String(l.tx_hash)),
        tx_index: asNumber(l.tx_index),
        log_index: asNumber(l.log_index),
        address: String(l.address),
        topic0: String(l.topic0),
        topic1: l.topic1 == null ? null : String(l.topic1),
        topic2: l.topic2 == null ? null : String(l.topic2),
        topic3: l.topic3 == null ? null : String(l.topic3),
        data: String(l.data),
      })
      const logColumns = "block_num, timestamp, tx_hash, tx_index, log_index, address, topic0, topic1, topic2, topic3, data"
      const logs = (
        await query<Row>(
          `SELECT ${logColumns} FROM ${ds}.logs
           WHERE ${range} AND (
             (topic0 IN (X'${TRANSFER_TOPIC}', X'${DEPOSIT_TOPIC}', X'${WITHDRAWAL_TOPIC}') AND (topic1 = ${topic} OR topic2 = ${topic}))
             OR (topic0 IN (X'${TRANSFER_SINGLE_TOPIC}', X'${TRANSFER_BATCH_TOPIC}') AND (topic2 = ${topic} OR topic3 = ${topic}))
           )`,
        )
      ).map(toLog)

      const sent = txs.filter((t) => hexOf(t.from) === me)
      const sentBlocks = [...new Set(sent.map((t) => t.block_num))]
      const withdrawals = (
        await inBlocks<Row>(
          sentBlocks,
          (filter) =>
            `SELECT ${logColumns} FROM ${ds}.logs
             WHERE ${filter} AND address = X'${hexOf(WETH_ADDRESS)}' AND topic0 = X'${WITHDRAWAL_TOPIC}'`,
        )
      ).map(toLog)

      // gas_used is cumulative within a block, so a transaction's gas needs the one before it.
      const previousIndexes = [...new Set(sent.filter((t) => t.tx_index > 0).map((t) => t.tx_index - 1))].join(", ")
      const previousGas = previousIndexes
        ? await inBlocks<Row>(sentBlocks, (filter) => `SELECT block_num, tx_index, gas_used FROM ${ds}.transactions WHERE ${filter} AND tx_index IN (${previousIndexes})`)
        : []
      const baseFees = await inBlocks<Row>(sentBlocks, (filter) => `SELECT block_num, base_fee_per_gas FROM ${ds}.blocks WHERE ${filter}`)

      const { rows, gasUnknownTxs } = legRowsFromRaw({
        account: address,
        txs,
        logs,
        withdrawals,
        gas: {
          cumulativeGas: new Map(previousGas.map((g) => [`${asNumber(g.block_num)}:${asNumber(g.tx_index)}`, String(g.gas_used)])),
          baseFeeByBlock: new Map(baseFees.map((b) => [asNumber(b.block_num), decimalString(b.base_fee_per_gas) ?? "0"])),
        },
      })
      return { rows, priced: null, gasUnknownTxs }
    },
  }
}

const isMissingTable = (error: unknown) => /table .*not found|not found.*table|does not exist|unknown table/i.test(describeError(error))

/** Enough for the guards in market.ts, which only read the latest few. A busy pool repeats each trade per account. */
const MARKET_ROWS = 300

export function datasetSource(query: Query, config: { baseDataset: string; dataset: string; startBlock: number; network: string }): Source {
  const reader = datasetReader(query, config)
  const ds = `"${config.dataset}"`
  const base = `"${config.baseDataset}"`
  return {
    mode: "dataset",
    startBlock: config.startBlock,
    historyBlocks: null,
    readBalances: (address, block) => readBalancesAt(query, config.network, address, block),
    readNotes: (address, blocks) => readNotesAt(query, config.baseDataset, address, blocks),
    ...reader,

    async readWindow(address, from, to) {
      const window = await reader.readWindow(address, from, to)
      // `legs` doesn't say who was on the other side, so that comes from the raw tables, for only the blocks that matter.
      const me = hexOf(address)
      const topic = `X'${me.padStart(64, "0")}'`
      const allowlist = ERC20_ADDRESSES.map((a) => `X'${hexOf(a)}'`).join(", ")
      const logs: Pick<RawLog, "tx_hash" | "log_index" | "topic1" | "topic2">[] = []
      const txs: Pick<RawTx, "tx_hash" | "from" | "to">[] = []
      for (const { filter } of blockFilters(counterpartyBlocks(window.rows))) {
        const logRows = await query<Row>(`SELECT tx_hash, log_index, topic1, topic2 FROM ${base}.logs WHERE ${filter} AND topic0 = X'${TRANSFER_TOPIC}' AND address IN (${allowlist}) AND (topic1 = ${topic} OR topic2 = ${topic})`)
        logs.push(...logRows.map((l) => ({ tx_hash: prefixed(String(l.tx_hash)), log_index: asNumber(l.log_index), topic1: String(l.topic1), topic2: String(l.topic2) })))
        const txRows = await query<Row>(`SELECT tx_hash, "from", "to" FROM ${base}.transactions WHERE ${filter} AND ("from" = X'${me}' OR "to" = X'${me}') AND value <> '0'`)
        txs.push(...txRows.map((t) => ({ tx_hash: prefixed(String(t.tx_hash)), from: String(t.from), to: t.to == null ? null : String(t.to) })))
      }
      return { ...window, rows: withCounterparties(window.rows, logs, txs) }
    },

    async marketReady() {
      // Only a dataset with the fix for wrong `priced_legs` rows has this table. Asking it for no rows tells them apart.
      try {
        await query<Row>(`SELECT block_num FROM ${ds}.unlisted_moves WHERE block_num BETWEEN ${config.startBlock} AND ${config.startBlock} LIMIT 1`, 15_000)
        return true
      } catch (error) {
        if (isNotStarted(error)) return true
        if (isMissingTable(error)) return false
        throw error
      }
    },

    async readMarketTrades(asset, from, to) {
      const rows = await query<Row>(
        `SELECT block_num, tx_hash, sold_token, sold_amount, bought_token, bought_amount, priced, eth_usd FROM ${ds}.priced_legs
         WHERE block_num BETWEEN ${from} AND ${to} AND get_field(priced, 'token') = '${asset.replace(/[^A-Za-z0-9]/g, "")}'
         ORDER BY block_num DESC LIMIT ${MARKET_ROWS}`,
      ).catch((error: unknown) => {
        if (isNotStarted(error)) return []
        throw error
      })
      return marketTrades(
        rows.map((r) => ({
          block_num: asNumber(r.block_num),
          tx_hash: prefixed(String(r.tx_hash)),
          sold_token: prefixed(String(r.sold_token)),
          sold_amount: String(r.sold_amount ?? ""),
          bought_token: prefixed(String(r.bought_token)),
          bought_amount: String(r.bought_amount ?? ""),
          priced: r.priced as PricedRow["priced"],
          eth_usd: decimalString(r.eth_usd) ?? "",
        })),
      )
    },
  }
}
