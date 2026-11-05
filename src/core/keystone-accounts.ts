// Working out a Keystone's accounts from what it shows when it's connected: public keys, with no way back to anything private. Only
// the standard path is covered, which is the one the device's own software-wallet screens use: m/44'/60'/0'/0/n.

import { secp256k1 } from "@noble/curves/secp256k1"
import { bytesToHex, hexToBytes, type Hex } from "viem"
import { HDKey, publicKeyToAddress } from "viem/accounts"
import type { ColdAccount } from "./cold.ts"

/** What the SDK parses from the device's code. */
export type KeystoneKey = { chain: string; path: string; publicKey: string; chainCode: string; xfp?: string }

const ACCOUNT_PATH = "m/44'/60'/0'"

/** The address of a public key in its short form. */
export function addressOfPublicKey(publicKey: Uint8Array): string {
  return publicKeyToAddress(bytesToHex(secp256k1.ProjectivePoint.fromHex(publicKey).toRawBytes(false))).toLowerCase()
}

/** The public key one unhardened step below another, which is what public keys can do by themselves. */
export function childPublicKey(publicKey: Uint8Array, chainCode: Uint8Array, steps: readonly number[]): Uint8Array {
  let key = new HDKey({ publicKey, chainCode })
  for (const step of steps) key = key.deriveChild(step)
  if (!key.publicKey) throw new Error("That key can't be followed.")
  return key.publicKey
}

const bytes = (hex: string) => hexToBytes((hex.startsWith("0x") ? hex : `0x${hex}`) as Hex)

/** The key this page can use out of what the device offered, or null if there's none. */
export function standardKey(keys: readonly KeystoneKey[]): KeystoneKey | null {
  return keys.find((key) => key.path === ACCOUNT_PATH && key.chainCode.length > 0) ?? null
}

export function keystoneAccounts(key: KeystoneKey, deviceId: string, start: number, count: number): ColdAccount[] {
  return Array.from({ length: count }, (_, i) => {
    const index = start + i
    return { address: addressOfPublicKey(childPublicKey(bytes(key.publicKey), bytes(key.chainCode), [0, index])), path: `44'/60'/0'/0/${index}`, deviceId }
  })
}
