// How far apart Base's blocks are. The spacing is exact, so time can be worked out from block numbers with no read.

/**
 * Base's first block of the 200 ms upgrade, on November 5, 2026 at 18:00 UTC. Blocks are 2 s apart up to this one,
 * and 200 ms apart after it, several to a second, since `timestamp` stays in whole seconds. So order by block number.
 * This one starts a second exactly, as Base Sepolia's did.
 * It's the first block at or after that time, counting 2 s from genesis at 1686789347.
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

const MINUTE_MS = 60_000
const DAY_MS = 1440 * MINUTE_MS
/** How often to read prices for a chart, by how long ago: about a tick of each of its timeframes. Each step is a multiple of the one before, so a read stays useful as it ages, for as long as it's on the coarser one. */
const SAMPLE_STEPS = [
  { withinMs: 60 * MINUTE_MS, stepMs: 5 * MINUTE_MS },
  { withinMs: DAY_MS, stepMs: 60 * MINUTE_MS },
  { withinMs: 7 * DAY_MS, stepMs: 360 * MINUTE_MS },
  { withinMs: 30 * DAY_MS, stepMs: DAY_MS },
  { withinMs: Number.POSITIVE_INFINITY, stepMs: 7 * DAY_MS },
]

/**
 * The blocks in `from`..`through` to read prices at for a chart, oldest first. They sit on fixed multiples, so the same
 * blocks come back on each refresh, and each one's only read once.
 */
export function priceSampleBlocks(from: number, through: number): number[] {
  const blocks = new Set<number>()
  for (const { withinMs, stepMs } of SAMPLE_STEPS) {
    const size = (block: number) => stepMs / (block > LAST_2S_BLOCK ? FAST_MS : SLOW_MS)
    const start = Math.max(from, blockBefore(through, withinMs))
    for (let block = start + (size(start) - start % size(start)) % size(start); block <= through; ) {
      blocks.add(block)
      // Past the upgrade the multiples are of a bigger number, so the next one might be further than one step.
      const next = block + size(block + 1)
      const aligned = next - next % size(next)
      block = aligned > block ? aligned : aligned + size(next)
    }
  }
  return [...blocks].sort((a, b) => a - b)
}

/**
 * The `timestamp` of `block`, from a block at or after it. Timestamps are in whole seconds, so `from`'s can be up to 800 ms
 * short of when that block came. This puts that back first, so the answer doesn't change with which block it's counted from.
 */
export function timestampOfBlock(block: number, from: { blockNum: number; timestamp: string }): string {
  const fromMs = Date.parse(from.timestamp) + (Math.max(0, from.blockNum - LAST_2S_BLOCK) * FAST_MS) % 1000
  return new Date(Math.floor((fromMs - msBetweenBlocks(block, from.blockNum)) / 1000) * 1000).toISOString()
}
