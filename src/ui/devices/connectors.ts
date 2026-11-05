// How the panel reaches devices. Each one loads only when it's needed, so looking at a wallet never pulls in any of this. The panel
// takes these as a prop, which is how a test page gives it a stand-in without anything in the app knowing about one.

import type { PublicClient } from "viem"
import type { ColdSend, DeviceSigner, WalletSigner } from "../../core/cold.ts"
import type { BrowserWallet } from "./browser.ts"
import type { ExchangeCodes, ScannedCode } from "./keystone.ts"

export type Connectors = {
  /** Whether this browser can reach a USB device at all. */
  canUseUsb: () => boolean
  preloadLedger: () => void
  ledger: () => Promise<DeviceSigner>
  findWallets: () => Promise<BrowserWallet[]>
  wallet: (wallet: BrowserWallet) => Promise<WalletSigner>
  keystone: (code: ScannedCode, exchange: ExchangeCodes) => Promise<DeviceSigner>
  client: () => Promise<PublicClient>
  send: (send: Omit<ColdSend, "rpc">) => Promise<`0x${string}`>
}

export const realConnectors: Connectors = {
  canUseUsb: () => "hid" in navigator,
  preloadLedger: () => void import("./ledger.ts"),
  ledger: async () => (await import("./ledger.ts")).connectLedger(),
  findWallets: async () => (await import("./browser.ts")).findBrowserWallets(),
  wallet: async (wallet) => (await import("./browser.ts")).connectBrowserWallet(wallet),
  keystone: async (code, exchange) => (await import("./keystone.ts")).connectKeystone(code, exchange),
  client: async () => (await import("../../core/cold.ts")).publicClient() as unknown as PublicClient,
  send: async (send) => (await import("../../core/cold.ts")).sendFromCold(send),
}

