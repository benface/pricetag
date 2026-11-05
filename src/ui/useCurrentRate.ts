import { useEffect, useState } from "react"
import type { CurrencyCode } from "@pricetag/sdk/core"

/** What one USD buys now, in millionths. Null in USD, while it's read, or when there's no current rate, so an amount stays in USD then. */
export function useCurrentRate(currency: CurrencyCode): string | null {
  const [read, setRead] = useState<{ currency: CurrencyCode; rateMicros: string | null } | null>(null)
  useEffect(() => {
    if (currency === "USD") return
    const abort = new AbortController()
    fetch(`/api/rate?currency=${currency}`, { signal: abort.signal })
      .then((response) => (response.ok ? (response.json() as Promise<{ rateMicros?: unknown }>) : null))
      .then((body) => setRead({ currency, rateMicros: typeof body?.rateMicros === "string" ? body.rateMicros : null }))
      .catch(() => {
        if (!abort.signal.aborted) setRead({ currency, rateMicros: null })
      })
    return () => abort.abort()
  }, [currency])
  return read?.currency === currency ? read.rateMicros : null
}
