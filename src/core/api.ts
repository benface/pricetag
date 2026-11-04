// What the server sends its clients. The browser runs the fold itself, because cost is personal.
// Clients that can't run it, like the Mac app, read the portfolio it computes instead.

import type { Head, LatestPrice, LatestPrices, Method, PnlPoint, PnlStatus, PositionValues, PricedLeg, ReferenceRow, Totals } from "@pricetag/sdk/core"

export type { Head, PnlStatus }

export type Mode = "demo" | "raw" | "dataset"

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

export type PortfolioPosition = {
  asset: string
  decimals: number
  /** A word about what the position folds together, like "incl. WETH". */
  note: string | null
  price: LatestPrice | null
  values: PositionValues
  /** Realized plus unrealized. null when either is unknown on what's still held, or units left that we never saw arrive. */
  pnlUsdMicros: string | null
  shortfallQty: string
  legCount: number
}

/** A wallet's holdings, cost and PnL, already folded by one method. */
export type PortfolioResponse = {
  address: string
  mode: Mode
  method: Method
  coverage: WalletResponse["coverage"]
  /** How many tokens the allowlist tracks, on top of ETH. Anything off it isn't counted. */
  trackedTokens: number
  latest: Head
  /** Whether what's read has reached the chain. `behindBlocks` is 0 until it's far enough behind to say so. */
  progress: { started: boolean; behindBlocks: number }
  gasUnknownTxs: string[]
  positions: PortfolioPosition[]
  totals: Totals
  pnlStatus: PnlStatus
  points: PnlPoint[]
}

/** One number's explanation: how it's worked out, and the legs behind it, newest first. */
export type ExplanationResponse = {
  title: string
  value: string | null
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
  priceUsdMicros: string | null
  priceSource: PricedLeg["priceSource"]
  priceNote: string | null
  costLabel: PricedLeg["costLabel"]
  blockNum: number
  timestamp: string
  txHash: string
  /** What this leg did to its position, in words. */
  effect: string
  /** The rows this leg nets together, in words, or null when it's just one. */
  netting: string | null
}

/** A derived table is normally a block or two behind the chain. More than this is worth saying out loud. */
const BEHIND_BLOCKS = 5

type Progress = Pick<WalletResponse, "coverage" | "latest">

export const hasStarted = ({ coverage }: Progress) => coverage.toBlock >= coverage.fromBlock
export const isBehind = ({ coverage, latest }: Progress) => latest.blockNum - coverage.toBlock > BEHIND_BLOCKS
