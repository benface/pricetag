// Where a wallet's rows come from: the Pricetag dataset through `resolvingSource`, or, when it isn't deployed, the raw Base
// dataset through `rawSource`. Both have the same shape, so everything after this file doesn't care which one it was.
//
// Every query is bounded by block, because staging is shared.

import { ETH_ADDRESS, ETH_USD_FEED, LAST_2S_BLOCK, MIN_TOKEN_TRADE_USD, MIN_TRADE_USD_MICROS, TOKENS, TOKEN_FEEDS, TOKEN_FEED_WINDOW_SECONDS, USDC_USD_FEED, WETH_ADDRESS, blockBefore, marketTrades, parseNote, type TokenActivity, type CostNote, type FeedRound, type PricedRow } from "@pricetag/sdk/core"
import { WalletTooBigError, MARKET_BUCKET_BLOCKS, asIso, asNumber, blockFilters, datasetReader, datasetSource, decimalString, decodeRoundAnswer, describeError, hexOf, isNotStarted, prefixed, readBalancesAt, readTokenFactsAt, readEthBalancesAt, readFeedRoundsAt, readHead, readPayoutTxsAt, settledThrough, type Followed, type PriceUpdate, type Query, type ReadL1Fees, type Row, type Source, type StreamedTable, type WindowRows } from "@pricetag/sdk/internal"
import { DEPOSIT_TOPIC, TRANSFER_BATCH_TOPIC, TRANSFER_SINGLE_TOPIC, TRANSFER_TOPIC, WITHDRAWAL_TOPIC, legRowsFromRaw, type RawLog, type RawTx } from "./raw.ts"
import { isMissingTable, walletTurns } from "./shared.ts"

/** One `AnswerUpdated` of a token's feed, in the feeds dataset. */
export type FeedUpdate = PriceUpdate & { asset: string; updatedAt: number }

const FEED_LOG_TIMEOUT_MS = 15_000

/** Every feed's updates from as far back as one could still count at `block`, up to the newest. A table with nothing yet has none. */
export async function readFeedUpdates(query: Query, dataset: string, block: number): Promise<FeedUpdate[]> {
  const sql = `SELECT block_num, tx_hash, log_index, asset, answer, updated_at FROM "${dataset}".feed_updates WHERE block_num >= ${blockBefore(block, TOKEN_FEED_WINDOW_SECONDS * 1000)} ORDER BY block_num, log_index`
  const rows = await query<Row>(sql, FEED_LOG_TIMEOUT_MS).catch((error: unknown) => {
    if (isNotStarted(error)) return [] as Row[]
    throw error
  })
  return rows.map((row) => ({ block_num: asNumber(row.block_num), tx_hash: prefixed(String(row.tx_hash)), log_index: asNumber(row.log_index), asset: String(row.asset), answer: String(row.answer), updatedAt: Number(row.updated_at) }))
}

/** The newest of `updates` for each asset at or before `block`. */
export function latestFeedUpdates(updates: readonly FeedUpdate[], block: number): Map<string, FeedUpdate> {
  return new Map(updates.filter((update) => update.block_num <= block).map((update) => [update.asset, update]))
}

/**
 * Feeds' answers from Chainlink's `AnswerUpdated` logs, in the feeds dataset, which are what the contracts answer at that block.
 * As in `updateRounds`, the table's newest row is the only sign of how far it's reached, so from that row on, an update could still
 * be on its way, and those blocks read the contract instead. That's what a current price usually is, and a chart's older points are
 * what this saves calls on. Anything the table can't answer, or a failed read of it, goes to the contract too, as it always did.
 *
 * Blocks past the newest row seen go straight to the contract, so following the head costs no read of the table. A chart's older
 * points read the table, which moves that row along.
 */
