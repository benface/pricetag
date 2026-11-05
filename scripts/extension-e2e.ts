// Drives a real site in a headless Chromium through the extension. `macos/extension-test.sh` sets up what this needs, and explains it.
// It only uses what a page can use: `window.ethereum` and EIP-6963, in the page's own world, with the page's real origin.
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { setTimeout as sleep } from "node:timers/promises"

const env = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} isn't set. Run this through macos/extension-test.sh.`)
  return value
}

const rpc = env("ANVIL_RPC_URL")
const hotWallet = env("HOT_WALLET")
const site = process.argv[2] ?? "https://aerodrome.finance/"
/** Nobody's. Only the fork ever sees anything sent here. */
const recipient = "0x000000000000000000000000000000000000dead"

/** What the person at the approval window would do. The debug build asks this for each thing that's waiting. */
let answer: "approve" | "reject" | "wait" = "wait"
const answerWith = (next: typeof answer) => {
  answer = next
}
createServer((_, response) => response.end(answer)).listen(Number(env("ANSWERS_PORT")), "127.0.0.1")

const anvil = async (method: string, params: unknown[]): Promise<any> => {
  const response = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const body: any = await response.json()
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`)
  return body.result
}

async function devtoolsPort(): Promise<string> {
  for (let tries = 0; tries < 100; tries++) {
    try {
      const port = readFileSync(env("DEVTOOLS_PORT_FILE"), "utf8").split("\n")[0]
      if (port) return port
    } catch {}
    await sleep(100)
  }
  throw new Error("Chromium didn't start")
}

/** Just enough of the DevTools protocol, over Node's own WebSocket, so this needs no dependency. */
class Page {
  private socket: WebSocket
  private next = 1
  private waiting = new Map<number, (message: any) => void>()

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data))
      this.waiting.get(message.id)?.(message)
      this.waiting.delete(message.id)
    })
  }

  static async open(port: string): Promise<Page> {
    const response = await fetch(`http://127.0.0.1:${port}/json/new`, { method: "PUT" })
    return Page.attach(await response.json())
  }

  static async attach(target: any): Promise<Page> {
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve)
      socket.addEventListener("error", reject)
    })
    return new Page(socket)
  }

  /** Nothing here should take long, so a request that gets no answer fails instead of hanging. */
  send(method: string, params: object = {}): Promise<any> {
    const id = this.next++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`No answer to ${method}: ${JSON.stringify(params).slice(0, 300)}`)), 45_000)
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

  /** One provider call, as `{ result }` or `{ error }`. */
  call(method: string, params?: unknown): Promise<any> {
    const request = JSON.stringify({ method, params })
    return this.evaluate(`window.__patina.request(${request}).then((result) => ({ result }), (error) => ({ error: { code: error.code, message: error.message } }))`)
  }
}

let failures = 0
const check = (name: string, passed: boolean, detail?: unknown) => {
  console.log(`${passed ? "ok  " : "FAIL"} ${name}${passed || detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`)
  if (!passed) failures++
}

answerWith("wait")
const port = await devtoolsPort()
await sleep(1000)
const page = await Page.open(port)
const navigated = await page.send("Page.navigate", { url: site })
if (navigated.result?.errorText) throw new Error(`Couldn't open ${site}: ${navigated.result.errorText}`)
// A new tab is about:blank until the site's first bytes arrive.
for (let tries = 0; tries < 300; tries++) {
  if ((await page.evaluate(`location.origin !== "null" && document.readyState !== "loading"`)) === true) break
  await sleep(100)
}

const origin = await page.evaluate("location.origin")
console.log(`On ${origin}. Wallet ${hotWallet}.`)

// A site that crashes because a wallet's there is the worst way for this to go wrong, and nothing else here would notice it.
let rendered = false
for (let tries = 0; tries < 200 && !rendered; tries++) {
  rendered = (await page.evaluate("document.body?.innerText.trim().length > 0")) === true
  if (!rendered) await sleep(100)
}
check("the site still renders with the extension installed", rendered)

