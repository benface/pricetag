p='src/core/portfolio.ts'; s=open(p).read()
s=s.replace('leg.proceedsUsdMicros !== null || leg.pieces !== undefined)','leg.proceedsUsdMicros !== null || leg.pieces?.some((piece) => piece.costUsdMicros !== null))')
open(p,'w').write(s)

# raw.ts: counterparties
p='server/raw.ts'; s=open(p).read()
s=s.replace('''      const eth = { ...base, log_index: 0, token: ETH_ADDRESS, account: me, amount: tx.value, kind: "eth" as const }
      if (from === me) rows.push({ ...eth, side: "debit" })
      if (tx.to !== null && normalizeAddress(tx.to) === me) rows.push({ ...eth, side: "credit" })''','''      const eth = { ...base, log_index: 0, token: ETH_ADDRESS, account: me, amount: tx.value, kind: "eth" as const }
      if (from === me) rows.push({ ...eth, side: "debit", counterparty: tx.to === null ? null : normalizeAddress(tx.to) })
      if (tx.to !== null && normalizeAddress(tx.to) === me) rows.push({ ...eth, side: "credit", counterparty: from })''')
s=s.replace('''      if (first === me) rows.push({ ...row, side: "debit" })
      if (topicToAddress(log.topic2) === me) rows.push({ ...row, side: "credit" })
    } else if (log.topic0 === TRANSFER_SINGLE''','''      if (first === me) rows.push({ ...row, side: "debit", counterparty: topicToAddress(log.topic2) })
      if (topicToAddress(log.topic2) === me) rows.push({ ...row, side: "credit", counterparty: first })
    } else if (log.topic0 === TRANSFER_SINGLE''')
s=s.replace('''/** The `answer` word of a `latestRoundData()` result''','''/**
 * Fills in who was on the other side of each ERC-20 and plain ETH row, from `Transfer` logs and the transactions behind them.
 * The dataset's `legs` table has one row per side, and doesn't say.
 */
export function withCounterparties(rows: readonly LegRow[], account: string, logs: readonly Pick<RawLog, "tx_hash" | "log_index" | "topic1" | "topic2">[], txs: readonly Pick<RawTx, "tx_hash" | "from" | "to">[]): LegRow[] {
  const me = normalizeAddress(account)
  const byLog = new Map(logs.map((log) => [`${normalizeAddress(log.tx_hash)}:${log.log_index}`, log]))
  const byTx = new Map(txs.map((tx) => [normalizeAddress(tx.tx_hash), tx]))
  return rows.map((row) => {
    if (row.kind === "erc20") {
      const log = byLog.get(`${row.tx_hash}:${row.log_index}`)
      if (!log) return row
      const [from, to] = [topicToAddress(log.topic1), topicToAddress(log.topic2)]
      return { ...row, counterparty: row.side === "credit" ? from : to }
    }
    if (row.kind === "eth") {
      const tx = byTx.get(row.tx_hash)
      if (!tx) return row
      if (row.side === "credit") return { ...row, counterparty: normalizeAddress(tx.from) }
      return { ...row, counterparty: tx.to === null ? null : normalizeAddress(tx.to) }
    }
    return row
  })
}

/** Rows' blocks worth looking up, so a wallet's first read doesn't scan every block for the few that touch it. */
export function counterpartyBlocks(rows: readonly LegRow[], account: string): number[] {
  const me = normalizeAddress(account)
  return [...new Set(rows.filter((r) => r.account === me && (r.kind === "erc20" || r.kind === "eth")).map((r) => r.block_num))]
}

/** The `answer` word of a `latestRoundData()` result''')
open(p,'w').write(s)

