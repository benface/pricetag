import { useCallback, useEffect, useState } from "react"
import type { WalletResponse } from "../core/api.ts"
import { emptyBook, parseBook, type Book } from "../core/book.ts"

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

/** Reads other wallets, and again on each new block of the wallet on screen. One that can't be read yet stays out. */
export function useOtherWallets(addresses: readonly string[], block: number | null): WalletResponse[] {
  const [wallets, setWallets] = useState<Record<string, WalletResponse>>({})
  const key = addresses.join(",")

  useEffect(() => {
    if (!key) return
    const abort = new AbortController()
    for (const address of key.split(",")) {
      fetch(`/api/wallet/${address}`, { signal: abort.signal })
        .then((response) => (response.ok ? (response.json() as Promise<WalletResponse>) : null))
        .then((wallet) => {
          if (wallet) setWallets((w) => ({ ...w, [address]: wallet }))
        })
        .catch(() => {})
    }
    return () => abort.abort()
  }, [key, block])

  return addresses.flatMap((address) => wallets[address] ?? [])
}
