import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { describe, test } from "node:test"
import { TOKENS, USDC_ADDRESS, WETH_ADDRESS, encodeNote, normalizeAddress, parseNote } from "@pricetag/sdk/core"
import { encodeFunctionData, erc20Abi, parseTransaction, serializeTransaction, type Address, type EIP1193Provider, type Hex, type TransactionSerializable } from "viem"
import { linkDeviceAccounts, emptyBook, isOwnWallet, linkedWallets } from "../src/core/book.ts"
import { NOT_ALLOWED, NOT_LISTED, NOT_YOURS, readColdRequest, sendFromCold, signatureFromHex, toColdAccount, transferRequest, yParityOf, type ColdRequest, type WalletSigner } from "../src/core/cold.ts"
import { accountsToLink, defaultAccount, isFresh, readCheckedAccounts, rememberCheckedAccount, selectedAccount, type SeenAccount } from "../src/core/device-accounts.ts"
import { addToMacLink, noteLinkFor, parseDeviceLink, usdMicrosOf } from "../src/core/device-link.ts"
import { FAKE_SIGNATURE, accountSigningWithFake, mockSigner } from "./support/mock-signer.ts"
import { assertMatchesFixture } from "./support/fixtures.ts"

const COLD = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const HOT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const STRANGER = "0xcccccccccccccccccccccccccccccccccccccccc"
const OWN = new Set([HOT])
const USDC = TOKENS.find((t) => t.address === USDC_ADDRESS)!
const ETH = TOKENS[0]!
const TX = `0x${"ab".repeat(32)}`
const note = encodeNote(TX, "USDC", "250000000") as Hex

const refusal = (request: ColdRequest) => {
  const read = readColdRequest(request, COLD, OWN)
  return "refused" in read ? read.refused : null
}
const call = (functionName: "transfer" | "approve", to: string, units: bigint) => encodeFunctionData({ abi: erc20Abi, functionName, args: [to as Address, units] })

describe("what a cold wallet can sign", () => {
  test("ETH to one of the user's wallets", () => {
    assert.deepEqual(readColdRequest({ to: HOT, value: 5n }, COLD, OWN), { intent: { kind: "transfer", token: ETH, to: HOT, units: 5n } })
  })

  test("a token on the list to one of the user's wallets", () => {
    assert.deepEqual(readColdRequest(transferRequest(USDC, HOT, 5n), COLD, OWN), { intent: { kind: "transfer", token: USDC, to: HOT, units: 5n } })
  })

  test("a note to itself", () => {
    assert.deepEqual(readColdRequest({ to: COLD, value: 0n, data: note }, COLD, OWN), { intent: { kind: "note", ...parseNote(note)! } })
  })

  test("not to anyone else", () => {
    assert.equal(refusal({ to: STRANGER, value: 5n }), NOT_YOURS)
    assert.equal(refusal(transferRequest(USDC, STRANGER, 5n)), NOT_YOURS)
  })

  test("not a send to itself, which would only spend gas", () => {
    assert.equal(refusal({ to: COLD, value: 5n }), NOT_YOURS)
    assert.equal(refusal(transferRequest(USDC, COLD, 5n)), NOT_YOURS)
  })

  test("no approvals, however they're dressed up", () => {
    assert.equal(refusal({ to: USDC_ADDRESS, value: 0n, data: call("approve", HOT, 5n) }), NOT_ALLOWED)
    assert.equal(refusal({ to: USDC_ADDRESS, value: 0n, data: call("approve", HOT, 2n ** 256n - 1n) }), NOT_ALLOWED)
  })

  test("no permits or swaps, or anything else with data", () => {
    const permit = "0xd505accf" as Hex
    const swap = "0x3593564c" as Hex
    assert.equal(refusal({ to: USDC_ADDRESS, value: 0n, data: `${permit}${"00".repeat(224)}` }), NOT_ALLOWED)
    assert.equal(refusal({ to: HOT, value: 0n, data: `${swap}${"00".repeat(96)}` }), NOT_ALLOWED)
    assert.equal(refusal({ to: HOT, value: 5n, data: "0x00" }), NOT_ALLOWED)
  })

  test("a transfer with something extra on the end isn't a plain transfer", () => {
    const transfer = call("transfer", HOT, 5n)
    assert.equal(refusal({ to: USDC_ADDRESS, value: 0n, data: `${transfer}00` }), NOT_ALLOWED)
    assert.equal(refusal({ to: USDC_ADDRESS, value: 0n, data: transfer.slice(0, -2) as Hex }), NOT_ALLOWED)
  })

  test("a transfer call on a contract off the list is refused, even to the user's own wallet", () => {
    assert.equal(refusal({ to: STRANGER, value: 0n, data: call("transfer", HOT, 5n) }), NOT_LISTED)
  })

  test("no empty transfers, and no ETH alongside a call", () => {
    assert.equal(refusal({ to: HOT, value: 0n }), NOT_ALLOWED)
    assert.equal(refusal({ to: USDC_ADDRESS, value: 0n, data: call("transfer", HOT, 0n) }), NOT_ALLOWED)
    assert.equal(refusal({ to: USDC_ADDRESS, value: 1n, data: call("transfer", HOT, 5n) }), NOT_ALLOWED)
  })

  test("a note that isn't to itself, or carries value, or doesn't parse, is refused", () => {
    assert.equal(refusal({ to: HOT, value: 0n, data: note }), NOT_ALLOWED)
    assert.equal(refusal({ to: COLD, value: 1n, data: note }), NOT_ALLOWED)
    assert.equal(refusal({ to: COLD, value: 0n, data: "0x1234" }), NOT_ALLOWED)
  })

  test("WETH counts as a token, so moving it to the user's wallet is a transfer and nothing more", () => {
    const weth = TOKENS.find((t) => t.address === WETH_ADDRESS)!
    assert.deepEqual(readColdRequest(transferRequest(weth, HOT, 5n), COLD, OWN), { intent: { kind: "transfer", token: weth, to: HOT, units: 5n } })
  })
})

