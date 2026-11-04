// Reads one block's rows from Amp for `verify.ts`, and what a deposit's hash covers from an RPC.

import { asNumber, decimalString, hexOf, type Query, type Row } from "@pricetag/sdk/internal"
import { DEPOSIT_TX_TYPE, type AccessListEntry, type Authorization, type BlockRow, type DepositDetails, type LogRow, type TxRow } from "./verify.ts"

export type BlockData = { block: BlockRow; txs: TxRow[]; logs: LogRow[] }

const TX_COLUMNS = `tx_index, tx_hash, type, "from", "to", nonce, gas_limit, gas_price, max_fee_per_gas, max_priority_fee_per_gas, value, input, r, s, v_parity, chain_id, gas_used, status`

const text = (value: unknown) => (value == null ? null : String(value))
const decimal = (value: unknown) => decimalString(value) ?? "0"

function blockRow(row: Row): BlockRow {
  return {
    hash: String(row.hash),
    parent_hash: String(row.parent_hash),
    ommers_hash: String(row.ommers_hash),
    miner: String(row.miner),
    state_root: String(row.state_root),
    transactions_root: String(row.transactions_root),
    receipt_root: String(row.receipt_root),
    logs_bloom: String(row.logs_bloom),
    difficulty: decimal(row.difficulty),
    block_num: String(row.block_num),
    gas_limit: String(row.gas_limit),
    gas_used: String(row.gas_used),
    timestamp: String(Math.floor(asNumber(row.timestamp) / 1000)),
    extra_data: String(row.extra_data),
    mix_hash: String(row.mix_hash),
    nonce: String(row.nonce),
    base_fee_per_gas: decimalString(row.base_fee_per_gas),
    withdrawals_root: text(row.withdrawals_root),
    blob_gas_used: text(row.blob_gas_used),
    excess_blob_gas: text(row.excess_blob_gas),
    parent_beacon_root: text(row.parent_beacon_root),
    requests_hash: text(row.requests_hash),
  }
}

/**
 * Amp's client can't read list columns, so these come out one entry at a time with `unnest`. It drops an entry with no
 * keys from the second query, which is why the first says how many each has. Reading them out of order fails the check
 * rather than passing it, since the order is part of what's hashed.
 */
async function readAccessLists(query: Query, ds: string, blockNum: number): Promise<Map<number, AccessListEntry[]>> {
  const where = `WHERE block_num = ${blockNum} AND array_length(access_list) > 0`
  const entries = await query<Row>(`SELECT tx_index, get_field(unnest(access_list), 'address') AS address, array_length(get_field(unnest(access_list), 'storage_keys')) AS key_count FROM ${ds}.transactions ${where}`)
  const lists = new Map<number, AccessListEntry[]>()
  if (entries.length === 0) return lists
  const keys = await query<Row>(`SELECT tx_index, unnest(storage_keys) AS storage_key FROM (SELECT tx_index, get_field(unnest(access_list), 'storage_keys') AS storage_keys FROM ${ds}.transactions ${where})`)
  const keysByTx = new Map<number, string[]>()
  for (const row of keys) keysByTx.set(asNumber(row.tx_index), [...(keysByTx.get(asNumber(row.tx_index)) ?? []), String(row.storage_key)])
  for (const row of entries) {
    const txIndex = asNumber(row.tx_index)
    const remaining = keysByTx.get(txIndex) ?? []
    const storageKeys = remaining.splice(0, asNumber(row.key_count ?? 0))
    lists.set(txIndex, [...(lists.get(txIndex) ?? []), { address: String(row.address), storageKeys }])
  }
  return lists
}

async function readAuthorizations(query: Query, ds: string, blockNum: number): Promise<Map<number, Authorization[]>> {
  const field = (name: string) => `get_field(unnest(authorization_list), '${name}') AS ${name}`
  const rows = await query<Row>(
    `SELECT tx_index, ${["chain_id", "address", "nonce", "y_parity", "r", "s"].map(field).join(", ")} FROM ${ds}.transactions WHERE block_num = ${blockNum} AND array_length(authorization_list) > 0`,
  )
  const lists = new Map<number, Authorization[]>()
  for (const row of rows) {
    const txIndex = asNumber(row.tx_index)
    const authorization = { chainId: String(row.chain_id), address: String(row.address), nonce: String(row.nonce), yParity: Boolean(row.y_parity), r: String(row.r), s: String(row.s) }
    lists.set(txIndex, [...(lists.get(txIndex) ?? []), authorization])
  }
  return lists
}

