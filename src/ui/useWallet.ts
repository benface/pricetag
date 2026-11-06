import { useCallback, useEffect, useRef, useState } from "react"
import type { WalletResponse } from "../core/api.ts"
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

const RECONNECT_MS = 3000

/** Reads a wallet, then reads it again on each new block. A block that arrives during a read waits for the next one. */
export function useWallet(address: string | null, currency: CurrencyCode, rule: string | null, paid: string): WalletState & { retry: () => void } {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<WalletState>({ wallet: null, loading: false, error: null })
  const shownAddress = useRef<string | null>(null)

  useEffect(() => {
    // A change of currency or rule keeps the numbers up until the new ones arrive. They say what they're in.
    if (shownAddress.current !== address) setState({ wallet: null, loading: address !== null, error: null })
    shownAddress.current = address
    if (!address) return
    const abort = new AbortController()
    let busy = false
    let readAgain = false
    // No updates can arrive while this is false, so a read that finishes then doesn't mean the numbers are current.
    let connected = true
    // Counts dropped connections, so a read that started before the last one can't clear its warning.
    let drops = 0

    const read = () => {
      if (busy) {
        readAgain = readAgain || !connected
        return
      }
      busy = true
      readAgain = false
      const dropsAtStart = drops
      fetchWallet(address, currency, rule, paid, abort.signal)
        .then((wallet) => setState((s) => ({ wallet, loading: false, error: connected && drops === dropsAtStart ? null : s.error })))
        .catch((error: unknown) => {
          if (abort.signal.aborted) return
          setState((s) => ({ ...s, loading: false, error: failureOf(error) }))
        })
        .finally(() => {
          busy = false
          if (readAgain && !abort.signal.aborted) read()
        })
    }
    read()

    if (address === "demo") return () => abort.abort()

    let events: EventSource
    let retry: ReturnType<typeof setTimeout> | undefined
    const connect = () => {
      events = new EventSource("/api/events")
      events.addEventListener("open", () => {
        if (connected) return
        // Blocks may have gone by unseen, so catch up. The warning clears only once that read succeeds.
        connected = true
        readAgain = busy
        read()
      })
      events.addEventListener("head", read)
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
      abort.abort()
    }
  }, [address, currency, rule, paid, attempt])

  return { ...state, retry: useCallback(() => setAttempt((n) => n + 1), []) }
}
