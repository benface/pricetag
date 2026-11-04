// Reads every allowlisted balance at a block with one `eth_call`, through Multicall3's `aggregate3`.
// Encoding is by hand because it's the only ABI this app writes, and it stays pure so a test can run it on real bytes.

import type { Query } from "./amp.ts"
import type { BalanceSnapshot } from "./reconcile.ts"
import { ETH_ADDRESS, TOKENS, normalizeAddress } from "./tokens.ts"

/** Deployed on Base, and long before any block this app reads. */
export const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11"

const AGGREGATE3 = "82ad56cb"
const BALANCE_OF = "70a08231"
const GET_ETH_BALANCE = "4d2301cc"
const WORD_BYTES = 32

const word = (value: bigint | number) => BigInt(value).toString(16).padStart(WORD_BYTES * 2, "0")
const addressWord = (address: string) => normalizeAddress(address).slice(2).padStart(WORD_BYTES * 2, "0")

/** Calldata for `aggregate3`, as hex with no prefix. Results come back in the order of `TOKENS`. */
export function encodeBalanceCalls(account: string): string {
  const calls = TOKENS.map((token) =>
    token.address === ETH_ADDRESS ? { target: MULTICALL3, selector: GET_ETH_BALANCE } : { target: token.address, selector: BALANCE_OF },
  )
  // Each call is its target, allowFailure, an offset, a length, and 36 bytes of calldata padded to 64.
  const callBytes = 3 * WORD_BYTES + WORD_BYTES + 2 * WORD_BYTES
  const offsets = calls.map((_, i) => word(calls.length * WORD_BYTES + i * callBytes)).join("")
  const bodies = calls
    .map(({ target, selector }) => addressWord(target) + word(1) + word(3 * WORD_BYTES) + word(4 + WORD_BYTES) + (selector + addressWord(account)).padEnd(2 * WORD_BYTES * 2, "0"))
    .join("")
  return AGGREGATE3 + word(WORD_BYTES) + word(calls.length) + offsets + bodies
}

/** One balance per call, null where that call failed. Null overall when the bytes aren't what `aggregate3` returns. */
export function decodeBalanceResults(data: string | null | undefined): (bigint | null)[] | null {
  if (!data) return null
  const wordAt = (byte: number): bigint | null => {
    const hex = data.slice(byte * 2, (byte + WORD_BYTES) * 2)
    return hex.length === WORD_BYTES * 2 ? BigInt(`0x${hex}`) : null
  }
  const list = wordAt(0)
  const count = list === null ? null : wordAt(Number(list))
  if (list === null || count !== BigInt(TOKENS.length)) return null
  const start = Number(list) + WORD_BYTES
  const results: (bigint | null)[] = []
  for (let i = 0; i < TOKENS.length; i++) {
    const offset = wordAt(start + i * WORD_BYTES)
    if (offset === null) return null
    const item = start + Number(offset)
    const success = wordAt(item)
    const length = wordAt(item + 2 * WORD_BYTES)
    if (success === null || length === null) return null
    results.push(success === 1n && length === BigInt(WORD_BYTES) ? wordAt(item + 3 * WORD_BYTES) : null)
  }
  return results
}

/** Calldata for Multicall3's `getEthBalance`, as hex with no prefix: plain ETH, without WETH. */
export const encodeEthBalanceCall = (account: string) => GET_ETH_BALANCE + addressWord(account)

/** The balance `encodeEthBalanceCall` asked for, or null when the bytes aren't one word. */
export function decodeEthBalance(data: string | null | undefined): string | null {
  return data && data.length === WORD_BYTES * 2 ? BigInt(`0x${data}`).toString() : null
}

/** Adds tokens up into their assets, so ETH is ETH plus WETH. An asset with any failed read is left out. */
export function balancesByAsset(results: readonly (bigint | null)[]): Record<string, string> {
  const totals = new Map<string, bigint | null>()
  TOKENS.forEach((token, i) => {
    const result = results[i] ?? null
    const total = totals.has(token.asset) ? (totals.get(token.asset) as bigint | null) : 0n
    totals.set(token.asset, total === null || result === null ? null : total + result)
  })
  return Object.fromEntries([...totals].flatMap(([asset, total]) => (total === null ? [] : [[asset, total.toString()]])))
}

/**
 * With no table in the query, this makes exactly one `eth_call`, and it can read a block no table has, like the one
 * before a local dataset's start.
 */
export async function readBalancesAt(query: Query, network: string, address: string, block: number): Promise<BalanceSnapshot | null> {
  const [row] = await query<Record<string, unknown>>(`SELECT rpc.${network}.eth_call(NULL, evm_encode_hex('${MULTICALL3}'), X'${encodeBalanceCalls(address)}', ${block}) AS r`)
  const results = decodeBalanceResults((row?.r as { data?: string } | null | undefined)?.data)
  return results && { blockNum: block, amounts: balancesByAsset(results) }
}
