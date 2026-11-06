// Addresses with a name we can back up. Each one's name tag was read on Basescan, or a withdrawal from it confirmed, and
// its activity checked on Base. A name is only evidence: exchanges send everyone's withdrawals from shared addresses, so
// it never says whose withdrawal this was. Whatever a bridge or a rewards contract sends is valued at its price, with nothing
// to ask, so only name one when nothing else could come out of it.

import { normalizeAddress } from "@pricetag/sdk/core"

export type KnownSender = { name: string; kind: "exchange" | "bridge" | "reward" }

const KNOWN: Readonly<Record<string, KnownSender>> = {
  "0x71660c4005ba85c37ccec55d0c4493e66fe775d3": { name: "Coinbase", kind: "exchange" },
  // No name tag. It paid a real Coinbase withdrawal (0x82a62dd6…3a26).
  "0x4b5c71082d027d16d2a146465d66f9eec11634f6": { name: "Coinbase", kind: "exchange" },
  // Name tag "Gate 1". 140 payouts in USDC and ETH over about 2 days.
  "0x0d0707963952f2fba59dd06f2b425ace40b492fe": { name: "Gate", kind: "exchange" },
  "0x4200000000000000000000000000000000000010": { name: "the Base bridge", kind: "bridge" },
  // What a bridge deposit calls, with the wallet in its calldata. A real one paid 69.74 ETH (0xcefbf81b…5e5c).
  "0x4200000000000000000000000000000000000007": { name: "the Base bridge", kind: "bridge" },
  "0x09aea4b2242abc8bb4bb78d537a67a245a7bec64": { name: "Across", kind: "bridge" },
  "0xf70da97812cb96acdf810712aa562db8dfa3dbef": { name: "Relay", kind: "bridge" },
  "0x27a16dc786820b16e5c9028b75b99f6f604b5d26": { name: "Stargate", kind: "bridge" },
  // Name tag "NEAR Intents: Treasury". 735 payouts in USDC, ETH and cbBTC over about 2 days.
  "0x2cff890f0378a11913b6129b2e97417a2c302680": { name: "NEAR Intents", kind: "bridge" },
  // Name tag "NEAR Intents: Refill". 513 tiny ETH payouts over about 2 days, for gas.
  "0xbb2f33f73ccc2c74e3fb9bb8eb75241ac15337e0": { name: "NEAR Intents", kind: "bridge" },
  // Merkl's rewards, name tag "Angle Protocol: Distributor". Nobody deposits here, so a claim is never the user's own money
  // coming back. 114 claims from 96 wallets over about 2 days.
  "0x3ef3d8ba38ebe18db133cec108f4d14ce00dd9ae": { name: "Merkl", kind: "reward" },
}

/** Where a mint comes from. Nobody holds this address, so it can't be one of the user's wallets. */
export const MINT_ADDRESS = "0x0000000000000000000000000000000000000000"

export const knownSender = (address: string): KnownSender | null => KNOWN[normalizeAddress(address)] ?? null

/** Whether what a sender sends has no question to ask: everything but an exchange's, whose withdrawals could be anyone's. */
export const isValuedOnArrival = (known: KnownSender | null) => known !== null && known.kind !== "exchange"
