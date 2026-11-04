// Follows the chain: says when a block has been processed, and when a reorg replaced some. Amp's stream says so as it
// happens, and polling takes over whenever the stream can't, so a caller doesn't need to know which it was.

import { setTimeout as sleep } from "node:timers/promises"
import { describeError, type BlockMark, type Logger, type StreamRanges } from "./amp.ts"

export type Via = "stream" | "polling"

/**
 * block: `blockNum` is the newest block, and `reorgFrom`, when it isn't null, is the first block a reorg replaced since the
 * last tick. Polling only sees a reorg at the head. Deeper ones are left to the re-read of recent blocks.
 * down: neither the stream nor polling can reach Amp.
 */
export type ChainTick = { kind: "block"; blockNum: number; reorgFrom: number | null; via: Via } | { kind: "down"; message: string }

export type FollowConfig = {
  /** Null to only poll. */
  stream: StreamRanges | null
  /** What to stream. Its rows are ignored. */
  sql: string
  readMark(after: number | null): Promise<BlockMark | null>
  logger?: Logger | undefined
  pollMs?: number | undefined
  /** How long to poll before trying the stream again. */
  retryMs?: number | undefined
  /** A stream with no new block for this long counts as lost. A keepalive doesn't count. */
  stallMs?: number | undefined
}

const POLL_MS = 2000
const RETRY_MS = 30_000
const STALL_MS = 60_000
/** Further back than any reorg on Base. A stream that goes this far has ignored where it was asked to resume, so it would replay the chain. */
const MAX_REWIND_BLOCKS = 1000

/** Only the newest tick is worth reading, but a reorg in one that was skipped still happened. */
function merged(pending: ChainTick | null, next: ChainTick): ChainTick {
  if (!pending) return next
  if (next.kind === "down") return pending.kind === "block" ? pending : next
  if (pending.kind === "down" || pending.reorgFrom === null) return next
  return { ...next, reorgFrom: Math.min(pending.reorgFrom, next.reorgFrom ?? pending.reorgFrom) }
}

async function pump({ stream, sql, readMark, logger = console, pollMs = POLL_MS, retryMs = RETRY_MS, stallMs = STALL_MS }: FollowConfig, emit: (tick: ChainTick) => void, signal: AbortSignal) {
  let last: BlockMark | null = null

  async function followStream(streamed: StreamRanges, from: BlockMark) {
    const stalled = new AbortController()
    const watchdog = setTimeout(() => stalled.abort(new Error(`No new block in ${stallMs} ms`)), stallMs)
    let reorgFrom: number | null = null
    let at = from
    try {
      for await (const range of streamed(sql, from, AbortSignal.any([signal, stalled.signal]))) {
        watchdog.refresh()
        if (at.blockNum - range.start > MAX_REWIND_BLOCKS) throw new Error(`The stream went back to block ${range.start} from ${at.blockNum}`)
        const isSameBlock = range.end === at.blockNum && range.hash === at.hash
        if (range.start <= at.blockNum && !isSameBlock) reorgFrom = Math.min(reorgFrom ?? range.start, range.start)
        if (!range.complete || isSameBlock) continue
        at = last = { blockNum: range.end, hash: range.hash }
        emit({ kind: "block", blockNum: range.end, reorgFrom, via: "stream" })
        reorgFrom = null
      }
      throw new Error("The stream ended")
    } finally {
      clearTimeout(watchdog)
    }
  }

  async function pollOnce() {
    const mark = await readMark(last?.blockNum ?? null)
    if (!mark) return
    const replaced = mark.blockNum === last?.blockNum && mark.hash !== last.hash
    if (last && mark.blockNum <= last.blockNum && !replaced) return
    last = mark
    emit({ kind: "block", blockNum: mark.blockNum, reorgFrom: replaced ? mark.blockNum : null, via: "polling" })
  }

  while (!signal.aborted) {
    if (stream) {
      try {
        last ??= await readMark(null)
        if (last) await followStream(stream, last)
      } catch (error) {
        if (signal.aborted) return
        logger.warn(`Amp's stream stopped, so polling until it's back: ${describeError(error)}`)
      }
    }
    const until = stream ? Date.now() + retryMs : Infinity
    while (!signal.aborted && Date.now() < until) {
      const started = Date.now()
      try {
        await pollOnce()
      } catch (error) {
        emit({ kind: "down", message: describeError(error) })
      }
      await sleep(Math.max(0, pollMs - (Date.now() - started)), undefined, { signal }).catch(() => {})
    }
  }
}

/**
 * Ticks as the chain moves, until `signal` aborts or the caller stops reading. Following starts on the first `next()`.
 * A slow reader doesn't fall behind: it gets the newest tick, with any reorg it missed.
 */
export async function* followChain(config: FollowConfig, signal?: AbortSignal): AsyncGenerator<ChainTick, void, void> {
  const stop = new AbortController()
  const stopping = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal
  let pending: ChainTick | null = null
  let wake = () => {}
  let finished = false
  const pumping = pump(
    config,
    (tick) => {
      pending = merged(pending, tick)
      wake()
    },
    stopping,
  ).finally(() => {
    finished = true
    wake()
  })
  try {
    while (true) {
      if (pending) {
        const tick: ChainTick = pending
        pending = null
        yield tick
      } else if (finished) return
      else await new Promise<void>((resolve) => (wake = resolve))
    }
  } finally {
    stop.abort()
    await pumping
  }
}
