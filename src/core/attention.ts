// What the top of a wallet has to say about its own numbers, once. One problem shouldn't show in orange six times.
// `Portfolio.attention` says the same on the Mac.

import { formatAmount, formatSignedAmount, type CurrencyCode, type PnlStatus, type Position, type Totals } from "@pricetag/sdk/core"
import { missingRatesLine, type ExplainTarget } from "./explain.ts"
import { ALL_BALANCES_MATCH, CHECK_LABELS, MARKET_ESTIMATES, PAST_COSTS_UNKNOWN, PNL_INCOMPLETE, UNPRICED_FEES, excludedSentence, feesUnknownSentence, leavesOutSentence, networkFeeUnknownSentence, pnlLeavesOutSentence, unreadBalancesSentence, unseenEthCause, valueGapsSentence, withheldSentence } from "./wording.ts"

export type AttentionFacts = {
  positions: readonly Position[]
  unread: readonly string[]
  totals: Totals
  pnlStatus: PnlStatus
  gasUnknownTxs: readonly string[]
  l1FeeUnknownTxs: readonly string[]
  withheld: readonly { wallet: string; asset: string }[]
  currency: CurrencyCode
  missingRateTxs: readonly unknown[]
  /** Whether there's a current rate from USD to `currency`, which USD never needs. */
  hasCurrentRate: boolean
}

export type Attention = {
  title: string
  /** What no row or number below would show. */
  details: string[]
  /** Exactly what's excluded and why, when the title only says how much. The holdings show which, row by row. */
  fullList: string | null
}

export type ValueGaps = { noPrice: string[]; unread: string[]; unchecked: string[]; incompleteHistory: string[] }

const listed = (positions: readonly Position[]) => positions.filter((p) => !p.noMarket)
const hasShortfall = (position: Position) => BigInt(position.state.shortfallQty) > 0n

/** Whether the value leaves out something held, which changes what the number means. */
export const isValuePartial = ({ valueMicros, coverage }: Totals) => valueMicros !== null && coverage.value.missing > 0 && coverage.value.known > 0

/** Why the value is partial, by the same causes the SDK counts. The first two are left out of it. The last two are in it, as a best estimate. */
export function valueGaps(positions: readonly Position[], unread: readonly string[]): ValueGaps {
  const shown = listed(positions)
  return {
    noPrice: shown.filter((p) => BigInt(p.values.qty) > 0n && p.values.valueMicros === null).map((p) => p.asset),
    unread: [...unread],
    unchecked: shown.filter((p) => p.reconciliation?.status === "unchecked" && p.reconciliation.heldIsCurrent !== true).map((p) => p.asset),
    // Unconfirmed positions already say so, and that's the bigger doubt.
    incompleteHistory: shown.filter((p) => hasShortfall(p) && p.reconciliation?.status !== "unchecked" && p.reconciliation?.status !== "incomplete").map((p) => p.asset),
  }
}

