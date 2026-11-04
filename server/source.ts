// Where a wallet's rows come from: the Pricetag dataset when it's deployed, otherwise the raw Base dataset,
// read through the same shapes so everything after this file doesn't care which one it was.
//
// Every query is bounded by block, because staging is shared.

import { ETH_USD_FEED, USDC_USD_FEED, WETH_ADDRESS, asIso, asNumber, blockFilters, datasetReader, decimalString, hexOf, prefixed, readHead, type GasUnknownTx, type LegRow, type PricedRow, type Query, type ReferenceRow, type Row, type BalanceSnapshot } from "@pricetag/sdk"
import type { Head, Mode } from "../src/core/api.ts"
import type { RateRound } from "../src/core/currency.ts"
import { MULTICALL3, balancesByAsset, decodeBalanceResults, decodeEthBalance, encodeBalanceCalls, encodeEthBalanceCall } from "./balances.ts"
import { DEPOSIT_TOPIC, TRANSFER_BATCH_TOPIC, TRANSFER_SINGLE_TOPIC, TRANSFER_TOPIC, WITHDRAWAL_TOPIC, decodeRound, decodeRoundAnswer, legRowsFromRaw, type RawLog, type RawTx } from "./raw.ts"

export type WindowRows = { rows: LegRow[]; priced: PricedRow[] | null; gasUnknown: GasUnknownTx[] }

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
  /** This wallet's plain ETH at the end of each block, not counting WETH. A block whose read failed isn't in it. */
  readEthBalances(address: string, blocks: readonly number[]): Promise<Map<number, string>>
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

/**
 * One query per 200 blocks, in the shape `readReferences` explains. A block the table doesn't have, like the one before a
 * local dataset's start, is read on its own.
 */
async function readEthBalancesAt(query: Query, network: string, baseDataset: string, address: string, blocks: readonly number[]): Promise<Map<number, string>> {
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
    readEthBalances: (address, blocks) => readEthBalancesAt(query, config.network, config.baseDataset, address, blocks),

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

      const { rows, gasUnknown } = legRowsFromRaw({
        account: address,
        txs,
        logs,
        withdrawals,
        gas: {
          cumulativeGas: new Map(previousGas.map((g) => [`${asNumber(g.block_num)}:${asNumber(g.tx_index)}`, String(g.gas_used)])),
          baseFeeByBlock: new Map(baseFees.map((b) => [asNumber(b.block_num), decimalString(b.base_fee_per_gas) ?? "0"])),
        },
      })
      return { rows, priced: null, gasUnknown }
    },
  }
}

export function datasetSource(query: Query, config: { baseDataset: string; dataset: string; priceDataset?: string; startBlock: number; network: string }): Source {
  return {
    mode: "dataset",
    startBlock: config.startBlock,
    historyBlocks: null,
    readBalances: (address, block) => readBalancesAt(query, config.network, address, block),
    readEthBalances: (address, blocks) => readEthBalancesAt(query, config.network, config.baseDataset, address, blocks),
    ...datasetReader(query, config),
  }
}
