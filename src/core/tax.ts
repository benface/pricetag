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
//
// What something received from someone else costs, which decides whether its market price is a cost or an estimate:
// - Canada, the market price is the cost: Income Tax Act s. 69(1)(c) deems a gift acquired at fair market value, and
//   s. 52(1) adds what was included in income to the cost of what was received.
// - US, it depends: IRS digital asset FAQs Q59 makes fair market value the basis of what you were paid, but Q76 gives a
//   gift the giver's basis. We can't tell which it was, so it stays an estimate.
// That only goes for what the user said came from someone else. A bridge or a mint could be their own money arriving from
// elsewhere, and CRA's crypto guide doesn't count moving between your own wallets as a disposition, so that keeps what they
// first paid, which we can't see. Those stay estimates in every country, and the report says why.

import { foldPositions, formatDuration, isAddress, markUnknownOrder, msBetweenBlocks, normalizeAddress, orderMatters, shortHash, timestampOfBlock, unreadAssets, viewWallet, worth, type CurrencyCode, type LegEffect, type Method, type PositionState, type PriceSource, type PricedLeg, type WalletView } from "@pricetag/sdk/core"
import { hasStarted, isBehind, type TaxReportResponse, type WalletResponse } from "./api.ts"
import { emptyBook, linkedWallets, type Book } from "./book.ts"
import { rateSource } from "./explain.ts"
import { resolveLegs, withheldIn } from "./resolve.ts"
import { METHOD_LABELS, withheldSentence } from "./wording.ts"

export type TaxCountryCode = "CA" | "US"
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
      "A loss can be denied if you buy the same asset back within 30 days before or after selling it (a superficial loss). This report doesn't check for that.",
      "Every gain here is shown in full, as if it's capital. Canada generally taxes half of a capital gain, and frequent trading can count as business income instead.",
    ],
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
    notes: ["This report doesn't split short-term from long-term gains, or give the date each sold unit was acquired, which Form 8949 asks for.", "Choosing specific units to sell isn't available yet."],
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
}

const UNKNOWN_COST = "What this cost isn't known. It was in the wallet before the first block read, or arrived from another address."
const INCOMPLETE_HISTORY = "More of this left than was seen arriving, so part of its history is missing."
const UNKNOWN_PROCEEDS = "What this sold for isn't known."
const NO_RATE = "There's no exchange rate at this block, so this can't be shown in this currency."
const NO_GAS_PRICE = "ETH had no price at this block."
const SENT = "Sent to another address, so it's not counted as a sale. If that's your own wallet, add it to this report. If it paid for something or was a gift, it's generally taxable."
const ESTIMATED_COST = "Part of its cost is an estimate, from a market price."
const ESTIMATED_PROCEEDS = "What it sold for is an estimate, from a market price."
const ESTIMATED_BOTH = "What it sold for and part of its cost are estimates, from market prices."
const REPORTED_COST = "Part of its cost is what you entered or imported, which the chain can't confirm."
const purchasedCost = (source: string) => `Some or all of its cost: ${source}, fees included.`
const MISMATCH = "This asset's history doesn't match its onchain balance, so its cost can't be trusted."
const UNCHECKED = "This asset hasn't been checked against its onchain balance yet, so its cost isn't shown."
const DIFFERENT_STARTS = "These wallets' histories start at different blocks, so their costs can't be worked out together."

/** Units with a known cost, what they cost, and where that cost came from. The fold keeps count, whatever a lot is labeled. */
function knownOf(state: PositionState) {
  const known = { qty: 0n, cost: 0n, estimated: 0n, given: 0n, reportedQty: 0n, purchasedQty: 0n, purchaseSource: null as string | null }
  for (const lot of state.lots) {
    if (lot.costMicros === null) continue
    known.qty += BigInt(lot.qty)
    known.cost += BigInt(lot.costMicros)
    known.estimated += BigInt(lot.estimatedCostMicros ?? "0")
    known.given += BigInt(lot.givenCostMicros ?? "0")
    if (lot.reported) known.reportedQty += BigInt(lot.qty)
    if (lot.purchaseSource) {
      known.purchasedQty += BigInt(lot.qty)
      known.purchaseSource = lot.purchaseSource
    }
  }
  return known
}

