// The small server: the browser's only way to Amp, so the token stays here.
// Used by `pnpm start` and, inside Vite, by `pnpm dev`.

import type { IncomingMessage, ServerResponse } from "node:http"
import { createQuery, describeError, isAddress } from "@pricetag/sdk"
import type { Head } from "../src/core/api.ts"
import { DEMO_ADDRESS, DEMO_WALLET } from "../src/core/fixtures.ts"
import { datasetSource, rawSource, type Source } from "./source.ts"
import { createWallets } from "./wallets.ts"

type Env = Record<string, string | undefined>

const POLL_MS = 2000

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

    const match = /^\/api\/wallet\/([^/]+)$/.exec(path)
    if (match) {
      const address = match[1] as string
      if (address === "demo" || address === DEMO_ADDRESS) {
        sendJson(res, 200, DEMO_WALLET)
        return true
      }
      if (!isAddress(address)) {
        sendJson(res, 400, { error: "That isn't a Base address." })
        return true
      }
      if (!wallets) {
        sendJson(res, 503, { error: "No Amp connection is set up, so only the demo wallet is available." })
        return true
      }
      try {
        sendJson(res, 200, await wallets.get(address))
      } catch (error) {
        sendAmpError(res, error)
      }
      return true
    }

    sendJson(res, 404, { error: "Not found" })
    return true
  }
}
