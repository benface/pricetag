// The tax report: one row per thing that may be taxable, in the user's currency, for an accountant or tax software.
// Pure, like the fold it runs on. The server calls it, so the web and Mac apps export the same file.
//
// Each row comes from what the fold did to a position. On a position with nothing unresolved, its gains add up to the
// Realized the apps show. With something unresolved, the apps leave out the whole position, and this keeps each row it
// knows. A gap stays a gap: a row that can't be worked out says "unknown", is never $0, and isn't in the gain total.
//
// What each country's defaults rest on, from official sources only:
// - Canada, average across all wallets: Income Tax Act s. 47(1) averages "identical properties" a taxpayer owns, and says
//   nothing about where they're held. CRA's guide T4037 says the same for property bought over time. CRA's crypto guide
//   doesn't spell this out for wallets, so that part is our reading, and an accountant should confirm it.
// - US, oldest first in each wallet: Treas. Reg. 1.1012-1(j), for dispositions from January 1, 2025. Average basis in
//   1.1012-1(e) only covers certain stock. Rev. Proc. 2024-28 and IRS digital asset FAQs cover the move to wallets.
// - UK, average across all wallets, after matching: HMRC's Cryptoassets Manual CRYPTO22200 gives the beneficial owner "a single
//   pooled asset" for each type of token (TCGA 1992 s. 104), whose cost is averaged, as CRYPTO22251 and HMRC's guidance "Check
//   if you need to pay tax when you sell cryptoassets" work out. A disposal is first matched to what was acquired the same day
//   and in the 30 days after, which `tax-matching.ts` does. That guidance also sets the tax year, 6 April to 5 April, and says
//   to report in pounds sterling.
//
// What something received from someone else costs, which decides whether its market price is a cost or an estimate:
// - Canada, the market price is the cost: Income Tax Act s. 69(1)(c) deems a gift acquired at fair market value, and
//   s. 52(1) adds what was included in income to the cost of what was received.
// - US, it depends: IRS digital asset FAQs Q59 makes fair market value the basis of what you were paid, but Q76 gives a
//   gift the giver's basis. We can't tell which it was, so it stays an estimate.
// - UK, it depends too: HMRC's guidance says what Income Tax was paid on isn't charged Capital Gains Tax again, but a gift's
//   cost depends on who gave it, so it stays an estimate.
// That only goes for what the user said came from someone else. A bridge or a mint could be their own money arriving from
// elsewhere, and CRA's crypto guide doesn't count moving between your own wallets as a disposition, so that keeps what they
// first paid, which we can't see. Those stay estimates in every country, and the report says why.

import { assertFoldFits, foldPositions, formatDuration, isAddress, markUnknownOrder, msBetweenBlocks, normalizeAddress, orderMatters, shortHash, timestampOfBlock, unreadAssets, viewWallet, worth, type CostPiece, type CurrencyCode, type KnownTaken, type LegEffect, type Method, type PriceSource, type PricedLeg, type WalletView } from "@pricetag/sdk/core"
import { hasStarted, isBehind, type TaxReportResponse, type WalletResponse } from "./api.ts"
import { emptyBook, linkedWallets, type Book } from "./book.ts"
import { csvCell, microsCell, unitsCell } from "./csv.ts"
import { rateSource } from "./explain.ts"
import { resolveLegs, withheldIn } from "./resolve.ts"
import { taxFormOf } from "./tax-forms.ts"
import { UK_TIME_ZONE, dayNumber, localDate, matchUk, startOfDate } from "./tax-matching.ts"
import { METHOD_LABELS, withheldSentence } from "./wording.ts"

export type TaxCountryCode = "CA" | "GB" | "US"
/** Whether cost is worked out across all of a person's wallets, or separately in each. */
export type TaxScope = "pooled" | "per-wallet"

export type TaxCountry = {
  code: TaxCountryCode
  name: string
  /** Its name in a sentence. */
  inSentence: string
  method: Method
  scope: TaxScope
  currency: CurrencyCode
  /** Said when the method is overridden, because the file may then not be what this country's rules call for. */
  methodWarning: string
  scopeWarning: string
  /** Whether a market price from when something arrived from someone else is its real cost here, rather than an estimate of it. */
  marketIsCost: boolean
  /** On a row that uses that price. */
  marketRowNote: string
  /** What that price means here, said once when any row uses it. */
  marketWarning: string
  /** What the report doesn't do for this country. */
  notes: string[]
  /** When its tax year starts, as MM-DD. A year that doesn't start on January 1 is named for the calendar year it starts in. */
  yearStart: string
  /** With Average, each sale is first matched to what was acquired the same day and in the 30 days after, as the UK does. */
  matchesAcquisitions: boolean
  /** Whose clock its days and tax year go by. UTC where the report hasn't been told otherwise, like the file's dates. */
  timeZone: string
  /** What a sentence calls that clock. */
  timeZoneName: string
}

