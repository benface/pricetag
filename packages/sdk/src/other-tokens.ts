// Tokens off the allowlist that a wallet holds, with what the chain says about them. They're apart from `positions` on purpose:
// the fold, the totals, sweeps and the cap never see them, so a token anyone can send can't change a number or move any money.
// Everything a contract answers is untrusted. It can lie, revert, burn all its gas or call itself USDC.

import type { LegRow } from "./legs.ts"
import { TOKENS, tokenByAddress } from "./tokens.ts"

export type OtherToken = {
  token: string
  /** A collectible's balance is how many items it holds, and it has no decimals to ask for. */
  kind: "token" | "collectible"
  /** Cleaned up, and still only what the contract claims. Show it with the address. */
  name: string | null
  symbol: string | null
  /** Null when the contract gave no usable answer, so `balance` is in its smallest unit. */
  decimals: number | null
  /** Null while it's being read, or when it can't be. Never 0 for that. */
  balance: string | null
  state: "reading" | "read" | "unreadable"
  /** What's wrong with it, in words. */
  note: string | null
  /** Why this is tucked away as possible spam, in words, or null when it's shown with the rest. It doesn't mean it's worthless. */
  tucked: string | null
}

export type OtherTokens = {
  otherTokens: OtherToken[]
  /** Past `MAX_OTHER_TOKENS`, moved through this wallet and not read at all. */
  otherTokensLeftOut: number
}

export const NO_OTHER_TOKENS: OtherTokens = { otherTokens: [], otherTokensLeftOut: 0 }

const byName = (a: OtherToken, b: OtherToken) => (a.symbol ?? a.name ?? a.token).toLowerCase().localeCompare((b.symbol ?? b.name ?? b.token).toLowerCase()) || a.token.localeCompare(b.token)

/** A busy wallet can have thousands, nearly all spam, and each one read costs a call. */
export const MAX_OTHER_TOKENS = 300
/** Each token is up to four calls in one `eth_call`. */
const TOKENS_PER_QUERY = 25
/** Reads run one at a time on a shared Amp, ahead of the wallet's next read, so this is the most a read can make it wait for. */
const QUERIES_PER_PASS = 2
/** A balance can change with no transfer, as a rebasing token's does. */
const BALANCE_MAX_AGE_MS = 5 * 60_000
const RETRY_BAD_ANSWER_MS = 10 * 60_000
/** After a query fails or times out, so an outage or a contract that hangs doesn't hold up every wallet read. */
const BACKOFF_MS = 60_000
const MAX_TEXT_BYTES = 256
const MAX_NAME = 64
const MAX_SYMBOL = 16
/** Amounts are compared as whole tokens at 36 decimals, and a real token doesn't get near that. */
const MAX_DECIMALS = 36
const MAX_TOKENS_REMEMBERED = 20_000
const MAX_ACCOUNTS_REMEMBERED = 200

const WORD_HEX = 64
const AGGREGATE3 = "82ad56cb"
const BALANCE_OF = "70a08231"
const NAME = "06fdde03"
const SYMBOL = "95d89b41"
const DECIMALS = "313ce567"

const word = (value: bigint | number) => BigInt(value).toString(16).padStart(WORD_HEX, "0")
const padded = (hex: string) => hex.padEnd(Math.ceil(hex.length / WORD_HEX) * WORD_HEX, "0")

/** Calldata for `aggregate3` where any call can fail, as hex with no prefix. */
export function encodeAggregate3(calls: readonly { target: string; data: string }[]): string {
  const bodies = calls.map(({ target, data }) => target.slice(2).toLowerCase().padStart(WORD_HEX, "0") + word(1) + word(96) + word(data.length / 2) + padded(data))
  let offset = calls.length * 32
  const offsets = bodies.map((body) => {
    const here = offset
    offset += body.length / 2
    return word(here)
  })
  return AGGREGATE3 + word(32) + word(calls.length) + offsets.join("") + bodies.join("")
}

