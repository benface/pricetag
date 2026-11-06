import { useCallback, useEffect, useMemo, useState } from "react"
import type { CurrencyCode } from "@pricetag/sdk/core"
import type { WalletResponse } from "../core/api.ts"
import { applyAnswer, changeStoredBook, isBookKey, linkDeviceAccounts, readStoredBook, recordPurchase, same, storedBook, undoAnswer, type Book, type Purchase } from "../core/book.ts"
import { readKey, readsMatching } from "../core/resolve.ts"
import { browserShelf } from "../core/shelf.ts"
import { walletUrl } from "./useWallet.ts"

type Step = { before: Book; after: Book }

/** Shared with `usePurchases`. */
export const shelf = browserShelf()

/** The user's answers, kept in this browser and nowhere else. Undo goes back one of this tab's answers at a time, and leaves what other tabs have said. */
export function useBook() {
  const [book, setBook] = useState(() => storedBook(localStorage))
  const [history, setHistory] = useState<Step[]>([])

  const show = useCallback((latest: Book) => setBook((shown) => (same(shown, latest) ? shown : latest)), [])

  // On screen right away, and then whatever the stored book says it became, with what other tabs have added. It rejects if that couldn't be saved.
  const save = useCallback(
    async (update: (latest: Book) => Book) => {
      setBook(update)
      try {
        show(await changeStoredBook(shelf, update))
      } catch (error) {
        show(storedBook(localStorage))
        throw error
      }
    },
    [show],
  )

  useEffect(() => {
    const read = () => void readStoredBook(shelf).then(show, console.error)
    const onStorage = (event: StorageEvent) => {
      if (isBookKey(event.key)) read()
    }
    read()
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [show])

  const change = useCallback(
    (next: Book) => {
      setHistory((h) => [...h, { before: book, after: next }])
      save((latest) => applyAnswer(latest, book, next)).catch(console.error)
    },
    [book, save],
  )
  const undo = useCallback(() => {
    const step = history.at(-1)
    if (!step) return
    setHistory(history.slice(0, -1))
    save((latest) => undoAnswer(latest, step.before, step.after)).catch(console.error)
  }, [history, save])

  // Not an answer, so undo doesn't take it back, whichever answers came before it.
  const linkAccounts = useCallback(
    (addresses: readonly string[]) => {
      save((latest) => linkDeviceAccounts(latest, addresses)).catch(console.error)
    },
    [save],
  )

  // What an order says, and not an answer either. Whoever calls this hears if it wasn't saved, so the order can be read again.
  const addPurchase = useCallback((purchase: Purchase) => save((latest) => recordPurchase(latest, purchase)), [save])

  return { book, change, undo, canUndo: history.length > 0, linkAccounts, addPurchase }
}

/**
 * Reads other wallets, and again on each new block of the wallet on screen. One that can't be read yet stays out, and one
 * whose read failed is in `failed`, so nobody's told it's still reading. `retry` reads them all again now.
 */
/**
 * Linked wallets, read by `rule` in `currency`. `shown` is how the numbers on screen were read, which for a moment after a
 * change isn't that: they go with the wallets read the same way, and a newer read waits until they've changed too.
 */
export function useOtherWallets(addresses: readonly string[], currency: CurrencyCode, rule: string | null, paid: string, block: number | null, shown: Pick<WalletResponse, "rule" | "currency"> | null) {
  const [wallets, setWallets] = useState<Record<string, WalletResponse>>({})
  const [failures, setFailures] = useState<ReadonlySet<string>>(new Set())
  const [attempt, setAttempt] = useState(0)
  const key = addresses.join(",")

  useEffect(() => {
    if (!key) return
    const abort = new AbortController()
    const fail = (address: string) => setFailures((f) => new Set([...f, address]))
    for (const address of key.split(",")) {
      fetch(walletUrl(address, currency, rule, paid), { signal: abort.signal })
        .then((response) => (response.ok ? (response.json() as Promise<WalletResponse>) : null))
        .then((wallet) => {
          if (!wallet) return fail(address)
          setWallets((w) => ({ ...w, [readKey(address, wallet)]: wallet }))
          setFailures((f) => new Set([...f].filter((other) => other !== address)))
        })
        .catch(() => {
          if (!abort.signal.aborted) fail(address)
        })
    }
    return () => abort.abort()
  }, [key, currency, rule, paid, block, attempt])

  return {
    others: useMemo(() => readsMatching(wallets, key ? key.split(",") : [], shown), [wallets, key, shown?.rule, shown?.currency]),
    failed: addresses.filter((address) => failures.has(address)),
    retry: useCallback(() => setAttempt((n) => n + 1), []),
  }
}