export function updateFeedRounds(query: Query, config: { baseDataset: string; feedsDataset: string }, exact: NonNullable<Source["readFeedRounds"]>): NonNullable<Source["readFeedRounds"]> {
  let reached: number | null = null
  return async (assets, blocks) => {
    const feeds = assets.filter((asset) => TOKEN_FEEDS[asset])
    if (feeds.length === 0 || blocks.length === 0) return new Map()
    const oldest = Math.min(...blocks)
    if (reached !== null && oldest >= reached) return exact(assets, blocks)
    const updates = await readFeedUpdates(query, config.feedsDataset, oldest).catch((error: unknown) => {
      console.warn(`Reading the feeds dataset failed, so this reads the contracts: ${describeError(error)}`)
      return [] as FeedUpdate[]
    })
    const newest = updates.at(-1)?.block_num ?? 0
    if (newest > 0) reached = Math.max(reached ?? 0, newest)
    const rounds = new Map<number, Record<string, FeedRound>>()
    for (const { filter, count } of blockFilters(blocks.filter((block) => block < newest))) {
      for (const row of await query<Row>(`SELECT block_num, timestamp FROM "${config.baseDataset}".blocks WHERE ${filter} LIMIT ${count}`)) {
        const block = asNumber(row.block_num)
        const latest = latestFeedUpdates(updates, block)
        const known: Record<string, FeedRound> = {}
        for (const asset of feeds) {
          const update = latest.get(asset)
          if (update) known[asset] = { answer: update.answer, updatedAt: update.updatedAt, blockNum: block, timestamp: asIso(row.timestamp) }
        }
        rounds.set(block, known)
      }
    }
    const unanswered = (block: number) => feeds.filter((asset) => !rounds.get(block)?.[asset])
    const contractBlocks = blocks.filter((block) => unanswered(block).length > 0)
    if (contractBlocks.length === 0) return rounds
    const contractAssets = feeds.filter((asset) => contractBlocks.some((block) => !rounds.get(block)?.[asset]))
    for (const [block, read] of await exact(contractAssets, contractBlocks)) rounds.set(block, { ...read, ...rounds.get(block) })
    return rounds
  }
}

async function readNotesAt(query: Query, dataset: string, address: string, blocks: readonly number[]): Promise<CostNote[]> {
  const me = hexOf(address)
  const notes: CostNote[] = []
  for (const { filter } of blockFilters(blocks)) {
    const rows = await query<Row>(`SELECT block_num, tx_hash, input FROM "${dataset}".transactions WHERE ${filter} AND "from" = X'${me}' AND "to" = X'${me}' AND status AND value = '0'`)
    for (const row of rows) {
      const note = parseNote(String(row.input ?? ""))
      if (note) notes.push({ ...note, noteTx: prefixed(String(row.tx_hash)), blockNum: asNumber(row.block_num) })
    }
  }
  return notes.sort((a, b) => a.blockNum - b.blockNum)
}

/** How far back a wallet's history goes when PRICETAG_HISTORY_BLOCKS doesn't say. */
const DEFAULT_HISTORY_MS = 3_600_000

