// Recomputes a Base block's commitments from the rows Amp returns, the way Amp's verification does (its docs/feat/verification.md).
// `ampctl verify` can't do this on Base: every block starts with an OP Stack deposit, and it rejects that transaction type.
//
// Pure, so it can run on fixtures. Valid for blocks since Canyon (January 2024).
// Keccak comes from @noble/hashes, because Node's depends on how it was built: 26.13.0 has it, and 26.8.1 and 22 don't.

import { secp256k1 } from "@noble/curves/secp256k1"
import { keccak_256 } from "@noble/hashes/sha3"

export type BlockRow = {
  hash: string
  parent_hash: string
  ommers_hash: string
  miner: string
  state_root: string
  transactions_root: string
  receipt_root: string
  logs_bloom: string
  difficulty: string
  block_num: string
  gas_limit: string
  gas_used: string
  /** In seconds. */
  timestamp: string
  extra_data: string
  mix_hash: string
  nonce: string
  base_fee_per_gas: string | null
  withdrawals_root: string | null
  blob_gas_used: string | null
  excess_blob_gas: string | null
  parent_beacon_root: string | null
  requests_hash: string | null
}

export type AccessListEntry = { address: string; storageKeys: string[] }
export type Authorization = { chainId: string; address: string; nonce: string; yParity: boolean; r: string; s: string }

export type TxRow = {
  tx_index: number
  tx_hash: string
  type: number
  from: string
  to: string | null
  nonce: string
  gas_limit: string
  gas_price: string | null
  max_fee_per_gas: string | null
  max_priority_fee_per_gas: string | null
  value: string
  input: string
  r: string
  s: string
  v_parity: boolean
  chain_id: string | null
  /** Cumulative within the block, like a receipt's `cumulativeGasUsed`, despite the name. */
  gas_used: string
  status: boolean
  accessList: AccessListEntry[]
  authorizationList: Authorization[]
}

export type LogRow = {
  tx_index: number
  log_index: number
  address: string
  topics: string[]
  data: string
}

/** What a deposit's hash covers and Amp doesn't store. */
export type DepositDetails = { sourceHash: string; mint: string; isSystemTx: boolean }

export const DEPOSIT_TX_TYPE = 126

/** Transactions with this type aren't on Base, or aren't read here. Hitting one means the check can't finish, not that it failed. */
export class UnreadableTransaction extends Error {}

type Rlp = Uint8Array | readonly Rlp[] | { encoded: Uint8Array }

const bytes = (hex: string | null | undefined) => Buffer.from((hex ?? "").replace(/^0x/, ""), "hex")

/** The minimal big-endian form RLP wants for a number, where zero is empty. */
function int(value: string | number | bigint | boolean | null | undefined): Uint8Array {
  const n = BigInt(value ?? 0)
  if (n === 0n) return Buffer.alloc(0)
  const hex = n.toString(16)
  return Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex")
}

/** A 32-byte value read as a number, as a signature's `r` and `s` are. */
const scalar = (hex: string) => int(`0x${hex.replace(/^0x/, "") || "0"}`)

const lengthPrefix = (length: number, offset: number) => {
  if (length < 56) return Buffer.from([offset + length])
  const size = int(length)
  return Buffer.concat([Buffer.from([offset + 55 + size.length]), size])
}

export function rlp(item: Rlp): Buffer {
  if ("encoded" in item) return Buffer.from(item.encoded)
  if (item instanceof Uint8Array) {
    if (item.length === 1 && (item[0] as number) < 0x80) return Buffer.from(item)
    return Buffer.concat([lengthPrefix(item.length, 0x80), item])
  }
  const payload = Buffer.concat((item as readonly Rlp[]).map(rlp))
  return Buffer.concat([lengthPrefix(payload.length, 0xc0), payload])
}

export const keccak = (data: Uint8Array) => Buffer.from(keccak_256(data))

const toHex = (data: Uint8Array) => Buffer.from(data).toString("hex")

type TrieEntry = { nibbles: number[]; value: Uint8Array }

