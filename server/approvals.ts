// A wallet's approvals: found in Amp, then each checked against the contract at the head through Amp's `eth_call`,
// because what an event granted is often used up or revoked since.
//
// The Pricetag dataset's `approvals` table holds every approval event from its start block, so a wallet's are one quick
// read. Until a dataset has that table, or with no dataset at all, the same logs come from the raw Base dataset, which
// is much slower, so what's been read is kept and only new blocks are read again.

import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from "viem"
import { APPROVAL_LOGS, PERMIT2, UNLIMITED, USDC_ADDRESS, WETH_ADDRESS, candidateKey, candidatesFromLogs, formatAmount, isActive, knownSpenderCandidates, mergeCandidates, spenderName, tokenByAddress, type ApprovalLog, type Candidate, type CheckedApproval, type Head } from "@pricetag/sdk/core"
import { MULTICALL3, asIso, asNumber, hexOf, isNotStarted, type Query, type Row } from "@pricetag/sdk/internal"
import type { ApprovalsResponse, ApprovalView } from "../src/core/api.ts"
import { DEMO_SAVINGS_ADDRESS } from "../src/core/book.ts"
import { isMissingTable, walletTurns } from "./shared.ts"

const MULTICALL_ABI = parseAbi(["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)"])
const ERC20_ABI = parseAbi(["function allowance(address owner, address spender) view returns (uint256)"])
const PERMIT2_ABI = parseAbi(["function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)"])
const COLLECTION_ABI = parseAbi(["function isApprovedForAll(address owner, address operator) view returns (bool)"])

/** Each call is a few hundred bytes of SQL, so a wallet with many approvals is checked in a few reads. */
const CALLS_PER_READ = 150

/** Contracts nobody vouches for are each read in a call of their own, and this many go in one query. */
const ISOLATED_PER_READ = 40

/** How many blocks of raw logs one query reads. Staging read about 3,500 blocks a second of them. */
const RAW_BLOCKS_PER_QUERY = 50_000

function callOf(owner: string, { kind, token, spender }: Candidate): { target: Hex; allowFailure: true; callData: Hex } {
  const [o, t, s] = [owner, token, spender] as Hex[]
  switch (kind) {
    case "token":
      return { target: t!, allowFailure: true, callData: encodeFunctionData({ abi: ERC20_ABI, functionName: "allowance", args: [o!, s!] }) }
    case "permit2":
      return { target: PERMIT2, allowFailure: true, callData: encodeFunctionData({ abi: PERMIT2_ABI, functionName: "allowance", args: [o!, t!, s!] }) }
    case "collection":
      return { target: t!, allowFailure: true, callData: encodeFunctionData({ abi: COLLECTION_ABI, functionName: "isApprovedForAll", args: [o!, s!] }) }
  }
}

/** Calldata for one `aggregate3` that checks each candidate, as hex with no prefix. */
export function encodeChecks(owner: string, candidates: readonly Candidate[]): string {
  return encodeFunctionData({ abi: MULTICALL_ABI, functionName: "aggregate3", args: [candidates.map((candidate) => callOf(owner, candidate))] }).slice(2)
}

/**
 * Whether a candidate's check can share one `aggregate3` with others. Multicall3 runs each with CALL, so a contract in the
 * batch could change state before a later one is read, like spending an allowance it holds only inside the simulation. So
 * only Permit2 and tracked tokens, whose `allowance` only reads, share it. Everything else gets a call of its own.
 */
export const isTrustedCheck = ({ kind, token }: Pick<Candidate, "kind" | "token">) => kind === "permit2" || (kind === "token" && tokenByAddress(token) !== undefined)

