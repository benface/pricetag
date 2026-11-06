// What the interface calls things, and the sentences the honesty rules depend on. The code, the dataset and the API
// keep their own names, like `leg`, `oracle` and `fifo`: this is only what people read.
// `Wording.swift` says the same on the Mac, and a test runs both on the same inputs.

import { formatAmount, formatDuration, formatMoney, msBetweenBlocks, shortHash, worth, type CostLabel, type CurrencyCode, type FoldLeg, type HoldComparison, type Method, type PricedLeg, type PriceSource, type UnseenEth } from "@pricetag/sdk/core"
import type { Mode } from "./api.ts"
import type { ReadFailure } from "./read-failure.ts"

export const METHOD_LABELS: Record<Method, string> = { average: "Average", fifo: "Oldest first" }
export const METHOD_NAME = "How cost is worked out"
export const METHOD_HELP = "Average spreads what you paid across all you hold. Oldest first counts what you sell as what you got earliest."

export const AVERAGE_PRICE_PAID = "Average price paid"
export const NETWORK_FEES = "Network fees"
export const BALANCE_CHECK = "Balance check"
export const CHECK_LABELS = { reconciled: "Matches", incomplete: "Doesn't match", unchecked: "Not checked" }
export const STARTING_BALANCE = "Starting balance"
export const PNL_HELP = "PnL is profit and loss: what you've gained or lost so far."
export const REALIZED_HELP = "Gain or loss on what you've sold or spent."
export const UNREALIZED_HELP = "Gain or loss on what you still hold, at the current price."
export const RETURN_HELP = "Unrealized PnL as a share of what you paid for what you still hold."

export const HOLD_TITLE = "Compared with holding ETH"
export const HOLD_WALLET = "This wallet, after network fees"
export const HOLD_ETH = "If you'd held ETH instead"
export const HOLD_PAST = "Past results don't predict future ones."

/** Fixing an unknown cost is answering questions, wherever it's offered, so it has one name. A count always says what it counts. */
export const ANSWER_QUESTIONS = "Answer Questions"
export const answerQuestionsLabel = (count: number) => (count === 1 ? "Answer 1 Question" : `Answer ${count.toLocaleString("en-US")} Questions`)
/** When there's nothing to answer, but something's still left out. */
export const SHOW_MISSING = "Show What's Missing"
export const SENDER_QUESTION = "Who sent you this?"
export const SENDER_WHY = "What you paid for it is unknown until you say where it came from, so PnL leaves it out."
export const COST_QUESTION = "What did you pay for this?"
export const COST_WHY = "Nothing shows what this cost, so PnL leaves it out until you say."
export const EXCHANGE_COST_WHY = "You said it came from your exchange account, which knows what you paid. Until you say, PnL leaves it out."
export const ALL_ANSWERED = "All answered"
export const NOTHING_LEFT = "That's all for now"

/** The tooltip for a title or sentence that says PnL, or nothing when it doesn't. */
export const pnlHelp = (text: string): string | undefined => (text.includes("PnL") ? PNL_HELP : undefined)

/** A token's name in a sentence. The code keeps its symbol. */
export const tokenLabel = (symbol: string) => (symbol === "WETH" ? "wrapped ETH" : symbol)

export const ETH_NOTE = "incl. wrapped ETH"
export const DEMO_NOTICE = "Demo data, not a real wallet."
export const PNL_UNAVAILABLE = "PnL unavailable"
export const NOTHING_TO_CHART = "Everything here depends on an unknown cost or price, so there's no PnL to chart. It isn't zero."
export const UNPRICED_FEES = "Some network fees had no price at the time, and aren't in this total."
export const READING = "Reading this wallet. The first read can take a minute."
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

const DOLLARS: readonly string[] = ["USDC", "USDT", "DAI"]

/** A few assets by name, and how many more when there are too many for a row. */
function movedAmounts(legs: readonly PricedLeg[]): string {
  // How much of a claim reached the wallet isn't known, so it only says what.
  const names = legs.map((leg) => (leg.unsettledCredit && BigInt(leg.delta) > 0n ? leg.asset : `${formatAmount(leg.delta.replace("-", ""), leg.decimals)} ${leg.asset}`))
  return names.length <= 2 ? names.join(" and ") : `${names[0]}, ${names[1]} and ${names.length - 2} more`
}

/**
 * What a transaction did to this wallet, in a few words, from its legs. Amounts rather than money, because what moved
 * is known even when what it was worth isn't. null when nothing moved at all.
 */