# source.ts
p='server/source.ts'; s=open(p).read()
s=s.replace('''import type { LegRow, PricedRow, ReferenceRow } from "../src/core/legs.ts"
import type { BalanceSnapshot } from "../src/core/reconcile.ts"
import { ETH_USD_FEED, USDC_USD_FEED, WETH_ADDRESS } from "../src/core/tokens.ts"
''','''import type { LegRow, PricedRow, ReferenceRow } from "../src/core/legs.ts"
import { marketTrades, type MarketTrade } from "../src/core/market.ts"
import { parseNote, type CostNote } from "../src/core/notes.ts"
import type { BalanceSnapshot } from "../src/core/reconcile.ts"
import { ERC20_ADDRESSES, ETH_USD_FEED, USDC_USD_FEED, WETH_ADDRESS } from "../src/core/tokens.ts"
''')
s=s.replace('''import { DEPOSIT_TOPIC, TRANSFER_BATCH_TOPIC, TRANSFER_SINGLE_TOPIC, TRANSFER_TOPIC, WITHDRAWAL_TOPIC, decodeRoundAnswer, legRowsFromRaw, type RawLog, type RawTx } from "./raw.ts"''','''import { DEPOSIT_TOPIC, TRANSFER_BATCH_TOPIC, TRANSFER_SINGLE_TOPIC, TRANSFER_TOPIC, WITHDRAWAL_TOPIC, counterpartyBlocks, decodeRoundAnswer, legRowsFromRaw, withCounterparties, type RawLog, type RawTx } from "./raw.ts"''')
s=s.replace('''  /** What the chain says this wallet holds at `block`, or null when the read gave nothing usable. */
  readBalances(address: string, block: number): Promise<BalanceSnapshot | null>
}''','''  /** What the chain says this wallet holds at `block`, or null when the read gave nothing usable. */
  readBalances(address: string, block: number): Promise<BalanceSnapshot | null>
  /** The cost notes this wallet published in these blocks: zero-value transactions from itself to itself. */
  readNotes?(address: string, blocks: readonly number[]): Promise<CostNote[]>
  /** Whether `readMarketTrades` can be trusted. An older dataset's `priced_legs` has wrong rows, so it can't. */
  marketReady?(): Promise<boolean>
  /** An asset's latest trades in a block range, newest first. Only a dataset's `priced_legs` has them. */
  readMarketTrades?(asset: string, from: number, to: number): Promise<MarketTrade[]>
}''')
s=s.replace('''/** About 2 minutes. A derived table''','''async function readNotesAt(query: Query, dataset: string, address: string, blocks: readonly number[]): Promise<CostNote[]> {
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

/** About 2 minutes. A derived table''')
s=s.replace('''    readBalances: (address, block) => readBalancesAt(query, config.network, address, block),

    async readWindow(address, from, to) {
      const me = hexOf(address)
      const topic =''','''    readBalances: (address, block) => readBalancesAt(query, config.network, address, block),
    readNotes: (address, blocks) => readNotesAt(query, config.baseDataset, address, blocks),

    async readWindow(address, from, to) {
      const me = hexOf(address)
      const topic =''')
s=s.replace('''    readBalances: (address, block) => readBalancesAt(query, config.network, address, block),

    async processedThrough(after, head) {''','''    readBalances: (address, block) => readBalancesAt(query, config.network, address, block),
    readNotes: (address, blocks) => readNotesAt(query, config.baseDataset, address, blocks),

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
      const rows = await readOrEmpty(
        `SELECT block_num, tx_hash, sold_token, sold_amount, bought_token, bought_amount, priced, eth_usd FROM ${ds}.priced_legs
         WHERE block_num BETWEEN ${from} AND ${to} AND get_field(priced, 'token') = '${asset.replace(/[^A-Za-z0-9]/g, "")}'
         ORDER BY block_num DESC LIMIT ${MARKET_ROWS}`,
      )
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

    async processedThrough(after, head) {''')
