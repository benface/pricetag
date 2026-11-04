// What the server sends its clients. The browser runs the fold itself, because cost is personal.
// Clients that can't run it, like the Mac app, read the portfolio it computes instead.

import type { Method, PositionValues } from "./fold.ts"
import type { PricedLeg, ReferenceRow } from "./legs.ts"
import type { CostNote } from "./notes.ts"
import type { Estimates, LatestPrice, LatestPrices, PnlPoint, PnlStatus, Totals } from "./portfolio.ts"
import type { BalanceSnapshot, Reconciliation } from "./reconcile.ts"
import type { Meter, Question } from "./resolve.ts"

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
  /** Onchain balances at `coverage.toBlock`, as read. An asset missing from them is in `unreadBalances`. Null when the whole read failed. */
  balances: BalanceSnapshot | null
  /** Assets whose balance before `fromBlock` couldn't be read, so they can't be compared yet. */
  openingUnread: string[]
  /** The last balance read for each asset in `unreadBalances` that has one. */
  lastBalances: Record<string, { blockNum: number; amount: string }>
  /** Assets with no balance read at `coverage.toBlock`, which isn't the same as holding none. Empty until reads start. */
  unreadBalances: string[]
  /** Costs this wallet published itself, from its own zero-value transactions to itself. */
  notes: CostNote[]
  /** Whether market prices were read successfully, so a token without one really has no market. */
  marketChecked: boolean
  /** Tokens off the allowlist that moved here, which have no position or price. */
  unlistedTokens: string[]
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
  reconciliation: Reconciliation | null
  /** No price, in any form, at any block. Often spam. It's listed apart, and can't affect PnL. */
  noMarket: boolean
  estimates: Estimates
  /** Its cost is unknown, and answering a question could change that. */
  resolvable: boolean
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
  l1FeeUnknownTxs: string[]
  openingUnread: string[]
  /** Assets with no position because nothing could be read about them, which isn't the same as holding none. */
  unreadAssets: string[]
  positions: PortfolioPosition[]
  totals: Totals
  pnlStatus: PnlStatus
  points: PnlPoint[]
  /** What's left to ask, most useful first. */
  questions: Question[]
  meter: Meter
  /** Linked wallets that aren't read yet, so what came from them shows as unresolved for now. */
  linkedReading: string[]
  unlistedTokens: number
  marketChecked: boolean
}

/** What the headline would say with a different set of answers, before any of them is final. */
export type BookPreview = {
  pnlUsdMicros: string | null
  pnlStatus: PnlStatus
  estimatedUsdMicros: string
  unresolvedUsdMicros: string
  open: number
  /** A wallet these answers link hasn't been read yet, so this can't say yet. */
  pending: boolean
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
  /** Its cost or proceeds rest on an estimate. */
  estimated: boolean
  /** Some of what arrived has a known cost and some doesn't. */
  partlyUnknown: boolean
  blockNum: number
  timestamp: string
  txHash: string
  /** What the wallet already held before the first block read. It isn't a transaction, so `txHash` is empty. */
  opening: boolean
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

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

export function isAddress(value: string): boolean {
  return ADDRESS.test(value)
}
