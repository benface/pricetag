// What the interface calls things, and the sentences the honesty rules depend on. The code, the dataset and the API
// keep their own names, like `leg`, `oracle` and `fifo`: this is only what people read.
// `Wording.swift` says the same on the Mac, and a test runs both on the same inputs.

import { formatDuration, formatMoney, msBetweenBlocks, type CostLabel, type CurrencyCode, type FoldLeg, type Method, type PriceSource } from "@pricetag/sdk/core"
import type { Mode } from "./api.ts"

export const METHOD_LABELS: Record<Method, string> = { average: "Average", fifo: "Oldest first" }
export const METHOD_NAME = "How cost is worked out"
export const METHOD_HELP = "Average spreads what you paid across all you hold. Oldest first counts what you sell as what you got earliest."

export const AVERAGE_PRICE_PAID = "Average price paid"
export const NETWORK_FEES = "Network fees"
export const BALANCE_CHECK = "Balance check"
export const CHECK_LABELS = { reconciled: "Matches", incomplete: "Incomplete", unchecked: "Not checked" }
export const STARTING_BALANCE = "Starting balance"
export const PNL_HELP = "PnL is profit and loss: what you've gained or lost so far."
export const REALIZED_HELP = "Gain or loss on what you've sold or spent."
export const UNREALIZED_HELP = "Gain or loss on what you still hold, at the current price."

/** The tooltip for a title or sentence that says PnL, or nothing when it doesn't. */
export const pnlHelp = (text: string): string | undefined => (text.includes("PnL") ? PNL_HELP : undefined)

/** A token's name in a sentence. The code keeps its symbol. */
export const tokenLabel = (symbol: string) => (symbol === "WETH" ? "wrapped ETH" : symbol)

export const ETH_NOTE = "incl. wrapped ETH"
export const DEMO_NOTICE = "Demo data, not a real wallet. Every case the app has to get right is in here."
export const PNL_UNAVAILABLE = "PnL unavailable"
export const NOTHING_TO_CHART = "Everything here depends on an unknown cost or price, so there's no PnL to chart. It isn't zero."
export const UNPRICED_FEES = "Some network fees had no price at the time, and aren't in this total."
export const READING = "Reading this wallet's history. The first read can take a minute, then only new activity is read."
export const NOT_AN_ADDRESS = "That isn't a Base address. It should start with 0x, then 40 letters and numbers."

export const RULES_TITLE = "Pricing rule"
export const RULES_HELP = "Prices come from a public recipe anyone can copy and change. Each rule here is one version of it, named by its fingerprint. Switching only changes which one this wallet is read through."

/** A dataset version's fingerprint, short enough to read and long enough to recognize. */
export const shortManifestHash = (hash: string) => `${hash.slice(0, 12)}…${hash.slice(-4)}`

export const MODE_LABELS: Record<Mode, string> = { demo: "Demo data", raw: "Raw chain data", dataset: "Pricetag data" }

/** What a leg did, in a word. */
export function actionLabel(kind: FoldLeg["kind"], incoming: boolean): string {
  if (kind === "gas") return "Network fee"
  if (kind === "swap") return incoming ? "Bought" : "Sold"
  return incoming ? "Received" : "Sent"
}

export function priceSourceLabel(source: PriceSource): string {
  return { oracle: "market price feed", swap: "from this exchange", market: "market price" }[source]
}

/** Where the current price came from, to finish "from …". */
export function currentPriceSource(source: PriceSource): string {
  return { oracle: "the market price feed", swap: "a recent exchange", market: "the market" }[source]
}

/** Where a leg's cost came from. */
export function costTag(label: CostLabel): string {
  return {
    paid: "Cost: what you paid",
    inherited: "Cost: from your other wallet",
    "received at market": "Cost: market price when received",
    "self-reported": "Cost: what you entered",
    unknown: "Cost unknown",
  }[label]
}

/** A cost's source, to finish "from …". */
export const COST_WORDS: Record<CostLabel, string> = {
  paid: "what you paid",
  inherited: "what your other wallet paid",
  "received at market": "the price when it arrived",
  "self-reported": "what you entered",
  unknown: "an unknown cost",
}

/** What a list of movements is called, with how much of it is showing. */
export function activityTitle(count: number, shown: number): string {
  const total = count.toLocaleString("en-US")
  return count > shown ? `Activity (newest ${shown} of ${total})` : `Activity (${total})`
}

/** How much of a wallet's PnL rests on an estimate, or null when none does. */
export const estimatedSentence = (micros: string, currency: CurrencyCode): string | null => (BigInt(micros) > 0n ? `${formatMoney(micros, currency)} of this is an estimate, from market prices.` : null)

/** What a total leaves out, or null when it leaves out nothing. */
export function excludedSentence(excluded: readonly { asset: string; reason: string }[]): string | null {
  if (excluded.length === 0) return null
  const byReason = new Map<string, string[]>()
  for (const { asset, reason } of excluded) byReason.set(reason, [...(byReason.get(reason) ?? []), asset])
  return `Excludes ${[...byReason.entries()].map(([reason, assets]) => `${assets.join(", ")} (${reason})`).join("; ")}.`
}

export function coverageSentence(coverage: { fromBlock: number; toBlock: number }, trackedTokens: number, openingUnread: boolean): string {
  const opening = openingUnread ? "What the wallet held before that couldn't all be read yet, so some amounts may not be full balances." : "What the wallet held before that is included, at an unknown cost."
  return `Covers about ${formatDuration(msBetweenBlocks(coverage.fromBlock, coverage.toBlock))} of history and ${trackedTokens} tokens plus ETH. ${opening} Other tokens aren't counted.`
}

export function networkFeeUnknownSentence(count: number): string {
  return `Couldn't read the network fee of ${count} ${count === 1 ? "transaction" : "transactions"} yet, so fees paid are too low, and ETH's PnL is unavailable until they're read.`
}

export function linkedFailedSentence(count: number): string {
  return count === 1 ? "Couldn't read your other wallet, so what came from it may show as unresolved." : `Couldn't read ${count} of your other wallets, so what came from them may show as unresolved.`
}

export function feesUnknownSentence(count: number): string {
  return `Network fees couldn't be worked out for ${count} ${count === 1 ? "transaction" : "transactions"}, so the network fees shown are too low.`
}

export const NOT_STARTED = "The data hasn't reached this wallet's history yet, so there's nothing to show so far."

export function behindSentence(ms: number): string {
  // Under half a minute would round to "0 min", which reads as not behind at all.
  return `The data is still catching up, ${ms < 30_000 ? "less than a minute" : `about ${formatDuration(ms)}`} behind the network. Anything newer isn't in these numbers yet.`
}

export function staleSentence(lastUpdate: string): string {
  return `These numbers aren't updating. Last update: ${lastUpdate}.`
}

/** The technical side of the status badge, for its tooltip. */
export function feedDetail(mode: Mode, block: number): string {
  return mode === "demo" ? MODE_LABELS.demo : `${MODE_LABELS[mode]} · block ${block.toLocaleString("en-US")}`
}