s=s.replace('''const BLOCKS_PER_QUERY = 200
''','''const BLOCKS_PER_QUERY = 200
/** Enough for the guards in market.ts, which only read the latest few. A busy pool repeats each trade per account. */
const MARKET_ROWS = 300
''')
s=s.replace('''      const rows = legRows.map(toLegRow)
      return {
        // pt_gas leaves the amount empty when the gas can't be worked out, and BigInt can't read that.
        // An unlisted row stays either way, because it's evidence that something moved.
        rows: [...rows.filter((r) => r.amount !== "" && r.amount !== "0"), ...unlistedRows.map(toLegRow)],''','''      const rows = legRows.map(toLegRow)
      const kept = rows.filter((r) => r.amount !== "" && r.amount !== "0")
      // `legs` doesn't say who was on the other side, so that comes from the raw tables, for only the blocks that matter.
      const logs: Pick<RawLog, "tx_hash" | "log_index" | "topic1" | "topic2">[] = []
      const txs: Pick<RawTx, "tx_hash" | "from" | "to">[] = []
      const allowlist = ERC20_ADDRESSES.map((a) => `X'${hexOf(a)}'`).join(", ")
      const topic = `X'${me.padStart(64, "0")}'`
      for (const { filter } of blockFilters(counterpartyBlocks(kept, address))) {
        const logRows = await query<Row>(`SELECT tx_hash, log_index, topic1, topic2 FROM "${config.baseDataset}".logs WHERE ${filter} AND topic0 = X'${TRANSFER_TOPIC}' AND address IN (${allowlist}) AND (topic1 = ${topic} OR topic2 = ${topic})`)
        logs.push(...logRows.map((l) => ({ tx_hash: prefixed(String(l.tx_hash)), log_index: asNumber(l.log_index), topic1: String(l.topic1), topic2: String(l.topic2) })))
        const txRows = await query<Row>(`SELECT tx_hash, "from", "to" FROM "${config.baseDataset}".transactions WHERE ${filter} AND ("from" = X'${me}' OR "to" = X'${me}') AND value <> '0'`)
        txs.push(...txRows.map((t) => ({ tx_hash: prefixed(String(t.tx_hash)), from: String(t.from), to: t.to == null ? null : String(t.to) })))
      }
      return {
        // pt_gas leaves the amount empty when the gas can't be worked out, and BigInt can't read that.
        // An unlisted row stays either way, because it's evidence that something moved.
        rows: [...withCounterparties(kept, address, logs, txs), ...unlistedRows.map(toLegRow)],''')
s=s.replace('''const asNumber = (value: unknown) => Number(value)''','''const asNumber = (value: unknown) => Number(value)
const isMissingTable = (error: unknown) => /table .*not found|not found.*table|does not exist|unknown table/i.test(describeError(error))''')
s=s.replace('import { decimalString, isNotStarted, type Query } from "./amp.ts"','import { decimalString, describeError, isNotStarted, type Query } from "./amp.ts"')
open(p,'w').write(s)

