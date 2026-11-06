// The small server: the only way to Amp for the browser and the Mac app, so the token stays here.
// Used by `pnpm start` and, inside Vite, by `pnpm dev`.

import type { IncomingMessage, ServerResponse } from "node:http"
import { OldestFirstTooBigError, WalletsTooBigError, limitFolds, currentRateMicros, hasStarted, isAddress, isCurrencyCode, isMainCurrency, latestPrices, type CurrencyCode, type Method } from "@pricetag/sdk/core"
import { WalletTooBigError, WalletsBusyError, createRowBudget, foldBytesThatFit, rowsThatFit, DEFAULT_RPC_URL, createL1FeeReader, createOtherTokens, createQuery, createRangeStream, createRates, createRowStream, createWallets, describeError, feedRounds, followChain, followRawSql, followSql, followedWallets, followedWindowSql, readBlockHashes, readHeadMark, sharedMarket, updateRounds, type AmpQuery, type FollowConfig, type ReadRates, type Source } from "@pricetag/sdk/internal"
import type { Head, WalletResponse } from "../src/core/api.ts"
import { emptyBook, linkedWallets, parseBook, walletsBehind, type Book } from "../src/core/book.ts"
import { parseCoinbaseCsv } from "../src/core/exchange-import.ts"
import { exportCsv } from "../src/core/export.ts"
import { DEMO_ADDRESS, DEMO_WALLET, demoRates, demoWallet } from "../src/core/fixtures.ts"
import { foldBook, previewBook } from "../src/core/resolve.ts"
import { CAUTIOUS_RULE_ID, MARKET_RULE_ID, RULE_TEXT, ruleNote, type PricingRule } from "../src/core/rules.ts"
import { refuse, type CheckoutRefusal } from "./hosting.ts"
import { forEveryone } from "./lanes.ts"
import { verifyLink } from "./links.ts"
import { ALL_YOURS, combinedPortfolioOf, explainCombined, exportCombined, previewCombined, type AllYoursRead, type Unread } from "../src/core/combined.ts"
import { compareRules, explainPortfolio, parseExplainTarget, portfolioOf } from "../src/core/portfolio.ts"
import { createCoinbase } from "./coinbase.ts"
import { ONRAMP_ASSETS, OnrampError, type FiatAmount, type Onramp } from "./onramp.ts"
import { readPaidRates } from "./rates.ts"
import { createBlockHashReader, createDepositReader } from "./block.ts"
import { warnOfNewAggregators, warnOfNewRateAggregators, warnOfNewTokenAggregators } from "./feeds.ts"
import { createManifestReader, createProofs, currentProofOf, currentRevision, currentVerificationOf, feedBehind, isSeed, proofOf, verificationOf, type BlockRead, type CheckedUpdate, type PriceBehind, type Proofs } from "./proof.ts"
import { rawSource, resolvingSource, settledL1Fees, sharedReads, type SharedReads } from "./source.ts"
import { createApprovals, demoApprovals, type Approvals } from "./approvals.ts"
import { createContractCheck } from "./contract.ts"
import { TAX_COUNTRIES, isTaxCountryCode, parseTaxYear, taxReportOf, type TaxScope } from "../src/core/tax.ts"

type Env = Record<string, string | undefined>

const DEMO_UNVERIFIABLE = "This is the demo wallet, so there's no real block to check."

function parseMethod(value: string | null): Method | null {
  if (value === null || value === "average") return "average"
  return value === "fifo" ? "fifo" : null
}

function parseScope(value: string | null): TaxScope | null {
  return value === "pooled" || value === "per-wallet" ? value : null
}

/** How many other wallets a report, or any other request, can add. Each is a full read. */
const MAX_OTHER_WALLETS = 20

/** How long a read of all the user's wallets waits on the slowest before answering with the rest. A wallet catching up takes far less. */
const ALL_YOURS_WAIT_MS = 2_500

/**
 * Waits for every job, or `ALL_YOURS_WAIT_MS`, whichever's first. If `enough` still says no by then, it keeps waiting, a job at
 * a time, until it does or they're all done. Jobs that aren't done keep running, and never reject.
 */
async function settleSome(jobs: readonly Promise<void>[], enough: () => boolean): Promise<void> {
  const pending = new Set(jobs)
  for (const job of jobs) void job.finally(() => pending.delete(job))
  await Promise.race([Promise.all(jobs), new Promise((resolve) => setTimeout(resolve, ALL_YOURS_WAIT_MS).unref())])
  while (pending.size > 0 && !enough()) await Promise.race(pending)
}

function parseCurrency(value: string | null): CurrencyCode | null {
  if (value === null) return "USD"
  return isMainCurrency(value) ? value : null
}

/** The other currencies a client's own answers are in, so it can fold them. It keeps those answers, and this is all it says about them. */
function parsePaidIn(value: string | null): CurrencyCode[] | null {
  const codes = value ? value.split(",") : []
  return codes.every((code) => isCurrencyCode(code)) ? (codes as CurrencyCode[]) : null
}

/** A pricing rule, and where a wallet's rows come from when it's read through that rule. */
type RuleSource = { rule: PricingRule; source: Source }

const MANIFEST_HASH = /^[0-9a-f]{64}$/

/** A dataset reference pinned to the manifest it's meant to be, so what's shown as the rule's hash is what gets read. */
function pinned(dataset: string, hash: string | undefined): string {
  if (!hash || !MANIFEST_HASH.test(hash)) throw new Error(`PRICETAG_FORK_DATASET needs the manifest hash of ${dataset}`)
  return `${dataset.split("@")[0]}@${hash}`
}

/** The most rows of wallet history this server holds at once: `PRICETAG_MAX_WALLET_ROWS`, or what fits in its heap. */
function maxWalletRowsOf(env: Env): number {
  if (!env.PRICETAG_MAX_WALLET_ROWS) return rowsThatFit()
  const rows = Number(env.PRICETAG_MAX_WALLET_ROWS)
  if (!Number.isSafeInteger(rows) || rows <= 0) throw new Error("PRICETAG_MAX_WALLET_ROWS must be a positive whole number")
  return rows
}

/** A wallet read's rows, closing balance and latest price run side by side, and the head or another wallet needn't wait behind them. Few enough to be fair to a shared Amp. */
const QUERIES_AT_ONCE = 3

