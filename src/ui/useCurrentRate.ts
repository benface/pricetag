import { useEffect, useState } from "react"
import type { CurrencyCode } from "@pricetag/sdk/core"
import { followCurrentRate, readCurrentRate } from "../core/current-rate.ts"

/** What one USD buys now, in millionths, for as long as the form's open. Null in USD, while it's read, or when there's no current rate, so an amount stays in USD then. */
export function useCurrentRate(currency: CurrencyCode): string | null {
  const [read, setRead] = useState<{ currency: CurrencyCode; rateMicros: string | null } | null>(null)
  useEffect(() => {
    if (currency === "USD") return
    return followCurrentRate(
      (signal) => readCurrentRate(currency, signal),
      (rateMicros) => setRead({ currency, rateMicros }),
    )
  }, [currency])
  return read?.currency === currency ? read.rateMicros : null
}
