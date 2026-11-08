import type { CurrencyCode } from "@pricetag/sdk/core"
import { normalizeAddress } from "@pricetag/sdk/core"
import type { WalletResponse } from "../core/api.ts"
import { walletsBehind, type Book } from "../core/book.ts"
import { heldIn, type Held } from "../core/held-units.ts"
import { readResponse } from "../core/read-failure.ts"
import { walletUrl } from "./useWallet.ts"

/** What a wallet holds of an asset, by purchase, with what's moved between it and the user's other wallets. */
export async function readHeld(address: string, asset: string, book: Book, currency: CurrencyCode, rule: string | null, paid: string): Promise<Held> {
  const read = async (one: string) => readResponse<WalletResponse>(await fetch(walletUrl(one, currency, rule, paid)))
  const wallet = await read(address)
  const others = await Promise.all(walletsBehind(book, wallet).filter((one) => one !== normalizeAddress(address)).map(read))
  return heldIn(wallet, others, book, asset)
}
