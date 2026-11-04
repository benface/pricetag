// The small server: the only way to Amp for the browser and the Mac app, so the token stays here.
// Used by `pnpm start` and, inside Vite, by `pnpm dev`.

import type { IncomingMessage, ServerResponse } from "node:http"
import { isAddress, isCurrencyCode, latestPrices, type CurrencyCode, type Method } from "@pricetag/sdk/core"
import { DEFAULT_RPC_URL, createL1FeeReader, createQuery, createWallets, describeError, sharedMarket, type Source } from "@pricetag/sdk/internal"
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
import { feedRounds, rawSource, resolvingSource } from "./source.ts"
import { TAX_COUNTRIES, isTaxCountryCode, taxReportOf, type TaxScope } from "../src/core/tax.ts"

type Env = Record<string, string | undefined>

const POLL_MS = 2000
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

function createSource(env: Env): { source: Source; rules?: RuleSource[]; readRates: ReturnType<typeof createRates>; proofs: Proofs } | null {
  if (!env.AMP_QUERY_URL) return null
  const query = createQuery(env.AMP_QUERY_URL, env.AMP_QUERY_TOKEN || undefined)
  const baseDataset = env.PRICETAG_BASE_DATASET || "edgeandnode/base_mainnet@0.0.2"
  const network = env.PRICETAG_RPC_NETWORK || "base_mainnet"
  const readRates = createRates(feedRounds(query, { baseDataset, network }))
  const proofs = createProofs(query, {
    baseDataset,
    dataset: env.PRICETAG_DATASET || null,
    readDeposits: createDepositReader(env.BASE_RPC_URL || DEFAULT_RPC_URL),
    readManifestHash: createManifestReader(env.AMP_ADMIN_URL || `${env.AMP_QUERY_URL}/controller`, env.AMP_QUERY_TOKEN || undefined),
  })
  if (env.PRICETAG_DATASET) {
    const startBlock = Number(env.PRICETAG_START_BLOCK)
    if (!Number.isSafeInteger(startBlock) || startBlock <= 0) throw new Error("PRICETAG_DATASET needs PRICETAG_START_BLOCK")
    void warnOfNewAggregators(env.BASE_RPC_URL || DEFAULT_RPC_URL)
    if (env.PRICETAG_FORK_DATASET) {
      // The same SQL for both. The header alone says which prices it reads, and the transactions always come from the
      // first, so they can't differ.
      const dataset = pinned(env.PRICETAG_DATASET, env.PRICETAG_DATASET_HASH)
      const ruleSource = (id: string, name: string, hash: string | undefined, priceDataset: string): RuleSource => ({
        rule: { id, ...RULE_TEXT[id]!, dataset: name, hash: hash as string },
        source: resolvingSource(query.aliased({ pricetag: dataset, pricing: priceDataset }), { baseDataset, dataset: "pricetag", priceDataset: "pricing", startBlock, network }),
      })
      const rules = [
        ruleSource(MARKET_RULE_ID, env.PRICETAG_DATASET, env.PRICETAG_DATASET_HASH, dataset),
        ruleSource(CAUTIOUS_RULE_ID, env.PRICETAG_FORK_DATASET, env.PRICETAG_FORK_HASH, pinned(env.PRICETAG_FORK_DATASET, env.PRICETAG_FORK_HASH)),
      ]
      return { source: rules[0]!.source, rules, readRates, proofs }
    }
    return { source: resolvingSource(query, { baseDataset, dataset: env.PRICETAG_DATASET, startBlock, network }), readRates, proofs }
  }
  const historyBlocks = Number(env.PRICETAG_HISTORY_BLOCKS || 1800)
  if (!Number.isSafeInteger(historyBlocks) || historyBlocks <= 0) throw new Error("PRICETAG_HISTORY_BLOCKS must be a positive number")
  return { source: rawSource(query, { baseDataset, network, historyBlocks }), readRates, proofs }
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

export function createApi(env: Env, created: ReturnType<typeof createSource> = createSource(env)) {
  const source = created?.source ?? null

  let head: Head | null = null
  const subscribers = new Set<ServerResponse>()
  let polling = false

  async function pollHead(): Promise<Head> {
    if (!source) throw new Error("No Amp source")
    const next = await source.head(head?.blockNum ?? null)
    if (next) head = next
    if (!head) throw new Error("No blocks yet")
    return head
  }

  // Only polls while a browser is watching, one query at a time.
  async function pollLoop() {
    if (polling) return
    polling = true
    let last = head?.blockNum ?? null
    while (subscribers.size > 0) {
      const started = Date.now()
      let message: string
      try {
        const current = await pollHead()
        if (current.blockNum === last) message = ""
        else {
          last = current.blockNum
          message = `event: head\ndata: ${JSON.stringify(current)}\n\n`
        }
      } catch (error) {
        console.error("Head poll failed:", describeError(error))
        message = `event: down\ndata: {}\n\n`
      }
      if (message) for (const subscriber of subscribers) subscriber.write(message)
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, POLL_MS - (Date.now() - started))))
    }
    polling = false
  }

  const readL1Fees = createL1FeeReader(env.BASE_RPC_URL || DEFAULT_RPC_URL)
  const wallets = source ? createWallets(source, pollHead, readL1Fees) : null
  // Each rule keeps its own, so a rule nobody's looking at costs nothing. The first rule is the same as having none.
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
        const market = sharedMarket(await first.wallets.marketOn(wallet, facts), await second.wallets.marketOn(wallet, facts))
        const a = first.wallets.pricedOn(wallet, facts, latestPrices(atA), market)
        const b = second.wallets.pricedOn(wallet, facts, latestPrices(atB), market)
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
      req.on("close", () => subscribers.delete(res))
      void pollLoop()
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
      const country = params.get("country")
      if (!isTaxCountryCode(country)) {
        sendJson(res, 400, { error: "That country isn't supported." })
        return true
      }
      const rules = TAX_COUNTRIES[country]
      const method = params.has("method") ? parseMethod(params.get("method")) : rules.method
      if (!method) {
        sendJson(res, 400, { error: "The method is either average or fifo." })
        return true
      }
      const scope = params.has("scope") ? parseScope(params.get("scope")) : rules.scope
      if (!scope) {
        sendJson(res, 400, { error: "The calculation is either pooled or per-wallet." })
        return true
      }
      const address = (taxMatch[1] as string).toLowerCase()
      const others = (params.get("also") ?? "").split(",").map((other) => other.trim().toLowerCase()).filter(Boolean)
      if (others.length > MAX_OTHER_WALLETS) {
        sendJson(res, 400, { error: `A report can add up to ${MAX_OTHER_WALLETS} other wallets.` })
        return true
      }
      const bad = others.find((other) => !isAddress(other))
      if (bad !== undefined) {
        sendJson(res, 400, { error: `${bad} isn't a Base address.` })
        return true
      }
      // Whichever way round: demo data must never land in a report on a real wallet.
      if (others.length > 0 && [address, ...others].some((wallet) => wallet === "demo" || wallet === DEMO_ADDRESS)) {
        sendJson(res, 400, { error: "The demo wallet can't be combined with other wallets." })
        return true
      }
      // One at a time, because a read that fails answers the request. A report never quietly leaves a wallet out.
      const wallets: WalletResponse[] = []
      for (const next of new Set([address, ...others])) {
        const read = await readWallet(next, res)
        const wallet = read && (await inCurrency(read, currency, res))
        if (!wallet) return true
        wallets.push(wallet)
      }
      sendJson(res, 200, taxReportOf(wallets, { country, method, scope }))
      return true
    }

    sendJson(res, 404, { error: "Not found" })
    return true
  }
}