/** Each call's returned bytes as hex, null where it failed. Null overall when the bytes aren't what `aggregate3` returns for `count` calls. */
export function decodeAggregate3(data: string | null | undefined, count: number): (string | null)[] | null {
  if (!data || !/^[0-9a-fA-F]*$/.test(data)) return null
  const size = data.length / 2
  const wordAt = (byte: number): number | null => {
    if (byte < 0 || byte + 32 > size) return null
    const value = BigInt(`0x${data.slice(byte * 2, (byte + 32) * 2)}`)
    return value > BigInt(size) ? Number.POSITIVE_INFINITY : Number(value)
  }
  const list = wordAt(0)
  if (list === null || wordAt(list) !== count) return null
  const start = list + 32
  const results: (string | null)[] = []
  for (let i = 0; i < count; i++) {
    const offset = wordAt(start + i * 32)
    if (offset === null) return null
    const item = start + offset
    const success = wordAt(item)
    const relative = wordAt(item + 32)
    if (success === null || relative === null) return null
    const length = wordAt(item + relative)
    if (length === null || item + relative + 32 + length > size) return null
    results.push(success === 1 ? data.slice((item + relative + 32) * 2, (item + relative + 32 + length) * 2) : null)
  }
  return results
}

/** What's safe to put on a screen: no control or direction characters, nothing piled on one letter, and not too long. Null when there's nothing left. */
export function cleanText(text: string, limit: number): string | null {
  const clean = text
    .normalize("NFC")
    .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "")
    .replace(/\p{M}{3,}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
  const characters = Array.from(clean)
  if (characters.length === 0) return null
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("").trimEnd()}…` : clean
}

function utf8(hex: string): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16)))
  } catch {
    return null
  }
}

/** A `string`, or the `bytes32` some old tokens return. Null when it's neither, or too long to be a name. */
export function decodeText(hex: string | null, limit: number): string | null {
  if (!hex) return null
  if (hex.length === WORD_HEX) return cleanText(utf8(hex.replace(/(00)+$/, "")) ?? "", limit)
  if (hex.length < WORD_HEX * 2 || hex.length % WORD_HEX !== 0) return null
  const offset = BigInt(`0x${hex.slice(0, WORD_HEX)}`)
  if (offset !== 32n) return null
  const length = BigInt(`0x${hex.slice(WORD_HEX, WORD_HEX * 2)}`)
  if (length > BigInt(MAX_TEXT_BYTES) || WORD_HEX * 2 + Number(length) * 2 > hex.length) return null
  const text = utf8(hex.slice(WORD_HEX * 2, WORD_HEX * 2 + Number(length) * 2))
  return text === null ? null : cleanText(text, limit)
}

const decodeDecimals = (hex: string | null): number | null => {
  if (hex?.length !== WORD_HEX) return null
  const value = BigInt(`0x${hex}`)
  return value <= BigInt(MAX_DECIMALS) ? Number(value) : null
}

const decodeBalance = (hex: string | null): string | null => (hex?.length === WORD_HEX ? BigInt(`0x${hex}`).toString() : null)

export type TokenRequest = { token: string; balance: boolean; details: boolean; decimals: boolean }
/** Null for a call with no usable answer. A field that wasn't asked for is left out. */
export type TokenAnswer = { balance?: string | null; name?: string | null; symbol?: string | null; decimals?: number | null }
/** Null when the whole call gave nothing, which is what one contract using up all the gas looks like. */
export type ReadTokenFacts = (account: string, requests: readonly TokenRequest[], block: number) => Promise<Map<string, TokenAnswer> | null>

/** The calls for these requests, in the order `decodeTokenFacts` reads them. */
export function encodeTokenFacts(account: string, requests: readonly TokenRequest[]): string {
  const me = account.slice(2).toLowerCase().padStart(WORD_HEX, "0")
  return encodeAggregate3(
    requests.flatMap(({ token, balance, details, decimals }) => [
      ...(balance ? [{ target: token, data: BALANCE_OF + me }] : []),
      ...(details ? [{ target: token, data: NAME }, { target: token, data: SYMBOL }] : []),
      ...(decimals ? [{ target: token, data: DECIMALS }] : []),
    ]),
  )
}

export function decodeTokenFacts(data: string | null | undefined, requests: readonly TokenRequest[]): Map<string, TokenAnswer> | null {
  const count = requests.reduce((sum, { balance, details, decimals }) => sum + Number(balance) + (details ? 2 : 0) + Number(decimals), 0)
  const results = decodeAggregate3(data, count)
  if (!results) return null
  let next = 0
  const take = () => results[next++] ?? null
  return new Map(
    requests.map(({ token, balance, details, decimals }) => {
      const answer: TokenAnswer = {}
      if (balance) answer.balance = decodeBalance(take())
      if (details) {
        answer.name = decodeText(take(), MAX_NAME)
        answer.symbol = decodeText(take(), MAX_SYMBOL)
      }
      if (decimals) answer.decimals = decodeDecimals(take())
      return [token, answer]
    }),
  )
}

// Letters from other alphabets that look like Latin ones, as a token copying a name would use them.
const LOOKALIKES: Record<string, string> = { А: "A", В: "B", С: "C", Е: "E", Н: "H", І: "I", К: "K", М: "M", О: "O", Р: "P", Т: "T", Х: "X", Ѕ: "S", Α: "A", Β: "B", Ε: "E", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Χ: "X", Υ: "Y", Ζ: "Z", "$": "S" }
const plainLetters = (text: string) =>
  Array.from(text.normalize("NFKC").toUpperCase(), (letter) => LOOKALIKES[letter] ?? letter)
    .join("")
    .replace(/[^A-Z0-9]/g, "")
const KNOWN_NAMES = new Map([...TOKENS.map((t) => [plainLetters(t.symbol), t.symbol] as const), ["ETHER", "ETH"], ["ETHEREUM", "ETH"], ["WRAPPEDETHER", "WETH"], ["USDCOIN", "USDC"], ["TETHER", "USDT"], ["TETHERUSD", "USDT"], ["DAISTABLECOIN", "DAI"], ["COINBASEWRAPPEDBTC", "cbBTC"], ["COINBASEWRAPPEDSTAKEDETH", "cbETH"]])
const WEB_ADDRESS = /(https?:|www\.|\b[\p{L}\p{N}-]+\.(com|net|org|io|xyz|app|site|top|click|live|fun|vip|link|pro|finance|claim|gift|cc|co|me|info|to|gg)\b|\bclaim\b|\bvisit\b)/iu

/**
 * Whether to tuck a token away, as a rule anyone can read in the app: it copies a token we know, it has a web address or
 * "claim" in its name, its contract doesn't answer, or nothing this wallet sent moved it. That can be wrong in both directions,
 * so it's never called worthless and it's a click away.
 */
export function tuckedReason({ name, symbol, state }: Pick<OtherToken, "name" | "symbol" | "state">, sentByThisWallet: boolean): string | null {
  const copied = [symbol, name].map((text) => (text ? KNOWN_NAMES.get(plainLetters(text)) : undefined)).find(Boolean)
  if (copied) return `It calls itself ${copied}, and it isn't the ${copied} we know.`
  if ([name, symbol].some((text) => text && WEB_ADDRESS.test(text))) return "Its name points you to a website, which is a common way to lure people to a scam."
  if (state === "unreadable") return "Its contract doesn't answer properly."
  if (!sentByThisWallet) return "It arrived without any transaction of yours."
  return null
}

