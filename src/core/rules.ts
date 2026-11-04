// The pricing rules a server can read a wallet through. Each is a dataset version, picked per request: the SQL stays
// the same, so a rule can be forked without touching the app. Cost and PnL follow from whichever prices it publishes.

/** `dataset` and `hash` say exactly what was read, because a query pinned to a hash can't read anything else. */
export type PricingRule = { id: string; name: string; summary: string; dataset: string; hash: string }

export const MARKET_RULE_ID = "market-price"
export const CAUTIOUS_RULE_ID = "cautious-eth"

export const RULE_TEXT: Record<string, Pick<PricingRule, "name" | "summary">> = {
  [MARKET_RULE_ID]: { name: "Market price", summary: "ETH counts at what Chainlink's price feed says at each block." },
  [CAUTIOUS_RULE_ID]: { name: "Cautious ETH", summary: "ETH counts at 1% below that price, closer to what you'd get if you sold it. Every other price is the same." },
}

/** One number by each rule, in the wallet's main currency, except `usdPrice`. A null is unavailable, not zero. */
export type RuleRow = { label: string; format: "signed" | "money" | "usdPrice"; a: string | null; b: string | null; difference: string | null }

export type RuleTransaction = { txHash: string; blockNum: number; timestamp: string; asset: string; label: "Cost" | "Sold for"; a: string | null; b: string | null; difference: string | null }

/** What two rules make of one wallet at the same block, so the only difference between them is the rule. */
export type RuleComparison = {
  address: string
  currency: string
  blockNum: number
  a: PricingRule
  b: PricingRule
  why: string
  rows: RuleRow[]
  /** The newest few that came out differently. `changedTxs` says how many there are. */
  transactions: RuleTransaction[]
  changedTxs: number
}

/** B minus A, or null when either is unavailable: a difference from an unknown isn't known. */
export const differenceOf = (a: string | null, b: string | null): string | null => (a === null || b === null ? null : (BigInt(b) - BigInt(a)).toString())

export function whySentence(changedTxs: number): string {
  const same = "Both read the same transactions at the same block, so the only difference is what ETH is worth, which also sets what ETH held and network fees count for."
  if (changedTxs === 0) return `No transaction's cost or sale value here depends on what ETH is worth, so those stay the same. ${same}`
  return `${changedTxs === 1 ? "1 transaction's" : `${changedTxs.toLocaleString("en-US")} transactions'`} cost or sale value changed. ${same}`
}

/** Said wherever a number is explained while a rule other than the first is on, since a label alone can't say it. */
export const ruleNote = (rule: Pick<PricingRule, "name" | "summary">) => `Using the pricing rule "${rule.name}". ${rule.summary}`
