// What a wallet has let others spend: the events that grant it, and how to read what each still allows.
// Events only say an approval was given. What it allows now is read from the contract, because spending uses it up.

import { ERC20_ADDRESSES, normalizeAddress } from "./tokens.ts"

/** Uniswap's, and the same address on every chain. Tokens approve it once, and it hands out its own allowances. */
export const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3"

/** ERC-20's, with the amount in the data. ERC-721's has the same topic, with the token ID as a fourth topic. */
export const APPROVAL_TOPIC = "8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925"
/** `ApprovalForAll(owner, operator, approved)`: every NFT in a collection, now and later. */
export const APPROVAL_FOR_ALL_TOPIC = "17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31"
/** Permit2's `Approval(owner, token, spender, amount, expiration)`. */
export const PERMIT2_APPROVAL_TOPIC = "da9fa7c1b00402c17d0161b249b1ab8bbec047c5a52207b9c112deffd817036b"
/** Permit2's `Permit(owner, token, spender, amount, expiration, nonce)`: a signature that was used, and is now an allowance. */
export const PERMIT2_PERMIT_TOPIC = "c6a377bfc4eb120024a8ac08eef205be16b817020812c73223e81d1bdb9708ec"

const hex = (address: string) => normalizeAddress(address).slice(2)

/**
 * The logs that grant an approval, as a WHERE clause on a logs table. Every one has the owner as `topic1`, so a wallet's
 * are `topic1 = <its address as a word>`. Revoking emits the same events, with nothing allowed, and the check says so.
 */
export const APPROVAL_LOGS = `((topic0 = X'${APPROVAL_TOPIC}' AND topic3 IS NULL) OR topic0 = X'${APPROVAL_FOR_ALL_TOPIC}' OR (address = X'${hex(PERMIT2)}' AND topic0 IN (X'${PERMIT2_APPROVAL_TOPIC}', X'${PERMIT2_PERMIT_TOPIC}')))`

/** What an approval covers. */
export type ApprovalKind =
  /** An ERC-20's `approve`: the spender can take up to the amount. */
  | "token"
  /** Permit2's own allowance, which only works while the token also approves Permit2. It expires. */
  | "permit2"
  /** Every NFT in a collection. */
  | "collection"

/**
 * The big contracts on Base, by whose they are. A name only says whose contract it is, never that it's safe. Each address was
 * checked to hold code on Base, and `tokens.json` holds the Swift package to the same list, so the Security list and a site's
 * request agree.
 */
export const KNOWN_CONTRACTS: Readonly<Record<string, string>> = {
  [PERMIT2]: "Uniswap Permit2",
  "0x6ff5693b99212da76ad316178a184ab56d299b43": "Uniswap",
  "0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7": "Uniswap",
  "0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40": "Uniswap",
  "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad": "Uniswap",
  "0x2626664c2603336e57b271c5c0b26f421741e481": "Uniswap",
  "0x03a520b32c04bf3beef7beb72e919cf822ed34f1": "Uniswap Positions",
  "0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43": "Aerodrome",
  "0xdef1c0ded9bec7f1a1670819833240f027b25eff": "0x",
  "0x111111125421ca6dc452d289314280a0f8842a65": "1inch",
  "0x19ceead7105607cd444f5ad10dd51356436095a1": "Odos",
  "0x9008d19f58aabd9ed0d60971565aa8510560ab41": "CoW Swap",
  "0xc92e8bdf79f0507f65a392b0ab4667716bfe0110": "CoW Swap",
}

/** Uniswap's routers spend through Permit2, so their Permit2 allowances are worth checking whatever the history says. */
const PERMIT2_SPENDERS = ["0x6ff5693b99212da76ad316178a184ab56d299b43", "0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7", "0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40", "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad"]

export const spenderName = (address: string): string | null => KNOWN_CONTRACTS[normalizeAddress(address)] ?? null

/** One approval this wallet may still have: who can spend what. `grant` is the newest event about it, when one was found. */
export type Candidate = {
  kind: ApprovalKind
  /** The token, or for a collection, its contract. */
  token: string
  spender: string
  grant: { txHash: string; blockNum: number; timestamp: string; logIndex: number } | null
}

