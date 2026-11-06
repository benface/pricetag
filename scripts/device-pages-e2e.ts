// Goes through each hardware wallet page in a headless Chromium, on the listener in a real build of the app. `macos/device-pages-test.sh`
// sets up what this needs. A stand-in browser wallet does the device's part, and everything the page sends to Base lands on a local fork.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { connect } from "node:net"
import { networkInterfaces } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { encodeNote } from "@pricetag/sdk/core"
import { CSP } from "../server/http.ts"

const env = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} isn't set. Run this through macos/device-pages-test.sh.`)
  return value
}

const rpc = env("ANVIL_RPC_URL")
const pageUrl = new URL(env("DEVICE_PAGE"))
const origin = pageUrl.origin
const port = Number(pageUrl.port)
/** Nobody's, with no key anywhere. The fork lets this send as it, and only the fork ever sees it. */
const device = "0x00000000000000000000000000000000d0d0cafe"
const hot = "0x00000000000000000000000000000000c0ffee01"
const BASE_RPC = "https://mainnet.base.org"

const anvil = async (method: string, params: unknown[]): Promise<any> => {
  const response = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
  const body: any = await response.json()
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`)
  return body.result
}

let failures = 0
const check = (name: string, passed: boolean, detail?: unknown) => {
  console.log(`${passed ? "ok  " : "FAIL"} ${name}${passed || detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`)
  if (!passed) failures++
}

/** A request with whatever headers a site's browser might send, which fetch won't let this choose. */
const raw = (path: string, headers: Record<string, string>, method = "GET") =>
  new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(`${method} ${path} HTTP/1.1\r\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("")}\r\n`))
    let text = ""
    socket.on("data", (data) => (text += data))
    socket.on("end", () => resolve(text))
    socket.on("error", reject)
  })

const isListening = (host: string) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ port, host, timeout: 1000 }, () => (socket.destroy(), resolve(true)))
    socket.on("error", () => resolve(false))
    socket.on("timeout", () => (socket.destroy(), resolve(false)))
  })

/** A browser wallet with a device behind it, as far as a page can tell. Its RPC calls go to the same address the page reads from. */
const WALLET = `(() => {
  const send = (method, params) => fetch(${JSON.stringify(BASE_RPC)}, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
    .then((response) => response.json()).then((body) => { if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code }); return body.result })
  const provider = { request: ({ method, params }) => method === "eth_requestAccounts" || method === "eth_accounts" ? Promise.resolve([${JSON.stringify(device)}]) : send(method, params ?? []) }
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { name: "Stand-in", rdns: "test.standin", icon: "", uuid: "1" }, provider } }))
  window.addEventListener("eip6963:requestProvider", announce)
})()`

class Page {
  private next = 1
  private waiting = new Map<number, (message: any) => void>()
  readonly requests: string[] = []
  readonly blocked: string[] = []
  readonly failed: string[] = []
  readonly console: string[] = []

  private socket: WebSocket

  constructor(socket: WebSocket) {
    this.socket = socket
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id) {
        this.waiting.get(message.id)?.(message)
        this.waiting.delete(message.id)
      } else void this.on(message.method, message.params)
    })
  }

  private async on(method: string, params: any) {
    if (method === "Network.requestWillBeSent") this.requests.push(params.request.url)
    if (method === "Network.responseReceived" && params.response.status >= 400 && params.response.url.startsWith(origin)) this.failed.push(`${params.response.status} ${params.response.url}`)
    if (method === "Log.entryAdded" && params.entry.level === "error") this.console.push(params.entry.text)
    if (method === "Fetch.requestPaused") {
      const { requestId, request } = params
      const cors = [
        { name: "access-control-allow-origin", value: "*" },
        { name: "access-control-allow-headers", value: "*" },
        { name: "content-type", value: "application/json" },
      ]
      if (!request.url.startsWith(BASE_RPC)) {
        this.blocked.push(request.url)
        await this.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" })
      } else if (request.method === "OPTIONS") {
        await this.send("Fetch.fulfillRequest", { requestId, responseCode: 204, responseHeaders: cors })
      } else {
        const answer = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: request.postData })
        await this.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: cors, body: Buffer.from(await answer.text()).toString("base64") })
      }
    }
  }

  send(method: string, params: object = {}): Promise<any> {
    const id = this.next++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`No answer to ${method}`)), 45_000)
      this.waiting.set(id, (message) => {
        clearTimeout(timeout)
        resolve(message)
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression: string): Promise<any> {
    const { result } = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }

  async open(query: string) {
    await this.send("Page.navigate", { url: `${origin}/${query}` })
    await this.until(`document.querySelector("dialog, p") !== null`, "the page to load")
  }

  async until(expression: string, what: string): Promise<void> {
    for (let tries = 0; tries < 300; tries++) {
      if ((await this.evaluate(expression).catch(() => false)) === true) return
      await sleep(100)
    }
    throw new Error(`Never saw ${what}. The page says: ${await this.evaluate("document.body.innerText")}`)
  }

  seeing = (text: string) => this.until(`document.body.innerText.includes(${JSON.stringify(text)})`, `"${text}"`)

  /** The way a person would: only something on the page, enabled, with these words. */
  async press(text: string) {
    const find = `[...document.querySelectorAll("button, a, label")].find((element) => element.innerText.includes(${JSON.stringify(text)}) && !element.disabled)`
    await this.until(`${find} !== undefined`, `a "${text}" button`)
    await this.evaluate(`${find}.click()`)
  }

  /** The transaction the last page sent, once it's mined. */
  async sentTransaction() {
    await this.seeing("✓ Done")
    const hash = await this.evaluate(`document.querySelector('a[href*="basescan.org/tx/"]').href.split("/").pop()`)
    return anvil("eth_getTransactionByHash", [hash])
  }
}

const devtools = async (): Promise<string> => {
  for (let tries = 0; tries < 100; tries++) {
    try {
      const found = readFileSync(env("DEVTOOLS_PORT_FILE"), "utf8").split("\n")[0]
      if (found) return found
    } catch {}
    await sleep(100)
  }
  throw new Error("Chromium didn't start")
}

// What anyone could ask it, before a page has opened.
const here = { Host: `127.0.0.1:${port}` }
const first = await raw("/?topup=0x1", here)
check("it serves the page", first.startsWith("HTTP/1.1 200") && first.includes("<title>Patina</title>"), first.slice(0, 200))
check("with the same content security policy as the server", first.includes(`content-security-policy: ${CSP}\r\n`), first.slice(0, 600))
check("exactly what's in the signed app", first.endsWith(readFileSync(join(env("PAGES_FOLDER"), "device.html"), "utf8")))
const listening = execFileSync("lsof", ["-nP", "-a", "-p", env("APP_PID"), "-iTCP", "-sTCP:LISTEN", "-Fn"], { encoding: "utf8" }).split("\n").filter((line) => line.startsWith("n"))
check("it only listens on 127.0.0.1", listening.length === 1 && listening[0] === `n127.0.0.1:${port}`, listening)
check("on a random port", port !== 8787)
const elsewhere = Object.values(networkInterfaces()).flat().find((address) => address && !address.internal && address.family === "IPv4")?.address
if (elsewhere) check("this Mac's other addresses don't answer", !(await isListening(elsewhere)), elsewhere)
check("a site rebinding its domain here gets nothing", (await raw("/", { Host: `evil.example:${port}` })).startsWith("HTTP/1.1 403"))
check("nor does a request with no such host", (await raw("/", { Host: "localhost" })).startsWith("HTTP/1.1 403"))
check("nor does another site", (await raw("/", { ...here, "Sec-Fetch-Site": "cross-site" })).startsWith("HTTP/1.1 403"))
check("nor does a page on another port here", (await raw("/", { ...here, "Sec-Fetch-Site": "same-site" })).startsWith("HTTP/1.1 403"))
check("nothing else can keep it going", (await raw("/alive", here)).startsWith("HTTP/1.1 403"))
check("nothing outside its files", (await raw("/../Info.plist", here)).startsWith("HTTP/1.1 404") && (await raw("/%2e%2e/Info.plist", here)).startsWith("HTTP/1.1 404"))
check("it has no API", (await raw("/api/rules", here)).startsWith("HTTP/1.1 404"))
check("it only reads", (await raw("/", here, "POST")).startsWith("HTTP/1.1 405"))

await anvil("anvil_impersonateAccount", [device])
await anvil("anvil_setBalance", [device, "0xde0b6b3a7640000"])

const debug = await devtools()
await sleep(500)
const target: any = await (await fetch(`http://127.0.0.1:${debug}/json/new`, { method: "PUT" })).json()
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve)
  socket.addEventListener("error", reject)
})
const page = new Page(socket)
for (const domain of ["Page", "Runtime", "Network", "Log"]) await page.send(`${domain}.enable`)
await page.send("Fetch.enable", { patterns: [{ urlPattern: "https://*" }] })
await page.send("Page.addScriptToEvaluateOnNewDocument", { source: WALLET })