/** What rows say about one token, all that's needed to know whether it's held and what to ask its contract. */
type Moved = { token: string; lastBlock: number; net: bigint; unreadable: boolean; collectible: boolean; multiple: boolean; sentByThisWallet: boolean }

function movedTokens(rows: readonly LegRow[], account: string, gasUnknown: ReadonlyMap<string, number>): Moved[] {
  const sent = new Set(gasUnknown.keys())
  for (const row of rows) if (row.kind === "gas" && row.account === account) sent.add(row.tx_hash)
  const tokens = new Map<string, Moved>()
  for (const row of rows) {
    if (row.account !== account || (row.kind !== "unlisted" && row.kind !== "unlisted_nft") || tokenByAddress(row.token)) continue
    const moved = tokens.get(row.token) ?? { token: row.token, lastBlock: 0, net: 0n, unreadable: false, collectible: false, multiple: false, sentByThisWallet: false }
    moved.lastBlock = Math.max(moved.lastBlock, row.block_num)
    if (sent.has(row.tx_hash)) moved.sentByThisWallet = true
    if (row.kind === "unlisted_nft") {
      moved.collectible = true
      moved.unreadable = true
    } else if (/^\d+$/.test(row.amount)) moved.net += row.side === "credit" ? BigInt(row.amount) : -BigInt(row.amount)
    else {
      // ERC-1155 logs have no amount the dataset can read, and its `balanceOf` takes an item as well.
      moved.collectible = true
      moved.multiple = true
      moved.unreadable = true
    }
    tokens.set(row.token, moved)
  }
  return [...tokens.values()]
}

type Details = { name: string | null; symbol: string | null; decimals: number | null; readAt: number; complete: boolean }
type Balance = { balance: string | null; atBlock: number; readAt: number }

const NOTES = {
  multiple: "This kind of token doesn't report one balance, so this wallet may or may not still hold it.",
  balance: "Its contract didn't answer when asked for this wallet's balance.",
  decimals: "Its contract won't say how it divides up, so this counts its smallest unit.",
  name: "Its contract doesn't give a name.",
}

