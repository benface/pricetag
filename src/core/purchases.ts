// Buying through a provider's page on the web: what's been started, what its order says, and what goes in the book, the way
// `Purchases.swift` does it on the Mac. Nothing here touches a key or signs anything. The page takes the payment, and what
// arrives is read from the chain like anything else.

import { TOKENS, formatAmount, formatMoney, formatPaid, isAddress, isCurrencyCode, normalizeAddress, plainAmount, type CurrencyCode } from "@pricetag/sdk/core"
import type { OnrampOrder } from "./api.ts"
import { parseBook, type Money, type Purchase } from "./book.ts"
import { unitsOfDecimal } from "./decimal.ts"
import { jsonPost } from "./read-failure.ts"
import { recordOf } from "./record.ts"
import type { PurchaseState } from "./resolve.ts"
import type { KeptIn, Shelf } from "./shelf.ts"

/** The one thing the flow says about who the provider is, along with where its page is. */
export const PROVIDER = "Coinbase"
const PROVIDER_HOSTS = new Set(["pay.coinbase.com"])

/** What its page can start from a typed amount in: the server's `PRESET_FIAT`. In anything else, it starts from a token amount. */
const STARTS_FROM_AMOUNT_IN: ReadonlySet<string> = new Set(["USD", "CAD", "GBP", "EUR"])

/** How long something unresolved is polled for. After that it's read when the page opens or comes back, so it's never given up on. */
const FOLLOWED_MS = 2 * 60 * 60 * 1000
const SHOWN_FINISHED = 5

/** A purchase someone started from this browser. It's kept, so one still going is picked up after a reload. */
export type TrackedPurchase = {
  ref: string
  wallet: string
  asset: string
  /** What was typed. It's a past amount, so it never goes through today's rate. */
  typed: Money
  startedAt: number
  order: OnrampOrder | null
}

/** Where a purchase has got to, as simply as it can be said. */
export type PurchasePhase =
  /** The page is open, and there's no order yet. */
  | { kind: "on-page" }
  | { kind: "on-its-way" }
  /** Delivered, and not seen on the chain yet. Its cost is known, and waits for that. */
  | { kind: "arriving" }
  | { kind: "recorded"; cost: Money }
  /** What arrived isn't exactly what the order says, or nothing ever did. Its cost stays unknown. */
  | { kind: "cost-unknown" }
  /** The order doesn't say what was paid for it, as when it was paid from crypto already held. Its cost stays unknown. */
  | { kind: "cost-not-said" }
  | { kind: "no-rate"; currency: string }
  | { kind: "failed"; failure: "payment" | "delivery" }
  /** There's been a long time with no order. Someone could still have paid, so it's asked about whenever the page opens or comes back. */
  | { kind: "no-order-yet" }

/** Only a known provider's own page. Whatever a server says, this app won't send a purchase anywhere else. */
export function pageOf(url: unknown): string | null {
  if (typeof url !== "string" || !URL.canParse(url)) return null
  const page = new URL(url)
  return page.protocol === "https:" && PROVIDER_HOSTS.has(page.hostname) ? page.href : null
}

/**
 * What goes in the book. Null until it's delivered and says all of this, because a cost is never made up from part of it. It
 * goes through the book's own check, because one row the book can't read would lose everything else in it on the next load.
 */
export function purchaseOf(order: OnrampOrder): Purchase | null {
  const { status, asset, units, wallet, txHash, cost, costUsdMicros } = order
  if (status !== "succeeded" || !asset || !units || !wallet || !txHash) return null
  const paid = cost ?? (costUsdMicros === null ? null : { micros: costUsdMicros, currency: "USD" as const })
  if (!paid) return null
  return parseBook({ purchases: [{ provider: order.provider, order: order.id, wallet, asset, units, txHash, blockNum: order.blockNum, cost: paid, costUsdMicros }] })?.purchases?.[0] ?? null
}

export function phaseOf(purchase: TrackedPurchase, match: PurchaseState["state"] | null, now: number): PurchasePhase {
  const { order } = purchase
  const longAgo = now - purchase.startedAt > FOLLOWED_MS
  if (!order) return { kind: longAgo ? "no-order-yet" : "on-page" }
  if (order.status === "failed") return { kind: "failed", failure: order.failure ?? "payment" }
  if (order.status === "pending" || !order.txHash) return { kind: "on-its-way" }
  const recorded = purchaseOf(order)
  if (!recorded) return order.paidIn ? { kind: "no-rate", currency: order.paidIn } : { kind: "cost-not-said" }
  if (match === "recorded") return { kind: "recorded", cost: recorded.cost }
  if (match === "unmatched") return { kind: "cost-unknown" }
  // Its hash hasn't led to a block in all this time. It's still asked about, and a block would change this.
  return { kind: order.blockNum === null && longAgo ? "cost-unknown" : "arriving" }
}