/** What one candidate allows, from what its call returned, or null when that isn't the answer it asked for. */
export function decodeCheck(candidate: Candidate, returnData: string | null | undefined): CheckedApproval | null {
  if (!returnData) return null
  const data = `0x${returnData.replace(/^0x/, "")}` as Hex
  // A contract that doesn't have the function can still answer with something. Only exactly the right size counts.
  try {
    switch (candidate.kind) {
      case "token": {
        if (data.length !== 66) return null
        return { ...candidate, amount: decodeFunctionResult({ abi: ERC20_ABI, functionName: "allowance", data }), expiresAt: null }
      }
      case "permit2": {
        if (data.length !== 2 + 3 * 64) return null
        const [amount, expiration] = decodeFunctionResult({ abi: PERMIT2_ABI, functionName: "allowance", data })
        return { ...candidate, amount, expiresAt: Number(expiration) }
      }
      case "collection": {
        if (data.length !== 66) return null
        return { ...candidate, amount: decodeFunctionResult({ abi: COLLECTION_ABI, functionName: "isApprovedForAll", data }) ? 1n : 0n, expiresAt: null }
      }
    }
  } catch {
    return null
  }
}

/** What each candidate allows, in order, or null where its call failed or answered something else. Null overall when the bytes aren't `aggregate3`'s. */
export function decodeChecks(data: string | null | undefined, candidates: readonly Candidate[]): (CheckedApproval | null)[] | null {
  if (!data) return null
  let results: readonly { success: boolean; returnData: Hex }[]
  try {
    results = decodeFunctionResult({ abi: MULTICALL_ABI, functionName: "aggregate3", data: `0x${data.replace(/^0x/, "")}` })
  } catch {
    return null
  }
  if (results.length !== candidates.length) return null
  return candidates.map((candidate, i) => (results[i]!.success ? decodeCheck(candidate, results[i]!.returnData) : null))
}

/**
 * What an `eth_call` returned, only when it worked. Amp keeps a revert's bytes in `data` and says why in `message`, and those
 * bytes can be exactly the size of a real answer, so a call with a message is a failure, whatever its data looks like.
 */
export function callResult(result: unknown): string | null {
  const { data, message } = (result ?? {}) as { data?: unknown; message?: unknown }
  if (message !== null && message !== undefined && message !== "") return null
  return typeof data === "string" && data !== "" ? data : null
}

/** Calldata for one candidate's own check, as hex with no prefix, and the contract it goes to. */
export function isolatedCall(owner: string, candidate: Candidate): { target: string; data: string } {
  const { target, callData } = callOf(owner, candidate)
  return { target: target.toLowerCase(), data: callData.slice(2) }
}

/** Past this, a date can't be written as one, and an expiry that far off is as good as never. */
const LATEST_DATE_SECONDS = Date.UTC(9999, 11, 31, 23, 59, 59) / 1000

/** When a Permit2 allowance runs out. Null when it has none, or when it's so far off it never will, like the largest `uint48`. */
export function expiryOf(seconds: number | null): string | null {
  return seconds === null || seconds > LATEST_DATE_SECONDS ? null : new Date(seconds * 1000).toISOString()
}

/** What the apps show of one approval that still allows something. */
export function viewOf(approval: CheckedApproval, found: boolean): ApprovalView {
  const token = approval.kind === "collection" ? undefined : tokenByAddress(approval.token)
  const unlimited = approval.kind === "collection" || (approval.amount ?? 0n) >= UNLIMITED
  return {
    id: candidateKey(approval),
    kind: approval.kind,
    token: approval.token,
    symbol: token?.symbol ?? null,
    decimals: token?.decimals ?? null,
    spender: approval.spender,
    spenderName: spenderName(approval.spender),
    amount: approval.kind === "collection" ? null : String(approval.amount),
    amountText: unlimited ? null : token ? `${formatAmount(String(approval.amount), token.decimals)} ${token.symbol}` : null,
    unlimited,
    expiresAt: expiryOf(approval.expiresAt),
    grantedTx: approval.grant?.txHash ?? null,
    grantedBlock: approval.grant?.blockNum ?? null,
    grantedAt: approval.grant?.timestamp ?? null,
    found: found ? "history" : "known-spender",
  }
}

/** Biggest risk first: unlimited, then the rest, each newest first. */
export function sortViews(views: readonly ApprovalView[]): ApprovalView[] {
  return [...views].sort((a, b) => Number(b.unlimited) - Number(a.unlimited) || (b.grantedBlock ?? -1) - (a.grantedBlock ?? -1) || a.id.localeCompare(b.id))
}