export function createSource(env: Env, query: AmpQuery | null = env.AMP_QUERY_URL ? createQuery(env.AMP_QUERY_URL, env.AMP_QUERY_TOKEN || undefined, { maxConcurrent: QUERIES_AT_ONCE }) : null): { source: Source; rules?: RuleSource[]; readRates: ReturnType<typeof createRates>; proofs: Proofs; follow: FollowConfig; shared?: SharedReads; approvals?: Approvals } | null {
  if (!query) return null
  const maxWalletRows = maxWalletRowsOf(env)
  const baseDataset = env.PRICETAG_BASE_DATASET || "edgeandnode/base_mainnet@0.0.2"
  const network = env.PRICETAG_RPC_NETWORK || "base_mainnet"
  const feedsDataset = env.PRICETAG_FEEDS_DATASET || undefined
  const calls = feedRounds(query, { baseDataset, network })
  const readRates = createRates(env.PRICETAG_RATES_DATASET ? updateRounds(query, env.PRICETAG_RATES_DATASET, calls) : calls)
  if (env.PRICETAG_RATES_DATASET) void warnOfNewRateAggregators(env.BASE_RPC_URL || DEFAULT_RPC_URL)
  // How the server hears about new blocks. Amp's block ranges name a network with a dash, and its RPC functions with an underscore.
  const followOf = (sql: string, startBlock: number | null = null): FollowConfig => ({ stream: env.AMP_QUERY_URL ? createRangeStream(env.AMP_QUERY_URL, env.AMP_QUERY_TOKEN || undefined, network.replaceAll("_", "-")) : null, sql, readMark: (after) => readHeadMark(query, baseDataset, after ?? startBlock), readHashes: (blocks) => readBlockHashes(query, baseDataset, blocks) })
  // Only a fork pins the default. Without one, a hash left in the env can be a hosted Amp's, which a local Amp doesn't have.
  const pin = env.PRICETAG_DATASET && env.PRICETAG_FORK_DATASET ? pinned(env.PRICETAG_DATASET, env.PRICETAG_DATASET_HASH) : null
  const proofs = createProofs(pin ? query.aliased({ pricetag: pin }) : query, {
    baseDataset,
    dataset: env.PRICETAG_DATASET ? { name: env.PRICETAG_DATASET, reference: pin ? "pricetag" : env.PRICETAG_DATASET, hash: pin ? env.PRICETAG_DATASET_HASH! : null } : null,
    feedsDataset: env.PRICETAG_DATASET ? (feedsDataset ?? null) : null,
    readDeposits: createDepositReader(env.BASE_RPC_URL || DEFAULT_RPC_URL),
    readBlockHash: createBlockHashReader(env.BASE_RPC_URL || DEFAULT_RPC_URL),
    readManifestHash: createManifestReader(env.AMP_ADMIN_URL || `${env.AMP_QUERY_URL}/controller`, env.AMP_QUERY_TOKEN || undefined),
  })
  /** With `PRICETAG_WALLET_STREAM=on`, follows a wallet's rows once it's read, so its next read doesn't query for them. Off by default until it's been through a real reorg. */
  const followedOf = (dataset: string) =>
    env.AMP_QUERY_URL && env.PRICETAG_WALLET_STREAM === "on"
      ? followedWallets({ stream: createRowStream(env.AMP_QUERY_URL, env.AMP_QUERY_TOKEN || undefined, network.replaceAll("_", "-")), sql: (address) => followedWindowSql(address, dataset, { counterparties: true }), readMark: (after) => readHeadMark(query, baseDataset, after), readHashes: (blocks) => readBlockHashes(query, baseDataset, blocks) })
      : undefined
  if (env.PRICETAG_DATASET) {
    if (env.PRICETAG_FEEDS_DATASET) void warnOfNewTokenAggregators(env.BASE_RPC_URL || DEFAULT_RPC_URL)
    const startBlock = Number(env.PRICETAG_START_BLOCK)
    if (!Number.isSafeInteger(startBlock) || startBlock <= 0) throw new Error("PRICETAG_DATASET needs PRICETAG_START_BLOCK")
    void warnOfNewAggregators(env.BASE_RPC_URL || DEFAULT_RPC_URL)
    if (pin) {
      // The same SQL for both. The header alone says which prices it reads, and the transactions always come from the
      // first, so they can't differ.
      const followed = followedOf(pin)
      const shared = sharedReads(query.aliased({ pricetag: pin }), { baseDataset, dataset: "pricetag", network, followed, maxWalletRows })
      const ruleSource = (id: string, name: string, hash: string | undefined, priceDataset: string): RuleSource => ({
        rule: { id, ...RULE_TEXT[id]!, dataset: name, hash: hash as string },
        // The stream reads the default rule's prices, so only that rule can use them.
        source: resolvingSource(query.aliased({ pricetag: pin, pricing: priceDataset }), { baseDataset, dataset: "pricetag", priceDataset: "pricing", feedsDataset, startBlock, network, tokensDataset: env.PRICETAG_TOKENS_DATASET, followed: priceDataset === pin ? followed : undefined, maxWalletRows }, shared),
      })
      const rules = [
        ruleSource(MARKET_RULE_ID, env.PRICETAG_DATASET, env.PRICETAG_DATASET_HASH, pin),
        ruleSource(CAUTIOUS_RULE_ID, env.PRICETAG_FORK_DATASET!, env.PRICETAG_FORK_HASH, pinned(env.PRICETAG_FORK_DATASET!, env.PRICETAG_FORK_HASH)),
      ]
      const approvals = createApprovals(query.aliased({ pricetag: pin }), { baseDataset, dataset: { reference: "pricetag", name: env.PRICETAG_DATASET }, network, historyFrom: () => startBlock })
      return { source: rules[0]!.source, rules, readRates, proofs, follow: followOf(followSql(pin), startBlock), shared, approvals }
    }
    const followed = followedOf(env.PRICETAG_DATASET)
    const shared = sharedReads(query, { baseDataset, dataset: env.PRICETAG_DATASET, network, followed, maxWalletRows })
    const approvals = createApprovals(query, { baseDataset, dataset: { reference: env.PRICETAG_DATASET, name: env.PRICETAG_DATASET }, network, historyFrom: () => startBlock })
    return { source: resolvingSource(query, { baseDataset, dataset: env.PRICETAG_DATASET, feedsDataset, startBlock, network, tokensDataset: env.PRICETAG_TOKENS_DATASET, followed, maxWalletRows }, shared), readRates, proofs, follow: followOf(followSql(env.PRICETAG_DATASET), startBlock), shared, approvals }
  }
  const historyBlocks = env.PRICETAG_HISTORY_BLOCKS ? Number(env.PRICETAG_HISTORY_BLOCKS) : null
  if (historyBlocks !== null && (!Number.isSafeInteger(historyBlocks) || historyBlocks <= 0)) throw new Error("PRICETAG_HISTORY_BLOCKS must be a positive number")
  const source = rawSource(query, { baseDataset, network, historyBlocks, maxWalletRows })
  const approvals = createApprovals(query, { baseDataset, dataset: null, network, historyFrom: (head) => source.historyFrom?.(head) ?? head })
  return { source, readRates, proofs, follow: followOf(followRawSql(baseDataset)), approvals }
}

/** Each one is a wallet read, so this stays well under what the server keeps in memory. */
const MAX_LINKED_WALLETS = 10

/** The user's other wallets, or null when that isn't what was sent. */
function parseLinked(value: string | null): string[] | null {
  if (value === null || value === "") return []
  const addresses = value.split(",")
  if (addresses.length > MAX_LINKED_WALLETS || !addresses.every(isAddress)) return null
  return [...new Set(addresses.map((address) => address.toLowerCase()))]
}

/** The request's decoded path, or null when the URL is malformed. Clients can send anything here. */
export function pathOf(req: IncomingMessage): string | null {
  try {
    return decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname)
  } catch {
    return null
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
  res.end(JSON.stringify(body))
}