/** Adding a country takes an entry here and a case in `TaxReport.swift`. */
export const TAX_COUNTRIES: Record<TaxCountryCode, TaxCountry> = {
  CA: {
    code: "CA",
    name: "Canada",
    inSentence: "Canada",
    method: "average",
    scope: "pooled",
    currency: "CAD",
    methodWarning: "Canada's rules average the cost of identical property, so Oldest first may not be accepted.",
    scopeWarning: "Canada's rules average what you own wherever it's held, so calculating each wallet on its own may not be accepted.",
    marketIsCost: true,
    marketRowNote: "Part of its cost is what it was worth when it arrived, which is generally the cost of what you're paid or given in Canada.",
    marketWarning: "In Canada, that's generally the cost of what you're paid or given.",
    notes: [
      "A loss can be denied if the same asset is acquired within 30 days before or after selling it, and still held 30 days after (a superficial loss). This report flags those it finds in these wallets, but can't see a spouse's or a company you control, which count too, or when something that arrived from elsewhere was bought unless an exchange file says. It doesn't change any amount.",
      "Every gain here is shown in full, as if it's capital. Canada generally taxes half of a capital gain, and frequent trading can count as business income instead.",
    ],
    yearStart: "01-01",
    matchesAcquisitions: false,
    timeZone: "UTC",
    timeZoneName: "UTC",
  },
  GB: {
    code: "GB",
    name: "United Kingdom",
    inSentence: "the UK",
    method: "average",
    scope: "pooled",
    currency: "GBP",
    methodWarning: "UK rules match each sale to what was bought the same day or in the 30 days after, and average the cost of the rest, so Oldest first may not be accepted.",
    scopeWarning: "UK rules average the cost of each kind of token you own, wherever it's held, so calculating each wallet on its own may not be accepted.",
    marketIsCost: false,
    marketRowNote: "If it was pay you paid Income Tax on, that price is generally its cost. A gift's cost depends on who gave it.",
    marketWarning: "In the UK, that's generally the cost of pay you paid Income Tax on, but a gift's cost depends on who gave it.",
    notes: [
      "With Average, each sale is matched first to what was bought the same day, then to what was bought in the 30 days after it, earliest first, and only then to the average cost of the rest, as HMRC's rules say. A network fee is matched the same way, since paying one is a disposal.",
      "Days and the tax year go by UK time, so something done just after midnight during British Summer Time is on the day it was in the UK. The file's dates are in UTC.",
      "What came from an exchange is matched by when its file says each part was bought, oldest first, so a buy still on the exchange isn't matched to anything.",
      "A gift is a disposal at its market value unless it's to your spouse or civil partner. Sends to other addresses aren't matched to anything, and stay in the full report for you to say what they were.",
      "Every gain here is shown in full. The yearly tax-free allowance and losses from other years aren't taken off.",
      "Self Assessment returns have a section for cryptoassets from the 2024 to 2025 tax year on, which takes amounts in pounds sterling.",
    ],
    yearStart: "04-06",
    matchesAcquisitions: true,
    timeZone: UK_TIME_ZONE,
    timeZoneName: "UK time",
  },
  US: {
    code: "US",
    name: "United States",
    inSentence: "the US",
    method: "fifo",
    scope: "per-wallet",
    currency: "USD",
    methodWarning: "US rules use oldest first in each wallet unless you identify specific units, so Average may not be accepted.",
    scopeWarning: "US rules have tracked cost wallet by wallet since January 1, 2025, so calculating all wallets together may not be accepted.",
    marketIsCost: false,
    marketRowNote: "If it was pay, that price is its cost. If it was a gift, its cost is generally the giver's.",
    marketWarning: "In the US, that's the cost of what you're paid, but a gift generally keeps the giver's cost.",
    notes: [
      "The Form 8949 file gives the date each sold unit was acquired, and splits short-term from long-term gains, which only works with Oldest first.",
      "Choosing specific units to sell isn't available yet.",
      "The wash sale rule in section 1091 of the tax code covers stock and securities, and this report doesn't check for it. Ask an accountant whether it applies to crypto in your year.",
    ],
    yearStart: "01-01",
    matchesAcquisitions: false,
    timeZone: "UTC",
    timeZoneName: "UTC",
  },
}

export const TAX_COUNTRY_CODES = Object.keys(TAX_COUNTRIES) as TaxCountryCode[]

export function isTaxCountryCode(value: string | null | undefined): value is TaxCountryCode {
  return TAX_COUNTRY_CODES.includes(value as TaxCountryCode)
}

export const SCOPE_LABELS: Record<TaxScope, string> = { pooled: "All wallets together", "per-wallet": "Each wallet on its own" }

export const TAX_DISCLAIMER = "Not tax advice. Rules differ by country and change over time, so check this with an accountant before relying on it."

const COMMON_NOTES = [
  "Network fees are their own rows, because paying one in ETH counts as selling that ETH. They aren't added to what you bought or taken off what you sold, which an accountant may want to adjust.",
  "The gain total adds up every row it knows. Realized in the app leaves out a whole asset when any of its sales is unknown, so the two can differ.",
  "What you received isn't listed. Some of it, like pay or rewards, may be income when it arrives.",
  "What arrives from a bridge or is newly created counts at its market price when it arrived, as an estimate. If it was your own, moved from elsewhere, its cost is what you first paid.",
]

const PRICE_SOURCE_LABELS: Record<PriceSource, string> = { oracle: "Market price feed (Chainlink)", swap: "This exchange", market: "Market price" }

export type TaxRowStatus = "resolved" | "estimated" | "self-reported" | "unresolved"

export type TaxRow = {
  blockNum: number
  txIndex: number
  timestamp: string
  type: "Sold" | "Network fee" | "Sent"
  asset: string
  /** In the token's smallest unit. */
  amount: string
  decimals: number
  /** null is unknown, which is never 0. */
  proceedsMicros: string | null
  costMicros: string | null
  gainMicros: string | null
  priceSource: PriceSource | null
  status: TaxRowStatus
  /** Why it's estimated, self-reported or unresolved, or where a known cost came from when that needs saying. */
  reason: string | null
  /** Part of its cost is a market price for what the user said came from someone else. */
  givenCost: boolean
  wallet: string
  txHash: string
  /**
   * What a known cost was paid for, piece by piece, with when each piece was acquired. null when it can't be split that way:
   * an average mixes every purchase together, and a row with no known cost has nothing to split.
   */
  acquired: Acquired[] | null
  /** A loss that a country's rules may not let you deduct. Missing means none was found. */
  lossRule?: LossRule
}

/** Part of what a sale took, with its cost and when it was acquired, or null when nothing says. */
export type Acquired = { qty: string; costMicros: string; at: string | null }

/** superficial: bought again within 30 days and still held after them. maybe: bought again, but the 30 days after aren't all read yet. */
export type LossRule = "superficial" | "maybe-superficial"

const UNKNOWN_COST = "What this cost isn't known. It was in the wallet before the first block read, or arrived from another address."
const INCOMPLETE_HISTORY = "More of this left than was seen arriving, so part of its history is missing."
const UNKNOWN_PROCEEDS = "What this sold for isn't known."
const NO_RATE = "There's no exchange rate at this block, so this can't be shown in this currency."
const NO_GAS_PRICE = "ETH had no price at this block."
const SENT = "Sent to another address, so it's not counted as a sale. If that's your own wallet, add it to this report. If it paid for something or was a gift, it's generally taxable."
const ESTIMATED_COST = "Part of its cost is an estimate, from a market price or an exchange rate."
const ESTIMATED_PROCEEDS = "What it sold for is an estimate, from a market price."
const ESTIMATED_BOTH = "What it sold for and part of its cost are estimates, from market prices or exchange rates."
const REPORTED_COST = "Part of its cost is what you entered or imported, which the chain can't confirm."
const purchasedCost = (sources: readonly string[]) => `Some or all of its cost: ${sources.length === 1 ? sources[0] : "several exchange purchases"}, fees included.`
const MISMATCH = "This asset's history doesn't match its onchain balance, so its cost can't be trusted."
const UNCHECKED = "This asset hasn't been checked against its onchain balance yet, so its cost isn't shown."
const DIFFERENT_STARTS = "These wallets' histories start at different blocks, so their costs can't be worked out together."

