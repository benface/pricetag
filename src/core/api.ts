// What the server sends the browser. The browser runs the fold itself, because cost is personal.

import type { PricedLeg, ReferenceRow } from "./legs.ts"
import type { LatestPrices } from "./portfolio.ts"

export type Mode = "demo" | "raw" | "dataset"

export type Head = { blockNum: number; timestamp: string }

export type WalletResponse = {
  address: string
  mode: Mode
  /**
   * The blocks read. Anything before `fromBlock` isn't seen, so balances are only what moved since then.
   * `toBlock` can be behind `latest` while a derived table catches up, and is below `fromBlock` until it starts.
   */
  coverage: { fromBlock: number; toBlock: number }
  legs: PricedLeg[]
  references: ReferenceRow[]
  prices: LatestPrices
  latest: Head
  /** Transactions this wallet sent whose gas couldn't be worked out, so ETH is overstated by that much. */
  gasUnknownTxs: string[]
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

export function isAddress(value: string): boolean {
  return ADDRESS.test(value)
}