const toLog = (row: Row): ApprovalLog => ({
  block_num: asNumber(row.block_num),
  timestamp: asIso(row.timestamp),
  tx_hash: String(row.tx_hash),
  log_index: asNumber(row.log_index),
  address: String(row.address),
  topic0: String(row.topic0),
  topic1: row.topic1 == null ? null : String(row.topic1),
  topic2: row.topic2 == null ? null : String(row.topic2),
  topic3: row.topic3 == null ? null : String(row.topic3),
})

const LOG_COLUMNS = "block_num, timestamp, tx_hash, log_index, address, topic0, topic1, topic2, topic3"

export type ApprovalsConfig = {
  baseDataset: string
  /** The Pricetag dataset as queries name it, and as it's shown. Null reads only the raw dataset. */
  dataset: { reference: string; name: string } | null
  network: string
  /** Where the history starts. The raw dataset only reads back as far as a wallet's history does. */
  historyFrom: (head: number) => number
}

/** What's been found of a wallet so far: every candidate in its history from `from` through `through`. */
type Held = { from: number; through: number; candidates: Candidate[] }

/** How many wallets' histories are kept, the least recently read going first. One that's gone is only read again. */
const MAX_HELD_WALLETS = 500

/** How many times a wallet's history is read again when a reorg comes while it's read. */
const MAX_ATTEMPTS = 3