/**
 * The pieces of known cost a debit took, oldest first, with each one's date: an exchange's purchase date when there is one,
 * since that's when it was bought, and otherwise when it reached a wallet, which an inherited piece keeps from the wallet
 * that sent it. When it reached a wallet is only its date if it was acquired then. An opening balance, or something that
 * arrived with a cost someone entered and no purchase date, has none, which the fold marks as `undated`. Only oldest first
 * keeps pieces apart, and only when they add up to the cost the row shows.
 */
function acquiredOf({ before, taken }: LegEffect, knownCost: bigint, knownQty: bigint): Acquired[] | null {
  if (before.method !== "fifo" || knownQty <= 0n || taken === null) return null
  const known = taken.filter((piece) => piece.costMicros !== null)
  const sum = (field: "qty" | "costMicros") => known.reduce((total, piece) => total + BigInt(piece[field] as string), 0n)
  if (sum("costMicros") !== knownCost || sum("qty") !== knownQty) return null
  return known.map((piece) => ({ qty: piece.qty, costMicros: piece.costMicros as string, at: piece.undated ? null : piece.boughtAt || piece.acquiredAt || null }))
}

/** The rows a debit becomes: a sale with both a known and an unknown cost splits, so the known part still adds up. */
function rowsOf(effect: LegEffect, wallet: string, unconfirmed: string | null, country: TaxCountry | null): TaxRow[] {
  const { leg, before, after } = effect
  const delta = BigInt(leg.delta)
  if (delta >= 0n) return []
  const qty = -delta
  // A lot with a cost only for all of it has none once part of it goes, so that cost isn't what this took. The fold left it out.
  const known = effect.known as KnownTaken
  // What it took has no known cost, whatever its lots say, when that depends on an order nothing says.
  const orderless = orderMatters(leg, before.method)
  const knownCost = orderless ? 0n : BigInt(known.costMicros)
  const unknownQty = orderless ? qty : qty - BigInt(known.qty)
  const row = (fields: Pick<TaxRow, "amount" | "proceedsMicros" | "costMicros" | "gainMicros" | "status" | "reason"> & { givenCost?: boolean; acquired?: Acquired[] | null }): TaxRow => ({
    givenCost: false,
    acquired: null,
    blockNum: leg.blockNum,
    txIndex: leg.txIndex,
    timestamp: leg.timestamp,
    type: leg.kind === "gas" ? "Network fee" : leg.kind === "transfer" ? "Sent" : "Sold",
    asset: leg.asset,
    decimals: leg.decimals,
    priceSource: leg.priceSource,
    wallet,
    txHash: leg.txHash,
    ...fields,
  })
  const amount = qty.toString()
  // Only a cost that's all there can be shown, and only on an asset the chain has confirmed.
  const wholeCost = unknownQty === 0n && unconfirmed === null ? knownCost.toString() : null
  const acquired = unconfirmed === null && !orderless ? acquiredOf(effect, knownCost, qty - unknownQty) : null

  if (leg.kind === "transfer") return [row({ amount, proceedsMicros: null, costMicros: wholeCost, gainMicros: null, status: "unresolved", reason: SENT })]

  const proceeds = leg.kind === "gas" ? (leg.priceMicros === null ? null : worth(qty, BigInt(leg.priceMicros), leg.decimals)) : leg.proceedsMicros === null ? null : BigInt(leg.proceedsMicros)
  if (proceeds === null) {
    const noRate = leg.conversion?.rateMicros === null
    return [row({ amount, proceedsMicros: null, costMicros: wholeCost, gainMicros: null, status: "unresolved", reason: noRate ? NO_RATE : leg.kind === "gas" ? NO_GAS_PRICE : UNKNOWN_PROCEEDS, acquired: wholeCost === null ? null : acquired })]
  }
  if (unconfirmed !== null) return [row({ amount, proceedsMicros: proceeds.toString(), costMicros: null, gainMicros: null, status: "unresolved", reason: unconfirmed })]

  const rows: TaxRow[] = []
  const resolvedQty = BigInt(after.resolvedDisposedQty) - BigInt(before.resolvedDisposedQty)
  const gain = BigInt(after.realizedMicros) - BigInt(before.realizedMicros)
  const resolvedProceeds = resolvedQty > 0n ? gain + knownCost : 0n
  if (resolvedQty > 0n) {
    const given = BigInt(known.givenMicros)
    const costIsEstimated = BigInt(known.estimatedMicros) - (country?.marketIsCost ? given : 0n) > 0n
    const proceedsAreEstimated = leg.estimated === true && resolvedProceeds > 0n
    // By units rather than dollars, because $0 is a cost someone can enter.
    const reported = BigInt(known.reportedQty) > 0n
    const estimate = costIsEstimated && proceedsAreEstimated ? ESTIMATED_BOTH : costIsEstimated ? ESTIMATED_COST : proceedsAreEstimated ? ESTIMATED_PROCEEDS : null
    const purchased = BigInt(known.purchasedQty) > 0n && known.purchaseSources.length > 0 ? purchasedCost(known.purchaseSources) : null
    const reason = [estimate, given > 0n ? (country?.marketRowNote ?? null) : null, reported ? REPORTED_COST : null, purchased].filter((note) => note !== null).join(" ")
    rows.push(row({ amount: resolvedQty.toString(), proceedsMicros: resolvedProceeds.toString(), costMicros: knownCost.toString(), gainMicros: gain.toString(), status: estimate ? "estimated" : reported ? "self-reported" : "resolved", reason: reason || null, givenCost: given > 0n, acquired }))
  }
  if (unknownQty > 0n) {
    const short = BigInt(after.shortfallQty) > BigInt(before.shortfallQty)
    rows.push(row({ amount: unknownQty.toString(), proceedsMicros: (proceeds - resolvedProceeds).toString(), costMicros: null, gainMicros: null, status: "unresolved", reason: short ? INCOMPLETE_HISTORY : UNKNOWN_COST }))
  }
  return rows
}

type Source = { wallet: WalletResponse; view: WalletView; unconfirmed: Map<string, string>; unread: string[] }

