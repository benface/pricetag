// `pnpm start`: serves the built app and the API. Binds to localhost, since this is a personal tool with a staging token.

import { createReadStream, existsSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { extname, join, resolve, sep } from "node:path"
import { createApi } from "./app.ts"

const DIST = resolve(import.meta.dirname, "../dist")
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".map": "application/json",
}
// No scripts from anywhere but this server.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"

const handleApi = createApi(process.env)
const port = Number(process.env.PORT || 8787)

createServer((req, res) => {
  void handleApi(req, res).then((handled) => {
    if (handled) return
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname)
    const requested = resolve(join(DIST, path))
    const inside = requested === DIST || requested.startsWith(DIST + sep)
    const file = inside && existsSync(requested) && statSync(requested).isFile() ? requested : join(DIST, "index.html")
    if (!existsSync(file)) {
      res.writeHead(503, { "content-type": "text/plain" })
      res.end("Run `pnpm build` first.")
      return
    }
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
    })
    createReadStream(file).pipe(res)
  })
}).listen(port, "127.0.0.1", () => {
  console.log(`Pricetag is on http://localhost:${port}`)
})
