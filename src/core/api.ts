// What the server sends its clients. The browser runs the fold itself, because cost is personal.
// Clients that can't run it, like the Mac app, read the portfolio it computes instead.

import type { BalanceSnapshot, Head, LatestPrice, LatestPrices, Method, PnlPoint, PnlStatus, PositionValues, PricedLeg, Reconciliation, ReferenceRow, Totals } from "@pricetag/sdk/core"
import type { Estimates } from "@pricetag/sdk/core"
import type { CurrencyCode, Rates } from "./currency.ts"
import type { CostNote } from "./notes.ts"
import type { Meter, Question } from "./resolve.ts"
import type { TaxCountryCode, TaxScope } from "./tax.ts"

export type { Head, PnlStatus }

export type Mode = "demo" | "raw" | "dataset"

/** A token off the allowlist that this wallet holds. It has no trusted price and may be malicious, so nothing ever calls it. */
export type UnlistedToken = { token: string; transfers: number }

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
  /** Transactions this wallet sent whose gas couldn't be worked out, so the fees are too low, and ETH worked out from its legs is too high. */
  gasUnknownTxs: string[]
  /** The pricing rule this was read through, when the server has more than one. */
  rule?: string
  /** Set when that rule isn't the default, because the prices it shows aren't what their labels alone would say. */
  ruleNote?: string | null
  unlisted: UnlistedToken[]
  /** What this response is meant to be shown in. Its money is always USD, and `viewWallet` converts it. */
  currency: CurrencyCode
  /** Null for USD. */
  rates: Rates | null
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
}

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
  /** No price, in any form, at any block. Often spam. It's listed apart, and can't affect PnL. */
  noMarket: boolean
  estimates: Estimates
  /** Its cost is unknown, and answering a question could change that. */
  resolvable: boolean
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
  /** The pricing rule this was read through, or null when the server has only one. */
  rule: string | null
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
  /** Every transaction that took something from this wallet or that it paid gas for. A hot wallet compares these with what it signed. */
  outgoingTxs: string[]
  unlisted: UnlistedToken[]
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
  /** Linked wallets whose last read failed. It's tried again with each request, and what they sent stays unresolved or out of date until it works. */
  linkedFailed: string[]
  marketChecked: boolean
}

/** What the headline would say with a different set of answers, before any of them is final. */
export type BookPreview = {
  pnlMicros: string | null
  pnlStatus: PnlStatus
  estimatedMicros: string
  unresolvedMicros: string
  open: number
  /** A wallet these answers link hasn't been read yet, so this can't say yet. */
  pending: boolean
  /** A wallet these answers link couldn't be read. */
  failed: boolean
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
  /** What this leg was in USD and the rate that converted it, in words, or null when it's in USD. */
  conversion: string | null
}

/** A tax report, ready to save. See `src/core/tax.ts`. */
export type TaxReportResponse = {
  /** The one asked about comes first. */
  wallets: string[]
  country: TaxCountryCode
  method: Method
  scope: TaxScope
  currency: CurrencyCode
  /** What this country calls for, so a client can tell an override. */
  defaults: { method: Method; scope: TaxScope }
  rowCount: number
  unresolvedCount: number
  estimatedCount: number
  /** Only rows whose gain is known, and null when none is. Read it next to `unresolvedCount`. */
  gainMicros: string | null
  disclaimer: string
  /** What's wrong with this file in particular. */
  warnings: string[]
  /** What this report never does, and what it covers. */
  notes: string[]
  filename: string
  csv: string
}

/** A derived table is normally a block or two behind the chain. More than this is worth saying out loud. */
const BEHIND_BLOCKS = 5

type Progress = Pick<WalletResponse, "coverage" | "latest">

export const hasStarted = ({ coverage }: Progress) => coverage.toBlock >= coverage.fromBlock
export const isBehind = ({ coverage, latest }: Progress) => latest.blockNum - coverage.toBlock > BEHIND_BLOCKS

/** A dataset behind a number, by name and manifest hash. The hash is null when it couldn't be read, and is never guessed. */
export type ProofDataset = { title: string; name: string; hash: string | null }

export type ProofLink = { title: string; url: string }

/** What's behind one leg's price. All of it is in words, because clients only show it. */
export type ProofResponse = {
  blockNum: number
  txHash: string
  source: string[]
  movements: string[]
  links: ProofLink[]
  datasets: ProofDataset[]
  /** What checking the block does and doesn't show for this leg. */
  scope: string[]
  /** Why the block can't be checked, or null when it can. */
  unavailable: string | null
}

export type CheckStatus = "passed" | "failed" | "unchecked"

export type ProofCheck = { title: string; status: CheckStatus; detail: string }

/** The block's commitments recomputed from what Amp stored, and whether this leg is in them. `status` is the worst of `checks`. */
export type VerificationResponse = {
  blockNum: number
  blockHash: string
  status: CheckStatus
  summary: string
  checks: ProofCheck[]
}