/** What the chain can't back up in a wallet. Balances only depend on amounts, so this doesn't need the answers. */
function checksOf(wallet: WalletResponse, view: WalletView, method: Method): Pick<Source, "unconfirmed" | "unread"> {
  const positions = foldPositions(view.legs, method, view.prices, wallet)
  const unconfirmed = new Map<string, string>()
  for (const { asset, reconciliation } of positions) {
    if (reconciliation && reconciliation.status !== "reconciled") unconfirmed.set(asset, reconciliation.status === "incomplete" ? MISMATCH : UNCHECKED)
  }
  return { unconfirmed, unread: unreadAssets(positions, wallet) }
}

/** What else goes into a report: the user's answers, and wallets whose costs it needs but whose rows it doesn't list. */
export type TaxContext = { book?: Book; costsFrom?: readonly WalletResponse[] }

/**
 * Each wallet with what the user has said filled in, the same way the apps do it. The wallets in a report are the user's
 * own, because that's what asking for them together says, so costs carry between them whatever else has been answered.
 */
function sourcesOf(wallets: readonly WalletResponse[], method: Method, { book = emptyBook(), costsFrom = [] }: TaxContext, country: TaxCountry | null = null): Source[] {
  const sides = [...wallets, ...costsFrom].map((wallet) => {
    const view = viewWallet(wallet)
    return { wallet, view, ...checksOf(wallet, view, method) }
  })
  const linking = wallets.length > 1 ? { ...book, linked: [...(book.linked ?? []), ...wallets.map((wallet) => wallet.address.toLowerCase())] } : book
  // Working out what each inherits walks every lot, so a fold that can't fit stops here, before any of that.
  const histories = sides.map(({ wallet }) => ({ address: normalizeAddress(wallet.address), legs: wallet.legs }))
  for (const history of histories.slice(0, wallets.length)) assertFoldFits(history, histories.filter((other) => other !== history), method)
  // Matching needs to know when what an exchange withdrew was bought, and what each purchase cost, not only its average.
  const { legs } = resolveLegs(sides, method, linking, { datedLots: method === "average" && country?.matchesAcquisitions === true })
  return sides.slice(0, wallets.length).map((side) => ({ ...side, view: { ...side.view, legs: legs.get(normalizeAddress(side.wallet.address)) as PricedLeg[] } }))
}

const moveKey = (leg: PricedLeg) => `${leg.txHash}:${leg.asset}`

/** ETH found from a balance is never one wallet's transfer to another, whichever transaction is named. */
const canBeMove = (leg: PricedLeg) => leg.kind === "transfer" && !leg.opening && !leg.parts.some((part) => part.kind === "unseen_eth")

/**
 * Transfers that only went from one of these wallets to another: the same transaction and asset, netting to nothing.
 * Moving between your own wallets isn't a sale in either country. A move that loses some on the way isn't one of these.
 */
export function movesBetween(sources: readonly Pick<Source, "wallet" | "view">[]): Set<string> {
  const moves = new Map<string, { net: bigint; wallets: Set<string> }>()
  for (const { wallet, view } of sources) {
    for (const leg of view.legs) {
      if (!canBeMove(leg)) continue
      const move = moves.get(moveKey(leg)) ?? { net: 0n, wallets: new Set<string>() }
      move.net += BigInt(leg.delta)
      move.wallets.add(wallet.address)
      moves.set(moveKey(leg), move)
    }
  }
  return new Set([...moves].filter(([, { net, wallets }]) => net === 0n && wallets.size > 1).map(([key]) => key))
}

export const isMove = (leg: PricedLeg, moves: ReadonlySet<string>) => canBeMove(leg) && moves.has(moveKey(leg))

/** Whether anything arrived from one of these wallets with a cost that still isn't all known. */
const hasUnknownMove = (sources: readonly Source[], moves: ReadonlySet<string>) => sources.some(({ view }) => view.legs.some((leg) => isMove(leg, moves) && BigInt(leg.delta) > 0n && leg.costMicros === null))

/**
 * What can be worked out across wallets. Each wallet is read up to its own block, so one can have sales another has
 * no purchases for yet, and a pool that mixed them would show a wrong cost as if it were known. So a pool stops at the
 * last block every wallet has reached. A pool also needs the same first block: before a wallet's first block, its
 * holdings and sales aren't in the pool, which changes what everyone else's sales took.
 */
function poolOf(sources: readonly Source[]) {
  const through = Math.min(...sources.map(({ wallet }) => wallet.coverage.toBlock))
  const sameStart = new Set(sources.map(({ wallet }) => wallet.coverage.fromBlock)).size === 1
  const pending = new Set<string>()
  const within = sources.map((source) => ({
    ...source,
    view: {
      ...source.view,
      legs: source.view.legs.filter((leg) => {
        if (leg.opening || leg.blockNum <= through) return true
        pending.add(leg.txHash)
        return false
      }),
    },
  }))
  return { through, sameStart, within, pendingTxs: pending.size }
}

function poolLegs(sources: readonly Source[], moves: ReadonlySet<string>): { legs: PricedLeg[]; walletOf: Map<PricedLeg, string> } {
  const walletOf = new Map<PricedLeg, string>()
  for (const { wallet, view } of sources) for (const leg of view.legs) if (!isMove(leg, moves)) walletOf.set(leg, wallet.address)
  // Each wallet's legs are already in order, and this sort is stable, so that order holds inside a transaction.
  const sorted = [...walletOf.keys()].sort((a, b) => a.blockNum - b.blockNum || a.txIndex - b.txIndex)
  // One wallet can't see what another's unseen ETH does to their shared order.
  const legs = markUnknownOrder(sorted)
  return { legs, walletOf: new Map(legs.map((leg, i) => [leg, walletOf.get(sorted[i] as PricedLeg) as string])) }
}

const DAY_MS = 86_400_000

/** A UTC date, `days` from this time's, as YYYY-MM-DD, which sorts as text. */
const dayOf = (timestamp: string, days = 0) => new Date(Date.parse(timestamp.slice(0, 10)) + days * DAY_MS).toISOString().slice(0, 10)

/**
 * When what a credit brought was acquired, as far as anything says: when it was bought here, paid for on its way in or received,
 * the dates an exchange gives for what it withdrew, or when another of the user's wallets acquired it. Something that arrived from elsewhere with no such date, through a bridge too, says nothing, and an
 * opening balance was already held, so neither is evidence of acquiring more.
 */