/** The one place the headline says it's incomplete or estimated, so it's never null while any of its numbers is. */
export function attentionOf({ positions, unread, totals, pnlStatus, gasUnknownTxs, l1FeeUnknownTxs, withheld, currency, missingRateTxs, hasCurrentRate }: AttentionFacts): Attention | null {
  const partial = isValuePartial(totals)
  const unknownCost = BigInt(totals.unresolvedMicros) > 0n
  const leavesOutFees = totals.unpricedGas || gasUnknownTxs.length > 0 || l1FeeUnknownTxs.length > 0
  // A holding whose history is incomplete is still in the PnL, so it's said with the value, not as left out.
  const pnlLeftOut = [...new Set(totals.excluded.filter(({ reason }) => reason !== "incomplete history" && (!unknownCost || reason !== "unknown cost")).map(({ asset }) => asset))]
  // A value that's partial says it of what couldn't be read, with what that means for the value.
  const lines = [
    ...(!partial && unread.length > 0 ? [unreadBalancesSentence(unread)] : []),
    ...(totals.unpricedGas ? [UNPRICED_FEES] : []),
    ...(gasUnknownTxs.length > 0 ? [feesUnknownSentence(gasUnknownTxs.length)] : []),
    ...(l1FeeUnknownTxs.length > 0 ? [networkFeeUnknownSentence(l1FeeUnknownTxs.length)] : []),
    ...withheld.map(({ wallet, asset }) => withheldSentence(wallet, asset)),
    ...(missingRateTxs.length > 0 ? [missingRatesLine(missingRateTxs.length, currency)] : []),
    ...(hasCurrentRate ? [] : [`There's no current USD to ${currency} rate, so what's held has no current value.`]),
    // The sentence about estimates only counts what's in the PnL. A value from a market price is an estimate too.
    ...(BigInt(totals.estimatedMicros) === 0n && (totals.estimated.value || totals.estimated.realized || totals.estimated.unrealized) ? [MARKET_ESTIMATES] : []),
  ]
  const excludedList = excludedSentence(totals.excluded)
  const valueLine = partial ? [valueGapsSentence(valueGaps(positions, unread))] : []
  const title = leavesOutSentence(totals, currency)
  if (title) {
    // That says how much is unknown or estimated, not which totals leave something out, and the numbers above don't say either.
    const omissions = pnlStatus !== "partial" ? [] : pnlLeftOut.length > 0 ? [`${pnlLeavesOutSentence(pnlLeftOut, unknownCost)}.`] : !unknownCost && !leavesOutFees ? [`${PNL_INCOMPLETE}.`] : []
    return { title, details: [...valueLine, ...omissions, ...lines], fullList: excludedList }
  }
  if (excludedList) return { title: excludedList, details: [...valueLine, ...lines], fullList: null }
  const rest = [...valueLine, ...lines]
  if (rest.length === 0 && pnlStatus === "partial") rest.push(`${PNL_INCOMPLETE}.`)
  const [first, ...details] = rest
  return first === undefined ? null : { title: first, details, fullList: null }
}

/** What to say when there's no warning but questions remain, as when what they ask about has left. They can still be answered, and a tax report needs them. */
export const pastCostsNote = (attention: Attention | null, questionCount: number) => (attention === null && questionCount > 0 ? PAST_COSTS_UNKNOWN : null)

/** Where "Show What's Missing" goes: the balance that doesn't match when that's the reason, or else what the total is made of. */
export function attentionTarget(positions: readonly Position[]): ExplainTarget {
  for (const position of listed(positions)) {
    const flag = balanceFlag(position)
    if (flag) return { kind: "asset", asset: position.asset, metric: flag.metric }
  }
  return { kind: "total", metric: "pnl" }
}

/** What the rows no longer say one by one. null unless every listed balance was checked and matches. */
export function allBalancesMatch(positions: readonly Position[], unread: readonly string[]): string | null {
  const shown = listed(positions)
  // A balance that couldn't be read has no row, and hasn't been shown to match anything.
  return shown.length > 0 && unread.length === 0 && shown.every((p) => p.reconciliation?.status === "reconciled") ? ALL_BALANCES_MATCH : null
}

/** What a row flags about its balance, or null when there's nothing to flag: a balance that matches says nothing. */
export function balanceFlag(position: Position): { label: string; help: string; metric: "onchain" | "amount" } | null {
  const { asset, decimals, reconciliation } = position
  if (reconciliation?.status === "unchecked") return { label: CHECK_LABELS.unchecked, help: `${CHECK_LABELS.unchecked}. ${reconciliation.reason} PnL is unavailable until this balance is confirmed.`, metric: "onchain" }
  if (reconciliation?.status === "incomplete") {
    const { computedQty, actualQty, differenceQty, unseenEth } = reconciliation
    const check = `Worked out ${formatAmount(computedQty, decimals)}, actual ${formatAmount(actualQty, decimals)}, difference ${formatSignedAmount(differenceQty, decimals)} ${asset}. PnL is unavailable.`
    return { label: CHECK_LABELS.incomplete, help: unseenEth ? `${check} ${unseenEthCause(unseenEth)}` : check, metric: "onchain" }
  }
  // Only the amount's explanation says this, because the balance itself may match.
  return hasShortfall(position) ? { label: CHECK_LABELS.incomplete, help: "More left this wallet than we saw arrive, so its history is incomplete.", metric: "amount" } : null
}