const announced = await page.evaluate(`new Promise((resolve) => {
  const found = []
  window.addEventListener("eip6963:announceProvider", (event) => found.push(event.detail))
  window.dispatchEvent(new Event("eip6963:requestProvider"))
  setTimeout(() => {
    const patina = found.find((detail) => detail.info.rdns === "com.benface.patina")
    window.__patina = patina?.provider
    resolve({ names: found.map((detail) => detail.info.name), isPatina: patina?.provider.isPatina === true })
  }, 300)
})`)
check("the site finds it through EIP-6963", announced.isPatina, announced)

check("it's on Base", (await page.call("eth_chainId")).result === "0x2105")
check("a site that hasn't connected sees no accounts", (await page.call("eth_accounts")).result?.length === 0)
const unconnectedSend = await page.call("eth_sendTransaction", [{ from: hotWallet, to: recipient, value: "0x1" }])
check("a site that hasn't connected can't send", unconnectedSend.error?.code === 4100, unconnectedSend)
const refused = await page.call("eth_sign", [hotWallet, `0x${"11".repeat(32)}`])
check("eth_sign is refused outright", refused.error?.code === 4200, refused)
const otherChain = await page.call("wallet_switchEthereumChain", [{ chainId: "0x1" }])
check("other chains are refused", otherChain.error?.code === 4902, otherChain)

answerWith("reject")
const rejectedConnect = await page.call("eth_requestAccounts")
check("rejecting in the app rejects the connection", rejectedConnect.error?.code === 4001, rejectedConnect)
check("and it still sees no accounts", (await page.call("eth_accounts")).result?.length === 0)

answerWith("approve")
const connected = await page.call("eth_requestAccounts")
check("approving in the app connects it, to the hot wallet only", connected.result?.length === 1 && connected.result[0] === hotWallet.toLowerCase(), connected)

await anvil("anvil_setBalance", [hotWallet, "0x2386f26fc10000"])
const balance = await page.call("eth_getBalance", [hotWallet, "latest"])
check("reads go through the app to the node", balance.result === "0x2386f26fc10000", balance)

const before = BigInt(await anvil("eth_getBalance", [recipient, "latest"]))
answerWith("reject")
const rejectedSend = await page.call("eth_sendTransaction", [{ from: hotWallet, to: recipient, value: "0x38d7ea4c68000" }])
check("rejecting a transaction refuses it", rejectedSend.error?.code === 4001, rejectedSend)
check("and nothing moved", BigInt(await anvil("eth_getBalance", [recipient, "latest"])) === before)

const wrongFrom = await page.call("eth_sendTransaction", [{ from: recipient, to: recipient, value: "0x1" }])
check("a transaction from any other address is refused", wrongFrom.error?.code === 4100, wrongFrom)
const wrongChain = await page.call("eth_sendTransaction", [{ from: hotWallet, to: recipient, value: "0x1", chainId: "0x1" }])
check("a transaction for another chain is refused", wrongChain.error?.code === 4901, wrongChain)

answerWith("approve")
const sent = await page.call("eth_sendTransaction", [{ from: hotWallet, to: recipient, value: "0x38d7ea4c68000" }])
check("approving a transaction sends it", typeof sent.result === "string" && sent.result.length === 66, sent)
let receipt: any = null
for (let tries = 0; tries < 50 && !receipt; tries++) {
  receipt = (await page.call("eth_getTransactionReceipt", [sent.result])).result
  await sleep(100)
}
check("the fork mined it", receipt?.status === "0x1" && receipt.from === hotWallet.toLowerCase(), receipt)
check("and the money moved", BigInt(await anvil("eth_getBalance", [recipient, "latest"])) === before + 0x38d7ea4c68000n)

const greeting = "Hello from a real site"
const signed = await page.call("personal_sign", [`0x${Buffer.from(greeting).toString("hex")}`, hotWallet])
check("signing a message returns a signature", /^0x[0-9a-f]{130}$/.test(signed.result ?? ""), signed)
// Foundry's own check, so this isn't just the wallet agreeing with itself.
const verified = execFileSync("cast", ["wallet", "verify", "--address", hotWallet, greeting, signed.result], { encoding: "utf8" })
check("and Foundry agrees this wallet signed it", verified.includes("Validation succeeded"), verified)

