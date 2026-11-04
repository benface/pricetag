// Proving a wallet is yours by signing, so it links without a question. This only checks a signature, and holds no key.

import { recoverMessageAddress } from "viem"
import { linkMessage } from "../src/core/book.ts"

type Recover = (args: { message: string; signature: `0x${string}` }) => Promise<string>

/** Whether `signature` is `address` signing the message that links it to `owner`. A malformed one just isn't. */
export async function verifyLink(owner: string, address: string, signature: string, recover: Recover = recoverMessageAddress): Promise<boolean> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return false
  try {
    const signer = await recover({ message: linkMessage(owner, address), signature: signature as `0x${string}` })
    return signer.toLowerCase() === address.toLowerCase()
  } catch {
    return false
  }
}
