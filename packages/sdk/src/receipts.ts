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

// The public RPC allows 25 calls a second per IP, counting each one in a batch. A local Amp's relay needs about 10 of
// them just to follow the head, so the two split a limit: fees get 40%, the relay the rest. So this is slow on purpose,
// and it waits out a 429 before giving up until the next refresh. A faster RPC says so with its rate limit.
export const DEFAULT_RPC_RATE_LIMIT = 25
const L1_FEE_SHARE = 0.4
const MAX_BATCH = 25
const PAUSE_AFTER_429_MS = 1_000
const RETRIES = 3
/** A busy wallet catches up over a few refreshes, and until then its ETH says it isn't checked yet. */
const SECONDS_PER_READ = 20
const TIMEOUT_MS = 15_000

/** Calls a second a local Amp's relay can send to an RPC that allows `rateLimit`, which is what L1 fees leave of it. */
export const relayRate = (rateLimit: number) => rateLimit * (1 - L1_FEE_SHARE)

/**
 * How to stay under the fees' share of `rateLimit`: at the default, 5 receipts every 500 ms, and at most 200 in a read.
 * A whole number of batches fits in each second, so no second of it can hold an extra one.
 */
export function l1FeePace(rateLimit: number = DEFAULT_RPC_RATE_LIMIT) {
  const callsPerSecond = (rateLimit > 0 ? rateLimit : DEFAULT_RPC_RATE_LIMIT) * L1_FEE_SHARE
  const batchesPerSecond = Math.max(2, Math.ceil(callsPerSecond / MAX_BATCH))
  const batch = Math.max(1, Math.floor(callsPerSecond / batchesPerSecond))
  return { batch, pauseMs: Math.max(1_000 / batchesPerSecond, (batch * 1_000) / callsPerSecond), maxPerRead: Math.max(batch, Math.floor(callsPerSecond * SECONDS_PER_READ)) }
}

type Receipt = { blockNumber?: string; l1Fee?: string } | null
type RpcResult = { id: number; result?: Receipt }

/** A receipt from another block means a reorg or a lagging RPC, so its fee isn't this transaction's yet. */
export function l1FeeOf(receipt: Receipt | undefined, blockNum: number): string | null {
  if (!receipt?.blockNumber || Number(receipt.blockNumber) !== blockNum) return null
  // Deposits have no L1 fee at all, and their field can be missing.
  return receipt.l1Fee ? BigInt(receipt.l1Fee).toString() : "0"
}

export function createL1FeeReader(url: string, send: typeof fetch = fetch, pauseAfter429Ms = PAUSE_AFTER_429_MS, logger: Logger = console, rateLimit?: number): ReadL1Fees {
  const { batch: batchSize, pauseMs, maxPerRead } = l1FeePace(rateLimit)
  // Wallets read at the same time share this, so together they stay at one pace. It's per batch, sized by what's in it, so a small read doesn't cost a whole pause.
  let nextSlot = 0
  const waitForSlot = (size: number) => {
    const now = Date.now()
    const slot = Math.max(now, nextSlot)
    nextSlot = slot + (pauseMs * size) / batchSize
    return new Promise((resolve) => setTimeout(resolve, slot - now))
  }
  return async (requests) => {
    const fees = new Map<string, string>()
    const wanted = requests.slice(0, maxPerRead)
    const started = Date.now()
    for (let i = 0; i < wanted.length; i += batchSize) {
      // Sharing the pace makes each read slower, so what doesn't fit waits for the next refresh instead of holding this one up.
      if (i > 0 && nextSlot - started > SECONDS_PER_READ * 1_000) break
      const batch = wanted.slice(i, i + batchSize)
      try {
        const body = JSON.stringify(batch.map(({ txHash }, id) => ({ jsonrpc: "2.0", id, method: "eth_getTransactionReceipt", params: [txHash] })))
        const post = async () => {
          await waitForSlot(batch.length)
          return send(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(TIMEOUT_MS) })
        }
        let response = await post()
        for (let retry = 0; response.status === 429 && retry < RETRIES; retry++) {
          // Every read waits, since the next batch would get a 429 too.
          nextSlot = Math.max(nextSlot, Date.now() + pauseAfter429Ms)
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
