import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { CurrencyCode } from "@pricetag/sdk/core"
import type { WalletResponse } from "../core/api.ts"
import { applyChange, changeStoredBook, isBookKey, linkDeviceAccounts, readStoredBook, recordPurchase, same, storedBook, storedBookHasNoCopy, undoAnswer, type Book, type BookChange, type Purchase } from "../core/book.ts"
import { readKey, readsMatching } from "../core/resolve.ts"
import { readStoredPurchases, isPurchasesKey, storedPurchasesHaveNoCopy } from "../core/purchases.ts"
import { browserShelf, hasUnseenSetAside, isSetAsideKey, markSetAsideSeen, plainShelf, type Shelf } from "../core/shelf.ts"
import { walletUrl } from "./useWallet.ts"

/** What the stored book said just before and just after an answer was saved, so only saved answers are ever in the history. */
type Step = { before: Book; after: Book }

/** Shared with `usePurchases`. */
export const shelf = browserShelf()

/** The user's answers, kept in this browser and nowhere else. Undo goes back one of this tab's answers at a time, and leaves what other tabs have said. */
export function useBook() {
  const [book, setBook] = useState(() => storedBook(localStorage))
  // Not state, because a save can finish between renders, and an undo right then has to see what that left.
  const history = useRef<Step[]>([])
  const [canUndo, setCanUndo] = useState(false)
  const [notSaved, setNotSaved] = useState(false)
  const turn = useRef(Promise.resolve())
  const waiting = useRef(0)
  const failures = useRef(0)

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

  // Something the user just did, so they're told if it didn't stick. Each waits for the one before, because what it means can depend on how that went. What's on screen settles once the last has.
  const act = useCallback(
    (work: () => Promise<Book>) => {
      setNotSaved(false)
      waiting.current += 1
      const settled = (latest: () => Book) => {
        waiting.current -= 1
        if (waiting.current === 0) show(latest())
      }
      turn.current = turn.current.then(work).then(
        (latest) => settled(() => latest),
        (error) => {
          console.error(error)
          failures.current += 1
          setNotSaved(true)
          settled(() => storedBook(localStorage))
        },
      )
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
    (next: BookChange) => {
      const update = (latest: Book) => applyChange(latest, book, next)
      setBook(update)
      act(async () => {
        let before = book
        const after = await changeStoredBook(shelf, (latest) => {
          before = latest
          return update(latest)
        })
        if (!same(before, after)) setHistory([...history.current, { before, after }])
        return after
      })
    },
    [book, act, setHistory],
  )
  // On screen once it's saved, since which answer it takes back isn't known until those before it have been. One waiting on something that failed had that in mind, so it doesn't go further back instead.
  const undo = useCallback(() => {
    const failuresSoFar = failures.current
    act(async () => {
      const step = history.current.at(-1)
      if (!step || failures.current !== failuresSoFar) return readStoredBook(shelf)
      const latest = await changeStoredBook(shelf, (latest) => undoAnswer(latest, step.before, step.after))
      setHistory(history.current.slice(0, -1))
      return latest
    })
  }, [act, setHistory])

  // Not an answer, so undo doesn't take it back, whichever answers came before it.
  const linkAccounts = useCallback(
    (addresses: readonly string[]) => {
      const update = (latest: Book) => linkDeviceAccounts(latest, addresses)
      setBook(update)
      act(() => changeStoredBook(shelf, update))
    },
    [act],
  )

  // What an order says, and not an answer either. Whoever calls this hears if it wasn't saved, so the order can be read again.
  const addPurchase = useCallback((purchase: Purchase) => save((latest) => recordPurchase(latest, purchase)), [save])

  return { book, change, undo, canUndo, notSaved, linkAccounts, addPurchase }
}

/** Reading is what sets something aside, so that comes first. */
async function unreadableIn(from: Shelf) {
  await Promise.all([readStoredBook(from), readStoredPurchases(from)])
  const [book, purchases, unseen] = await Promise.all([storedBookHasNoCopy(from), storedPurchasesHaveNoCopy(from), hasUnseenSetAside(from)])
  return { copyFailed: book || purchases, unseen }
}

const COPY_RETRY_MS = 5_000

/** Tells the person once when something saved couldn't be read. If no copy could be kept, it says that instead, for as long as that's so, and keeps trying. */
export function useUnreadableSaved() {
  const [unseen, setUnseen] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)

  // What's on screen is the copy in localStorage when the shelf can't be read, so that's what this is about then.
  const read = useCallback(() => {
    void unreadableIn(shelf)
      .catch(() => unreadableIn(plainShelf(localStorage)))
      .then((found) => {
        setUnseen(found.unseen)
        setCopyFailed(found.copyFailed)
      }, console.error)
  }, [])

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (isBookKey(event.key) || isPurchasesKey(event.key) || isSetAsideKey(event.key)) read()
    }
    read()
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [read])

  useEffect(() => {
    if (!copyFailed) return
    const timer = setInterval(read, COPY_RETRY_MS)
    return () => clearInterval(timer)
  }, [copyFailed, read])

  const dismiss = useCallback(() => {
    setUnseen(false)
    markSetAsideSeen(shelf).catch(console.error)
  }, [])

  return { unreadable: unseen || copyFailed, copyFailed, dismiss }
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