const typed = {
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "chainId", type: "uint256" },
    ],
    Note: [{ name: "text", type: "string" }],
  },
  primaryType: "Note",
  domain: { name: "Test", chainId: 8453 },
  message: { text: "hello" },
}
const typedSigned = await page.call("eth_signTypedData_v4", [hotWallet, JSON.stringify(typed)])
check("signing typed data returns a signature", /^0x[0-9a-f]{130}$/.test(typedSigned.result ?? ""), typedSigned)
const typedOther = await page.call("eth_signTypedData_v4", [hotWallet, JSON.stringify({ ...typed, domain: { name: "Test", chainId: 1 } })])
check("typed data for another chain is refused", typedOther.error?.code === 4901, typedOther)

const revoked = await page.call("wallet_revokePermissions", [{ eth_accounts: {} }])
check("a site can disconnect itself", revoked.error === undefined && (await page.call("eth_accounts")).result?.length === 0, revoked)

// In a tab, since headless has no toolbar to open it from. It's the same page, and only the extension can load it.
const targets = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[]
const extension = `chrome-extension://${env("EXTENSION_ID")}/`
const worker = (await targets()).find((target) => target.type === "service_worker" && target.url.startsWith(extension))
check("the extension's background script is running", worker !== undefined)
if (worker) {
  const popup = await Page.open(port)
  await popup.send("Page.navigate", { url: `${extension}popup.html` })
  let status: any
  for (let tries = 0; tries < 100; tries++) {
    status = await popup.evaluate(`document.getElementById("address") && ({ status: document.getElementById("status").textContent, address: document.getElementById("address").title, short: document.getElementById("address").textContent, lines: document.getElementById("address").getClientRects().length, disabled: document.getElementById("top-up").disabled, receiveDisabled: document.getElementById("receive").disabled })`)
    if (status?.address) break
    await sleep(100)
  }
  check("the popup shows the hot wallet", status?.address?.toLowerCase() === hotWallet.toLowerCase(), status)
  check("its address is short, on one line", status?.short === `${status?.address?.slice(0, 6)}…${status?.address?.slice(-4)}` && status?.lines === 1, status)
  check("and Top up can be pressed", status?.disabled === false, status)
  check("and so can Receive", status?.receiveDisabled === false, status)
  if (process.env.POPUP_SCREENSHOT) {
    const shot = await popup.send("Page.captureScreenshot", { format: "png" })
    writeFileSync(process.env.POPUP_SCREENSHOT, Buffer.from(shot.result.data, "base64"))
  }
  // Each closes the popup once the app has it, so Top up gets a fresh one.
  await popup.evaluate(`document.getElementById("receive").click()`)
  let askedToReceive = false
  for (let tries = 0; tries < 50 && !askedToReceive; tries++) {
    askedToReceive = readFileSync(env("APP_LOG"), "utf8").includes("RECEIVE ASKED")
    if (!askedToReceive) await sleep(100)
  }
  check("pressing Receive reaches the app", askedToReceive)
  const again = await Page.open(port)
  await again.send("Page.navigate", { url: `${extension}popup.html` })
  for (let tries = 0; tries < 100; tries++) {
    if (await again.evaluate(`document.getElementById("top-up")?.disabled === false`)) break
    await sleep(100)
  }
  await again.evaluate(`document.getElementById("top-up").click()`)
  let asked = false
  for (let tries = 0; tries < 50 && !asked; tries++) {
    asked = readFileSync(env("APP_LOG"), "utf8").includes("TOP UP ASKED")
    if (!asked) await sleep(100)
  }
  check("pressing Top up reaches the app", asked)
}

const { data: screenshot } = await page.send("Page.captureScreenshot", { format: "png" }).then((message) => message.result)
if (process.env.SCREENSHOT) writeFileSync(process.env.SCREENSHOT, Buffer.from(screenshot, "base64"))

if (failures > 0) {
  console.error(`${failures} failed.`)
  process.exit(1)
}
console.log("All passed.")
process.exit(0)