# wallets.ts
p='server/wallets.ts'; s=open(p).read()
s=s.replace('''import { buildPricedLegs, derivePricedRows, answerToMicros, type LegRow, type PricedRow, type ReferenceRow } from "../src/core/legs.ts"
import type { LatestPrices } from "../src/core/portfolio.ts"
import { openingLegs, type BalanceSnapshot } from "../src/core/reconcile.ts"
import { ASSETS } from "../src/core/tokens.ts"
''','''import { buildPricedLegs, derivePricedRows, answerToMicros, type LegRow, type PricedRow, type ReferenceRow } from "../src/core/legs.ts"
import { MARKET_MAX_AGE_BLOCKS, marketPrice, type MarketPrice } from "../src/core/market.ts"
import type { CostNote } from "../src/core/notes.ts"
import type { LatestPrices } from "../src/core/portfolio.ts"
import { openingLegs, type BalanceSnapshot } from "../src/core/reconcile.ts"
import { ASSETS, TOKENS, tokenByAddress } from "../src/core/tokens.ts"
''')
s=s.replace('''  /** L1 fees by transaction. See `isL1FeeSettled`. */
  l1Fees: Map<string, L1Fee>
}
''','''  /** L1 fees by transaction. See `isL1FeeSettled`. */
  l1Fees: Map<string, L1Fee>
  notes: CostNote[]
  /** Blocks already checked for notes, so each is only read once it's past the part of the chain re-read for reorgs. */
  notesReadTo: number
  /** Market prices were all read this time. */
  marketChecked: boolean
}
''')
s=s.replace('''/** A gas row's L1 fee, as a row of its own beside it. */''','''/** Rows that aren't a trade with a price of its own, so a market price is what would price them. */
export function marketNeeds(rows: readonly LegRow[], priced: readonly PricedRow[]): { asset: string; block: number }[] {
  const swapped = new Set(priced.filter((p) => p.priced.source === "swap").map((p) => p.tx_hash))
  return rows.flatMap((row) => {
    const token = tokenByAddress(row.token)
    return !token || token.oracle || swapped.has(row.tx_hash) ? [] : [{ asset: token.asset, block: row.block_num }]
  })
}

/** A price for each block in a bucket, so a thousand transfers don't make a thousand queries. Always at or before the block. */
const MARKET_BUCKET_BLOCKS = 150
/** A current price moves on faster. */
const MARKET_HEAD_BUCKET_BLOCKS = 30
/** Each read is a query, and they run one at a time. What's left waits for the next refresh, and has no price until then. */
const MARKET_READS_PER_REFRESH = 20
const bucketOf = (block: number, size = MARKET_BUCKET_BLOCKS) => block - (block % size)
const MARKET_ASSETS = TOKENS.filter((t) => !t.oracle).map((t) => t.asset)

/** A gas row's L1 fee, as a row of its own beside it. */''')
s=s.replace('''  const inflight = new Map<string, Promise<Cached>>()
''','''  const inflight = new Map<string, Promise<Cached>>()
  /** Prices by `<asset>:<bucket>`, null when too little trading backs one. A failed read isn't in here, so it's tried again. */
  const market = new Map<string, MarketPrice | null>()
  let marketReady: boolean | null = null

  /** Reads what's missing, and says whether everything asked for is now known. */
  async function loadMarket(wanted: readonly { asset: string; bucket: number }[]): Promise<boolean> {
    if (!source.readMarketTrades || !source.marketReady) return false
    try {
      marketReady ??= await source.marketReady()
    } catch (error) {
      console.error("Market check failed:", describeError(error))
      return false
    }
    if (!marketReady) return false
    const missing = [...new Map(wanted.map((w) => [`${w.asset}:${w.bucket}`, w])).entries()].filter(([key]) => !market.has(key))
    for (const [key, { asset, bucket }] of missing.slice(0, MARKET_READS_PER_REFRESH)) {
      try {
        market.set(key, marketPrice(await source.readMarketTrades(asset, bucket - MARKET_MAX_AGE_BLOCKS, bucket), asset, bucket))
      } catch (error) {
        console.error("Market read failed:", describeError(error))
        return false
      }
    }
    return missing.length <= MARKET_READS_PER_REFRESH
  }
''')
s=s.replace('''    let opening = cached?.opening ?? null
    let closing = cached?.closing ?? null''','''    // A transaction with only gas in it is what a note looks like. Anything near the tip could still change, so it's read again.
    let notes = cached?.notes ?? []
    let notesReadTo = cached?.notesReadTo ?? fromBlock - 1
    const settled = coveredTo - REORG_BLOCKS
    if (source.readNotes && coveredTo >= fromBlock) {
      const movers = new Set(rows.filter((r) => r.kind !== "gas" && r.kind !== "l1_fee").map((r) => r.tx_hash))
      const noteBlocks = [...new Set(rows.filter((r) => r.kind === "gas" && !movers.has(r.tx_hash) && r.block_num > notesReadTo).map((r) => r.block_num))]
      const read = await source.readNotes(address, noteBlocks)
      notes = [...notes.filter((n) => n.blockNum <= notesReadTo), ...read]
      if (settled > notesReadTo) notesReadTo = settled
    }

    let opening = cached?.opening ?? null
    let closing = cached?.closing ?? null''')
