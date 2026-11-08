// The hardware wallet panel with a stand-in for the device, for looking at it without one. Only `pnpm dev` serves this, at
// /test/support/device-harness.html?scene=accounts, and the app's build never includes it.

import { createRoot } from "react-dom/client"
import { serializeTransaction } from "viem"
import { parseDeviceLink } from "../../src/core/device-link.ts"
import { emptyBook } from "../../src/core/book.ts"
import type { SeenAccount } from "../../src/core/device-accounts.ts"
import { DevicePanel } from "../../src/ui/DevicePanel.tsx"
import type { Connectors } from "../../src/ui/devices/connectors.ts"
import { CodeToSign } from "../../src/ui/devices/KeystoneCodes.tsx"
import "../../src/ui/styles.css"
import { mockSigner } from "./mock-signer.ts"

const accounts: SeenAccount[] = [
  { address: "0x4a6f8c1e2d3b5a79c0e1f2a3b4c5d6e7f8091a2b", path: "44'/60'/0'/0/0", activity: { nonce: 12, ethUnits: 41_000_000_000_000_000n, tokenCount: 2 } },
  { address: "0x7c1d9e3f5a2b4c6d8e0f1a3b5c7d9e1f3a5b7c9d", path: "44'/60'/1'/0/0", activity: { nonce: 0, ethUnits: 0n, tokenCount: 0 } },
  { address: "0x9e2f4a6c8b0d1e3f5a7c9b1d3e5f7a9c1b3d5e7f", path: "44'/60'/2'/0/0", activity: { nonce: 0, ethUnits: 0n, tokenCount: 0 } },
  { address: "0x1b3d5f7a9c0e2f4a6c8b0d2e4f6a8c0e2d4f6a8b", path: "44'/60'/3'/0/0", activity: null },
]

const params = new URLSearchParams(window.location.search)
// Past the first page, for a wallet that takes "Show more" to find.
if (params.get("many")) accounts.push({ address: "0x2c4e6a8b0d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c", path: "44'/60'/4'/0/0", activity: null }, { address: "0x3d5f7a9c1e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f", path: "44'/60'/5'/0/0", activity: null })
const scene = params.get("scene") ?? "route"
const signer = mockSigner(accounts, { check: params.get("look") ? "look-on-device" : "shown-on-device" })

// For checking what the device was asked, and `&holds=1` is a device that keeps showing an address until someone answers.
Object.assign(window, { deviceHarnessShown: signer.shown })
if (params.get("holds")) signer.showAddress = (account) => (signer.shown.push(account.address), new Promise(() => {}))

const connectors: Connectors = {
  canUseUsb: () => params.get("usb") !== "no",
  preloadLedger: () => {},
  ledger: async () => signer,
  findWallets: async () => (params.get("wallets") === "no" ? [] : [{ name: "Rabby", rdns: "io.rabby", icon: "", provider: {} as never }]),
  wallet: async () => {
    throw new Error("No browser wallet here.")
  },
  keystone: async () => signer,
  client: async () => ({ getTransactionCount: async () => 0, multicall: async () => [], getBalance: async ({ address }: { address: string }) => (address === accounts[0]?.address ? 41_000_000_000_000_000n : 0n), readContract: async () => [0n, 310000000000n, 0n, BigInt(Math.floor(Date.now() / 1000)), 0n], estimateGas: async () => 21_000n, estimateFeesPerGas: async () => ({ maxFeePerGas: 6_000_000n }), waitForTransactionReceipt: async () => ({ status: "success" }), chain: { contracts: {} }, call: async () => ({}) }) as never,
  send: async () => `0x${"ab".repeat(32)}`,
}

const chosen = scene === "check" || scene === "ready" || scene === "handoff" ? (accounts[1] as SeenAccount).address : (accounts[0] as SeenAccount).address

const root = createRoot(document.getElementById("root") as HTMLElement)

// What a Keystone scans, in its real format. A long `signData` makes it animate, as a big transaction would.
if (scene === "code") {
  const signData = serializeTransaction({ type: "eip1559", chainId: 8453, nonce: 1, gas: 21_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, to: accounts[0]?.address as `0x${string}`, value: 5n, ...(params.get("long") ? { data: `0x${"ab".repeat(600)}` as `0x${string}` } : {}) }).slice(2)
  const { KeystoneEthereumSDK, KeystoneSDK } = await import("@keystonehq/keystone-sdk")
  const request = new KeystoneSDK().eth.generateSignRequest({ requestId: crypto.randomUUID(), signData, dataType: KeystoneEthereumSDK.DataType.typedTransaction, path: "m/44'/60'/0'/0/0", xfp: "aabbccdd", chainId: 8453 })
  root.render(<CodeToSign code={{ type: request.type, cbor: request.cbor.toString("hex") }} />)
} else root.render(
  <DevicePanel
    link={parseDeviceLink(window.location.search, window.location.hash)}
    book={emptyBook()}
    onLink={() => {}}
    onView={() => {}}
    onClose={() => {}}
    connectors={connectors}
    {...(scene === "route" ? {} : { start: { signer, accounts, chosen, step: scene === "handoff" ? "check" : (scene as "accounts"), ...(scene === "handoff" ? { handingOff: true } : {}), ...(params.get("look") ? { lookOnDevice: true } : {}) } })}
  />,
)
