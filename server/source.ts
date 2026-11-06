// Where a wallet's rows come from when the Pricetag dataset isn't deployed: the raw Base dataset, read through the same
// shapes as the dataset's `datasetSource`, so everything after this file doesn't care which one it was.
//
// Every query is bounded by block, because staging is shared.

import { CURRENCIES, ERC20_ADDRESSES, ETH_ADDRESS, ETH_USD_FEED, MAX_ROUND_AGE_SECONDS, MIN_TRADE_USD_MICROS, TOKENS, TOKEN_FEEDS, USDC_USD_FEED, WETH_ADDRESS, blockBefore, marketTrades, parseNote, type CostNote, type CurrencyCode, type FeedRound, type MarketTrade, type PricedRow, type RateRound } from "@pricetag/sdk/core"
import { asIso, asNumber, blockFilters, blockRanges, datasetReader, datasetSource, decimalString, describeError, hexOf, isNotStarted, prefixed, readBalancesAt, readEthBalancesAt, readHead, readPayoutTxsAt, settledThrough, type Query, type ReadL1Fees, type Row, type Source, type WindowRows } from "@pricetag/sdk/internal"
import { DEPOSIT_TOPIC, TRANSFER_BATCH_TOPIC, TRANSFER_SINGLE_TOPIC, TRANSFER_TOPIC, WITHDRAWAL_TOPIC, counterpartyBlocks, decodeRound, decodeRoundAnswer, legRowsFromRaw, withCounterparties, type RawLog, type RawTx } from "./raw.ts"

/** A currency's answer at each block, leaving out blocks where the read failed. */
export type RoundReader = (currency: CurrencyCode, blocks: readonly number[]) => Promise<Map<number, RateRound>>

/**
 * Exchange rates read from each feed's contract, the way `rawSource` reads the oracle, for an Amp with no rates dataset. It leans on
 * an RPC, and it's what a local Amp has to do, because it has no logs from before its start. See the note on the query's shape in `readReferences`.
 */
export function feedRounds(query: Query, config: { baseDataset: string; network: string }): RoundReader {
  return async (currency, blocks) => {
    const rounds = new Map<number, RateRound>()
    const address = CURRENCIES[currency].feed?.address
    if (!address) return rounds
    for (const { filter, count } of blockFilters(blocks)) {
      const rows = await query<Row>(
        `SELECT block_num, rpc.${config.network}.eth_call(NULL, evm_encode_hex('${address}'), evm_encode_params('latestRoundData()'), block_num) AS round
         FROM (SELECT block_num FROM "${config.baseDataset}".blocks WHERE ${filter} LIMIT ${count})`,
      )
      for (const row of rows) {
        const round = decodeRound((row.round as { data?: string } | null)?.data)
        if (round) rounds.set(asNumber(row.block_num), round)
      }
    }
    return rounds
  }
}

/**
 * Exchange rates from Chainlink's `AnswerUpdated` logs, in the rates dataset. A rate at a block is the feed's latest update at or
 * before it, which is what the contract answers there, so it needs no RPC.
 *
 * The table only has a row when a feed updates, so its newest row, from any feed, is the only sign of how far it's reached. It
 * writes in block order, so before that row it's complete. From that row on, an update could still be on its way, and an old
 * answer would quietly be wrong, so those blocks go to `exact`, which reads the contract. That's usually the head and a few
 * recent blocks. If the table stops, everything after it does, which is slower but still right.
 */
export function updateRounds(query: Query, dataset: string, exact: RoundReader): RoundReader {
  return async (currency, blocks) => {
    const rounds = new Map<number, RateRound>()
    const wanted = [...blocks].sort((a, b) => a - b)
    const first = wanted[0]
    if (first === undefined) return rounds
    const sql = `SELECT block_num, currency, answer, updated_at FROM "${dataset}".rate_updates WHERE block_num >= ${blockBefore(first, MAX_ROUND_AGE_SECONDS * 1000)} ORDER BY block_num, log_index`
    const rows = await query<Row>(sql).catch((error: unknown) => {
      if (isNotStarted(error)) return [] as Row[]
      throw error
    })
    const covered = asNumber(rows.at(-1)?.block_num ?? 0)
    let at = 0
    let latest: Row | null = null
    for (const block of wanted.filter((block) => block < covered)) {
      while (at < rows.length && asNumber((rows[at] as Row).block_num) <= block) {
        const row = rows[at++] as Row
        if (row.currency === currency) latest = row
      }
      if (latest) rounds.set(block, { answer: String(latest.answer), updatedAt: Number(latest.updated_at) })
    }
    const past = wanted.filter((block) => block >= covered)
    if (past.length > 0) for (const [block, round] of await exact(currency, past)) rounds.set(block, round)
    return rounds
  }
}

