// Builds rows in the `legs` shape from raw `transactions` and `logs` rows, the same way the dataset's tables do.
// Pure, so it can be tested without Amp.

import { ETH_ADDRESS, WETH_ADDRESS, normalizeAddress, tokenByAddress, type GasUnknownTx, type LegRow } from "@pricetag/sdk/core"

export const TRANSFER_TOPIC = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
export const DEPOSIT_TOPIC = "e1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c"
export const WITHDRAWAL_TOPIC = "7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65"
export const TRANSFER_SINGLE_TOPIC = "c3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62"
export const TRANSFER_BATCH_TOPIC = "4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb"
export const ANSWER_UPDATED_TOPIC = "0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f"

/** OP Stack deposits are paid for on L1, so they cost no L2 gas. */
const DEPOSIT_TX_TYPE = 126

export type RawTx = {
  block_num: number
  timestamp: string
  tx_hash: string
  tx_index: number
  from: string
  to: string | null
  value: string
  /** Cumulative within the block, like a receipt's `cumulativeGasUsed`, despite the name. */
  gas_used: string
  /** Null on type 2 transactions. */
  gas_price: string | null
  max_fee_per_gas: string | null
  max_priority_fee_per_gas: string | null
  status: boolean
  type: number
}

export type RawLog = {
  block_num: number
  timestamp: string
  tx_hash: string
  tx_index: number
  log_index: number
  address: string
  topic0: string
  topic1: string | null
  topic2: string | null
  topic3: string | null
  data: string
}

export type GasContext = {
  /** Cumulative gas by `${block}:${txIndex}`. */
  cumulativeGas: ReadonlyMap<string, string>
  baseFeeByBlock: ReadonlyMap<number, string>
}

const topicToAddress = (topic: string | null) => normalizeAddress((topic ?? "").slice(-40).padStart(40, "0"))

export function effectiveGasPrice(tx: Pick<RawTx, "gas_price" | "max_fee_per_gas" | "max_priority_fee_per_gas">, baseFee: string | undefined): bigint | null {
  if (tx.gas_price !== null) return BigInt(tx.gas_price)
  if (baseFee === undefined || tx.max_fee_per_gas === null || tx.max_priority_fee_per_gas === null) return null
  const tipped = BigInt(baseFee) + BigInt(tx.max_priority_fee_per_gas)
  const cap = BigInt(tx.max_fee_per_gas)
  return tipped < cap ? tipped : cap
}

/** Gas paid in wei, or null when it can't be worked out. L1 data fees aren't in Amp's data, so they aren't in this. */
export function gasPaid(tx: RawTx, context: GasContext): bigint | null {
  const price = effectiveGasPrice(tx, context.baseFeeByBlock.get(tx.block_num))
  const previous = tx.tx_index === 0 ? "0" : context.cumulativeGas.get(`${tx.block_num}:${tx.tx_index - 1}`)
  if (price === null || previous === undefined) return null
  return (BigInt(tx.gas_used) - BigInt(previous)) * price
}

export type RawInput = {
  account: string
  /** Transactions the account sent or was the direct recipient of. */
  txs: readonly RawTx[]
  /** `Transfer`, `Deposit`, `Withdrawal` and ERC-1155 logs naming the account, for any token. */
  logs: readonly RawLog[]
  /** WETH `Withdrawal` logs in transactions the account sent, whoever `src` is. */
  withdrawals: readonly RawLog[]
  gas: GasContext
}

