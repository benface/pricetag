// Linking a browser wallet by signing. Its prompts stay open for as long as someone likes, and the app stays usable behind them.

import { shortHash } from "@pricetag/sdk/core"
import { answerSender, linkMessage, proofOwner, type Book, type BookChange } from "../core/book.ts"
import { jsonPost } from "../core/read-failure.ts"

export type Ethereum = { request(args: { method: string; params?: unknown[] }): Promise<unknown> }

type Verify = (proof: { owner: string; address: string; signature: unknown }) => Promise<boolean>

const verifyOnServer: Verify = async (proof) => {
  const response = await fetch("/api/links/verify", jsonPost(proof))
  return ((await response.json()) as { verified?: boolean }).verified === true
}

/** Asks the wallet to sign, and links it to whatever the book is by then. Says how it went, or null if no wallet was picked. */
export async function linkByProof(ethereum: Ethereum, current: string, latest: () => Book, onChange: (change: BookChange) => void, verify = verifyOnServer): Promise<string | null> {
  try {
    const [address] = (await ethereum.request({ method: "eth_requestAccounts" })) as string[]
    if (!address) return null
    const owner = proofOwner(latest(), address, current)
    const signature = await ethereum.request({ method: "personal_sign", params: [linkMessage(owner, address), address] })
    if (!(await verify({ owner, address, signature }))) return "That signature isn't from this wallet."
    onChange((book) => answerSender(book, null, address, { kind: "mine" }))
    return `Linked ${shortHash(address)}.`
  } catch {
    return "Didn't link it. Nothing changed."
  }
}