export function rawSource(query: Query, config: { baseDataset: string; network: string; historyBlocks: number | null; maxWalletRows?: number | undefined }): Source {
  const ds = `"${config.baseDataset}"`
  const max = config.maxWalletRows
  // One past the most it can use, which is how it knows there's more without loading it all.
  const limit = max === undefined ? "" : ` LIMIT ${max + 1}`
  const refuseIfOver = (rows: number) => {
    if (max !== undefined && rows > max) throw new WalletTooBigError(max)
  }

  async function inBlocks<T>(blocks: readonly number[], sql: (filter: string, count: number) => string): Promise<T[]> {
    const result: T[] = []
    for (const { filter, count } of blockFilters(blocks)) result.push(...(await query<T>(sql(filter, count))))
    return result
  }

  const readReferences = (blocks: readonly number[]) =>
    inBlocks<Row>(
      blocks,
      // The filter sits in an inner subquery with a LIMIT, and the outer query reads no field of the result.
      // WORK-320 found the other shapes can run eth_call on every block on the chain.
      (filter, count) =>
        `SELECT block_num,
           rpc.${config.network}.eth_call(NULL, evm_encode_hex('${ETH_USD_FEED}'), evm_encode_params('latestRoundData()'), block_num) AS e,
           rpc.${config.network}.eth_call(NULL, evm_encode_hex('${USDC_USD_FEED}'), evm_encode_params('latestRoundData()'), block_num) AS u
         FROM (SELECT block_num FROM ${ds}.blocks WHERE ${filter} LIMIT ${count})`,
    ).then((rows) =>
      rows.map((r) => ({
        blockNum: asNumber(r.block_num),
        ethUsd: decodeRoundAnswer((r.e as { data?: string } | null)?.data),
        usdcUsd: decodeRoundAnswer((r.u as { data?: string } | null)?.data),
      })),
    )

  return {
    mode: "raw",
    startBlock: null,
    historyFrom: (head) => (config.historyBlocks === null ? blockBefore(head, DEFAULT_HISTORY_MS) : head - config.historyBlocks),
    head: (after) => readHead(query, config.baseDataset, after),
    // The raw tables are what the head is read from, so they've always reached it.
    processedThrough: async (_after, head) => head,
    readReferences,
    readLatestReference: async (head) => (await readReferences([head]))[0] ?? null,
    readBalances: (address, block) => readBalancesAt(query, config.network, address, block),
    readTokenFacts: readTokenFactsAt(query, config.network),
    readNotes: (address, blocks) => readNotesAt(query, config.baseDataset, address, blocks),
    readEthBalances: (address, blocks) => readEthBalancesAt(query, config.network, config.baseDataset, address, blocks),
    readPayoutTxs: (address, blocks) => readPayoutTxsAt(query, config.baseDataset, address, blocks),
    readFeedRounds: readFeedRoundsAt(query, config),

    async readWindow(address, from, to) {
      const me = hexOf(address)
      const topic = `X'${me.padStart(64, "0")}'`
      const range = `block_num BETWEEN ${from} AND ${to}`
      const txRows = await query<Row>(
        `SELECT block_num, timestamp, tx_hash, tx_index, "from", "to", value, gas_used, gas_price, max_fee_per_gas, max_priority_fee_per_gas, status, type
         FROM ${ds}.transactions WHERE ${range} AND ("from" = X'${me}' OR "to" = X'${me}')${limit}`,
      )
      refuseIfOver(txRows.length)
      const txs: RawTx[] = txRows.map((t) => ({
        block_num: asNumber(t.block_num),
        timestamp: asIso(t.timestamp),
        tx_hash: prefixed(String(t.tx_hash)),
        tx_index: asNumber(t.tx_index),
        from: String(t.from),
        to: t.to == null ? null : String(t.to),
        value: String(t.value),
        gas_used: String(t.gas_used),
        gas_price: decimalString(t.gas_price),
        max_fee_per_gas: decimalString(t.max_fee_per_gas),
        max_priority_fee_per_gas: decimalString(t.max_priority_fee_per_gas),
        status: Boolean(t.status),
        type: asNumber(t.type),
      }))
      const toLog = (l: Row): RawLog => ({
        block_num: asNumber(l.block_num),
        timestamp: asIso(l.timestamp),
        tx_hash: prefixed(String(l.tx_hash)),
        tx_index: asNumber(l.tx_index),
        log_index: asNumber(l.log_index),
        address: String(l.address),
        topic0: String(l.topic0),
        topic1: l.topic1 == null ? null : String(l.topic1),
        topic2: l.topic2 == null ? null : String(l.topic2),
        topic3: l.topic3 == null ? null : String(l.topic3),
        data: String(l.data),
      })
      const logColumns = "block_num, timestamp, tx_hash, tx_index, log_index, address, topic0, topic1, topic2, topic3, data"
      const logs = (
        await query<Row>(
          `SELECT ${logColumns} FROM ${ds}.logs
           WHERE ${range} AND (
             (topic0 IN (X'${TRANSFER_TOPIC}', X'${DEPOSIT_TOPIC}', X'${WITHDRAWAL_TOPIC}') AND (topic1 = ${topic} OR topic2 = ${topic}))
             OR (topic0 IN (X'${TRANSFER_SINGLE_TOPIC}', X'${TRANSFER_BATCH_TOPIC}') AND (topic2 = ${topic} OR topic3 = ${topic}))
           )${limit}`,
        )
      ).map(toLog)
      refuseIfOver(txs.length + logs.length)

      const sent = txs.filter((t) => hexOf(t.from) === me)
      const sentBlocks = [...new Set(sent.map((t) => t.block_num))]
      const withdrawals = (
        await inBlocks<Row>(
          sentBlocks,
          (filter) =>
            `SELECT ${logColumns} FROM ${ds}.logs
             WHERE ${filter} AND address = X'${hexOf(WETH_ADDRESS)}' AND topic0 = X'${WITHDRAWAL_TOPIC}'`,
        )
      ).map(toLog)

      // gas_used is cumulative within a block, so a transaction's gas needs the one before it.
      const previousIndexes = [...new Set(sent.filter((t) => t.tx_index > 0).map((t) => t.tx_index - 1))].join(", ")
      const previousGas = previousIndexes
        ? await inBlocks<Row>(sentBlocks, (filter) => `SELECT block_num, tx_index, gas_used FROM ${ds}.transactions WHERE ${filter} AND tx_index IN (${previousIndexes})`)
        : []
      const baseFees = await inBlocks<Row>(sentBlocks, (filter) => `SELECT block_num, base_fee_per_gas FROM ${ds}.blocks WHERE ${filter}`)

      const { rows, gasUnknown } = legRowsFromRaw({
        account: address,
        txs,
        logs,
        withdrawals,
        gas: {
          cumulativeGas: new Map(previousGas.map((g) => [`${asNumber(g.block_num)}:${asNumber(g.tx_index)}`, String(g.gas_used)])),
          // With no base fee, what a transaction paid isn't known, and it isn't free.
          baseFeeByBlock: new Map(baseFees.flatMap((b) => {
            const baseFee = decimalString(b.base_fee_per_gas)
            return baseFee === null ? [] : [[asNumber(b.block_num), baseFee] as const]
          })),
        },
      })
      return { rows, priced: null, gasUnknown }
    },
  }
}

