import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const read = (path: string) => readFileSync(new URL(`../macos/${path}`, import.meta.url), "utf8")
const swift = read("HotWalletKit/Sources/HotWalletKit/Sites/BrowserHosts.swift")
const entitlements = read("Config/Hosted.entitlements")
const extensionID = /^extension_id=(\w+)$/m.exec(read("install-bridge.sh"))![1]!

const swiftBrowsers = [.../static let browsers = \[([\s\S]*?)\]/.exec(swift)![1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!)
const allowed = [...entitlements.matchAll(/<string>\/Library\/Application Support\/(.+?)<\/string>/g)].map((match) => match[1]!)

test("the sandbox allows each browser's host manifest and nothing beside it, for the browsers the app writes to", () => {
  assert.deepEqual(allowed, swiftBrowsers.flatMap((browser) => [`${browser}/NativeMessagingHosts`, `${browser}/NativeMessagingHosts/com.benface.patina.json`]))
})

test("every browser pnpm mac knows, an installed copy knows too", () => {
  const script = /for browser in \\\n([\s\S]*?); do/.exec(read("install-bridge.sh"))![1]!
  const browsers = [...script.matchAll(/"([^"]+)"/g)].map((match) => match[1]!)
  assert.ok(browsers.length > 0)
  for (const browser of browsers) assert.ok(swiftBrowsers.includes(browser), browser)
})

test("an installed copy's manifest allows the same extension as pnpm mac's, and can be told from it", () => {
  assert.ok(swift.includes(`static let extensionID = "${extensionID}"`))
  assert.ok(read("BridgeHost/main.swift").includes(`chrome-extension://${extensionID}/`))
  const theirs = /"description": "([^"]+)"/.exec(read("install-bridge.sh"))![1]!
  const ours = /static let description = "([^"]+)"/.exec(swift)![1]!
  assert.notEqual(theirs, ours)
})

test("the hosted build can't share a Keychain group, sandbox or socket with the normal one", () => {
  const groups = (file: string) => [...read(file).matchAll(/AppIdentifierPrefix\)([\w.]+hotwallet)/g)].map((match) => match[1])
  assert.deepEqual(groups("Config/Hosted.entitlements"), ["com.benface.pricetag.hosted.hotwallet"])
  assert.deepEqual(groups("Config/HotWallet.entitlements"), ["com.benface.pricetag.hotwallet"])
  const ids = (file: string) => [...read(file).matchAll(/^(?:APP_BUNDLE_ID|APP_DEBUG_BUNDLE_ID) = (.+)$/gm)].map((match) => match[1]!)
  const [release, debug] = ids("Config/Hosted.xcconfig")
  assert.ok(release && debug)
  const normal = ids("Config/App.xcconfig")
  assert.equal(normal.length, 2)
  const socket = (id: string) => id.split(".").at(-1)
  for (const id of normal) {
    assert.notEqual(id, release)
    assert.notEqual(id, debug)
    assert.notEqual(socket(id), socket(release))
    assert.notEqual(socket(id), socket(debug))
  }
})

test("the install note says what matters before anything else", () => {
  const note = read("INSTALLING.md")
  const [first, second] = note.split("\n\n")
  assert.match(first!, /macOS 27/)
  assert.match(second!, /unreviewed/)
  assert.match(second!, /\$100/)
  assert.match(note, /can't be exported/)
  assert.match(note, /Load unpacked/)
  assert.doesNotMatch(note, /FIFO|oracle|\blegs?\b/i)
})