const plain = (changes: Partial<TransactionSerializable> = {}) =>
  ({ type: "eip1559", chainId: 8453, nonce: 3, gas: 21_000n, maxFeePerGas: 2_000_000n, maxPriorityFeePerGas: 1_000n, to: HOT as Address, value: 5n, ...changes }) as TransactionSerializable

describe("the account the devices sign through", () => {
  const prompt = () => {}

  test("hands the device the unsigned transaction, and gives back the signed one", async () => {
    const transaction = plain()
    const address = await accountSigningWithFake(transaction)
    const device = mockSigner([{ address, path: "44'/60'/0'/0/0" }])
    const signed = await toColdAccount(device, { address, path: "44'/60'/0'/0/0" }, OWN, prompt).signTransaction(transaction)
    assert.deepEqual(device.asked, [serializeTransaction(transaction)])
    const parsed = parseTransaction(signed)
    assert.equal(parsed.r, FAKE_SIGNATURE.r)
    assert.equal(parsed.to, HOT)
    assert.equal(parsed.value, 5n)
  })

  test("refuses a signature from any other account", async () => {
    const device = mockSigner([{ address: COLD, path: "44'/60'/0'/0/0" }])
    await assert.rejects(toColdAccount(device, { address: COLD, path: "44'/60'/0'/0/0" }, OWN, prompt).signTransaction(plain()), /different account/)
  })

  test("refuses a signature that isn't one", async () => {
    const device = mockSigner([], { signature: { r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}`, yParity: 0 } })
    await assert.rejects(toColdAccount(device, { address: COLD, path: null }, OWN, prompt).signTransaction(plain()), /different account/)
  })

  test("never asks the device about what it isn't allowed to sign", async () => {
    const device = mockSigner([])
    const account = toColdAccount(device, { address: COLD, path: "44'/60'/0'/0/0" }, OWN, prompt)
    await assert.rejects(account.signTransaction(plain({ to: STRANGER as Address })), new RegExp(NOT_YOURS))
    await assert.rejects(account.signTransaction(plain({ to: USDC_ADDRESS as Address, value: 0n, data: call("approve", HOT, 5n) })), new RegExp(NOT_ALLOWED))
    assert.deepEqual(device.asked, [])
  })

  test("only for Base, and only this kind of transaction", async () => {
    const device = mockSigner([])
    const account = toColdAccount(device, { address: COLD, path: "44'/60'/0'/0/0" }, OWN, prompt)
    await assert.rejects(account.signTransaction(plain({ chainId: 1 })), new RegExp(NOT_ALLOWED))
    await assert.rejects(account.signTransaction({ type: "legacy", chainId: 8453, nonce: 0, gas: 21_000n, gasPrice: 1n, to: HOT as Address, value: 5n }), new RegExp(NOT_ALLOWED))
    await assert.rejects(account.signTransaction(plain({ authorizationList: [] }) as never), new RegExp(NOT_ALLOWED))
    assert.deepEqual(device.asked, [])
  })

  test("signs no messages or typed data", async () => {
    const account = toColdAccount(mockSigner([]), { address: COLD, path: null }, OWN, prompt)
    await assert.rejects(account.signMessage({ message: "hello" }), new RegExp(NOT_ALLOWED))
    await assert.rejects(account.signTypedData({ domain: {}, types: { A: [] }, primaryType: "A", message: {} }), new RegExp(NOT_ALLOWED))
  })

  test("a refusal on the device comes back as a failure", async () => {
    const transaction = plain()
    const address = await accountSigningWithFake(transaction)
    await assert.rejects(toColdAccount(mockSigner([], { refuse: true }), { address, path: null }, OWN, prompt).signTransaction(transaction), /Refused/)
  })
})

describe("what devices say", () => {
  test("v in either form", () => {
    assert.equal(yParityOf(0), 0)
    assert.equal(yParityOf(1), 1)
    assert.equal(yParityOf(27), 0)
    assert.equal(yParityOf(28), 1)
    assert.throws(() => yParityOf(37))
  })

  test("a signature as 65 bytes", () => {
    assert.deepEqual(signatureFromHex(`${"11".repeat(32)}${"22".repeat(32)}01`), { r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}`, yParity: 1 })
    assert.deepEqual(signatureFromHex(`0x${"11".repeat(32)}${"22".repeat(32)}1b`).yParity, 0)
    assert.throws(() => signatureFromHex("abcd"))
  })
})

