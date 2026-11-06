// The user's main currency, and what a purchase was paid in. The dataset and the legs stay in USD, and this is the one place that converts them.
//
// Each amount converts at the rate when it happened, not at today's: a purchase at 1.30 and a sale at the same USD price
// at 1.40 is a real gain in CAD. So this runs before the fold, which then adds up amounts that are already in CAD.
// A missing rate makes an amount null, which the fold already treats as unknown. It's never filled in from another day.

import { timestampOfBlock } from "./chain.ts"
import type { PricedLeg } from "./legs.ts"
import { referenceMarks, type LatestPrices, type MarkPrice } from "./portfolio.ts"
import type { WalletData } from "./wallet.ts"

export type CurrencyCode = "USD" | "CAD" | "EUR" | "GBP" | "CHF" | "AUD" | "NZD" | "SGD" | "MXN" | "BRL" | "TRY" | "ZAR"

export type Currency = {
  code: CurrencyCode
  name: string
  locale: string
  /** Printed by hand before amounts too small for Intl's two decimals. */
  symbol: string
  /** Printed instead of `symbol` beside amounts in another currency, where a bare "$" doesn't say which. */
  label: string
  /** Where Intl's own symbol for this currency is its code, it can still print the one people use. */
  narrow?: true
  /** Chainlink's feed on Base, answering USD for one unit with 8 decimals. USD doesn't need one. */
  feed: { address: string; pair: string; aggregators: readonly string[] } | null
}

/**
 * Adding a currency takes one line here and one in `Currency.swift`, plus a new version of the rates dataset (`node dataset/build.ts --rates`), since it only has these aggregators.
 * Each address is from Chainlink's own list for Base, and checked onchain: `description()`, `decimals()` and `aggregator()`.
 */
export const CURRENCIES: Record<CurrencyCode, Currency> = {
  USD: { code: "USD", name: "US dollar", locale: "en-US", symbol: "$", label: "US$", feed: null },
  CAD: { code: "CAD", name: "Canadian dollar", locale: "en-CA", symbol: "$", label: "CA$", feed: { address: "0xA840145F87572E82519d578b1F36340368a25D5d", pair: "CAD / USD", aggregators: ["0x9D779986f861810CadA370F04F524226d150fb7F"] } },
  EUR: { code: "EUR", name: "Euro", locale: "en-IE", symbol: "€", label: "€", feed: { address: "0xc91D87E81faB8f93699ECf7Ee9B44D11e1D53F0F", pair: "EUR / USD", aggregators: ["0x46ba9365C7CE12224504cF8581f061a6942f8516"] } },
  GBP: { code: "GBP", name: "British pound", locale: "en-GB", symbol: "£", label: "£", feed: { address: "0xCceA6576904C118037695eB71195a5425E69Fa15", pair: "GBP / USD", aggregators: ["0x2e46086480909c2049F372DE72Ba5a2fAB281eE9"] } },
  // en-US because Intl writes -0.50 as "CHF-0.50" in en-CH. The space is the no-break one Intl puts there.
  CHF: { code: "CHF", name: "Swiss franc", locale: "en-US", symbol: "CHF\u00a0", label: "CHF\u00a0", feed: { address: "0x3A1d6444fb6a402470098E23DaD0B7E86E14252F", pair: "CHF / USD", aggregators: ["0x61d85c6cCE419845c2DfC20130B4f120C10B2105"] } },
  AUD: { code: "AUD", name: "Australian dollar", locale: "en-AU", symbol: "$", label: "A$", feed: { address: "0x46e51B8cA41d709928EdA9Ae43e42193E6CDf229", pair: "AUD / USD", aggregators: ["0xBe5bC9c1d407a0D97C34A73FbA19118b478F427d"] } },
  NZD: { code: "NZD", name: "New Zealand dollar", locale: "en-NZ", symbol: "$", label: "NZ$", feed: { address: "0x06bdFe07E71C476157FC025d3cCD4BBe08e83EF9", pair: "NZD / USD", aggregators: ["0xf74260ed595B7e31829f6f32cAD273563949A4BB"] } },
  SGD: { code: "SGD", name: "Singapore dollar", locale: "en-SG", symbol: "$", label: "S$", feed: { address: "0x81575495532fB311Efc5C993B612564274F0949b", pair: "SGD / USD", aggregators: ["0x3860668e752604a6734e3d812E14DF14d2B3Ae48"] } },
  // Base also has an MXN feed with 18 decimals, for another product. This is the one with 8.
  MXN: { code: "MXN", name: "Mexican peso", locale: "es-MX", symbol: "$", label: "MX$", feed: { address: "0x9e8Ee77c76d4fa41306056D1C3196AF5da1600bd", pair: "MXN / USD", aggregators: ["0x84A0f5A767BD862bE27F6C8F07aCf6506b393370"] } },
  // en-US because pt-BR writes its decimals with a comma, and nothing else here does.
  BRL: { code: "BRL", name: "Brazilian real", locale: "en-US", symbol: "R$", label: "R$", feed: { address: "0x0b0E64c05083FdF9ED7C5D3d8262c4216eFc9394", pair: "BRL / USD", aggregators: ["0x70f3a88dfD546dE52D2cEA8733E4DecC5d58F5f0"] } },
  // Their own locales write decimals with a comma too, and en-US knows these two only by their codes without `narrow`.
  TRY: { code: "TRY", name: "Turkish lira", locale: "en-US", symbol: "₺", label: "₺", narrow: true, feed: { address: "0x29413773e7CD4Dfd6Ad89a50887877b88a6C592C", pair: "TRY / USD", aggregators: ["0x74Ec57bB8B8eb99e668c052c7F3c0c6e88d38Dec"] } },
  ZAR: { code: "ZAR", name: "South African rand", locale: "en-US", symbol: "R", label: "R", narrow: true, feed: { address: "0x2ecc8A8B370fC6a217166b2782a35339bEBEe98B", pair: "ZAR / USD", aggregators: ["0x1D292e75f586f4B2638b9C81300d58aD6299c0Da"] } },
}

