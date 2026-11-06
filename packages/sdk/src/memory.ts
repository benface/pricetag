// How much wallet history fits in this process's memory, so a wallet too big to read is refused before it brings the process down.

import { getHeapStatistics } from "node:v8"

/** A wallet has more history than fits in memory. Nothing partial comes back: the numbers would look complete and be wrong. */
export class WalletTooBigError extends Error {
  readonly maxRows: number
  constructor(maxRows: number) {
    super(`This wallet has more than ${maxRows} rows of history, which is more than fits in memory. Read a smaller block range, or raise the heap with --max-old-space-size.`)
    this.name = "WalletTooBigError"
    this.maxRows = maxRows
  }
}

/** The wallets being read right now leave no room for this one. Unlike `WalletTooBigError`, this passes. */
export class WalletsBusyError extends Error {
  constructor() {
    super("Other large wallets are being read, and there's no memory left for this one yet. Try again shortly.")
    this.name = "WalletsBusyError"
  }
}

/** What one row costs at the peak of reading and folding it. Measured on staging's busiest wallets through `/api/portfolio` (WORK-570). */
const BYTES_PER_ROW = 10_000
/** What the heap limit counts that rows can't use: the young generation, and the server before it's read anything. */
const HEAP_FOR_THE_REST = 200_000_000
/** So a small heap still reads an ordinary wallet. */
const MIN_ROWS = 1_000

/** The most rows of wallet history this process can hold at once. */
export const rowsThatFit = (heapBytes = getHeapStatistics().heap_size_limit) => Math.max(MIN_ROWS, Math.floor((heapBytes - HEAP_FOR_THE_REST) / BYTES_PER_ROW))

/** Measured: 19,000 legs took 475 MB, and 27,000 ran a 640 MB heap out. So 2 bytes per leg squared leaves about a third to spare (WORK-570). */
const BYTES_PER_LEG_SQUARED = 2

/** The most legs an oldest-first fold can take. Its memory grows with their square, so this is far fewer than `rowsThatFit`. */
export const oldestFirstLegsThatFit = (heapBytes = getHeapStatistics().heap_size_limit) => Math.floor(Math.sqrt(Math.max(heapBytes - HEAP_FOR_THE_REST, 0) / BYTES_PER_LEG_SQUARED))

/** A store of wallets' rows that can give some up. A wallet being read isn't counted, because its read reserves its rows. */
export type RowHolder = { heldRows(): number; evictOldest(): boolean }

/**
 * First reads loading at once when nothing else is being read. A wallet holds its rows while its next query waits its turn, so
 * these add up: 14 wallets of 11,000 to 28,000 rows ran a 512 MB heap out, before any had started folding (WORK-570). Loaded rows
 * cost about a fifth of what they do at the peak, and a third of the budget for each leaves room for that on top of what's kept.
 */
const LOADS_AT_ONCE = 3

/** Rows of wallet history, across everything that keeps or reads them: what's kept goes first to make room, oldest first. */
export function createRowBudget(maxRows: number) {
  const holders = new Set<RowHolder>()
  const waiting: (() => void)[] = []
  let reading = 0
  const held = () => [...holders].reduce((sum, holder) => sum + holder.heldRows(), 0)
  function take(rows: number): () => void {
    reading += rows
    let released = false
    return () => {
      if (released) return
      released = true
      reading -= rows
      for (const wake of waiting.splice(0)) wake()
    }
  }
  return {
    maxRows,
    join(holder: RowHolder) {
      holders.add(holder)
    },
    /** Room for a read of this many rows, or `WalletsBusyError` when other reads have it. Returns what gives it back. */
    reserve(rows: number): () => void {
      while (reading + rows + held() > maxRows && [...holders].some((holder) => holder.evictOldest()));
      if (reading + rows > maxRows) throw new WalletsBusyError()
      return take(rows)
    },
    /** Waits for room to load a wallet whose size isn't known yet. Kept wallets stay, since a small one wouldn't need them gone. Returns what gives it back. */
    async loading(): Promise<() => void> {
      const rows = Math.ceil(maxRows / LOADS_AT_ONCE)
      while (reading + rows > maxRows) await new Promise<void>((resolve) => waiting.push(resolve))
      return take(rows)
    },
  }
}

export type RowBudget = ReturnType<typeof createRowBudget>
