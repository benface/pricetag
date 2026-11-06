// What any token is worth from its own trading, with no list of tokens and no hand-set bounds. `dataset/tokens.json` has what every
// pool's trades were. This decides when they add up to a market, and says why not when they don't, so nothing here is ever a guess.
//
// A chain can't prove trading is honest: wallets are free to make, and a pool's fees go back to whoever funds it. So these make faking
// slow and bound what it can do, and what a price is used for has to stay safe when it's wrong. See README.md's "Pricing any token".

/**
 * One sender's trades on one side of a token, over a few minutes, up to the block `bin`. Amounts are in the token's smallest unit, so no decimals
 * are needed, and a token can't lie about them to change what it's worth.
 */
export type TokenActivity = { token: string; bin: number; timeMs: number; sender: string; side: "buy" | "sell"; usd: number; raw: number; trades: number }

export type TokenMarketRules = {
  /** How far back trading has to look real. Long enough that a token can't pass within an hour of being made. */
  windowMs: number
  minBuyers: number
  minSellers: number
  /** Selling is what a token with a trap in it can't do, so both sides need real money. */
  minSideUsd: number
  /** No sender can be most of the trading: that's a bot washing its own pool. */
  maxTopSenderShare: number
  /** Hours of the window with trades on both sides. A burst isn't a market. */
  minActiveHours: number
  /** How recent the price itself has to be. */
  priceWindowMs: number
  minPriceSenders: number
  /** Highest over lowest of the recent trades. In a thin pool each trade moves the price, so this stands in for depth. */
  maxPriceSpread: number
}

export const TOKEN_MARKET_RULES: TokenMarketRules = {
  windowMs: 24 * 3_600_000,
  minBuyers: 10,
  minSellers: 10,
  minSideUsd: 2_000,
  maxTopSenderShare: 0.5,
  minActiveHours: 6,
  priceWindowMs: 3_600_000,
  minPriceSenders: 3,
  maxPriceSpread: 1.25,
}

/** Trades under this don't count at all, so dust can't fill the window for pennies. In USD. */
export const MIN_TOKEN_TRADE_USD = 10

export type TokenMarketRefusal = "tooFewBuyers" | "tooFewSellers" | "tooLittleTrading" | "oneSender" | "tooFewHours" | "noRecentTrades" | "priceTooWide"
export type TokenMarketResult = { usdPerRaw: number; refused?: never } | { usdPerRaw?: never; refused: TokenMarketRefusal }

const middle = (sorted: readonly number[], at: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * at))] as number

/** What one token's trades say it's worth at `atMs`. Never looks ahead. `activity` is only that token's. */
export function tokenMarketPrice(activity: readonly TokenActivity[], atMs: number, rules: TokenMarketRules = TOKEN_MARKET_RULES): TokenMarketResult {
  const window = activity.filter((row) => row.timeMs <= atMs && row.timeMs > atMs - rules.windowMs)
  const buyers = new Set<string>()
  const sellers = new Set<string>()
  const bySender = new Map<string, number>()
  const hours = new Map<number, { buy: boolean; sell: boolean }>()
  let buyUsd = 0
  let sellUsd = 0
  for (const row of window) {
    ;(row.side === "buy" ? buyers : sellers).add(row.sender)
    if (row.side === "buy") buyUsd += row.usd
    else sellUsd += row.usd
    bySender.set(row.sender, (bySender.get(row.sender) ?? 0) + row.usd)
    const hour = Math.floor(row.timeMs / 3_600_000)
    const seen = hours.get(hour) ?? { buy: false, sell: false }
    seen[row.side] = true
    hours.set(hour, seen)
  }
  if (buyers.size < rules.minBuyers) return { refused: "tooFewBuyers" }
  if (sellers.size < rules.minSellers) return { refused: "tooFewSellers" }
  if (buyUsd < rules.minSideUsd || sellUsd < rules.minSideUsd) return { refused: "tooLittleTrading" }
  if (Math.max(...bySender.values()) > (buyUsd + sellUsd) * rules.maxTopSenderShare) return { refused: "oneSender" }
  if ([...hours.values()].filter((hour) => hour.buy && hour.sell).length < rules.minActiveHours) return { refused: "tooFewHours" }

  const recent = window.filter((row) => row.timeMs > atMs - rules.priceWindowMs && row.raw > 0)
  if (new Set(recent.map((row) => row.sender)).size < rules.minPriceSenders) return { refused: "noRecentTrades" }
  const prices = recent.map((row) => row.usd / row.raw).sort((a, b) => a - b)
  // Not the very ends, so one odd trade can't refuse a price any more than it can set one.
  if (middle(prices, 0.9) > middle(prices, 0.1) * rules.maxPriceSpread) return { refused: "priceTooWide" }
  return { usdPerRaw: middle(prices, 0.5) }
}
