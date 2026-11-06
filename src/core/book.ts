// The user's answers about where things came from. They stay on the device: clients keep them and send them along with
// each request, and the server doesn't store them. Writing one onchain would publicly tie the wallets together.

import { isAddress, isCurrencyCode, normalizeAddress, type CurrencyCode } from "@pricetag/sdk/core"

export const DEMO_ADDRESS = "0x00000000000000000000000000000000000de300"
/** The demo's other wallet. Nothing links them until someone answers that it's theirs. */
export const DEMO_SAVINGS_ADDRESS = "0x00000000000000000000000000000000000de301"

/** An amount someone entered or imported, in the currency it was in, because that's what it stays true in. */
export type Money = { micros: string; currency: CurrencyCode }

/** One thing that arrived from a sender, as it was when someone answered for it. */
export type Receipt = { wallet: string; legId: string; asset: string; units: string }

/** What was paid for exactly these receipts. Anything that arrives later isn't covered, so it's asked about in turn. */
export type ExchangeCost = Money & { asset: string; receipts: Receipt[] }

export type SenderAnswer =
  | { kind: "mine" }
  | { kind: "my-exchange"; costs?: ExchangeCost[] }
  | { kind: "someone-else" }

/** A withdrawal found in an exchange's history. See `exchange-import.ts`. */
export type ExchangeWithdrawal = {
  exchange: string
  asset: string
  units: string
  at: string
  cost: Money
  toAddress: string | null
}

/** The providers a purchase can come from. Each one's name for people is in `wording.ts`. */
export type PurchaseProvider = "coinbase"

/**
 * Something bought through a provider, as its order says. It's only the cost of a movement it matches exactly: see
 * `purchasedLegs` in `resolve.ts`. Anything else leaves that movement unknown, so it's asked about as usual.
 */
export type Purchase = {
  provider: PurchaseProvider
  order: string
  wallet: string
  asset: string
  units: string
  txHash: string
  /** The transaction's block, which is how ETH inside a batched payout is found, since no row names it. Null until it's read. */
  blockNum: number | null
  /** Everything paid, fees included, in what it was paid in. */
  cost: Money
  /** The same in USD, when the provider says, for a read in a currency `cost` can't be converted to at the rate when it arrived. */
  costUsdMicros: string | null
}

export type Book = {
  senders: Record<string, SenderAnswer>
  /** A cost entered for one movement, by `<wallet>:<leg id>`. */
  costs: Record<string, Money>
  withdrawals: ExchangeWithdrawal[]
  /** The wallets a client already knows are the user's, like the Mac app's hot and cold ones. Nobody answered for these. */
  linked?: string[]
  purchases?: Purchase[]
}

export const emptyBook = (): Book => ({ senders: {}, costs: {}, withdrawals: [] })

export const costKey = (wallet: string, legId: string) => `${normalizeAddress(wallet)}:${legId}`

/**
 * Answering for a sender. Saying it's yours says the wallet you're looking at is yours too. Saying someone else sent what
 * arrived from a wallet that's already yours is about the wallet you're looking at, and yours stays yours. With no `focus`,
 * it's only about the sender.
 */
export function answerSender(book: Book, focus: string | null, sender: string, answer: SenderAnswer): Book {
  const focused = focus !== null && isAddress(focus)
  if (answer.kind === "someone-else" && book.senders[normalizeAddress(sender)]?.kind === "mine" && focused && book.senders[normalizeAddress(focus)]?.kind !== "mine") {
    return { ...book, senders: { ...book.senders, [normalizeAddress(focus)]: answer } }
  }
  const senders: Book["senders"] = { ...book.senders, [normalizeAddress(sender)]: answer }
  if (answer.kind === "mine" && focused) senders[normalizeAddress(focus)] = { kind: "mine" }
  return { ...book, senders }
}

/** Accounts from one hardware device are all the user's, and the device already proved it, so nobody's asked. This overrides any earlier answer about them. */
export function linkDeviceAccounts(book: Book, addresses: readonly string[]): Book {
  const senders: Book["senders"] = { ...book.senders }
  for (const address of addresses) senders[normalizeAddress(address)] = { kind: "mine" }
  return { ...book, senders }
}

