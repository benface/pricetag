// The user's answers about where things came from. They stay on the device: clients keep them and send them along with
// each request, and the server doesn't store them. Writing one onchain would publicly tie the wallets together.

import { isAddress } from "./api.ts"
import { normalizeAddress } from "./tokens.ts"

export type SenderAnswer =
  | { kind: "mine" }
  /** `costs` is what was paid for everything from this address, by asset, in micro-USD. */
  | { kind: "my-exchange"; costs?: Record<string, string> }
  | { kind: "someone-else" }

/** A withdrawal found in an exchange's history. See `exchange-import.ts`. */
export type ExchangeWithdrawal = {
  exchange: string
  asset: string
  units: string
  at: string
  costUsdMicros: string
  toAddress: string | null
}

export type Book = {
  senders: Record<string, SenderAnswer>
  /** A cost entered for one movement, by `<wallet>:<leg id>`, in micro-USD. */
  costs: Record<string, string>
  withdrawals: ExchangeWithdrawal[]
}

export const emptyBook = (): Book => ({ senders: {}, costs: {}, withdrawals: [] })

export const costKey = (wallet: string, legId: string) => `${normalizeAddress(wallet)}:${legId}`

/** Answering for a sender. Saying it's yours says the wallet you're looking at is yours too. */
export function answerSender(book: Book, focus: string, sender: string, answer: SenderAnswer): Book {
  const senders: Book["senders"] = { ...book.senders, [normalizeAddress(sender)]: answer }
  if (answer.kind === "mine" && isAddress(focus)) senders[normalizeAddress(focus)] = { kind: "mine" }
  return { ...book, senders }
}

export const linkedWallets = (book: Book) => Object.entries(book.senders).flatMap(([address, answer]) => (answer.kind === "mine" ? [address] : []))

const isMicros = (value: unknown): value is string => typeof value === "string" && /^\d{1,30}$/.test(value)

const plainRecord = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null)

function parseAnswer(value: unknown): SenderAnswer | null {
  const answer = plainRecord(value)
  if (answer?.kind === "mine" || answer?.kind === "someone-else") return { kind: answer.kind }
  if (answer?.kind !== "my-exchange") return null
  if (answer.costs === undefined) return { kind: "my-exchange" }
  const costs = plainRecord(answer.costs)
  if (!costs || !Object.values(costs).every(isMicros)) return null
  return { kind: "my-exchange", costs: { ...(costs as Record<string, string>) } }
}

function parseWithdrawal(value: unknown): ExchangeWithdrawal | null {
  const row = plainRecord(value)
  if (!row || typeof row.exchange !== "string" || typeof row.asset !== "string" || !isMicros(row.units) || !isMicros(row.costUsdMicros)) return null
  if (typeof row.at !== "string" || Number.isNaN(Date.parse(row.at))) return null
  if (row.toAddress !== null && (typeof row.toAddress !== "string" || !isAddress(row.toAddress))) return null
  return { exchange: row.exchange, asset: row.asset, units: row.units, at: row.at, costUsdMicros: row.costUsdMicros, toAddress: row.toAddress === null ? null : normalizeAddress(row.toAddress) }
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
    if (!isMicros(raw)) return null
    parsed.costs[key] = raw
  }
  for (const raw of withdrawals) {
    const withdrawal = parseWithdrawal(raw)
    if (!withdrawal) return null
    parsed.withdrawals.push(withdrawal)
  }
  return parsed
}

/** What a wallet signs to prove it's yours. It says what it does, and it can't move anything. */
export function linkMessage(owner: string, address: string): string {
  return `Patina: ${normalizeAddress(address)} is my wallet, and belongs with ${normalizeAddress(owner)}.\n\nThis only links them in my own app. It can't move funds or approve anything.`
}
