// What's read about a wallet, and the one way it becomes numbers, so the browser, the app's server and the SDK can't disagree.
// Pure, like the rest of core. `wallets.ts` is what reads it, through Amp.

import { viewWallet, type CurrencyCode, type PaidRates, type Rates, type WalletView } from "./currency.ts"
import type { Method } from "./fold.ts"
import { compareWithHoldingEth, type HoldComparison } from "./hold.ts"
import type { PricedLeg, Reference, UnseenEth } from "./legs.ts"
import type { MarketMarks } from "./market.ts"
import type { OtherToken } from "./other-tokens.ts"
import type { CostNote } from "./notes.ts"
import { foldPositions, pnlOverTime, pnlStatus, sumTotals, unconfirmedAssets, unreadAssets, type Head, type LatestPrices, type PnlPoint, type PnlStatus, type Position, type Totals } from "./portfolio.ts"
import type { BalanceSnapshot } from "./reconcile.ts"

export type Mode = "demo" | "raw" | "dataset"

/** A token off the allowlist that this wallet holds. It has no trusted price and may be malicious, so nothing ever sends it. Its only use is knowing a key isn't empty. */
export type UnlistedToken = { token: string; transfers: number }

/** Everything read about a wallet, before any method folds it. The app's server sends this to the browser as is. */
export type WalletData = {
  address: string
  mode: Mode
  /**
   * The blocks read. What the wallet held before `fromBlock` comes from the chain, as opening legs with an unknown cost.
   * `toBlock` can be behind `latest` while a derived table catches up, and is below `fromBlock` until it starts.
   */
  coverage: { fromBlock: number; toBlock: number }
  legs: PricedLeg[]
  references: Reference[]
  prices: LatestPrices
  latest: Head
  /** Transactions this wallet sent whose gas couldn't be worked out, so the fees are too low, and ETH worked out from its legs is too high. */
  gasUnknownTxs: string[]
  /** The blocks they're in, since one of them can have no legs to tell from. */
  gasUnknownBlocks: number[]
  /** The pricing rule this was read through, when the server has more than one. */
  rule?: string
  /** Set when that rule isn't the default, because the prices it shows aren't what their labels alone would say. */
  ruleNote?: string | null
  unlisted: UnlistedToken[]
  /** The same tokens with what the chain says about them, which is only for showing. Nothing adds them to a total or moves them. Empty for a wallet read as of a fixed block. */
  otherTokens: OtherToken[]
  /** Past the limit, moved through this wallet and not read at all. */
  otherTokensLeftOut: number
  /** What this is meant to be shown in. Its money is always USD, and `viewWallet` converts it. */
  currency: CurrencyCode
  /** Null for USD. */
  rates: Rates | null
  /** Only when a request's purchases were paid in a currency other than this one and USD. */
  paidRates?: PaidRates
  /** Transactions this wallet sent whose L1 fee couldn't be read yet. */
  l1FeeUnknownTxs: string[]
  /** Onchain balances at `coverage.toBlock`, as read. An asset missing from them is in `unreadBalances`. Null when the whole read failed. */
  balances: BalanceSnapshot | null
  /** Assets whose balance before `fromBlock` couldn't be read, so they can't be compared yet. */
  openingUnread: string[]
  /** The last balance read for each asset in `unreadBalances` that has one. */
  lastBalances: Record<string, { blockNum: number; amount: string }>
  /** The last ETH balance read with everything up to it known, every fee and claim. Something that can't be read yet says nothing about what came before it. */
  lastCheckableEth: { blockNum: number; amount: string } | null
  /** Assets with no balance read at `coverage.toBlock`, which isn't the same as holding none. Empty until reads start. */
  unreadBalances: string[]
  /** Where ETH arrived that no row explains, with the transactions that took a token from this wallet there. */
  unseenEth: UnseenEth[]
  /** Costs this wallet published itself, from its own zero-value transactions to itself. */
  notes: CostNote[]
  /** Whether market prices were read successfully, so a token without one really has no market. */
  marketChecked: boolean
  /** What this wallet's tokens the dataset has no oracle reads for were worth at the blocks of its transactions, by their feed or else their market, for a chart. Some can still be unread. */
  marketMarks: MarketMarks
  /**
   * Oracle reads at evenly spread blocks with no transaction in them, for a chart. A block whose read hasn't worked yet has
   * empty answers, because it's still somewhere a chart needs a price. Left out when nobody asked for them.
   */
  priceSamples?: Reference[]
}

