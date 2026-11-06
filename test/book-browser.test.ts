// The book and the purchases it's told about, in tabs of a real browser, through the real hooks. A shared Map can't show what
// this is for: each tab has its own process and its own copy of localStorage, so two of them can act at the same moment.

import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"
import { createServer, type ViteDevServer } from "vite"

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const ME = "0x3762620fbcb400b0f98365da4aad7d2a250e5d89"
const OTHER = "0x1111111111111111111111111111111111111111"
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`
const purchase = { provider: "coinbase", order: "order", wallet: ME, asset: "USDC", units: "5000000", txHash: `0x${"ab".repeat(32)}`, blockNum: 100, cost: { micros: "5250000", currency: "USD" }, costUsdMicros: "5250000" }
const delivered = (id: string) => ({ ...purchase, id, status: "succeeded", paidIn: "USD", failure: null })
const tracked = (ref: string, order: unknown) => ({ ref, wallet: ME, asset: "USDC", typed: purchase.cost, startedAt: Date.now(), order })

const HARNESS = `
import { createElement, useEffect } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { answerSender } from "/src/core/book.ts"
import { shelf, useBook } from "/src/ui/useBook.ts"
import { usePurchases } from "/src/ui/usePurchases.ts"
function Harness() {
  const book = useBook()
  const tracker = usePurchases(book.addPurchase)
  window.hook = book
  window.tracker = tracker
  window.answer = (address, kind) => flushSync(() => window.hook.change(answerSender(window.hook.book, null, address, { kind })))
  window.record = (one) => flushSync(() => void window.hook.addPurchase(one))
  window.undo = () => flushSync(() => window.hook.undo())
  window.link = (addresses) => flushSync(() => window.hook.linkAccounts(addresses))
  window.begin = () => window.tracker.begin({ address: "${ME}", asset: "USDC", cryptoAmount: "1", fiat: null }, { micros: "1000000", currency: "USD" })
  useEffect(() => void (window.ready = true), [])
  return null
}
window.count = async (times) => {
  for (let i = 0; i < times; i++) await shelf.change("count", (latest) => String(Number(latest ?? 0) + 1))
}
window.counted = () => shelf.read("count")
createRoot(document.getElementById("root")).render(createElement(Harness))
`

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until<T>(read: () => Promise<T> | T, what: string, timeout = 20_000): Promise<T> {
  const end = Date.now() + timeout
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await delay(25)
  }
}

describe("the book in two browser tabs", { skip: existsSync(CHROME) ? false : "Chrome isn't installed here", timeout: 180_000 }, () => {
  const orders = new Map<string, unknown>()
  let server: ViteDevServer
  let url: string
  let chrome: ChildProcess
  let ws: WebSocket
  let scratch: string
  let nextRef = 0
  let nextId = 0
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()

  const send = (method: string, params: object = {}, sessionId?: string) =>
    new Promise<any>((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params, sessionId }))
    })

  const evaluate = async <T = any>(session: string, expression: string): Promise<T> => {
    const answer = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session)
    if (answer.exceptionDetails) throw new Error(JSON.stringify(answer.exceptionDetails))
    return answer.result.value as T
  }

  /** Tabs sharing one browser's storage, and nothing with any other test. */
  async function tabs(count: number): Promise<string[]> {
    const { browserContextId } = await send("Target.createBrowserContext")
    return Promise.all(
      Array.from({ length: count }, async () => {
        const { targetId } = await send("Target.createTarget", { url, browserContextId })
        const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true })
        await until(() => evaluate(sessionId, "Boolean(window.ready)"), "a tab to start")
        return sessionId
      }),
    )
  }

  async function reload(session: string) {
    await evaluate(session, "window.ready = false")
    await send("Page.reload", {}, session)
    await until(() => evaluate(session, "Boolean(window.ready)"), "a tab to reload")
    // What's stored takes a moment to read, and this is about what it says.
    await delay(150)
  }

  /** Runs each at the same instant, in its own tab. */
  const together = (...work: [session: string, expression: string][]) => {
    const at = Date.now() + 40
    return Promise.all(work.map(([session, expression]) => evaluate(session, `new Promise((resolve) => setTimeout(async () => { while (Date.now() < ${at}); await (${expression}); resolve(true) }, 0))`)))
  }

  const bookIn = (session: string) => evaluate(session, "window.hook.book")

  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "book-browser-"))
    server = await createServer({
      root: process.cwd(),
      configFile: false,
      logLevel: "error",
      cacheDir: join(scratch, "vite"),
      server: { host: "127.0.0.1", port: 0, hmr: false },
      optimizeDeps: { include: ["react", "react-dom", "react-dom/client"] },
      plugins: [
        {
          name: "book-harness",
          resolveId: (id) => (id === "/__harness.js" ? "\0harness" : null),
          load: (id) => (id === "\0harness" ? HARNESS : null),
          configureServer({ middlewares }) {
            middlewares.use((req, res, next) => {
              const reply = (type: string, body: string) => {
                res.setHeader("content-type", type)
                res.end(body)
              }
              if (req.url === "/__harness") return reply("text/html", `<!doctype html><div id="root"></div><script type="module" src="/__harness.js"></script>`)
              if (req.url === "/api/onramp/checkout") return reply("application/json", JSON.stringify({ url: "https://pay.coinbase.com/x", ref: `ref-${++nextRef}` }))
              if (req.url?.startsWith("/api/onramp/orders/")) return reply("application/json", JSON.stringify({ orders: [orders.get(req.url.split("/").at(-1)!)].filter(Boolean) }))
              next()
            })
          },
        },
      ],
    })
    await server.listen()
    url = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/__harness`
    chrome = spawn(CHROME, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--remote-debugging-port=0", `--user-data-dir=${join(scratch, "chrome")}`, "about:blank"], { stdio: "ignore" })
    const port = await until(() => readFile(join(scratch, "chrome/DevToolsActivePort"), "utf8").then((text) => Number(text.split("\n")[0]), () => 0), "Chrome to start")
    const { webSocketDebuggerUrl } = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string }
    ws = new WebSocket(webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true })
      ws.addEventListener("error", reject, { once: true })
    })
    ws.addEventListener("message", ({ data }) => {
      const message = JSON.parse(String(data))
      const waiting = message.id ? pending.get(message.id) : undefined
      if (!waiting) return
      pending.delete(message.id)
      if (message.error) waiting.reject(new Error(JSON.stringify(message.error)))
      else waiting.resolve(message.result)
    })
  })

  after(async () => {
    ws?.close()
    if (chrome && chrome.exitCode === null) {
      chrome.kill("SIGTERM")
      await new Promise((resolve) => chrome.once("exit", resolve))
    }
    await server?.close()
    await rm(scratch, { recursive: true, force: true })
  })

  it("loses nothing when an answer and a purchase land at the same moment", async () => {
    const [a, b] = (await tabs(2)) as [string, string]
    const rounds = 40
    for (let i = 0; i < rounds; i++) {
      await together([a, `answer(${JSON.stringify(address(100 + i))}, "mine")`], [b, `record(${JSON.stringify({ ...purchase, order: `race-${i}` })})`])
    }
    await delay(200)
    await reload(a)
    const book = await bookIn(a)
    assert.equal(Object.keys(book.senders).length, rounds)
    assert.equal(book.purchases?.length ?? 0, rounds)
  })

  it("loses nothing when an undo, a link and an answer land at the same moment", async () => {
    const [a, b] = (await tabs(2)) as [string, string]
    const rounds = 25
    for (let i = 0; i < rounds; i++) {
      const [taken, linked, answered] = [address(1000 + i), address(2000 + i), address(3000 + i)]
      await evaluate(a, `answer(${JSON.stringify(taken)}, "mine")`)
      await until(() => evaluate(a, `Boolean(hook.canUndo && hook.book.senders[${JSON.stringify(taken)}])`), "the answer to show")
      await together([a, "undo()"], [b, `link([${JSON.stringify(linked)}])`])
      await together([a, `answer(${JSON.stringify(answered)}, "someone-else")`], [b, `answer(${JSON.stringify(address(4000 + i))}, "someone-else")`])
      await delay(10)
    }
    await delay(200)
    await reload(a)
    const { senders } = await bookIn(a)
    for (let i = 0; i < rounds; i++) {
      assert.equal(senders[address(1000 + i)], undefined, "the undone answer stays undone")
      assert.deepEqual(senders[address(2000 + i)], { kind: "mine" }, "the link stays")
      assert.deepEqual(senders[address(3000 + i)], { kind: "someone-else" }, "this tab's answer stays")
      assert.deepEqual(senders[address(4000 + i)], { kind: "someone-else" }, "that tab's answer stays")
    }
  })

  it("loses no purchase started in two tabs at the same moment", async () => {
    const [a, b] = (await tabs(2)) as [string, string]
    const rounds = 12
    for (let i = 0; i < rounds; i++) await together([a, "begin()"], [b, "begin()"])
    await delay(200)
    await reload(a)
    assert.equal(await evaluate(a, "tracker.purchases.length"), rounds * 2)
  })

  // The same two loops around a Web Lock and localStorage lost 6 to 38 of 4,000 writes, because a tab's copy can be behind even when it's holding the lock.
  it("runs changes from two tabs strictly one after another", async () => {
    const [a, b] = (await tabs(2)) as [string, string]
    await Promise.all([evaluate(a, "count(1000)"), evaluate(b, "count(1000)")])
    assert.equal(await evaluate(a, "counted()"), "2000")
  })

  it("keeps an account linked in another tab after an undo and a reload", async () => {
    const [a, b] = (await tabs(2)) as [string, string]
    await evaluate(a, `answer(${JSON.stringify(OTHER)}, "mine")`)
    await until(() => evaluate(b, `hook.book.senders[${JSON.stringify(OTHER)}]?.kind === "mine"`), "the other tab to hear")
    await evaluate(b, `link([${JSON.stringify(OTHER)}])`)
    await evaluate(a, "undo()")
    await delay(100)
    for (const tab of [a, b]) {
      await reload(tab)
      assert.deepEqual((await bookIn(tab)).senders[OTHER], { kind: "mine" })
    }
  })

  it("takes over what was saved before, records an older order from it, and trusts what's stored over its copy", async () => {
    const [a] = (await tabs(1)) as [string]
    const rows = [tracked("older", { ...delivered("older"), status: "pending", txHash: null, blockNum: null }), ...Array.from({ length: 5 }, (_, i) => tracked(`d${i}`, delivered(`d${i}`)))]
    orders.set("older", delivered("older"))
    const earlier = { senders: { [OTHER]: { kind: "mine" } }, costs: {}, withdrawals: [] }
    await evaluate(a, `localStorage.setItem("patina.book", ${JSON.stringify(JSON.stringify(earlier))}); localStorage.setItem("patina.purchases", ${JSON.stringify(JSON.stringify(rows))})`)
    await reload(a)
    await until(() => evaluate(a, `hook.book.purchases?.some(({ order }) => order === "older")`), "the older order to be recorded")
    assert.deepEqual((await bookIn(a)).senders[OTHER], { kind: "mine" })
    assert.deepEqual(await evaluate(a, "tracker.purchases.map(({ ref }) => ref)"), ["older", "d1", "d2", "d3", "d4"])

    await until(() => evaluate(a, `JSON.parse(localStorage.getItem("patina.book")).purchases?.length === 6`), "the copy to catch up")
    await evaluate(a, `localStorage.setItem("patina.book", ${JSON.stringify(JSON.stringify(earlier))})`)
    await reload(a)
    assert.ok((await bookIn(a)).purchases.some(({ order }: { order: string }) => order === "older"))
    assert.ok(await evaluate<boolean>(a, `JSON.parse(localStorage.getItem("patina.book")).purchases.length > 0`), "and the copy's put right")
  })
})
