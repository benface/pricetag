// What another app builds on: a wallet's portfolio, its priced legs and a token's prices, read from the Pricetag dataset.
// Everything keeps its price source and transaction, and what can't be priced stays unknown.

import { createQuery, createRangeStream, describeError, type Logger, type Query, type StreamRanges } from "./amp.ts"
import { isMainCurrency, type CurrencyCode, type Rates, type WalletView } from "./currency.ts"
import { ORACLE_TABLES, SWAP_TABLES, WALLET_TABLES, datasetReader, datasetSource, followSql, readBlockHashes, readFeedRoundsAt, readHeadMark } from "./dataset.ts"
import type { Method } from "./fold.ts"
import { answerToMicros, buildPricedLegs, type LegRow, type PricedLeg, type PriceSource, type Reference } from "./legs.ts"
import { followChain, type FollowConfig, type Via } from "./live.ts"
import { latestPrices, type Head, type LatestPrices } from "./portfolio.ts"
import { createRates, feedRounds, updateRounds } from "./rates.ts"
import { createL1FeeReader, type ReadL1Fees } from "./receipts.ts"
import { ASSETS, TOKENS, TOKEN_FEEDS, isAddress, normalizeAddress, tokenByAddress, type Token } from "./tokens.ts"
import { describeMissing, foldWallet, hasStarted, type FoldedWallet, type WalletData } from "./wallet.ts"
import { createWallets, feedPrices } from "./wallets.ts"

export type PricetagConfig = {
  /** Amp's query URL. */
  url: string
  /** Leave it out for an Amp that doesn't check tokens, like a local one. */
  token?: string | undefined
  /** The Pricetag dataset, like `benface/pricetag@0.0.1`. */
  dataset: string
  /** The raw dataset the chain's head is read from. */
  baseDataset?: string | undefined
  /**
   * The rates dataset (`dataset/rates.json`), for `getPortfolio`'s `currency`. Without one, each rate is read from its
   * feed's contract, which is slower.
   */
  ratesDataset?: string | undefined
  /** The dataset's first block, which every read starts from unless it says otherwise. */
  startBlock?: number | undefined
  /**
   * Where L1 fees are read from. Without one, `getPortfolio` can't check ETH against the chain for a wallet that sent
   * anything, and `getLegs` can't confirm a swap paid out in unwrapped ETH. Both say so.
   */
  rpcUrl?: string | undefined
  /** Calls a second `rpcUrl` allows, of which L1 fees use 40%. It defaults to 25, for the public RPC. Raise it for a dedicated one, so a very busy wallet can catch up. */
  rpcRateLimit?: number | undefined
  /** The network name Amp knows the chain by, as in `rpc.base_mainnet.eth_call`, which reads onchain balances and price feeds. */
  network?: string | undefined
  /** How long one query can take, in ms. It defaults to 60 s. Queries still run one at a time, because a hosted Amp is shared. */
  timeoutMs?: number | undefined
  /** Gets slow queries, and reads that failed and will be retried. It defaults to `console`. */
  logger?: Logger | undefined
}

/** Blocks to read, inclusive. Without `from`, it starts at the config's `startBlock`. Without `to`, it reads up to the chain's head. */
export type BlockRange = { from?: number | undefined; to?: number | undefined }

export type PortfolioOptions = BlockRange & {
  /** How to work out the cost of what's sold. It defaults to `average`. */
  method?: Method | undefined
  /** What to show the money in. It defaults to `USD`. Each amount converts at the rate when it happened, and a missing rate makes it unknown. */
  currency?: CurrencyCode | undefined
}

export type WatchOptions = Omit<PortfolioOptions, "to"> & {
  /** Stops watching. Leaving a `for await` does too. */
  signal?: AbortSignal | undefined
}

/**
 * read: every L1 fee this wallet paid is in the numbers. pending: some couldn't be read yet, and the next call tries again.
 * no rpc url: they're missing, because the config has no `rpcUrl`.
 */
export type L1FeeStatus = "read" | "pending" | "no rpc url"

/**
 * The blocks actually read, which `toBlock` can leave short of what was asked while a table this read uses catches up.
 * `toBlock` is below `fromBlock` when nothing in the range has been processed yet. No rows then doesn't mean nothing happened.
 */
export type BlocksRead = { fromBlock: number; toBlock: number }