s=s.replace('''    if (latest && usdc) prices.USDC = { usdMicros: usdc, source: "oracle", blockNum: latest.block_num }

    const next: Cached = { fromBlock, coveredTo, rows, priced, references: known, prices, latest: head, gasUnknownTxs, opening, closing, lastBalances, l1Fees }''','''    if (latest && usdc) prices.USDC = { usdMicros: usdc, source: "oracle", blockNum: latest.block_num }

    // A price at the end of what's covered, for what's held, and one for each movement a trade doesn't already price.
    const headBucket = bucketOf(Math.min(coveredTo, head.blockNum), MARKET_HEAD_BUCKET_BLOCKS)
    const heldAssets = MARKET_ASSETS.filter((asset) => rows.some((r) => tokenByAddress(r.token)?.asset === asset) || BigInt(opening?.amounts[asset] ?? "0") > 0n || BigInt(closing?.amounts[asset] ?? "0") > 0n)
    const marketChecked = await loadMarket([
      ...heldAssets.map((asset) => ({ asset, bucket: headBucket })),
      ...marketNeeds(rows, priced).map(({ asset, block }) => ({ asset, bucket: bucketOf(block) })),
    ])
    for (const asset of heldAssets) {
      const price = market.get(`${asset}:${headBucket}`)
      if (price) prices[asset] = { usdMicros: price.usdMicros, source: "market", blockNum: price.blockNum }
    }

    const next: Cached = { fromBlock, coveredTo, rows, priced, references: known, prices, latest: head, gasUnknownTxs, opening, closing, lastBalances, l1Fees, notes, notesReadTo, marketChecked }''')
s=s.replace('''...buildPricedLegs({ account: key, rows: [...wallet.rows, ...l1.rows], references, priced: wallet.priced })],''','''...buildPricedLegs({ account: key, rows: [...wallet.rows, ...l1.rows], references, priced: wallet.priced, market: (asset, block) => market.get(`${asset}:${bucketOf(block)}`)?.usdMicros ?? null })],''')
s=s.replace('''      unreadBalances: wallet.coveredTo >= wallet.fromBlock ? ASSETS.filter((asset) => closing?.amounts[asset] === undefined) : [],
''','''      unreadBalances: wallet.coveredTo >= wallet.fromBlock ? ASSETS.filter((asset) => closing?.amounts[asset] === undefined) : [],
      notes: wallet.notes,
      marketChecked: wallet.marketChecked,
      unlistedTokens: [...new Set(wallet.rows.filter((r) => r.kind === "unlisted" || r.kind === "unlisted_nft").map((r) => r.token))],
''')
open(p,'w').write(s)

# server/portfolio.ts
p='server/portfolio.ts'; s=open(p).read()
s=s.replace('''import { hasStarted, isBehind, type ExplanationLeg, type ExplanationResponse, type PnlStatus, type PortfolioPosition, type PortfolioResponse, type WalletResponse } from "../src/core/api.ts"
''','''import { hasStarted, isBehind, type ExplanationLeg, type ExplanationResponse, type PortfolioPosition, type PortfolioResponse, type WalletResponse } from "../src/core/api.ts"
import { emptyBook, type Book } from "../src/core/book.ts"
''')
s=s.replace('''import { foldPositions, pnlOverTime, sumTotals, unconfirmedAssets, unreadAssets, type LegEffect, type Position, type Totals } from "../src/core/portfolio.ts"
''','''import { foldBook, missingWallets, type LegEffect, type Position } from "../src/core/portfolio.ts"
import type { Question } from "../src/core/resolve.ts"
''')
s=s.replace('''function positionOf({ asset, decimals, price, values, state, effects, reconciliation }: Position): PortfolioPosition {''','''function positionOf({ asset, decimals, price, values, state, effects, reconciliation, noMarket, estimates }: Position, questions: readonly Question[]): PortfolioPosition {''')
s=s.replace('''legCount: effects.length, reconciliation }
}''','''legCount: effects.length, reconciliation, noMarket, estimates, resolvable: BigInt(values.unknownCostQty) > 0n && questions.some((q) => q.arrivals.some((a) => a.asset === asset)) }
}''')
a=s.index('function pnlStatusOf'); b=s.index('export function portfolioOf')
s=s[:a]+s[b:]
a=s.index('export function portfolioOf'); b=s.index('function legOf')
s=s[:a]+'''export function portfolioOf(wallet: WalletResponse, method: Method, others: readonly WalletResponse[] = [], book: Book = emptyBook()): PortfolioResponse {
  const { positions, unread, totals, pnlStatus, points, questions, meter } = foldBook(wallet, others, method, book)
  return {
    address: wallet.address,
    mode: wallet.mode,
    method,
    coverage: wallet.coverage,
    // ETH is the allowlist's first entry, and everything else is a token.
    trackedTokens: TOKENS.length - 1,
    latest: wallet.latest,
    progress: { started: hasStarted(wallet), behindBlocks: isBehind(wallet) ? wallet.latest.blockNum - wallet.coverage.toBlock : 0 },
    gasUnknownTxs: wallet.gasUnknownTxs,
    l1FeeUnknownTxs: wallet.l1FeeUnknownTxs,
    openingUnread: wallet.openingUnread,
    unreadAssets: unread,
    positions: positions.map((position) => positionOf(position, questions)),
    totals,
    pnlStatus,
    points,
    questions,
    meter,
    linkedReading: missingWallets(book, wallet.address, others),
    unlistedTokens: wallet.unlistedTokens.length,
    marketChecked: wallet.marketChecked,
  }
}

'''+s[b:]
s=s.replace('''    costLabel: leg.costLabel,
    blockNum: leg.blockNum,''','''    costLabel: leg.costLabel,
    estimated: leg.estimated === true,
    partlyUnknown: leg.pieces !== undefined && leg.pieces.some((p) => p.costUsdMicros === null) && leg.pieces.some((p) => p.costUsdMicros !== null),
    blockNum: leg.blockNum,''')
