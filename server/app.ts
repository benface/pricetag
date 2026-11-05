// The small server: the only way to Amp for the browser and the Mac app, so the token stays here.
// Used by `pnpm start` and, inside Vite, by `pnpm dev`.

import type { IncomingMessage, ServerResponse } from "node:http"
import { isAddress, isCurrencyCode, latestPrices, type CurrencyCode, type Method } from "@pricetag/sdk/core"
import { DEFAULT_RPC_URL, createL1FeeReader, createQuery, createRangeStream, createWallets, describeError, followChain, followRawSql, followSql, readHeadMark, sharedMarket, type AmpQuery, type FollowConfig, type Source } from "@pricetag/sdk/internal"
import type { Head, WalletResponse } from "../src/core/api.ts"
import { emptyBook, linkedWallets, parseBook, type Book } from "../src/core/book.ts"
import { parseCoinbaseCsv } from "../src/core/exchange-import.ts"
import { exportCsv } from "../src/core/export.ts"
import { DEMO_ADDRESS, DEMO_WALLET, demoRates, demoWallet } from "../src/core/fixtures.ts"
import { foldBook, previewBook } from "../src/core/resolve.ts"
import { CAUTIOUS_RULE_ID, MARKET_RULE_ID, RULE_TEXT, ruleNote, type PricingRule } from "../src/core/rules.ts"
import { verifyLink } from "./links.ts"
import { compareRules, explainPortfolio, parseExplainTarget, portfolioOf } from "./portfolio.ts"
import { createRates } from "./rates.ts"
import { createDepositReader } from "./block.ts"
import { warnOfNewAggregators } from "./feeds.ts"
import { createManifestReader, createProofs, feedBehind, isSeed, proofOf, verificationOf, type BlockRead, type CheckedUpdate, type PriceBehind, type Proofs } from "./proof.ts"
import { feedRounds, rawSource, resolvingSource, settledL1Fees, sharedReads, type SharedReads } from "./source.ts"
import { TAX_COUNTRIES, isTaxCountryCode, taxReportOf, type TaxScope } from "../src/core/tax.ts"

type Env = Record<string, string | undefined>

const DEMO_UNVERIFIABLE = "This is the demo wallet, so there's no real block to check."

function parseMethod(value: string | null): Method | null {
  if (value === null || value === "average") return "average"
  return value === "fifo" ? "fifo" : null
}

function parseScope(value: string | null): TaxScope | null {
  return value === "pooled" || value === "per-wallet" ? value : null
}

/** How many other wallets a report can add. Each is a full read. */
const MAX_OTHER_WALLETS = 20

function parseCurrency(value: string | null): CurrencyCode | null {
  if (value === null) return "USD"
  return isCurrencyCode(value) ? value : null
}

/** A pricing rule, and where a wallet's rows come from when it's read through that rule. */
type RuleSource = { rule: PricingRule; source: Source }

const MANIFEST_HASH = /^[0-9a-f]{64}$/

/** A dataset reference pinned to the manifest it's meant to be, so what's shown as the rule's hash is what gets read. */
function pinned(dataset: string, hash: string | undefined): string {
  if (!hash || !MANIFEST_HASH.test(hash)) throw new Error(`PRICETAG_FORK_DATASET needs the manifest hash of ${dataset}`)
  return `${dataset.split("@")[0]}@${hash}`
}

