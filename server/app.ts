// The small server: the only way to Amp for the browser and the Mac app, so the token stays here.
// Used by `pnpm start` and, inside Vite, by `pnpm dev`.

import type { IncomingMessage, ServerResponse } from "node:http"
import { isAddress, type Head, type WalletResponse } from "../src/core/api.ts"
import { DEMO_ADDRESS, DEMO_WALLET } from "../src/core/fixtures.ts"
import type { Method } from "../src/core/fold.ts"
import { createQuery } from "./amp.ts"
import { explainPortfolio, parseExplainTarget, portfolioOf } from "./portfolio.ts"
import { datasetSource, rawSource, type Source } from "./source.ts"
import { createWallets } from "./wallets.ts"

type Env = Record<string, string | undefined>

const POLL_MS = 2000

function parseMethod(value: string | null): Method | null {
  if (value === null || value === "average") return "average"
  return value === "fifo" ? "fifo" : null
}

function createSource(env: Env): Source | null {
  if (!env.AMP_QUERY_URL) return null
  const query = createQuery(env.AMP_QUERY_URL, env.AMP_QUERY_TOKEN || undefined)
  const baseDataset = env.PRICETAG_BASE_DATASET || "edgeandnode/base_mainnet@0.0.2"
  if (env.PRICETAG_DATASET) {
    const startBlock = Number(env.PRICETAG_START_BLOCK)
    if (!Number.isSafeInteger(startBlock) || startBlock <= 0) throw new Error("PRICETAG_DATASET needs PRICETAG_START_BLOCK")
    return datasetSource(query, { baseDataset, dataset: env.PRICETAG_DATASET, startBlock })
  }
  const historyBlocks = Number(env.PRICETAG_HISTORY_BLOCKS || 1800)
  if (!Number.isSafeInteger(historyBlocks) || historyBlocks <= 0) throw new Error("PRICETAG_HISTORY_BLOCKS must be a positive number")
  return rawSource(query, { baseDataset, network: env.PRICETAG_RPC_NETWORK || "base_mainnet", historyBlocks })
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
  res.end(JSON.stringify(body))
}

/** Amp's client can throw errors with an empty message. These never contain the token, which only travels in a header. */
function describeError(error: unknown): string {
  return (error instanceof Error && error.message) || String(error)
}

/** Query errors can quote our SQL or the endpoint. The browser gets a fixed message, and the detail stays in the server log. */
function sendAmpError(res: ServerResponse, error: unknown) {
  console.error("Amp query failed:", describeError(error))
  sendJson(res, 502, { error: "Couldn't read from Amp." })
}

export function createApi(env: Env) {
  const source = createSource(env)

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

  const wallets = source ? createWallets(source, pollHead) : null

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
      sendJson(res, 503, { error: "No Amp connection is set up, so only the demo wallet is available." })
      return null
    }
    try {
      return (!fresh && wallets.peek(address)) || (await wallets.get(address))
    } catch (error) {
      sendAmpError(res, error)
      return null
    }
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost")
    const path = url.pathname
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

    const walletMatch = /^\/api\/wallet\/([^/]+)$/.exec(path)
    if (walletMatch) {
      const wallet = await readWallet(walletMatch[1] as string, res)
      if (wallet) sendJson(res, 200, wallet)
      return true
    }

    const portfolioMatch = /^\/api\/portfolio\/([^/]+)(\/explain)?$/.exec(path)
    if (portfolioMatch) {
      const method = parseMethod(url.searchParams.get("method"))
      if (!method) {
        sendJson(res, 400, { error: "The method is either average or fifo." })
        return true
      }
      const target = portfolioMatch[2] ? parseExplainTarget(url.searchParams) : null
      if (portfolioMatch[2] && !target) {
        sendJson(res, 400, { error: "That isn't a number this can explain." })
        return true
      }
      const wallet = await readWallet(portfolioMatch[1] as string, res, { fresh: !target })
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

    sendJson(res, 404, { error: "Not found" })
    return true
  }
}