function browserWallet(chain: string): WalletSigner & { asked: { method: string; params?: unknown }[] } {
  const asked: { method: string; params?: unknown }[] = []
  let current = chain
  const provider = {
    async request({ method, params }: { method: string; params?: unknown }) {
      asked.push({ method, params })
      if (method === "eth_chainId") return current
      if (method === "wallet_switchEthereumChain") {
        current = "0x2105"
        return null
      }
      if (method === "eth_sendTransaction") return TX
      throw new Error(`Unexpected ${method}`)
    },
  } as unknown as EIP1193Provider
  return { kind: "browser", name: "Rabby", provider, asked, listAccounts: async () => [], showAddress: async () => "look-on-device", close: async () => {} } as WalletSigner & { asked: typeof asked }
}

describe("a browser wallet", () => {
  const send = (signer: WalletSigner, request: ColdRequest) => sendFromCold({ signer, account: { address: COLD, path: null }, request, own: OWN, onPrompt: () => {} })

  test("sends a plain transfer, on Base", async () => {
    const wallet = browserWallet("0x2105")
    assert.equal(await send(wallet, { to: HOT, value: 5n }), TX)
    assert.equal(wallet.asked.filter((a) => a.method === "eth_sendTransaction").length, 1)
    assert.equal(wallet.asked.some((a) => a.method === "wallet_switchEthereumChain"), false)
  })

  test("is asked to move to Base first", async () => {
    const wallet = browserWallet("0x1")
    assert.equal(await send(wallet, { to: HOT, value: 5n }), TX)
    assert.deepEqual(wallet.asked.find((a) => a.method === "wallet_switchEthereumChain")?.params, [{ chainId: "0x2105" }])
  })

  test("is held to the same rule, and never sees what's refused", async () => {
    const wallet = browserWallet("0x2105")
    await assert.rejects(send(wallet, { to: STRANGER, value: 5n }), new RegExp(NOT_YOURS))
    await assert.rejects(send(wallet, { to: USDC_ADDRESS, value: 0n, data: call("approve", HOT, 5n) }), new RegExp(NOT_ALLOWED))
    assert.deepEqual(wallet.asked, [])
  })
})