export function legRowsFromRaw({ account, txs, logs, withdrawals, gas }: RawInput): { rows: LegRow[]; gasUnknown: GasUnknownTx[] } {
  const me = normalizeAddress(account)
  const rows: LegRow[] = []
  const gasUnknown: GasUnknownTx[] = []

  for (const tx of txs) {
    const base = { block_num: tx.block_num, timestamp: tx.timestamp, tx_hash: normalizeAddress(tx.tx_hash), tx_index: tx.tx_index }
    const from = normalizeAddress(tx.from)
    if (from === me && tx.type !== DEPOSIT_TX_TYPE) {
      const paid = gasPaid(tx, gas)
      if (paid === null) gasUnknown.push({ tx_hash: base.tx_hash, block_num: base.block_num })
      else if (paid > 0n) rows.push({ ...base, log_index: 0, token: ETH_ADDRESS, account: me, side: "debit", amount: paid.toString(), kind: "gas" })
    }
    if (tx.status && BigInt(tx.value) > 0n) {
      const eth = { ...base, log_index: 0, token: ETH_ADDRESS, account: me, amount: tx.value, kind: "eth" as const }
      if (from === me) rows.push({ ...eth, side: "debit", counterparty: tx.to === null ? null : normalizeAddress(tx.to) })
      if (tx.to !== null && normalizeAddress(tx.to) === me) rows.push({ ...eth, side: "credit", counterparty: from })
    }
  }

  for (const log of logs) {
    const address = normalizeAddress(log.address)
    const listed = tokenByAddress(address) !== undefined
    const first = topicToAddress(log.topic1)
    const base = {
      block_num: log.block_num,
      timestamp: log.timestamp,
      tx_hash: normalizeAddress(log.tx_hash),
      tx_index: log.tx_index,
      log_index: log.log_index,
      token: address,
      account: me,
      amount: BigInt(`0x${log.data.slice(0, 64) || "0"}`).toString(),
    }
    if (log.topic0 === TRANSFER_TOPIC) {
      if (listed && log.topic3 !== null) continue
      // An ERC-721 transfer has its token ID in topic3, where an ERC-20's amount is in its data.
      const nftId = log.topic3 === null ? null : BigInt(`0x${log.topic3}`).toString()
      const row = nftId !== null ? { ...base, amount: nftId, kind: "unlisted_nft" as const } : { ...base, kind: listed ? ("erc20" as const) : ("unlisted" as const) }
      if (first === me) rows.push({ ...row, side: "debit", counterparty: topicToAddress(log.topic2) })
      if (topicToAddress(log.topic2) === me) rows.push({ ...row, side: "credit", counterparty: first })
    } else if (log.topic0 === TRANSFER_SINGLE_TOPIC || log.topic0 === TRANSFER_BATCH_TOPIC) {
      // A batch can hold many IDs and amounts, so an empty amount just says something moved. That's all the guard needs.
      const row = { ...base, amount: "", kind: "unlisted" as const }
      if (topicToAddress(log.topic2) === me) rows.push({ ...row, side: "debit" })
      if (topicToAddress(log.topic3) === me) rows.push({ ...row, side: "credit" })
    } else if (address !== WETH_ADDRESS) {
      continue
    } else if (log.topic0 === DEPOSIT_TOPIC && first === me) {
      rows.push({ ...base, side: "credit", kind: "wrap" })
    } else if (log.topic0 === WITHDRAWAL_TOPIC && first === me) {
      rows.push({ ...base, side: "debit", kind: "unwrap" })
    }
  }

  // Without traces, a WETH Withdrawal in a transaction counts as ETH paid to its sender. `settleUnwraps` checks it.
  const sentByMe = new Set(txs.filter((t) => normalizeAddress(t.from) === me).map((t) => normalizeAddress(t.tx_hash)))
  for (const log of withdrawals) {
    const hash = normalizeAddress(log.tx_hash)
    if (!sentByMe.has(hash) || normalizeAddress(log.address) !== WETH_ADDRESS) continue
    rows.push({
      block_num: log.block_num,
      timestamp: log.timestamp,
      tx_hash: hash,
      tx_index: log.tx_index,
      log_index: log.log_index,
      token: ETH_ADDRESS,
      account: me,
      side: "credit",
      amount: BigInt(`0x${log.data.slice(0, 64) || "0"}`).toString(),
      kind: "unwrap",
    })
  }
  return { rows, gasUnknown }
}