/** Plenty for the guards in market.ts once small trades are left out, even though a busy pool repeats each trade per account. */
const MARKET_ROWS = 300

/** How many wallets' rows are kept here, the oldest going first. One that's gone is only read again. */
const MAX_SHARED_WALLETS = 20

/** A reorg from the block it replaced, and the newest block the old chain is known to have reached. */
type Reorg = { from: number; oldTip: number }

/** Whether an answer read as of `reached` is for good: past any reorg, and not in one the tables may not have rewritten yet. `createWallets` draws the same line. */
function isFinal(block: number, reached: number, reorgs: readonly Reorg[]): boolean {
  return block <= settledThrough(reached) && block < (unsettledFrom(reached, reorgs) ?? Infinity)
}

function unsettledFrom(reached: number, reorgs: readonly Reorg[]): number | null {
  const unsettled = reorgs.filter(({ oldTip }) => settledThrough(reached) < oldTip)
  return unsettled.length > 0 ? Math.min(...unsettled.map(({ from }) => from)) : null
}

/** What's been read of a wallet: its rows from `from` to `to`, and the answers for blocks that were past any reorg by then. */
type SharedWallet = Pick<WindowRows, "rows" | "gasUnknown"> & { from: number; to: number; notes: Map<number, CostNote[]>; ethBalances: Map<number, string> }

/**
 * The reads of a wallet that no pricing rule changes, each done once however many rules ask. Rules read one after the
 * other, so the second usually wants a few blocks more than the first. Blocks a reorg could still reach are always read
 * again, and everything older comes from what's held, until `rewind` says a reorg went further back than that.
 */
