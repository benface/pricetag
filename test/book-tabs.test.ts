import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { answerSender, applyAnswer, changeStoredBook, costKey, emptyBook, enterExchangeCosts, linkDeviceAccounts, parseBook, recordPurchase, storedBook, undoAnswer, type Book, type Purchase } from "../src/core/book.ts"
import { plainShelf, type KeptIn } from "../src/core/shelf.ts"

const ME = "0x3762620fbcb400b0f98365da4aad7d2a250e5d89"
const OTHER = "0x1111111111111111111111111111111111111111"
const SENDER = "0x2222222222222222222222222222222222222222"
const purchase: Purchase = { provider: "coinbase", order: "order-1", wallet: ME, asset: "USDC", units: "5000000", txHash: `0x${"ab".repeat(32)}`, blockNum: 100, cost: { micros: "5250000", currency: "USD" }, costUsdMicros: "5250000" }
const withdrawal = { exchange: "coinbase", asset: "USDC", units: "1000000", at: "2026-11-05T00:00:00Z", cost: { micros: "1000000", currency: "USD" as const }, toAddress: null }

function shelf(): KeptIn & { writes: number } {
  const kept = new Map<string, string>()
  return {
    writes: 0,
    getItem: (key) => kept.get(key) ?? null,
    setItem(key, value) {
      this.writes++
      kept.set(key, value)
    },
  }
}

/** One tab, the way `useBook` does it: what's on screen goes stale until another tab's write is heard about. */
function tab(storage: KeptIn) {
  let book = storedBook(storage)
  const history: { before: Book; after: Book }[] = []
  const save = async (update: (latest: Book) => Book) => {
    book = await changeStoredBook(plainShelf(storage), update)
  }
  return {
    get book() {
      return book
    },
    hear: () => void (book = storedBook(storage)),
    async change(next: (shown: Book) => Book) {
      const [before, after] = [book, next(book)]
      history.push({ before, after })
      await save((latest) => applyAnswer(latest, before, after))
    },
    async undo() {
      const step = history.pop()
      if (step) await save((latest) => undoAnswer(latest, step.before, step.after))
    },
    link: (addresses: string[]) => save((latest) => linkDeviceAccounts(latest, addresses)),
    record: (one: Purchase) => save((latest) => recordPurchase(latest, one)),
  }
}

const someoneElse = (shown: Book) => answerSender(shown, null, SENDER, { kind: "someone-else" })
const mine = (shown: Book) => answerSender(shown, null, OTHER, { kind: "mine" })