/** Query errors can quote our SQL or the endpoint. The browser gets a fixed message, and the detail stays in the server log. */
function sendAmpError(res: ServerResponse, error: unknown, message = "Couldn't read this wallet's data.") {
  if (error instanceof WalletTooBigError) return sendJson(res, 413, { error: "This wallet has too much history for this server to read, so there are no numbers to show for it." })
  if (error instanceof OldestFirstTooBigError) return sendJson(res, 413, { error: "There's too much history here to work out by oldest first on this server. Average cost still works." })
  if (error instanceof WalletsTooBigError) return sendJson(res, 413, { error: "These wallets have too much history to add up on this server. Each one can still be read on its own." })
  if (error instanceof WalletsBusyError) return sendJson(res, 429, { error: "This server is busy reading other very large wallets. Try again in a minute." })
  console.error("Amp query failed:", describeError(error))
  sendJson(res, 502, { error: message })
}

/** Answers, CSVs and signatures are small. Anything bigger isn't one of them. */
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

/** For a source with nothing to stream. */
const pollingOnly = (source: Source): FollowConfig => ({
  stream: null,
  sql: "",
  readMark: async (after) => {
    const head = await source.head(after)
    return head && { blockNum: head.blockNum, hash: "" }
  },
})

type Created = Omit<NonNullable<ReturnType<typeof createSource>>, "follow"> & { follow?: FollowConfig | undefined }

/** How old a followed head can be for a wallet read to use it. Ticks are at least 2 s apart, and a read of the head is a query every read would otherwise wait for. */
const FOLLOWED_HEAD_MS = 5000

const NO_ONRAMP = "Buying isn't set up on this server."

/** An amount typed in a currency, or undefined when it isn't one. */
function fiatOf(value: unknown): FiatAmount | undefined {
  const { amount, currency } = recordOf(value) ?? {}
  if (typeof amount !== "string" || !/^\d{1,9}(\.\d{1,2})?$/.test(amount) || !/[1-9]/.test(amount)) return undefined
  return typeof currency === "string" && isMainCurrency(currency) ? { amount, currency } : undefined
}

export type ApiOptions = {
  /** The client's address, for a provider to check where a purchase is made from, or null when it's this machine or isn't known. */
  clientIp?: (req: IncomingMessage) => string | null
  /** How many wallets each rule keeps read. A shared server has more people's wallets than one Mac, and one pushed out is read again in full. */
  maxWallets?: number
  /** Counts a valid checkout just before it reaches the provider, or says why it can't go. */
  limitCheckout?: (req: IncomingMessage) => CheckoutRefusal | null
}

