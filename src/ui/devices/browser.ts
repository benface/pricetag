// A browser wallet standing in for the device, like Rabby with a Ledger or a Keystone behind it. It's the fallback when a direct route
// misbehaves. The wallet talks to the device, so all this page can do is ask it to send.

import type { EIP1193Provider } from "viem"
import { isAddress, normalizeAddress } from "@pricetag/sdk/core"
import type { ColdAccount, WalletSigner } from "../../core/cold.ts"

export type BrowserWallet = { name: string; rdns: string; icon: string; provider: EIP1193Provider }

/** Our own extension announces itself too, but it's the hot wallet, and savings can't go through it. */
const NOT_A_ROUTE = new Set(["com.benface.patina"])

/** The wallets in this browser, through EIP-6963. They answer right away or not at all. */
export function findBrowserWallets(waitMs = 150): Promise<BrowserWallet[]> {
  return new Promise((resolve) => {
    const found = new Map<string, BrowserWallet>()
    const announced = (event: Event) => {
      const { info, provider } = (event as CustomEvent<{ info: { name: string; rdns: string; icon: string }; provider: EIP1193Provider }>).detail
      if (!NOT_A_ROUTE.has(info.rdns)) found.set(info.rdns, { name: info.name, rdns: info.rdns, icon: info.icon, provider })
    }
    window.addEventListener("eip6963:announceProvider", announced)
    window.dispatchEvent(new Event("eip6963:requestProvider"))
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", announced)
      resolve([...found.values()])
    }, waitMs)
  })
}

export async function connectBrowserWallet({ name, provider }: BrowserWallet): Promise<WalletSigner> {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[]
  const listed: ColdAccount[] = accounts.filter(isAddress).map((address) => ({ address: normalizeAddress(address), path: null }))
  return {
    kind: "browser",
    name,
    provider,
    listAccounts: async (start, count) => listed.slice(start, start + count),
    // This page can't reach the device through a wallet, so the person has to go and read it there.
    showAddress: async () => "look-on-device",
    close: async () => {},
  }
}
