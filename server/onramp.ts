// What buying needs from a provider, and nothing about which one it is: open a checkout, and read what its order says happened.
// Coinbase's is in `coinbase.ts`. Swapping it means another file like that one, and a word for it in `purchaseSource`.

import type { OnrampOrder } from "../src/core/api.ts"

export type Onramp = {
  /** A page for buying `cryptoAmount` of `asset` for this address, and what to ask about its order by. */
  checkout(request: { address: string; asset: string; cryptoAmount: string; clientIp: string | null }): Promise<{ url: string; ref: string }>
  orders(ref: string): Promise<OnrampOrder[]>
}

/** What's on sale here: tokens this app tracks and prices, on the one chain it reads. */
export const ONRAMP_ASSETS = ["ETH", "USDC"]

/** The provider said no, or couldn't be reached. Its message is one to show, and its detail stays in the server's log. */
export class OnrampError extends Error {}

/** A decimal amount in a token's smallest unit, or null when it isn't one, or is finer than the token goes. Never rounded. */
export function unitsOf(value: unknown, decimals: number): string | null {
  const match = typeof value === "string" ? /^(\d+)(?:\.(\d+))?$/.exec(value) : null
  if (!match) return null
  const fraction = (match[2] ?? "").replace(/0+$/, "")
  if (fraction.length > decimals) return null
  return (BigInt(match[1] as string) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0")).toString()
}