s=s.replace('''export function explainPortfolio(wallet: WalletResponse, method: Method, target: ExplainTarget): ExplanationResponse | null {
  const positions = foldPositions(wallet.legs, method, wallet.prices, wallet)
  const unread = unreadAssets(positions, wallet)
  const explanation = ((): Explanation | null => {
    if (target.kind === "total") return explainTotal(positions, sumTotals(positions, unread), target.metric)''','''export function explainPortfolio(wallet: WalletResponse, method: Method, target: ExplainTarget, others: readonly WalletResponse[] = [], book: Book = emptyBook()): ExplanationResponse | null {
  const { positions, totals, points } = foldBook(wallet, others, method, book)
  const explanation = ((): Explanation | null => {
    if (target.kind === "total") return explainTotal(positions, totals, target.metric)''')
s=s.replace('''    const point = pnlOverTime(wallet.legs, method, wallet.prices, wallet.references, wallet.latest, unconfirmedAssets(positions, unread)).find((p) => p.txHash === target.txHash)
''','''    const point = points.find((p) => p.txHash === target.txHash)
''')
open(p,'w').write(s)

# server/app.ts
p='server/app.ts'; s=open(p).read()
s=s.replace('''import { DEMO_ADDRESS, DEMO_WALLET } from "../src/core/fixtures.ts"
import type { Method } from "../src/core/fold.ts"
''','''import { answerSender, emptyBook, linkedWallets, parseBook, type Book } from "../src/core/book.ts"
import { parseCoinbaseCsv } from "../src/core/exchange-import.ts"
import { exportCsv } from "../src/core/export.ts"
import { DEMO_ADDRESS, DEMO_WALLET, demoWallet } from "../src/core/fixtures.ts"
import type { Method } from "../src/core/fold.ts"
import { foldBook, previewBook } from "../src/core/portfolio.ts"
''')
s=s.replace('''import { explainPortfolio, parseExplainTarget, portfolioOf } from "./portfolio.ts"
''','''import { verifyLink } from "./links.ts"
import { explainPortfolio, parseExplainTarget, portfolioOf } from "./portfolio.ts"
''')
s=s.replace('''export function createApi(env: Env) {''','''/** Answers, CSVs and signatures are small. Anything bigger isn't one of them. */
const MAX_BODY_BYTES = 8_000_000

/**
 * A request's JSON body, or null when it isn't one. Requiring the JSON type keeps a page in the browser from posting here
 * without the server's say-so, and this server never gives it.
 */
async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) return null
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    return null
  }
}

const recordOf = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null)

export function createApi(env: Env) {''')
s=s.replace('''    if (address === "demo" || address === DEMO_ADDRESS) return DEMO_WALLET
    if (!isAddress(address)) {''','''    if (address === "demo" || address === DEMO_ADDRESS) return DEMO_WALLET
    const demo = demoWallet(address)
    if (demo) return demo
    if (!isAddress(address)) {''')