/** A book and what undo goes back to, oldest first. */
export type BookState = { book: Book; history: Book[] }

/** A new book, or how to get one from the latest. Anything that waited on something has to use the latest, because the book may have changed meanwhile. */
export type BookChange = Book | ((latest: Book) => Book)

export const changeBook = ({ book, history }: BookState, change: BookChange): BookState => ({ book: typeof change === "function" ? change(book) : change, history: [...history, book] })

export function undoBook(state: BookState): BookState {
  const previous = state.history.at(-1)
  return previous ? { book: previous, history: state.history.slice(0, -1) } : state
}

/** Not an answer, so undo doesn't take it back, whichever answers came before it. */
export const linkAccountsInBook = ({ book, history }: BookState, addresses: readonly string[]): BookState => ({ book: linkDeviceAccounts(book, addresses), history: history.map((one) => linkDeviceAccounts(one, addresses)) })

/** Saying what was paid for a sender's open receipts, by asset. It takes over for those receipts, and any others keep their earlier answers. */
export function enterExchangeCosts(book: Book, focus: string, sender: string, receipts: readonly Receipt[], amounts: Readonly<Record<string, Money>>): Book {
  const earlier = book.senders[sender]?.kind === "my-exchange" ? (book.senders[sender].costs ?? []) : []
  const costs = Object.entries(amounts).map(([asset, money]) => ({ ...money, asset, receipts: receipts.filter((r) => r.asset === asset) }))
  return answerSender(book, focus, sender, { kind: "my-exchange", costs: [...earlier, ...costs] })
}

export const linkedWallets = (book: Book) => [...new Set([...Object.entries(book.senders).flatMap(([address, answer]) => (answer.kind === "mine" ? [address] : [])), ...(book.linked ?? [])])]

/**
 * Whether a wallet's the user's own, which is what lets costs carry onto it. Having been paid by one of their wallets doesn't
 * make it so, because they could have paid anyone. A client only sends `linked` for its own, and the demo stands in for theirs.
 */
export const isOwnWallet = (book: Book, { address, mode }: { address: string; mode?: string }) => mode === "demo" || (book.linked?.length ?? 0) > 0 || linkedWallets(book).includes(normalizeAddress(address))

/** The user's wallets a read of this one goes with. A wallet that isn't theirs has nothing to do with them. */
export const walletsBehind = (book: Book, wallet: { address: string; mode?: string }) => (isOwnWallet(book, wallet) ? linkedWallets(book) : [])

const plainRecord = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null)

const isMicros = (value: unknown): value is string => typeof value === "string" && /^\d{1,30}$/.test(value)

function parseMoney(value: unknown): Money | null {
  const money = plainRecord(value)
  return money && isMicros(money.micros) && typeof money.currency === "string" && isCurrencyCode(money.currency) ? { micros: money.micros, currency: money.currency } : null
}

function parseReceipt(value: unknown): Receipt | null {
  const receipt = plainRecord(value)
  if (!receipt || typeof receipt.wallet !== "string" || !isAddress(receipt.wallet) || typeof receipt.legId !== "string" || typeof receipt.asset !== "string" || !isMicros(receipt.units)) return null
  return { wallet: normalizeAddress(receipt.wallet), legId: receipt.legId, asset: receipt.asset, units: receipt.units }
}

function parseExchangeCost(value: unknown): ExchangeCost | null {
  const cost = plainRecord(value)
  const money = parseMoney(value)
  if (!cost || !money || typeof cost.asset !== "string" || !Array.isArray(cost.receipts)) return null
  const receipts = cost.receipts.map(parseReceipt)
  return receipts.includes(null) ? null : { ...money, asset: cost.asset, receipts: receipts as Receipt[] }
}

function parseAnswer(value: unknown): SenderAnswer | null {
  const answer = plainRecord(value)
  if (answer?.kind === "mine" || answer?.kind === "someone-else") return { kind: answer.kind }
  if (answer?.kind !== "my-exchange") return null
  if (answer.costs === undefined) return { kind: "my-exchange" }
  if (!Array.isArray(answer.costs)) return null
  const costs: ExchangeCost[] = []
  for (const value of answer.costs) {
    const cost = parseExchangeCost(value)
    if (!cost) return null
    costs.push(cost)
  }
  return { kind: "my-exchange", costs }
}