/**
 * Keeps what the chain says about other tokens, and reads what's missing between wallet reads. A wallet read never waits for
 * this and can't fail because of it: a token shows as still reading until its answer arrives, and each read of a wallet picks
 * up what's arrived since. What can change is read again when it might have, and what a contract says about itself is read once.
 */
export function createOtherTokens(read: ReadTokenFacts, logger: { warn(message: string): void } = console, now: () => number = Date.now) {
  const details = new Map<string, Details>()
  const balances = new Map<string, Map<string, Balance>>()
  /** How many tokens to read a token with, after a query with it in failed. Halving finds a contract that uses up all the gas. */
  const groupSize = new Map<string, number>()
  let blockedUntil = 0
  let rewinds = 0
  let passing: Promise<void> | null = null

  /** Which ones to bother with, most likely to matter first. A token read as empty and not moved since doesn't use a place. */
  function select(account: string, moved: readonly Moved[]) {
    const known = balances.get(account)
    const live = moved.filter(({ token, lastBlock }) => {
      const balance = known?.get(token)
      return !(balance?.balance === "0" && balance.atBlock >= lastBlock)
    })
    const score = ({ sentByThisWallet, net, unreadable }: Moved) => (sentByThisWallet ? 2 : net > 0n || unreadable ? 1 : 0)
    live.sort((a, b) => score(b) - score(a) || b.lastBlock - a.lastBlock || a.token.localeCompare(b.token))
    return { chosen: live.slice(0, MAX_OTHER_TOKENS), leftOut: Math.max(0, live.length - MAX_OTHER_TOKENS) }
  }

  function requestFor(account: string, moved: Moved, at: number): TokenRequest | null {
    const balance = balances.get(account)?.get(moved.token)
    const known = details.get(moved.token)
    const wantsBalance = !moved.multiple && (!balance || balance.atBlock < moved.lastBlock || at - balance.readAt >= (balance.balance === null ? RETRY_BAD_ANSWER_MS : BALANCE_MAX_AGE_MS))
    const wantsDetails = !known || (!known.complete && at - known.readAt >= RETRY_BAD_ANSWER_MS)
    if (!wantsBalance && !wantsDetails) return null
    return { token: moved.token, balance: wantsBalance, details: wantsDetails, decimals: wantsDetails && !moved.collectible }
  }

  function remember(account: string, block: number, moved: Moved, request: TokenRequest, answer: TokenAnswer | undefined) {
    const at = now()
    if (request.balance) {
      const own = balances.get(account) ?? new Map<string, Balance>()
      balances.delete(account)
      balances.set(account, own)
      if (balances.size > MAX_ACCOUNTS_REMEMBERED) balances.delete(balances.keys().next().value as string)
      // A last answer's better than none, and it's read again soon enough.
      own.set(request.token, { balance: answer?.balance ?? own.get(request.token)?.balance ?? null, atBlock: block, readAt: at })
    }
    if (request.details) {
      const last = details.get(request.token)
      const decimals = moved.collectible ? 0 : (answer?.decimals ?? last?.decimals ?? null)
      details.delete(request.token)
      details.set(request.token, { name: answer?.name ?? last?.name ?? null, symbol: answer?.symbol ?? last?.symbol ?? null, decimals, readAt: at, complete: decimals !== null })
      if (details.size > MAX_TOKENS_REMEMBERED) details.delete(details.keys().next().value as string)
    }
  }

  async function pass(account: string, chosen: readonly Moved[], block: number, isBusy: () => boolean) {
    const started = rewinds
    const at = now()
    const movedOf = new Map(chosen.map((moved) => [moved.token, moved]))
    const due = chosen.flatMap((moved) => requestFor(account, moved, at) ?? [])
    const sizeOf = ({ token }: TokenRequest) => groupSize.get(token) ?? TOKENS_PER_QUERY
    due.sort((a, b) => sizeOf(a) - sizeOf(b))
    for (let queries = 0; queries < QUERIES_PER_PASS && due.length > 0 && !isBusy(); queries++) {
      const group = due.splice(0, sizeOf(due[0] as TokenRequest))
      let answers: Map<string, TokenAnswer> | null = null
      let failed = false
      try {
        answers = await read(account, group, block)
      } catch (error) {
        logger.warn(`Couldn't read other tokens: ${error instanceof Error ? error.message : String(error)}`)
        failed = true
        blockedUntil = now() + BACKOFF_MS
      }
      if (started !== rewinds) return
      if (!answers && group.length > 1) {
        for (const { token } of group) groupSize.set(token, Math.ceil(group.length / 2))
      } else {
        for (const request of group) {
          const answer = answers?.get(request.token)
          const asked = (request.balance && answer?.balance == null) || (request.decimals && answer?.decimals == null)
          // Another contract in the group can have used up the gas this one needed, so it gets a query to itself before it's blamed.
          if (answers && asked && group.length > 1) groupSize.set(request.token, 1)
          else {
            groupSize.delete(request.token)
            remember(account, block, movedOf.get(request.token) as Moved, request, answer)
          }
        }
      }
      if (failed) return
    }
  }

  function toOtherToken(account: string, moved: Moved): OtherToken | null {
    const about = details.get(moved.token)
    const balance = balances.get(account)?.get(moved.token)
    const held = moved.net > 0n || moved.unreadable
    if (balance?.balance === "0" || (!held && balance?.balance == null)) return null
    const state: OtherToken["state"] = moved.multiple ? "read" : !balance ? "reading" : balance.balance === null ? "unreadable" : "read"
    const decimals = about?.decimals ?? null
    const note = moved.multiple ? NOTES.multiple : state === "unreadable" ? NOTES.balance : !about ? null : decimals === null ? NOTES.decimals : about.name === null && about.symbol === null ? NOTES.name : null
    const facts = { name: about?.name ?? null, symbol: about?.symbol ?? null, state }
    return { token: moved.token, kind: moved.collectible ? "collectible" : "token", ...facts, decimals, balance: moved.multiple ? null : (balance?.balance ?? null), note, tucked: tuckedReason(facts, moved.sentByThisWallet) }
  }

  return {
    /** What's known now, with no query. */
    view(account: string, rows: readonly LegRow[], gasUnknown: ReadonlyMap<string, number>): OtherTokens {
      const { chosen, leftOut } = select(account, movedTokens(rows, account, gasUnknown))
      const otherTokens = chosen.flatMap((moved) => toOtherToken(account, moved) ?? [])
      return { otherTokens: otherTokens.sort(byName), otherTokensLeftOut: leftOut }
    },

    /** Starts reading what's due at `block`, if nothing else is. `isBusy` says a wallet read is waiting, and that goes first. */
    update(account: string, rows: readonly LegRow[], gasUnknown: ReadonlyMap<string, number>, block: number, isBusy: () => boolean = () => false) {
      if (passing || now() < blockedUntil) return
      const { chosen } = select(account, movedTokens(rows, account, gasUnknown))
      if (chosen.length === 0) return
      passing = pass(account, chosen, block, isBusy)
        .catch((error: unknown) => logger.warn(`Couldn't read other tokens: ${String(error)}`))
        .finally(() => {
          passing = null
        })
    },

    /** When what's been started has finished, for tests. */
    idle: async () => {
      await passing
    },

    /** A reorg replaced every block from `block` on, so what was read there may not be true anymore. */
    forgetFrom(block: number) {
      rewinds += 1
      for (const own of balances.values()) for (const [token, balance] of own) if (balance.atBlock >= block) own.delete(token)
    },
  }
}

export type OtherTokensReader = ReturnType<typeof createOtherTokens>

/** One wallet's list for several. A balance only adds up when every wallet's is known, and a token is only tucked away when it would be in every wallet. */
export function combineOtherTokens(lists: readonly OtherTokens[]): OtherTokens {
  const tokens = new Map<string, OtherToken>()
  for (const token of lists.flatMap(({ otherTokens }) => otherTokens)) {
    const known = tokens.get(token.token)
    if (!known) {
      tokens.set(token.token, token)
      continue
    }
    const state = known.state === "unreadable" || token.state === "unreadable" ? "unreadable" : known.state === "reading" || token.state === "reading" ? "reading" : "read"
    tokens.set(token.token, {
      ...known,
      state,
      note: known.note ?? token.note,
      balance: state === "read" && known.balance !== null && token.balance !== null ? (BigInt(known.balance) + BigInt(token.balance)).toString() : null,
      tucked: known.tucked !== null && token.tucked !== null ? known.tucked : null,
    })
  }
  return { otherTokens: [...tokens.values()].sort(byName), otherTokensLeftOut: Math.max(0, ...lists.map((list) => list.otherTokensLeftOut)) }
}