export function createApi(env: Env, created: Created | null = createSource(env), onramp: Onramp | null = createCoinbase(env), { clientIp = () => null, maxWallets, limitCheckout = () => null }: ApiOptions = {}) {
  const source = created?.source ?? null
  limitFolds(foldBytesThatFit())

  let head: Head | null = null
  let headReadAt = 0
  /** Goes up when a reorg starts and when it's been applied, so a read of the head can tell it spanned one. */
  let headRewinds = 0
  const subscribers = new Set<ServerResponse>()
  let following: AbortController | null = null

  async function pollHead(): Promise<Head> {
    if (!source) throw new Error("No Amp source")
    const startedAt = headRewinds
    const next = await forEveryone(() => source.head(head?.blockNum ?? null))
    // What it found can be the replaced chain's, and higher than the new one, so its height says nothing. Only `rewindTo` changes this, so it can't go on for long.
    if (startedAt !== headRewinds) return pollHead()
    // Reads overlap, so one that started first can finish last. A reorg lowers the head through `rewindTo`, not here.
    if (next && (!head || next.blockNum >= head.blockNum)) {
      head = next
      headReadAt = Date.now()
    }
    if (!head) throw new Error("No blocks yet")
    return head
  }

  /** While the chain's followed, every tick reads the head and the next one reads the wallet again, so a read can start from one that's seconds old. */
  const walletHead = async () => (head && following && Date.now() - headReadAt < FOLLOWED_HEAD_MS ? head : pollHead())

  const send = (message: string) => {
    for (const subscriber of subscribers) subscriber.write(message)
  }

  /** Blocks some already-read wallets hold were replaced. The next read of each replaces them, however far back it was. */
  async function rewindTo(block: number, tip: number) {
    headRewinds += 1
    const oldTip = Math.max(head?.blockNum ?? 0, tip)
    readL1Fees.rewind(block, oldTip)
    await Promise.all([created?.shared?.rewind(block, oldTip), ...[...new Set([wallets, ...rules.map((r) => r.wallets)])].map((w) => w?.rewind(block, oldTip))])
    created?.readRates.rewind?.(block)
    // The new chain can be shorter, and the head is only read from the last one on.
    if (head && head.blockNum >= block) head = { ...head, blockNum: block - 1 }
    headReadAt = 0
    headRewinds += 1
  }

  // Only follows the chain while something is watching.
  async function followLoop() {
    if (following || !source) return
    const stop = new AbortController()
    following = stop
    for await (const tick of followChain(created?.follow ?? pollingOnly(source), stop.signal)) {
      if (tick.kind === "down") {
        console.error("Head read failed:", tick.message)
        send(`event: down\ndata: {}\n\n`)
        continue
      }
      try {
        if (tick.reorgFrom !== null) await rewindTo(tick.reorgFrom, tick.blockNum)
        // Every tick, even under the same head: it can be a block the dataset has only now finished.
        const current = await pollHead()
        send(`event: head\ndata: ${JSON.stringify({ ...current, via: tick.via })}\n\n`)
      } catch (error) {
        console.error("Head read failed:", describeError(error))
        send(`event: down\ndata: {}\n\n`)
      }
    }
    following = null
    if (subscribers.size > 0) void followLoop()
  }

  const isContract = createContractCheck(env.BASE_RPC_URL || DEFAULT_RPC_URL)
  const readL1Fees = settledL1Fees(createL1FeeReader(env.BASE_RPC_URL || DEFAULT_RPC_URL, fetch, undefined, console, Number(env.BASE_RPC_RATE_LIMIT) || undefined), () => head?.blockNum ?? null)
  // Shared by the rules, since no rule changes what a token says about itself or what a wallet holds of it.
  const otherTokens = source?.readTokenFacts && createOtherTokens(source.readTokenFacts)
  const budget = createRowBudget(maxWalletRowsOf(env))
  const wallets = source ? createWallets(source, walletHead, readL1Fees, console, { maxWallets, priceSamples: true, otherTokens, budget }) : null
  // Each rule keeps its own, so a rule nobody's looking at costs nothing, and what no rule changes is only read once. The first rule is the same as having none.
  const rules = (created?.rules ?? []).map(({ rule, source }, i) => ({ rule, source, note: i === 0 ? null : ruleNote(rule), wallets: i === 0 ? wallets! : createWallets(source, walletHead, readL1Fees, console, { maxWallets, priceSamples: true, otherTokens, budget }) }))

  /**
   * Reads a wallet, or answers the request with why it can't.
   * `fresh: false` settles for the last read if there is one: a read can take seconds, and a click shouldn't wait on it.
   */
  async function readWallet(address: string, res: ServerResponse, { fresh, rule }: { fresh: boolean; rule: (typeof rules)[number] | null } = { fresh: true, rule: null }): Promise<WalletResponse | null> {
    if (address === "demo" || address === DEMO_ADDRESS) return DEMO_WALLET
    const demo = demoWallet(address)
    if (demo) return demo
    if (!isAddress(address)) {
      sendJson(res, 400, { error: "That isn't a Base address." })
      return null
    }
    if (!wallets) {
      sendJson(res, 503, { error: "No data source is set up, so only the demo wallet is available." })
      return null
    }
    try {
      const from = rule?.wallets ?? wallets
      const wallet = (!fresh && from.peek(address)) || (await from.get(address))
      return rule ? { ...wallet, rule: rule.rule.id, ruleNote: rule.note } : wallet
    } catch (error) {
      sendAmpError(res, error)
      return null
    }
  }

  /** A wallet with the rates to show it in `currency`. Never falls back to USD. Throws when they can't be read. */
  async function convert(wallet: WalletResponse, currency: CurrencyCode, books: readonly Book[] = [], paidIn: readonly CurrencyCode[] = []): Promise<WalletResponse> {
    const live = created && wallet.mode !== "demo" ? created : null
    // A wallet can be as of an earlier block than the head, like one that's read at a block they've all reached.
    const readRates: ReadRates = live ? (other, read, options) => live.readRates(other, read, { ...options, chainHead: head?.blockNum }) : async (other) => demoRates(other)
    const paidRates = await readPaidRates(readRates, wallet, currency, books, paidIn)
    const paid = paidRates ? { ...wallet, paidRates } : wallet
    if (currency === "USD") return paid
    return { ...paid, currency, rates: await readRates(currency, wallet) }
  }

  /** A wallet with the rates to show it in `currency`, or answers the request with why it can't. Never falls back to USD. */
  async function inCurrency(wallet: WalletResponse, currency: CurrencyCode, res: ServerResponse, books: readonly Book[] = [], paidIn: readonly CurrencyCode[] = []): Promise<WalletResponse | null> {
    try {
      return await convert(wallet, currency, books, paidIn)
    } catch (error) {
      sendAmpError(res, error)
      return null
    }
  }

  /**
   * What one USD buys right now, without reading any wallet, for what's shown before one has been read. Null when there's no current rate.
   * With no data source there's no rate either: this is for real balances, which the demo's made-up rates mustn't convert.
   */
  async function answerRate(currency: CurrencyCode, res: ServerResponse) {
    if (currency === "USD") return sendJson(res, 200, { currency, rateMicros: null })
    try {
      if (!created) return sendJson(res, 200, { currency, rateMicros: null })
      const latest = await pollHead()
      sendJson(res, 200, { currency, rateMicros: currentRateMicros(await created.readRates(currency, { legs: [], latest }), latest.timestamp) })
    } catch (error) {
      sendAmpError(res, error)
    }
  }

  /** What a wallet lets others spend, checked at the head. Demo wallets have made-up ones, like the rest of their history. */
  async function answerApprovals(address: string, res: ServerResponse) {
    const demo = address === "demo" || address === DEMO_ADDRESS ? DEMO_WALLET : demoWallet(address)
    if (demo) return sendJson(res, 200, demoApprovals(demo))
    if (!isAddress(address)) return sendJson(res, 400, { error: "That isn't a Base address." })
    if (!created?.approvals) return sendJson(res, 503, { error: "No data source is set up, so only the demo wallet is available." })
    try {
      sendJson(res, 200, await created.approvals.read(address.toLowerCase(), await pollHead()))
    } catch (error) {
      sendAmpError(res, error, "Couldn't read this wallet's approvals.")
    }
  }

  /** Linked wallets whose last read failed, so a client can say so rather than go on saying it's reading. Each request tries again. */
  const linkedFailures = new Set<string>()

  /**
   * The linked wallets already read, in `currency`. Never waits on a first read, because it can take a while and a number
   * shouldn't: it starts the read, and what came from that wallet stays unresolved until the next request finds it.
   */
  async function linkedOf(focus: WalletResponse, books: readonly Book[], currency: CurrencyCode, rule: (typeof rules)[number] | null, res: ServerResponse): Promise<WalletResponse[] | null> {
    const addresses = new Set(books.flatMap((book) => walletsBehind(book, focus)))
    const read: WalletResponse[] = []
    for (const address of addresses) {
      if (address === focus.address.toLowerCase()) continue
      let wallet = address === DEMO_ADDRESS ? DEMO_WALLET : demoWallet(address)
      const from = rule?.wallets ?? wallets
      if (!wallet && from) {
        void from.get(address).then(
          () => linkedFailures.delete(address),
          (error: unknown) => {
            console.error("Linked wallet read failed:", describeError(error))
            linkedFailures.add(address)
          },
        )
        const read = from.peek(address)
        wallet = read && rule ? { ...read, rule: rule.rule.id, ruleNote: rule.note } : read
      }
      if (!wallet) continue
      const converted = await inCurrency(wallet, currency, res, books)
      if (!converted) return null
      read.push(converted)
    }
    return read
  }

  /**
   * Every one of the user's wallets that this request could read, in `currency`, and the ones it couldn't yet. Each wallet is
   * one job, its read and its rates together, so one slow or failing wallet doesn't hold up or fail the rest: after a moment
   * whatever's done is the answer, and the rest are still reading or failed. With nothing done at all, it waits for the first.
   * A wallet whose read this time failed or hasn't finished is left out, whatever was read of it before, because its balance
   * then can be from before a move another wallet has already seen. `fresh: false` takes what's already been read, and
   * leaves out a wallet whose last read failed.
   */
  async function readAllYours(addresses: readonly string[], currency: CurrencyCode, rule: (typeof rules)[number] | null, books: readonly Book[], fresh: boolean, res: ServerResponse, paidIn: readonly CurrencyCode[] = []): Promise<{ read: WalletResponse[]; unread: Unread } | null> {
    const from = rule?.wallets ?? wallets
    const chain = rule?.source ?? source
    if (!from || !chain) {
      sendJson(res, 503, { error: "No data source is set up, so only the demo wallet is available." })
      return null
    }
    const ruled = (wallet: WalletResponse): WalletResponse => (rule ? { ...wallet, rule: rule.rule.id, ruleNote: rule.note } : wallet)
    const failed = new Set<string>()
    const done = new Map<string, WalletResponse>()
    /** Why a wallet was refused, which says more than that it failed. */
    let refusal: unknown = null
    const job = async (address: string): Promise<void> => {
      let wallet: WalletResponse | null
      try {
        wallet = fresh ? await from.get(address) : from.peek(address)
        if (fresh) linkedFailures.delete(address)
      } catch (error) {
        console.error("Wallet read failed:", describeError(error))
        if (error instanceof WalletTooBigError || error instanceof WalletsBusyError) refusal = error
        linkedFailures.add(address)
        failed.add(address)
        return
      }
      if (!wallet) return
      if (!fresh && linkedFailures.has(address)) {
        failed.add(address)
        return
      }
      try {
        done.set(address, await convert(ruled(wallet), currency, books, paidIn))
      } catch (error) {
        console.error("Wallet rates failed:", describeError(error))
        failed.add(address)
      }
    }
    await settleSome(addresses.map(job), () => done.size > 0)

    // What's done by now is the answer. A job that finishes later comes too late to be taken back to the block below, so it stays out, as still reading.
    const answer = new Map(done)

    // One block for all of them, the oldest any of them reached, so a move between them is in both or neither.
    const started = [...answer.values()].filter(hasStarted)
    const blockNum = Math.min(...started.map((wallet) => wallet.coverage.toBlock))
    const ahead = started.filter((wallet) => wallet.coverage.toBlock > blockNum)
    if (ahead.length > 0) {
      for (const wallet of ahead) answer.delete(wallet.address.toLowerCase())
      const reference = chain.readLatestReference(blockNum)
      await settleSome(
        ahead.map(async ({ address }) => {
          const account = address.toLowerCase()
          try {
            const prices = latestPrices(await reference)
            const facts = await from.factsAt(account, blockNum, { withBalances: true })
            // A history that starts after this block can't say what the wallet held at it.
            const at = facts && facts.fromBlock <= blockNum ? from.pricedOn(account, facts, prices, await from.marketOn(account, facts, prices)) : null
            if (!at) throw new Error(`It can't be read at block ${blockNum}.`)
            answer.set(account, await convert(ruled(at), currency, books, paidIn))
          } catch (error) {
            console.error("Wallet read at an earlier block failed:", describeError(error))
            failed.add(account)
          }
        }),
        () => true,
      )
    }

    const read = addresses.flatMap((address) => answer.get(address) ?? [])
    const unread = { reading: addresses.filter((address) => !answer.has(address) && !failed.has(address)), failed: addresses.filter((address) => !answer.has(address) && failed.has(address)) }
    if (read.length === 0 && fresh && unread.reading.length === 0) {
      if (refusal) sendAmpError(res, refusal)
      else sendJson(res, 502, { error: "None of your wallets could be read." })
      return null
    }
    return { read, unread }
  }

  /** All of the user's wallets as one: `linked` is every one of them. Demo data never mixes in, because nobody owns it. */
  async function allYours(action: string | undefined, body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse, { method, currency, book, rule }: { method: Method; currency: CurrencyCode; book: Book; rule: (typeof rules)[number] | null }): Promise<void> {
    const listed: unknown = body.linked
    if (!Array.isArray(listed) || !listed.every((address) => typeof address === "string" && isAddress(address))) return sendJson(res, 400, { error: "Your wallets are a list of Base addresses." })
    const addresses = [...new Set((listed as string[]).map((address) => address.toLowerCase()))].filter((address) => address !== DEMO_ADDRESS && !demoWallet(address))
    if (addresses.length === 0) return sendJson(res, 400, { error: "There are no wallets of yours to add up." })
    if (addresses.length > MAX_OTHER_WALLETS + 1) return sendJson(res, 400, { error: `This can add up to ${MAX_OTHER_WALLETS + 1} wallets.` })
    if (action === "compare") return sendJson(res, 400, { error: "Rules are compared one wallet at a time." })
    const target = action === "explain" ? parseExplainTarget(new URL(req.url ?? "/", "http://localhost").searchParams) : null
    if (action === "explain" && !target) return sendJson(res, 400, { error: "That isn't a number this can explain." })
    const candidates = action === "preview" ? (Array.isArray(body.candidates) ? body.candidates.map(parseBook) : null) : []
    if (!candidates || candidates.includes(null) || candidates.length > 8) return sendJson(res, 400, { error: "Those answers can't be read." })
    const books = action === "preview" ? (candidates as Book[]) : [book]
    const paidIn = parsePaidIn(typeof body.paid === "string" ? body.paid : null)
    if (!paidIn) return sendJson(res, 400, { error: "That currency isn't supported." })
    const found = await readAllYours(addresses, currency, rule, books, action === undefined || action === "wallets", res, paidIn)
    if (!found) return
    const { read, unread } = found
    // The wallets themselves, because the browser runs the fold, with answers that stay with it.
    if (action === "wallets") return sendJson(res, 200, { wallets: read, unread } satisfies AllYoursRead)
    if (read.length === 0) {
      res.writeHead(204, { "cache-control": "no-store" })
      res.end()
      return
    }
    if (action === "preview") return sendJson(res, 200, { previews: previewCombined(read, method, candidates as Book[], unread) })
    if (action === "export") {
      // Worked out first, because it can be refused, and a refusal can't follow a 200.
      const csv = exportCombined(read, method, book)
      res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store" })
      res.end(csv)
      return
    }
    if (target) {
      const explanation = explainCombined(read, method, target, book, unread)
      return explanation ? sendJson(res, 200, explanation) : sendJson(res, 404, { error: "None of your wallets has anything like that." })
    }
    sendJson(res, 200, combinedPortfolioOf(read, method, book, unread))
  }

  /** The provider's detail stays in the server's log, and the client gets a sentence it can show. */
  async function onrampAnswer(res: ServerResponse, read: () => Promise<unknown>) {
    try {
      sendJson(res, 200, await read())
    } catch (error) {
      if (!(error instanceof OnrampError)) throw error
      sendJson(res, 502, { error: error.message })
    }
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

    if (path === "/api/onramp/checkout") {
      if (!onramp) return sendJson(res, 503, { error: NO_ONRAMP })
      const { address, asset, cryptoAmount, fiat } = body
      if (typeof address !== "string" || !isAddress(address)) return sendJson(res, 400, { error: "That needs a Base address." })
      if (typeof asset !== "string" || !ONRAMP_ASSETS.includes(asset)) return sendJson(res, 400, { error: "That token can't be bought here." })
      if (typeof cryptoAmount !== "string" || !/^\d{1,12}(\.\d{1,18})?$/.test(cryptoAmount) || !/[1-9]/.test(cryptoAmount)) return sendJson(res, 400, { error: "That isn't an amount." })
      const typed = fiat === undefined || fiat === null ? null : fiatOf(fiat)
      if (typed === undefined) return sendJson(res, 400, { error: "That isn't an amount." })
      const refusal = limitCheckout(req)
      if (refusal) return refuse(res, 429, refusal.error, refusal.retryAfter)
      return onrampAnswer(res, () => onramp.checkout({ address, asset, cryptoAmount, fiat: typed, clientIp: clientIp(req) }))
    }

    const taxMatch = /^\/api\/tax-report\/([^/]+)$/.exec(path)
    if (taxMatch) {
      const currency = parseCurrency(typeof body.currency === "string" ? body.currency : null)
      if (!currency) return sendJson(res, 400, { error: "That currency isn't supported." })
      const book = body.book === undefined ? emptyBook() : parseBook(body.book)
      if (!book) return sendJson(res, 400, { error: "Those answers can't be read." })
      const also: unknown = body.also ?? []
      if (!Array.isArray(also) || !also.every((address) => typeof address === "string")) return sendJson(res, 400, { error: "Other wallets are a list of Base addresses." })
      return taxReport(taxMatch[1] as string, { country: body.country, method: body.method, scope: body.scope, year: body.year }, also as string[], currency, book, res)
    }

    const match = /^\/api\/portfolio\/([^/]+)(?:\/(explain|preview|export|compare|last|wallets))?$/.exec(path)
    if (!match) return sendJson(res, 404, { error: "Not found" })
    const method = parseMethod(typeof body.method === "string" ? body.method : null)
    if (!method) return sendJson(res, 400, { error: "The method is either average or fifo." })
    const currency = parseCurrency(typeof body.currency === "string" ? body.currency : null)
    if (!currency) return sendJson(res, 400, { error: "That currency isn't supported." })
    const book = body.book === undefined ? emptyBook() : parseBook(body.book)
    if (!book) return sendJson(res, 400, { error: "Those answers can't be read." })
    const rule = body.rule === undefined || body.rule === null ? (rules[0] ?? null) : (rules.find((r) => r.rule.id === body.rule) ?? null)
    if (body.rule !== undefined && body.rule !== null && !rule) return sendJson(res, 400, { error: "That pricing rule isn't available here." })
    const action = match[2]
    if (match[1] === ALL_YOURS) return allYours(action, body, req, res, { method, currency, book, rule })
    if (action === "wallets") return sendJson(res, 404, { error: "Not found" })

    const target = action === "explain" ? parseExplainTarget(new URL(req.url ?? "/", "http://localhost").searchParams) : null
    if (action === "explain" && !target) return sendJson(res, 400, { error: "That isn't a number this can explain." })
    const candidates = action === "preview" ? (Array.isArray(body.candidates) ? body.candidates.map(parseBook) : null) : []
    if (!candidates || candidates.includes(null) || candidates.length > 8) return sendJson(res, 400, { error: "Those answers can't be read." })
    const books = action === "preview" ? (candidates as Book[]) : [book]

    // Every wallet this request could read, before any read starts: a shared server's reads queue for everyone.
    const sent: unknown[] = Array.isArray(body.linked) ? body.linked : []
    if (!sent.every((address) => typeof address === "string" && isAddress(address))) return sendJson(res, 400, { error: "Linked wallets are a list of Base addresses." })
    const named = new Set([...(sent as string[]).map((address) => address.toLowerCase()), ...books.flatMap(linkedWallets)])
    named.delete((match[1] as string).toLowerCase())
    if (named.size > MAX_OTHER_WALLETS) return sendJson(res, 400, { error: `A request can add up to ${MAX_OTHER_WALLETS} other wallets.` })

    if (action === "compare") {
      const known = Array.isArray(body.linked) ? body.linked : []
      if (!known.every((address) => typeof address === "string" && isAddress(address))) return sendJson(res, 400, { error: "Linked wallets are a list of Base addresses." })
      const linking = { ...book, linked: known.map((address: string) => address.toLowerCase()) }
      return compare(match[1] as string, currency, method, walletsBehind(linking, { address: match[1] as string }), res, linking)
    }

    // What's already been read, folded for this request, which takes no query. It may be behind, so it's for showing while a real read runs.
    if (action === "last" && !(rule?.wallets ?? wallets)?.peek(match[1] as string)) {
      res.writeHead(204, { "cache-control": "no-store" })
      res.end()
      return
    }
    const read = await readWallet(match[1] as string, res, { fresh: action === undefined, rule })
    const wallet = read && (await inCurrency(read, currency, res, books))
    if (!wallet) return
    // The client's own wallets, which only count on a wallet that's real.
    const known: unknown[] = wallet.mode === "demo" || !Array.isArray(body.linked) ? [] : body.linked
    if (!known.every((address) => typeof address === "string" && isAddress(address))) return sendJson(res, 400, { error: "Linked wallets are a list of Base addresses." })
    const linkedBooks = books.map((one) => ({ ...one, linked: (known as string[]).map((address) => address.toLowerCase()) }))
    const others = await linkedOf(wallet, linkedBooks, currency, rule, res)
    if (!others) return

    if (action === "preview") return sendJson(res, 200, { previews: linkedBooks.map((candidate) => previewBook(wallet, others, method, candidate, [...linkedFailures])) })
    if (action === "export") {
      const { positions, view } = foldBook(wallet, others, method, linkedBooks[0] as Book)
      res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store" })
      res.end(exportCsv(positions, view.currency))
      return
    }
    if (!target) return sendJson(res, 200, portfolioOf(wallet, method, others, linkedBooks[0], [...linkedFailures]))
    const explanation = explainPortfolio(wallet, method, target, others, linkedBooks[0])
    if (explanation) sendJson(res, 200, explanation)
    else sendJson(res, 404, { error: "This wallet has nothing like that." })
  }

  /**
   * Answers with a report on `address`, the wallets typed in with it, and the ones the answers say are the user's, because
   * those are in what the apps show. A wallet nobody's said is theirs, like one being watched, takes no costs from them, so
   * they aren't read or listed. The demo's own wallets are read for its costs without being listed. Demo data and real data never mix.
   */
  async function taxReport(address: string, choices: { country: unknown; method: unknown; scope: unknown; year: unknown }, also: readonly string[], currency: CurrencyCode, book: Book, res: ServerResponse): Promise<void> {
    const { country } = choices
    if (typeof country !== "string" || !isTaxCountryCode(country)) return sendJson(res, 400, { error: "That country isn't supported." })
    const defaults = TAX_COUNTRIES[country]
    const method = choices.method === null || choices.method === undefined ? defaults.method : parseMethod(typeof choices.method === "string" ? choices.method : "")
    if (!method) return sendJson(res, 400, { error: "The method is either average or fifo." })
    const scope = choices.scope === null || choices.scope === undefined ? defaults.scope : parseScope(typeof choices.scope === "string" ? choices.scope : "")
    if (!scope) return sendJson(res, 400, { error: "The calculation is either pooled or per-wallet." })
    const year = parseTaxYear(choices.year)
    if (year === null) return sendJson(res, 400, { error: "The year is a year, latest or all." })

    const focus = address.toLowerCase()
    const others = also.map((other) => other.trim().toLowerCase()).filter(Boolean)
    const bad = others.find((other) => !isAddress(other))
    if (bad !== undefined) return sendJson(res, 400, { error: `${bad} isn't a Base address.` })
    const isDemo = (wallet: string) => wallet === "demo" || wallet === DEMO_ADDRESS || demoWallet(wallet) !== null
    // Whichever way round: demo data must never land in a report on a real wallet.
    if (others.length > 0 && [focus, ...others].some(isDemo)) return sendJson(res, 400, { error: "The demo wallet can't be combined with other wallets." })

    const answered = linkedWallets(book).filter((wallet) => isDemo(wallet) === isDemo(focus))
    // The demo's wallets start at different blocks, so their costs couldn't be worked out together, and its report stays its own.
    const own = !isDemo(focus) && (others.length > 0 || answered.includes(focus))
    const listed = new Set([focus, ...others, ...(own ? answered : [])])
    // Anyone else's wallet takes nothing from the user's, so only the demo needs them.
    const costsFrom = isDemo(focus) ? answered.filter((wallet) => !listed.has(wallet) && wallet !== (focus === "demo" ? DEMO_ADDRESS : focus)) : []
    if (others.length > MAX_OTHER_WALLETS || listed.size - 1 + costsFrom.length > MAX_OTHER_WALLETS) return sendJson(res, 400, { error: `A report can add up to ${MAX_OTHER_WALLETS} other wallets.` })

    // One at a time, because a read that fails answers the request. A report never quietly leaves a wallet out.
    const readAll = async (addresses: Iterable<string>): Promise<WalletResponse[] | null> => {
      const read: WalletResponse[] = []
      for (const next of addresses) {
        const wallet = await readWallet(next, res)
        const converted = wallet && (await inCurrency(wallet, currency, res, [book]))
        if (!converted) return null
        read.push(converted)
      }
      return read
    }
    const wallets = await readAll(listed)
    const context = wallets && (await readAll(costsFrom))
    if (!wallets || !context) return
    sendJson(res, 200, taxReportOf(wallets, { country, method, scope, year }, { book, costsFrom: context }))
  }

  /**
   * One wallet by both rules, from one set of facts at one block: the first rule's rows, balances, fees and exchange rates
   * go on both sides, and only prices come from each. Answers with why not when that can't be established.
   */
  async function compare(address: string, currency: CurrencyCode, method: Method, linked: readonly string[], res: ServerResponse, book?: Book): Promise<void> {
    const [first, second] = rules
    if (!first || !second) {
      sendJson(res, 404, { error: "There's only one pricing rule here, so there's nothing to compare." })
      return
    }
    if (!isAddress(address)) {
      sendJson(res, 400, { error: "That isn't a Base address." })
      return
    }
    const notYet = () => sendJson(res, 409, { error: "The two rules haven't reached the same block yet. Try again in a moment." })
    const own = address.toLowerCase()
    const others = linked.filter((other) => other !== own)
    const read: WalletResponse[] = []
    for (const by of [first, second]) {
      for (const wallet of [own, ...others]) {
        const answer = await readWallet(wallet, res, { fresh: true, rule: by })
        if (!answer) return
        read.push(answer)
      }
    }
    // One can be a block or two ahead, so compare where everything has been.
    const blockNum = Math.min(...read.map((wallet) => wallet.coverage.toBlock))
    if (read.some((wallet) => blockNum < wallet.coverage.fromBlock)) return notYet()
    try {
      const [atA, atB] = [await first.source.readLatestReference(blockNum), await second.source.readLatestReference(blockNum)]
      // A current price at another block, or none, would be a difference that isn't the rule.
      if (!atA || !atB || atA.blockNum !== atB.blockNum) return notYet()
      const pair = async (wallet: string, withBalances: boolean): Promise<[WalletResponse, WalletResponse] | null | undefined> => {
        const facts = await first.wallets.factsAt(wallet, blockNum, { withBalances })
        if (!facts) return null
        // Each rule's own market prices at this block, and only where both have one, so a token priced on one side alone
        // can't look like the rule.
        const [pricesA, pricesB] = [latestPrices(atA), latestPrices(atB)]
        const market = sharedMarket(await first.wallets.marketOn(wallet, facts, pricesA), await second.wallets.marketOn(wallet, facts, pricesB))
        const a = first.wallets.pricedOn(wallet, facts, pricesA, market)
        const b = second.wallets.pricedOn(wallet, facts, pricesB, market)
        if (!a || !b) return null
        // A block one side has no price for would look like the rule made a number unavailable.
        const blocksOf = (wallet: WalletResponse) => new Set(wallet.references.map((reference) => reference.blockNum))
        const [pricedA, pricedB] = [blocksOf(a), blocksOf(b)]
        if (a.legs.some((leg) => pricedA.has(leg.blockNum) !== pricedB.has(leg.blockNum))) return null
        // One read of the rates, on both sides. Answers the request itself when it fails, so that's not a "not yet".
        const shown = await inCurrency(a, currency, res, book ? [book] : [])
        if (!shown) return undefined
        return [{ ...shown, rule: first.rule.id, ruleNote: first.note }, { ...b, currency: shown.currency, rates: shown.rates, ...(shown.paidRates ? { paidRates: shown.paidRates } : {}), rule: second.rule.id, ruleNote: second.note }]
      }
      const main = await pair(own, true)
      if (main === undefined) return
      if (main === null) return notYet()
      const linkedA: WalletResponse[] = []
      const linkedB: WalletResponse[] = []
      for (const other of others) {
        const both = await pair(other, false)
        if (both === undefined) return
        if (both === null) return notYet()
        linkedA.push(both[0])
        linkedB.push(both[1])
      }
      sendJson(res, 200, compareRules({ rule: first.rule, wallet: main[0], reference: atA, linked: linkedA }, { rule: second.rule, wallet: main[1], reference: atB, linked: linkedB }, method, blockNum, book))
    } catch (error) {
      sendAmpError(res, error)
    }
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    try {
      return await route(req, res)
    } catch (error) {
      // Folds aren't all inside a read's `try`, and every one of them can ask for this.
      if (!(error instanceof OldestFirstTooBigError || error instanceof WalletsTooBigError)) throw error
      sendAmpError(res, error)
      return true
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = pathOf(req)
    if (path === null) {
      sendJson(res, 400, { error: "Bad request" })
      return true
    }
    if (!path.startsWith("/api/")) return false
    if (req.method === "POST") {
      await handlePost(path, req, res)
      return true
    }
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Method not allowed" })
      return true
    }

    if (path === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" })
      res.write(": connected\n\n")
      if (!source) return true
      subscribers.add(res)
      req.on("close", () => {
        subscribers.delete(res)
        if (subscribers.size === 0) following?.abort()
      })
      // It outlives this request, and reads for everyone watching.
      forEveryone(() => void followLoop())
      return true
    }

    if (path === "/api/rules") {
      sendJson(res, 200, { rules: rules.map(({ rule }) => rule) })
      return true
    }

    if (path === "/api/rate") {
      const currency = new URL(req.url ?? "/", "http://localhost").searchParams.get("currency")
      if (!isMainCurrency(currency)) {
        sendJson(res, 400, { error: "That isn't a currency this app shows amounts in." })
        return true
      }
      await answerRate(currency, res)
      return true
    }

    const progressMatch = /^\/api\/wallet\/([^/]+)\/progress$/.exec(path)
    if (progressMatch) {
      const address = (progressMatch[1] as string).toLowerCase()
      if (address === "demo" || address === DEMO_ADDRESS || demoWallet(address)) sendJson(res, 200, { stage: "costs", transfers: null, isContract: false })
      else if (!isAddress(address)) sendJson(res, 400, { error: "That isn't a Base address." })
      else sendJson(res, 200, { ...(wallets?.progress(address) ?? { stage: "waiting", transfers: null }), isContract: await isContract(address) })
      return true
    }

    const orderMatch = /^\/api\/onramp\/orders\/([A-Za-z0-9_-]{1,64})$/.exec(path)
    if (orderMatch) {
      if (onramp) await onrampAnswer(res, async () => ({ orders: await onramp.orders(orderMatch[1] as string) }))
      else sendJson(res, 503, { error: NO_ONRAMP })
      return true
    }

    const params = new URL(req.url ?? "/", "http://localhost").searchParams
    const ruleId = params.get("rule")
    const rule = ruleId === null ? (rules[0] ?? null) : (rules.find((r) => r.rule.id === ruleId) ?? null)
    if (ruleId !== null && !rule) {
      sendJson(res, 400, { error: "That pricing rule isn't available here." })
      return true
    }
    const currency = parseCurrency(params.get("currency"))
    if (!currency) {
      sendJson(res, 400, { error: "That currency isn't supported." })
      return true
    }

    const approvalsMatch = /^\/api\/approvals\/([^/]+)$/.exec(path)
    if (approvalsMatch) {
      await answerApprovals(approvalsMatch[1] as string, res)
      return true
    }

    const walletMatch = /^\/api\/wallet\/([^/]+)$/.exec(path)
    if (walletMatch) {
      const paidIn = parsePaidIn(params.get("paid"))
      if (!paidIn) {
        sendJson(res, 400, { error: "That currency isn't supported." })
        return true
      }
      const read = await readWallet(walletMatch[1] as string, res, { fresh: true, rule })
      const wallet = read && (await inCurrency(read, currency, res, [], paidIn))
      if (wallet) sendJson(res, 200, wallet)
      return true
    }

    const proofMatch = /^\/api\/portfolio\/([^/]+)\/(proof|verify)$/.exec(path)
    if (proofMatch) {
      const wallet = await readWallet(proofMatch[1] as string, res, { fresh: false, rule })
      if (!wallet) return true
      const proofs = wallet.mode === "demo" ? null : (created?.proofs ?? null)
      const byRule = Boolean(wallet.ruleNote)
      const asset = params.get("asset")
      if (asset !== null) {
        const price = wallet.prices[asset]
        if (!price || price.source !== "oracle") {
          sendJson(res, 404, { error: "This price doesn't come from Chainlink." })
          return true
        }
        try {
          const behind = proofs ? await proofs.currentPriceBehind(asset, price, wallet.prices.ETH, byRule) : null
          const revision = behind && currentRevision(behind, price, wallet.prices.ETH, wallet.rule ?? null)
          if (proofMatch[2] === "proof") {
            // A proof of any other price would sit beside the one on screen as if it were about that.
            if (params.get("price") !== price.micros) {
              sendJson(res, 412, { error: "This price has just changed. Its proof will show once the new price does." })
              return true
            }
            sendJson(res, 200, { ...currentProofOf(asset, price.blockNum, currency, proofs ? await proofs.datasets(rule?.note ? rule.rule : null, asset) : [], proofs ? null : DEMO_UNVERIFIABLE, behind, wallet.ruleNote ?? null), ...(revision ? { revision } : {}) })
            return true
          }
          if (!proofs) {
            sendJson(res, 400, { error: DEMO_UNVERIFIABLE })
            return true
          }
          if (!behind) {
            sendJson(res, 404, { error: "A price read from a contract has no log to check, so there's no block to verify." })
            return true
          }
          // Checking the newest update instead would pass or fail something other than what the proof on screen says.
          if (params.get("revision") !== revision) {
            sendJson(res, 412, { error: "The update behind this price has changed, so its proof was read again. Check the new one." })
            return true
          }
          const blocks = [...new Set(behind.updates.flatMap(({ update }) => (update && !isSeed(update) ? [update.block_num] : [])))]
          const reads = new Map(await Promise.all(blocks.map(async (block) => [block, await proofs.readBlock(block)] as const)))
          sendJson(res, 200, currentVerificationOf(behind, reads))
        } catch (error) {
          sendAmpError(res, error, "Couldn't read this block.")
        }
        return true
      }
      const leg = wallet.legs.find(({ id }) => id === params.get("leg"))
      if (!leg || leg.opening || !leg.txHash) {
        sendJson(res, 404, { error: "There's no transaction behind that." })
        return true
      }
      const feed = feedBehind(leg, wallet.legs)
      if (proofMatch[2] === "proof") {
        // The rest of the proof doesn't depend on this read, so a failure just says the update couldn't be found.
        const behind: PriceBehind | null =
          proofs && feed
            ? await proofs.priceBehind(feed, leg.blockNum).catch((error: unknown) => {
                console.error("Amp query failed:", describeError(error))
                return { feed, update: null }
              })
            : null
        sendJson(res, 200, proofOf(leg, wallet.legs, currency, proofs ? await proofs.datasets(rule?.note ? rule.rule : null) : [], proofs ? null : DEMO_UNVERIFIABLE, behind && { ...behind, byRule }, wallet.ruleNote ?? null))
        return true
      }
      if (!proofs) {
        sendJson(res, 400, { error: DEMO_UNVERIFIABLE })
        return true
      }
      let read: BlockRead | null
      let checkedUpdate: CheckedUpdate | null = null
      try {
        read = await proofs.readBlock(leg.blockNum)
        const behind = read && feed ? await proofs.priceBehind(feed, leg.blockNum) : null
        // A price read when a local Amp started has no log to check, and the proof says so.
        if (behind && !isSeed(behind.update)) {
          const updateBlock = behind.update?.block_num
          checkedUpdate = { behind: { ...behind, byRule }, read: updateBlock === undefined ? null : updateBlock === leg.blockNum ? read : await proofs.readBlock(updateBlock) }
        }
      } catch (error) {
        sendAmpError(res, error, "Couldn't read this block.")
        return true
      }
      if (read) sendJson(res, 200, verificationOf(leg, wallet.legs, read.data, read.deposits, checkedUpdate, read.nodeHash))
      else sendJson(res, 404, { error: "The price service doesn't have this block." })
      return true
    }

    const portfolioMatch = /^\/api\/portfolio\/([^/]+)(\/explain|\/compare)?$/.exec(path)
    if (portfolioMatch) {
      const method = parseMethod(params.get("method"))
      if (!method) {
        sendJson(res, 400, { error: "The method is either average or fifo." })
        return true
      }
      if (portfolioMatch[2] === "/compare") {
        const linked = parseLinked(params.get("linked"))
        if (!linked) sendJson(res, 400, { error: "Linked wallets are a comma-separated list of Base addresses." })
        else await compare(portfolioMatch[1] as string, currency, method, linked, res)
        return true
      }
      const target = portfolioMatch[2] ? parseExplainTarget(params) : null
      if (portfolioMatch[2] && !target) {
        sendJson(res, 400, { error: "That isn't a number this can explain." })
        return true
      }
      const linked = parseLinked(params.get("linked"))
      if (!linked) {
        sendJson(res, 400, { error: "Linked wallets are a comma-separated list of Base addresses." })
        return true
      }
      const read = await readWallet(portfolioMatch[1] as string, res, { fresh: !target, rule })
      const wallet = read && (await inCurrency(read, currency, res))
      if (!wallet) return true
      const linkedWallets: WalletResponse[] = []
      for (const address of wallet.mode === "demo" ? [] : linked.filter((address) => address !== wallet.address)) {
        // A cost that can't be read isn't a cost of zero, so this answers with the failure instead of a wrong number.
        const other = await readWallet(address, res, { fresh: !target, rule })
        const converted = other && (await inCurrency(other, currency, res))
        if (!converted) return true
        linkedWallets.push(converted)
      }
      if (!target) {
        sendJson(res, 200, portfolioOf(wallet, method, linkedWallets))
        return true
      }
      const explanation = explainPortfolio(wallet, method, target, linkedWallets)
      if (explanation) sendJson(res, 200, explanation)
      else sendJson(res, 404, { error: "This wallet has nothing like that." })
      return true
    }

    const taxMatch = /^\/api\/tax-report\/([^/]+)$/.exec(path)
    if (taxMatch) {
      const also = (params.get("also") ?? "").split(",")
      await taxReport(taxMatch[1] as string, { country: params.get("country"), method: params.get("method"), scope: params.get("scope"), year: params.get("year") }, also, currency, emptyBook(), res)
      return true
    }

    sendJson(res, 404, { error: "Not found" })
    return true
  }
}