function parseWithdrawal(value: unknown): ExchangeWithdrawal | null {
  const row = plainRecord(value)
  if (!row || typeof row.exchange !== "string" || typeof row.asset !== "string" || !isMicros(row.units)) return null
  const cost = parseMoney(row.cost)
  if (!cost) return null
  if (typeof row.at !== "string" || Number.isNaN(Date.parse(row.at))) return null
  if (row.toAddress !== null && (typeof row.toAddress !== "string" || !isAddress(row.toAddress))) return null
  return { exchange: row.exchange, asset: row.asset, units: row.units, at: row.at, cost, toAddress: row.toAddress === null ? null : normalizeAddress(row.toAddress) }
}

function parsePurchase(value: unknown): Purchase | null {
  const row = plainRecord(value)
  if (!row || row.provider !== "coinbase" || typeof row.order !== "string" || typeof row.wallet !== "string" || !isAddress(row.wallet) || typeof row.asset !== "string" || !isMicros(row.units) || typeof row.txHash !== "string") return null
  const cost = parseMoney(row.cost)
  // The Mac app's encoder leaves out what it doesn't have.
  const blockNum = row.blockNum ?? null
  const costUsdMicros = row.costUsdMicros ?? null
  if (!cost || (blockNum !== null && !Number.isSafeInteger(blockNum)) || (costUsdMicros !== null && !isMicros(costUsdMicros))) return null
  return { provider: row.provider, order: row.order, wallet: normalizeAddress(row.wallet), asset: row.asset, units: row.units, txHash: row.txHash.toLowerCase(), blockNum: blockNum as number | null, cost, costUsdMicros: costUsdMicros as string | null }
}

/** A book from a request, or null when it isn't one. Clients can send anything here. */
export function parseBook(value: unknown): Book | null {
  const book = plainRecord(value)
  if (!book) return null
  const senders = plainRecord(book.senders ?? {})
  const costs = plainRecord(book.costs ?? {})
  const withdrawals = book.withdrawals ?? []
  if (!senders || !costs || !Array.isArray(withdrawals)) return null
  const parsed = emptyBook()
  for (const [address, raw] of Object.entries(senders)) {
    const answer = parseAnswer(raw)
    if (!isAddress(address) || !answer) return null
    parsed.senders[normalizeAddress(address)] = answer
  }
  for (const [key, raw] of Object.entries(costs)) {
    const money = parseMoney(raw)
    if (!money) return null
    parsed.costs[key] = money
  }
  for (const raw of withdrawals) {
    const withdrawal = parseWithdrawal(raw)
    if (!withdrawal) return null
    parsed.withdrawals.push(withdrawal)
  }
  const purchases = book.purchases ?? []
  if (!Array.isArray(purchases)) return null
  for (const raw of purchases) {
    const purchase = parsePurchase(raw)
    if (!purchase) return null
    parsed.purchases = [...(parsed.purchases ?? []), purchase]
  }
  return parsed
}

/**
 * Which wallet a signature links `address` to: the one showing if that's the user's, or another of theirs. With none yet, it
 * speaks for itself. A wallet that's only being looked at never comes into it, because one wallet's signature says nothing about
 * another, and neither does the demo, whose wallets nobody owns even after answering for them.
 */
export function proofOwner(book: Book, address: string, current: string): string {
  const others = linkedWallets(book).filter((wallet) => wallet !== normalizeAddress(address) && wallet !== DEMO_ADDRESS && wallet !== DEMO_SAVINGS_ADDRESS)
  return others.find((wallet) => wallet === normalizeAddress(current)) ?? others[0] ?? normalizeAddress(address)
}

/** What a wallet signs to prove it's yours. It says what it does, and it can't move anything. */
export function linkMessage(owner: string, address: string): string {
  return `Patina: ${normalizeAddress(address)} is my wallet, and belongs with ${normalizeAddress(owner)}.\n\nThis only links them in my own app. It can't move funds or approve anything.`
}
