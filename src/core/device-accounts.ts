// The accounts this browser has seen on a device. Choosing one is about keeping money apart, so the point is to find one nothing's
// happened to. They're addresses and where they are on the device, which is all this ever keeps.

import { isAddress, normalizeAddress } from "@pricetag/sdk/core"
import type { ColdAccount } from "./cold.ts"

/** What the chain says about an account. Null when it couldn't be read, which isn't the same as nothing. */
export type AccountActivity = { nonce: number; ethUnits: bigint; tokenCount: number } | null

export type SeenAccount = ColdAccount & { activity: AccountActivity }

export const isFresh = (activity: AccountActivity) => activity !== null && activity.nonce === 0 && activity.ethUnits === 0n && activity.tokenCount === 0

export const hasActivity = (activity: AccountActivity) => activity !== null && !isFresh(activity)

/**
 * Which account to start on. Receiving starts on the first one nothing's happened to, so demo funds stay apart from anything else on
 * the device. Paying for something starts on the first with money in it, because a fresh one has nothing to send.
 */
export function defaultAccount<Account extends SeenAccount>(accounts: readonly Account[], purpose: "receive" | "send"): Account | null {
  const wanted = purpose === "receive" ? accounts.find((a) => isFresh(a.activity)) : accounts.find((a) => a.activity !== null && a.activity.ethUnits > 0n)
  return wanted ?? null
}

/** A device's accounts that belong in the book: the ones in use. A fresh one has nothing to say, and each one is another read. */
export const accountsToLink = (accounts: readonly SeenAccount[], chosen: string | null) => accounts.filter((a) => hasActivity(a.activity) || (chosen !== null && normalizeAddress(a.address) === normalizeAddress(chosen))).map((a) => normalizeAddress(a.address))

/** An account someone checked on the device's own screen. */
export type CheckedAccount = ColdAccount & { deviceName: string; kind: "ledger" | "keystone" | "browser" }

const KEY = "patina.deviceAccounts"

function parseChecked(value: unknown): CheckedAccount | null {
  if (typeof value !== "object" || value === null) return null
  const { address, path, deviceId, deviceName, kind } = value as Record<string, unknown>
  if (typeof address !== "string" || !isAddress(address) || typeof deviceName !== "string") return null
  if (path !== null && typeof path !== "string") return null
  if (kind !== "ledger" && kind !== "keystone" && kind !== "browser") return null
  return { address: normalizeAddress(address), path, deviceName, kind, ...(typeof deviceId === "string" ? { deviceId } : {}) }
}

export function readCheckedAccounts(storage: Pick<Storage, "getItem"> = localStorage): CheckedAccount[] {
  try {
    const stored: unknown = JSON.parse(storage.getItem(KEY) ?? "[]")
    return Array.isArray(stored) ? stored.flatMap((value) => parseChecked(value) ?? []) : []
  } catch {
    return []
  }
}

export function rememberCheckedAccount(account: CheckedAccount, storage: Pick<Storage, "getItem" | "setItem"> = localStorage): CheckedAccount[] {
  const others = readCheckedAccounts(storage).filter((other) => other.address !== normalizeAddress(account.address))
  const accounts = [...others, { ...account, address: normalizeAddress(account.address) }]
  storage.setItem(KEY, JSON.stringify(accounts))
  return accounts
}