export const candidateKey = ({ kind, token, spender }: Pick<Candidate, "kind" | "token" | "spender">) => `${kind}:${normalizeAddress(token)}:${normalizeAddress(spender)}`

/** A log as the logs table has it, with each topic as hex with no prefix. */
export type ApprovalLog = { block_num: number; timestamp: string; tx_hash: string; log_index: number; address: string; topic0: string; topic1: string | null; topic2: string | null; topic3: string | null }

const topicAddress = (topic: string | null) => (topic && /^(0x)?[0-9a-f]{64}$/i.test(topic) ? `0x${topic.slice(-40).toLowerCase()}` : null)
const bare = (value: string) => value.replace(/^0x/, "").toLowerCase()

/** What each log says this owner approved, keeping only the newest event for each. Anything that isn't one of these logs is left out. */
export function candidatesFromLogs(owner: string, logs: readonly ApprovalLog[]): Candidate[] {
  const me = normalizeAddress(owner)
  const byKey = new Map<string, Candidate>()
  const sorted = [...logs].sort((a, b) => a.block_num - b.block_num || a.log_index - b.log_index)
  for (const log of sorted) {
    if (topicAddress(log.topic1) !== me) continue
    const topic0 = bare(log.topic0)
    const contract = normalizeAddress(log.address.startsWith("0x") ? log.address : `0x${log.address}`)
    let candidate: Omit<Candidate, "grant"> | null = null
    if (topic0 === APPROVAL_TOPIC && log.topic3 === null) {
      const spender = topicAddress(log.topic2)
      if (spender) candidate = { kind: "token", token: contract, spender }
    } else if (topic0 === APPROVAL_FOR_ALL_TOPIC) {
      const operator = topicAddress(log.topic2)
      if (operator) candidate = { kind: "collection", token: contract, spender: operator }
    } else if (contract === PERMIT2 && (topic0 === PERMIT2_APPROVAL_TOPIC || topic0 === PERMIT2_PERMIT_TOPIC)) {
      const token = topicAddress(log.topic2)
      const spender = topicAddress(log.topic3)
      if (token && spender) candidate = { kind: "permit2", token, spender }
    }
    if (!candidate) continue
    byKey.set(candidateKey(candidate), { ...candidate, grant: { txHash: `0x${bare(log.tx_hash)}`, blockNum: log.block_num, timestamp: log.timestamp, logIndex: log.log_index } })
  }
  return [...byKey.values()]
}

/**
 * The approvals worth checking whatever the history covers: every tracked token to each known contract, and to Uniswap's
 * routers through Permit2. These are most of what people approve, so an approval older than the history still shows.
 */
export function knownSpenderCandidates(): Candidate[] {
  const tokens = ERC20_ADDRESSES.flatMap((token) => Object.keys(KNOWN_CONTRACTS).map((spender): Candidate => ({ kind: "token", token, spender, grant: null })))
  const permit2 = ERC20_ADDRESSES.flatMap((token) => PERMIT2_SPENDERS.map((spender): Candidate => ({ kind: "permit2", token, spender, grant: null })))
  return [...tokens, ...permit2]
}

/** Found ones first, so they keep their event when both lists have the same approval. */
export function mergeCandidates(...lists: readonly (readonly Candidate[])[]): Candidate[] {
  const byKey = new Map<string, Candidate>()
  for (const list of lists) for (const candidate of list) if (!byKey.has(candidateKey(candidate))) byKey.set(candidateKey(candidate), candidate)
  return [...byKey.values()]
}

/** At or above this, an allowance is more than any token's supply, so it's as good as unlimited. Wallets usually ask for the maximum. */
export const UNLIMITED = 2n ** 128n

/** What an approval allows right now, from the contract. `amount` is null for a collection, which allows everything or nothing. */
export type CheckedApproval = Candidate & { amount: bigint | null; expiresAt: number | null }

/** Whether an approval still lets the spender take anything. An expired Permit2 allowance doesn't. */
export function isActive({ kind, amount, expiresAt }: Pick<CheckedApproval, "kind" | "amount" | "expiresAt">, nowSeconds: number): boolean {
  if (kind === "collection") return amount === 1n
  if (amount === null || amount === 0n) return false
  return kind !== "permit2" || (expiresAt !== null && expiresAt > nowSeconds)
}
