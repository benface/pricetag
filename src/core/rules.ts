// The pricing rules a server can read a wallet through. Each is a dataset version, picked per request: the SQL stays
// the same, so a rule can be forked without touching the app. Cost and PnL follow from whichever prices it publishes.

import { formatMoney, formatPrice, formatSignedMoney, labelUsd, type CurrencyCode } from "@pricetag/sdk/core"

/** `dataset` and `hash` say exactly what was read, because a query pinned to a hash can't read anything else. */
export type PricingRule = { id: string; name: string; summary: string; dataset: string; hash: string }

/** The rules in a `/api/rules` response. Throws for anything else, like a refusal's `{ error }`, because that says nothing about which rules the server has. */
export async function readRules(response: Response): Promise<PricingRule[]> {
  const body = (await response.json()) as { rules?: PricingRule[] }
  if (!response.ok || !Array.isArray(body.rules)) throw new Error("Couldn't read the rules.")
  return body.rules
}

/** The server's rules. `useRules` keeps its empty list when this fails. */
export const fetchRules = (signal: AbortSignal, send: typeof fetch = fetch): Promise<PricingRule[]> => send("/api/rules", { signal }).then(readRules)

export const MARKET_RULE_ID = "market-price"
export const CAUTIOUS_RULE_ID = "cautious-eth"

export const RULE_TEXT: Record<string, Pick<PricingRule, "name" | "summary">> = {
  [MARKET_RULE_ID]: { name: "Market price", summary: "ETH counts at what Chainlink's price feed says at each block." },
  [CAUTIOUS_RULE_ID]: { name: "Cautious ETH", summary: "ETH counts at 1% below Chainlink's price, closer to what you'd get if you sold it. A token priced against ETH follows it, and every other price is the same." },
}

/** One number by each rule, in the wallet's main currency, except `usdPrice`. A null is unavailable, not zero. */
export type RuleRow = {
  label: string
  format: "signed" | "money" | "usdPrice"
  a: string | null
  b: string | null
  /** Null unless both sides are made of the same known amounts, because anything else isn't a difference between rules. */
  difference: string | null
  /** This side's sum leaves something out. `warnings` says what. */
  aPartial: boolean
  bPartial: boolean
  /** This side rests on an estimate, and so does a difference from it. `warnings` says how much. */
  aEstimated: boolean
  bEstimated: boolean
}

export type RuleTransaction = { txHash: string; blockNum: number; timestamp: string; asset: string; label: "Cost" | "Sold for" | "Network fee"; a: string | null; b: string | null; difference: string | null; aEstimated: boolean; bEstimated: boolean }

/** What two rules make of one wallet at the same block, so the only difference between them is the rule. */
export type RuleComparison = {
  address: string
  currency: string
  blockNum: number
  a: PricingRule
  b: PricingRule
  why: string
  /** What the numbers leave out or can't vouch for, the same as they'd say on the main screen. */
  warnings: string[]
  rows: RuleRow[]
  /** The newest few that came out differently. `changedTxs` says how many there are. */
  transactions: RuleTransaction[]
  changedTxs: number
}

/** B minus A, or null when either is unavailable: a difference from an unknown isn't known. */
export const differenceOf = (a: string | null, b: string | null): string | null => (a === null || b === null ? null : (BigInt(b) - BigInt(a)).toString())

export function whySentence(changedTxs: number): string {
  const same = "Both read the same transactions, balances and exchange rates at the same block, so the only difference is what ETH is worth, which also sets what ETH held counts for and what a token priced against ETH is worth."
  if (changedTxs === 0) return `No transaction's cost, sale value or network fee here depends on what ETH is worth, so those stay the same. ${same}`
  return `${changedTxs === 1 ? "1 transaction's" : `${changedTxs.toLocaleString("en-US")} transactions'`} cost, sale value or network fee changed. ${same}`
}

/** Said wherever a number is explained while a rule other than the first is on, since a label alone can't say it. */
export const ruleNote = (rule: Pick<PricingRule, "name" | "summary">) => `Using the pricing rule "${rule.name}". ${rule.summary}`

/** One side of a comparison. A null is unavailable, not zero. */
export function showRuleValue(micros: string | null, format: RuleRow["format"], currency: CurrencyCode, estimated = false): string {
  if (micros === null) return "Unavailable"
  if (estimated) return `≈${showRuleValue(micros, format, currency)}`
  if (format === "usdPrice") return labelUsd(formatPrice(micros, "USD"), currency)
  return format === "money" ? formatMoney(micros, currency) : formatSignedMoney(micros, currency)
}

/** A difference is always signed, so which way it went can be read at a glance. A price's is small, so it keeps its digits. */
export function showRuleDifference(micros: string | null, format: RuleRow["format"], currency: CurrencyCode, estimated = false): string {
  if (micros === null) return "—"
  if (BigInt(micros) === 0n) return "Same"
  if (estimated) return `≈${showRuleDifference(micros, format, currency)}`
  if (format !== "usdPrice") return formatSignedMoney(micros, currency)
  const size = micros.startsWith("-") ? micros.slice(1) : micros
  return labelUsd(`${micros.startsWith("-") ? "-" : "+"}${formatPrice(size, "USD")}`, currency)
}
