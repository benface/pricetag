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
const COULD_NOT_SAVE = "This browser couldn't save that."
/** The slowest change seen on a machine at a load of 127 took 278 ms, so this long means it's stuck rather than slow. */
const STALLED_MS = 5_000

const inTime = <T>(work: Promise<T>, onStalled: () => void): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onStalled()
      reject(new Error(COULD_NOT_SAVE))
    }, STALLED_MS)
  })
  return Promise.race([work, stalled]).finally(() => clearTimeout(timer))
}

/**
 * IndexedDB decides what's true. localStorage holds a copy, which is what a page shows before it can read that, what a client
 * saved before this existed, and what tells other tabs to look, since a write there reaches them as a `storage` event.
 */
export function browserShelf(): Shelf {
  let opening: Promise<IDBDatabase | null> | undefined
  const open = () =>
    new Promise<IDBDatabase | null>((resolve) => {
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
    })
  // Chrome keeps a page someone just left, frozen, in case they come back. One frozen while creating the database holds up every
  // open on this site, in every tab, for as long as it's kept. Chrome drops a frozen page holding a lock someone's waiting for, so
  // each open waits for this one, which is why it can't be a shared lock. A late open stays the one everyone waits for, since another would only queue behind it.
  const database = () => (opening ??= navigator.locks ? navigator.locks.request(`${DATABASE}.opening`, open).catch(() => open()) : open())
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
      const timer =
        mode === "readwrite"
          ? setTimeout(() => {
              // So it can't land after the user's been told it didn't. It can't be stopped once it's committing, and then it may.
              try {
                transaction.abort()
              } catch {}
              reject(new Error(COULD_NOT_SAVE))
              catchUp(key)
            }, STALLED_MS)
          : undefined
      found.onsuccess = () => {
        const stored = typeof found.result === "string" ? found.result : null
        result = work(stored ?? localStorage.getItem(key), store)
      }
      transaction.oncomplete = () => {
        clearTimeout(timer)
        resolve(result)
      }
      transaction.onabort = () => {
        clearTimeout(timer)
        reject(new Error(COULD_NOT_SAVE))
      }
    })
  const readNow = async (key: string) => {
    const db = await database()
    if (!db) return localStorage.getItem(key)
    const text = await run(db, "readonly", key, (latest) => latest)
    copy(key, text)
    return text
  }
  // Whoever asked has moved on, so once the shelf's free again they hear how it ended the way they'd hear another tab's write.
  const catchUp = (key: string) => {
    readNow(key).then(() => window.dispatchEvent(new StorageEvent("storage", { key })), console.error)
  }
  return {
    read: (key) => inTime(readNow(key), () => catchUp(key)),
    async change(key, update) {
      const db = await inTime(database(), () => catchUp(key))
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

const SET_ASIDE_KEY = "patina.unreadable"

export const isSetAsideKey = (key: string | null) => key === null || key === SET_ASIDE_KEY

/** Text this version couldn't read, exactly as it was, and how many of those the person has been told about. Nothing ever removes one. */
type SetAside = { entries: { key: string; text: string }[]; seen: number }

function setAsideFrom(text: string | null): SetAside {
  if (text === null) return { entries: [], seen: 0 }
  try {
    const { entries, seen } = JSON.parse(text)
    if (Array.isArray(entries) && entries.every((entry) => typeof entry?.key === "string" && typeof entry?.text === "string") && Number.isSafeInteger(seen)) return { entries, seen }
  } catch {
    // Handled below.
  }
  // This isn't thrown away either.
  return { entries: [{ key: SET_ASIDE_KEY, text }], seen: 0 }
}

async function setAside(shelf: Shelf, key: string, text: string) {
  await shelf.change(SET_ASIDE_KEY, (latest) => {
    const kept = setAsideFrom(latest)
    return kept.entries.some((entry) => entry.key === key && entry.text === text) ? latest : JSON.stringify({ ...kept, entries: [...kept.entries, { key, text }] })
  })
}

/** Reads `key`, keeping a copy of what `readable` turns down. What's there stays until something changes it. */
export async function readKept(shelf: Shelf, key: string, readable: (text: string) => boolean): Promise<string | null> {
  const text = await shelf.read(key)
  if (text !== null && !readable(text)) await setAside(shelf, key, text).catch(console.error)
  return text
}

/** Whether `readable` turns down what's under `key` and no copy of it has been kept, so the original is all there is. */
export async function hasNoCopy(shelf: Shelf, key: string, readable: (text: string) => boolean): Promise<boolean> {
  const text = await shelf.read(key)
  if (text === null || readable(text)) return false
  return !setAsideFrom(await shelf.read(SET_ASIDE_KEY)).entries.some((entry) => entry.key === key && entry.text === text)
}

/** `shelf.change`, but what `readable` turns down is only replaced once a copy has been kept. `update` can't wait on that, so the copy comes first, and then it's tried again. */
export async function changeKept(shelf: Shelf, key: string, readable: (text: string) => boolean, update: (latest: string | null) => string | null): Promise<string | null> {
  let copied: string | null = null
  for (;;) {
    let unread = null as string | null
    const text = await shelf.change(key, (latest) => {
      if (latest === null || latest === copied || readable(latest)) return update(latest)
      unread = latest
      return latest
    })
    if (unread === null) return text
    await setAside(shelf, key, unread)
    copied = unread
  }
}

/** Whether something's been set aside that the person hasn't been told about. */
export const hasUnseenSetAside = async (shelf: Shelf) => {
  const { entries, seen } = setAsideFrom(await shelf.read(SET_ASIDE_KEY))
  return entries.length > seen
}

export const markSetAsideSeen = (shelf: Shelf) =>
  shelf.change(SET_ASIDE_KEY, (latest) => {
    const kept = setAsideFrom(latest)
    return kept.seen === kept.entries.length ? latest : JSON.stringify({ ...kept, seen: kept.entries.length })
  })
