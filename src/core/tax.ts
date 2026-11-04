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

import { foldPositions, unreadAssets, worth, type LegEffect, type Method, type PositionState, type PriceSource, type PricedLeg } from "@pricetag/sdk/core"
import { hasStarted, isBehind, type TaxReportResponse, type WalletResponse } from "./api.ts"
import { viewWallet, type CurrencyCode, type WalletView } from "./currency.ts"
import { rateSource } from "./explain.ts"
import { formatDuration, shortHash } from "./format.ts"
import { METHOD_LABELS } from "./wording.ts"

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
]

const PRICE_SOURCE_LABELS: Record<PriceSource, string> = { oracle: "Market price feed (Chainlink)", swap: "This exchange", market: "Market price" }

export type TaxRowStatus = "resolved" | "estimated" | "unresolved"

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
  /** Why it's estimated or unresolved. */
  reason: string | null
  wallet: string
  txHash: string
}

const UNKNOWN_COST = "What this cost isn't known. It was in the wallet before the first block read, or arrived from another address."
const INCOMPLETE_HISTORY = "More of this left than was seen arriving, so part of its history is missing."
const UNKNOWN_PROCEEDS = "What this sold for isn't known."
const NO_RATE = "There's no exchange rate at this block, so this can't be shown in this currency."
const NO_GAS_PRICE = "ETH had no price at this block."
const SENT = "Sent to another address, so it's not counted as a sale. If that's your own wallet, add it to this report. If it paid for something or was a gift, it's generally taxable."
const ESTIMATED_COST = "Part of its cost is an estimate, from the market price when it arrived."
const MISMATCH = "This asset's history doesn't match its onchain balance, so its cost can't be trusted."
const UNCHECKED = "This asset hasn't been checked against its onchain balance yet, so its cost isn't shown."

/** Units with a known cost, and what they cost. */
function knownOf(state: PositionState): { qty: bigint; cost: bigint } {
  let qty = 0n
  let cost = 0n
  for (const lot of state.lots) {
    if (lot.costMicros === null) continue
    qty += BigInt(lot.qty)
    cost += BigInt(lot.costMicros)
  }
  return { qty, cost }
}

/** A cost from an estimate carries through a sale, and an average that blends one in can't be told apart from it. */
function usedEstimate({ before, after }: LegEffect): boolean {
  return before.lots.some((lot) => {
    if (lot.costMicros === null || (lot.label !== "received at market" && lot.label !== "mixed")) return false
    return !after.lots.some((rest) => rest.legId === lot.legId && rest.qty === lot.qty)
  })
}

