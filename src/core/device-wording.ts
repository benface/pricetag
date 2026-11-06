// What the hardware wallet flow says. Plain words only, and it never asks for anything the device should be keeping to itself.

import type { DevicePrompt } from "./cold.ts"

export const REFUSED_ON_DEVICE = "Refused on the device, so nothing happened."
export const LEDGER_LOCKED = "Unlock your Ledger, then try again."
export const LEDGER_NO_APP = "Open the Ethereum app on your Ledger, then try again. If it isn't there, install it from My Ledger in Ledger Wallet, then quit Ledger Wallet."
export const LEDGER_NOT_CHOSEN = "No Ledger was chosen. If it wasn't in the list, check it's unlocked and Ledger Wallet is closed, then unplug it and plug it back in."
export const LEDGER_BLIND_SIGNING = "Your Ledger can't show this transaction's contents. To sign it, turn on Blind signing in the Ethereum app's settings on the device, then try again. Turn it back off after."
export const LEDGER_BUSY = "Couldn't talk to your Ledger. Close Ledger Wallet if it's open, unplug the device and plug it back in, then try again."
export const KEYSTONE_WRONG_CODE = "That's not the code this was waiting for. Nothing was sent."
export const KEYSTONE_NOT_STANDARD = "That code doesn't include the account this page uses. On your Keystone, choose MetaMask under Connect Software Wallet, and use its standard accounts."

/** What a Ledger needs before a browser can reach it. The Mac app's steps say the same: see `AddSavingsWording`. */
export const LEDGER_READY = [
  "Plug it in with its USB cable, and enter your PIN.",
  "Open the Ethereum app on it. Base uses this app too. If it isn't there, install it from My Ledger in Ledger Wallet.",
  "Quit Ledger Wallet. Only one app can talk to your Ledger at a time.",
] as const
export const LEDGER_NEEDS_CHROMIUM = "Needs Chrome, Brave, Edge or another Chromium browser"
/** What the Ethereum app says for chain 8453. An older version leaves out the network's name. */
export const LEDGER_VERIFY = "Your Ledger should say Verify Base address, then show this. Compare every group, then choose Confirm there."
export const LEDGER_HAND_OFF = "Your Ledger should say Verify Base address, then show this. Compare it with the Mac app, then choose Confirm on your Ledger. If it doesn't match, choose Reject."
export const LEDGER_HANDED_OFF = "✓ Confirmed on your Ledger. Finish in the Mac app, then you can close this page."
export const KEYSTONE_CONNECT = "On your Keystone, open Connect Software Wallet, choose MetaMask, and hold its screen up to your webcam."
/** A Keystone's receive screen says ETH, and Base uses that same address. */
export const KEYSTONE_LOOK = "This page can't reach your Keystone. On its home screen, tap ETH, and find this address under Receive ETH. Use Switch Account if it shows another one. Base uses this same address."
export const LOOK_HANDED_OFF = "Compare it with the Mac app, and finish there."

export const NEVER_ASKED = "This page never asks for your recovery phrase, and nothing should. If anything does, stop."

export const CHECK_ADDRESS_WARNING = "Money sent here is real, and a compromised computer could show you the wrong address. The device's screen is the only one to trust."

export const PROMPTS: Record<DevicePrompt, string> = {
  unlock: "Unlock your device.",
  "open-app": "Allow the Ethereum app to open on your device.",
  "confirm-address": "Check the address on your device, then approve it there.",
  "confirm-transaction": "Check what it says on your device, then approve it there.",
  working: "Talking to your device…",
}

export const WRONG_PUBLISHER = "Only the wallet this arrived in can publish its cost, so nothing was sent."

export const PUBLISH_WARNING = "Anyone can read this, forever. It publicly ties what you paid to this wallet, and it can't be deleted or changed. Saving it in this browser keeps it private."

export const PUBLISH_DETAIL = "It's a transaction from this wallet to itself, so it costs a small network fee and moves nothing else. Your device confirms it."

export const PUBLISH_DEVICE_NOTE = "A Ledger can't read what this says, so it shows only a code, and needs its Blind signing setting on for this. Turn it back off after."

/** Says what went wrong with a Ledger in words, because its errors are status codes. */
export function ledgerMessage(error: unknown): string {
  const { _tag: tag, errorCode } = (error ?? {}) as { _tag?: string; errorCode?: string }
  if (tag === "RefusedByUserDAError" || errorCode === "6985" || errorCode === "5501") return REFUSED_ON_DEVICE
  if (tag === "DeviceLockedError" || errorCode === "5515") return LEDGER_LOCKED
  // The Ethereum app says this for anything with data it can't show, when its blind signing setting is off.
  if (errorCode === "6a80") return LEDGER_BLIND_SIGNING
  if (tag === "UnsupportedApplicationDAError" || errorCode === "6807") return LEDGER_NO_APP
  return LEDGER_BUSY
}

/** Addresses in groups, because nobody really compares 40 characters in one run. */
export const groupAddress = (address: string) => `0x ${address.slice(2).match(/.{1,4}/g)?.join(" ") ?? ""}`

export const ALL_YOURS_DEVICE = "You're looking at all your wallets. Your device's accounts are listed next, and sending says which one it comes from before you sign."