describe("a book shared between tabs", () => {
  it("keeps an answer from another tab when an order lands in a tab that hasn't heard about it", async () => {
    const storage = shelf()
    const [a, b] = [tab(storage), tab(storage)]
    await b.change(mine)
    await a.record(purchase)
    const saved = storedBook(storage)
    assert.deepEqual(saved.senders[OTHER], { kind: "mine" })
    assert.deepEqual(saved.purchases, [purchase])
  })

  it("keeps an answer and a purchase from another tab when answering in a tab that hasn't heard about them", async () => {
    const storage = shelf()
    const [a, b] = [tab(storage), tab(storage)]
    await b.change(mine)
    await b.record(purchase)
    await a.change(someoneElse)
    const saved = storedBook(storage)
    assert.deepEqual(saved.senders, { [OTHER]: { kind: "mine" }, [SENDER]: { kind: "someone-else" } })
    assert.deepEqual(saved.purchases, [purchase])
  })

  it("survives a reload, which reads what's saved and writes nothing", async () => {
    const storage = shelf()
    const b = tab(storage)
    await b.change(mine)
    const { writes } = storage
    const reloaded = tab(storage)
    assert.deepEqual(reloaded.book.senders, { [OTHER]: { kind: "mine" } })
    assert.equal(storage.writes, writes)
  })

  it("writes nothing for a purchase it already has, so tabs don't keep waking each other", async () => {
    const storage = shelf()
    const [a, b] = [tab(storage), tab(storage)]
    await a.record(purchase)
    const { writes } = storage
    await b.record(purchase)
    await a.record({ ...purchase })
    assert.equal(storage.writes, writes)
  })

  it("takes in a block that an order's later read adds", async () => {
    const storage = shelf()
    const a = tab(storage)
    await a.record({ ...purchase, blockNum: null })
    await a.record(purchase)
    assert.deepEqual(storedBook(storage).purchases, [purchase])
  })

  describe("undo", () => {
    it("takes back only this tab's answer", async () => {
      const storage = shelf()
      const [a, b] = [tab(storage), tab(storage)]
      await a.change(someoneElse)
      await b.change(mine)
      await b.record(purchase)
      await a.undo()
      const saved = storedBook(storage)
      assert.deepEqual(saved.senders, { [OTHER]: { kind: "mine" } })
      assert.deepEqual(saved.purchases, [purchase])
    })

    it("doesn't take back a purchase recorded before or after the answer", async () => {
      const storage = shelf()
      const a = tab(storage)
      await a.change(someoneElse)
      await a.record(purchase)
      await a.undo()
      assert.deepEqual(storedBook(storage), { ...emptyBook(), purchases: [purchase] })
    })

    it("leaves a newer answer to the same question, from another tab", async () => {
      const storage = shelf()
      const [a, b] = [tab(storage), tab(storage)]
      await a.change(someoneElse)
      b.hear()
      await b.change((shown) => answerSender(shown, null, SENDER, { kind: "mine" }))
      await a.undo()
      assert.deepEqual(storedBook(storage).senders[SENDER], { kind: "mine" })
    })

    it("doesn't take back a linked account that an answer had already said was theirs", async () => {
      const storage = shelf()
      const a = tab(storage)
      await a.change(mine)
      await a.link([OTHER])
      await a.undo()
      assert.deepEqual(storedBook(storage).senders[OTHER], { kind: "mine" })
    })

    it("doesn't take back an account another tab linked after the answer, even once reloaded", async () => {
      const storage = shelf()
      const [a, b] = [tab(storage), tab(storage)]
      await a.change(mine)
      b.hear()
      await b.link([OTHER])
      await a.undo()
      assert.deepEqual(tab(storage).book.senders[OTHER], { kind: "mine" })
    })

    it("doesn't restore an earlier answer over an account linked since", async () => {
      const storage = shelf()
      const [a, b] = [tab(storage), tab(storage)]
      await a.change((shown) => answerSender(shown, null, OTHER, { kind: "someone-else" }))
      await a.change(mine)
      b.hear()
      await b.link([OTHER])
      await a.undo()
      assert.deepEqual(storedBook(storage).senders[OTHER], { kind: "mine" })
    })

    it("doesn't take back an account a device linked again after the answer, in any order of tabs", async () => {
      const storage = shelf()
      const [a, b] = [tab(storage), tab(storage)]
      await a.link([OTHER])
      await a.change((shown) => answerSender(shown, null, OTHER, { kind: "someone-else" }))
      await a.change(mine)
      b.hear()
      await b.link([OTHER])
      await a.undo()
      assert.deepEqual(tab(storage).book.senders[OTHER], { kind: "mine" })
      await a.undo()
      assert.deepEqual(tab(storage).book.senders[OTHER], { kind: "mine" })
    })

    it("still takes back an answer given after a device linked it again", async () => {
      const storage = shelf()
      const a = tab(storage)
      await a.link([OTHER])
      await a.link([OTHER])
      await a.change((shown) => answerSender(shown, null, OTHER, { kind: "someone-else" }))
      await a.undo()
      assert.deepEqual(storedBook(storage).senders[OTHER], { kind: "mine" })
    })

    it("still takes back an answer about an account that was already linked", async () => {
      const storage = shelf()
      const a = tab(storage)
      await a.link([OTHER])
      await a.change((shown) => answerSender(shown, null, OTHER, { kind: "someone-else" }))
      assert.deepEqual(storedBook(storage).senders[OTHER], { kind: "someone-else" })
      await a.undo()
      assert.deepEqual(storedBook(storage).senders[OTHER], { kind: "mine" })
    })

    it("takes back the rest of an answer that also said a linked account was theirs", async () => {
      const storage = shelf()
      const [a, b] = [tab(storage), tab(storage)]
      await a.change((shown) => answerSender(shown, ME, OTHER, { kind: "mine" }))
      b.hear()
      await b.link([ME])
      await a.undo()
      assert.deepEqual(storedBook(storage).senders, { [ME]: { kind: "mine" } })
    })

    it("restores what an answer replaced, once the book's been saved and read back", async () => {
      const storage = shelf()
      const receipts = [{ wallet: ME, legId: "leg-1", asset: "USDC", units: "1000000" }]
      const key = costKey(ME, "leg-2")
      const a = tab(storage)
      await a.change((shown) => ({ ...enterExchangeCosts(shown, ME, SENDER, receipts, { USDC: { micros: "1000000", currency: "USD" } }), costs: { [key]: { micros: "2", currency: "USD" } }, withdrawals: [withdrawal] }))
      const earlier = storedBook(storage)
      const b = tab(storage)
      await b.change((shown) => ({ ...answerSender(shown, null, SENDER, { kind: "someone-else" }), costs: { [key]: { micros: "3", currency: "USD" } }, withdrawals: [{ ...withdrawal, units: "2000000" }] }))
      await b.undo()
      assert.deepEqual(storedBook(storage), earlier)
    })
  })

  it("keeps which accounts a device linked, and turns away a book that says something else", () => {
    assert.deepEqual(parseBook({ deviceLinks: { [OTHER.toUpperCase().replace("0X", "0x")]: 2 } })?.deviceLinks, { [OTHER]: 2 })
    assert.equal(parseBook({ deviceLinks: { nope: 1 } }), null)
    assert.equal(parseBook({ deviceLinks: { [OTHER]: 0 } }), null)
    assert.equal(parseBook({ deviceLinks: { [OTHER]: "1" } }), null)
    assert.equal(parseBook({ deviceLinks: [OTHER] }), null)
    assert.equal(parseBook({})?.deviceLinks, undefined)
  })
})