export function sharedReads(query: Query, config: { baseDataset: string; dataset: string; network: string; followed?: Followed<StreamedTable> | undefined; maxWalletRows?: number | undefined }) {
  const reader = datasetReader(query, { ...config, counterparties: true })
  const wallets = new Map<string, SharedWallet>()
  const inTurn = walletTurns()
  const reorgs: Reorg[] = []
  const max = config.maxWalletRows ?? Infinity
  /** These outlast what `createWallets` keeps, so they need a limit of their own. The newest always stays. */
  function keepWithinMax() {
    let rows = [...wallets.values()].reduce((sum, wallet) => sum + wallet.rows.length, 0)
    for (const [address, wallet] of wallets) {
      if (rows <= max || wallets.size === 1) return
      wallets.delete(address)
      rows -= wallet.rows.length
    }
  }

  return {
    readLegs: (address: string, from: number, to: number) =>
      inTurn(address, async () => {
        const held = wallets.get(address)
        const extended = held && held.from <= from && from <= held.to + 1 ? held : null
        // Until the tables get past a reorg, every read goes back to it, however far that is.
        const readFrom = extended ? Math.max(extended.from, Math.min(settledThrough(extended.to) + 1, unsettledFrom(extended.to, reorgs) ?? Infinity)) : from
        const read = readFrom <= to ? await reader.readLegs(address, readFrom, to) : { rows: [], gasUnknown: [] }
        const unread = ({ block_num }: { block_num: number }) => block_num < readFrom || block_num > to
        const next: SharedWallet = {
          from: extended?.from ?? from,
          to: Math.max(extended?.to ?? to, to),
          rows: [...(extended?.rows.filter(unread) ?? []), ...read.rows],
          gasUnknown: [...(extended?.gasUnknown.filter(unread) ?? []), ...read.gasUnknown],
          notes: held?.notes ?? new Map(),
          ethBalances: held?.ethBalances ?? new Map(),
        }
        wallets.delete(address)
        if (next.rows.length > max) throw new WalletTooBigError(max)
        wallets.set(address, next)
        if (wallets.size > MAX_SHARED_WALLETS) wallets.delete(wallets.keys().next().value as string)
        keepWithinMax()
        const asked = ({ block_num }: { block_num: number }) => block_num >= from && block_num <= to
        return { rows: next.rows.filter(asked), gasUnknown: next.gasUnknown.filter(asked) }
      }),

    readNotes: (address: string, blocks: readonly number[]) =>
      inTurn(address, async () => {
        const held = wallets.get(address)
        const unread = blocks.filter((block) => !held?.notes.has(block))
        const read = await readNotesAt(query, config.baseDataset, address, unread)
        const known = blocks.flatMap((block) => held?.notes.get(block) ?? [])
        // Most blocks have none, and that's the answer that's worth keeping.
        if (held) for (const block of unread) if (isFinal(block, held.to, reorgs)) held.notes.set(block, read.filter((note) => note.blockNum === block))
        return [...known, ...read].sort((a, b) => a.blockNum - b.blockNum)
      }),

    readEthBalances: (address: string, blocks: readonly number[]) =>
      inTurn(address, async () => {
        const held = wallets.get(address)
        const balances = new Map(blocks.flatMap((block) => {
          const balance = held?.ethBalances.get(block)
          return balance === undefined ? [] : [[block, balance] as const]
        }))
        const read = await readEthBalancesAt(query, config.network, config.baseDataset, address, blocks.filter((block) => !balances.has(block)))
        for (const [block, balance] of read) {
          balances.set(block, balance)
          if (held && isFinal(block, held.to, reorgs)) held.ethBalances.set(block, balance)
        }
        return balances
      }),

    /**
     * Blocks from `block` on were replaced, and the old chain reached `tip`. A read that's already started finishes first,
     * so what it found goes too.
     */
    async rewind(block: number, tip: number): Promise<void> {
      config.followed?.rewind()
      reorgs.push({ from: block, oldTip: Math.max(tip, ...[...wallets.values()].map((wallet) => wallet.to)) })
      const before = <T>(answers: Map<number, T>) => new Map([...answers].filter(([at]) => at < block))
      const kept = ({ block_num }: { block_num: number }) => block_num < block
      await Promise.allSettled(
        [...wallets.keys()].map((address) =>
          inTurn(address, async () => {
            const held = wallets.get(address)
            if (!held) return
            if (block <= held.from) wallets.delete(address)
            else if (block <= held.to) wallets.set(address, { ...held, to: block - 1, rows: held.rows.filter(kept), gasUnknown: held.gasUnknown.filter(kept), notes: before(held.notes), ethBalances: before(held.ethBalances) })
          }),
        ),
      )
    },
  }
}

