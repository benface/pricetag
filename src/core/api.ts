// What the server sends its clients. The browser runs the fold itself, because cost is personal.
// Clients that can't run it, like the Mac app, read the portfolio it computes instead.

import { hasStarted, type CurrencyCode, type Head, type LatestPrice, type Method, type Mode, type PnlPoint, type PnlStatus, type PositionValues, type PricedLeg, type Reconciliation, type Totals, type WalletData } from "@pricetag/sdk/core"

export { hasStarted }
export type { Head, Mode, PnlStatus }

export type WalletResponse = WalletData

export type PortfolioPosition = {
  asset: string
  decimals: number
  /** A word about what the position folds together, like "incl. WETH". */
  note: string | null
  price: LatestPrice | null
  values: PositionValues
  /** Realized plus unrealized. null when either is unknown on what's still held, or units left that we never saw arrive. */
  pnlMicros: string | null
  shortfallQty: string
  legCount: number
  reconciliation: Reconciliation | null
}

/** How a portfolio's money got out of USD. */
export type PortfolioExchange = {
  /** Where the rates came from, in words. */
  source: string
  /** What one USD buys now, or null when there's no current rate, so nothing held has a current value. */
  latestRateMicros: string | null
  /** Transactions with an amount that had no rate at its block, so that amount is unavailable. */
  missingRateTxs: string[]
}

/** A wallet's holdings, cost and PnL, already folded by one method, in one currency. */
export type PortfolioResponse = {
  address: string
  mode: Mode
  method: Method
  currency: CurrencyCode
  /** Null for USD. */
  exchange: PortfolioExchange | null
  coverage: WalletResponse["coverage"]
  /** How many tokens the allowlist tracks, on top of ETH. Anything off it isn't counted. */
  trackedTokens: number
  latest: Head
  /** Whether what's read has reached the chain. `behindBlocks` is 0 until it's far enough behind to say so. */
  progress: { started: boolean; behindBlocks: number }
  gasUnknownTxs: string[]
  l1FeeUnknownTxs: string[]
  openingUnread: string[]
  /** Assets with no position because nothing could be read about them, which isn't the same as holding none. */
  unreadAssets: string[]
  positions: PortfolioPosition[]
  totals: Totals
  pnlStatus: PnlStatus
  points: PnlPoint[]
}

/** One number's explanation: how it's worked out, and the legs behind it, newest first. */
export type ExplanationResponse = {
  currency: CurrencyCode
  title: string
  value: string | null
  /** The same number in USD, when that isn't what `value` is in. */
  sourceValue: string | null
  lines: string[]
  /** All of them, which can be more than `legs` holds. */
  legCount: number
  legs: ExplanationLeg[]
}

export type ExplanationLeg = {
  id: string
  asset: string
  delta: string
  decimals: number
  kind: PricedLeg["kind"]
  priceMicros: string | null
  priceSource: PricedLeg["priceSource"]
  priceNote: string | null
  costLabel: PricedLeg["costLabel"]
  blockNum: number
  timestamp: string
  txHash: string
  /** What the wallet already held before the first block read. It isn't a transaction, so `txHash` is empty. */
  opening: boolean
  /** What this leg did to its position, in words. */
  effect: string
  /** The rows this leg nets together, in words, or null when it's just one. */
  netting: string | null
  /** What this leg was in USD and the rate that converted it, in words, or null when it's in USD. */
  conversion: string | null
}

/** A derived table is normally a block or two behind the chain. More than this is worth saying out loud. */
const BEHIND_BLOCKS = 5

export const isBehind = ({ coverage, latest }: Pick<WalletResponse, "coverage" | "latest">) => latest.blockNum - coverage.toBlock > BEHIND_BLOCKS