const seen = (address: string, activity: SeenAccount["activity"]): SeenAccount => ({ address, path: null, activity })
const FRESH = { nonce: 0, ethUnits: 0n, tokenCount: 0 }

describe("choosing an account", () => {
  const used = seen("0x1111111111111111111111111111111111111111", { nonce: 4, ethUnits: 5n, tokenCount: 1 })
  const tokensOnly = seen("0x2222222222222222222222222222222222222222", { nonce: 0, ethUnits: 0n, tokenCount: 1 })
  const unread = seen("0x3333333333333333333333333333333333333333", null)
  const fresh = seen("0x4444444444444444444444444444444444444444", FRESH)

  test("receiving starts on the first fresh one", () => {
    assert.equal(defaultAccount([used, tokensOnly, unread, fresh], "receive"), fresh)
  })

  test("one that couldn't be read isn't called fresh", () => {
    assert.equal(isFresh(null), false)
    assert.equal(defaultAccount([unread], "receive"), null)
  })

  test("a top-up starts on one with money", () => {
    assert.equal(defaultAccount([fresh, used], "send"), used)
    assert.equal(defaultAccount([fresh], "send"), null)
  })

  test("what's already selected stays, and otherwise it's the default, or the first", () => {
    const options = { required: null, purpose: "receive" as const }
    assert.equal(selectedAccount([used, fresh], { ...options, current: used.address }), used.address)
    assert.equal(selectedAccount([used, fresh], { ...options, current: null }), fresh.address)
    assert.equal(selectedAccount([used], { ...options, current: null }), used.address)
    assert.equal(selectedAccount([], { ...options, current: null }), null)
  })

  test("a wallet that has to publish is the only choice, and nothing stands in for it", () => {
    const options = { purpose: "send" as const, current: null }
    const wanted = fresh.address
    // A different device, which has every other account but that one.
    assert.equal(selectedAccount([used, tokensOnly, unread], { ...options, required: wanted }), null)
    // Something else selected earlier doesn't count either.
    assert.equal(selectedAccount([used, tokensOnly], { ...options, current: used.address, required: wanted }), null)
    // Past the first page, once it's been shown.
    assert.equal(selectedAccount([used, tokensOnly, unread, fresh], { ...options, current: null, required: wanted }), wanted)
    assert.equal(selectedAccount([used, fresh], { purpose: "send", current: used.address, required: wanted.toUpperCase().replace("0X", "0x") }), wanted)
  })

  test("the ones in use and the chosen one get linked, and no others", () => {
    assert.deepEqual(accountsToLink([used, tokensOnly, unread, fresh], fresh.address), [used.address, tokensOnly.address, fresh.address])
    assert.deepEqual(accountsToLink([used, fresh], null), [used.address])
  })

  test("remembers what was checked, once each, and ignores anything broken", () => {
    const stored = new Map<string, string>()
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) }
    const account = { address: COLD.toUpperCase().replace("0X", "0x"), path: "44'/60'/0'/0/0", deviceName: "Ledger", kind: "ledger" as const }
    rememberCheckedAccount(account, storage)
    assert.deepEqual(rememberCheckedAccount(account, storage), [{ ...account, address: COLD }])
    stored.set("patina.deviceAccounts", JSON.stringify([{ address: "nope" }, 4, { address: COLD, path: 3, deviceName: "x", kind: "ledger" }, { address: HOT, path: null, deviceName: "Rabby", kind: "browser" }]))
    assert.deepEqual(readCheckedAccounts(storage), [{ address: HOT, path: null, deviceName: "Rabby", kind: "browser" }])
    stored.set("patina.deviceAccounts", "{")
    assert.deepEqual(readCheckedAccounts(storage), [])
  })

  test("keeps nothing but addresses and where they are", () => {
    const stored = new Map<string, string>()
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) }
    rememberCheckedAccount({ address: COLD, path: "44'/60'/0'/0/0", deviceId: "aabbccdd", deviceName: "Keystone", kind: "keystone" }, storage)
    assert.deepEqual(Object.keys(JSON.parse(stored.get("patina.deviceAccounts")!)[0]).sort(), ["address", "deviceId", "deviceName", "kind", "path"])
  })
})

