// What the server sends its clients. The browser runs the fold itself, because cost is personal.
// Clients that can't run it, like the Mac app, read the portfolio it computes instead.

import { hasStarted, msBetweenBlocks, type CurrencyCode, type Head, type LatestPrice, type Method, type Mode, type PnlPoint, type PnlStatus, type PositionValues, type PricedLeg, type Reconciliation, type Totals, type OtherToken, type UnlistedToken, type WalletData } from "@pricetag/sdk/core"
import type { Estimates, HoldComparison } from "@pricetag/sdk/core"
import type { TransactionFacts } from "./activity.ts"
import type { Meter, Question } from "./resolve.ts"
import type { TaxForm } from "./tax-forms.ts"
import type { TaxCountryCode, TaxPreviewRow, TaxScope } from "./tax.ts"

export { hasStarted }

/** A provider's order, as it says. What it doesn't say, or says in a way that can't be read, is null. */
export type OnrampOrder = {
  provider: "coinbase"
  id: string
  status: "pending" | "succeeded" | "failed"
  failure: "payment" | "delivery" | null
  asset: string | null
  units: string | null
  wallet: string | null
  network: string | null
  txHash: string | null
  /** The block `txHash` landed in, once that can be read. */
  blockNum: number | null
  /** Everything paid, fees included. */
  cost: { micros: string; currency: CurrencyCode } | null
  costUsdMicros: string | null
  /** The currency it was paid in, when that's why `cost` is null: there's no rate for it. */
  paidIn: string | null
}
export type { Head, Mode, PnlStatus }

export type { UnlistedToken }

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
  /** Unrealized over the cost of what's held, in basis points. null when either is unknown, or it cost nothing. Never 0 for unknown. */
  returnBps: string | null
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

/** A point on the PnL chart, and what its transaction did. The last point has no transaction, so no summary and no facts. */
export type BookPoint = PnlPoint & { summary: string | null } & TransactionFacts

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
  /** Tokens off the allowlist this wallet holds. They have no price, and they're in no total. See `OtherToken`. */
  otherTokens: OtherToken[]
  otherTokensLeftOut: number
  l1FeeUnknownTxs: string[]
  openingUnread: string[]
  /** Assets with no position because nothing could be read about them, which isn't the same as holding none. */
  unreadAssets: string[]
  positions: PortfolioPosition[]
  totals: Totals
  pnlStatus: PnlStatus
  points: BookPoint[]
  /** What this wallet made next to what simply holding ETH would have. */
  holdComparison: HoldComparison
  /** What's left to ask, most useful first. */
  questions: Question[]
  meter: Meter
  /** Linked wallets that aren't read yet, so what came from them shows as unresolved for now. */
  linkedReading: string[]
  /** Linked wallets whose last read failed. It's tried again with each request, and what they sent stays unresolved or out of date until it works. */
  linkedFailed: string[]
  /** Other wallets' history that can't be confirmed, which leaves what they sent here with an unknown cost. */
  withheld: { wallet: string; asset: string }[]
  /** What became of each purchase in the book, among the wallets read. */
  purchases: { order: string; state: "recorded" | "waiting" | "unmatched" }[]
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
  /** Where to read the proof of the current price this number rests on, when that price comes from Chainlink. */
  priceProof?: { asset: string; price: string; wallet: string } | null
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
  /** Who says what was paid, when it isn't the chain. */
  costSource: string | null
  /** Its cost or proceeds rest on an estimate. */
  estimated: boolean
  /** Some of what arrived has a known cost and some doesn't. */
  partlyUnknown: boolean
  blockNum: number
  timestamp: string
  txHash: string
  /** What the wallet already held before the first block read. It isn't a transaction, so `txHash` is empty. */
  opening: boolean
  /** What this leg did, in one plain sentence led by its amount in money. */
  summary: string
  /** What about it isn't known, in words, or null when nothing is. */
  unknown: string | null
  /** Answering a question about this asset could fix what isn't known. */
  answerable: boolean
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
  /** The tax year listed, in the country's time zone (UK time for the UK, UTC otherwise), named for the calendar year it starts in, or null for everything. */
  year: number | null
  /** Every tax year with some history, newest first. */
  years: number[]
  /** What each of `years` is called where it's filed, like 2025, or 2025 to 2026 in the UK. */
  yearLabels: string[]
  /** What `year` is called, or null for everything. */
  yearLabel: string | null
  /** When `year`'s history isn't all here, why, in a sentence. It's also the first warning. */
  partialYear: string | null
  rowCount: number
  /** Sales, fees and sends, each counted once, where `rowCount` counts one split into a known and an unknown part twice. */
  soldCount: number
  feeCount: number
  sentCount: number
  /** What arrived from other addresses that may be income, which the file lists after the sales. Not in `rowCount`. */
  receivedCount: number
  /** Of those, how many have an unknown gain, in whole or in part. `unresolvedCount` counts the file's rows instead. */
  unknownCount: number
  /** The wallets with something unknown, in the order of `wallets`, so a client can open the right one's questions. */
  unknownWallets: string[]
  unresolvedCount: number
  estimatedCount: number
  /** Rows with a known gain that partly rests on a cost the user gave. */
  selfReportedCount: number
  /** Only rows whose gain is known, and null when none is. Read it next to `unresolvedCount`. */
  gainMicros: string | null
  disclaimer: string
  /** What's wrong with this file in particular. */
  warnings: string[]
  /** What this report never does, and what it covers. */
  notes: string[]
  /** The first few rows, oldest first. */
  preview: TaxPreviewRow[]
  filename: string
  csv: string
  /** The same rows in the shape of the country's own form, like Form 8949 or Schedule 3. */
  form: TaxForm | null
}

