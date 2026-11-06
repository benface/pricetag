// Follows the chain: says when a block has been processed, and when a reorg replaced some. Amp's stream says so as it
// happens, and polling takes over whenever the stream can't, so a caller doesn't need to know which it was.

import { setTimeout as sleep } from "node:timers/promises"
import { describeError, type BlockMark, type Logger, type StreamRanges } from "./amp.ts"

export type Via = "stream" | "polling"

/**
 * block: `blockNum` is the newest block, and `reorgFrom`, when it isn't null, is the first block a reorg replaced since the
 * last tick, or may have: what polling said counts as replaced once the stream is back, since only the stream can vouch for
 * it. While polling, `reorgFrom` is the block after the newest one it said that the chain still has, so it can be a little
 * before the real one.
 * down: neither the stream nor polling can reach Amp.
 */
export type ChainTick = { kind: "block"; blockNum: number; reorgFrom: number | null; via: Via } | { kind: "down"; message: string }

export type FollowConfig = {
  /** Null to only poll. */
  stream: StreamRanges | null
  /** What to stream. Its rows are ignored. */
  sql: string
  readMark(after: number | null): Promise<BlockMark | null>
  /** The hash the chain has at each of these blocks, leaving out any it doesn't have. Without it, polling only sees a reorg at the head. */
  readHashes?: ((blocks: readonly number[]) => Promise<ReadonlyMap<number, string>>) | undefined
  logger?: Logger | undefined
  pollMs?: number | undefined
  /** How long to poll before trying the stream again. */
  retryMs?: number | undefined
  /** A stream with no new block for this long counts as lost. A keepalive doesn't count. */
  stallMs?: number | undefined
  /** The least time between ticks. Base makes 5 blocks a second, and each tick is at least one read of a shared Amp. */
  tickMs?: number | undefined
}

const POLL_MS = 2000
const RETRY_MS = 30_000
const STALL_MS = 60_000
const TICK_MS = 2000
/** Further back than any reorg on Base. A stream that goes this far has ignored where it was asked to resume, so it would replay the chain. */
const MAX_REWIND_BLOCKS = 1000

/** Only the newest tick is worth reading, but a reorg in one that was skipped still happened. */
function merged(pending: ChainTick | null, next: ChainTick): ChainTick {
  if (!pending) return next
  if (next.kind === "down") return pending.kind === "block" ? pending : next
  if (pending.kind === "down" || pending.reorgFrom === null) return next
  return { ...next, reorgFrom: Math.min(pending.reorgFrom, next.reorgFrom ?? pending.reorgFrom) }
}