export type WalletLegs = {
  address: string
  blocks: BlocksRead
  /** In order for the fold. Each has its `txHash`, `priceSource` and, when it has no price, a `priceNote` saying why. */
  legs: PricedLeg[]
  /** The oracle reads at the blocks of those legs. `referenceMarks` turns them into what `pnlOverTime` takes. */
  references: Reference[]
  /** Transactions this wallet sent whose gas couldn't be worked out, so ETH is overstated by that much. */
  gasUnknownTxs: string[]
  l1Fees: L1FeeStatus
  /** Transactions whose gas legs leave out their L1 fee. A swap paid out in unwrapped ETH in one of them stays unknown. */
  l1FeeUnknownTxs: string[]
}

/** A wallet's holdings, cost and PnL in `currency`, the same way the app works them out. */
export type WalletPortfolio = Omit<FoldedWallet, "view"> & {
  address: string
  method: Method
  /** What every amount of money here is in. */
  currency: CurrencyCode
  /** What one USD buys now, or null when USD is the currency, or there's no current rate, so nothing held has a current value. */
  latestRate: WalletView["latestRate"]
  /** Transactions with an amount that couldn't be converted, so it's unknown here. */
  missingRateTxs: string[]
  blocks: BlocksRead
  /** False until the dataset has processed `blocks.fromBlock`. Until then there are no totals, and no rows doesn't mean nothing happened. */
  started: boolean
  /** What these numbers leave out, in words. Show it next to any total. Empty when nothing is. */
  missing: string[]
  /** In order for the fold, starting with what the wallet already held, as opening legs. */
  legs: PricedLeg[]
  gasUnknownTxs: string[]
  l1Fees: L1FeeStatus
  l1FeeUnknownTxs: string[]
  /** Assets whose balance before `blocks.fromBlock` couldn't be read, so they can't be compared yet. */
  openingUnread: string[]
  /**
   * The first block a reorg replaced that the dataset may not have rewritten yet, or null. These numbers can still hold the
   * old blocks from here on, and the next reads replace them.
   */
  unsettledFrom: number | null
}

/** A wallet's portfolio, after a block, in full. Replace the last one with it. Nothing in it adds to what came before. */
export type WalletUpdate = WalletPortfolio & {
  /** What said there was a new block, or null for the first update, which is what the wallet already was. */
  via: Via | null
  /** The first block a reorg replaced since the last update, or null when none did. */
  reorgFrom: number | null
}

export type PricePoint = {
  blockNum: number
  timestamp: string
  /** USD price of one whole token, or null when it's unknown. */
  usdMicros: string | null
  source: PriceSource | "unknown"
  /** The swap this price comes from. Null for an oracle, which is read at a block, not in a transaction. */
  txHash: string | null
  /** The account whose swap this is. One transaction can have several, like a trader and a pool. */
  account: string | null
  /** Why this price is unknown. */
  note: string | null
}

export type TokenPrices = {
  /** The allowlist's symbol for the token. */
  token: string
  blocks: BlocksRead
  prices: PricePoint[]
}

const DEFAULT_NETWORK = "base_mainnet"

const isBlock = (block: number) => Number.isSafeInteger(block) && block > 0

/** Rates for a wallet that has nothing read yet: none, so it can't pass for USD. */
const NO_RATES: Rates = { byBlock: {}, latest: null }

function checkCurrency(currency: string) {
  if (!isMainCurrency(currency)) throw new Error(`${currency} isn't a currency Pricetag can show. See MAIN_CURRENCY_CODES.`)
}

function findToken(token: string): Token {
  const found = isAddress(token) ? tokenByAddress(token) : TOKENS.find((t) => t.symbol === token)
  if (!found) throw new Error(`${token} isn't on the allowlist, so it has no price. See TOKENS.`)
  return found
}

export function createPricetag(config: PricetagConfig) {
  if (!config.url) throw new Error("Pricetag needs Amp's query URL")
  const { timeoutMs, logger, rpcUrl, rpcRateLimit } = config
  const stream = createRangeStream(config.url, config.token || undefined, (config.network ?? DEFAULT_NETWORK).replaceAll("_", "-"))
  return pricetagClient(createQuery(config.url, config.token || undefined, { timeoutMs, logger }), { ...config, stream, readL1Fees: rpcUrl ? createL1FeeReader(rpcUrl, fetch, undefined, logger, rpcRateLimit) : undefined })
}

type ClientConfig = Pick<PricetagConfig, "dataset" | "ratesDataset" | "baseDataset" | "startBlock" | "network" | "logger"> & {
  readL1Fees?: ReadL1Fees | undefined
  /** Without one, `watchWallet` polls. */
  stream?: StreamRanges | undefined
  /** The timing of `watchWallet`'s stream and polling, for tests. */
  follow?: Pick<FollowConfig, "pollMs" | "retryMs" | "stallMs" | "tickMs"> | undefined
}

