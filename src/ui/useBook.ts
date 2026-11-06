import { useCallback, useEffect, useMemo, useState } from "react"
import type { CurrencyCode } from "@pricetag/sdk/core"
import type { WalletResponse } from "../core/api.ts"
import { changeBook, emptyBook, linkAccountsInBook, parseBook, undoBook, type Book, type BookChange, type BookState } from "../core/book.ts"
import { readKey, readsMatching } from "../core/resolve.ts"

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
  const [{ book, history }, setState] = useState<BookState>(() => ({ book: readBook(), history: [] }))

  useEffect(() => localStorage.setItem(KEY, JSON.stringify(book)), [book])

  const change = useCallback((next: BookChange) => setState((state) => changeBook(state, next)), [])
  const undo = useCallback(() => setState(undoBook), [])
  const linkAccounts = useCallback((addresses: readonly string[]) => setState((state) => linkAccountsInBook(state, addresses)), [])

  return { book, change, undo, canUndo: history.length > 0, linkAccounts }
}

/**
 * Reads other wallets, and again on each new block of the wallet on screen. One that can't be read yet stays out, and one
 * whose read failed is in `failed`, so nobody's told it's still reading. `retry` reads them all again now.
 */
/**
 * Linked wallets, read by `rule` in `currency`. `shown` is how the numbers on screen were read, which for a moment after a
 * change isn't that: they go with the wallets read the same way, and a newer read waits until they've changed too.
 */
export function useOtherWallets(addresses: readonly string[], currency: CurrencyCode, rule: string | null, block: number | null, shown: Pick<WalletResponse, "rule" | "currency"> | null) {
  const [wallets, setWallets] = useState<Record<string, WalletResponse>>({})
  const [failures, setFailures] = useState<ReadonlySet<string>>(new Set())
  const [attempt, setAttempt] = useState(0)
  const key = addresses.join(",")

  useEffect(() => {
    if (!key) return
    const abort = new AbortController()
    const fail = (address: string) => setFailures((f) => new Set([...f, address]))
    for (const address of key.split(",")) {
      fetch(`/api/wallet/${address}?currency=${currency}${rule ? `&rule=${encodeURIComponent(rule)}` : ""}`, { signal: abort.signal })
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
  }, [key, currency, rule, block, attempt])

  return {
    others: useMemo(() => readsMatching(wallets, key ? key.split(",") : [], shown), [wallets, key, shown?.rule, shown?.currency]),
    failed: addresses.filter((address) => failures.has(address)),
    retry: useCallback(() => setAttempt((n) => n + 1), []),
  }
}