/**
 * A derived table is normally about 5 seconds behind the chain, and one read in a dozen lands over 10, up to 17 when measured. More than this is worth saying out loud.
 * A table that's stopped falls further behind with every second, so it still gets past this quickly.
 */
const BEHIND_MS = 30_000

export const isBehind = ({ coverage, latest }: Pick<WalletResponse, "coverage" | "latest">) => msBetweenBlocks(coverage.toBlock, latest.blockNum) > BEHIND_MS

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
  /** What a current price's proof describes, which checking it has to name. Only set when it has an update behind it. */
  revision?: string
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

/** One approval a wallet gave that still lets someone spend from it. */
export type ApprovalView = {
  /** Its kind, token and spender, which is what makes it this approval. */
  id: string
  kind: "token" | "permit2" | "collection"
  /** The token, or for a collection, its contract. */
  token: string
  /** Only for a tracked token. Anything else can call itself anything, so it's never named. */
  symbol: string | null
  decimals: number | null
  spender: string
  /** Whose contract it is, when it's a well-known one. That says who, not that it's safe. */
  spenderName: string | null
  /** In the token's smallest units. Null for a collection, which allows every NFT in it. */
  amount: string | null
  /** The amount in the token, when it's tracked and not unlimited. */
  amountText: string | null
  unlimited: boolean
  /** When a Permit2 allowance stops working. Null when it never will, including an expiry past the year 9999. */
  expiresAt: string | null
  /** The newest transaction that set it, when the history has it. */
  grantedTx: string | null
  grantedBlock: number | null
  grantedAt: string | null
  /** In the wallet's history, or only found by checking well-known apps, so it may be older than the history. */
  found: "history" | "known-spender"
}

export type ApprovalsResponse = {
  mode: Mode
  address: string
  /** The block every approval here was checked at. */
  checkedAt: Head
  /** The blocks searched for approval events, and the dataset they came from. */
  history: { fromBlock: number; throughBlock: number; dataset: string }
  /** Where this list comes from, line by line, like a price's proof. */
  source: string[]
  approvals: ApprovalView[]
  /** Approvals in the history whose contract didn't answer, so what they allow isn't known. */
  unreadable: number
}