function acquisitionDates(leg: PricedLeg): string[] {
  const here = !leg.opening && (leg.kind === "swap" || leg.costLabel === "paid" || leg.costLabel === "received at market")
  if (!leg.pieces) return here ? [leg.timestamp] : []
  // A piece from another of the user's wallets keeps when it was first acquired there, if anything says.
  const dateOf = (piece: CostPiece) => piece.boughtAt || (piece.acquiredAt && !piece.undated ? piece.acquiredAt : null) || (!leg.opening && !piece.undated && (leg.kind === "swap" || piece.label === "paid" || piece.label === "received at market") ? leg.timestamp : null)
  return leg.pieces.map(dateOf).filter((at) => at !== null)
}

const SUPERFICIAL = "More of it was acquired within 30 days of this loss, and some was still held 30 days after, so this may be a superficial loss, which can't be deducted. It's usually added to the cost of what was acquired instead."
const MAYBE_SUPERFICIAL = "More of it was acquired within 30 days of this loss, and the 30 days after haven't all been read yet, so this may turn out to be a superficial loss."

/**
 * Canada's superficial loss rule, from CRA's guide T4037: a loss can't be deducted when identical property is acquired in the
 * 30 calendar days before or after the sale, and is still held 30 calendar days after it. This only sees the wallets in the
 * report, not a spouse's or a company's, which the rule also counts. It flags rows and changes no amount.
 */
export function flagSuperficialLosses(rows: TaxRow[], sources: readonly Pick<Source, "wallet" | "view">[], book: Book = emptyBook()): void {
  const moves = movesBetween(sources)
  const legs = sources.flatMap(({ view }) => view.legs)
  // What an exchange file says was bought there and later withdrawn. Buying it there is acquiring it, whenever it's withdrawn, and
  // whichever method the report uses, which decides whether the wallet's legs carry those dates.
  const exchangeBuys = book.withdrawals.flatMap(({ asset, fifoLots }) => (fifoLots ?? []).flatMap(({ at }) => (at ? [{ asset, at }] : [])))
  // The last moment every wallet has been read through, since a balance after that could still change.
  const readThrough = sources.map(({ wallet }) => timestampOfBlock(wallet.coverage.toBlock, wallet.latest)).reduce((a, b) => (a < b ? a : b))
  for (const row of rows) {
    if (row.gainMicros === null || BigInt(row.gainMicros) >= 0n || row.type === "Sent") continue
    const [from, to] = [dayOf(row.timestamp, -30), dayOf(row.timestamp, 30)]
    const within = (at: string) => dayOf(at) >= from && dayOf(at) <= to
    const acquiredAgain =
      legs.some((leg) => leg.asset === row.asset && BigInt(leg.delta) > 0n && leg.txHash !== row.txHash && !isMove(leg, moves) && acquisitionDates(leg).some(within)) || exchangeBuys.some((buy) => buy.asset === row.asset && within(buy.at))
    if (!acquiredAgain) continue
    // Held at the end of the 30th day, across every wallet here. Moves between them add up to nothing.
    const end = `${to}T23:59:59.999Z`
    if (readThrough < end) row.lossRule = "maybe-superficial"
    else if (legs.filter((leg) => leg.asset === row.asset && (leg.opening || leg.timestamp <= end)).reduce((sum, leg) => sum + BigInt(leg.delta), 0n) > 0n) row.lossRule = "superficial"
    if (row.lossRule) row.reason = [row.reason, row.lossRule === "superficial" ? SUPERFICIAL : MAYBE_SUPERFICIAL].filter(Boolean).join(" ")
  }
}

export type TaxSettings = { country: TaxCountryCode; method: Method; scope: TaxScope }

/** A calendar year, the newest one there's history for, or everything. */
export type TaxYear = number | "latest" | "all"

export function parseTaxYear(value: unknown): TaxYear | null {
  if (value === undefined || value === null || value === "all") return "all"
  if (value === "latest") return value
  const year = typeof value === "string" && /^\d{4}$/.test(value) ? Number(value) : value
  return typeof year === "number" && Number.isInteger(year) && year >= 2000 && year <= 2999 ? year : null
}

type YearRules = Pick<TaxCountry, "yearStart" | "timeZone">

/** The tax year something happened in, named for the calendar year it starts in, by the date where it's filed. */
export function taxYearOf(timestamp: string, { yearStart, timeZone }: YearRules = { yearStart: "01-01", timeZone: "UTC" }): number {
  const date = localDate(timestamp, timeZone)
  const year = Number(date.slice(0, 4))
  return date.slice(5, 10) < yearStart ? year - 1 : year
}

const yearStartOf = (year: number, { yearStart, timeZone }: YearRules) => startOfDate(`${year}-${yearStart}`, timeZone)

/** What a year is called where it's filed: 2025, or 2025 to 2026 for one that starts in April, the way HMRC writes it. */
export const yearLabel = (year: number, { yearStart }: Pick<TaxCountry, "yearStart">) => (yearStart === "01-01" ? String(year) : `${year} to ${year + 1}`)

/** In a sentence, with its dates when they aren't a calendar year's. */
function yearInSentence(year: number, country: TaxCountry): string {
  if (country.yearStart === "01-01") return String(year)
  const end = new Date(Date.parse(yearStartOf(year + 1, country)) - 1).toISOString()
  return `the ${yearLabel(year, country)} tax year (${longDate(yearStartOf(year, country), country.timeZone)} to ${longDate(end, country.timeZone)})`
}

/** When the last of these wallets' history starts, since a year is only whole once every wallet's is. */
function historyStart(wallets: readonly WalletResponse[]): string {
  return wallets.map((wallet) => timestampOfBlock(wallet.coverage.fromBlock, wallet.latest)).reduce((a, b) => (a > b ? a : b))
}

/** Every tax year with some history, newest first. */
function yearsOf(wallets: readonly WalletResponse[], country: TaxCountry): number[] {
  const first = Math.min(...wallets.map((wallet) => taxYearOf(timestampOfBlock(wallet.coverage.fromBlock, wallet.latest), country)))
  const last = Math.max(...wallets.map((wallet) => taxYearOf(wallet.latest.timestamp, country)))
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => last - i)
}

const longDate = (timestamp: string, timeZone = "UTC") => new Date(timestamp).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone })

/** Said plainly when a year's history isn't all here, because what's missing would change its gains. */
function partialYearNote(year: number, start: string, country: TaxCountry): string | null {
  const startYear = taxYearOf(start, country)
  const named = yearInSentence(year, country)
  if (startYear > year) return `Records start on ${longDate(start, country.timeZone)}, so nothing from ${named} is here.`
  if (startYear === year && start > yearStartOf(year, country)) return `Records start on ${longDate(start, country.timeZone)}, so ${named} is missing everything before then.`
  return null
}

/**
 * A sale, fee or send split into a known and an unknown part is two rows in the file, and still one thing that happened.
 * The same leg is always the same wallet, transaction, kind and asset.
 */
const eventKey = (row: TaxRow) => `${row.wallet}:${row.txHash}:${row.type}:${row.asset}`

/** What happened, counted once each, with whether any part of it has an unknown gain. */
function eventsOf(rows: readonly TaxRow[]): Map<string, { type: TaxRow["type"]; wallet: string; unknown: boolean }> {
  const events = new Map<string, { type: TaxRow["type"]; wallet: string; unknown: boolean }>()
  for (const row of rows) {
    const event = events.get(eventKey(row)) ?? { type: row.type, wallet: row.wallet, unknown: false }
    event.unknown ||= row.gainMicros === null
    events.set(eventKey(row), event)
  }
  return events
}

/** What the app shows of the file before it's saved. */
export type TaxPreviewRow = Pick<TaxRow, "timestamp" | "type" | "asset" | "amount" | "decimals" | "gainMicros" | "status">

const PREVIEW_ROWS = 5

const LATER_BUYS = "Part of its cost is what was bought in the 30 days after it, which UK rules match to it first."
const TENTATIVE = {
  day: "The rest of its day hasn't been read yet, and everything bought that day counts as one purchase, at that day's average cost, which UK rules match to it first, so its cost may still change.",
  "30 days": "The 30 days after it haven't all been read yet, and what's bought in them would be matched to it first, so its cost may still change.",
} as const
const TENTATIVE_NOTES: readonly string[] = Object.values(TENTATIVE)

/** The last whole day read, since a balance after that could still change. */
const readThroughOf = (sources: readonly Pick<Source, "wallet">[]) => sources.map(({ wallet }) => timestampOfBlock(wallet.coverage.toBlock, wallet.latest)).reduce((a, b) => (a < b ? a : b))

/** Each debit's effect, by asset: the fold's, or under the UK's matching rules, with what that says about each one. */
function effectsOf(legs: readonly PricedLeg[], method: Method, country: TaxCountry | null, readThrough: string): { asset: string; effects: { leg: PricedLeg; effect: LegEffect; notes: string[] }[] }[] {
  if (method === "average" && country?.matchesAcquisitions) {
    return matchUk(legs, dayNumber(readThrough, country.timeZone) - 1, country.timeZone).map(({ asset, effects }) => ({ asset, effects: effects.map(({ leg, effect, laterBuys, tentative }) => ({ leg, effect, notes: [...(laterBuys ? [LATER_BUYS] : []), ...(tentative ? [TENTATIVE[tentative]] : [])] })) }))
  }
  return foldPositions(legs, method, {}).map(({ asset, effects }) => ({ asset, effects: effects.map((effect) => ({ leg: effect.leg, effect, notes: [] })) }))
}

function rowsFrom(sources: readonly Source[], method: Method, scope: TaxScope, country: TaxCountry | null): TaxRow[] {
  const rows: TaxRow[] = []
  const add = (made: TaxRow[], notes: readonly string[]) => {
    for (const row of made) rows.push(notes.length === 0 ? row : { ...row, reason: [row.reason, ...notes].filter(Boolean).join(" ") })
  }
  if (scope === "pooled") {
    const { sameStart, within } = poolOf(sources)
    const { legs, walletOf } = poolLegs(within, movesBetween(within))
    // What one wallet can't confirm leaves its share of the pool unknown, and that touches every sale of the asset.
    const unconfirmed = new Map(sources.flatMap(({ wallet, unconfirmed, unread }) => [...[...unread, ...wallet.openingUnread].map((asset) => [asset, UNCHECKED] as [string, string]), ...unconfirmed]))
    for (const position of effectsOf(legs, method, country, readThroughOf(sources))) {
      const reason = sameStart ? (unconfirmed.get(position.asset) ?? null) : DIFFERENT_STARTS
      for (const { leg, effect, notes } of position.effects) add(rowsOf(effect, walletOf.get(leg) as string, reason, country), notes)
    }
  } else {
    const moves = movesBetween(sources)
    for (const source of sources) {
      const { wallet, view, unconfirmed } = source
      for (const position of effectsOf(view.legs, method, country, readThroughOf([source]))) {
        for (const { leg, effect, notes } of position.effects) {
          if (!isMove(leg, moves)) add(rowsOf(effect, wallet.address, unconfirmed.get(position.asset) ?? null, country), notes)
        }
      }
    }
  }
  const feeFirst = (row: TaxRow) => (row.type === "Network fee" ? 0 : 1)
  return rows.sort((a, b) => a.blockNum - b.blockNum || a.txIndex - b.txIndex || feeFirst(a) - feeFirst(b))
}

/** Every row, oldest first, with a transaction's fee before what it did, the way the fold reads them. */
export function taxRows(wallets: readonly WalletResponse[], { method, scope, country }: Pick<TaxSettings, "method" | "scope"> & { country?: TaxCountryCode }, context: TaxContext = {}): TaxRow[] {
  const rules = country ? TAX_COUNTRIES[country] : null
  return rowsFrom(sourcesOf(wallets, method, context, rules), method, scope, rules)
}

const walletWords = (text: string) => text.split(/[\s,]+/).filter(Boolean)

/**
 * The wallets someone typed in, and the first that can't be one. The demo wallet can't be combined with anything, so
 * what's saved from another wallet is ignored there: it mustn't block a report whose field for fixing it isn't shown.
 */
export function readOtherWallets(text: string, address: string): { others: string[]; bad: string | null } {
  if (address === "demo") return { others: [], bad: null }
  const others = walletWords(text)
  return { others: others.map((other) => other.toLowerCase()), bad: others.find((other) => !isAddress(other)) ?? null }
}

/** What's worth keeping of that text: only its addresses, so anything pasted there by mistake isn't saved. */
export function savedOtherWallets(text: string): string {
  return [...new Set(walletWords(text).filter(isAddress).map((other) => other.toLowerCase()))].join("\n")
}

