// How far apart Base's blocks are. The spacing is exact, so time can be worked out from block numbers with no read.

/**
 * Base's first block of the 200 ms upgrade, set for November 5, 2026 at 18:00 UTC. Blocks are 2 s apart up to this one,
 * and 200 ms apart after it, several to a second, since `timestamp` stays in whole seconds. So order by block number.
 * It's the first block at or after that time, counting 2 s from genesis at 1686789347. Change it if Base moves the date.
 */
export const LAST_2S_BLOCK = 53_556_127

const SLOW_MS = 2000
const FAST_MS = 200

/** How long after block `from` block `to` came. */
export function msBetweenBlocks(from: number, to: number): number {
  const slow = Math.max(0, Math.min(to, LAST_2S_BLOCK) - from)
  const fast = Math.max(0, to - Math.max(from, LAST_2S_BLOCK))
  return slow * SLOW_MS + fast * FAST_MS
}

/** The newest block at least `ms` before `block`. */
export function blockBefore(block: number, ms: number): number {
  const fastSpan = Math.max(0, block - LAST_2S_BLOCK) * FAST_MS
  if (ms <= fastSpan) return block - Math.ceil(ms / FAST_MS)
  return Math.max(0, Math.min(block, LAST_2S_BLOCK) - Math.ceil((ms - fastSpan) / SLOW_MS))
}
