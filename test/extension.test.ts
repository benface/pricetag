import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"
import vm from "node:vm"

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
const manifest = JSON.parse(read("extension/manifest.json"))
const scripts = ["inpage.js", "content.js", "background.js", "popup.js"]

/** The ID Chrome derives from a manifest's public key: the first half of its SHA-256, with each hex digit moved to a to p. */
function extensionId(key: string): string {
  const hash = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32)
  return [...hash].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("")
}

describe("the extension's rules", () => {
  test("only our extension can start the host", () => {
    const id = extensionId(manifest.key)
    assert.match(read("macos/install-bridge.sh"), new RegExp(`^extension_id=${id}$`, "m"))
    assert.match(read("macos/BridgeHost/main.swift"), new RegExp(`"chrome-extension://${id}/"`))
    assert.match(read("macos/install-bridge.sh"), /"allowed_origins": \["chrome-extension:\/\/\$extension_id\/"\]/)
    assert.doesNotMatch(read("macos/install-bridge.sh"), /allowed_origins.*\*/)
  })

  test("the app and its host agree on where the socket is", () => {
    const group = read("macos/HotWalletKit/Sources/HotWalletKit/Sites/BridgeServer.swift").match(/group = "([^"]+)"/)?.[1]
    assert.ok(group)
    assert.ok(read("macos/BridgeHost/main.swift").includes(`/Library/Group Containers/${group}/`))
    const team = group.split(".")[0]
    assert.match(read("macos/run.sh"), new RegExp(`^team=${team}$`, "m"))
    const entitled = `$(AppIdentifierPrefix)${group.slice(team!.length + 1)}`
    assert.ok(read("macos/Config/HotWallet.entitlements").includes(entitled))
    assert.ok(read("macos/Config/BridgeHost.entitlements").includes(entitled))
  })

  test("the host can't reach the Keychain or the app's sandbox", () => {
    const entitlements = read("macos/Config/BridgeHost.entitlements")
    assert.doesNotMatch(entitlements, /keychain/)
    assert.equal(entitlements.match(/<key>/g)?.length, 1)
    assert.doesNotMatch(read("macos/BridgeHost/main.swift"), /import (KeyVault|HotWalletKit|Security)/)
  })

  test("it has the same name as the app", () => {
    const name = read("macos/Config/App.xcconfig").match(/^APP_NAME = (.+)$/m)?.[1]
    assert.equal(manifest.name, name)
    assert.ok(read("extension/inpage.js").includes(`name: "${name}"`))
    assert.ok(read("macos/HotWalletKit/Sources/HotWalletKit/Sites/SiteReview.swift").includes(`appName = "${name}"`))
  })

  test("it asks for nothing it doesn't need", () => {
    assert.deepEqual(manifest.permissions, ["nativeMessaging"])
    assert.equal(manifest.host_permissions, undefined)
    assert.equal(manifest.web_accessible_resources, undefined)
    assert.equal(manifest.externally_connectable, undefined)
    assert.equal(manifest.content_security_policy, undefined)
  })

  test("it runs in top-level HTTPS pages and on this Mac, and nowhere else", () => {
    const expected = ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"]
    for (const script of manifest.content_scripts) {
      assert.deepEqual(script.matches, expected)
      assert.equal(script.all_frames, false)
    }
  })

  test("it doesn't log, store or send anything, or load code from anywhere", () => {
    for (const script of scripts) {
      const source = read(`extension/${script}`)
      for (const banned of [/console\./, /chrome\.storage/, /localStorage/, /indexedDB/, /\bfetch\(/, /XMLHttpRequest/, /WebSocket/, /\beval\(/, /new Function/, /importScripts/, /sendBeacon/]) {
        assert.doesNotMatch(source, banned, `${script} uses ${banned}`)
      }
    }
    assert.doesNotMatch(read("extension/popup.html"), /https?:/)
    assert.deepEqual([...read("extension/popup.html").matchAll(/src="([^"]+)"/g)].map((match) => match[1]), ["popup.js"])
  })

  test("nothing on the page or in the extension has a way to answer an approval", () => {
    for (const script of scripts) assert.doesNotMatch(read(`extension/${script}`), /approve[A-Z(]|kind: "approve/)
  })

  test("the host only gets installed by running the app, so a build can't point browsers at a temporary folder", () => {
    const run = read("macos/run.sh")
    assert.ok(run.indexOf("--build-only") < run.indexOf("install-bridge.sh"))
  })

  test("installing the host writes a manifest for the browsers this Mac has, and no others", () => {
    const home = mkdtempSync(join(tmpdir(), "bridge-install-"))
    try {
      const support = join(home, "Library/Application Support")
      mkdirSync(join(support, "Google/Chrome"), { recursive: true })
      mkdirSync(join(support, "Arc/User Data"), { recursive: true })
      const app = join(home, "Patina.app")
      mkdirSync(join(app, "Contents/Helpers"), { recursive: true })
      const host = join(app, "Contents/Helpers/pricetag-bridge")
      writeFileSync(host, "")
      chmodSync(host, 0o755)
      execFileSync(new URL("../macos/install-bridge.sh", import.meta.url).pathname, [app], { env: { ...process.env, HOME: home } })

      const written = JSON.parse(readFileSync(join(support, "Google/Chrome/NativeMessagingHosts/com.benface.patina.json"), "utf8"))
      assert.equal(written.name, "com.benface.patina")
      assert.equal(written.path, host)
      assert.equal(written.type, "stdio")
      assert.deepEqual(written.allowed_origins, [`chrome-extension://${extensionId(manifest.key)}/`])
      assert.ok(existsSync(join(support, "Arc/User Data/NativeMessagingHosts/com.benface.patina.json")))
      assert.ok(!existsSync(join(support, "Microsoft Edge")))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

type Listener = (event: any) => void

/** A window with just what the provider uses, and postMessage between its scripts and the test. */
function pageWindow(existing: Record<string, unknown> = {}) {
  const listeners = new Map<string, Set<Listener>>()
  const posted: any[] = []
  const window: any = {
    ...existing,
    location: { origin: "https://site.example" },
    addEventListener(type: string, listener: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(listener)
    },
    dispatchEvent(event: any) {
      for (const listener of listeners.get(event.type) ?? []) listener(event)
      return true
    },
    postMessage(data: any) {
      posted.push(structuredClone(data))
    },
  }
  return {
    window,
    posted,
    fromWallet(message: object, source: unknown = window) {
      for (const listener of listeners.get("message") ?? []) {
        listener({ source, origin: "https://site.example", data: { channel: "patina-provider", direction: "from-wallet", ...message } })
      }
    },
  }
}

class FakeCustomEvent {
  type: string
  detail: any
  constructor(type: string, init: { detail: any }) {
    this.type = type
    this.detail = init.detail
  }
}

function loadProvider(existing?: Record<string, unknown>) {
  const page = pageWindow(existing)
  const announced: any[] = []
  page.window.addEventListener("eip6963:announceProvider", (event: any) => announced.push(event.detail))
  vm.runInNewContext(read("extension/inpage.js"), {
    window: page.window,
    CustomEvent: FakeCustomEvent,
    crypto: { randomUUID: () => "11111111-1111-4111-8111-111111111111" },
    setTimeout,
  })
  return { ...page, announced, provider: announced[0].provider }
}

describe("the provider", () => {
  test("announces itself with EIP-6963, and again when asked", () => {
    const { announced, window } = loadProvider()
    assert.equal(announced.length, 1)
    assert.equal(announced[0].info.name, "Patina")
    assert.equal(announced[0].info.rdns, "com.benface.patina")
    assert.match(announced[0].info.icon, /^data:image\//)
    window.dispatchEvent({ type: "eip6963:requestProvider" })
    assert.equal(announced.length, 2)
  })

  test("doesn't take the place of a wallet that's already there", () => {
    const other = { other: true }
    assert.equal(loadProvider({ ethereum: other }).window.ethereum, other)
    const { window, provider } = loadProvider()
    assert.equal(window.ethereum, provider)
  })

  test("lets a site set properties on it, which Uniswap crashes without", () => {
    const { provider } = loadProvider()
    provider.autoRefreshOnNetworkChange = false
    assert.equal(provider.autoRefreshOnNetworkChange, false)
  })

  test("asks through the channel, and answers with what comes back", async () => {
    const { provider, posted, fromWallet } = loadProvider()
    const answer = provider.request({ method: "eth_chainId" })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(posted[0].channel, "patina-provider")
    assert.equal(posted[0].direction, "to-wallet")
    assert.equal(posted[0].method, "eth_chainId")
    fromWallet({ id: posted[0].id, result: "0x2105" })
    assert.equal(await answer, "0x2105")
  })

  test("passes on an EIP-1193 error with its code and data", async () => {
    const { provider, posted, fromWallet } = loadProvider()
    const answer = provider.request({ method: "eth_sign", params: [] })
    await new Promise((resolve) => setImmediate(resolve))
    fromWallet({ id: posted[0].id, error: { code: 4200, message: "No.", data: "0x01" } })
    await assert.rejects(answer, (error: any) => error.code === 4200 && error.message === "No." && error.data === "0x01")
  })

  test("refuses what it can't send, without asking", async () => {
    const { provider, posted } = loadProvider()
    await assert.rejects(provider.request({}), (error: any) => error.code === -32602)
    await assert.rejects(provider.request({ method: "eth_call", params: [1n] }), (error: any) => error.code === -32602)
    assert.equal(posted.length, 0)
  })

  test("ignores answers that didn't come from its own window", async () => {
    const { provider, posted, fromWallet } = loadProvider()
    const answer = provider.request({ method: "eth_accounts" })
    await new Promise((resolve) => setImmediate(resolve))
    fromWallet({ id: posted[0].id, result: ["0xbad"] }, {})
    fromWallet({ id: posted[0].id, result: [] })
    assert.equal((await answer).length, 0)
  })

  test("emits accountsChanged, connect and disconnect", async () => {
    const { provider, posted, fromWallet } = loadProvider()
    const seen: unknown[][] = []
    const listener = (accounts: unknown) => seen.push(["accounts", accounts])
    provider.on("accountsChanged", listener)
    provider.on("connect", (info: any) => seen.push(["connect", info.chainId]))
    provider.on("disconnect", (error: any) => seen.push(["disconnect", error.code]))
    assert.equal(provider.isConnected(), false)

    const answer = provider.request({ method: "eth_requestAccounts" })
    await new Promise((resolve) => setImmediate(resolve))
    fromWallet({ id: posted[0].id, result: ["0xabc"] })
    await answer
    assert.equal(provider.isConnected(), true)
    fromWallet({ event: "accountsChanged", data: ["0xabc"] })
    fromWallet({ event: "accountsChanged", data: [] })
    fromWallet({ event: "disconnect", message: "Gone" })
    provider.removeListener("accountsChanged", listener)
    fromWallet({ event: "accountsChanged", data: ["0xabc"] })

    assert.equal(JSON.stringify(seen), JSON.stringify([["connect", "0x2105"], ["accounts", ["0xabc"]], ["accounts", []], ["disconnect", 4900]]))
    assert.equal(provider.isConnected(), false)
  })
})

function fakePort(name: string, sender?: object) {
  const messages: any[] = []
  const handlers: Listener[] = []
  const disconnects: (() => void)[] = []
  const port: any = {
    name,
    sender,
    disconnected: false,
    postMessage: (message: any) => messages.push(message),
    disconnect() {
      port.disconnected = true
    },
    onMessage: { addListener: (listener: Listener) => handlers.push(listener) },
    onDisconnect: { addListener: (listener: () => void) => disconnects.push(listener) },
    messages,
    receive: (message: any) => handlers.forEach((handler) => handler(message)),
    close: () => disconnects.forEach((handler) => handler()),
  }
  return port
}

let backgroundImports = 0

async function loadBackground() {
  const native = fakePort("native")
  let connect: Listener = () => {}
  let hostAvailable = true
  const chrome: any = {
    runtime: {
      id: "ours",
      lastError: undefined,
      getURL: (path: string) => `chrome-extension://ours/${path}`,
      onConnect: { addListener: (listener: Listener) => (connect = listener) },
      connectNative: (host: string) => {
        assert.equal(host, "com.benface.patina")
        if (!hostAvailable) throw new Error("Specified native messaging host not found.")
        return native
      },
    },
  }
  ;(globalThis as any).chrome = chrome
  backgroundImports++
  const module: any = await import(`../extension/background.js?load=${backgroundImports}`)
  return {
    module,
    native,
    chrome,
    connect: (port: any) => connect(port),
    breakHost: () => {
      hostAvailable = false
    },
  }
}

const tabSender = (origin: string, extra: object = {}) => ({ id: "ours", origin, frameId: 0, tab: {}, url: `${origin}/page`, ...extra })

describe("the background script", () => {
  test("takes the origin from the browser, whatever the page says", async () => {
    const { connect, native } = await loadBackground()
    const port = fakePort("site", tabSender("https://real.example"))
    connect(port)
    port.receive({ id: 1, method: "eth_accounts", origin: "https://spoofed.example", kind: "popup", params: [] })
    assert.equal(native.messages.length, 1)
    const sent = native.messages[0]
    assert.equal(sent.kind, "site")
    assert.equal(sent.origin, "https://real.example")
    assert.equal(sent.method, "eth_accounts")
  })

  test("refuses anything but a top-level page on HTTPS or this Mac", async () => {
    const { connect, native } = await loadBackground()
    for (const sender of [
      tabSender("https://real.example", { frameId: 1 }),
      tabSender("http://real.example"),
      tabSender("http://localhost.real.example"),
      tabSender("file://"),
      tabSender("https://real.example", { id: "someone-else" }),
      tabSender("https://real.example", { tab: undefined }),
      tabSender("https://real.example/path"),
      { id: "ours", frameId: 0, tab: {} },
      undefined,
    ]) {
      const port = fakePort("site", sender)
      connect(port)
      assert.equal(port.disconnected, true, JSON.stringify(sender))
    }
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:3000", "https://real.example"]) {
      const port = fakePort("site", tabSender(origin))
      connect(port)
      assert.equal(port.disconnected, false, origin)
    }
    assert.equal(native.messages.length, 0)
  })

  test("a page can't pretend to be the popup, or use an unknown port", async () => {
    const { connect, native } = await loadBackground()
    const pretending = fakePort("popup", tabSender("https://real.example"))
    connect(pretending)
    assert.equal(pretending.disconnected, true)
    const otherExtensionPage = fakePort("popup", { id: "ours", url: "chrome-extension://ours/other.html" })
    connect(otherExtensionPage)
    assert.equal(otherExtensionPage.disconnected, true)
    const unknown = fakePort("anything", tabSender("https://real.example"))
    connect(unknown)
    assert.equal(unknown.disconnected, true)

    const popup = fakePort("popup", { id: "ours", url: "chrome-extension://ours/popup.html" })
    connect(popup)
    assert.equal(popup.disconnected, false)
    popup.receive({ id: 5, method: "status" })
    assert.equal(native.messages[0].kind, "popup")
  })

  test("sends each answer back to the page that asked, under its own ID", async () => {
    const { connect, native } = await loadBackground()
    const first = fakePort("site", tabSender("https://one.example"))
    const second = fakePort("site", tabSender("https://two.example"))
    connect(first)
    connect(second)
    first.receive({ id: 1, method: "eth_accounts" })
    second.receive({ id: 1, method: "eth_accounts" })
    const [toFirst, toSecond] = native.messages
    assert.notEqual(toFirst.id, toSecond.id)
    native.receive({ id: toSecond.id, result: ["two"] })
    native.receive({ id: toFirst.id, error: { code: 4001, message: "No" } })
    assert.equal(JSON.stringify(second.messages), JSON.stringify([{ id: 1, result: ["two"] }]))
    assert.equal(JSON.stringify(first.messages), JSON.stringify([{ id: 1, error: { code: 4001, message: "No" } }]))
  })

  test("a closed tab cancels what it was waiting for", async () => {
    const { connect, native } = await loadBackground()
    const port = fakePort("site", tabSender("https://one.example"))
    connect(port)
    port.receive({ id: 1, method: "eth_requestAccounts" })
    port.receive({ id: 2, method: "eth_chainId" })
    native.receive({ id: native.messages[1].id, result: "0x2105" })
    port.close()
    const cancels = native.messages.filter((message: any) => message.kind === "cancel")
    assert.deepEqual(cancels.map((message: any) => message.id), [native.messages[0].id])
  })

  test("account changes only go to the origin they're about", async () => {
    const { connect, native } = await loadBackground()
    const one = fakePort("site", tabSender("https://one.example"))
    const two = fakePort("site", tabSender("https://two.example"))
    connect(one)
    connect(two)
    one.receive({ id: 1, method: "eth_chainId" })
    native.receive({ event: "accountsChanged", origin: "https://one.example", data: [] })
    assert.equal(JSON.stringify(one.messages), JSON.stringify([{ event: "accountsChanged", data: [] }]))
    assert.equal(two.messages.length, 0)
  })

  test("when the app goes away, every page hears it and nothing hangs", async () => {
    const { connect, native } = await loadBackground()
    const port = fakePort("site", tabSender("https://one.example"))
    connect(port)
    port.receive({ id: 1, method: "eth_requestAccounts" })
    native.close()
    assert.equal(port.messages[0].id, 1)
    assert.equal(port.messages[0].error.code, 4900)
    assert.match(port.messages[0].error.message, /isn't open/)
    assert.equal(port.messages[1].event, "disconnect")
  })

  test("says so when the host isn't installed", async () => {
    const { connect, breakHost, chrome, native } = await loadBackground()
    const port = fakePort("site", tabSender("https://one.example"))
    connect(port)
    port.receive({ id: 1, method: "eth_chainId" })
    chrome.runtime.lastError = { message: "Specified native messaging host not found." }
    native.close()
    chrome.runtime.lastError = undefined
    breakHost()
    assert.match(port.messages[0].error.message, /pnpm mac/)
    port.receive({ id: 2, method: "eth_chainId" })
    assert.equal(port.messages.at(-1).error.code, 4900)
  })
})