/** One query however many feeds, in the same shape: a wallet that holds several asks for them all at once. */
function readFeedRoundsAt(query: Query, config: { baseDataset: string; network: string }): NonNullable<Source["readFeedRounds"]> {
  return async (assets, block) => {
    const feeds = assets.flatMap((asset) => {
      const feed = TOKEN_FEEDS[asset]
      return feed ? [{ asset, address: feed.address }] : []
    })
    if (feeds.length === 0) return {}
    const calls = feeds.map(({ address }, i) => `rpc.${config.network}.eth_call(NULL, evm_encode_hex('${address}'), evm_encode_params('latestRoundData()'), block_num) AS f${i}`)
    const { filter, count } = blockFilters([block])[0] as { filter: string; count: number }
    const [row] = await query<Row>(`SELECT block_num, timestamp, ${calls.join(", ")} FROM (SELECT block_num, timestamp FROM "${config.baseDataset}".blocks WHERE ${filter} LIMIT ${count})`)
    if (!row) return {}
    const rounds: Record<string, FeedRound> = {}
    feeds.forEach(({ asset }, i) => {
      const round = decodeRound((row[`f${i}`] as { data?: string } | null)?.data)
      if (round) rounds[asset] = { ...round, blockNum: asNumber(row.block_num), timestamp: asIso(row.timestamp) }
    })
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

export function rawSource(query: Query, config: { baseDataset: string; network: string; historyBlocks: number | null }): Source {
  const ds = `"${config.baseDataset}"`

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
         FROM ${ds}.transactions WHERE ${range} AND ("from" = X'${me}' OR "to" = X'${me}')`,
      )
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
           )`,
        )
      ).map(toLog)

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
          baseFeeByBlock: new Map(baseFees.map((b) => [asNumber(b.block_num), decimalString(b.base_fee_per_gas) ?? "0"])),
        },
      })
      return { rows, priced: null, gasUnknown }
    },
  }
}

const isMissingTable = (error: unknown) => /table .*not found|not found.*table|does not exist|unknown table/i.test(describeError(error))

/** Plenty for the guards in market.ts once small trades are left out, even though a busy pool repeats each trade per account. */
const MARKET_ROWS = 300

/** As many as `createWallets` keeps, so a wallet it still holds is here too. */
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

/** 5,000 blocks of `logs` took 3.8 s on staging, against about 7 s for the same blocks named 200 at a time. */
const COUNTERPARTY_SPAN = 5_000

/** What's been read of a wallet: its rows from `from` to `to`, and the answers for blocks that were past any reorg by then. */
type SharedWallet = Pick<WindowRows, "rows" | "gasUnknown"> & { from: number; to: number; notes: Map<number, CostNote[]>; ethBalances: Map<number, string> }

/**
 * The reads of a wallet that no pricing rule changes, each done once however many rules ask. Rules read one after the
 * other, so the second usually wants a few blocks more than the first. Blocks a reorg could still reach are always read
 * again, and everything older comes from what's held, until `rewind` says a reorg went further back than that.
 */
