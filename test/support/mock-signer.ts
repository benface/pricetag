// A stand-in for a hardware wallet, for tests only. It lives outside `src`, so nothing the app builds can reach it, and `cold.test.ts`
// checks that. It holds no key: its signatures are two fixed numbers, and the account they turn out to belong to is worked out from them.

import { keccak256, recoverAddress, serializeTransaction, type Hex, type TransactionSerializable } from "viem"
import type { AddressCheck, ColdAccount, DeviceSigner, Signature } from "../../src/core/cold.ts"

// `r` has to be the x of a point on the curve for anything to recover from it, so this is the curve's own starting point.
export const FAKE_SIGNATURE: Signature = { r: "0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", s: `0x${"22".repeat(32)}`, yParity: 0 }

/** The account `FAKE_SIGNATURE` recovers to for this transaction. Nobody has its key, and on a local chain it can still send. */
export const accountSigningWithFake = (transaction: TransactionSerializable): Promise<Hex> => recoverAddress({ hash: keccak256(serializeTransaction(transaction)), signature: FAKE_SIGNATURE })

export type MockSigner = DeviceSigner & {
  /** Every transaction a device was asked to sign, unsigned. */
  asked: Hex[]
  shown: string[]
}

export function mockSigner(accounts: readonly ColdAccount[], { refuse = false, signature = FAKE_SIGNATURE, check = "shown-on-device" as AddressCheck } = {}): MockSigner {
  const asked: Hex[] = []
  const shown: string[] = []
  return {
    kind: "ledger",
    name: "Mock device",
    asked,
    shown,
    listAccounts: async (start, count) => accounts.slice(start, start + count),
    async showAddress(account) {
      if (refuse) throw new Error("Refused on the device.")
      shown.push(account.address)
      return check
    },
    async signTransaction(_account, unsigned) {
      asked.push(unsigned)
      if (refuse) throw new Error("Refused on the device.")
      return signature
    },
    close: async () => {},
  }
}
