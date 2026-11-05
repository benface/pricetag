import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { describe, test } from "node:test"
import { TOKENS, USDC_ADDRESS } from "@pricetag/sdk/core"
import { serializeTransaction, type Hex } from "viem"
import { HDKey } from "viem/accounts"
import { CSP } from "../server/http.ts"
import { amountForUsd, parseAmount } from "../src/core/device-read.ts"
import { KEYSTONE_LOOK, LEDGER_BLIND_SIGNING, LEDGER_LOCKED, LEDGER_READY, REFUSED_ON_DEVICE, groupAddress, ledgerMessage } from "../src/core/device-wording.ts"
import { addressOfPublicKey, childPublicKey, keystoneAccounts, standardKey } from "../src/core/keystone-accounts.ts"
import { connectKeystone, type ScannedCode } from "../src/ui/devices/keystone.ts"
import { findBrowserWallets } from "../src/ui/devices/browser.ts"

const hex = (value: Uint8Array) => Buffer.from(value).toString("hex")
// BIP-32's published test vector 1, public keys only: the chain m/0'/1/2'/2, and its child 1000000000.
const VECTOR = HDKey.fromExtendedKey("xpub6FHa3pjLCk84BayeJxFW2SP4XRrFd1JYnxeLeU8EqN3vDfZmbqBqaGJAyiLjTAwm6ZLRQUMv1ZACTj37sR62cfN7fe5JnJ7dh8zL4fiyLHV")
const VECTOR_CHILD = "022a471424da5e657499d1ff51cb43c47481a03b1e77f951fe64cec9f5a48f7011"
const DEVICE = "aabbccdd"

const require = createRequire(createRequire(import.meta.url).resolve("@keystonehq/keystone-sdk"))
const registry = require("@keystonehq/bc-ur-registry")
const registryEth = require("@keystonehq/bc-ur-registry-eth")

const hdKeyCode = (path: number[] = [44, 60, 0]): ScannedCode => {
  const origin = new registry.CryptoKeypath(path.map((index) => new registry.PathComponent({ index, hardened: true })), Buffer.from(DEVICE, "hex"), path.length)
  const ur = new registry.CryptoHDKey({ isMaster: false, isPrivateKey: false, key: Buffer.from(VECTOR.publicKey as Uint8Array), chainCode: Buffer.from(VECTOR.chainCode as Uint8Array), origin, parentFingerprint: Buffer.from("01020304", "hex"), name: "Keystone", note: "account.standard" }).toUR()
  return { type: ur.type, cbor: ur.cbor.toString("hex") }
}

describe("a Keystone's accounts", () => {
  test("follows BIP-32 with public keys alone", () => {
    assert.equal(hex(childPublicKey(VECTOR.publicKey as Uint8Array, VECTOR.chainCode as Uint8Array, [1_000_000_000])), VECTOR_CHILD)
  })

  test("an address is what everyone agrees it is", () => {
    // The curve's starting point, whose address is widely published.
    const point = Buffer.from("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", "hex")
    assert.equal(addressOfPublicKey(point), "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf")
  })

  test("accounts run along the standard path", () => {
    const key = { chain: "ETH", path: "m/44'/60'/0'", publicKey: hex(VECTOR.publicKey as Uint8Array), chainCode: hex(VECTOR.chainCode as Uint8Array) }
    const accounts = keystoneAccounts(key, DEVICE, 2, 2)
    assert.deepEqual(accounts.map((a) => a.path), ["44'/60'/0'/0/2", "44'/60'/0'/0/3"])
    assert.equal(accounts[0]?.address, addressOfPublicKey(childPublicKey(VECTOR.publicKey as Uint8Array, VECTOR.chainCode as Uint8Array, [0, 2])))
    assert.equal(accounts[0]?.deviceId, DEVICE)
  })

  test("only takes the key that path comes from", () => {
    assert.equal(standardKey([{ chain: "ETH", path: "m/44'/60'/1'/0/0", publicKey: "02", chainCode: "" }]), null)
    assert.equal(standardKey([{ chain: "ETH", path: "m/44'/60'/0'", publicKey: "02", chainCode: "" }]), null)
  })
})