// Top Up.
await page.open(`?topup=${hot}&usd=5`)
check("it's a secure context, so a Ledger can connect", (await page.evaluate("isSecureContext && navigator.hid !== undefined")) === true)
await page.seeing("Top up from savings")
await page.press("Stand-in")
await page.press("Continue")
await page.seeing("0x0000")
await page.press("This is my wallet")
await page.until(`[...document.querySelectorAll("input")].some((input) => input.placeholder === "0.00" && Number(input.value) > 0)`, "the amount filled in from the link")
const before = BigInt(await anvil("eth_getBalance", [hot, "latest"]))
await page.press("Send from your device")
const topUp = await page.sentTransaction()
check("Top Up sends from the device's account to the hot wallet", topUp?.from === device && topUp?.to === hot, topUp)
const moved = BigInt(await anvil("eth_getBalance", [hot, "latest"])) - before
check("and the money moved, on the fork", moved > 0n && moved === BigInt(topUp.value), moved.toString())

// Publish a cost.
const about = `0x${"ab".repeat(32)}`
await page.open(`?publish=${about}&wallet=${device}&asset=USDC&units=1500000&decimals=6&usd=250`)
await page.seeing("Publish this cost")
await page.press("Stand-in")
await page.press("Continue")
await page.press("Publish for everyone")
const note = await page.sentTransaction()
check("Publish writes the note to the wallet itself", note?.from === device && note?.to === device && BigInt(note?.value ?? 1) === 0n, note)
check("and it says what the link asked", note?.input === encodeNote(about, "USDC", "250000000"), note?.input)