export function createSource(env: Env, query: AmpQuery | null = env.AMP_QUERY_URL ? createQuery(env.AMP_QUERY_URL, env.AMP_QUERY_TOKEN || undefined) : null): { source: Source; rules?: RuleSource[]; readRates: ReturnType<typeof createRates>; proofs: Proofs; follow: FollowConfig; shared?: SharedReads } | null {
  if (!query) return null
  const baseDataset = env.PRICETAG_BASE_DATASET || "edgeandnode/base_mainnet@0.0.2"
  const network = env.PRICETAG_RPC_NETWORK || "base_mainnet"
  const readRates = createRates(feedRounds(query, { baseDataset, network }))
  // How the server hears about new blocks. Amp's block ranges name a network with a dash, and its RPC functions with an underscore.
  const followOf = (sql: string): FollowConfig => ({ stream: env.AMP_QUERY_URL ? createRangeStream(env.AMP_QUERY_URL, env.AMP_QUERY_TOKEN || undefined, network.replaceAll("_", "-")) : null, sql, readMark: (after) => readHeadMark(query, baseDataset, after) })
  // Only a fork pins the default. Without one, a hash left in the env can be a hosted Amp's, which a local Amp doesn't have.
  const pin = env.PRICETAG_DATASET && env.PRICETAG_FORK_DATASET ? pinned(env.PRICETAG_DATASET, env.PRICETAG_DATASET_HASH) : null
  const proofs = createProofs(pin ? query.aliased({ pricetag: pin }) : query, {
    baseDataset,
    dataset: env.PRICETAG_DATASET ? { name: env.PRICETAG_DATASET, reference: pin ? "pricetag" : env.PRICETAG_DATASET, hash: pin ? env.PRICETAG_DATASET_HASH! : null } : null,
    readDeposits: createDepositReader(env.BASE_RPC_URL || DEFAULT_RPC_URL),
    readManifestHash: createManifestReader(env.AMP_ADMIN_URL || `${env.AMP_QUERY_URL}/controller`, env.AMP_QUERY_TOKEN || undefined),
  })
  if (env.PRICETAG_DATASET) {
    const startBlock = Number(env.PRICETAG_START_BLOCK)
    if (!Number.isSafeInteger(startBlock) || startBlock <= 0) throw new Error("PRICETAG_DATASET needs PRICETAG_START_BLOCK")
    void warnOfNewAggregators(env.BASE_RPC_URL || DEFAULT_RPC_URL)
    if (pin) {
      // The same SQL for both. The header alone says which prices it reads, and the transactions always come from the
      // first, so they can't differ.
      const shared = sharedReads(query.aliased({ pricetag: pin }), { baseDataset, dataset: "pricetag", network })
      const ruleSource = (id: string, name: string, hash: string | undefined, priceDataset: string): RuleSource => ({
        rule: { id, ...RULE_TEXT[id]!, dataset: name, hash: hash as string },
        source: resolvingSource(query.aliased({ pricetag: pin, pricing: priceDataset }), { baseDataset, dataset: "pricetag", priceDataset: "pricing", startBlock, network }, shared),
      })
      const rules = [
        ruleSource(MARKET_RULE_ID, env.PRICETAG_DATASET, env.PRICETAG_DATASET_HASH, pin),
        ruleSource(CAUTIOUS_RULE_ID, env.PRICETAG_FORK_DATASET!, env.PRICETAG_FORK_HASH, pinned(env.PRICETAG_FORK_DATASET!, env.PRICETAG_FORK_HASH)),
      ]
      return { source: rules[0]!.source, rules, readRates, proofs, follow: followOf(followSql(pin)), shared }
    }
    const shared = sharedReads(query, { baseDataset, dataset: env.PRICETAG_DATASET, network })
    return { source: resolvingSource(query, { baseDataset, dataset: env.PRICETAG_DATASET, startBlock, network }, shared), readRates, proofs, follow: followOf(followSql(env.PRICETAG_DATASET)), shared }
  }
  const historyBlocks = env.PRICETAG_HISTORY_BLOCKS ? Number(env.PRICETAG_HISTORY_BLOCKS) : null
  if (historyBlocks !== null && (!Number.isSafeInteger(historyBlocks) || historyBlocks <= 0)) throw new Error("PRICETAG_HISTORY_BLOCKS must be a positive number")
  return { source: rawSource(query, { baseDataset, network, historyBlocks }), readRates, proofs, follow: followOf(followRawSql(baseDataset)) }
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

export function createApi(env: Env, created: Created | null = createSource(env)) {
  const source = created?.source ?? null

  let head: Head | null = null
  const subscribers = new Set<ServerResponse>()
  let following: AbortController | null = null

  async function pollHead(): Promise<Head> {
    if (!source) throw new Error("No Amp source")
    const next = await source.head(head?.blockNum ?? null)
    if (next) head = next
    if (!head) throw new Error("No blocks yet")
    return head
  }

  const send = (message: string) => {
    for (const subscriber of subscribers) subscriber.write(message)
  }

  /** Blocks some already-read wallets hold were replaced. The next read of each replaces them, however far back it was. */
  async function rewindTo(block: number, tip: number) {
    const oldTip = Math.max(head?.blockNum ?? 0, tip)
    readL1Fees.rewind(block, oldTip)
    await Promise.all([created?.shared?.rewind(block, oldTip), ...[...new Set([wallets, ...rules.map((r) => r.wallets)])].map((w) => w?.rewind(block, oldTip))])
    created?.readRates.rewind?.(block)
    // The new chain can be shorter, and the head is only read from the last one on.
    if (head && head.blockNum >= block) head = { ...head, blockNum: block - 1 }
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

  const readL1Fees = settledL1Fees(createL1FeeReader(env.BASE_RPC_URL || DEFAULT_RPC_URL), () => head?.blockNum ?? null)
  const wallets = source ? createWallets(source, pollHead, readL1Fees) : null
  // Each rule keeps its own, so a rule nobody's looking at costs nothing, and what no rule changes is only read once. The first rule is the same as having none.
  const rules = (created?.rules ?? []).map(({ rule, source }, i) => ({ rule, source, note: i === 0 ? null : ruleNote(rule), wallets: i === 0 ? wallets! : createWallets(source, pollHead, readL1Fees) }))

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

  /** A wallet with the rates to show it in `currency`, or answers the request with why it can't. Never falls back to USD. */
  async function inCurrency(wallet: WalletResponse, currency: CurrencyCode, res: ServerResponse): Promise<WalletResponse | null> {
    if (currency === "USD") return wallet
    try {
      const rates = created && wallet.mode !== "demo" ? await created.readRates(currency, wallet) : demoRates(currency)
      return { ...wallet, currency, rates }
    } catch (error) {
      sendAmpError(res, error)
      return null
    }
  }

  /** Linked wallets whose last read failed, so a client can say so rather than go on saying it's reading. Each request tries again. */
  const linkedFailures = new Set<string>()

  /**
   * The linked wallets already read, in `currency`. Never waits on a first read, because it can take a while and a number
   * shouldn't: it starts the read, and what came from that wallet stays unresolved until the next request finds it.
   */
  async function linkedOf(focus: string, books: readonly Book[], currency: CurrencyCode, rule: (typeof rules)[number] | null, res: ServerResponse): Promise<WalletResponse[] | null> {
    const addresses = new Set(books.flatMap(linkedWallets))
    const read: WalletResponse[] = []
    for (const address of addresses) {
      if (address === focus.toLowerCase()) continue
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
      // With no data source, only the demo's own wallets can ever be read, so this one isn't still reading.
      if (!wallet && !wallets) linkedFailures.add(address)
      if (!wallet) continue
      const converted = await inCurrency(wallet, currency, res)
      if (!converted) return null
      read.push(converted)
    }
    return read
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

    const taxMatch = /^\/api\/tax-report\/([^/]+)$/.exec(path)
    if (taxMatch) {
      const currency = parseCurrency(typeof body.currency === "string" ? body.currency : null)
      if (!currency) return sendJson(res, 400, { error: "That currency isn't supported." })
      const book = body.book === undefined ? emptyBook() : parseBook(body.book)
      if (!book) return sendJson(res, 400, { error: "Those answers can't be read." })
      const also: unknown = body.also ?? []
      if (!Array.isArray(also) || !also.every((address) => typeof address === "string")) return sendJson(res, 400, { error: "Other wallets are a list of Base addresses." })
      return taxReport(taxMatch[1] as string, { country: body.country, method: body.method, scope: body.scope }, also as string[], currency, book, res)
    }

    const match = /^\/api\/portfolio\/([^/]+)(?:\/(explain|preview|export|compare))?$/.exec(path)
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

    const target = action === "explain" ? parseExplainTarget(new URL(req.url ?? "/", "http://localhost").searchParams) : null
    if (action === "explain" && !target) return sendJson(res, 400, { error: "That isn't a number this can explain." })
    const candidates = action === "preview" ? (Array.isArray(body.candidates) ? body.candidates.map(parseBook) : null) : []
    if (!candidates || candidates.includes(null) || candidates.length > 8) return sendJson(res, 400, { error: "Those answers can't be read." })
    const books = action === "preview" ? (candidates as Book[]) : [book]

    if (action === "compare") {
      const known = Array.isArray(body.linked) ? body.linked : []
      if (!known.every((address) => typeof address === "string" && isAddress(address))) return sendJson(res, 400, { error: "Linked wallets are a list of Base addresses." })
      const linking = { ...book, linked: known.map((address: string) => address.toLowerCase()) }
      return compare(match[1] as string, currency, method, linkedWallets(linking), res, linking)
    }

    const read = await readWallet(match[1] as string, res, { fresh: action === undefined, rule })
    const wallet = read && (await inCurrency(read, currency, res))
    if (!wallet) return
    // The client's own wallets, which only count on a wallet that's real.
    const known: unknown[] = wallet.mode === "demo" || !Array.isArray(body.linked) ? [] : body.linked
    if (!known.every((address) => typeof address === "string" && isAddress(address))) return sendJson(res, 400, { error: "Linked wallets are a list of Base addresses." })
    const linkedBooks = books.map((one) => ({ ...one, linked: (known as string[]).map((address) => address.toLowerCase()) }))
    const others = await linkedOf(wallet.address, linkedBooks, currency, rule, res)
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
   * those are in what the apps show. On a wallet nobody's said is theirs, like one being watched, the answers still decide
   * its costs, so they're read for that, but their sales aren't this wallet's to list. Demo data and real data never mix.
   */
  async function taxReport(address: string, choices: { country: unknown; method: unknown; scope: unknown }, also: readonly string[], currency: CurrencyCode, book: Book, res: ServerResponse): Promise<void> {
    const { country } = choices
    if (typeof country !== "string" || !isTaxCountryCode(country)) return sendJson(res, 400, { error: "That country isn't supported." })
    const defaults = TAX_COUNTRIES[country]
    const method = choices.method === null || choices.method === undefined ? defaults.method : parseMethod(typeof choices.method === "string" ? choices.method : "")
    if (!method) return sendJson(res, 400, { error: "The method is either average or fifo." })
    const scope = choices.scope === null || choices.scope === undefined ? defaults.scope : parseScope(typeof choices.scope === "string" ? choices.scope : "")
    if (!scope) return sendJson(res, 400, { error: "The calculation is either pooled or per-wallet." })

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
    const costsFrom = own ? [] : answered.filter((wallet) => !listed.has(wallet) && wallet !== (focus === "demo" ? DEMO_ADDRESS : focus))
    if (others.length > MAX_OTHER_WALLETS || listed.size - 1 + costsFrom.length > MAX_OTHER_WALLETS) return sendJson(res, 400, { error: `A report can add up to ${MAX_OTHER_WALLETS} other wallets.` })

    // One at a time, because a read that fails answers the request. A report never quietly leaves a wallet out.
    const readAll = async (addresses: Iterable<string>): Promise<WalletResponse[] | null> => {
      const read: WalletResponse[] = []
      for (const next of addresses) {
        const wallet = await readWallet(next, res)
        const converted = wallet && (await inCurrency(wallet, currency, res))
        if (!converted) return null
        read.push(converted)
      }
      return read
    }
    const wallets = await readAll(listed)
    const context = wallets && (await readAll(costsFrom))
    if (!wallets || !context) return
    sendJson(res, 200, taxReportOf(wallets, { country, method, scope }, { book, costsFrom: context }))
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
        const shown = await inCurrency(a, currency, res)
        if (!shown) return undefined
        return [{ ...shown, rule: first.rule.id, ruleNote: first.note }, { ...b, currency: shown.currency, rates: shown.rates, rule: second.rule.id, ruleNote: second.note }]
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
      void followLoop()
      return true
    }

    if (path === "/api/rules") {
      sendJson(res, 200, { rules: rules.map(({ rule }) => rule) })
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

    const walletMatch = /^\/api\/wallet\/([^/]+)$/.exec(path)
    if (walletMatch) {
      const read = await readWallet(walletMatch[1] as string, res, { fresh: true, rule })
      const wallet = read && (await inCurrency(read, currency, res))
      if (wallet) sendJson(res, 200, wallet)
      return true
    }

    const proofMatch = /^\/api\/portfolio\/([^/]+)\/(proof|verify)$/.exec(path)
    if (proofMatch) {
      const wallet = await readWallet(proofMatch[1] as string, res, { fresh: false, rule })
      if (!wallet) return true
      const leg = wallet.legs.find(({ id }) => id === params.get("leg"))
      if (!leg || leg.opening) {
        sendJson(res, 404, { error: "There's no transaction behind that." })
        return true
      }
      const proofs = wallet.mode === "demo" ? null : (created?.proofs ?? null)
      const feed = feedBehind(leg, wallet.legs)
      const byRule = Boolean(wallet.ruleNote)
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
      if (read) sendJson(res, 200, verificationOf(leg, wallet.legs, read.data, read.deposits, checkedUpdate))
      else sendJson(res, 404, { error: "Amp doesn't have this block." })
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
      await taxReport(taxMatch[1] as string, { country: params.get("country"), method: params.get("method"), scope: params.get("scope") }, also, currency, emptyBook(), res)
      return true
    }

    sendJson(res, 404, { error: "Not found" })
    return true
  }
}
