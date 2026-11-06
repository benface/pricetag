// `pnpm start`: serves the built app and the API. It binds to localhost, since locally it's a personal tool with a staging token.
// With PRICETAG_HOSTED=1 it's the shared server instead: see "Hosting" in the README and `server/hosting.ts`.

import { createServer } from "node:http"
import { resolve } from "node:path"
import { createApi, createSource } from "./app.ts"
import { createCoinbase } from "./coinbase.ts"
import { clientIpOf, gate, hostingOf, useStructuredLogs } from "./hosting.ts"
import { createHandler } from "./http.ts"

const hosting = hostingOf(process.env)
if (hosting.hosted) useStructuredLogs(process.env)

const maxWallets = process.env.PRICETAG_MAX_WALLETS ? Number(process.env.PRICETAG_MAX_WALLETS) : undefined
if (maxWallets !== undefined && (!Number.isSafeInteger(maxWallets) || maxWallets <= 0)) throw new Error("PRICETAG_MAX_WALLETS must be a positive whole number")

const created = createSource(process.env)
const onramp = createCoinbase(process.env)
const api = gate(createApi(process.env, created, onramp, { clientIp: (req) => clientIpOf(req, hosting.clientIpHeader), maxWallets }), hosting, () => ({ amp: created !== null, buying: onramp !== null }))
const server = createServer(createHandler(api, hosting.servesApp ? resolve(import.meta.dirname, "../dist") : null))

server.listen(hosting.port, hosting.host, () => {
  console.log(hosting.hosted ? `Pricetag is serving on port ${hosting.port}, for ${hosting.invites.size} invites` : `Pricetag is on http://localhost:${hosting.port}`)
})

// A host stops an instance with SIGTERM, and gives it a few seconds. New requests go elsewhere while these finish.
let stopping = false
function stop(signal: string) {
  if (stopping) return
  stopping = true
  console.log(`${signal}: finishing what's in flight`)
  api.drain()
  server.close(() => process.exit(0))
  server.closeIdleConnections()
  setTimeout(() => {
    server.closeAllConnections()
    process.exit(0)
  }, hosting.drainMs).unref()
}
process.on("SIGTERM", () => stop("SIGTERM"))
process.on("SIGINT", () => stop("SIGINT"))