const nibblesOf = (key: Uint8Array) => [...key].flatMap((byte) => [byte >> 4, byte & 0xf])

/** The path of a leaf or extension, with its flag and whether it's odd in the first nibble. */
function compactPath(nibbles: readonly number[], isLeaf: boolean): Uint8Array {
  const flag = (isLeaf ? 2 : 0) + nibbles.length % 2
  const all = nibbles.length % 2 ? [flag, ...nibbles] : [flag, 0, ...nibbles]
  const out = Buffer.alloc(all.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = ((all[2 * i] as number) << 4) | (all[2 * i + 1] as number)
  return out
}

/** A node goes inside its parent when it's shorter than a hash, so it's the node's encoding here, not a hash. */
const reference = (node: Buffer): Rlp => (node.length < 32 ? { encoded: node } : keccak(node))

function trieNode(entries: readonly TrieEntry[], depth: number): Buffer {
  const [first] = entries as [TrieEntry]
  if (entries.length === 1) return rlp([compactPath(first.nibbles.slice(depth), true), first.value])

  let shared = 0
  while (entries.every((entry) => entry.nibbles.length > depth + shared && entry.nibbles[depth + shared] === first.nibbles[depth + shared])) shared++
  if (shared > 0) return rlp([compactPath(first.nibbles.slice(depth, depth + shared), false), reference(trieNode(entries, depth + shared))])

  const branch: Rlp[] = []
  for (let nibble = 0; nibble < 16; nibble++) {
    const below = entries.filter((entry) => entry.nibbles[depth] === nibble)
    branch.push(below.length > 0 ? reference(trieNode(below, depth + 1)) : Buffer.alloc(0))
  }
  branch.push(entries.find((entry) => entry.nibbles.length === depth)?.value ?? Buffer.alloc(0))
  return rlp(branch)
}

/** The root of a Merkle Patricia trie, as Ethereum commits to a block's transactions and receipts. */
export function trieRoot(entries: readonly (readonly [key: Uint8Array, value: Uint8Array])[]): string {
  if (entries.length === 0) return toHex(keccak(rlp(Buffer.alloc(0))))
  return toHex(keccak(trieNode(entries.map(([key, value]) => ({ nibbles: nibblesOf(key), value })), 0)))
}

/** A block's transactions or receipts, keyed by position. */
const orderedRoot = (values: readonly Uint8Array[]) => trieRoot(values.map((value, index) => [rlp(int(index)), value] as const))

export function headerHash(block: BlockRow): string {
  const nonce = Buffer.alloc(8)
  nonce.writeBigUInt64BE(BigInt(block.nonce))
  const fields: Rlp[] = [
    bytes(block.parent_hash),
    bytes(block.ommers_hash),
    bytes(block.miner),
    bytes(block.state_root),
    bytes(block.transactions_root),
    bytes(block.receipt_root),
    bytes(block.logs_bloom),
    int(block.difficulty),
    int(block.block_num),
    int(block.gas_limit),
    int(block.gas_used),
    int(block.timestamp),
    bytes(block.extra_data),
    bytes(block.mix_hash),
    nonce,
  ]
  // Each fork adds fields on the end, so a block has them up to the last one it knows about. A gap can't be real, and hashes wrong.
  const optional: readonly (readonly [string | null, Rlp])[] = [
    [block.base_fee_per_gas, int(block.base_fee_per_gas)],
    [block.withdrawals_root, bytes(block.withdrawals_root)],
    [block.blob_gas_used, int(block.blob_gas_used)],
    [block.excess_blob_gas, int(block.excess_blob_gas)],
    [block.parent_beacon_root, bytes(block.parent_beacon_root)],
    [block.requests_hash, bytes(block.requests_hash)],
  ]
  const last = optional.findLastIndex(([value]) => value !== null)
  fields.push(...optional.slice(0, last + 1).map(([, encoded]) => encoded))
  return toHex(keccak(rlp(fields)))
}

const accessListOf = (tx: TxRow): Rlp => tx.accessList.map(({ address, storageKeys }) => [bytes(address), storageKeys.map(bytes)])

/** What a transaction's sender signs, in the order its encoding has them. A deposit isn't signed. */
function signedFields(tx: TxRow): Rlp[] {
  const to = bytes(tx.to)
  const fees = [int(tx.max_priority_fee_per_gas), int(tx.max_fee_per_gas), int(tx.gas_limit), to, int(tx.value), bytes(tx.input), accessListOf(tx)]
  switch (tx.type) {
    case 0:
      return [int(tx.nonce), int(tx.gas_price), int(tx.gas_limit), to, int(tx.value), bytes(tx.input)]
    case 1:
      return [int(tx.chain_id), int(tx.nonce), int(tx.gas_price), int(tx.gas_limit), to, int(tx.value), bytes(tx.input), accessListOf(tx)]
    case 2:
      return [int(tx.chain_id), int(tx.nonce), ...fees]
    case 4: {
      const authorizations = tx.authorizationList.map((a) => [int(a.chainId), bytes(a.address), int(a.nonce), int(a.yParity), scalar(a.r), scalar(a.s)])
      return [int(tx.chain_id), int(tx.nonce), ...fees, authorizations]
    }
    default:
      throw new UnreadableTransaction(`Transaction type ${tx.type} can't be read.`)
  }
}

/** A transaction as the block's trie holds it, whose hash is the transaction's hash. */
export function encodeTransaction(tx: TxRow, deposit: DepositDetails | undefined): Buffer {
  if (tx.type === DEPOSIT_TX_TYPE) {
    if (!deposit) throw new UnreadableTransaction("A deposit's details are missing.")
    return Buffer.concat([Buffer.from([DEPOSIT_TX_TYPE]), rlp([bytes(deposit.sourceHash), bytes(tx.from), bytes(tx.to), int(deposit.mint), int(tx.value), int(tx.gas_limit), int(deposit.isSystemTx), bytes(tx.input)])])
  }
  const fields = signedFields(tx)
  if (tx.type === 0) {
    const v = tx.chain_id === null ? 27n + BigInt(tx.v_parity) : 35n + 2n * BigInt(tx.chain_id) + BigInt(tx.v_parity)
    return rlp([...fields, int(v), scalar(tx.r), scalar(tx.s)])
  }
  return Buffer.concat([Buffer.from([tx.type]), rlp([...fields, int(tx.v_parity), scalar(tx.r), scalar(tx.s)])])
}

/** The address a transaction's signature recovers to, or null when it recovers to none. Only reads public data: a signature and what it signed. */
export function recoverSender(tx: TxRow): string | null {
  const fields = signedFields(tx)
  // A legacy transaction with a chain signs that chain followed by two blanks, where its signature will go.
  const signed = tx.type !== 0 ? Buffer.concat([Buffer.from([tx.type]), rlp(fields)]) : rlp(tx.chain_id === null ? fields : [...fields, int(tx.chain_id), int(0), int(0)])
  try {
    const signature = new secp256k1.Signature(BigInt(`0x${tx.r.replace(/^0x/, "")}`), BigInt(`0x${tx.s.replace(/^0x/, "")}`)).addRecoveryBit(Number(tx.v_parity))
    return toHex(keccak(signature.recoverPublicKey(keccak(signed)).toRawBytes(false).subarray(1))).slice(24)
  } catch {
    return null
  }
}

/** The 2048 bits a receipt commits to for its logs. */
function bloomOf(logs: readonly LogRow[]): Buffer {
  const bloom = Buffer.alloc(256)
  const add = (item: Uint8Array) => {
    const hash = keccak(item)
    for (let i = 0; i < 6; i += 2) {
      const bit = (((hash[i] as number) << 8) | (hash[i + 1] as number)) & 2047
      bloom[255 - (bit >> 3)]! |= 1 << (bit & 7)
    }
  }
  for (const log of logs) {
    add(bytes(log.address))
    for (const topic of log.topics) add(bytes(topic))
  }
  return bloom
}

/** A transaction's result as the block's trie holds it. A deposit's also commits to its nonce, and a version, which is 1 since Canyon. */
export function encodeReceipt(tx: TxRow, logs: readonly LogRow[]): Buffer {
  const fields: Rlp[] = [
    int(tx.status),
    int(tx.gas_used),
    bloomOf(logs),
    logs.map((log) => [bytes(log.address), log.topics.map(bytes), bytes(log.data)]),
  ]
  if (tx.type === DEPOSIT_TX_TYPE) fields.push(int(tx.nonce), int(1))
  const body = rlp(fields)
  return tx.type === 0 ? body : Buffer.concat([Buffer.from([tx.type]), body])
}

export type Commitment = { status: "passed" } | { status: "failed"; computed: string; expected: string } | { status: "failed"; reason: string } | { status: "unchecked"; reason: string }

const compare = (computed: string, expected: string): Commitment => (computed === expected ? { status: "passed" } : { status: "failed", computed, expected })

export function checkHeader(block: BlockRow): Commitment {
  return compare(headerHash(block), block.hash)
}

export function checkTransactions(block: BlockRow, txs: readonly TxRow[], deposits: ReadonlyMap<string, DepositDetails> | null): Commitment {
  // A transaction's position is what the trie commits to, and what its logs and the activity check find it by.
  const misplaced = txs.findIndex((tx, i) => tx.tx_index !== i)
  if (misplaced >= 0) return { status: "failed", reason: `The transaction stored at position ${misplaced} says it's at position ${(txs[misplaced] as TxRow).tx_index}.` }
  if (deposits === null && txs.some((tx) => tx.type === DEPOSIT_TX_TYPE)) return { status: "unchecked", reason: "Amp doesn't store everything a deposit's hash covers, and Base's node didn't answer." }
  try {
    const encoded = txs.map((tx) => encodeTransaction(tx, deposits?.get(tx.tx_hash)))
    const wrongHash = txs.findIndex((tx, i) => toHex(keccak(encoded[i] as Buffer)) !== tx.tx_hash)
    if (wrongHash >= 0) return { status: "failed", computed: toHex(keccak(encoded[wrongHash] as Buffer)), expected: (txs[wrongHash] as TxRow).tx_hash }
    return compare(orderedRoot(encoded), block.transactions_root)
  } catch (error) {
    if (error instanceof UnreadableTransaction) return { status: "unchecked", reason: error.message }
    throw error
  }
}

export function checkReceipts(block: BlockRow, txs: readonly TxRow[], logs: readonly LogRow[]): Commitment {
  const logsByTx = new Map<number, LogRow[]>(txs.map((tx) => [tx.tx_index, []]))
  // Every log counted has to be in what's hashed, and a log's number is only as good as its place in the block.
  for (const [position, log] of logs.entries()) {
    const list = logsByTx.get(log.tx_index)
    if (!list) return { status: "failed", reason: `Log #${log.log_index} says it's from a transaction this block doesn't have.` }
    if (log.log_index !== position) return { status: "failed", reason: `The log stored at position ${position} says it's #${log.log_index}.` }
    if (log.tx_index < (logs[position - 1]?.tx_index ?? 0)) return { status: "failed", reason: `Log #${log.log_index} is out of order.` }
    list.push(log)
  }
  return compare(orderedRoot(txs.map((tx) => encodeReceipt(tx, logsByTx.get(tx.tx_index) as LogRow[]))), block.receipt_root)
}

/** That the stored sender is who signed. A deposit isn't signed, and its hash covers its sender instead, which `checkTransactions` compares. */
export function checkSender(tx: TxRow): Commitment {
  if (tx.type === DEPOSIT_TX_TYPE) return { status: "passed" }
  try {
    const signer = recoverSender(tx)
    const stored = toHex(bytes(tx.from))
    if (signer === null) return { status: "failed", reason: "This transaction's signature doesn't work out to any address." }
    return signer === stored ? { status: "passed" } : { status: "failed", reason: `The signature says 0x${signer} sent this transaction, but Amp stored 0x${stored}.` }
  } catch (error) {
    if (error instanceof UnreadableTransaction) return { status: "unchecked", reason: error.message }
    throw error
  }
}
