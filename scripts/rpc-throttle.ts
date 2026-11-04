// A local relay in front of the Base RPC, started by scripts/amp. It holds requests to a steady rate and retries 429s.
//
// Amp can't do this itself: `eth_call` ignores the provider's concurrency limit, and its rate limit allows a burst of
// a whole minute's quota, which starts over each time a job restarts. One rate-limited `eth_call` fails its job, so the
// restarted job bursts and fails again, forever.

import { createServer, type Server } from "node:http"
import { fileURLToPath } from "node:url"

const RETRIES = 20
const PAUSE_AFTER_429_MS = 1_000
const TIMEOUT_MS = 30_000

export function createThrottle(target: string, perSecond: number): Server {
  const gapMs = 1_000 / perSecond
  let nextSlot = 0

  const waitForSlot = () => {
    const now = Date.now()
    const slot = Math.max(now, nextSlot)
    nextSlot = slot + gapMs
    return new Promise((resolve) => setTimeout(resolve, slot - now))
  }

  return createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)

    try {
      for (let attempt = 0; ; attempt++) {
        await waitForSlot()
        const upstream = await fetch(target, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
        if (upstream.status === 429 && attempt < RETRIES) {
          // Everything waits, since the next request would get a 429 too.
          nextSlot = Math.max(nextSlot, Date.now() + PAUSE_AFTER_429_MS)
          continue
        }
        res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" })
        res.end(Buffer.from(await upstream.arrayBuffer()))
        return
      }
    } catch (error) {
      // Only the error's name, because its message can quote the URL, which can hold a key.
      console.error("RPC request failed:", error instanceof Error ? error.name : "unknown error")
      res.writeHead(502, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "RPC request failed" }))
    }
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.env.BASE_RPC_URL
  const perSecond = Number(process.env.BASE_RPC_RATE_LIMIT)
  const port = Number(process.argv[2])
  if (!target || !(perSecond > 0) || !Number.isInteger(port)) throw new Error("Needs BASE_RPC_URL, BASE_RPC_RATE_LIMIT and a port")
  createThrottle(target, perSecond).listen(port, "127.0.0.1")
}
