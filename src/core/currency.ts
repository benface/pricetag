// The user's main currency. The dataset and the legs stay in USD, and this is the one place that converts them.
//
// Each amount converts at the rate when it happened, not at today's: a purchase at 1.30 and a sale at the same USD price
// at 1.40 is a real gain in CAD. So this runs before the fold, which then adds up amounts that are already in CAD.
// A missing rate makes an amount null, which the fold already treats as unknown. It's never filled in from another day.

import { referenceMarks, type LatestPrices, type MarkPrice, type PricedLeg } from "@pricetag/sdk/core"
import type { WalletResponse } from "./api.ts"

export type CurrencyCode = "USD" | "CAD"

export type Currency = {
  code: CurrencyCode
  name: string
  locale: string
  /** Printed by hand before amounts too small for Intl's two decimals. */
  symbol: string
  /** Chainlink's feed on Base, answering USD for one unit with 8 decimals. USD doesn't need one. */
  feed: { address: string; pair: string } | null
}

/** Adding a currency takes one line here and one in `Currency.swift`. Base has feeds for EUR, GBP, AUD, CHF, SGD and more. */
export const CURRENCIES: Record<CurrencyCode, Currency> = {
  USD: { code: "USD", name: "US dollar", locale: "en-US", symbol: "$", feed: null },
  CAD: { code: "CAD", name: "Canadian dollar", locale: "en-CA", symbol: "$", feed: { address: "0xA840145F87572E82519d578b1F36340368a25D5d", pair: "CAD / USD" } },
}

export const CURRENCY_CODES = Object.keys(CURRENCIES) as CurrencyCode[]

export function isCurrencyCode(value: string | null | undefined): value is CurrencyCode {
  return CURRENCY_CODES.includes(value as CurrencyCode)
}

/** One read of a feed, as it answered at some block. */
export type RateRound = {
  /** USD for one unit of the currency, with 8 decimals. */
  answer: string
  /** When the feed last updated, in Unix seconds. */
  updatedAt: number
}

/** What a client needs to convert a wallet. Blocks the feed had no answer for are left out. */
export type Rates = {
  byBlock: Record<string, RateRound>
  latest: { blockNum: number; round: RateRound } | null
}

/** Forex markets close for about 2 days a week, and the feed updates hourly when they're open. Older than this, it has stopped. */
const MAX_ROUND_AGE_SECONDS = 3 * 24 * 60 * 60

const E8 = 10n ** 8n
const E6 = 10n ** 6n

function usableAnswer(round: RateRound | null | undefined, at: string): bigint | null {
  if (!round || !/^\d+$/.test(round.answer)) return null
  const answer = BigInt(round.answer)
  if (answer === 0n) return null
  return Date.parse(at) / 1000 - round.updatedAt > MAX_ROUND_AGE_SECONDS ? null : answer
}

const convert = (usdMicros: string | null, answer: bigint): string | null => (usdMicros === null ? null : ((BigInt(usdMicros) * E8) / answer).toString())

/** What one USD buys, in millionths of the currency. */
const rateOf = (answer: bigint) => ((E6 * E8) / answer).toString()

/** A wallet ready to fold: its money in `currency`, and what's needed to say how it got there. */
export type WalletView = {
  currency: CurrencyCode
  legs: PricedLeg[]
  prices: LatestPrices
  markPrice: MarkPrice
  /** What one USD buys now, or null when USD is the currency, or there's no current rate. */
  latestRate: { rateMicros: string; blockNum: number } | null
  /** Transactions with an amount that couldn't be converted, so it's unavailable here. */
  missingRateTxs: string[]
}

/** The wallet as its own USD facts, whatever its currency. */
export function usdView(wallet: WalletResponse): WalletView {
  return { currency: "USD", legs: wallet.legs, prices: wallet.prices, markPrice: referenceMarks(wallet.references), latestRate: null, missingRateTxs: [] }
}

export function viewWallet(wallet: WalletResponse): WalletView {
  if (wallet.currency === "USD" || !wallet.rates) return usdView(wallet)
  const { rates } = wallet
  const answers = new Map<number, bigint | null>()
  const missingRateTxs = new Set<string>()

  const legs = wallet.legs.map((leg): PricedLeg => {
    const answer = usableAnswer(rates.byBlock[leg.blockNum], leg.timestamp)
    answers.set(leg.blockNum, answer)
    // Nothing to convert, like what a wallet already held at an unknown cost, so there's no rate to speak of.
    if (leg.priceMicros === null && leg.costMicros === null && leg.proceedsMicros === null) return leg
    const usd = { priceUsdMicros: leg.priceMicros, costUsdMicros: leg.costMicros, proceedsUsdMicros: leg.proceedsMicros }
    if (answer === null) {
      missingRateTxs.add(leg.txHash)
      return { ...leg, priceMicros: null, priceSource: null, costMicros: null, proceedsMicros: null, costLabel: "unknown", conversion: { ...usd, rateMicros: null } }
    }
    return {
      ...leg,
      priceMicros: convert(leg.priceMicros, answer),
      costMicros: convert(leg.costMicros, answer),
      proceedsMicros: convert(leg.proceedsMicros, answer),
      conversion: { ...usd, rateMicros: rateOf(answer) },
    }
  })

  const latest = usableAnswer(rates.latest?.round, wallet.latest.timestamp)
  const prices: LatestPrices = {}
  // Without a current rate, what's held has no current value in this currency. An old rate would quietly be wrong.
  if (latest !== null) {
    for (const [asset, price] of Object.entries(wallet.prices)) {
      if (price) prices[asset] = { ...price, micros: convert(price.micros, latest) as string, usdMicros: price.micros }
    }
  }

  const usdMark = referenceMarks(wallet.references)
  return {
    currency: wallet.currency,
    legs,
    prices,
    markPrice: (blockNum, asset) => {
      const answer = answers.get(blockNum)
      return answer ? convert(usdMark(blockNum, asset), answer) : null
    },
    latestRate: latest !== null && rates.latest ? { rateMicros: rateOf(latest), blockNum: rates.latest.blockNum } : null,
    missingRateTxs: [...missingRateTxs],
  }
}