export type SharedReads = ReturnType<typeof sharedReads>

/**
 * L1 fees, read once for good when their block is already past any reorg, so a second pricing rule reading the same
 * wallet only pays for what the first hasn't read. `tip` is the newest block known, or null when none is.
 */
/** How many transactions' L1 fees are kept, the oldest read going first. One that's gone is only read again. */
const MAX_SETTLED_FEES = 100_000

export function settledL1Fees(read: ReadL1Fees, tip: () => number | null): ReadL1Fees & { rewind(block: number, tip: number): void } {
  const settled = new Map<string, { blockNum: number; fee: string }>()
  const reorgs: Reorg[] = []
  /** How many reorgs have been told about. A read that crossed one can't say which chain it got, so it isn't kept. */
  let rewinds = 0
  const readFees: ReadL1Fees = async (requests) => {
    const fees = new Map<string, string>()
    const unread = requests.filter(({ txHash, blockNum }) => {
      const known = settled.get(txHash)
      if (known?.blockNum !== blockNum) return true
      fees.set(txHash, known.fee)
      return false
    })
    if (unread.length === 0) return fees
    // Before the read, because the head can move on during it, and a fee read before a reorg isn't final just because the reorg is over.
    const newest = tip()
    const startedAt = rewinds
    const found = await read(unread)
    for (const { txHash, blockNum } of unread) {
      const fee = found.get(txHash)
      if (fee === undefined) continue
      fees.set(txHash, fee)
      if (newest !== null && startedAt === rewinds && isFinal(blockNum, newest, reorgs)) settled.set(txHash, { blockNum, fee })
    }
    for (const txHash of settled.keys()) {
      if (settled.size <= MAX_SETTLED_FEES) break
      settled.delete(txHash)
    }
    return fees
  }
  return Object.assign(readFees, {
    rewind(block: number, oldTip: number) {
      rewinds += 1
      reorgs.push({ from: block, oldTip })
      for (const [txHash, { blockNum }] of settled) if (blockNum >= block) settled.delete(txHash)
    },
  })
}

/** The last block of a pricing bucket's 5 minutes, which is the first block a price can see all of them from. Blocks got 10 times faster, so its buckets did too. A remainder, because this engine's `/` doesn't round. */
const tokenBinSql = (size: number) => `(block_num + ${size - 1}) - (block_num + ${size - 1}) % ${size}`

/**
 * A token's trades, one row per sender and side every 5 minutes, so a busy token's still a small read. Each is dated by its last trade, so no
 * price looks ahead of its time. The 5 minutes are a pricing bucket's rather than the clock's, so a read that goes further leaves these rows as they are.
 */
function readTokenActivityFrom(query: Query, dataset: string) {
  return async (tokens: readonly string[], from: number, to: number): Promise<TokenActivity[]> => {
    const rows = await query<Row>(
      `SELECT token, sender, side, CASE WHEN block_num > ${LAST_2S_BLOCK} THEN ${tokenBinSql(MARKET_BUCKET_BLOCKS * 10)} ELSE ${tokenBinSql(MARKET_BUCKET_BLOCKS)} END AS bin, MAX(timestamp) AS at, SUM(CAST(usd_micros AS DOUBLE)) AS usd_micros, SUM(CAST(token_amount AS DOUBLE)) AS raw, COUNT(*) AS trades
       FROM "${dataset}".token_trades
       WHERE block_num BETWEEN ${from} AND ${to} AND token IN (${tokens.map((token) => `X'${hexOf(token)}'`).join(", ")}) AND CAST(usd_micros AS DOUBLE) >= ${MIN_TOKEN_TRADE_USD * 1_000_000}
       GROUP BY token, sender, side, bin`,
      120_000,
    )
    return rows.map((r) => ({ token: prefixed(String(r.token)), bin: Number(r.bin), timeMs: Number(r.at), sender: String(r.sender), side: r.side as "buy" | "sell", usd: Number(r.usd_micros) / 1e6, raw: Number(r.raw), trades: Number(r.trades) }))
  }
}

