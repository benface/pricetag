// The request handler behind `pnpm start`: the API, then the built app. One bad request must never stop the server.

import { createReadStream, existsSync, statSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import { extname, join, resolve, sep } from "node:path"
import { pathOf } from "./app.ts"

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".map": "application/json",
}
// No scripts from anywhere but this server. Hardware wallets send to Base's RPC themselves, and a Ledger asks Ledger's servers what a token
// is so it can show its name. Ledger's kit can also report what's signed and have a transaction checked, which these leave out on purpose.
const CONNECT = ["'self'", "https://mainnet.base.org", "https://global.api.prd.ledger.com/cal/", "https://nft.api.live.ledger.com"]
export const CSP = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ${CONNECT.join(" ")}; frame-ancestors 'none'; base-uri 'none'`

function sendText(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, { "content-type": "text/plain" })
  res.end(text)
}

function serveStatic(req: IncomingMessage, res: ServerResponse, dist: string) {
  const path = pathOf(req)
  if (path === null) {
    sendText(res, 400, "Bad request")
    return
  }
  const requested = resolve(join(dist, path))
  const inside = requested === dist || requested.startsWith(dist + sep)
  const file = inside && existsSync(requested) && statSync(requested).isFile() ? requested : join(dist, "index.html")
  if (!existsSync(file)) {
    sendText(res, 503, "Run `pnpm build` first.")
    return
  }
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
  })
  createReadStream(file)
    .on("error", () => res.destroy())
    .pipe(res)
}

/** `dist` is null for a server that only answers the API, which a hosted one is by default. */
export function createHandler(handleApi: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>, dist: string | null) {
  return (req: IncomingMessage, res: ServerResponse) => {
    handleApi(req, res)
      .then((handled) => {
        if (handled) return
        if (dist) serveStatic(req, res, dist)
        else sendText(res, 404, "Not found")
      })
      .catch((error: unknown) => {
        console.error("Request failed:", error instanceof Error ? error.message : String(error))
        if (res.headersSent) res.destroy()
        else sendText(res, 500, "Something went wrong.")
      })
  }
}