const UNSIGNED = serializeTransaction({ type: "eip1559", chainId: 8453, nonce: 1, gas: 21_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", value: 5n })
const R = "11".repeat(32)
const S = "22".repeat(32)

/** Answers a sign request the way a Keystone's screen would, in its real format. */
function answering(tamper: (requestId: Buffer) => Buffer = (id) => id, v = "01") {
  const seen: { path: string; chainId: number; data: string; xfp: string; origin: string; type: string; expected: string }[] = []
  return {
    seen,
    exchange: async (code: ScannedCode, expected: string): Promise<ScannedCode> => {
      const request = registryEth.EthSignRequest.fromCBOR(Buffer.from(code.cbor, "hex"))
      seen.push({ path: request.getDerivationPath(), chainId: request.getChainId(), data: request.getSignData().toString("hex"), xfp: request.derivationPath.getSourceFingerprint().toString("hex"), origin: request.getOrigin(), type: code.type, expected })
      const ur = new registryEth.ETHSignature(Buffer.from(`${R}${S}${v}`, "hex"), tamper(request.getRequestId())).toUR()
      return { type: ur.type, cbor: ur.cbor.toString("hex") }
    },
  }
}

describe("signing with a Keystone, in its own format", () => {
  test("reads its connect code", async () => {
    const accounts = await connectKeystone(hdKeyCode(), answering().exchange).listAccounts(0, 2, () => {})
    assert.equal(accounts.length, 2)
    assert.equal(accounts[0]?.deviceId, DEVICE)
    assert.equal(accounts[0]?.path, "44'/60'/0'/0/0")
  })

  test("says so when the code isn't one this can use", () => {
    assert.throws(() => connectKeystone(hdKeyCode([44, 60, 1]), answering().exchange), /doesn't include the account/)
    assert.throws(() => connectKeystone({ type: "eth-signature", cbor: "00" }, answering().exchange), /not the code/)
  })

  test("asks for exactly the transaction, on Base, with the right account", async () => {
    const { seen, exchange } = answering()
    const signature = await connectKeystone(hdKeyCode(), exchange).signTransaction({ address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", path: "44'/60'/0'/0/3", deviceId: DEVICE }, UNSIGNED, () => {})
    assert.deepEqual(seen, [{ path: "m/44'/60'/0'/0/3".slice(2), chainId: 8453, data: UNSIGNED.slice(2), xfp: DEVICE, origin: "Patina", type: "eth-sign-request", expected: "eth-signature" }])
    assert.deepEqual(signature, { r: `0x${R}`, s: `0x${S}`, yParity: 1 })
  })

  test("won't take the answer to another request", async () => {
    const { exchange } = answering(() => Buffer.from("9b1deb4d3b7d4bad9bdd2b0d7b3dcb6d", "hex"))
    await assert.rejects(connectKeystone(hdKeyCode(), exchange).signTransaction({ address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", path: "44'/60'/0'/0/0", deviceId: DEVICE }, UNSIGNED, () => {}), /not the code/)
  })

  test("won't take another kind of code as the answer", async () => {
    await assert.rejects(connectKeystone(hdKeyCode(), async () => hdKeyCode()).signTransaction({ address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", path: "44'/60'/0'/0/0", deviceId: DEVICE }, UNSIGNED, () => {}), /not the code/)
  })
})

describe("amounts", () => {
  const eth = TOKENS[0]!
  const usdc = TOKENS.find((t) => t.address === USDC_ADDRESS)!
  const dai = TOKENS.find((t) => t.symbol === "DAI")!

  test("as typed, exactly", () => {
    assert.equal(parseAmount("1.5", 6), 1_500_000n)
    assert.equal(parseAmount("1,000", 6), 1_000_000_000n)
    assert.equal(parseAmount(".000001", 6), 1n)
  })

  test("never rounded, and never nothing", () => {
    assert.equal(parseAmount("0.0000001", 6), null)
    assert.equal(parseAmount("0", 18), null)
    assert.equal(parseAmount("-1", 18), null)
    assert.equal(parseAmount("1e3", 18), null)
    assert.equal(parseAmount("", 18), null)
  })

  test("dollars to a token, for filling in the form", () => {
    assert.equal(amountForUsd("20000000", eth, 4_000_000_000n), "0.005")
    assert.equal(amountForUsd("20000000", usdc, null), "20.00")
    assert.equal(amountForUsd("20000000", eth, null), null)
    assert.equal(amountForUsd("20000000", dai, 4_000_000_000n), null)
  })
})

describe("what a device says", () => {
  test("in words", () => {
    assert.equal(ledgerMessage({ _tag: "RefusedByUserDAError" }), REFUSED_ON_DEVICE)
    assert.equal(ledgerMessage({ errorCode: "6985" }), REFUSED_ON_DEVICE)
    assert.equal(ledgerMessage({ _tag: "DeviceLockedError" }), LEDGER_LOCKED)
    assert.equal(ledgerMessage({ errorCode: "6a80" }), LEDGER_BLIND_SIGNING)
  })

  test("addresses in groups", () => {
    assert.equal(groupAddress("0xaaaabbbbccccddddeeeeffff0000111122223333"), "0x aaaa bbbb cccc dddd eeee ffff 0000 1111 2222 3333")
  })
})

describe("browser wallets", () => {
  test("our own hot wallet isn't one of the routes", async () => {
    const page = new EventTarget() as EventTarget & { dispatchEvent: EventTarget["dispatchEvent"] }
    const announce = (rdns: string) => page.dispatchEvent(Object.assign(new Event("eip6963:announceProvider"), { detail: { info: { name: rdns, rdns, icon: "" }, provider: {} } }))
    page.addEventListener("eip6963:requestProvider", () => {
      announce("com.benface.patina")
      announce("io.rabby")
    })
    const global = globalThis as { window?: unknown }
    global.window = page
    try {
      assert.deepEqual((await findBrowserWallets(1)).map((w) => w.rdns), ["io.rabby"])
    } finally {
      delete global.window
    }
  })
})

describe("what the page can reach", () => {
  test("Base's RPC and what Ledger needs to name a token, and nothing that reports what's signed", () => {
    const connect = CSP.match(/connect-src ([^;]+)/)?.[1]?.split(" ")
    assert.deepEqual(connect, ["'self'", "https://mainnet.base.org", "https://global.api.prd.ledger.com/cal/", "https://nft.api.live.ledger.com"])
    assert.doesNotMatch(CSP, /blind-signing|transaction-checks/)
    assert.match(CSP, /script-src 'self';/)
  })

  test("device code stays out of the page that only looks at wallets", () => {
    const app = readFileSync(new URL("../src/ui/App.tsx", import.meta.url), "utf8")
    assert.doesNotMatch(app, /from "\.\/DevicePanel|from "\.\/devices|from "\.\.\/core\/cold/)
  })
})

describe("what the flow tells someone to do", () => {
  test("a Ledger's first step names everything it needs", () => {
    const steps = LEDGER_READY.join(" ")
    for (const needed of ["USB cable", "PIN", "Ethereum app", "My Ledger", "Quit Ledger Wallet"]) assert.ok(steps.includes(needed), needed)
  })

  test("a Keystone's address is under the words on its screen", () => {
    assert.ok(KEYSTONE_LOOK.includes("tap ETH"))
    assert.ok(KEYSTONE_LOOK.includes("Receive ETH"))
    assert.ok(!KEYSTONE_LOOK.includes("receive screen for Ethereum"))
  })
})
