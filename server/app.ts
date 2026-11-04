// The small server: the only way to Amp for the browser and the Mac app, so the token stays here.
// Used by `pnpm start` and, inside Vite, by `pnpm dev`.

import type { IncomingMessage, ServerResponse } from "node:http"
import { isAddress, type Head, type WalletResponse } from "../src/core/api.ts"
import { emptyBook, linkedWallets, parseBook, type Book } from "../src/core/book.ts"
import { parseCoinbaseCsv } from "../src/core/exchange-import.ts"
import { exportCsv } from "../src/core/export.ts"
import { DEMO_ADDRESS, DEMO_WALLET, demoWallet } from "../src/core/fixtures.ts"
import type { Method } from "../src/core/fold.ts"
import { foldBook, previewBook } from "../src/core/portfolio.ts"
import { createQuery, describeError } from "./amp.ts"
import { verifyLink } from "./links.ts"
import { explainPortfolio, parseExplainTarget, portfolioOf } from "./portfolio.ts"
import { DEFAULT_RPC_URL, createL1FeeReader } from "./receipts.ts"
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
  const network = env.PRICETAG_RPC_NETWORK || "base_mainnet"
  if (env.PRICETAG_DATASET) {
    const startBlock = Number(env.PRICETAG_START_BLOCK)
    if (!Number.isSafeInteger(startBlock) || startBlock <= 0) throw new Error("PRICETAG_DATASET needs PRICETAG_START_BLOCK")
    return datasetSource(query, { baseDataset, dataset: env.PRICETAG_DATASET, startBlock, network })
  }
  const historyBlocks = Number(env.PRICETAG_HISTORY_BLOCKS || 1800)
  if (!Number.isSafeInteger(historyBlocks) || historyBlocks <= 0) throw new Error("PRICETAG_HISTORY_BLOCKS must be a positive number")
  return rawSource(query, { baseDataset, network, historyBlocks })
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
  sendJson(res, 502, { error: "Couldn't read from Amp." })
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

  const wallets = source ? createWallets(source, pollHead, createL1FeeReader(env.BASE_RPC_URL || DEFAULT_RPC_URL)) : null

  /**
   * Reads a wallet, or answers the request with why it can't.
   * `fresh: false` settles for the last read if there is one: a read can take seconds, and a click shouldn't wait on it.
   */
  async function readWallet(address: string, res: ServerResponse, { fresh } = { fresh: true }): Promise<WalletResponse | null> {
    if (address === "demo" || address === DEMO_ADDRESS) return DEMO_WALLET
    const demo = demoWallet(address)
    if (demo) return demo
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

  /**
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

    const match = /^\/api\/portfolio\/([^/]+)(?:\/(explain|preview|export))?$/.exec(path)
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

    const walletMatch = /^\/api\/wallet\/([^/]+)$/.exec(path)
    if (walletMatch) {
      const wallet = await readWallet(walletMatch[1] as string, res)
      if (wallet) sendJson(res, 200, wallet)
      return true
    }

    const portfolioMatch = /^\/api\/portfolio\/([^/]+)(\/explain)?$/.exec(path)
    if (portfolioMatch) {
      const params = new URL(req.url ?? "/", "http://localhost").searchParams
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
