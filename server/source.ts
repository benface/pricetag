// Where a wallet's rows come from: the Pricetag dataset when it's deployed, otherwise the raw Base dataset,
// read through the same shapes so everything after this file doesn't care which one it was.
//
// Every query is bounded by block, because staging is shared.

import type { Head, Mode } from "../src/core/api.ts"
import type { LegRow, PricedRow, ReferenceRow } from "../src/core/legs.ts"
import { ERC20_ADDRESSES, ETH_USD_FEED, USDC_USD_FEED, WETH_ADDRESS } from "../src/core/tokens.ts"
import { decimalString, type Query } from "./amp.ts"
import { DEPOSIT_TOPIC, TRANSFER_TOPIC, WITHDRAWAL_TOPIC, decodeRoundAnswer, legRowsFromRaw, type RawLog, type RawTx } from "./raw.ts"

export type WindowRows = { rows: LegRow[]; priced: PricedRow[] | null; gasUnknownTxs: string[] }

export type Source = {
  mode: Mode
  /** The first block a wallet's history can start from, or null to count back from the head. */
  startBlock: number | null
  historyBlocks: number | null
  head(after: number | null): Promise<Head | null>
  readWindow(address: string, from: number, to: number): Promise<WindowRows>
  readReferences(blocks: readonly number[]): Promise<ReferenceRow[]>
}

const hexOf = (address: string) => address.replace(/^0x/, "").toLowerCase()
const asNumber = (value: unknown) => Number(value)
const asIso = (value: unknown) => new Date(Number(value)).toISOString()
const prefixed = (hex: string) => `0x${hex}`

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

type Row = Record<string, unknown>

async function readHead(query: Query, dataset: string, after: number | null): Promise<Head | null> {
  const where = after === null ? "" : `WHERE block_num >= ${after}`
  const rows = await query<Row>(`SELECT block_num, timestamp FROM "${dataset}".blocks ${where} ORDER BY block_num DESC LIMIT 1`, 15_000)
  const row = rows[0]
  return row ? { blockNum: asNumber(row.block_num), timestamp: asIso(row.timestamp) } : null
}

export function rawSource(query: Query, config: { baseDataset: string; network: string; historyBlocks: number }): Source {
  const ds = `"${config.baseDataset}"`
  const allowlist = ERC20_ADDRESSES.map((a) => `X'${hexOf(a)}'`).join(", ")

  async function inBlocks<T>(blocks: readonly number[], sql: (filter: string, count: number) => string): Promise<T[]> {
    const result: T[] = []
    for (const { filter, count } of blockFilters(blocks)) result.push(...(await query<T>(sql(filter, count))))
    return result
  }

  return {
    mode: "raw",
    startBlock: null,
    historyBlocks: config.historyBlocks,
    head: (after) => readHead(query, config.baseDataset, after),

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
        data: String(l.data),
      })
      const logColumns = "block_num, timestamp, tx_hash, tx_index, log_index, address, topic0, topic1, topic2, data"
      const logs = (
        await query<Row>(
          `SELECT ${logColumns} FROM ${ds}.logs
           WHERE ${range} AND address IN (${allowlist}) AND topic3 IS NULL
             AND topic0 IN (X'${TRANSFER_TOPIC}', X'${DEPOSIT_TOPIC}', X'${WITHDRAWAL_TOPIC}')
             AND (topic1 = ${topic} OR topic2 = ${topic})`,
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

    // The filter sits in an inner subquery with a LIMIT, and the outer query reads no field of the result.
    // WORK-320 found the other shapes can run eth_call on every block on the chain.
    readReferences: (blocks) =>
      inBlocks<Row>(
        blocks,
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
      ),
  }
}

export function datasetSource(query: Query, config: { baseDataset: string; dataset: string; startBlock: number }): Source {
  const ds = `"${config.dataset}"`
  return {
    mode: "dataset",
    startBlock: config.startBlock,
    historyBlocks: null,
    head: (after) => readHead(query, config.baseDataset, after),

    async readWindow(address, from, to) {
      const me = hexOf(address)
      const range = `block_num BETWEEN ${from} AND ${to}`
      const legRows = await query<Row>(
        `SELECT block_num, timestamp, tx_hash, tx_index, log_index, token, account, side, amount, kind FROM ${ds}.legs WHERE ${range} AND account = X'${me}'`,
      )
      const pricedRows = await query<Row>(
        `SELECT block_num, tx_hash, account, sold_token, sold_amount, bought_token, bought_amount, priced FROM ${ds}.priced_legs WHERE ${range} AND account = X'${me}'`,
      )
      const rows = legRows.map((l): LegRow => ({
        block_num: asNumber(l.block_num),
        timestamp: asIso(l.timestamp),
        tx_hash: prefixed(String(l.tx_hash)),
        tx_index: asNumber(l.tx_index),
        log_index: asNumber(l.log_index),
        token: prefixed(String(l.token)),
        account: prefixed(String(l.account)),
        side: l.side as LegRow["side"],
        amount: String(l.amount),
        kind: l.kind as LegRow["kind"],
      }))
      return {
        // pt_gas leaves the amount empty when the gas can't be worked out, and BigInt can't read that.
        rows: rows.filter((r) => r.amount !== "" && r.amount !== "0"),
        gasUnknownTxs: rows.filter((r) => r.kind === "gas" && r.amount === "").map((r) => r.tx_hash),
        priced: pricedRows.map((p) => ({
          block_num: asNumber(p.block_num),
          tx_hash: prefixed(String(p.tx_hash)),
          account: prefixed(String(p.account)),
          sold_token: prefixed(String(p.sold_token)),
          sold_amount: String(p.sold_amount),
          bought_token: prefixed(String(p.bought_token)),
          bought_amount: String(p.bought_amount),
          priced: p.priced as PricedRow["priced"],
        })),
      }
    },

    async readReferences(blocks) {
      const result: ReferenceRow[] = []
      for (const { filter } of blockFilters(blocks)) {
        const rows = await query<Row>(`SELECT block_num, get_field(eth_round, 'c1') AS eth_usd, get_field(usdc_round, 'c1') AS usdc_usd FROM ${ds}.reference_prices WHERE ${filter}`)
        for (const r of rows) result.push({ block_num: asNumber(r.block_num), eth_usd: decimalString(r.eth_usd) ?? "", usdc_usd: decimalString(r.usdc_usd) ?? "" })
      }
      return result
    },
  }
}
