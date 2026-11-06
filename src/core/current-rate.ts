// The current rate for an open form on the web, read the way the Mac app's store does: `PortfolioStore.readRate`.

import type { CurrencyCode } from "@pricetag/sdk/core"
import { failureOf, ReadError, retryAfterOf } from "./read-failure.ts"

const READ_EVERY_MS = 5 * 60 * 1000
const RETRY_AFTER_MS = 30 * 1000
/** The feed moves hourly at most, so a failed read can keep the last rate this long, and after that amounts go back to USD. */
const LASTS_MS = 60 * 60 * 1000
const READ_TIMEOUT_MS = 15 * 1000

/** What one USD buys now, in millionths, or null when the server says there's no current rate. Throws when it can't say. */
export async function readCurrentRate(currency: CurrencyCode, signal: AbortSignal, send: typeof fetch = fetch): Promise<string | null> {
  const response = await send(`/api/rate?currency=${currency}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)]) })
  // Whatever the body says, since something in front of the server can answer this too.
  if (response.status === 429) throw new ReadError({ kind: "slowedDown", said: "Too many requests.", retryAfter: retryAfterOf(response) })
  if (!response.ok) throw new Error(`The rate read answered ${response.status}`)
  const { rateMicros } = (await response.json()) as { rateMicros?: unknown }
  if (rateMicros === null || (typeof rateMicros === "string" && /^[1-9]\d*$/.test(rateMicros))) return rateMicros
  throw new Error("The rate read answered something else")
}

/** Keeps reading until it's stopped, and says whenever there's a rate to use, or none. An answer of no rate counts straight away. Returns what stops it. */
export function followCurrentRate(read: (signal: AbortSignal) => Promise<string | null>, onRate: (rateMicros: string | null) => void): () => void {
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let expiry: ReturnType<typeof setTimeout> | undefined
  let readAt: number | null = null

  const expire = () => {
    readAt = null
    onRate(null)
  }

  const next = async () => {
    let delay = READ_EVERY_MS
    try {
      const rateMicros = await read(abort.signal)
      if (abort.signal.aborted) return
      readAt = rateMicros === null ? null : Date.now()
      onRate(rateMicros)
    } catch (error) {
      if (abort.signal.aborted) return
      const failure = failureOf(error)
      delay = failure.kind === "slowedDown" ? failure.retryAfter * 1000 : RETRY_AFTER_MS
      if (readAt !== null) {
        const left = readAt + LASTS_MS - Date.now()
        if (left < 0) expire()
        // The next read is too late to notice, and a server that said to wait isn't asked any sooner.
        else if (delay > left) expiry = setTimeout(expire, left)
      }
    }
    timer = setTimeout(() => void next(), delay)
  }

  void next()
  return () => {
    abort.abort()
    clearTimeout(timer)
    clearTimeout(expiry)
  }
}
