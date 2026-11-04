import { useEffect, useRef, useState } from "react"
import type { WalletResponse } from "../core/api.ts"
import type { CurrencyCode } from "@pricetag/sdk/core"

export type WalletState = {
  wallet: WalletResponse | null
  loading: boolean
  /** Set when the latest read failed. `wallet` then still holds the last good data, so the UI must say it's old. */
  error: string | null
}

async function fetchWallet(address: string, currency: CurrencyCode, rule: string | null, signal: AbortSignal): Promise<WalletResponse> {
  const response = await fetch(`/api/wallet/${address}?currency=${currency}${rule ? `&rule=${encodeURIComponent(rule)}` : ""}`, { signal })
  const body = (await response.json().catch(() => ({ error: "Can't reach the server." }))) as WalletResponse | { error: string }
  if (!response.ok || "error" in body) throw new Error("error" in body ? body.error : "Couldn't read this wallet.")
  return body
}

const LOST_CONNECTION = "Lost the connection to the server."
const RECONNECT_MS = 3000

/** Reads a wallet, then reads it again on each new block. A block that arrives during a read waits for the next one. */
export function useWallet(address: string | null, currency: CurrencyCode, rule: string | null): WalletState {
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
      fetchWallet(address, currency, rule, abort.signal)
        .then((wallet) => setState((s) => ({ wallet, loading: false, error: connected && drops === dropsAtStart ? null : s.error })))
        .catch((error: Error) => {
          if (abort.signal.aborted) return
          const message = error instanceof TypeError ? "Can't reach the server." : error.message
          setState((s) => ({ ...s, loading: false, error: message }))
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
      events.addEventListener("down", () => setState((s) => ({ ...s, error: "Can't reach the data source." })))
      events.addEventListener("error", () => {
        connected = false
        drops++
        setState((s) => ({ ...s, loading: false, error: LOST_CONNECTION }))
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
  }, [address, currency, rule])

  return state
}
