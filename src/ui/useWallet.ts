import { useEffect, useState } from "react"
import type { WalletResponse } from "../core/api.ts"

export type WalletState = {
  wallet: WalletResponse | null
  loading: boolean
  /** Set when the latest read failed. `wallet` then still holds the last good data, so the UI must say it's old. */
  error: string | null
}

async function fetchWallet(address: string, signal: AbortSignal): Promise<WalletResponse> {
  const response = await fetch(`/api/wallet/${address}`, { signal })
  const body = (await response.json()) as WalletResponse | { error: string }
  if (!response.ok || "error" in body) throw new Error("error" in body ? body.error : "Couldn't read this wallet.")
  return body
}

/** Reads a wallet, then reads it again on each new block. A block that arrives during a read waits for the next one. */
export function useWallet(address: string | null): WalletState {
  const [state, setState] = useState<WalletState>({ wallet: null, loading: false, error: null })

  useEffect(() => {
    setState({ wallet: null, loading: address !== null, error: null })
    if (!address) return
    const abort = new AbortController()
    let busy = false

    const read = () => {
      if (busy) return
      busy = true
      fetchWallet(address, abort.signal)
        .then((wallet) => setState({ wallet, loading: false, error: null }))
        .catch((error: Error) => {
          if (!abort.signal.aborted) setState((s) => ({ ...s, loading: false, error: error.message }))
        })
        .finally(() => {
          busy = false
        })
    }
    read()

    if (address === "demo") return () => abort.abort()
    const events = new EventSource("/api/events")
    events.addEventListener("head", read)
    events.addEventListener("down", () => setState((s) => ({ ...s, error: "Can't reach Amp." })))
    return () => {
      events.close()
      abort.abort()
    }
  }, [address])

  return state
}