/** The rows a debit becomes: a sale with both a known and an unknown cost splits, so the known part still adds up. */
function rowsOf(effect: LegEffect, wallet: string, unconfirmed: string | null): TaxRow[] {
  const { leg, before, after } = effect
  const delta = BigInt(leg.delta)
  if (delta >= 0n) return []
  const qty = -delta
  const knownBefore = knownOf(before)
  const knownAfter = knownOf(after)
  const knownCost = knownBefore.cost - knownAfter.cost
  const unknownQty = qty - (knownBefore.qty - knownAfter.qty)
  const row = (fields: Pick<TaxRow, "amount" | "proceedsMicros" | "costMicros" | "gainMicros" | "status" | "reason">): TaxRow => ({
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
    const estimated = usedEstimate(effect)
    rows.push(row({ amount: resolvedQty.toString(), proceedsMicros: resolvedProceeds.toString(), costMicros: knownCost.toString(), gainMicros: gain.toString(), status: estimated ? "estimated" : "resolved", reason: estimated ? ESTIMATED_COST : null }))
  }
  if (unknownQty > 0n) {
    const short = BigInt(after.shortfallQty) > BigInt(before.shortfallQty)
    rows.push(row({ amount: unknownQty.toString(), proceedsMicros: (proceeds - resolvedProceeds).toString(), costMicros: null, gainMicros: null, status: "unresolved", reason: short ? INCOMPLETE_HISTORY : UNKNOWN_COST }))
  }
  return rows
}

type Source = { wallet: WalletResponse; view: WalletView; unconfirmed: Map<string, string>; unread: string[] }

function sourceOf(wallet: WalletResponse, method: Method): Source {
  const view = viewWallet(wallet)
  const positions = foldPositions(view.legs, method, view.prices, wallet)
  const unconfirmed = new Map<string, string>()
  for (const { asset, reconciliation } of positions) {
    if (reconciliation && reconciliation.status !== "reconciled") unconfirmed.set(asset, reconciliation.status === "incomplete" ? MISMATCH : UNCHECKED)
  }
  return { wallet, view, unconfirmed, unread: unreadAssets(positions, wallet) }
}

const moveKey = (leg: PricedLeg) => `${leg.txHash}:${leg.asset}`

/**
 * Transfers that only went from one of these wallets to another: the same transaction and asset, netting to nothing.
 * Moving between your own wallets isn't a sale in either country. A move that loses some on the way isn't one of these.
 */
function movesBetween(sources: readonly Source[]): Set<string> {
  const moves = new Map<string, { net: bigint; wallets: Set<string> }>()
  for (const { wallet, view } of sources) {
    for (const leg of view.legs) {
      if (leg.kind !== "transfer" || leg.opening) continue
      const move = moves.get(moveKey(leg)) ?? { net: 0n, wallets: new Set<string>() }
      move.net += BigInt(leg.delta)
      move.wallets.add(wallet.address)
      moves.set(moveKey(leg), move)
    }
  }
  return new Set([...moves].filter(([, { net, wallets }]) => net === 0n && wallets.size > 1).map(([key]) => key))
}

const isMove = (leg: PricedLeg, moves: ReadonlySet<string>) => leg.kind === "transfer" && !leg.opening && moves.has(moveKey(leg))

function poolLegs(sources: readonly Source[], moves: ReadonlySet<string>): { legs: PricedLeg[]; walletOf: Map<PricedLeg, string> } {
  const walletOf = new Map<PricedLeg, string>()
  for (const { wallet, view } of sources) for (const leg of view.legs) if (!isMove(leg, moves)) walletOf.set(leg, wallet.address)
  // Each wallet's legs are already in order, and this sort is stable, so that order holds inside a transaction.
  const legs = [...walletOf.keys()].sort((a, b) => a.blockNum - b.blockNum || a.txIndex - b.txIndex)
  return { legs, walletOf }
}

export type TaxSettings = { country: TaxCountryCode; method: Method; scope: TaxScope }

/** Every row, oldest first, with a transaction's fee before what it did, the way the fold reads them. */
export function taxRows(wallets: readonly WalletResponse[], { method, scope }: Pick<TaxSettings, "method" | "scope">): TaxRow[] {
  const sources = wallets.map((wallet) => sourceOf(wallet, method))
  const moves = movesBetween(sources)
  const rows: TaxRow[] = []
  if (scope === "pooled") {
    const { legs, walletOf } = poolLegs(sources, moves)
    // An asset one wallet can't confirm leaves its share of the pool unknown, and that touches every sale of it.
    const unconfirmed = new Map(sources.flatMap((source) => [...source.unconfirmed, ...source.unread.map((asset) => [asset, UNCHECKED] as [string, string])]))
    for (const position of foldPositions(legs, method, {})) {
      for (const effect of position.effects) rows.push(...rowsOf(effect, walletOf.get(effect.leg) as string, unconfirmed.get(position.asset) ?? null))
    }
  } else {
    for (const { wallet, view, unconfirmed } of sources) {
      for (const position of foldPositions(view.legs, method, {})) {
        for (const effect of position.effects) {
          if (!isMove(effect.leg, moves)) rows.push(...rowsOf(effect, wallet.address, unconfirmed.get(position.asset) ?? null))
        }
      }
    }
  }
  const feeFirst = (row: TaxRow) => (row.type === "Network fee" ? 0 : 1)
  return rows.sort((a, b) => a.blockNum - b.blockNum || a.txIndex - b.txIndex || feeFirst(a) - feeFirst(b))
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
  const span = toBlock >= fromBlock ? ` (about ${formatDuration(toBlock - fromBlock)})` : ""
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

const STATUS_LABELS: Record<TaxRowStatus, string> = { resolved: "OK", estimated: "ESTIMATED", unresolved: "UNRESOLVED" }

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
export function taxReportOf(wallets: readonly WalletResponse[], settings: TaxSettings): TaxReportResponse {
  const { country: code, method, scope } = settings
  const country = TAX_COUNTRIES[code]
  const first = wallets[0] as WalletResponse
  const { currency } = first
  const sources = wallets.map((wallet) => sourceOf(wallet, method))
  const named = wallets.length > 1
  const rows = taxRows(wallets, settings)
  const count = (status: TaxRowStatus) => rows.filter((row) => row.status === status).length
  const unresolved = count("unresolved")
  const estimated = count("estimated")
  const counted = rows.filter((row) => row.gainMicros !== null)

  const warnings: string[] = []
  if (unresolved > 0) warnings.push(`${plural(unresolved, "row")} of ${rows.length.toLocaleString("en-US")} ${unresolved === 1 ? "is" : "are"} unresolved. What can't be worked out says "unknown". It's never counted as 0, and it isn't in the gain total.`)
  if (estimated > 0) warnings.push(`${plural(estimated, "row")} of ${rows.length.toLocaleString("en-US")} ${estimated === 1 ? "uses" : "use"} an estimated cost.`)
  for (const source of sources) warnings.push(...walletWarnings(source, named))
  if (method !== country.method) warnings.push(country.methodWarning)
  if (scope !== country.scope) warnings.push(country.scopeWarning)
  if (currency !== country.currency) warnings.push(`This is in ${currency}, and ${country.inSentence} reports in ${country.currency}. Change your main currency to export it in ${country.currency}.`)
  if (scope === "per-wallet" && movesBetween(sources).size > 0) warnings.push("Moves between your wallets aren't sales, so they aren't listed, but their cost doesn't carry over yet. What arrived has an unknown cost until it does.")

  const notes = [
    ...sources.map((source) => coverageNote(source, named)),
    ...(currency === "USD" ? [] : [`Amounts convert at the rate when each transaction happened, from ${rateSource(currency)}. A tax authority may expect another source.`]),
    ...COMMON_NOTES,
    ...country.notes,
  ]
  const summary = `Prepared for ${country.inSentence}: ${METHOD_LABELS[method].toLowerCase()}, ${SCOPE_LABELS[scope].toLowerCase()}, in ${currency}.`

  return {
    wallets: wallets.map((wallet) => wallet.address),
    country: code,
    method,
    scope,
    currency,
    defaults: { method: country.method, scope: country.scope },
    rowCount: rows.length,
    unresolvedCount: unresolved,
    estimatedCount: estimated,
    gainMicros: counted.length === 0 ? null : counted.reduce((sum, row) => sum + BigInt(row.gainMicros as string), 0n).toString(),
    disclaimer: TAX_DISCLAIMER,
    warnings,
    notes,
    filename: `tax-report-${first.address.slice(0, 8)}-${code}-${method === "fifo" ? "oldest-first" : "average"}-${currency}.csv`,
    csv: taxCsv(rows, [TAX_DISCLAIMER, summary, ...warnings, ...notes], { method, scope, currency }),
  }
}
