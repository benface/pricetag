// What's read about a wallet, and the one way it becomes numbers, so the browser, the app's server and the SDK can't disagree.
// Pure, like the rest of core. `wallets.ts` is what reads it, through Amp.

import { viewWallet, type CurrencyCode, type Rates, type WalletView } from "./currency.ts"
import type { Method } from "./fold.ts"
import type { PricedLeg, Reference } from "./legs.ts"
import { foldPositions, pnlOverTime, pnlStatus, sumTotals, unconfirmedAssets, unreadAssets, type Head, type LatestPrices, type PnlPoint, type PnlStatus, type Position, type Totals } from "./portfolio.ts"
import type { BalanceSnapshot } from "./reconcile.ts"

export type Mode = "demo" | "raw" | "dataset"

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
  /** What this is meant to be shown in. Its money is always USD, and `viewWallet` converts it. */
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
}

/** With nothing read, there's no sum at all. Adding up no legs would otherwise say $0. */
const noTotals = (): Totals => ({ ...sumTotals([]), valueMicros: null, realizedMicros: null, unrealizedMicros: null, gasMicros: null, pnlMicros: null })

export function foldWallet(wallet: WalletData, method: Method): FoldedWallet {
  const view = viewWallet(wallet)
  const positions = foldPositions(view.legs, method, view.prices, wallet)
  const unread = unreadAssets(positions, wallet)
  const totals = hasStarted(wallet) ? sumTotals(positions, unread) : noTotals()
  return {
    view,
    positions,
    unreadAssets: unread,
    totals,
    pnlStatus: pnlStatus(totals, wallet.gasUnknownTxs),
    points: pnlOverTime(view.legs, method, view.prices, view.markPrice, wallet.latest, unconfirmedAssets(positions, unread)),
  }
}

/** What a wallet's numbers leave out, in words. Empty when nothing is. */
export function describeMissing({ totals, gasUnknownTxs, l1FeeUnknownTxs }: { totals: Totals; gasUnknownTxs: readonly string[]; l1FeeUnknownTxs: readonly string[] }): string[] {
  const reasons = new Map<string, string[]>()
  for (const { asset, reason } of totals.excluded) reasons.set(asset, [...(reasons.get(asset) ?? []), reason])
  return [
    ...[...reasons].map(([asset, why]) => `${asset} (${why.join(", ")})`),
    ...(totals.unpricedGas ? ["gas with no price"] : []),
    ...(gasUnknownTxs.length > 0 ? [`gas that couldn't be worked out, in ${gasUnknownTxs.length} tx, so ETH is overstated`] : []),
    ...(l1FeeUnknownTxs.length > 0 ? [`the L1 fees of ${l1FeeUnknownTxs.length} tx, so ETH can't be checked`] : []),
  ]
}