/** The rows a debit becomes: a sale with both a known and an unknown cost splits, so the known part still adds up. */
function rowsOf(effect: LegEffect, wallet: string, unconfirmed: string | null, country: TaxCountry | null): TaxRow[] {
  const { leg, before, after } = effect
  const delta = BigInt(leg.delta)
  if (delta >= 0n) return []
  const qty = -delta
  const knownBefore = knownOf(before)
  const knownAfter = knownOf(after)
  // What it took has no known cost, whatever its lots say, when that depends on an order nothing says.
  const orderless = orderMatters(leg, before.method)
  const knownCost = orderless ? 0n : knownBefore.cost - knownAfter.cost
  const unknownQty = orderless ? qty : qty - (knownBefore.qty - knownAfter.qty)
  const row = (fields: Pick<TaxRow, "amount" | "proceedsMicros" | "costMicros" | "gainMicros" | "status" | "reason"> & { givenCost?: boolean }): TaxRow => ({
    givenCost: false,
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

  if (leg.kind === "transfer") return [row({ amount, proceedsMicros: null, costMicros: wholeCost, gainMicros: null, status: "unresolved", reason: SENT })]

  const proceeds = leg.kind === "gas" ? (leg.priceMicros === null ? null : worth(qty, BigInt(leg.priceMicros), leg.decimals)) : leg.proceedsMicros === null ? null : BigInt(leg.proceedsMicros)
  if (proceeds === null) {
    const noRate = leg.conversion?.rateMicros === null
    return [row({ amount, proceedsMicros: null, costMicros: wholeCost, gainMicros: null, status: "unresolved", reason: noRate ? NO_RATE : leg.kind === "gas" ? NO_GAS_PRICE : UNKNOWN_PROCEEDS })]
  }
  if (unconfirmed !== null) return [row({ amount, proceedsMicros: proceeds.toString(), costMicros: null, gainMicros: null, status: "unresolved", reason: unconfirmed })]

  const rows: TaxRow[] = []
  const resolvedQty = BigInt(after.resolvedDisposedQty) - BigInt(before.resolvedDisposedQty)
  const gain = BigInt(after.realizedMicros) - BigInt(before.realizedMicros)
  const resolvedProceeds = resolvedQty > 0n ? gain + knownCost : 0n
  if (resolvedQty > 0n) {
    const given = knownBefore.given - knownAfter.given
    const costIsEstimated = knownBefore.estimated - knownAfter.estimated - (country?.marketIsCost ? given : 0n) > 0n
    const proceedsAreEstimated = leg.estimated === true && resolvedProceeds > 0n
    // By units rather than dollars, because $0 is a cost someone can enter.
    const reported = knownBefore.reportedQty > knownAfter.reportedQty
    const estimate = costIsEstimated && proceedsAreEstimated ? ESTIMATED_BOTH : costIsEstimated ? ESTIMATED_COST : proceedsAreEstimated ? ESTIMATED_PROCEEDS : null
    const purchased = knownBefore.purchasedQty > knownAfter.purchasedQty && knownBefore.purchaseSource ? purchasedCost(knownBefore.purchaseSource) : null
    const reason = [estimate, given > 0n ? (country?.marketRowNote ?? null) : null, reported ? REPORTED_COST : null, purchased].filter((note) => note !== null).join(" ")
    rows.push(row({ amount: resolvedQty.toString(), proceedsMicros: resolvedProceeds.toString(), costMicros: knownCost.toString(), gainMicros: gain.toString(), status: estimate ? "estimated" : reported ? "self-reported" : "resolved", reason: reason || null, givenCost: given > 0n }))
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
function sourcesOf(wallets: readonly WalletResponse[], method: Method, { book = emptyBook(), costsFrom = [] }: TaxContext): Source[] {
  const sides = [...wallets, ...costsFrom].map((wallet) => {
    const view = viewWallet(wallet)
    return { wallet, view, ...checksOf(wallet, view, method) }
  })
  const linking = wallets.length > 1 ? { ...book, linked: [...(book.linked ?? []), ...wallets.map((wallet) => wallet.address.toLowerCase())] } : book
  const { legs } = resolveLegs(sides, method, linking)
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

export type TaxSettings = { country: TaxCountryCode; method: Method; scope: TaxScope }

/** A calendar year, the newest one there's history for, or everything. */
export type TaxYear = number | "latest" | "all"

export function parseTaxYear(value: unknown): TaxYear | null {
  if (value === undefined || value === null || value === "all") return "all"
  if (value === "latest") return value
  const year = typeof value === "string" && /^\d{4}$/.test(value) ? Number(value) : value
  return typeof year === "number" && Number.isInteger(year) && year >= 2000 && year <= 2999 ? year : null
}

/** In UTC, like the file's dates. */
const yearOf = (timestamp: string) => Number(timestamp.slice(0, 4))

/** When the last of these wallets' history starts, since a year is only whole once every wallet's is. */
function historyStart(wallets: readonly WalletResponse[]): string {
  return wallets.map((wallet) => timestampOfBlock(wallet.coverage.fromBlock, wallet.latest)).reduce((a, b) => (a > b ? a : b))
}

/** Every year with some history, newest first. */
function yearsOf(wallets: readonly WalletResponse[]): number[] {
  const first = Math.min(...wallets.map((wallet) => yearOf(timestampOfBlock(wallet.coverage.fromBlock, wallet.latest))))
  const last = Math.max(...wallets.map((wallet) => yearOf(wallet.latest.timestamp)))
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => last - i)
}

const longDate = (timestamp: string) => new Date(timestamp).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })

/** Said plainly when a year's history isn't all here, because what's missing would change its gains. */
function partialYearNote(year: number, start: string): string | null {
  const startYear = yearOf(start)
  if (startYear > year) return `Records start on ${longDate(start)}, so nothing from ${year} is here.`
  if (startYear === year && start > `${year}-01-01T00:00:00.000Z`) return `Records start on ${longDate(start)}, so ${year} is missing everything before then.`
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

function rowsFrom(sources: readonly Source[], method: Method, scope: TaxScope, country: TaxCountry | null): TaxRow[] {
  const rows: TaxRow[] = []
  if (scope === "pooled") {
    const { sameStart, within } = poolOf(sources)
    const { legs, walletOf } = poolLegs(within, movesBetween(within))
    // What one wallet can't confirm leaves its share of the pool unknown, and that touches every sale of the asset.
    const unconfirmed = new Map(sources.flatMap(({ wallet, unconfirmed, unread }) => [...[...unread, ...wallet.openingUnread].map((asset) => [asset, UNCHECKED] as [string, string]), ...unconfirmed]))
    for (const position of foldPositions(legs, method, {})) {
      const reason = sameStart ? (unconfirmed.get(position.asset) ?? null) : DIFFERENT_STARTS
      for (const effect of position.effects) rows.push(...rowsOf(effect, walletOf.get(effect.leg) as string, reason, country))
    }
  } else {
    const moves = movesBetween(sources)
    for (const { wallet, view, unconfirmed } of sources) {
      for (const position of foldPositions(view.legs, method, {})) {
        for (const effect of position.effects) {
          if (!isMove(effect.leg, moves)) rows.push(...rowsOf(effect, wallet.address, unconfirmed.get(position.asset) ?? null, country))
        }
      }
    }
  }
  const feeFirst = (row: TaxRow) => (row.type === "Network fee" ? 0 : 1)
  return rows.sort((a, b) => a.blockNum - b.blockNum || a.txIndex - b.txIndex || feeFirst(a) - feeFirst(b))
}

/** Every row, oldest first, with a transaction's fee before what it did, the way the fold reads them. */
export function taxRows(wallets: readonly WalletResponse[], { method, scope, country }: Pick<TaxSettings, "method" | "scope"> & { country?: TaxCountryCode }, context: TaxContext = {}): TaxRow[] {
  return rowsFrom(sourcesOf(wallets, method, context), method, scope, country ? TAX_COUNTRIES[country] : null)
}

/**
 * The wallets someone typed in, and the first that can't be one. The demo wallet can't be combined with anything, so
 * what's saved from another wallet is ignored there: it mustn't block a report whose field for fixing it isn't shown.
 */
export function readOtherWallets(text: string, address: string): { others: string[]; bad: string | null } {
  if (address === "demo") return { others: [], bad: null }
  const others = text.split(/[\s,]+/).filter(Boolean)
  return { others: others.map((other) => other.toLowerCase()), bad: others.find((other) => !isAddress(other)) ?? null }
}

const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`

function walletWarnings(source: Source, named: boolean): string[] {
  const { wallet, view, unread } = source
  const who = named ? `${shortHash(wallet.address)}: ` : ""
  const lines: string[] = []
  if (wallet.mode === "demo") lines.push("Demo data, not a real wallet.")
  if (!hasStarted(wallet)) lines.push(`${who}The dataset hasn't reached this wallet's first block yet, so nothing from it is here.`)
  else if (isBehind(wallet)) lines.push(`${who}The dataset is ${plural(wallet.latest.blockNum - wallet.coverage.toBlock, "block")} behind the chain, so the newest transactions aren't here yet.`)
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

const csvCell = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value)

function money(micros: string | null): string {
  if (micros === null) return "unknown"
  const value = BigInt(micros)
  const size = value < 0n ? -value : value
  return `${value < 0n ? "-" : ""}${size / 1_000_000n}.${(size % 1_000_000n).toString().padStart(6, "0")}`
}

/** Every digit, because a tax file shouldn't round what it's given. */
function units(amount: string, decimals: number): string {
  const size = BigInt(amount)
  const scale = 10n ** BigInt(decimals)
  const fraction = (size % scale).toString().padStart(decimals, "0").replace(/0+$/, "")
  return `${size / scale}${fraction ? `.${fraction}` : ""}`
}

const STATUS_LABELS: Record<TaxRowStatus, string> = { resolved: "OK", estimated: "ESTIMATED", "self-reported": "SELF-REPORTED", unresolved: "UNRESOLVED" }

const CSV_HEADER = ["Date (UTC)", "Type", "Asset", "Amount", "Proceeds", "Cost", "Gain", "Currency", "Method", "Calculation", "Price source", "Status", "Notes", "Wallet", "Transaction"]

/** Notes are rows too, right under the header where they'll be seen, and every row has every column, so the file still parses. */
export function taxCsv(rows: readonly TaxRow[], notes: readonly string[], { method, scope, currency }: Pick<TaxSettings, "method" | "scope"> & { currency: CurrencyCode }): string {
  const noteRow = (note: string) => CSV_HEADER.map((column) => (column === "Type" ? "Note" : column === "Notes" ? note : ""))
  const eventRow = (row: TaxRow) => [
    row.timestamp.slice(0, 19).replace("T", " "),
    row.type,
    row.asset,
    units(row.amount, row.decimals),
    money(row.proceedsMicros),
    money(row.costMicros),
    money(row.gainMicros),
    currency,
    METHOD_LABELS[method],
    SCOPE_LABELS[scope],
    row.priceSource === null ? "None" : PRICE_SOURCE_LABELS[row.priceSource],
    STATUS_LABELS[row.status],
    row.reason ?? "",
    row.wallet,
    `https://basescan.org/tx/${row.txHash}`,
  ]
  return `${[CSV_HEADER, ...notes.map(noteRow), ...rows.map(eventRow)].map((cells) => cells.map(csvCell).join(",")).join("\r\n")}\r\n`
}

/** `wallets[0]` is the one asked about. They all have to be in the same currency. */
/**
 * `wallets[0]` is the one asked about. They all have to be in the same currency. A year only picks which rows are listed:
 * what each one cost is still worked out from all the history there is, as it would be across tax years.
 */
export function taxReportOf(wallets: readonly WalletResponse[], settings: TaxSettings & { year?: TaxYear }, context: TaxContext = {}): TaxReportResponse {
  const { country: code, method, scope } = settings
  const country = TAX_COUNTRIES[code]
  const first = wallets[0] as WalletResponse
  const { currency } = first
  const sources = sourcesOf(wallets, method, context)
  const named = wallets.length > 1
  const years = yearsOf(wallets)
  const year = settings.year === "latest" ? (years[0] ?? null) : settings.year === "all" || settings.year === undefined ? null : settings.year
  const allRows = rowsFrom(sources, method, scope, country)
  const rows = year === null ? allRows : allRows.filter((row) => yearOf(row.timestamp) === year)
  const partialYear = year === null ? null : partialYearNote(year, historyStart(wallets))
  const count = (status: TaxRowStatus) => rows.filter((row) => row.status === status).length
  const unresolved = count("unresolved")
  const estimated = count("estimated")
  const selfReported = count("self-reported")
  const given = rows.filter((row) => row.givenCost).length
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
  if (unresolved > 0) warnings.push(`${plural(unresolved, "row")} of ${rows.length.toLocaleString("en-US")} ${unresolved === 1 ? "is" : "are"} unresolved. What can't be worked out says "unknown". It's never counted as 0, and it isn't in the gain total.`)
  if (estimated > 0) warnings.push(`${plural(estimated, "row")} of ${rows.length.toLocaleString("en-US")} ${estimated === 1 ? "rests" : "rest"} on an estimate.`)
  if (selfReported > 0) warnings.push(`${plural(selfReported, "row")} of ${rows.length.toLocaleString("en-US")} ${selfReported === 1 ? "uses" : "use"} a cost you entered or imported, which the chain can't confirm, so keep your records for it.`)
  if (given > 0) warnings.push(`${plural(given, "row")} of ${rows.length.toLocaleString("en-US")} ${given === 1 ? "uses" : "use"} a market price from when something you said came from someone else arrived. ${country.marketWarning}`)
  for (const { wallet, asset } of withheldIn(sources.flatMap(({ view }) => view.legs))) warnings.push(withheldSentence(wallet, asset))
  for (const source of sources) warnings.push(...walletWarnings(source, named))
  if (method !== country.method) warnings.push(country.methodWarning)
  if (scope !== country.scope) warnings.push(country.scopeWarning)
  if (!TAX_COUNTRY_CODES.some((other) => TAX_COUNTRIES[other].currency === currency)) warnings.unshift(`This report only knows ${TAX_COUNTRY_CODES.map((other) => TAX_COUNTRIES[other].inSentence).join(" and ")}, and neither reports in ${currency}. If you report in ${currency}, these rules and this layout may not apply where you do.`)
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
    ...(year === null ? [] : [`Only what happened in ${year} is listed, by its date in UTC. What it cost still counts everything before it.`]),
    ...COMMON_NOTES,
    ...country.notes,
  ]
  const summary = `Prepared for ${country.inSentence}${year === null ? "" : `, ${year}`}: ${METHOD_LABELS[method].toLowerCase()}, ${SCOPE_LABELS[scope].toLowerCase()}, in ${currency}.`

  return {
    wallets: wallets.map((wallet) => wallet.address),
    country: code,
    method,
    scope,
    currency,
    defaults: { method: country.method, scope: country.scope },
    year,
    years,
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
    filename: `tax-report-${first.address.slice(0, 8)}-${year === null ? "" : `${year}-`}${code}-${method === "fifo" ? "oldest-first" : "average"}-${currency}.csv`,
    csv: taxCsv(rows, [TAX_DISCLAIMER, summary, ...warnings, ...notes], { method, scope, currency }),
  }
}