/** "Canada, the UK and the US". */
const listOf = (items: readonly string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`)

/** What the file calls the method, which says when sales are matched before anything is averaged. */
const methodLabelOf = (method: Method, country: TaxCountry) => (method === "average" && country.matchesAcquisitions ? "Same day, then 30 days, then average" : METHOD_LABELS[method])

const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`

function walletWarnings(source: Source, named: boolean): string[] {
  const { wallet, view, unread } = source
  const who = named ? `${shortHash(wallet.address)}: ` : ""
  const lines: string[] = []
  if (wallet.mode === "demo") lines.push("Demo data, not a real wallet.")
  if (!hasStarted(wallet)) lines.push(`${who}The data hasn't reached this wallet's first block yet, so nothing from it is here.`)
  else if (isBehind(wallet)) lines.push(`${who}The data is ${plural(wallet.latest.blockNum - wallet.coverage.toBlock, "block")} behind the chain, so the newest transactions aren't here yet.`)
  if (wallet.gasUnknownTxs.length > 0) lines.push(`${who}Network fees couldn't be worked out for ${plural(wallet.gasUnknownTxs.length, "transaction")}, so they aren't here.`)
  if (wallet.l1FeeUnknownTxs.length > 0) lines.push(`${who}Part of the network fee couldn't be read yet for ${plural(wallet.l1FeeUnknownTxs.length, "transaction")}, so those fees are low.`)
  if (wallet.openingUnread.length > 0) lines.push(`${who}What the wallet already held couldn't all be read yet (${wallet.openingUnread.join(", ")}).`)
  if (unread.length > 0) lines.push(`${who}Balances couldn't be read for ${unread.join(", ")}, so they may be missing from this report.`)
  if (view.missingRateTxs.length > 0) lines.push(`${who}${plural(view.missingRateTxs.length, "transaction")} had no exchange rate to ${view.currency}, so what depends on them is unknown.`)
  return lines
}

function coverageNote({ wallet }: Source, named: boolean): string {
  const { fromBlock, toBlock } = wallet.coverage
  const span = toBlock >= fromBlock ? ` (about ${formatDuration(msBetweenBlocks(fromBlock, toBlock))})` : ""
  return `${named ? `${shortHash(wallet.address)} covers` : "Covers"} blocks ${fromBlock.toLocaleString("en-US")} to ${toBlock.toLocaleString("en-US")}${span}. Anything earlier isn't here, and tokens off the tracked list aren't counted.`
}

const money = (micros: string | null) => (micros === null ? "unknown" : microsCell(micros))

const STATUS_LABELS: Record<TaxRowStatus, string> = { resolved: "OK", estimated: "ESTIMATED", "self-reported": "SELF-REPORTED", unresolved: "UNKNOWN GAIN" }

const CSV_HEADER = ["Date (UTC)", "Type", "Asset", "Amount", "Proceeds", "Cost", "Gain", "Currency", "Method", "Calculation", "Price source", "Status", "Notes", "Wallet", "Transaction"]

/** Notes are rows too, right under the header where they'll be seen, and every row has every column, so the file still parses. */
export function taxCsv(rows: readonly TaxRow[], notes: readonly string[], { method, scope, currency, methodLabel = METHOD_LABELS[method] }: Pick<TaxSettings, "method" | "scope"> & { currency: CurrencyCode; methodLabel?: string }): string {
  const noteRow = (note: string) => CSV_HEADER.map((column) => (column === "Type" ? "Note" : column === "Notes" ? note : ""))
  const eventRow = (row: TaxRow) => [
    row.timestamp.slice(0, 19).replace("T", " "),
    row.type,
    row.asset,
    unitsCell(row.amount, row.decimals),
    money(row.proceedsMicros),
    money(row.costMicros),
    money(row.gainMicros),
    currency,
    methodLabel,
    SCOPE_LABELS[scope],
    row.priceSource === null ? "None" : PRICE_SOURCE_LABELS[row.priceSource],
    STATUS_LABELS[row.status],
    row.reason ?? "",
    row.wallet,
    `https://basescan.org/tx/${row.txHash}`,
  ]
  return `${[CSV_HEADER, ...notes.map(noteRow), ...rows.map(eventRow)].map((cells) => cells.map(csvCell).join(",")).join("\r\n")}\r\n`
}

/**
 * `wallets[0]` is the one asked about. They all have to be in the same currency. A year only picks which rows are listed:
 * what each one cost is still worked out from all the history there is, as it would be across tax years.
 */
export function taxReportOf(wallets: readonly WalletResponse[], settings: TaxSettings & { year?: TaxYear }, context: TaxContext = {}): TaxReportResponse {
  const { country: code, method, scope } = settings
  const country = TAX_COUNTRIES[code]
  const first = wallets[0] as WalletResponse
  const { currency } = first
  const sources = sourcesOf(wallets, method, context, country)
  const named = wallets.length > 1
  const years = yearsOf(wallets, country)
  const year = settings.year === "latest" ? (years[0] ?? null) : settings.year === "all" || settings.year === undefined ? null : settings.year
  const allRows = rowsFrom(sources, method, scope, country)
  if (code === "CA") flagSuperficialLosses(allRows, sources, context.book)
  const rows = year === null ? allRows : allRows.filter((row) => taxYearOf(row.timestamp, country) === year)
  const partialYear = year === null ? null : partialYearNote(year, historyStart(wallets), country)
  const count = (status: TaxRowStatus) => rows.filter((row) => row.status === status).length
  const unresolved = count("unresolved")
  const estimated = count("estimated")
  const selfReported = count("self-reported")
  const given = rows.filter((row) => row.givenCost).length
  const superficial = rows.filter((row) => row.lossRule !== undefined).length
  const tentative = new Set(rows.filter((row) => TENTATIVE_NOTES.some((note) => row.reason?.includes(note))).map(eventKey)).size
  const counted = rows.filter((row) => row.gainMicros !== null)
  const events = [...eventsOf(rows).values()]
  // Where to fix what's unknown: the wallets whose sales say so, and any wallet holding an asset with an unknown gain
  // that arrived with no known cost. Across wallets, that cost is part of another wallet's sale, which has no question.
  const unknownAssets = new Set(rows.filter((row) => row.gainMicros === null).map((row) => row.asset))
  const unknownIn = new Set([
    ...events.filter((event) => event.unknown).map((event) => event.wallet.toLowerCase()),
    ...sources.filter(({ view }) => view.legs.some((leg) => unknownAssets.has(leg.asset) && BigInt(leg.delta) > 0n && leg.costMicros === null)).map(({ wallet }) => wallet.address.toLowerCase()),
  ])

  const warnings: string[] = partialYear === null ? [] : [partialYear]
  if (unresolved > 0) warnings.push(`${plural(unresolved, "row")} of ${rows.length.toLocaleString("en-US")} ${unresolved === 1 ? "has" : "have"} an unknown gain. What can't be worked out says "unknown". It's never counted as 0, and it isn't in the gain total.`)
  if (estimated > 0) warnings.push(`${plural(estimated, "row")} of ${rows.length.toLocaleString("en-US")} ${estimated === 1 ? "rests" : "rest"} on an estimate.`)
  if (selfReported > 0) warnings.push(`${plural(selfReported, "row")} of ${rows.length.toLocaleString("en-US")} ${selfReported === 1 ? "uses" : "use"} a cost you entered or imported, which the chain can't confirm, so keep your records for it.`)
  if (given > 0) warnings.push(`${plural(given, "row")} of ${rows.length.toLocaleString("en-US")} ${given === 1 ? "uses" : "use"} a market price from when something you said came from someone else arrived. ${country.marketWarning}`)
  if (superficial > 0) warnings.push(`${plural(superficial, "loss", "losses")} may be superficial, because more of the same asset was acquired within 30 days. A superficial loss can't be deducted, so check ${superficial === 1 ? "it" : "them"} before filing.`)
  if (tentative > 0) warnings.push(`${plural(tentative, "sale or fee", "sales or fees")} happened less than 30 days before the end of what's been read, so ${tentative === 1 ? "its" : "their"} cost may still change with what's bought next.`)
  for (const { wallet, asset } of withheldIn(sources.flatMap(({ view }) => view.legs))) warnings.push(withheldSentence(wallet, asset))
  for (const source of sources) warnings.push(...walletWarnings(source, named))
  if (method !== country.method) warnings.push(country.methodWarning)
  if (scope !== country.scope) warnings.push(country.scopeWarning)
  if (!TAX_COUNTRY_CODES.some((other) => TAX_COUNTRIES[other].currency === currency)) warnings.unshift(`This report only knows the rules of ${listOf(TAX_COUNTRY_CODES.map((other) => TAX_COUNTRIES[other].inSentence))}, and none of them reports in ${currency}. If you report in ${currency}, these rules and this layout may not apply where you do.`)
  else if (currency !== country.currency) warnings.push(`This is in ${currency}, and ${country.inSentence} reports in ${country.currency}. Change your main currency to export it in ${country.currency}.`)
  const pool = poolOf(sources)
  if (scope === "pooled" && !pool.sameStart) warnings.push(`${DIFFERENT_STARTS} Their costs and gains say "unknown". Calculating each wallet on its own avoids this.`)
  if (scope === "pooled" && pool.pendingTxs > 0) warnings.push(`This stops at block ${pool.through.toLocaleString("en-US")}, the last one every wallet has reached, so ${plural(pool.pendingTxs, "newer transaction")} ${pool.pendingTxs === 1 ? "isn't" : "aren't"} here yet.`)
  if (scope === "per-wallet" && hasUnknownMove(sources, movesBetween(sources))) warnings.push("Moves between your wallets aren't sales, so they aren't listed. Some of what moved has no known cost to carry over, so its cost stays unknown.")

  const answered = new Set(linkedWallets(context.book ?? emptyBook()))
  const fromAnswers = wallets.slice(1).map((wallet) => wallet.address).filter((address) => answered.has(address.toLowerCase()))
  const notes = [
    ...(fromAnswers.length > 0 ? [`This includes the wallets you've said are yours: ${fromAnswers.map(shortHash).join(", ")}.`] : []),
    ...sources.map((source) => coverageNote(source, named)),
    ...(currency === "USD" ? [] : [`Amounts convert at the rate when each transaction happened, from ${rateSource(currency)}. A tax authority may expect another source.`]),
    ...(year === null ? [] : [`Only what happened in ${yearInSentence(year, country)} is listed, by its date in ${country.timeZoneName}. What it cost still counts everything before it.`]),
    ...COMMON_NOTES,
    ...country.notes,
  ]
  const filename = `tax-report-${first.address.slice(0, 8)}-${year === null ? "" : `${yearLabel(year, country).replace(/ to \d\d/, "-")}-`}${code}-${method === "fifo" ? "oldest-first" : "average"}-${currency}.csv`
  const methodLabel = methodLabelOf(method, country)
  const summary = `Prepared for ${country.inSentence}${year === null ? "" : `, ${yearLabel(year, country)}`}: ${methodLabel.toLowerCase()}, ${SCOPE_LABELS[scope].toLowerCase()}, in ${currency}.`

  return {
    wallets: wallets.map((wallet) => wallet.address),
    country: code,
    method,
    scope,
    currency,
    defaults: { method: country.method, scope: country.scope },
    year,
    years,
    yearLabels: years.map((option) => yearLabel(option, country)),
    yearLabel: year === null ? null : yearLabel(year, country),
    partialYear,
    rowCount: rows.length,
    soldCount: events.filter((event) => event.type === "Sold").length,
    feeCount: events.filter((event) => event.type === "Network fee").length,
    sentCount: events.filter((event) => event.type === "Sent").length,
    unknownCount: events.filter((event) => event.unknown).length,
    unknownWallets: wallets.map((wallet) => wallet.address.toLowerCase()).filter((address) => unknownIn.has(address)),
    unresolvedCount: unresolved,
    estimatedCount: estimated,
    selfReportedCount: selfReported,
    gainMicros: counted.length === 0 ? null : counted.reduce((sum, row) => sum + BigInt(row.gainMicros as string), 0n).toString(),
    disclaimer: TAX_DISCLAIMER,
    warnings,
    notes,
    preview: rows.slice(0, PREVIEW_ROWS).map(({ timestamp, type, asset, amount, decimals, gainMicros, status }) => ({ timestamp, type, asset, amount, decimals, gainMicros, status })),
    filename,
    csv: taxCsv(rows, [TAX_DISCLAIMER, summary, ...warnings, ...notes], { method, scope, currency, methodLabel }),
    form: taxFormOf(code, rows, [TAX_DISCLAIMER, summary, ...warnings], filename),
  }
}