export function describeTransaction(legs: readonly PricedLeg[], currency: CurrencyCode): string | null {
  const moved = legs.filter((leg) => leg.kind !== "gas" && BigInt(leg.delta) !== 0n)
  const of = (kind: FoldLeg["kind"], incoming: boolean) => moved.filter((leg) => leg.kind === kind && BigInt(leg.delta) > 0n === incoming)
  const sold = of("swap", false)
  const bought = of("swap", true)
  const clauses: string[] = []
  if (sold.length > 0 && bought.length > 0) {
    // Spending dollars reads as buying what they bought, not as selling the dollars.
    if (sold.every((leg) => DOLLARS.includes(leg.asset))) clauses.push(`Bought ${movedAmounts(bought)} for ${movedAmounts(sold)}`)
    else clauses.push(`Sold ${movedAmounts(sold)} for ${movedAmounts(bought)}`)
  } else if (sold.length > 0) clauses.push(`Sold ${movedAmounts(sold)}`)
  else if (bought.length > 0) clauses.push(`Bought ${movedAmounts(bought)}`)
  const sent = of("transfer", false)
  const received = of("transfer", true)
  if (sent.length > 0) clauses.push(`Sent ${movedAmounts(sent)}`)
  if (received.length > 0) clauses.push(`Received ${movedAmounts(received)}`)
  if (clauses.length > 0) return clauses.map((clause, i) => (i === 0 ? clause : clause[0]!.toLowerCase() + clause.slice(1))).join(", ")
  const fees = legs.filter((leg) => leg.kind === "gas")
  if (fees.length === 0) return null
  // With no price at that block, it still says what this was.
  if (fees.some((leg) => leg.priceMicros === null)) return "Network fee"
  return `Network fee of ${formatMoney(fees.reduce((sum, leg) => sum + worth(BigInt(leg.delta.replace("-", "")), BigInt(leg.priceMicros as string), leg.decimals), 0n), currency)}`
}

/** A transaction that moved something from one of your wallets to another. `legs` are what arrived. */
export const movedBetweenSentence = (legs: readonly PricedLeg[]) => `Moved ${movedAmounts(legs)} between your wallets`

export function priceSourceLabel(source: PriceSource): string {
  return { oracle: "market price feed", swap: "from this exchange", market: "market price" }[source]
}

/** Where the current price came from, to finish "from …". */
export function currentPriceSource(source: PriceSource): string {
  return { oracle: "the market price feed", swap: "a recent exchange", market: "the market" }[source]
}

/** Where a leg's cost came from. */
export function costTag(label: CostLabel, source: string | null = null): string {
  if (source) return label === "inherited" ? `Cost: ${source}, from your other wallet` : `Cost: ${source}`
  return {
    paid: "Cost: what you paid",
    inherited: "Cost: from your other wallet",
    "received at market": "Cost: market price when received",
    "self-reported": "Cost: what you entered",
    unknown: "Cost unknown",
  }[label]
}

/** How a purchase's provider is named wherever its cost shows up. */
export const purchaseSource = (provider: "coinbase", paid?: string) => `${{ coinbase: "Bought on Coinbase" }[provider]}${paid ? ` for ${paid}` : ""}`

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

/** How this wallet did next to holding, when the two cover the same money. */
export function holdDifferenceSentence(micros: string, currency: CurrencyCode, estimated = false): string {
  const difference = BigInt(micros)
  const about = estimated ? "About " : ""
  if (difference === 0n) return `${about}${estimated ? "the" : "The"} same as holding ETH.`
  return `${about}${formatMoney(difference < 0n ? -difference : difference, currency)} ${difference > 0n ? "more" : "less"} than holding ETH.`
}

/** What keeps the two from being set against each other, or null when nothing does. */
export function holdCaveatSentence({ status, unavailable, putInMicros, unknownAmounts, walletLeavesOut }: Pick<HoldComparison, "status" | "unavailable" | "putInMicros" | "unknownAmounts" | "walletLeavesOut">, currency: CurrencyCode): string | null {
  if (status === "complete") return null
  if (unavailable === "no current eth price") return "Unavailable, because there's no current ETH price to compare with."
  if (unavailable === "left with no known value") return "Unavailable, because something left this wallet with no known value, so what holding ETH would have left can't be worked out."
  if (unavailable === "left with no known share") return "Unavailable, because something left this wallet after an exchange of several tokens at once, so how much of it came from what was put in can't be worked out."
  if (unavailable === "nothing known put in") return "Unavailable, because nothing put in this wallet has a known value yet."
  const amounts = unknownAmounts === 1 ? "1 other amount has no known value, and isn't counted." : `${unknownAmounts.toLocaleString("en-US")} other amounts have no known value, and aren't counted.`
  return [`Partial, so the two don't cover the same money. Holding ETH counts the ${formatMoney(putInMicros, currency)} put in with a known value.`, unknownAmounts > 0 ? amounts : null, walletLeavesOut ? "This wallet's total leaves some things out." : null].filter((part) => part !== null).join(" ")
}