export const CURRENCY_CODES = Object.keys(CURRENCIES) as CurrencyCode[]

/** What a portfolio can be shown in: every currency, for now. To keep one as only what something was paid in, leave it out here and in `Currency.swift`. */
export const MAIN_CURRENCY_CODES: readonly CurrencyCode[] = CURRENCY_CODES

export function isMainCurrency(value: string | null | undefined): value is CurrencyCode {
  return MAIN_CURRENCY_CODES.includes(value as CurrencyCode)
}

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

/** Each feed's answers at the blocks where something with a cost stored in that currency arrived or was already held, for reading it in another. */
export type PaidRates = Partial<Record<CurrencyCode, Rates["byBlock"]>>

/** What a client needs to convert a wallet. Blocks the feed had no answer for are left out. */
export type Rates = {
  byBlock: Record<string, RateRound>
  latest: { blockNum: number; round: RateRound } | null
}

/** Forex markets close for about 2 days a week. Feeds update hourly or daily, weekends included. Older than this, a feed has stopped. */
export const MAX_ROUND_AGE_SECONDS = 3 * 24 * 60 * 60

const E8 = 10n ** 8n
const E6 = 10n ** 6n

export function usableAnswer(round: RateRound | null | undefined, at: string): bigint | null {
  if (!round || !/^\d+$/.test(round.answer)) return null
  const answer = BigInt(round.answer)
  if (answer === 0n) return null
  return Date.parse(at) / 1000 - round.updatedAt > MAX_ROUND_AGE_SECONDS ? null : answer
}

const convert = (usdMicros: string | null, answer: bigint): string | null => (usdMicros === null ? null : ((BigInt(usdMicros) * E8) / answer).toString())

/** What one USD buys, in millionths of the currency. */
const rateOf = (answer: bigint) => ((E6 * E8) / answer).toString()

/**
 * What one USD buys now, in millionths of the currency, for showing what's held or typed right now. Null without a current
 * answer. An older rate would quietly be wrong, so there's never one standing in for it.
 */
export function currentRateMicros(rates: Rates | null | undefined, at: string): string | null {
  const answer = usableAnswer(rates?.latest?.round, at)
  return answer === null ? null : rateOf(answer)
}

/** A USD amount in the currency, at a rate from `currentRateMicros`. */
export function atCurrentRate(usdMicros: string, rateMicros: string): string {
  return ((BigInt(usdMicros) * BigInt(rateMicros)) / E6).toString()
}

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

/** Every oracle read a chart can mark to. A sample can be empty, so where a transaction has its own read at that block, that one wins. */
const readsOf = ({ references, priceSamples = [] }: Pick<WalletData, "references" | "priceSamples">) => [...priceSamples, ...references]

/** The wallet as its own USD facts, whatever its currency. */
export function usdView(wallet: WalletData): WalletView {
  return { currency: "USD", legs: wallet.legs, prices: wallet.prices, markPrice: referenceMarks(readsOf(wallet), wallet.marketMarks), latestRate: null, missingRateTxs: [] }
}

export function viewWallet(wallet: WalletData): WalletView {
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

  for (const { blockNum } of wallet.priceSamples ?? []) {
    if (!answers.has(blockNum)) answers.set(blockNum, usableAnswer(rates.byBlock[blockNum], timestampOfBlock(blockNum, wallet.latest)))
  }

  const latest = usableAnswer(rates.latest?.round, wallet.latest.timestamp)
  const prices: LatestPrices = {}
  // Without a current rate, what's held has no current value in this currency. An old rate would quietly be wrong.
  if (latest !== null) {
    for (const [asset, price] of Object.entries(wallet.prices)) {
      if (price) prices[asset] = { ...price, micros: convert(price.micros, latest) as string, usdMicros: price.micros }
    }
  }

  const usdMark = referenceMarks(readsOf(wallet), wallet.marketMarks)
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
