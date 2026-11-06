import { useCallback, useEffect, useState } from "react"
import type { Money, Purchase } from "../core/book.ts"
import { changeStoredPurchases, isFollowed, isPurchasesKey, isResolved, purchaseOf, readOrder, settleOrder, startCheckout, storedPurchases, type CheckoutRequest, type TrackedPurchase } from "../core/purchases.ts"

const POLL_MS = 10_000

const readTracked = () => storedPurchases(localStorage)

/**
 * Purchases started from this browser, followed across reloads. Each change starts from what's stored, so a second tab can't
 * lose one. What an order says goes in the book whenever it's known, whichever tab or visit that was, because recording it twice changes nothing.
 */
export function usePurchases(record: (purchase: Purchase) => void) {
  const [purchases, setPurchases] = useState(readTracked)
  // Why orders can't be checked right now. They're tried again, and nothing's lost.
  const [problem, setProblem] = useState<string | null>(null)

  const update = useCallback((change: (current: TrackedPurchase[]) => TrackedPurchase[]) => {
    setPurchases(changeStoredPurchases(localStorage, change))
  }, [])

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (isPurchasesKey(event.key)) setPurchases(readTracked())
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])

  // Checking an order records it too. This is for a row saved in another tab or an earlier visit.
  useEffect(() => {
    for (const { order } of purchases) {
      const purchase = order && purchaseOf(order)
      if (purchase) record(purchase)
    }
  }, [purchases, record])

  const unresolved = purchases.filter((purchase) => !isResolved(purchase)).map(({ ref }) => ref).join(",")

  // Reads everything unresolved, however old, and keeps polling what's recent. Coming back from the provider's page reads it all again.
  useEffect(() => {
    if (!unresolved) return
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let busy = false

    const check = async () => {
      if (busy) return
      busy = true
      clearTimeout(timer)
      let failure: string | null = null
      for (const { ref } of readTracked().filter((purchase) => !isResolved(purchase))) {
        try {
          const order = await readOrder(ref, abort.signal)
          if (abort.signal.aborted) return
          // A failed read changes nothing, so a purchase can't get lost.
          if (order) setPurchases(settleOrder(localStorage, ref, order, record))
        } catch (error) {
          if (abort.signal.aborted) return
          failure = error instanceof TypeError || !(error instanceof Error) ? "Can't reach the server." : error.message
        }
      }
      setProblem(failure)
      busy = false
      if (readTracked().some((purchase) => isFollowed(purchase, Date.now()))) timer = setTimeout(() => void check(), POLL_MS)
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") void check()
    }
    void check()
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      abort.abort()
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [unresolved, record])

  /** Asks for a page, and starts following it. Throws when there's no page to open, with something to say about why. */
  const begin = useCallback(
    async (request: CheckoutRequest, typed: Money): Promise<string> => {
      const { page, ref } = await startCheckout(request)
      update((current) => [...current, { ref, wallet: request.address, asset: request.asset, typed, startedAt: Date.now(), order: null }])
      return page
    },
    [update],
  )

  /** Someone who's left the page without paying says so. */
  const dismiss = useCallback((ref: string) => update((current) => current.filter((one) => one.ref !== ref)), [update])

  return { purchases, problem, begin, dismiss }
}