// Add a savings wallet. Following the link would open the app, so this only reads where it goes.
await page.open("?addsavings=ledger")
await page.seeing("Add a savings wallet")
await page.seeing("Connect my Ledger")
await page.press("Back")
await page.press("Stand-in")
const link = `[...document.querySelectorAll("a")].find((a) => a.innerText.includes("Add to the Mac app"))`
await page.until(`${link} !== undefined`, "the link to the Mac app")
const href = new URL(await page.evaluate(`${link}.href`))
check("Add Savings hands the account to the app", href.protocol === "patina:" && href.host === "add-savings" && href.searchParams.get("address") === device, href.href)
await page.evaluate(`${link}.addEventListener("click", (event) => event.preventDefault()); ${link}.click()`)
await page.seeing("Finish in the Mac app")

// What a person would take the other ways: their code has to load under the page's rules.
await page.send("Page.reload")
await page.seeing("Connect my Ledger")
await page.until(`performance.getEntriesByType("resource").some((entry) => /assets\\/ledger-/.test(entry.name))`, "a Ledger's code loading")
await page.open(`?topup=${hot}&usd=5`)
await page.press("Keystone")
await page.until(`performance.getEntriesByType("resource").some((entry) => /assets\\/KeystoneCodes-/.test(entry.name))`, "a Keystone's code loading")

check("no flow asked a server for anything", !page.requests.some((url) => url.includes("/api/")), page.requests.filter((url) => url.includes("/api/")))
check("every request for the page's own code worked", page.failed.length === 0, page.failed)
check("the page's rules blocked nothing", !page.console.some((text) => /Content Security Policy/i.test(text)), page.console)
check("everything else that left stayed on the list", page.blocked.every((url) => /^https:\/\/(global\.api\.prd\.ledger\.com\/cal\/|nft\.api\.live\.ledger\.com)/.test(url)), page.blocked)

// Closing it.
check("it's still serving with the tab open, long after the wait for a page", await isListening("127.0.0.1"))
await page.open("?addsavings=ledger")
await page.press("Close")
await page.seeing("You can close this tab")
for (let tries = 0; tries < 250 && (await isListening("127.0.0.1")); tries++) await sleep(100)
check("Close stops it listening", !(await isListening("127.0.0.1")))
const stopped = await raw("/", here).catch(() => "refused")
check("and the address stops answering", stopped === "refused", stopped.slice(0, 100))

socket.close()
if (failures > 0) {
  console.error(`${failures} failed.`)
  process.exit(1)
}
console.log("All passed.")
process.exit(0)
