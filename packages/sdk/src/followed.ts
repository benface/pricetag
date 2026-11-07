// Keeps a live copy of the rows a wallet's next read will ask for, so that read doesn't have to query for them. A read only
// gets rows when the copy covers everything it asked. Any other time it gets null and queries as it always did, so a stream
// that's slow, stopped or was never started only costs what it would have.

import { asNumber, describeError, type BlockMark, type Logger, type StreamBatch, type StreamRows } from "./amp.ts"
import { blockBefore } from "./chain.ts"
import type { Row } from "./dataset.ts"

export type FollowedConfig<Table extends string> = {
  stream: StreamRows
  /** What to follow for a wallet: the same rows as the query it stands in for, with `block_num`, and no range of blocks. */
  sql(address: string): Record<Table, string>
  readMark(after: number | null): Promise<BlockMark | null>
  readHashes(blocks: readonly number[]): Promise<ReadonlyMap<number, string>>
  logger?: Logger | undefined
  /** How far back a stream starts. It has to be further than a read re-reads for reorgs, for the copy to answer one soon after it starts. */
  resumeMs?: number | undefined
  /** How many wallets are followed at once, since each is a stream per table on a shared Amp. Past this, a wallet just queries. */
  maxWallets?: number | undefined
  /** How long a read waits for a stream that's just behind what it asked. */
  waitMs?: number | undefined
  /** A wallet nobody's read for this long stops being followed. */
  idleMs?: number | undefined
  /** A stream with no new block for this long counts as lost. */
  stallMs?: number | undefined
  /** How long to query before trying a lost stream again. */
  retryMs?: number | undefined
}

const MAX_WALLETS = 3
const WAIT_MS = 1000
const IDLE_MS = 120_000
const STALL_MS = 20_000
const RETRY_MS = 30_000
const RESUME_MS = 120_000
/** How much the copy holds. A read further back than this queries. */
const KEEP_MS = 600_000
/** A read this far behind the head isn't following it, like one as of a fixed block, and following it would replay all that. */
const LIVE_BLOCKS = 1000
/** How far behind a stream can be for a wait to be worth it. Further back, it's catching up or stuck. */
const WAIT_BLOCKS = 100
/** Further back than any reorg on Base. A stream that goes this far has ignored where it was asked to resume. */
const MAX_REWIND_BLOCKS = 1000

/**
 * One table's rows for one wallet, as a stream says them. `through` only moves when a stream says every row up to there has
 * come, so a read never sees part of a block. It throws on anything it can't vouch for, which ends the stream.
 */
export class FollowedTable {
  from: number
  through: number
  private hash: string
  private rows: Row[] = []
  /** The range a stream has sent part of. Its rows are held, but not said to be there yet. */
  private partial: { start: number; end: number; hash: string } | null = null

  constructor(resume: BlockMark) {
    this.from = resume.blockNum + 1
    this.through = resume.blockNum
    this.hash = resume.hash
  }

  apply({ start, end, hash, complete, rows }: StreamBatch) {
    if (end === this.through && hash === this.hash) return
    if (this.through - start > MAX_REWIND_BLOCKS) throw new Error(`The stream went back to block ${start} from ${this.through}`)
    const { partial } = this
    const sameAsPartial = partial?.start === start && partial.end === end && partial.hash === hash
    if (start <= this.through || (partial && !sameAsPartial && start <= partial.end)) {
      // A reorg. Everything from here on comes again, whatever it was before.
      this.rows = this.rows.filter((row) => asNumber(row.block_num) < start)
      this.through = Math.min(this.through, start - 1)
      this.from = Math.min(this.from, start)
    }
    if (start > this.through + 1) throw new Error(`The stream skipped from block ${this.through} to ${start}`)
    // A loop, since spreading a big batch into `push` overflows the stack.
    for (const row of rows) this.rows.push(row)
    this.partial = complete ? null : { start, end, hash }
    if (!complete) return
    this.through = end
    this.hash = hash
    const keepFrom = blockBefore(end, KEEP_MS)
    if (keepFrom > this.from) {
      this.rows = this.rows.filter((row) => asNumber(row.block_num) >= keepFrom)
      this.from = keepFrom
    }
  }

  read(from: number, to: number): Row[] | null {
    if (from < this.from || to > this.through) return null
    return this.rows.filter((row) => {
      const block = asNumber(row.block_num)
      return block >= from && block <= to
    })
  }
}

type Wallet<Table extends string> = {
  stop: AbortController
  tables: Partial<Record<Table, FollowedTable>>
  /** Runs out when nobody's read the wallet for a while. */
  idle: NodeJS.Timeout
  movedAt: number
  /** Wakes the reads waiting for a stream to get further. */
  waiting: Set<() => void>
}

