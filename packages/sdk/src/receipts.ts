// Reads L1 data fees from RPC receipts, because Amp's data doesn't have them. They only exist on receipts, and every
// Base transaction pays one on top of its gas, so computed ETH can't match the chain without them.

import type { Logger } from "./amp.ts"

export const DEFAULT_RPC_URL = "https://mainnet.base.org"

/** An RPC answered, but not with what was asked for. Only this code writes its message, so it's safe to log. */
export class RpcAnswerError extends Error {}

/** What to log when an RPC read fails. Other errors only give their name, because `fetch`'s messages can quote the URL, and a dedicated RPC's has a key in it. */
export const describeRpcError = (error: unknown) => (error instanceof RpcAnswerError ? error.message : error instanceof Error ? error.name : "unknown error")

/** Which transactions to read, with the block each was seen in. */
export type FeeRequest = { txHash: string; blockNum: number }
/** L1 fees in wei by transaction hash. A transaction with no answer yet isn't in it. */
export type ReadL1Fees = (requests: readonly FeeRequest[]) => Promise<Map<string, string>>

const BATCH = 5
// The public RPC allows 25 calls a second per IP, counting each one in a batch, and a local Amp's relay can be using
// most of that. So this is slow on purpose, and it waits out a 429 before giving up until the next refresh.
const PAUSE_MS = 500
const PAUSE_AFTER_429_MS = 1_000
const RETRIES = 3
/** A busy wallet catches up over a few refreshes, and until then its ETH says it isn't checked yet. */
const MAX_PER_READ = 200
const TIMEOUT_MS = 15_000

type Receipt = { blockNumber?: string; l1Fee?: string } | null
type RpcResult = { id: number; result?: Receipt }

/** A receipt from another block means a reorg or a lagging RPC, so its fee isn't this transaction's yet. */
export function l1FeeOf(receipt: Receipt | undefined, blockNum: number): string | null {
  if (!receipt?.blockNumber || Number(receipt.blockNumber) !== blockNum) return null
  // Deposits have no L1 fee at all, and their field can be missing.
  return receipt.l1Fee ? BigInt(receipt.l1Fee).toString() : "0"
}

export function createL1FeeReader(url: string, send: typeof fetch = fetch, pauseAfter429Ms = PAUSE_AFTER_429_MS, logger: Logger = console): ReadL1Fees {
  return async (requests) => {
    const fees = new Map<string, string>()
    const wanted = requests.slice(0, MAX_PER_READ)
    for (let i = 0; i < wanted.length; i += BATCH) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, PAUSE_MS))
      const batch = wanted.slice(i, i + BATCH)
      try {
        const body = JSON.stringify(batch.map(({ txHash }, id) => ({ jsonrpc: "2.0", id, method: "eth_getTransactionReceipt", params: [txHash] })))
        const post = () => send(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(TIMEOUT_MS) })
        let response = await post()
        for (let retry = 0; response.status === 429 && retry < RETRIES; retry++) {
          await new Promise((resolve) => setTimeout(resolve, pauseAfter429Ms))
          response = await post()
        }
        if (!response.ok) throw new RpcAnswerError(`status ${response.status}`)
        const results = (await response.json()) as RpcResult[]
        for (const { id, result } of results) {
          const request = batch[id]
          const fee = request ? l1FeeOf(result, request.blockNum) : null
          if (request && fee !== null) fees.set(request.txHash, fee)
        }
      } catch (error) {
        // What's missing is retried on the next refresh.
        logger.warn(`Couldn't read L1 fees: ${describeRpcError(error)}`)
        break
      }
    }
    return fees
  }
}
