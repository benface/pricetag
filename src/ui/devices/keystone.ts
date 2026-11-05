// A Keystone over QR codes. It never connects to the computer: the page reads its screen with the webcam, and it reads the page's.
// This module loads only when someone picks Keystone, and the codes themselves are drawn in `KeystoneCodes.tsx`.

import "./node-globals.ts"
import { Buffer } from "buffer"
import { KeystoneEthereumSDK, KeystoneSDK, UR, URType } from "@keystonehq/keystone-sdk"
import { BASE_CHAIN_ID, signatureFromHex, type ColdAccount, type DeviceSigner } from "../../core/cold.ts"
import { keystoneAccounts, standardKey, type KeystoneKey } from "../../core/keystone-accounts.ts"
import { KEYSTONE_NOT_STANDARD, KEYSTONE_WRONG_CODE } from "../../core/device-wording.ts"

/** A code off the device, as the scanner gives it. */
export type ScannedCode = { type: string; cbor: string }

/** The code to show, and what the device shows back. The panel does the showing and the scanning. */
export type ExchangeCodes = (code: ScannedCode, expected: string) => Promise<ScannedCode>

export const CONNECT_TYPES = [URType.CryptoHDKey, URType.CryptoMultiAccounts]

const toUR = ({ type, cbor }: ScannedCode) => new UR(Buffer.from(cbor, "hex"), type)

/** The SDK's errors are about its internals, and a code that can't be read only means one thing here. */
function parsed<Result>(read: () => Result, problem: string): Result {
  try {
    return read()
  } catch {
    throw new Error(problem)
  }
}

/** The account key and device ID in a Keystone's "connect" code. */
function readConnectCode(code: ScannedCode): { key: KeystoneKey; deviceId: string } {
  const sdk = new KeystoneSDK()
  const ur = toUR(code)
  if (code.type === URType.CryptoMultiAccounts) {
    const { masterFingerprint, keys } = parsed(() => sdk.parseMultiAccounts(ur), KEYSTONE_NOT_STANDARD)
    const key = standardKey(keys)
    if (!key) throw new Error(KEYSTONE_NOT_STANDARD)
    return { key, deviceId: masterFingerprint }
  }
  if (code.type !== URType.CryptoHDKey) throw new Error(KEYSTONE_WRONG_CODE)
  const account = parsed(() => sdk.parseHDKey(ur), KEYSTONE_NOT_STANDARD)
  const key = standardKey([account])
  if (!key || !account.xfp) throw new Error(KEYSTONE_NOT_STANDARD)
  return { key, deviceId: account.xfp }
}

export function connectKeystone(code: ScannedCode, exchange: ExchangeCodes): DeviceSigner {
  const { key, deviceId } = readConnectCode(code)
  return {
    kind: "keystone",
    name: "Keystone",
    listAccounts: async (start, count) => keystoneAccounts(key, deviceId, start, count),
    // Nothing can reach the device to put it on its screen, so the person looks it up there.
    showAddress: async () => "look-on-device",
    async signTransaction(account: ColdAccount, unsigned, onPrompt) {
      if (!account.path || !account.deviceId) throw new Error(KEYSTONE_WRONG_CODE)
      const requestId = crypto.randomUUID()
      const request = new KeystoneSDK().eth.generateSignRequest({
        requestId,
        signData: unsigned.slice(2),
        dataType: KeystoneEthereumSDK.DataType.typedTransaction,
        path: `m/${account.path}`,
        xfp: account.deviceId,
        chainId: BASE_CHAIN_ID,
        origin: "Patina",
      })
      onPrompt("confirm-transaction")
      const answer = await exchange({ type: request.type, cbor: request.cbor.toString("hex") }, URType.EthSignature)
      if (answer.type !== URType.EthSignature) throw new Error(KEYSTONE_WRONG_CODE)
      const signed = parsed(() => new KeystoneSDK().eth.parseSignature(toUR(answer)), KEYSTONE_WRONG_CODE)
      // A code from another request would sign something else. The account checks whose signature it is, too.
      if (signed.requestId !== requestId) throw new Error(KEYSTONE_WRONG_CODE)
      return signatureFromHex(signed.signature)
    },
    close: async () => {},
  }
}