s=s.replace('''  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {''','''  /**
   * The linked wallets already read. Never waits on one, because it can take a while, and a number shouldn't: it starts the
   * read, and what came from that wallet stays unresolved until the next request finds it.
   */
  function linkedOf(focus: string, books: readonly Book[]): WalletResponse[] {
    const addresses = new Set(books.flatMap(linkedWallets))
    return [...addresses].flatMap((address) => {
      if (address === focus.toLowerCase()) return []
      const demo = demoWallet(address)
      if (demo) return [demo]
      if (address === DEMO_ADDRESS) return [DEMO_WALLET]
      if (!wallets) return []
      void wallets.get(address).catch((error: unknown) => console.error("Linked wallet read failed:", describeError(error)))
      const read = wallets.peek(address)
      return read ? [read] : []
    })
  }

  async function handlePost(path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = recordOf(await readJson(req))
    if (!body) return sendJson(res, 400, { error: "This needs a JSON body." })

    if (path === "/api/import/coinbase") {
      const imported = typeof body.csv === "string" ? parseCoinbaseCsv(body.csv) : null
      if (!imported) return sendJson(res, 400, { error: "That doesn't look like a Coinbase transaction history." })
      return sendJson(res, 200, imported)
    }
    if (path === "/api/links/verify") {
      const { owner, address, signature } = body
      if (typeof owner !== "string" || typeof address !== "string" || typeof signature !== "string" || !isAddress(owner) || !isAddress(address)) return sendJson(res, 400, { error: "That needs two addresses and a signature." })
      return sendJson(res, 200, { verified: await verifyLink(owner, address, signature) })
    }

    const match = /^\\/api\\/portfolio\\/([^/]+)(?:\\/(explain|preview|export))?$/.exec(path)
    if (!match) return sendJson(res, 404, { error: "Not found" })
    const method = parseMethod(typeof body.method === "string" ? body.method : null)
    if (!method) return sendJson(res, 400, { error: "The method is either average or fifo." })
    const book = body.book === undefined ? emptyBook() : parseBook(body.book)
    if (!book) return sendJson(res, 400, { error: "Those answers can't be read." })
    const action = match[2]

    if (action === "preview") {
      const candidates = Array.isArray(body.candidates) ? body.candidates.map(parseBook) : null
      if (!candidates || candidates.includes(null) || candidates.length > 8) return sendJson(res, 400, { error: "Those answers can't be read." })
      const wallet = await readWallet(match[1] as string, res, { fresh: false })
      if (!wallet) return
      const books = candidates as Book[]
      const others = linkedOf(wallet.address, books)
      return sendJson(res, 200, { previews: books.map((candidate) => previewBook(wallet, others, method, candidate)) })
    }

    const target = action === "explain" ? parseExplainTarget(new URL(req.url ?? "/", "http://localhost").searchParams) : null
    if (action === "explain" && !target) return sendJson(res, 400, { error: "That isn't a number this can explain." })
    const wallet = await readWallet(match[1] as string, res, { fresh: action === undefined })
    if (!wallet) return
    const others = linkedOf(wallet.address, [book])
    if (action === "export") {
      res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store" })
      res.end(exportCsv(foldBook(wallet, others, method, book).positions))
      return
    }
    if (!target) return sendJson(res, 200, portfolioOf(wallet, method, others, book))
    const explanation = explainPortfolio(wallet, method, target, others, book)
    if (explanation) sendJson(res, 200, explanation)
    else sendJson(res, 404, { error: "This wallet has nothing like that." })
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {''')
s=s.replace('''    if (req.method !== "GET") {
      sendJson(res, 405''','''    if (req.method === "POST") {
      await handlePost(path, req, res)
      return true
    }
    if (req.method !== "GET") {
      sendJson(res, 405''')
s=s.replace('import { answerSender, emptyBook, linkedWallets, parseBook, type Book } from','import { emptyBook, linkedWallets, parseBook, type Book } from')
open(p,'w').write(s)
