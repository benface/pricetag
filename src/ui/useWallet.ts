import { useEffect, useRef, useState } from "react"
import type { WalletResponse } from "../core/api.ts"
import { ALL_YOURS, type AllYoursRead } from "../core/combined.ts"
import type { CurrencyCode } from "@pricetag/sdk/core"
import { failureOf, readResponse, type ReadFailure } from "../core/read-failure.ts"

export type WalletState = {
  wallet: WalletResponse | null
  loading: boolean
  /** Set when the latest read failed. `wallet` then still holds the last good data, so the UI must say it's old. */
  error: ReadFailure | null
}

/** Where a wallet's read. `paid` is the currencies the book holds amounts in, comma-separated, because this client folds its answers without sending them. */
export const walletUrl = (address: string, currency: CurrencyCode, rule: string | null, paid: string) => `/api/wallet/${address}?currency=${currency}${rule ? `&rule=${encodeURIComponent(rule)}` : ""}${paid ? `&paid=${paid}` : ""}`

async function fetchWallet(address: string, currency: CurrencyCode, rule: string | null, paid: string, signal: AbortSignal): Promise<WalletResponse> {
  return readResponse<WalletResponse>(await fetch(walletUrl(address, currency, rule, paid), { signal }))
}

/** A post, so that which wallets are someone's doesn't end up in a URL, and so in logs. No answers go with it: they stay here. */
async function fetchAllYours(addresses: readonly string[], currency: CurrencyCode, rule: string | null, paid: string, signal: AbortSignal): Promise<AllYoursRead> {
  return readResponse<AllYoursRead>(await fetch(`/api/portfolio/${ALL_YOURS}/wallets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ linked: addresses, currency, rule, paid }), signal }))
}

const RECONNECT_MS = 3000
/** How soon to read again while a wallet's still being read, since nothing else says when it's done. */
const READ_AGAIN_MS = 2000

type LiveState<T> = { value: T | null; loading: boolean; error: ReadFailure | null }

type LiveOptions<T> = {
  /** Whether new blocks can change it. */
  live: boolean
  /** Whether it's worth reading again without waiting for a new block. */
  unfinished?: (value: T) => boolean
}

/**
 * Reads something, then reads it again on each new block. A block that arrives during a read waits for the next one. `showing`
 * is what's on screen, and only a change to that clears it. Any other change to `request` keeps the numbers up until the new
 * ones arrive, since they say what they're in. `attempt` reads again now.
 */
function useLiveRead<T>(showing: string | null, request: string, read: (signal: AbortSignal) => Promise<T>, { live, unfinished }: LiveOptions<T>, attempt = 0): LiveState<T> {
  const [state, setState] = useState<LiveState<T>>({ value: null, loading: false, error: null })
  const shown = useRef<string | null>(null)

  useEffect(() => {
    if (shown.current !== showing) setState({ value: null, loading: showing !== null, error: null })
    shown.current = showing
    if (showing === null) return
    const abort = new AbortController()
    let busy = false
    let readAgain = false
    // No updates can arrive while this is false, so a read that finishes then doesn't mean the numbers are current.
    let connected = true
    // Counts dropped connections, so a read that started before the last one can't clear its warning.
    let drops = 0
    let soon: ReturnType<typeof setTimeout> | undefined

    const refresh = () => {
      if (busy) {
        readAgain = readAgain || !connected
        return
      }
      busy = true
      readAgain = false
      clearTimeout(soon)
      const dropsAtStart = drops
      read(abort.signal)
        .then((value) => {
          setState((s) => ({ value, loading: false, error: connected && drops === dropsAtStart ? null : s.error }))
          if (unfinished?.(value)) soon = setTimeout(refresh, READ_AGAIN_MS)
        })
        .catch((error: unknown) => {
          if (abort.signal.aborted) return
          setState((s) => ({ ...s, loading: false, error: failureOf(error) }))
        })
        .finally(() => {
          busy = false
          if (readAgain && !abort.signal.aborted) refresh()
        })
    }
    refresh()

    const stop = () => {
      clearTimeout(soon)
      abort.abort()
    }
    if (!live) return stop

    let events: EventSource
    let retry: ReturnType<typeof setTimeout> | undefined
    const connect = () => {
      events = new EventSource("/api/events")
      events.addEventListener("open", () => {
        if (connected) return
        // Blocks may have gone by unseen, so catch up. The warning clears only once that read succeeds.
        connected = true
        readAgain = busy
        refresh()
      })
      events.addEventListener("head", refresh)
      events.addEventListener("down", () => setState((s) => ({ ...s, error: { kind: "unavailable", said: "Can't reach the data source." } })))
      events.addEventListener("error", () => {
        connected = false
        drops++
        setState((s) => ({ ...s, loading: false, error: { kind: "unreachable" } }))
        // The browser retries a dropped connection by itself, but gives up for good on an error response.
        if (events.readyState === EventSource.CLOSED) retry = setTimeout(connect, RECONNECT_MS)
      })
    }
    connect()
    return () => {
      clearTimeout(retry)
      events.close()
      stop()
    }
  }, [showing, request, attempt])

  return state
}

/** Reads a wallet, and again on each new block. */
export function useWallet(address: string | null, currency: CurrencyCode, rule: string | null, paid: string): WalletState & { retry: () => void } {
  const [attempt, setAttempt] = useState(0)
  const { value, loading, error } = useLiveRead(address, `${currency}:${rule}:${paid}`, (signal) => fetchWallet(address as string, currency, rule, paid, signal), { live: address !== "demo" }, attempt)
  return { wallet: value, loading, error, retry: () => setAttempt((n) => n + 1) }
}

/**
 * Reads all the user's wallets together, so they're all at one block, and again on each new block. Each is its own read on the
 * server, so a slow one doesn't hold up the rest: it's listed as still reading, and looked at again soon. Answering for another
 * wallet adds it without clearing what's on screen.
 */
export function useAllYours(addresses: readonly string[] | null, currency: CurrencyCode, rule: string | null, paid: string) {
  const [attempt, setAttempt] = useState(0)
  const { value, loading, error } = useLiveRead(addresses ? ALL_YOURS : null, `${addresses?.join(",")}:${currency}:${rule}:${paid}`, (signal) => fetchAllYours(addresses as string[], currency, rule, paid, signal), { live: true, unfinished: ({ unread }) => unread.reading.length > 0 }, attempt)
  return { read: value, loading, error, retry: () => setAttempt((n) => n + 1) }
}
