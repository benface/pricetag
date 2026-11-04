import { useCallback, useEffect, useState } from "react"
import type { WalletResponse } from "../core/api.ts"
import { emptyBook, parseBook, type Book } from "../core/book.ts"
import type { CurrencyCode } from "../core/currency.ts"

const KEY = "patina.book"

function readBook(): Book {
  try {
    return parseBook(JSON.parse(localStorage.getItem(KEY) ?? "null")) ?? emptyBook()
  } catch {
    return emptyBook()
  }
}

/** The user's answers, kept in this browser and nowhere else. Undo goes back one answer at a time. */
export function useBook() {
  const [book, setBook] = useState(readBook)
  const [history, setHistory] = useState<Book[]>([])

  useEffect(() => localStorage.setItem(KEY, JSON.stringify(book)), [book])

  const change = useCallback(
    (next: Book) => {
      setHistory((h) => [...h, book])
      setBook(next)
    },
    [book],
  )
  const undo = useCallback(() => {
    const previous = history.at(-1)
    if (!previous) return
    setHistory(history.slice(0, -1))
    setBook(previous)
  }, [history])

  return { book, change, undo, canUndo: history.length > 0 }
}

/**
 * Reads other wallets, and again on each new block of the wallet on screen. One that can't be read yet stays out, and one
 * whose read failed is in `failed`, so nobody's told it's still reading. `retry` reads them all again now.
 */
export function useOtherWallets(addresses: readonly string[], currency: CurrencyCode, rule: string | null, block: number | null) {
  const [wallets, setWallets] = useState<Record<string, WalletResponse>>({})
  const [failures, setFailures] = useState<ReadonlySet<string>>(new Set())
  const [attempt, setAttempt] = useState(0)
  const key = addresses.join(",")
  // A wallet read by another rule would mix prices, and "the default" doesn't say which rule that was, so those are dropped.
  const [readBy, setReadBy] = useState(rule)
  if (readBy !== rule) {
    setReadBy(rule)
    setWallets({})
  }

  useEffect(() => {
    if (!key) return
    const abort = new AbortController()
    const fail = (address: string) => setFailures((f) => new Set([...f, address]))
    for (const address of key.split(",")) {
      fetch(`/api/wallet/${address}?currency=${currency}${rule ? `&rule=${encodeURIComponent(rule)}` : ""}`, { signal: abort.signal })
        .then((response) => (response.ok ? (response.json() as Promise<WalletResponse>) : null))
        .then((wallet) => {
          if (!wallet) return fail(address)
          setWallets((w) => ({ ...w, [address]: wallet }))
          setFailures((f) => new Set([...f].filter((other) => other !== address)))
        })
        .catch(() => {
          if (!abort.signal.aborted) fail(address)
        })
    }
    return () => abort.abort()
  }, [key, currency, rule, block, attempt])

  return {
    // A wallet in another currency would mix amounts, so one from before a change waits for the new read.
    others: addresses.flatMap((address) => (wallets[address]?.currency === currency ? [wallets[address]] : [])),
    failed: addresses.filter((address) => failures.has(address)),
    retry: useCallback(() => setAttempt((n) => n + 1), []),
  }
}