/** A block's rows from the raw dataset, or null when Amp doesn't have the block. */
export async function readBlock(query: Query, baseDataset: string, blockNum: number): Promise<BlockData | null> {
  const ds = `"${baseDataset}"`
  const [block] = await query<Row>(`SELECT * FROM ${ds}.blocks WHERE block_num = ${blockNum}`)
  if (!block) return null
  const txRows = await query<Row>(`SELECT ${TX_COLUMNS} FROM ${ds}.transactions WHERE block_num = ${blockNum}`)
  const logRows = await query<Row>(`SELECT tx_index, log_index, address, topic0, topic1, topic2, topic3, data FROM ${ds}.logs WHERE block_num = ${blockNum}`)
  const accessLists = await readAccessLists(query, ds, blockNum)
  const authorizations = await readAuthorizations(query, ds, blockNum)

  const txs: TxRow[] = txRows
    .map((t) => ({
      tx_index: asNumber(t.tx_index),
      tx_hash: String(t.tx_hash),
      type: asNumber(t.type),
      from: String(t.from),
      to: text(t.to),
      nonce: String(t.nonce),
      gas_limit: String(t.gas_limit),
      gas_price: decimalString(t.gas_price),
      max_fee_per_gas: decimalString(t.max_fee_per_gas),
      max_priority_fee_per_gas: decimalString(t.max_priority_fee_per_gas),
      value: String(t.value),
      input: String(t.input),
      r: String(t.r),
      s: String(t.s),
      v_parity: Boolean(t.v_parity),
      chain_id: text(t.chain_id),
      gas_used: String(t.gas_used),
      status: Boolean(t.status),
      accessList: accessLists.get(asNumber(t.tx_index)) ?? [],
      authorizationList: authorizations.get(asNumber(t.tx_index)) ?? [],
    }))
    .sort((a, b) => a.tx_index - b.tx_index)
  const logs: LogRow[] = logRows
    .map((l) => ({
      tx_index: asNumber(l.tx_index),
      log_index: asNumber(l.log_index),
      address: String(l.address),
      topics: [l.topic0, l.topic1, l.topic2, l.topic3].filter((topic) => topic != null).map(String),
      data: String(l.data),
    }))
    .sort((a, b) => a.log_index - b.log_index)
  return { block: blockRow(block), txs, logs }
}

export type ReadDeposits = (txHashes: readonly string[]) => Promise<Map<string, DepositDetails> | null>

const TIMEOUT_MS = 15_000
const RETRIES = 3
const PAUSE_AFTER_429_MS = 1_000

type DepositResult = { id: number; result?: { sourceHash?: string; mint?: string; isSystemTx?: boolean } | null }

/** What each deposit's hash covers and Amp doesn't store, or null unless every one was read. */
export function createDepositReader(url: string, send: typeof fetch = fetch, pauseAfter429Ms = PAUSE_AFTER_429_MS): ReadDeposits {
  return async (txHashes) => {
    if (txHashes.length === 0) return new Map()
    try {
      const body = JSON.stringify(txHashes.map((hash, id) => ({ jsonrpc: "2.0", id, method: "eth_getTransactionByHash", params: [`0x${hexOf(hash)}`] })))
      const post = () => send(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(TIMEOUT_MS) })
      let response = await post()
      for (let retry = 0; response.status === 429 && retry < RETRIES; retry++) {
        await new Promise((resolve) => setTimeout(resolve, pauseAfter429Ms))
        response = await post()
      }
      if (!response.ok) throw new Error(`status ${response.status}`)
      const results = (await response.json()) as DepositResult[]
      const deposits = new Map<string, DepositDetails>()
      for (const { id, result } of results) {
        const hash = txHashes[id]
        if (hash && result?.sourceHash) deposits.set(hash, { sourceHash: result.sourceHash, mint: result.mint ?? "0x0", isSystemTx: result.isSystemTx === true })
      }
      return deposits.size === txHashes.length ? deposits : null
    } catch (error) {
      // Not the URL: a dedicated RPC's has a key in it.
      console.error("Couldn't read deposits:", error instanceof Error ? error.message : "unknown error")
      return null
    }
  }
}

export const depositHashes = (txs: readonly TxRow[]) => txs.filter((tx) => tx.type === DEPOSIT_TX_TYPE).map((tx) => tx.tx_hash)
