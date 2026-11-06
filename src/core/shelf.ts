// What several tabs of this app change. localStorage can't be trusted with that: each tab reads its own copy, which hears about
// another tab's write late, even inside a lock. IndexedDB runs each change after the last has finished, from what it left.

/** Where a client keeps something it can read right away. */
export type KeptIn = Pick<Storage, "getItem" | "setItem">

export type Shelf = {
  read(key: string): Promise<string | null>
  /** `update` gets what's there now, and returning that same text writes nothing. It runs while no tab can write, so it can't wait on anything. */
  change(key: string, update: (latest: string | null) => string | null): Promise<string | null>
}

/** For one writer at a time: a browser with no IndexedDB, or a test. */
export const plainShelf = (storage: KeptIn): Shelf => ({
  read: async (key) => storage.getItem(key),
  async change(key, update) {
    const latest = storage.getItem(key)
    const next = update(latest)
    if (next !== null && next !== latest) storage.setItem(key, next)
    return next
  },
})

const DATABASE = "patina"
const STORE = "kept"

/**
 * IndexedDB decides what's true. localStorage holds a copy, which is what a page shows before it can read that, what a client
 * saved before this existed, and what tells other tabs to look, since a write there reaches them as a `storage` event.
 */
export function browserShelf(): Shelf {
  let opening: Promise<IDBDatabase | null> | undefined
  const database = () =>
    (opening ??= new Promise((resolve) => {
      try {
        const request = indexedDB.open(DATABASE, 1)
        request.onupgradeneeded = () => request.result.createObjectStore(STORE)
        request.onsuccess = () => {
          request.result.onclose = () => (opening = undefined)
          resolve(request.result)
        }
        request.onerror = () => resolve(null)
      } catch {
        resolve(null)
      }
    }))
  const copy = (key: string, text: string | null) => {
    try {
      if (text !== null && localStorage.getItem(key) !== text) localStorage.setItem(key, text)
    } catch {
      // It's only a copy. The next page to open reads the real one a moment later.
    }
  }
  const run = (db: IDBDatabase, mode: IDBTransactionMode, key: string, work: (latest: string | null, store: IDBObjectStore) => string | null) =>
    new Promise<string | null>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode)
      const store = transaction.objectStore(STORE)
      const found = store.get(key)
      let result: string | null = null
      found.onsuccess = () => {
        const stored = typeof found.result === "string" ? found.result : null
        result = work(stored ?? localStorage.getItem(key), store)
      }
      transaction.oncomplete = () => resolve(result)
      transaction.onabort = () => reject(new Error("This browser couldn't save that."))
    })
  return {
    async read(key) {
      const db = await database()
      if (!db) return localStorage.getItem(key)
      const text = await run(db, "readonly", key, (latest) => latest)
      copy(key, text)
      return text
    },
    async change(key, update) {
      const db = await database()
      if (!db) return plainShelf(localStorage).change(key, update)
      let changed = false
      const text = await run(db, "readwrite", key, (latest, store) => {
        const next = update(latest)
        // Also when nothing changed but it's still only in the copy, so what's here is on the shelf from now on.
        if (next !== null) store.put(next, key)
        changed = next !== latest
        return next
      })
      if (changed) copy(key, text)
      return text
    },
  }
}