/** Nothing says they've paid, so only they can say they won't. */
export const isUpToThem = ({ kind }: PurchasePhase) => kind === "on-page" || kind === "no-order-yet"

export const isFinished = ({ kind }: PurchasePhase) => kind === "recorded" || kind === "cost-unknown" || kind === "cost-not-said" || kind === "no-rate" || kind === "failed"

export const isWarning = ({ kind }: PurchasePhase) => kind === "cost-unknown" || kind === "cost-not-said" || kind === "no-rate" || kind === "failed"

/** Whether there's nothing more to learn about it. How long it's been never settles this: an order can appear after any wait, and so can a delivery's block. */
export function isResolved({ order }: TrackedPurchase): boolean {
  if (!order || order.status === "pending") return false
  return order.status === "failed" || (order.txHash !== null && order.blockNum !== null)
}

export const isFollowed = (purchase: TrackedPurchase, now: number) => !isResolved(purchase) && now - purchase.startedAt <= FOLLOWED_MS

/**
 * What's finished only matters for a while, and what's still going stays however long this gets. `justRead` is never the one
 * to go, because an older order finishing last hasn't been seen yet.
 */
export function trimmed(purchases: readonly TrackedPurchase[], justRead?: string): TrackedPurchase[] {
  const finished = purchases.filter(isResolved)
  const dropped = new Set([...finished.filter(({ ref }) => ref !== justRead), ...finished.filter(({ ref }) => ref === justRead)].slice(0, -SHOWN_FINISHED).map(({ ref }) => ref))
  return purchases.filter(({ ref }) => !dropped.has(ref))
}

const money = ({ micros, currency }: Money, main: CurrencyCode) => (currency === main ? formatMoney(micros, currency) : formatPaid(micros, currency))

/** What the order says once it says, because the amount can be changed on the page. Until then, what was chosen. */
export function purchaseTitle({ order, typed, asset }: TrackedPurchase, main: CurrencyCode): string {
  const token = TOKENS.find(({ symbol }) => symbol === order?.asset)
  if (order?.units && token) return `${formatAmount(order.units, token.decimals)} ${token.symbol}`
  // Whole, as it was typed.
  return `${money(typed, main).replace(".00", "")} of ${order?.asset ?? asset}`
}

export function purchaseStatus(phase: PurchasePhase, main: CurrencyCode): string {
  switch (phase.kind) {
    case "on-page":
      return `Waiting for you on ${PROVIDER}`
    case "on-its-way":
      return "On its way"
    case "arriving":
      return "Delivered. Waiting to see it arrive"
    case "recorded":
      return `Cost ${money(phase.cost, main)}, fees included`
    case "cost-unknown":
      return "Cost unknown. The order didn't match what arrived"
    case "cost-not-said":
      return "Cost unknown. The order doesn't say what you paid for it"
    case "no-rate":
      return `Cost unknown. There's no exchange rate for ${phase.currency}`
    case "failed":
      return phase.failure === "payment" ? `${PROVIDER} couldn't take the payment` : `${PROVIDER} couldn't deliver it`
    case "no-order-yet":
      return `No order from ${PROVIDER} yet`
  }
}

/** What the amount in the form will do once it's on the provider's page, so what it charges is no surprise. `typedIn` is what the form reads in. */
export function checkoutNote(typedIn: CurrencyCode, main: CurrencyCode): string {
  const account = `You'll need a ${PROVIDER} account.`
  if (typedIn !== "USD" && !STARTS_FROM_AMOUNT_IN.has(typedIn)) return `${account} Its page can't start from an amount in ${typedIn}, so it starts from about that much of the token, and shows its own price and fees before you pay. What it charges, fees included, becomes the cost here.`
  if (typedIn !== "USD") return `${account} Its page starts at this amount in ${typedIn} and shows its fees before you pay. What it charges, fees included, becomes the cost here.`
  if (main !== "USD") return `There's no current USD to ${main} rate, so this is in US dollars, and ${PROVIDER}'s page works out its own price in your currency. ${account} What it charges, fees included, becomes the cost here.`
  return `${account} Its fees are added, and that total becomes the cost here.`
}

/** An amount as someone typed it, in plain digits with at most cents, which is what the checkout takes. Null when it isn't one above zero. */
export function typedAmount(text: string): string | null {
  const clean = plainAmount(text)
  return clean !== null && /^\d{1,9}(\.\d{1,2})?$/.test(clean) && /[1-9]/.test(clean) ? clean : null
}