export const hasStarted = ({ coverage }: Pick<WalletData, "coverage">) => coverage.toBlock >= coverage.fromBlock

export type FoldedWallet = {
  /** The wallet in its currency, which is what everything else here was folded from. */
  view: WalletView
  positions: Position[]
  /** Assets with no position because nothing could be read about them, which isn't the same as holding none. */
  unreadAssets: string[]
  totals: Totals
  /** Whether `totals.pnlMicros` can be read as the wallet's PnL. */
  pnlStatus: PnlStatus
  /** PnL after each transaction, for a chart. */
  points: PnlPoint[]
  /** What this wallet made next to what simply holding ETH would have. */
  holdComparison: HoldComparison
}

/** With nothing read, there's no sum at all. Adding up no legs would otherwise say $0. */
const noTotals = (): Totals => ({ ...sumTotals([]), valueMicros: null, realizedMicros: null, unrealizedMicros: null, gasMicros: null, pnlMicros: null })

/** `view` is for a wallet that's been changed since it was converted, as when its costs come from the user's other wallets. */
export function foldWallet(wallet: WalletData, method: Method, view: WalletView = viewWallet(wallet)): FoldedWallet {
  const positions = foldPositions(view.legs, method, view.prices, wallet)
  const unread = unreadAssets(positions, wallet)
  const totals = hasStarted(wallet) ? sumTotals(positions, unread) : noTotals()
  const status = pnlStatus(totals, wallet.gasUnknownTxs)
  return {
    view,
    positions,
    unreadAssets: unread,
    totals,
    pnlStatus: status,
    points: pnlOverTime(view.legs, method, view.prices, view.markPrice, wallet.latest, unconfirmedAssets(positions, unread), new Set(totals.noMarket), wallet.priceSamples?.map((sample) => sample.blockNum)),
    holdComparison: compareWithHoldingEth(positions, totals, status, view.prices, view.markPrice),
  }
}

/** What a wallet's numbers leave out, in words. Empty when nothing is. */
export function describeMissing({ totals, gasUnknownTxs, l1FeeUnknownTxs, missingRateTxs = [], otherTokens = 0 }: { totals: Totals; gasUnknownTxs: readonly string[]; l1FeeUnknownTxs: readonly string[]; missingRateTxs?: readonly string[]; otherTokens?: number }): string[] {
  const reasons = new Map<string, string[]>()
  for (const { asset, reason } of totals.excluded) reasons.set(asset, [...(reasons.get(asset) ?? []), reason])
  return [
    ...[...reasons].map(([asset, why]) => `${asset} (${why.join(", ")})`),
    ...(totals.unpricedGas ? ["gas with no price"] : []),
    ...(gasUnknownTxs.length > 0 ? [`gas that couldn't be worked out, in ${gasUnknownTxs.length} tx, so ETH is overstated`] : []),
    ...(l1FeeUnknownTxs.length > 0 ? [`the L1 fees of ${l1FeeUnknownTxs.length} tx, so ETH can't be checked`] : []),
    ...(missingRateTxs.length > 0 ? [`the exchange rate of ${missingRateTxs.length} tx, so what they moved has no amount in this currency`] : []),
    ...(otherTokens > 0 ? [`${otherTokens} other ${otherTokens === 1 ? "token" : "tokens"} with no price`] : []),
  ]
}
