// The "Which units?" step of a hardware-wallet send, in the real panel in a real browser. What's chosen there has to survive the
// renders a new block brings, and a send never goes without the choice someone made, even while what's held is still being read.

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
const FROM = "0x3762620fbcb400b0f98365da4aad7d2a250e5d89"
const TO = "0x1111111111111111111111111111111111111111"
const FIRST = "2026-01-02T00:00:00.000Z"
const SECOND = "2026-03-04T00:00:00.000Z"

const HARNESS = `
import { createElement, useState } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { emptyBook } from "/src/core/book.ts"
import { parseDeviceLink } from "/src/core/device-link.ts"
import { DevicePanel } from "/src/ui/DevicePanel.tsx"
import "/src/ui/styles.css"

localStorage.setItem("pricetag.taxCountry", "US")
const held = { purchases: [{ boughtAt: "${FIRST}", units: 10n ** 18n, costMicros: 2000000000n, allOnly: false }, { boughtAt: "${SECOND}", units: 10n ** 18n, costMicros: 3000000000n, allOnly: false }], unnamed: 0n }
window.reads = 0
window.named = []
window.sent = 0
// How the next read goes: "ok", "fail", or "hold", which waits for release().
window.nextRead = "ok"
let releases = []
window.release = () => (releases.splice(0).forEach((go) => go()), true)
const read = () => {
  window.reads++
  const how = window.nextRead
  if (how === "fail") return Promise.reject(new Error("offline"))
  if (how === "hold") return new Promise((resolve) => releases.push(() => resolve(held)))
  return Promise.resolve(held)
}
const signer = { kind: "browser", name: "Test", provider: {}, listAccounts: async () => [], showAddress: async () => ({ ok: true }), close: async () => {} }
const connectors = {
  canUseUsb: () => false,
  preloadLedger: () => {},
  ledger: () => Promise.reject(new Error("none")),
  findWallets: async () => [],
  wallet: () => Promise.reject(new Error("none")),
  keystone: () => Promise.reject(new Error("none")),
  client: () => new Promise(() => {}),
  send: async () => (window.sent++, "0x" + "ab".repeat(32)),
}
const start = { signer, accounts: [{ address: "${FROM}", path: null, activity: null }], chosen: "${FROM}", step: "send" }
const book = emptyBook()
const stable = (from, asset) => read()
function Harness() {
  const [renders, setRenders] = useState(0)
  // "fresh" makes a new read function on each render, as the book changing would. Otherwise it's the same one every render.
  const [fresh, setFresh] = useState(false)
  window.rerender = () => flushSync(() => setRenders((n) => n + 1))
  window.freshReads = () => flushSync(() => setFresh(true))
  const heldOf = fresh ? (from, asset) => read() : stable
  // A top-up the Mac app opened carries what its savings hold, and gets the choice back by a link of its own.
  const link = location.search.startsWith("?topup") ? parseDeviceLink(location.search) : null
  return createElement(DevicePanel, { link, book, currency: "USD", onLink: () => {}, onClose: () => {}, connectors, start, heldOf, onNamed: (choice) => window.named.push(choice), renders })
}
const input = (element, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set
  setter.call(element, value)
  element.dispatchEvent(new Event("input", { bubbles: true }))
}
const button = (name) => [...document.querySelectorAll("button")].find((one) => one.textContent.trim().startsWith(name))
window.fill = (to, amount) => {
  const typed = document.querySelector("input[placeholder='0x…']")
  if (typed) flushSync(() => input(typed, to))
  flushSync(() => input(document.querySelector("input[placeholder='0.00']"), amount))
  const mine = document.querySelector(".check-row input")
  if (mine && !mine.checked) flushSync(() => mine.click())
  return true
}
window.click = (name) => (flushSync(() => button(name).click()), true)
window.pickFrom = (at, amount) => (flushSync(() => input(document.querySelectorAll("label.name-unit input")[at], amount)), true)
window.picked = () => [...document.querySelectorAll("label.name-unit input")].map((one) => one.value)
window.canSend = () => !button("Send from your device").disabled
window.text = () => document.body.textContent
window.handBack = () => [...document.querySelectorAll("a")].find((one) => one.href.startsWith("patina://unit-choice"))?.href ?? null
createRoot(document.getElementById("root")).render(createElement(Harness))
window.ready = true
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

describe("naming a send's units in the hardware-wallet panel", { skip: existsSync(CHROME) ? false : "Chrome isn't installed here", timeout: 120_000 }, () => {
  let server: ViteDevServer
  let url: string
  let chrome: ChildProcess
  let ws: WebSocket
  let scratch: string
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

  /** A page of its own, at the send step with an address and amount filled in. */
  async function page(search = ""): Promise<string> {
    const { browserContextId } = await send("Target.createBrowserContext")
    const { targetId } = await send("Target.createTarget", { url: url + search, browserContextId })
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true })
    await until(() => evaluate(sessionId, "Boolean(window.ready && document.querySelector(\"input[placeholder='0.00']\"))"), "the send form")
    await evaluate(sessionId, `fill(${JSON.stringify(TO)}, "0.5")`)
    await until(() => evaluate(sessionId, "canSend()"), "the send to be ready")
    return sessionId
  }

  const openNaming = async (session: string) => {
    await evaluate(session, `click("Which units?")`)
    await until(() => evaluate(session, "picked().length === 2"), "the purchases to show")
  }

  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "name-units-browser-"))
    server = await createServer({
      root: process.cwd(),
      configFile: false,
      logLevel: "error",
      cacheDir: join(scratch, "vite"),
      server: { host: "127.0.0.1", port: 0, hmr: false },
      optimizeDeps: { include: ["react", "react-dom", "react-dom/client"] },
      plugins: [
        {
          name: "name-units-harness",
          resolveId: (id) => (id === "/__harness.js" ? "\0harness" : null),
          load: (id) => (id === "\0harness" ? HARNESS : null),
          configureServer({ middlewares }) {
            middlewares.use((req, res, next) => {
              if (req.url?.split("?")[0] !== "/__harness") return next()
              res.setHeader("content-type", "text/html")
              res.end(`<!doctype html><div id="root"></div><script type="module" src="/__harness.js"></script>`)
            })
          },
        },
      ],
    })
    await server.listen()
    url = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/__harness`
    chrome = spawn(CHROME, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${join(scratch, "chrome")}`, "about:blank"], { stdio: "ignore" })
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

  it("keeps what's chosen through the renders each new block brings, and sends with it", async () => {
    const session = await page()
    await openNaming(session)
    await evaluate(session, `pickFrom(1, "0.5")`)
    assert.equal(await evaluate(session, "canSend()"), true)
    for (let i = 0; i < 5; i++) await evaluate(session, "rerender()")
    await delay(100)
    assert.deepEqual(await evaluate(session, "picked()"), ["", "0.5"], "the choice stays")
    assert.equal(await evaluate(session, "reads"), 1, "the same holdings aren't read again")
    await evaluate(session, `click("Send from your device")`)
    const named = await until(() => evaluate<any[]>(session, "named.length ? named : null"), "the choice to be kept")
    assert.equal(named.length, 1)
    assert.deepEqual(named[0].takes, [{ boughtAt: SECOND, units: "500000000000000000" }])
  })

  it("keeps what's chosen when holdings are read again, and waits for that read before sending", async () => {
    const session = await page()
    await openNaming(session)
    await evaluate(session, `pickFrom(1, "0.5")`)
    await evaluate(session, `nextRead = "hold"`)
    await evaluate(session, "freshReads()")
    await until(() => evaluate(session, "reads === 2"), "a second read")
    assert.deepEqual(await evaluate(session, "picked()"), ["", "0.5"], "the choice stays while it's read again")
    assert.equal(await evaluate(session, "canSend()"), false, "nothing goes until it's back")
    await evaluate(session, "release()")
    await until(() => evaluate(session, "canSend()"), "the send to be ready again")
    assert.deepEqual(await evaluate(session, "picked()"), ["", "0.5"])
  })

  it("doesn't send while what's held is still being read", async () => {
    const session = await page()
    await evaluate(session, `nextRead = "hold"`)
    await evaluate(session, `click("Which units?")`)
    await until(() => evaluate(session, `text().includes("Reading what this wallet holds")`), "the read to start")
    assert.equal(await evaluate(session, "canSend()"), false)
    await evaluate(session, `click("Don't choose")`)
    assert.equal(await evaluate(session, "canSend()"), true, "closing it sends without a choice")
  })

  it("doesn't send without a choice when what's held can't be read, until it's closed", async () => {
    const session = await page()
    await evaluate(session, `nextRead = "fail"`)
    await evaluate(session, `click("Which units?")`)
    await until(() => evaluate(session, `text().includes("Couldn't read what this wallet holds")`), "the failure")
    assert.equal(await evaluate(session, "canSend()"), false)
    await evaluate(session, `click("Don't choose")`)
    assert.equal(await evaluate(session, "canSend()"), true)
    await evaluate(session, `click("Send from your device")`)
    await until(() => evaluate(session, "sent === 1"), "the send")
    assert.deepEqual(await evaluate(session, "named"), [], "nothing was named, and nothing says it was")
  })

  it("doesn't send with the step open and nothing chosen", async () => {
    const session = await page()
    await openNaming(session)
    assert.equal(await evaluate(session, "canSend()"), false)
    await evaluate(session, `pickFrom(0, "0.2")`)
    assert.equal(await evaluate(session, "canSend()"), false, "0.2 isn't what's sent")
    await evaluate(session, `pickFrom(1, "0.3")`)
    assert.equal(await evaluate(session, "canSend()"), true)
  })

  it("offers what the Mac app says its savings hold, and hands the choice back to it", async () => {
    const held = { [FROM]: { ETH: { purchases: [{ boughtAt: FIRST, units: "1000000000000000000", costMicros: "2000000000", allOnly: false }], unnamed: "0" } } }
    const session = await page(`?topup=${TO}&usd=20&held=${encodeURIComponent(JSON.stringify(held))}`)
    await evaluate(session, `click("Which units?")`)
    await until(() => evaluate(session, "picked().length === 1"), "the Mac's purchase to show")
    assert.equal(await evaluate(session, "reads"), 0, "this page reads nothing of its own")
    await evaluate(session, `pickFrom(0, "0.5")`)
    await until(() => evaluate(session, "canSend()"), "the send to be ready")
    await evaluate(session, `click("Send from your device")`)
    const link = new URL((await until(() => evaluate<string | null>(session, "handBack()"), "the link back to the Mac")) as string)
    assert.equal(link.host, "unit-choice")
    assert.equal(link.searchParams.get("wallet"), FROM)
    assert.equal(link.searchParams.get("tx"), `0x${"ab".repeat(32)}`)
    assert.equal(link.searchParams.get("asset"), "ETH")
    assert.equal(link.searchParams.get("takes"), `${FIRST}~500000000000000000`)
    assert.deepEqual(await evaluate(session, "named"), [], "this page's own book doesn't keep it")
  })
})