export function sharedReads(query: Query, config: { baseDataset: string; dataset: string; network: string }) {
  const reader = datasetReader(query, config)
  const base = `"${config.baseDataset}"`
  const wallets = new Map<string, SharedWallet>()
  const turns = new Map<string, Promise<void>>()
  const reorgs: Reorg[] = []

  // One at a time per wallet, so a read that starts while another is running can use what that one found.
  function inTurn<T>(address: string, read: () => Promise<T>): Promise<T> {
    const turn = (turns.get(address) ?? Promise.resolve()).then(read)
    turns.set(address, turn.then(() => {}, () => {}))
    return turn
  }

  /** The rows in a range, with who was on the other side. `legs` doesn't say, so that comes from the raw tables, for only the blocks that matter. */
  async function readRows(address: string, from: number, to: number): Promise<Pick<WindowRows, "rows" | "gasUnknown">> {
    const window = await reader.readLegs(address, from, to)
    const me = hexOf(address)
    const topic = `X'${me.padStart(64, "0")}'`
    const allowlist = ERC20_ADDRESSES.map((a) => `X'${hexOf(a)}'`).join(", ")
    const logs: Pick<RawLog, "tx_hash" | "log_index" | "topic1" | "topic2">[] = []
    const txs: Pick<RawTx, "tx_hash" | "from" | "to">[] = []
    // What else these ranges find matches no row of this wallet's, so `withCounterparties` never looks at it.
    for (const filter of blockRanges(counterpartyBlocks(window.rows, "erc20"), COUNTERPARTY_SPAN)) {
      const logRows = await query<Row>(`SELECT tx_hash, log_index, topic1, topic2 FROM ${base}.logs WHERE ${filter} AND topic0 = X'${TRANSFER_TOPIC}' AND address IN (${allowlist}) AND (topic1 = ${topic} OR topic2 = ${topic})`)
      logs.push(...logRows.map((l) => ({ tx_hash: prefixed(String(l.tx_hash)), log_index: asNumber(l.log_index), topic1: String(l.topic1), topic2: String(l.topic2) })))
    }
    for (const filter of blockRanges(counterpartyBlocks(window.rows, "eth"), COUNTERPARTY_SPAN)) {
      const txRows = await query<Row>(`SELECT tx_hash, "from", "to" FROM ${base}.transactions WHERE ${filter} AND ("from" = X'${me}' OR "to" = X'${me}') AND value <> '0'`)
      txs.push(...txRows.map((t) => ({ tx_hash: prefixed(String(t.tx_hash)), from: String(t.from), to: t.to == null ? null : String(t.to) })))
    }
    return { ...window, rows: withCounterparties(window.rows, logs, txs) }
  }

  return {
    readLegs: (address: string, from: number, to: number) =>
      inTurn(address, async () => {
        const held = wallets.get(address)
        const extended = held && held.from <= from && from <= held.to + 1 ? held : null
        // Until the tables get past a reorg, every read goes back to it, however far that is.
        const readFrom = extended ? Math.max(extended.from, Math.min(settledThrough(extended.to) + 1, unsettledFrom(extended.to, reorgs) ?? Infinity)) : from
        const read = readFrom <= to ? await readRows(address, readFrom, to) : { rows: [], gasUnknown: [] }
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
        wallets.set(address, next)
        if (wallets.size > MAX_SHARED_WALLETS) wallets.delete(wallets.keys().next().value as string)
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

/**
 * The SDK's `datasetSource`, plus what only working out a cost needs: who was on the other side, notes, and market prices.
 * Pricing rules of one wallet history pass the same `shared`, so only what a rule changes is read for each.
 */
export function resolvingSource(query: Query, config: { baseDataset: string; dataset: string; priceDataset?: string; startBlock: number; network: string }, shared = sharedReads(query, config)): Source {
  const { readPricedOf } = datasetReader(query, config)
  const ds = `"${config.dataset}"`
  // What a fork of the pricing rule changes, so its market prices come from its own trades.
  const prices = `"${config.priceDataset ?? config.dataset}"`
  return {
    ...datasetSource(query, config),
    readNotes: shared.readNotes,
    readEthBalances: shared.readEthBalances,
    readFeedRounds: readFeedRoundsAt(query, config),

    async readWindow(address, from, to) {
      const legs = await shared.readLegs(address, from, to)
      return { ...legs, priced: await readPricedOf(legs.rows, address, from, to) }
    },

    async marketReady() {
      // Only a dataset with the fix for wrong `priced_legs` rows has this table. Asking it for no rows tells them apart.
      try {
        await query<Row>(`SELECT block_num FROM ${ds}.unlisted_moves WHERE block_num BETWEEN ${config.startBlock} AND ${config.startBlock} LIMIT 1`, 15_000)
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