export function createApprovals(query: Query, config: ApprovalsConfig) {
  const base = `"${config.baseDataset}"`
  const held = new Map<string, Held>()
  const inTurn = walletTurns()
  /** How many reorgs have been told about, so a read that crossed one knows. */
  let rewinds = 0
  /** Whether the dataset has the table, once a read has said. */
  let hasTable: boolean | null = config.dataset ? null : false

  async function readTable(owner: string, from: number, to: number): Promise<{ logs: ApprovalLog[]; through: number } | null> {
    if (!config.dataset || hasTable === false) return null
    const ds = `"${config.dataset.reference}"`
    try {
      // The table can be behind the chain, and a block it hasn't reached looks like one with nothing in it.
      const newest = await query<Row>(`SELECT block_num FROM ${ds}.approvals WHERE block_num >= ${from} ORDER BY block_num DESC LIMIT 1`, 15_000)
      hasTable = true
      const through = Math.min(to, newest[0] ? asNumber(newest[0].block_num) : from - 1)
      if (through < from) return { logs: [], through: from - 1 }
      const rows = await query<Row>(`SELECT ${LOG_COLUMNS} FROM ${ds}.approvals WHERE block_num BETWEEN ${from} AND ${through} AND topic1 = X'${owner.padStart(64, "0")}'`)
      return { logs: rows.map(toLog), through }
    } catch (error) {
      if (isNotStarted(error)) return { logs: [], through: from - 1 }
      if (!isMissingTable(error)) throw error
      hasTable = false
      return null
    }
  }

  async function readRaw(owner: string, from: number, to: number): Promise<ApprovalLog[]> {
    const logs: ApprovalLog[] = []
    for (let start = from; start <= to; start += RAW_BLOCKS_PER_QUERY) {
      const end = Math.min(to, start + RAW_BLOCKS_PER_QUERY - 1)
      const rows = await query<Row>(`SELECT ${LOG_COLUMNS} FROM ${base}.logs WHERE block_num BETWEEN ${start} AND ${end} AND topic1 = X'${owner.padStart(64, "0")}' AND ${APPROVAL_LOGS}`)
      logs.push(...rows.map(toLog))
    }
    return logs
  }

  /** Every candidate in the wallet's history through `head`, and where that history was read from. It's only kept when no reorg came while it was read. */
  async function findCandidates(address: string, head: number): Promise<{ held: Held; from: string }> {
    for (let attempt = 1; ; attempt++) {
      const startedAt = rewinds
      const found = await readCandidates(address, head)
      if (startedAt === rewinds) {
        held.delete(address)
        held.set(address, found.held)
        if (held.size > MAX_HELD_WALLETS) held.delete(held.keys().next().value as string)
        return found
      }
      // What it read can be the replaced chain's, so it's read again from what the reorg left. Reorgs that keep coming can't hold the answer up for long.
      if (attempt === MAX_ATTEMPTS) return found
    }
  }

  async function readCandidates(address: string, head: number): Promise<{ held: Held; from: string }> {
    const owner = hexOf(address)
    const from = config.historyFrom(head)
    const known = held.get(address)
    const kept = known && known.from <= from ? known : null
    const readFrom = kept ? kept.through + 1 : from
    let logs: ApprovalLog[] = []
    let through = kept?.through ?? from - 1
    let source = config.baseDataset
    if (readFrom <= head) {
      const table = await readTable(owner, readFrom, head)
      if (table) {
        logs = table.logs
        through = table.through
        source = config.dataset!.name
      } else {
        logs = await readRaw(owner, readFrom, head)
        through = head
      }
    } else if (hasTable) {
      source = config.dataset!.name
    }
    // What's newly read is newer than anything kept, so it replaces it.
    const candidates = candidatesFromLogs(address, logs)
    const merged = new Map((kept?.candidates ?? []).map((c) => [candidateKey(c), c]))
    for (const candidate of candidates) merged.set(candidateKey(candidate), candidate)
    return { held: { from: kept?.from ?? from, through, candidates: [...merged.values()] }, from: source }
  }

  async function check(address: string, candidates: readonly Candidate[], head: Head): Promise<{ checked: CheckedApproval[]; unreadable: number }> {
    const checked: CheckedApproval[] = []
    let unreadable = 0
    const keep = (candidate: Candidate, result: CheckedApproval | null) => {
      if (result) checked.push(result)
      // A known spender that isn't in the history was only a guess, so a token that can't answer isn't missing anything.
      else if (candidate.grant) unreadable += 1
    }
    const trusted = candidates.filter(isTrustedCheck)
    for (let i = 0; i < trusted.length; i += CALLS_PER_READ) {
      const part = trusted.slice(i, i + CALLS_PER_READ)
      const [row] = await query<Row>(`SELECT rpc.${config.network}.eth_call(NULL, evm_encode_hex('${MULTICALL3}'), X'${encodeChecks(address, part)}', ${head.blockNum}) AS r`)
      const results = decodeChecks(callResult(row?.r), part)
      if (!results) throw new Error("The approval check didn't answer")
      part.forEach((candidate, j) => keep(candidate, results[j]!))
    }
    // Each its own simulation, so nothing one does can change what another answers.
    const isolated = candidates.filter((candidate) => !isTrustedCheck(candidate))
    for (let i = 0; i < isolated.length; i += ISOLATED_PER_READ) {
      const part = isolated.slice(i, i + ISOLATED_PER_READ)
      const columns = part.map((candidate, j) => {
        const { target, data } = isolatedCall(address, candidate)
        return `rpc.${config.network}.eth_call(NULL, evm_encode_hex('${target}'), X'${data}', ${head.blockNum}) AS c${j}`
      })
      const [row] = await query<Row>(`SELECT ${columns.join(", ")}`)
      if (!row) throw new Error("The approval check didn't answer")
      part.forEach((candidate, j) => keep(candidate, decodeCheck(candidate, callResult(row[`c${j}`]))))
    }
    return { checked, unreadable }
  }

  return {
    /**
     * Blocks from `block` on were replaced, so they're read again. A wallet whose newest grant of something was in them is
     * read again from the start, because the grant before it, which is what's left on the new chain, was replaced in what's
     * kept. A read that's running when this comes reads again before it answers.
     */
    rewind(block: number): void {
      rewinds += 1
      for (const [address, known] of held) {
        if (known.candidates.some((candidate) => (candidate.grant?.blockNum ?? -1) >= block)) held.delete(address)
        else if (known.through >= block) held.set(address, { ...known, through: Math.max(known.from, block) - 1 })
      }
    },

    /** A wallet's approvals that still allow something at `head`. */
    read: (address: string, head: Head): Promise<ApprovalsResponse> =>
      inTurn(address, async () => {
        const { held: found, from } = await findCandidates(address, head.blockNum)
        const candidates = mergeCandidates(found.candidates, knownSpenderCandidates())
        const { checked, unreadable } = await check(address, candidates, head)
        const now = Date.parse(head.timestamp) / 1000
        const active = checked.filter((approval) => isActive(approval, now))
        const history = { fromBlock: found.from, throughBlock: found.through, dataset: from }
        return {
          mode: from === config.baseDataset ? "raw" : "dataset",
          address,
          checkedAt: head,
          history,
          source: sourceLines(history, head),
          approvals: sortViews(active.map((approval) => viewOf(approval, approval.grant !== null))),
          unreadable,
        }
      }),
  }
}