describe("linking a device's accounts", () => {
  test("they're the user's, with no answer needed, and only they are", () => {
    const book = linkDeviceAccounts(emptyBook(), [COLD.toUpperCase().replace("0X", "0x"), HOT])
    assert.deepEqual(linkedWallets(book).sort(), [COLD, HOT].sort())
    assert.equal(isOwnWallet(book, { address: COLD }), true)
    assert.equal(isOwnWallet(book, { address: STRANGER }), false)
  })

  test("it takes over from an earlier answer", () => {
    const book = linkDeviceAccounts({ ...emptyBook(), senders: { [COLD]: { kind: "someone-else" } } }, [COLD])
    assert.deepEqual(book.senders[COLD], { kind: "mine" })
  })
})

describe("links into the flow", () => {
  test("a top-up", () => {
    assert.deepEqual(parseDeviceLink("?addsavings=ledger"), { kind: "add-savings", device: "ledger" })
    assert.deepEqual(parseDeviceLink("?addsavings=anything"), { kind: "add-savings", device: null })
    assert.deepEqual(parseDeviceLink(`?topup=${HOT}&usd=20`), { kind: "top-up", to: HOT, usdMicros: "20000000" })
    assert.deepEqual(parseDeviceLink(`?topup=${HOT}`), { kind: "top-up", to: HOT, usdMicros: null })
  })

  test("a bad amount is left for the person to fill in, and a bad address isn't a link", () => {
    assert.deepEqual(parseDeviceLink(`?topup=${HOT}&usd=lots`), { kind: "top-up", to: HOT, usdMicros: null })
    assert.deepEqual(parseDeviceLink(`?topup=${HOT}&usd=-5`), { kind: "top-up", to: HOT, usdMicros: null })
    assert.equal(parseDeviceLink("?topup=0x1234&usd=20"), null)
  })

  test("publishing a cost", () => {
    assert.deepEqual(parseDeviceLink(`?publish=${TX}&wallet=${COLD}&asset=USDC&units=1500000&decimals=6&usd=250`), { kind: "publish", wallet: COLD, txHash: TX, asset: "USDC", usdMicros: "250000000", amount: { units: "1500000", decimals: 6 } })
  })

  test("what can't be in a note isn't a link", () => {
    assert.equal(parseDeviceLink(`?publish=0x12&wallet=${COLD}&asset=USDC`), null)
    assert.equal(parseDeviceLink(`?publish=${TX}&wallet=nope&asset=USDC`), null)
    assert.equal(parseDeviceLink(`?publish=${TX}&wallet=${COLD}&asset=US:DC`), null)
  })

  test("anything else isn't a link", () => {
    assert.equal(parseDeviceLink("?address=demo"), null)
    assert.equal(parseDeviceLink(""), null)
  })

  test("dollars", () => {
    assert.equal(usdMicrosOf("$1,250.50"), "1250500000")
    assert.equal(usdMicrosOf(".5"), "500000")
    assert.equal(usdMicrosOf("0"), null)
    assert.equal(usdMicrosOf(null), null)
  })

  test("a decimal comma isn't thousands, since a note can't be taken back", () => {
    assert.equal(usdMicrosOf("46,20"), "46200000")
    assert.equal(usdMicrosOf("1 234,50 $"), "1234500000")
    assert.equal(usdMicrosOf("1,234"), "1234000000")
    assert.equal(usdMicrosOf("1,234,567.50"), "1234567500000")
    for (const bad of ["1.234,50", "12,3456", "1,23,456", "0,125", ",5"]) assert.equal(usdMicrosOf(bad), null, bad)
    assert.equal(noteLinkFor({ wallet: COLD, noteAbout: TX, arrivals: [{ asset: "USDC", units: "1500000", decimals: 6 }], receipts: [{}] }, "46,20", "USD")?.usdMicros, "46200000")
    const link = parseDeviceLink(new URL(`http://127.0.0.1:8787?topup=${HOT}&usd=46,20`).search)
    assert.deepEqual(link, { kind: "top-up", to: HOT, usdMicros: "46200000" })
  })

  test("reads what the Mac app writes, as `DeviceFlowTests.swift` pins it", () => {
    assert.deepEqual(parseDeviceLink(new URL(`http://127.0.0.1:8787?topup=${HOT}&usd=20`).search), { kind: "top-up", to: HOT, usdMicros: "20000000" })
    assert.deepEqual(parseDeviceLink(new URL(`http://127.0.0.1:8787?publish=${TX}&wallet=${COLD}&asset=USDC&units=1500000&decimals=6&usd=250`).search), { kind: "publish", wallet: COLD, txHash: TX, asset: "USDC", usdMicros: "250000000", amount: { units: "1500000", decimals: 6 } })
  })

  test("is what the Swift tests read, for the names it writes and the amounts it reads", () => {
    const written: [typed: string, usd: string][] = [["250", "250"], ["US$46", "46"], ["46 USD", "46"], ["$1,234.50", "1234.5"], ["46,20", "46.2"], [".5", "0.5"], ["1 234,50 $", "1234.5"]]
    const amounts = written.map(([typed, usd]) => {
      const link = parseDeviceLink(new URLSearchParams({ publish: TX, wallet: COLD, asset: "USDC", usd }).toString())
      assert.equal(link?.kind, "publish")
      return { typed, usd, usdMicros: link?.kind === "publish" ? link.usdMicros : null }
    })
    assert.ok(amounts.every(({ usdMicros }) => usdMicros !== null))
    const notAmounts = ["lots", "€46", "0", "-5"]
    for (const typed of notAmounts) assert.equal(usdMicrosOf(typed), null, typed)
    assertMatchesFixture("device-link-vectors.json", {
      names: ["Ledger", "Rabby Wallet", "A+B & C", "Écran 1"].map((name) => ({ name, link: addToMacLink(COLD, name, [HOT]) })),
      amounts,
      notAmounts,
    })
  })

  test("a note from Resolve, only when one can say the whole answer", () => {
    const arrival = { asset: "USDC", units: "1500000", decimals: 6 }
    const question = { wallet: COLD, noteAbout: TX, arrivals: [arrival], receipts: [{}] }
    assert.deepEqual(noteLinkFor(question, "$250", "USD"), { kind: "publish", wallet: COLD, txHash: TX, asset: "USDC", usdMicros: "250000000", amount: { units: "1500000", decimals: 6 } })
    assert.equal(noteLinkFor(question, null, "USD")?.usdMicros, null)
    assert.equal(noteLinkFor({ ...question, noteAbout: null }, "1", "USD"), null)
    assert.equal(noteLinkFor({ ...question, noteAbout: "opening" }, "1", "USD"), null)
    assert.equal(noteLinkFor({ ...question, receipts: [{}, {}] }, "1", "USD"), null)
    assert.equal(noteLinkFor({ ...question, arrivals: [arrival, arrival] }, "1", "USD"), null)
    assert.equal(noteLinkFor({ ...question, arrivals: [{ ...arrival, asset: "US:DC" }] }, "1", "USD"), null)
  })

  test("a cost typed in another currency isn't carried over as dollars", () => {
    const question = { wallet: COLD, noteAbout: TX, arrivals: [{ asset: "USDC", units: "1500000", decimals: 6 }], receipts: [{}] }
    const link = noteLinkFor(question, "250", "CAD")
    assert.equal(link?.usdMicros, null, "the form has to ask for USD")
    assert.equal(link?.txHash, TX, "publishing is still on offer")
  })

  test("the link to the Mac app", () => {
    const link = new URL(addToMacLink(COLD.toUpperCase().replace("0X", "0x"), "Ledger", [HOT]))
    assert.equal(link.protocol, "patina:")
    assert.equal(link.host, "add-savings")
    assert.equal(link.searchParams.get("address"), COLD)
    assert.equal(link.searchParams.get("name"), "Ledger")
    assert.equal(link.searchParams.get("linked"), HOT)
    assert.equal(new URL(addToMacLink(COLD, "Ledger", [])).searchParams.has("linked"), false)
  })
})

const sourceFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? sourceFiles(path) : [path]
})

describe("the rules on keys", () => {
  const root = new URL("..", import.meta.url).pathname
  const app = [...sourceFiles(join(root, "src")), join(root, "index.html")]

  test("the mock signer can't be reached from the app", () => {
    for (const file of app) assert.doesNotMatch(readFileSync(file, "utf8"), /mock-signer|test\/support/, file)
  })

  test("the app has no way to make, import or read a key or phrase", () => {
    for (const file of app) assert.doesNotMatch(readFileSync(file, "utf8"), /privateKeyToAccount|mnemonicToAccount|hdKeyToAccount|generatePrivateKey|generateMnemonic|Math\.random|\bmnemonic\b|recovery phrase input/i, file)
  })

  test("the mock holds no key either", () => {
    assert.doesNotMatch(readFileSync(join(root, "test/support/mock-signer.ts"), "utf8"), /privateKeyToAccount|mnemonic|generatePrivateKey/)
  })
})

const hasAnvil = () => {
  try {
    execFileSync("anvil", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const freePort = () => new Promise<number>((resolve) => {
  const server = createServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address() as { port: number }
    server.close(() => resolve(port))
  })
})

describe("on a local chain", { skip: hasAnvil() ? false : "needs Foundry's anvil" }, () => {
  async function chain() {
    const port = await freePort()
    const process = spawn("anvil", ["--port", String(port), "--chain-id", "8453", "--silent", "--auto-impersonate"], { stdio: "ignore" })
    const rpc = `http://127.0.0.1:${port}`
    const send = async <T,>(method: string, params: unknown[] = []): Promise<T> => {
      const response = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
      const body = (await response.json()) as { result: T; error?: { message: string } }
      if (body.error) throw new Error(body.error.message)
      return body.result
    }
    for (let tries = 0; ; tries++) {
      try {
        await send("eth_chainId")
        break
      } catch (error) {
        if (tries > 50) throw error
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    return { rpc, send, stop: () => process.kill() }
  }

  test("a signed transfer lands, through the same path a device uses", async () => {
    const { send, stop } = await chain()
    try {
      const fees = { maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1_000_000n }
      const transaction = plain({ nonce: 0, gas: 21_000n, value: 7n, ...fees })
      const address = await accountSigningWithFake(transaction)
      await send("anvil_setBalance", [address, "0xde0b6b3a7640000"])
      const signed = await toColdAccount(mockSigner([]), { address, path: null }, OWN, () => {}).signTransaction(transaction)
      const hash = await send<Hex>("eth_sendRawTransaction", [signed])
      // A local chain mines right after it answers, not before.
      let receipt: { status: string; from: string; to: string } | null = null
      for (let tries = 0; !receipt && tries < 50; tries++) {
        receipt = await send("eth_getTransactionReceipt", [hash])
        if (!receipt) await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.ok(receipt, "it never landed")
      assert.equal(receipt.status, "0x1")
      assert.equal(normalizeAddress(receipt.from), normalizeAddress(address))
      assert.equal(normalizeAddress(receipt.to), HOT)
      assert.equal(BigInt(await send<string>("eth_getBalance", [HOT, "latest"])), 7n)
    } finally {
      stop()
    }
  })

  test("a note lands through a browser wallet, and reads back", async () => {
    const { rpc, send, stop } = await chain()
    try {
      await send("anvil_setBalance", [COLD, "0xde0b6b3a7640000"])
      const provider = { request: ({ method, params }: { method: string; params?: unknown[] }) => send(method, params ?? []) } as unknown as EIP1193Provider
      const signer: WalletSigner = { kind: "browser", name: "Local", provider, listAccounts: async () => [], showAddress: async () => "look-on-device", close: async () => {} }
      const hash = await sendFromCold({ signer, account: { address: COLD, path: null }, request: { to: COLD, value: 0n, data: note }, own: OWN, onPrompt: () => {}, rpc })
      const tx = await send<{ input: Hex; from: string; to: string; value: string }>("eth_getTransactionByHash", [hash])
      assert.equal(normalizeAddress(tx.from), COLD)
      assert.equal(normalizeAddress(tx.to), COLD)
      assert.equal(BigInt(tx.value), 0n)
      assert.deepEqual(parseNote(tx.input), { txHash: TX, asset: "USDC", usdMicros: "250000000" })
    } finally {
      stop()
    }
  })
})
