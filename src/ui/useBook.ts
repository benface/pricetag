import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { CurrencyCode } from "@pricetag/sdk/core"
import type { WalletResponse } from "../core/api.ts"
import { applyAnswer, changeStoredBook, isBookKey, linkDeviceAccounts, readStoredBook, recordPurchase, same, storedBook, undoAnswer, type Book, type Purchase } from "../core/book.ts"
import { readKey, readsMatching } from "../core/resolve.ts"
import { browserShelf } from "../core/shelf.ts"
import { walletUrl } from "./useWallet.ts"

/** `number` says where it goes, for an undo that couldn't be saved and has to go back. */
type Step = { number: number; before: Book; after: Book }

/** Shared with `usePurchases`. */
export const shelf = browserShelf()

/** The user's answers, kept in this browser and nowhere else. Undo goes back one of this tab's answers at a time, and leaves what other tabs have said. */
export function useBook() {
  const [book, setBook] = useState(() => storedBook(localStorage))
  // Not state, because a save can fail between renders, and an undo right then has to see the step that put back.
  const history = useRef<Step[]>([])
  const [canUndo, setCanUndo] = useState(false)
  const [notSaved, setNotSaved] = useState(false)
  const steps = useRef(0)

  const setHistory = useCallback((next: Step[]) => {
    history.current = next
    setCanUndo(next.length > 0)
  }, [])

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

  // Something the user just did, so they're told if it didn't stick.
  const act = useCallback(
    (update: (latest: Book) => Book, undone?: () => void) => {
      setNotSaved(false)
      save(update).catch((error) => {
        console.error(error)
        setNotSaved(true)
        undone?.()
      })
    },
    [save],
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
      const step = { number: ++steps.current, before: book, after: next }
      setHistory([...history.current, step])
      act(
        (latest) => applyAnswer(latest, book, next),
        () => setHistory(history.current.filter((other) => other !== step)),
      )
    },
    [book, act, setHistory],
  )
  const undo = useCallback(() => {
    const step = history.current.at(-1)
    if (!step) return
    setHistory(history.current.slice(0, -1))
    act(
      (latest) => undoAnswer(latest, step.before, step.after),
      () => setHistory([...history.current, step].sort((a, b) => a.number - b.number)),
    )
  }, [act, setHistory])

  // Not an answer, so undo doesn't take it back, whichever answers came before it.
  const linkAccounts = useCallback(
    (addresses: readonly string[]) => act((latest) => linkDeviceAccounts(latest, addresses)),
    [act],
  )

  // What an order says, and not an answer either. Whoever calls this hears if it wasn't saved, so the order can be read again.
  const addPurchase = useCallback((purchase: Purchase) => save((latest) => recordPurchase(latest, purchase)), [save])

  return { book, change, undo, canUndo, notSaved, linkAccounts, addPurchase }
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