async function pump({ stream, sql, readMark, readHashes, logger = console, pollMs = POLL_MS, retryMs = RETRY_MS, stallMs = STALL_MS }: FollowConfig, emit: (tick: ChainTick) => void, signal: AbortSignal) {
  let last: BlockMark | null = null
  /** What ticks said, oldest first, to find where a reorg polling sees starts. They can be from a replaced chain, so each is checked before it's believed. */
  let marks: BlockMark[] = []
  /**
   * Where the stream resumes: the last block it finished, not the newest one polling found. Polling can't see a reorg
   * before it's checked a block, so this lets Amp say if one replaced this block in the meantime, however deep it was.
   */
  let resume: BlockMark | null = null
  /** The first block replaced by a reorg that no tick has said yet. It outlives a stream that dies halfway through reporting one. */
  let reorgFrom: number | null = null
  /**
   * The first block polling said that the stream hasn't been through. Amp only reports a reorg before where the stream
   * resumes, so one after it would pass as new blocks. A hash can't rule that out, since polling can read one block from the
   * old chain and the next from the new one. So they count as replaced when the stream catches up, however many tries it takes.
   */
  let unconfirmedFrom: number | null = null

  const remember = (mark: BlockMark) => {
    last = mark
    marks = [...marks.filter(({ blockNum }) => blockNum < mark.blockNum && mark.blockNum - blockNum <= MAX_REWIND_BLOCKS), mark]
  }

  const tickFor = (blockNum: number, via: Via): ChainTick => {
    const tick: ChainTick = { kind: "block", blockNum, reorgFrom, via }
    reorgFrom = null
    return tick
  }

  async function followStream(streamed: StreamRanges, from: BlockMark) {
    const stalled = new AbortController()
    const watchdog = setTimeout(() => stalled.abort(new Error(`No new block in ${stallMs} ms`)), stallMs)
    let at = from
    if (last && last.blockNum > from.blockNum) unconfirmedFrom ??= from.blockNum + 1
    try {
      for await (const range of streamed(sql, from, AbortSignal.any([signal, stalled.signal]))) {
        watchdog.refresh()
        if (at.blockNum - range.start > MAX_REWIND_BLOCKS) throw new Error(`The stream went back to block ${range.start} from ${at.blockNum}`)
        const isSameBlock = range.end === at.blockNum && range.hash === at.hash
        if (range.start <= at.blockNum && !isSameBlock) reorgFrom = Math.min(reorgFrom ?? range.start, range.start)
        if (!range.complete || isSameBlock) continue
        at = resume = { blockNum: range.end, hash: range.hash }
        // Catching up on blocks polling already said, with nothing replaced so far.
        if (reorgFrom === null && last && range.end < last.blockNum) continue
        if (unconfirmedFrom !== null) reorgFrom = Math.min(reorgFrom ?? unconfirmedFrom, unconfirmedFrom)
        unconfirmedFrom = null
        remember(at)
        emit(tickFor(range.end, "stream"))
      }
      throw new Error("The stream ended")
    } finally {
      clearTimeout(watchdog)
    }
  }

  /**
   * A reorg that also made the chain longer looks like a new block at the head, so the last block a tick said has to be
   * checked. One the chain doesn't have says nothing, since it can be a read behind, and it's checked again once it's there.
   */
  async function findReorg() {
    if (!readHashes || !last) return
    const hash = (await readHashes([last.blockNum])).get(last.blockNum)
    if (hash === undefined || hash === last.hash) return
    const hashes = await readHashes(marks.map(({ blockNum }) => blockNum))
    const agreed = marks.findLast(({ blockNum, hash }) => hashes.get(blockNum) === hash)
    const from = agreed ? agreed.blockNum + 1 : marks[0]!.blockNum
    reorgFrom = Math.min(reorgFrom ?? from, from)
  }

  async function pollOnce() {
    // A reorg the stream reported can leave a shorter chain, which reading from the last block wouldn't find.
    const mark = await readMark(reorgFrom === null ? (last?.blockNum ?? null) : reorgFrom - 1)
    // After the head, or a reorg between the two reads would go unseen: this mark replaces the last one, and only the last one gets checked.
    await findReorg()
    if (!mark) return
    const replaced = mark.blockNum === last?.blockNum && mark.hash !== last.hash
    const shorter = reorgFrom !== null && last !== null && mark.blockNum < last.blockNum
    if (last && mark.blockNum <= last.blockNum && !replaced && !shorter) return
    remember(mark)
    if (replaced) reorgFrom = Math.min(reorgFrom ?? mark.blockNum, mark.blockNum)
    emit(tickFor(mark.blockNum, "polling"))
  }

  while (!signal.aborted) {
    if (stream) {
      try {
        if (!last) {
          const mark = await readMark(null)
          if (mark) remember(mark)
        }
        resume ??= last
        if (resume) await followStream(stream, resume)
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
 * A slow reader doesn't fall behind, and neither does a fast one with more blocks than it needs: each gets the newest tick,
 * with any reorg it missed.
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
  const { tickMs = TICK_MS } = config
  try {
    while (true) {
      if (pending) {
        const tick: ChainTick = pending
        pending = null
        const yieldedAt = Date.now()
        yield tick
        // Anything that comes in during this is merged into the next tick, including a reorg.
        await sleep(Math.max(0, tickMs - (Date.now() - yieldedAt)), undefined, { signal: stopping }).catch(() => {})
      } else if (finished) return
      else await new Promise<void>((resolve) => (wake = resolve))
    }
  } finally {
    stop.abort()
    await pumping
  }
}
