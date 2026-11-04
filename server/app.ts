// The small server: the only way to Amp for the browser and the Mac app, so the token stays here.
// Used by `pnpm start` and, inside Vite, by `pnpm dev`.

import type { IncomingMessage, ServerResponse } from "node:http"
import { createQuery, describeError, isAddress, type Method } from "@pricetag/sdk"
import type { Head, WalletResponse } from "../src/core/api.ts"
import { isCurrencyCode, type CurrencyCode } from "../src/core/currency.ts"
import { DEMO_ADDRESS, DEMO_WALLET, demoRates } from "../src/core/fixtures.ts"
import { explainPortfolio, parseExplainTarget, portfolioOf } from "./portfolio.ts"
import { createRates } from "./rates.ts"
import { DEFAULT_RPC_URL, createL1FeeReader } from "./receipts.ts"
import { datasetSource, feedRounds, rawSource, type Source } from "./source.ts"
import { TAX_COUNTRIES, isTaxCountryCode, taxReportOf, type TaxScope } from "../src/core/tax.ts"
import { createWallets } from "./wallets.ts"

type Env = Record<string, string | undefined>

const POLL_MS = 2000

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

function createSource(env: Env): { source: Source; readRates: ReturnType<typeof createRates> } | null {
  if (!env.AMP_QUERY_URL) return null
  const query = createQuery(env.AMP_QUERY_URL, env.AMP_QUERY_TOKEN || undefined)
  const baseDataset = env.PRICETAG_BASE_DATASET || "edgeandnode/base_mainnet@0.0.2"
  const network = env.PRICETAG_RPC_NETWORK || "base_mainnet"
  const readRates = createRates(feedRounds(query, { baseDataset, network }))
  if (env.PRICETAG_DATASET) {
    const startBlock = Number(env.PRICETAG_START_BLOCK)
    if (!Number.isSafeInteger(startBlock) || startBlock <= 0) throw new Error("PRICETAG_DATASET needs PRICETAG_START_BLOCK")
    return { source: datasetSource(query, { baseDataset, dataset: env.PRICETAG_DATASET, startBlock, network }), readRates }
  }
  const historyBlocks = Number(env.PRICETAG_HISTORY_BLOCKS || 1800)
  if (!Number.isSafeInteger(historyBlocks) || historyBlocks <= 0) throw new Error("PRICETAG_HISTORY_BLOCKS must be a positive number")
  return { source: rawSource(query, { baseDataset, network, historyBlocks }), readRates }
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

export function createApi(env: Env) {
  const created = createSource(env)
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

  const wallets = source ? createWallets(source, pollHead, createL1FeeReader(env.BASE_RPC_URL || DEFAULT_RPC_URL)) : null

  /**
   * Reads a wallet, or answers the request with why it can't.
   * `fresh: false` settles for the last read if there is one: a read can take seconds, and a click shouldn't wait on it.
   */
  async function readWallet(address: string, res: ServerResponse, { fresh } = { fresh: true }): Promise<WalletResponse | null> {
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
      return (!fresh && wallets.peek(address)) || (await wallets.get(address))
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

    const params = new URL(req.url ?? "/", "http://localhost").searchParams
    const currency = parseCurrency(params.get("currency"))
    if (!currency) {
      sendJson(res, 400, { error: "That currency isn't supported." })
      return true
    }

    const walletMatch = /^\/api\/wallet\/([^/]+)$/.exec(path)
    if (walletMatch) {
      const read = await readWallet(walletMatch[1] as string, res)
      const wallet = read && (await inCurrency(read, currency, res))
      if (wallet) sendJson(res, 200, wallet)
      return true
    }

    const portfolioMatch = /^\/api\/portfolio\/([^/]+)(\/explain)?$/.exec(path)
    if (portfolioMatch) {
      const method = parseMethod(params.get("method"))
      if (!method) {
        sendJson(res, 400, { error: "The method is either average or fifo." })
        return true
      }
      const target = portfolioMatch[2] ? parseExplainTarget(params) : null
      if (portfolioMatch[2] && !target) {
        sendJson(res, 400, { error: "That isn't a number this can explain." })
        return true
      }
      const read = await readWallet(portfolioMatch[1] as string, res, { fresh: !target })
      const wallet = read && (await inCurrency(read, currency, res))
      if (!wallet) return true
      if (!target) {
        sendJson(res, 200, portfolioOf(wallet, method))
        return true
      }
      const explanation = explainPortfolio(wallet, method, target)
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
