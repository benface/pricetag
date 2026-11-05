// Addresses with a name we can back up. Each one's name tag was read on Basescan, or its owner traced on Base, and its
// activity checked on Base. A name is only evidence: exchanges send everyone's withdrawals from shared addresses, so it
// never says whose withdrawal this was.

import { normalizeAddress } from "@pricetag/sdk/core"

export type KnownSender = { name: string; kind: "exchange" | "bridge" }

const KNOWN: Readonly<Record<string, KnownSender>> = {
  "0x71660c4005ba85c37ccec55d0c4493e66fe775d3": { name: "Coinbase", kind: "exchange" },
  // No name tag on either. The first paid a real Coinbase withdrawal (0x82a62dd6…3a26). The second has the same deployer,
  // its only caller has the same Coinbase-tagged funder, and in a day of ETH payouts the two shared 239 recipients.
  "0x4b5c71082d027d16d2a146465d66f9eec11634f6": { name: "Coinbase", kind: "exchange" },
  "0xbf2f1213f47e76f1c1d9b7a536f2cb8b347d59b4": { name: "Coinbase", kind: "exchange" },
  "0x4200000000000000000000000000000000000010": { name: "the Base bridge", kind: "bridge" },
  "0x09aea4b2242abc8bb4bb78d537a67a245a7bec64": { name: "Across", kind: "bridge" },
  "0xf70da97812cb96acdf810712aa562db8dfa3dbef": { name: "Relay", kind: "bridge" },
  "0x27a16dc786820b16e5c9028b75b99f6f604b5d26": { name: "Stargate", kind: "bridge" },
}

/** Where a mint comes from. Nobody holds this address, so it can't be one of the user's wallets. */
export const MINT_ADDRESS = "0x0000000000000000000000000000000000000000"

export const knownSender = (address: string): KnownSender | null => KNOWN[normalizeAddress(address)] ?? null