export function coverageSentence(coverage: { fromBlock: number; toBlock: number }, trackedTokens: number, openingUnread: boolean): string {
  const opening = openingUnread ? "What the wallet held before that couldn't all be read yet, so some amounts may not be full balances." : "What the wallet held before that is included, at an unknown cost."
  return `Covers about ${formatDuration(msBetweenBlocks(coverage.fromBlock, coverage.toBlock))} of history and ${trackedTokens} tokens plus ETH. ${opening} Other tokens aren't counted.`
}

export function networkFeeUnknownSentence(count: number): string {
  return `Couldn't read the network fee of ${count} ${count === 1 ? "transaction" : "transactions"} yet, so fees paid are too low, and ETH's PnL is unavailable until they're read.`
}

export function linkedFailedSentence(count: number): string {
  return count === 1 ? "Couldn't read your other wallet, so what came from it may show an unknown cost." : `Couldn't read ${count} of your other wallets, so what came from them may show an unknown cost.`
}

/** A wallet's history that doesn't add up, or can't be checked, and what that does to what it sent. */
export function withheldSentence(wallet: string, asset: string): string {
  return `${shortHash(wallet)}'s ${asset} history can't be confirmed, so what it sent has an unknown cost where it arrived.`
}

export function feesUnknownSentence(count: number): string {
  return `Network fees couldn't be worked out for ${count} ${count === 1 ? "transaction" : "transactions"}, so the network fees shown are too low.`
}

export const NOT_STARTED = "Numbers appear once the data reaches this wallet."

export function behindSentence(ms: number): string {
  // Under half a minute would round to "0 min", which reads as not behind at all.
  return `The data is still catching up, ${ms < 30_000 ? "less than a minute" : `about ${formatDuration(ms)}`} behind the network. Anything newer isn't in these numbers yet.`
}

export function staleSentence(lastUpdate: string): string {
  return `These numbers aren't updating. Last update: ${lastUpdate}.`
}

/** A failed read never touches what's onchain, so this is true of every failure. */
export const MONEY_UNAFFECTED = "Your money isn't affected."

/** What's wrong, for someone who doesn't know there's a server. What a developer would want stays in `detail`. */
export type Problem = { message: string; detail: string | null }

const SAID = (said: string) => `The price service said: ${said}`

/** A wallet's read that failed, in `FeedState.problem`'s words on the Mac. `stale` says how old any numbers still on screen are. */
export function feedProblem(failure: ReadFailure, serverUrl: string, stale: string | null = null): Problem {
  const say = (what: string, next: string, detail: string) => ({ message: [what, stale, MONEY_UNAFFECTED, next].filter((part) => part !== null).join(" "), detail })
  switch (failure.kind) {
    case "unreachable":
      return say("The price service isn't answering.", "Check your internet connection, then try again.", `Nothing answered at ${serverUrl}.`)
    case "unavailable":
      return say("The price service can't get its data right now.", "It usually clears up by itself, and updates start again when it does.", SAID(failure.said))
    case "noSource":
      return say("The price service has no data source, so only the demo wallet works.", "Set one up, then restart the price service.", `${SAID(failure.said)} Its data source goes in .env.local.`)
    case "refused":
      return say("The price service turned this request down.", "Try again. If it keeps happening, restart the price service.", SAID(failure.said))
  }
}

/** A failure in a panel, which answers one question and doesn't update by itself. A refusal already says what about that question went wrong. */
export function panelProblem(failure: ReadFailure, serverUrl: string): Problem {
  if (failure.kind === "refused") return { message: failure.said, detail: null }
  if (failure.kind === "unavailable") return { message: `The price service can't get its data right now. ${MONEY_UNAFFECTED} It usually clears up by itself, so try again in a moment.`, detail: SAID(failure.said) }
  return feedProblem(failure, serverUrl)
}

/** The technical side of the status badge, for its tooltip. */
export function feedDetail(mode: Mode, block: number): string {
  return mode === "demo" ? MODE_LABELS.demo : `${MODE_LABELS[mode]} · block ${block.toLocaleString("en-US")}`
}

/** Keeps a wallet with many of these to a sentence. The rest are still there, as sales with no known value. */
const MAX_NAMED_UNSEEN = 5

/** The transactions most likely behind ETH that doesn't match. */
export function unseenEthCause(unseen: readonly UnseenEth[]): string {
  const named = unseen.slice(0, MAX_NAMED_UNSEEN).map(({ amount, txHashes }) => `${txHashes.map(shortHash).join(", ")} (+${formatAmount(amount, 18)} ETH)`)
  const more = unseen.length > named.length ? `, and ${unseen.length - named.length} more` : ""
  return `It lines up with what left this wallet in ${named.join(", ")}${more}: ETH rose by that much in the same block, with no transaction showing it.`
}