export function pricetagClient(query: Query, config: ClientConfig) {
  if (!config.dataset) throw new Error("Pricetag needs a dataset, like benface/pricetag@0.0.1")
  const { startBlock, readL1Fees, logger = console } = config
  if (startBlock !== undefined && !isBlock(startBlock)) throw new Error(`Bad start block: ${startBlock}. It's the block number the dataset starts from.`)
  const baseDataset = config.baseDataset ?? "edgeandnode/base_mainnet@0.0.2"
  const network = config.network ?? DEFAULT_NETWORK
  const source = datasetSource(query, { dataset: config.dataset, baseDataset, startBlock: startBlock ?? null, network })
  const reader = datasetReader(query, { dataset: config.dataset, baseDataset, startBlock })
  const calls = feedRounds(query, { baseDataset, network })
  const readRates = createRates(config.ratesDataset ? updateRounds(query, config.ratesDataset, calls) : calls)

  // Read just before a wallet is. A wallet's history stays in memory between calls, so each call only reads what's new.
  let chainHead: Head | null = null
  const wallets = createWallets(source, async () => chainHead as Head, readL1Fees ?? (async () => new Map()), config.logger)

  const l1FeeStatus = (unknownTxs: readonly string[]): L1FeeStatus => (unknownTxs.length === 0 ? "read" : readL1Fees ? "pending" : "no rpc url")

  async function readWallet(account: string, from: number, to: number | undefined): Promise<WalletData> {
    chainHead = (await reader.head(chainHead?.blockNum ?? null)) ?? chainHead
    return chainHead ? wallets.get(account, { from, to }) : emptyWallet(account, from)
  }

  /** A range with its first block filled in, or an error saying what's wrong with it. */
  function resolveRange({ from = startBlock, to }: BlockRange): { from: number; to: number | undefined } {
    if (from === undefined) throw new Error("No first block: pass `from`, or `startBlock` in createPricetag's config.")
    if (!isBlock(from) || (to !== undefined && (!Number.isSafeInteger(to) || to < from))) throw new Error(`Bad block range: from ${from} to ${to}. The dataset's start block is the earliest with data.`)
    return { from, to }
  }

  async function blocksRead(range: BlockRange, tables: readonly string[]): Promise<BlocksRead> {
    const { from, to } = resolveRange(range)
    const nothing = { fromBlock: from, toBlock: from - 1 }
    const head = to ?? (await reader.head(from))?.blockNum
    if (head === undefined) return nothing
    const processed = await reader.processedThrough(from, head, tables)
    return processed === null ? nothing : { fromBlock: from, toBlock: processed }
  }

  async function getPortfolio(address: string, { method = "average", currency = "USD", ...range }: PortfolioOptions = {}): Promise<WalletPortfolio> {
    if (!isAddress(address)) throw new Error(`${address} isn't a Base address`)
    checkCurrency(currency)
    const account = normalizeAddress(address)
    const { from, to } = resolveRange(range)
    const read = await readWallet(account, from, to)
    const started = hasStarted(read)
    // A rate that can't be read throws, like any other read. This never falls back to USD.
    const wallet = currency === "USD" ? read : { ...read, currency, rates: started ? await readRates(currency, read, { chainHead: chainHead?.blockNum }) : NO_RATES }
    const { coverage, gasUnknownTxs, l1FeeUnknownTxs, openingUnread } = wallet
    const { view, ...folded } = foldWallet(wallet, method)
    return {
      ...folded,
      address: account,
      method,
      currency,
      latestRate: view.latestRate,
      missingRateTxs: view.missingRateTxs,
      blocks: coverage,
      started,
      missing: started ? [...describeMissing({ totals: folded.totals, gasUnknownTxs, l1FeeUnknownTxs, missingRateTxs: view.missingRateTxs }), ...(currency !== "USD" && !view.latestRate ? ["a current exchange rate, so nothing held has a current value"] : [])] : [`everything, because the dataset hasn't processed block ${from}`],
      legs: view.legs,
      gasUnknownTxs,
      l1Fees: l1FeeStatus(l1FeeUnknownTxs),
      l1FeeUnknownTxs,
      openingUnread,
      unsettledFrom: wallets.unsettledFrom(account, { from, to }),
    }
  }

  return {
    /**
     * A wallet's holdings, cost and PnL, the same way the app works them out: what it held before the range, its L1 fees,
     * and every position checked against the chain. Check `started`, and show `pnlStatus` and `missing` next to any total.
     * With a `to`, it's the wallet as of that block, valued at that block's prices. With a `currency`, its money is in that.
     */
    getPortfolio,

    /**
     * A wallet's portfolio now, then again after each new block, for as long as it's read. Each update is the whole wallet,
     * so a reorg replaces what it changed instead of adding to it. Amp's stream says when there's a block, and polling takes
     * over when it can't. A read that fails goes to the logger, and the next block tries again.
     */
    async *watchWallet(address: string, { signal, method, currency, from }: WatchOptions = {}): AsyncGenerator<WalletUpdate, void, void> {
      if (!isAddress(address)) throw new Error(`${address} isn't a Base address`)
      if (currency) checkCurrency(currency)
      resolveRange({ from })
      const stop = new AbortController()
      const stopping = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal
      const ticks = followChain({ stream: config.stream ?? null, sql: followSql(config.dataset), readMark: (after) => readHeadMark(query, baseDataset, after ?? startBlock ?? null), readHashes: (blocks) => readBlockHashes(query, baseDataset, blocks), logger, ...config.follow }, stopping)
      // Following starts before the first read, which can take a while, so no block or reorg goes by unseen.
      let next = ticks.next()
      let via: Via | null = null
      let reorgFrom: number | null = null
      let shown: number | null = null
      try {
        while (!stopping.aborted) {
          try {
            const portfolio = await getPortfolio(address, { method, currency, from })
            if (portfolio.blocks.toBlock !== shown || reorgFrom !== null) {
              shown = portfolio.blocks.toBlock
              const update: WalletUpdate = { ...portfolio, via, reorgFrom }
              reorgFrom = null
              yield update
            }
          } catch (error) {
            logger.warn(`Couldn't read ${address}, and will try again on the next block: ${describeError(error)}`)
          }
          let tick = await next
          while (!tick.done && tick.value.kind === "down") {
            logger.warn(`Can't reach Amp: ${tick.value.message}`)
            next = ticks.next()
            tick = await next
          }
          if (tick.done) return
          next = ticks.next()
          const { value } = tick
          if (value.kind === "block") {
            via = value.via
            if (value.reorgFrom !== null) {
              reorgFrom = Math.min(reorgFrom ?? value.reorgFrom, value.reorgFrom)
              await wallets.rewind(value.reorgFrom, Math.max(chainHead?.blockNum ?? 0, value.blockNum))
              readRates.rewind?.(value.reorgFrom)
              // The new chain can be shorter, and the head is only read from the last one on.
              if (chainHead && chainHead.blockNum >= value.reorgFrom) chainHead = { ...chainHead, blockNum: value.reorgFrom - 1 }
            }
          }
        }
      } finally {
        stop.abort()
        await ticks.return()
      }
    },

    /**
     * A wallet's legs in the range, priced and labeled the same way the app's are. They're what moved, not what the wallet
     * holds, so there's no opening balance in them, and no position is checked against the chain. For that, use `getPortfolio`.
     *
     * With an `rpcUrl`, these are the app's legs, because they come from the same read: gas includes L1 fees, and a swap
     * paid out in unwrapped ETH is confirmed against the wallet's balance. Without one, gas has no L1 fee and that swap
     * stays unknown, so this skips the balance reads, which couldn't confirm anything.
     */
    async getLegs(address: string, range: BlockRange = {}): Promise<WalletLegs> {
      if (!isAddress(address)) throw new Error(`${address} isn't a Base address`)
      const account = normalizeAddress(address)
      if (readL1Fees) {
        const { from, to } = resolveRange(range)
        const { coverage, legs, references, gasUnknownTxs, l1FeeUnknownTxs } = await readWallet(account, from, to)
        return { address: account, blocks: coverage, legs: legs.filter((l) => !l.opening), references, gasUnknownTxs, l1Fees: l1FeeStatus(l1FeeUnknownTxs), l1FeeUnknownTxs }
      }
      const blocks = await blocksRead(range, WALLET_TABLES)
      if (blocks.toBlock < blocks.fromBlock) return { address: account, blocks, legs: [], references: [], gasUnknownTxs: [], l1Fees: "read", l1FeeUnknownTxs: [] }
      const { rows, priced, gasUnknown } = await reader.readWindow(account, blocks.fromBlock, blocks.toBlock)
      const references = await reader.readReferences(rows.map((r) => r.block_num))
      const l1FeeUnknownTxs = rows.filter((r) => r.kind === "gas").map((r) => r.tx_hash)
      return { address: account, blocks, legs: buildPricedLegs({ account, rows, references, priced }), references, gasUnknownTxs: gasUnknown.map((tx) => tx.tx_hash), l1Fees: l1FeeStatus(l1FeeUnknownTxs), l1FeeUnknownTxs }
    },

    /**
     * A token's prices in the range, by symbol or address. A token with an oracle has one price a block, and any other
     * token has one for each swap that gave one. A swap that couldn't be priced is still there, as unknown. That includes
     * a sender's swap paid out in unwrapped ETH, even with an `rpcUrl`: confirming it takes that wallet's balance and fees
     * for each swap, and another account's row in the same transaction, like the pool's, usually prices it anyway.
     */
    async getPrices(token: string, range: BlockRange = {}): Promise<TokenPrices> {
      const found = findToken(token)
      const blocks = await blocksRead(range, found.oracle ? ORACLE_TABLES : SWAP_TABLES)
      const result = { token: found.symbol, blocks }
      if (blocks.toBlock < blocks.fromBlock) return { ...result, prices: [] }

      if (found.oracle) {
        const rows = await reader.readOracle(found.oracle, blocks.fromBlock, blocks.toBlock)
        const prices = rows.map(({ block_num, timestamp, answer }): PricePoint => {
          const usdMicros = answerToMicros(answer)
          return { blockNum: block_num, timestamp, usdMicros, source: usdMicros === null ? "unknown" : "oracle", txHash: null, account: null, note: usdMicros === null ? "The oracle read failed at this block." : null }
        })
        return { ...result, prices }
      }

      const swaps = await reader.readSwaps(found.address, blocks.fromBlock, blocks.toBlock)
      const moved = new Map<string, LegRow[]>()
      for (const r of await reader.readTxRows(swaps.map((s) => s.row))) moved.set(r.tx_hash, [...(moved.get(r.tx_hash) ?? []), r])
      const prices = swaps.map(({ row, timestamp, reference }): PricePoint => {
        // The same path a wallet's legs take, so a price the app would reject, like one from a swap that also moved a
        // token off the allowlist, is unknown here too.
        const legs = buildPricedLegs({ account: row.account, rows: moved.get(row.tx_hash) ?? [], references: [reference], priced: [row] })
        const leg = legs.find((l) => l.asset === found.asset)
        const usdMicros = leg?.priceSource === "swap" ? leg.priceMicros : null
        const base = { blockNum: row.block_num, timestamp, txHash: row.tx_hash, account: row.account }
        if (usdMicros !== null) return { ...base, usdMicros, source: "swap", note: null }
        return { ...base, usdMicros: null, source: "unknown", note: leg?.priceNote ?? "This swap didn't give a usable price for this token." }
      })
      return { ...result, prices }
    },

    /**
     * The current prices `buildPortfolio` values positions at: ETH and USDC from a recent oracle read, and every other
     * token from its feed, all read in one query. A token whose answer is too old, implausible or failed has no price.
     */
    async getLatestPrices(): Promise<LatestPrices> {
      const head = await reader.head(null)
      if (!head) return {}
      const prices = latestPrices(await reader.readLatestReference(head.blockNum))
      try {
        const rounds = await readFeedRoundsAt(query, { baseDataset, network })(Object.keys(TOKEN_FEEDS), [head.blockNum])
        return { ...prices, ...feedPrices(rounds.get(head.blockNum) ?? {}, prices) }
      } catch (error) {
        logger.warn(`Feed read failed: ${describeError(error)}`)
        return prices
      }
    },
  }
}

/** A chain with no blocks yet, so nothing can be read. */
function emptyWallet(address: string, from: number): WalletData {
  return {
    address,
    mode: "dataset",
    currency: "USD",
    rates: null,
    coverage: { fromBlock: from, toBlock: from - 1 },
    notes: [],
    marketChecked: false,
    marketMarks: {},
    legs: [],
    references: [],
    prices: {},
    latest: { blockNum: from - 1, timestamp: new Date(0).toISOString() },
    gasUnknownTxs: [],
    gasUnknownBlocks: [],
    unlisted: [],
    l1FeeUnknownTxs: [],
    balances: null,
    openingUnread: [...ASSETS],
    lastBalances: {},
    lastCheckableEth: null,
    unreadBalances: [],
    unseenEth: [],
  }
}

export type Pricetag = ReturnType<typeof pricetagClient>