/** Those digits as millionths. */
export function microsOf(amount: string): string {
  return unitsOfDecimal(amount, 6).toString()
}

export type CheckoutRequest = { address: string; asset: string; cryptoAmount: string; fiat: { amount: string; currency: CurrencyCode } | null }

const answerOf = async (response: Response): Promise<Record<string, unknown>> => ((await response.json().catch(() => null)) ?? {}) as Record<string, unknown>

const refusal = (body: Record<string, unknown>, fallback: string) => new Error(typeof body.error === "string" ? body.error : fallback)

/** Asks the server for a page. Throws with something to say about why, when there's none to open. */
export async function startCheckout(request: CheckoutRequest, send: typeof fetch = fetch): Promise<{ page: string; ref: string }> {
  const response = await send("/api/onramp/checkout", jsonPost(request))
  const body = await answerOf(response)
  if (!response.ok) throw refusal(body, "Couldn't start this purchase.")
  const page = pageOf(body.url)
  if (!page) throw new Error(`The price service sent a page that isn't ${PROVIDER}'s.`)
  if (typeof body.ref !== "string") throw new Error("The price service sent something this page can't read.")
  return { page, ref: body.ref }
}

/** The order a purchase led to, or null when there's none yet. Throws when that can't be read, which changes nothing, and it's tried again. */
export async function readOrder(ref: string, signal: AbortSignal, send: typeof fetch = fetch): Promise<OnrampOrder | null> {
  const response = await send(`/api/onramp/orders/${encodeURIComponent(ref)}`, { signal })
  const body = await answerOf(response)
  if (!response.ok) throw refusal(body, "Couldn't check this purchase.")
  return Array.isArray(body.orders) ? ((body.orders[0] as OnrampOrder | undefined) ?? null) : null
}


function parseTracked(value: unknown): TrackedPurchase | null {
  const row = recordOf(value)
  const typed = recordOf(row?.typed)
  if (!row || typeof row.ref !== "string" || typeof row.wallet !== "string" || !isAddress(row.wallet) || typeof row.asset !== "string" || typeof row.startedAt !== "number") return null
  if (typeof typed?.micros !== "string" || !/^\d+$/.test(typed.micros) || typeof typed.currency !== "string" || !isCurrencyCode(typed.currency)) return null
  const order = recordOf(row.order)
  return { ref: row.ref, wallet: normalizeAddress(row.wallet), asset: row.asset, typed: { micros: typed.micros, currency: typed.currency }, startedAt: row.startedAt, order: order ? (order as OnrampOrder) : null }
}

/** What's kept in this browser. A row that can't be read is left out, and the rest still count. */
export function parseTrackedPurchases(value: unknown): TrackedPurchase[] {
  return Array.isArray(value) ? value.map(parseTracked).filter((row) => row !== null) : []
}

const PURCHASES_KEY = "patina.purchases"

export const isPurchasesKey = (key: string | null) => key === null || key === PURCHASES_KEY

function purchasesFrom(text: string | null): TrackedPurchase[] {
  try {
    return parseTrackedPurchases(JSON.parse(text ?? "null"))
  } catch {
    return []
  }
}

/** The copy a page can show right away, until `readStoredPurchases` says what's true. */
export const storedPurchases = (storage: KeptIn): TrackedPurchase[] => purchasesFrom(storage.getItem(PURCHASES_KEY))

export const readStoredPurchases = async (shelf: Shelf): Promise<TrackedPurchase[]> => purchasesFrom(await shelf.read(PURCHASES_KEY))

export async function changeStoredPurchases(shelf: Shelf, change: (latest: TrackedPurchase[]) => TrackedPurchase[]): Promise<TrackedPurchase[]> {
  const text = await shelf.change(PURCHASES_KEY, (text) => {
    const latest = purchasesFrom(text)
    const next = JSON.stringify(change(latest))
    return next === JSON.stringify(latest) ? text : next
  })
  return purchasesFrom(text)
}

/** What an order says. It goes in the book first and has to get there, because trimming can take its row away, and then nothing would say it again. */
export async function settleOrder(shelf: Shelf, ref: string, order: OnrampOrder, record: (purchase: Purchase) => unknown): Promise<TrackedPurchase[]> {
  const purchase = purchaseOf(order)
  if (purchase) await record(purchase)
  return changeStoredPurchases(shelf, (current) => trimmed(current.map((one) => (one.ref === ref ? { ...one, order } : one)), ref))
}