export type Approvals = ReturnType<typeof createApprovals>

const block = (n: number) => n.toLocaleString("en-US")

/** Says where the list comes from, the way a price's proof does. */
export function sourceLines(history: ApprovalsResponse["history"], head: Head): string[] {
  return [
    history.throughBlock < history.fromBlock
      ? `Nothing found in Amp yet: ${history.dataset} hasn't reached block ${block(history.fromBlock)}.`
      : `Found in Amp, in ${history.dataset}, from block ${block(history.fromBlock)} through ${block(history.throughBlock)}.`,
    `Each one checked onchain at block ${block(head.blockNum)}, through Amp, for what it still allows.`,
    `Every tracked token was also checked with well-known apps like Uniswap and Aerodrome, however old the approval.`,
  ]
}

const DEMO_ROUTER = "0x6ff5693b99212da76ad316178a184ab56d299b43"
const DEMO_STRANGER = "0x000000000000000000000000000000000000be13"
const DEMO_COLLECTION = "0x000000000000000000000000000000000000c011"

/** Made up, like the rest of the demo, with one of each kind for the apps to show. The demo's savings wallet has one from before Patina. */
export function demoApprovals(wallet: { address: string; latest: Head; coverage: { fromBlock: number } }): ApprovalsResponse {
  const at = (blocksBefore: number, n: number) => ({
    txHash: `0x${n.toString(16).padStart(64, "d")}`,
    blockNum: wallet.latest.blockNum - blocksBefore,
    timestamp: new Date(Date.parse(wallet.latest.timestamp) - blocksBefore * 2000).toISOString(),
    logIndex: 0,
  })
  const now = Date.parse(wallet.latest.timestamp) / 1000
  const isSavings = wallet.address === DEMO_SAVINGS_ADDRESS
  const approvals: CheckedApproval[] = isSavings
    ? [{ kind: "token", token: USDC_ADDRESS, spender: DEMO_STRANGER, grant: null, amount: 2n ** 256n - 1n, expiresAt: null }]
    : [
        { kind: "token", token: USDC_ADDRESS, spender: PERMIT2, grant: at(4000, 1), amount: 2n ** 256n - 1n, expiresAt: null },
        { kind: "permit2", token: USDC_ADDRESS, spender: DEMO_ROUTER, grant: at(4000, 2), amount: 250_000_000n, expiresAt: now + 20 * 86_400 },
        { kind: "token", token: WETH_ADDRESS, spender: DEMO_STRANGER, grant: at(1200, 3), amount: 2n ** 256n - 1n, expiresAt: null },
        { kind: "collection", token: DEMO_COLLECTION, spender: DEMO_STRANGER, grant: at(300, 4), amount: 1n, expiresAt: null },
      ]
  return {
    mode: "demo",
    address: wallet.address,
    checkedAt: wallet.latest,
    history: { fromBlock: wallet.coverage.fromBlock, throughBlock: wallet.latest.blockNum, dataset: "the demo" },
    source: ["This is the demo wallet, so these approvals are made up."],
    approvals: sortViews(approvals.map((approval) => viewOf(approval, approval.grant !== null))),
    unreadable: 0,
  }
}