export type Followed<Table extends string> = {
  /** A wallet's rows in `from`..`to` from its stream, or null when the caller has to query for them. Starts following the wallet if it isn't. */
  read(address: string, table: Table, from: number, to: number): Promise<Row[] | null>
  /** A reorg was seen. A stream can take longer to say so, so nothing it's held is trusted, and each starts over on its next read. */
  rewind(): void
}

export function followedWallets<Table extends string>({ stream, sql, readMark, readHashes, logger = console, resumeMs = RESUME_MS, maxWallets = MAX_WALLETS, waitMs = WAIT_MS, idleMs = IDLE_MS, stallMs = STALL_MS, retryMs = RETRY_MS }: FollowedConfig<Table>): Followed<Table> {
  const wallets = new Map<string, Wallet<Table>>()
  /** When each wallet whose stream was lost can try again. */
  const lostUntil = new Map<string, number>()

  const drop = (address: string, wallet: Wallet<Table>) => {
    wallet.stop.abort()
    clearTimeout(wallet.idle)
    if (wallets.get(address) === wallet) wallets.delete(address)
    for (const wake of wallet.waiting) wake()
  }

  /** Queries for a while before trying this wallet again. */
  const pause = (address: string, wallet: Wallet<Table>) => {
    lostUntil.set(address, Date.now() + retryMs)
    drop(address, wallet)
  }

  const lose = (address: string, wallet: Wallet<Table>, error: unknown) => {
    if (wallet.stop.signal.aborted) return
    logger.warn(`Amp's stream for ${address} stopped, so querying until it's back: ${describeError(error)}`)
    pause(address, wallet)
  }

  function follow(address: string, wallet: Wallet<Table>, table: Table, query: string, resume: BlockMark) {
    const copy = new FollowedTable(resume)
    wallet.tables[table] = copy
    const stalled = new AbortController()
    const watchdog = setTimeout(() => stalled.abort(new Error(`No new block in ${stallMs} ms`)), stallMs).unref()
    void (async () => {
      for await (const batch of stream(query, resume, AbortSignal.any([wallet.stop.signal, stalled.signal]))) {
        const before = copy.through
        copy.apply(batch)
        if (copy.through === before) continue
        watchdog.refresh()
        wallet.movedAt = Date.now()
        for (const wake of wallet.waiting) wake()
      }
      throw new Error("The stream ended")
    })()
      .catch((error: unknown) => lose(address, wallet, stalled.signal.aborted ? stalled.signal.reason : error))
      .finally(() => clearTimeout(watchdog))
  }

  async function start(address: string, wallet: Wallet<Table>, to: number) {
    try {
      const head = await readMark(to)
      if (!head || head.blockNum - to > LIVE_BLOCKS) return pause(address, wallet)
      const block = blockBefore(head.blockNum, resumeMs)
      const hash = (await readHashes([block])).get(block)
      if (hash === undefined) return pause(address, wallet)
      if (wallet.stop.signal.aborted) return
      const queries = sql(address)
      for (const table of Object.keys(queries) as Table[]) follow(address, wallet, table, queries[table], { blockNum: block, hash })
    } catch (error) {
      lose(address, wallet, error)
    }
  }

  function followedFor(address: string, to: number): Wallet<Table> | null {
    const followed = wallets.get(address)
    if (followed) {
      followed.idle.refresh()
      return followed
    }
    if (wallets.size >= maxWallets || Date.now() < (lostUntil.get(address) ?? 0)) return null
    const wallet: Wallet<Table> = { stop: new AbortController(), tables: {}, idle: setTimeout(() => drop(address, wallet), idleMs).unref(), movedAt: Date.now(), waiting: new Set() }
    wallets.set(address, wallet)
    void start(address, wallet, to)
    return wallet
  }

  /** Whether the stream got to `to` soon enough. A wait is added to the read, so it's only for a stream that's moving and nearly there. */
  async function reached(wallet: Wallet<Table>, copy: FollowedTable, to: number): Promise<boolean> {
    if (copy.through >= to) return true
    if (to - copy.through > WAIT_BLOCKS || Date.now() - wallet.movedAt > waitMs * 2) return false
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        wallet.waiting.delete(check)
        resolve(copy.through >= to)
      }
      const check = () => {
        if (copy.through >= to || wallet.stop.signal.aborted) finish()
      }
      const timer = setTimeout(finish, waitMs)
      wallet.waiting.add(check)
    })
  }

  return {
    async read(address, table, from, to) {
      const wallet = followedFor(address, to)
      const copy = wallet?.tables[table]
      if (!wallet || !copy || from < copy.from) return null
      if (!(await reached(wallet, copy, to)) || wallet.stop.signal.aborted) return null
      return copy.read(from, to)
    },

    rewind() {
      for (const [address, wallet] of wallets) drop(address, wallet)
    },
  }
}