/** How far `token_trades` has got, which is its own, since it's its own dataset with its own job. */
function tokenTradesThrough(query: Query, baseDataset: string, dataset: string) {
  const { processedThrough } = datasetReader(query, { baseDataset, dataset })
  return (after: number, head: number) => processedThrough(after, head, ["token_trades"])
}

/**
 * The SDK's `datasetSource`, plus what only working out a cost needs: who was on the other side, notes, and market prices.
 * Pricing rules of one wallet history pass the same `shared`, so only what a rule changes is read for each.
 */
export function resolvingSource(query: Query, config: { baseDataset: string; dataset: string; priceDataset?: string; feedsDataset?: string | undefined; startBlock: number; network: string; tokensDataset?: string | undefined; followed?: Followed<StreamedTable> | undefined; maxWalletRows?: number | undefined }, shared = sharedReads(query, config)): Source {
  const { readPricedOf } = datasetReader(query, config)
  // What a fork of the pricing rule changes, so its market prices come from its own trades.
  const prices = `"${config.priceDataset ?? config.dataset}"`
  return {
    ...datasetSource(query, config),
    readNotes: shared.readNotes,
    readEthBalances: shared.readEthBalances,
    readFeedRounds: config.feedsDataset ? updateFeedRounds(query, { baseDataset: config.baseDataset, feedsDataset: config.feedsDataset }, readFeedRoundsAt(query, config)) : readFeedRoundsAt(query, config),
    ...(config.tokensDataset ? { readTokenActivity: readTokenActivityFrom(query, config.tokensDataset), tokenActivityThrough: tokenTradesThrough(query, config.baseDataset, config.tokensDataset) } : {}),

    async readWindow(address, from, to) {
      const legs = await shared.readLegs(address, from, to)
      return { ...legs, priced: await readPricedOf(legs.rows, address, from, to) }
    },

    async marketReady() {
      // Only a dataset with the fix for wrong `priced_legs` rows has this table, and it's the one trades are read from. Asking it for no rows tells them apart.
      try {
        await query<Row>(`SELECT block_num FROM ${prices}.unlisted_moves WHERE block_num BETWEEN ${config.startBlock} AND ${config.startBlock} LIMIT 1`, 15_000)
        return true
      } catch (error) {
        if (isNotStarted(error)) return true
        if (isMissingTable(error)) return false
        throw error
      }
    },

    async readMarketTrades(asset, from, to) {
      const token = TOKENS.find((t) => t.asset === asset && !t.oracle)
      if (!token) return []
      // Only rows `marketTrades` and the guards can use, or small trades fill the limit and hide real ones further back.
      // Amounts as doubles are only close, so this stops just short of the guard, which then checks exactly.
      const rows = await query<Row>(
        `SELECT block_num, tx_hash, sold_token, sold_amount, bought_token, bought_amount, priced, eth_usd FROM ${prices}.priced_legs
         WHERE block_num BETWEEN ${from} AND ${to} AND get_field(priced, 'token') = '${token.symbol}' AND get_field(priced, 'source') = 'swap'
           AND bought_token <> X'${hexOf(ETH_ADDRESS)}'
           AND TRY_CAST(get_field(priced, 'usd_micros') AS DOUBLE) * TRY_CAST(CASE WHEN sold_token = X'${hexOf(token.address)}' THEN sold_amount ELSE bought_amount END AS DOUBLE) >= ${(MIN_TRADE_USD_MICROS * 99n) / 100n} * 1e${token.decimals}
         ORDER BY block_num DESC LIMIT ${MARKET_ROWS}`,
      ).catch((error: unknown) => {
        if (isNotStarted(error)) return []
        throw error
      })
      return marketTrades(
        rows.map((r) => ({
          block_num: asNumber(r.block_num),
          tx_hash: prefixed(String(r.tx_hash)),
          sold_token: prefixed(String(r.sold_token)),
          sold_amount: String(r.sold_amount ?? ""),
          bought_token: prefixed(String(r.bought_token)),
          bought_amount: String(r.bought_amount ?? ""),
          priced: r.priced as PricedRow["priced"],
          eth_usd: decimalString(r.eth_usd) ?? "",
        })),
      )
    },
  }
}
