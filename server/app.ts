// The small server: the only way to Amp for the browser and the Mac app, so the token stays here.
// Used by `pnpm start` and, inside Vite, by `pnpm dev`.

import type { IncomingMessage, ServerResponse } from "node:http"
import { createQuery, describeError, isAddress, latestPrices, type Method } from "@pricetag/sdk"
import type { Head, WalletResponse } from "../src/core/api.ts"
import { isCurrencyCode, type CurrencyCode } from "../src/core/currency.ts"
import { DEMO_ADDRESS, DEMO_WALLET, demoRates } from "../src/core/fixtures.ts"
import { CAUTIOUS_RULE_ID, MARKET_RULE_ID, RULE_TEXT, ruleNote, type PricingRule } from "../src/core/rules.ts"
import { compareRules, explainPortfolio, parseExplainTarget, portfolioOf } from "./portfolio.ts"
import { createRates } from "./rates.ts"
import { DEFAULT_RPC_URL, createL1FeeReader } from "./receipts.ts"
import { datasetSource, feedRounds, rawSource, type Source } from "./source.ts"
import { createWallets } from "./wallets.ts"

type Env = Record<string, string | undefined>

const POLL_MS = 2000

function parseMethod(value: string | null): Method | null {
  if (value === null || value === "average") return "average"
  return value === "fifo" ? "fifo" : null
}

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

function createSource(env: Env): { source: Source; rules?: RuleSource[]; readRates: ReturnType<typeof createRates> } | null {
  if (!env.AMP_QUERY_URL) return null
  const query = createQuery(env.AMP_QUERY_URL, env.AMP_QUERY_TOKEN || undefined)
  const baseDataset = env.PRICETAG_BASE_DATASET || "edgeandnode/base_mainnet@0.0.2"
  const network = env.PRICETAG_RPC_NETWORK || "base_mainnet"
  const readRates = createRates(feedRounds(query, { baseDataset, network }))
  if (env.PRICETAG_DATASET) {
    const startBlock = Number(env.PRICETAG_START_BLOCK)
    if (!Number.isSafeInteger(startBlock) || startBlock <= 0) throw new Error("PRICETAG_DATASET needs PRICETAG_START_BLOCK")
    if (env.PRICETAG_FORK_DATASET) {
      // The same SQL for both. The header alone says which prices it reads, and the transactions always come from the
      // first, so they can't differ.
      const dataset = pinned(env.PRICETAG_DATASET, env.PRICETAG_DATASET_HASH)
      const ruleSource = (id: string, name: string, hash: string | undefined, priceDataset: string): RuleSource => ({
        rule: { id, ...RULE_TEXT[id]!, dataset: name, hash: hash as string },
        source: datasetSource(query.aliased({ pricetag: dataset, pricing: priceDataset }), { baseDataset, dataset: "pricetag", priceDataset: "pricing", startBlock, network }),
      })
      const rules = [
        ruleSource(MARKET_RULE_ID, env.PRICETAG_DATASET, env.PRICETAG_DATASET_HASH, dataset),
        ruleSource(CAUTIOUS_RULE_ID, env.PRICETAG_FORK_DATASET, env.PRICETAG_FORK_HASH, pinned(env.PRICETAG_FORK_DATASET, env.PRICETAG_FORK_HASH)),
      ]
      return { source: rules[0]!.source, rules, readRates }
    }
    return { source: datasetSource(query, { baseDataset, dataset: env.PRICETAG_DATASET, startBlock, network }), readRates }
  }
  const historyBlocks = Number(env.PRICETAG_HISTORY_BLOCKS || 1800)
  if (!Number.isSafeInteger(historyBlocks) || historyBlocks <= 0) throw new Error("PRICETAG_HISTORY_BLOCKS must be a positive number")
  return { source: rawSource(query, { baseDataset, network, historyBlocks }), readRates }
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
function sendAmpError(res: ServerResponse, error: unknown) {
  console.error("Amp query failed:", describeError(error))
  sendJson(res, 502, { error: "Couldn't read this wallet's data." })
}

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

  /** The two rules' wallets at one block, or answers the request with why they can't be compared yet. */
  async function compare(address: string, currency: CurrencyCode, method: Method, linked: readonly string[], res: ServerResponse): Promise<void> {
    const [first, second] = rules
    if (!first || !second) {
      sendJson(res, 404, { error: "There's only one pricing rule here, so there's nothing to compare." })
      return
    }
    if (!isAddress(address)) {
      sendJson(res, 400, { error: "That isn't a Base address." })
      return
    }
    const a = await readWallet(address, res, { fresh: true, rule: first })
    const b = a && (await readWallet(address, res, { fresh: true, rule: second }))
    if (!a || !b) return
    // One can be a block or two ahead, and a price moves between blocks, so compare where both have been.
    const blockNum = Math.min(a.coverage.toBlock, b.coverage.toBlock)
    const movedSince = (wallet: WalletResponse) => wallet.legs.some((leg) => leg.blockNum > blockNum)
    if (blockNum < a.coverage.fromBlock || movedSince(a) || movedSince(b)) {
      sendJson(res, 409, { error: "The two rules haven't reached the same block yet. Try again in a moment." })
      return
    }
    try {
      const side = async (by: (typeof rules)[number], wallet: WalletResponse): Promise<Parameters<typeof compareRules>[0] | null> => {
        const reference = await by.source.readLatestReference(blockNum)
        const shown = await inCurrency({ ...wallet, prices: latestPrices(reference) }, currency, res)
        if (!shown) return null
        // Costs carried over from the user's other wallets are priced by the same rule as the wallet they land on.
        const others: WalletResponse[] = []
        for (const other of linked.filter((a) => a !== wallet.address)) {
          const read = await readWallet(other, res, { fresh: true, rule: by })
          const converted = read && (await inCurrency(read, currency, res))
          if (!converted) return null
          others.push(converted)
        }
        return { rule: by.rule, wallet: shown, reference, linked: others }
      }
      const left = await side(first, a)
      const right = left && (await side(second, b))
      if (left && right) sendJson(res, 200, compareRules(left, right, method, blockNum))
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

    sendJson(res, 404, { error: "Not found" })
    return true
  }
}
