// What the server sends the browser. The browser runs the fold itself, because cost is personal.

import type { PricedLeg, ReferenceRow } from "./legs.ts"
import type { LatestPrices } from "./portfolio.ts"
import type { BalanceSnapshot } from "./reconcile.ts"

export type Mode = "demo" | "raw" | "dataset"

export type Head = { blockNum: number; timestamp: string }

export type WalletResponse = {
  address: string
  mode: Mode
  /**
   * The blocks read. What the wallet held before `fromBlock` comes from the chain, as opening legs with an unknown cost.
   * `toBlock` can be behind `latest` while a derived table catches up, and is below `fromBlock` until it starts.
   */
  coverage: { fromBlock: number; toBlock: number }
  legs: PricedLeg[]
  references: ReferenceRow[]
  prices: LatestPrices
  latest: Head
  /** Transactions this wallet sent whose gas couldn't be worked out, so ETH is overstated by that much. */
  gasUnknownTxs: string[]
  /** Transactions this wallet sent whose L1 fee couldn't be read yet. */
  l1FeeUnknownTxs: string[]
  /** Onchain balances at `coverage.toBlock`, or null unless they and the opening balances were both read. */
  balances: BalanceSnapshot | null
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

export function isAddress(value: string): boolean {
  return ADDRESS.test(value)
}
