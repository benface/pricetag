// What's behind one leg's price, and the check of the block it's in. The words are here because the clients only show them.
// The check only reaches the raw dataset's rows: the block's header covers those, and nothing downstream of them.

import { ETH_USD_FEED, TOKENS, USDC_USD_FEED, WETH_ADDRESS, describeError, hexOf, tokenByAddress, type LegRow, type PricedLeg, type Query } from "@pricetag/sdk"
import type { CheckStatus, ProofCheck, ProofDataset, ProofLink, ProofResponse, VerificationResponse } from "../src/core/api.ts"
import type { CurrencyCode } from "../src/core/currency.ts"
import { formatAmount } from "../src/core/format.ts"
import { tokenLabel } from "../src/core/wording.ts"
import { depositHashes, readBlock, type BlockData, type ReadDeposits } from "./block.ts"
import { DEPOSIT_TOPIC, TRANSFER_TOPIC, WITHDRAWAL_TOPIC } from "./raw.ts"
import { checkHeader, checkReceipts, checkTransactions, type Commitment, type DepositDetails, type LogRow, type TxRow } from "./verify.ts"

const BASESCAN = "https://basescan.org"

const FEEDS = {
  eth: { pair: "ETH/USD", address: ETH_USD_FEED },
  usdc: { pair: "USDC/USD", address: USDC_USD_FEED },
}

const feedOf = (asset: string) => {
  const oracle = TOKENS.find((token) => token.symbol === asset)?.oracle
  return oracle ? FEEDS[oracle] : null
}

const amountOf = ({ delta, decimals, asset }: PricedLeg) => `${formatAmount(delta.replace("-", ""), decimals)} ${asset}`

/** The other side of an exchange, which is what a swap price is worked out from. */
const paidFor = (leg: PricedLeg, legs: readonly PricedLeg[]) => (leg.priceSource === "swap" ? legs.find((other) => other.txHash === leg.txHash && other.id !== leg.id && other.kind === "swap") : undefined)

/** Everything recorded behind this leg's amount and price. */
const partsBehind = (leg: PricedLeg, legs: readonly PricedLeg[]) => [...leg.parts, ...(paidFor(leg, legs)?.parts ?? [])]

/** Where this leg's price came from, in words, with where to read it for yourself. */
function priceSource(leg: PricedLeg, legs: readonly PricedLeg[]): { source: string[]; links: ProofLink[] } {
  const block = leg.blockNum.toLocaleString("en-US")
  if (leg.priceSource === "oracle") {
    const feed = feedOf(leg.asset)
    const source = [`Chainlink's ${feed?.pair ?? `${leg.asset}/USD`} price on Base, read from its contract at block ${block}.`]
    return { source, links: feed ? [{ title: `Chainlink's ${feed.pair} contract on Basescan`, url: `${BASESCAN}/address/${feed.address}` }] : [] }
  }
  if (leg.priceSource === "swap") {
    const paid = paidFor(leg, legs)
    const feed = paid && feedOf(paid.asset)
    const source = [paid ? `Worked out from this exchange: ${amountOf(paid)} for ${amountOf(leg)}.` : `Worked out from what this transaction exchanged at block ${block}.`]
    if (paid && feed) source.push(`The ${paid.asset} is valued at Chainlink's ${feed.pair} price at this block.`)
    return { source, links: feed ? [{ title: `Chainlink's ${feed.pair} contract on Basescan`, url: `${BASESCAN}/address/${feed.address}` }] : [] }
  }
  return { source: [leg.priceNote ?? "This has no price."], links: [] }
}

/** Each thing this leg adds up, and where it's recorded. */
function describePart(part: LegRow): string {
  const token = tokenByAddress(part.token)
  const amount = formatAmount(part.amount, token?.decimals ?? 18)
  const symbol = tokenLabel(token?.symbol ?? part.token)
  const direction = part.side === "credit" ? "received" : "sent"
  switch (part.kind) {
    case "gas":
      return `Network fee: ${amount} ETH, worked out from the gas this transaction used`
    case "l1_fee":
      return `Ethereum fee: ${amount} ETH, from Base's receipt for this transaction`
    case "eth":
      return `Transaction value: ${amount} ETH ${direction}`
    case "wrap":
      return `Log #${part.log_index}: ${amount} ETH wrapped`
    case "unwrap":
      return `Log #${part.log_index}: ${amount} ETH unwrapped`
    default:
      return `Log #${part.log_index}: ${amount} ${symbol} ${direction}`
  }
}

/** What checking this leg's block does and doesn't show. Nothing here can be left out for a passing result to read honestly. */
function scopeOf(leg: PricedLeg, currency: CurrencyCode): string[] {
  const scope = [
    "Checking the block shows that the data Amp stored matches the block's header. It doesn't show that the header is on Base's real chain, or that the dataset's calculations ran correctly. A dataset's fingerprint only identifies its recipe.",
  ]
  if (leg.priceSource === "oracle") scope.push("It doesn't cover this price: Chainlink's price comes from calling a contract, and block headers don't record calls. It covers the transaction and the amounts.")
  if (leg.priceSource === "swap") scope.push("It covers the amounts exchanged. It doesn't cover Chainlink's price, used to value them, because block headers don't record calls to a contract.")
  if (leg.parts.some((part) => part.kind === "l1_fee")) scope.push("It doesn't cover the fee paid to Ethereum, which only Base's receipts have.")
  if (currency !== "USD") scope.push(`It doesn't cover the USD to ${currency} rate, which also comes from calling Chainlink's contract.`)
  return scope
}

export function proofOf(leg: PricedLeg, legs: readonly PricedLeg[], currency: CurrencyCode, datasets: ProofDataset[], unavailable: string | null): ProofResponse {
  const { source, links } = priceSource(leg, legs)
  return {
    blockNum: leg.blockNum,
    txHash: leg.txHash,
    source,
    movements: partsBehind(leg, legs).map(describePart),
    links: [{ title: "This transaction's logs on Basescan", url: `${BASESCAN}/tx/${leg.txHash}#eventlog` }, ...links],
    datasets,
    scope: scopeOf(leg, currency),
    unavailable,
  }
}

const short = (hex: string) => `0x${hex.slice(0, 6)}…${hex.slice(-6)}`

const padded = (address: string) => hexOf(address).padStart(64, "0")

/** Whether the checked rows say what a row of this leg says they do. */
function partMatches(part: LegRow, tx: TxRow, logs: readonly LogRow[]): boolean {
  const account = hexOf(part.account)
  if (part.kind === "gas" || part.kind === "l1_fee") return hexOf(tx.from) === account
  if (part.kind === "eth") return tx.status && tx.value === part.amount && hexOf((part.side === "debit" ? tx.from : tx.to) ?? "") === account

  const log = logs.find((candidate) => candidate.log_index === part.log_index && candidate.tx_index === tx.tx_index)
  if (!log || !part.amount || BigInt(`0x${log.data.slice(0, 64) || "0"}`) !== BigInt(part.amount)) return false
  const weth = hexOf(WETH_ADDRESS)
  if (part.kind === "erc20") return hexOf(log.address) === hexOf(part.token) && log.topics[0] === TRANSFER_TOPIC && log.topics[part.side === "debit" ? 1 : 2] === padded(account)
  if (part.kind === "wrap") return hexOf(log.address) === weth && log.topics[0] === DEPOSIT_TOPIC && log.topics[1] === padded(account)
  if (part.kind === "unwrap") {
    if (hexOf(log.address) !== weth || log.topics[0] !== WITHDRAWAL_TOPIC) return false
    // ETH arriving from an unwrap is credited to whoever sent the transaction, since the log only names who unwrapped.
    return part.side === "debit" ? log.topics[1] === padded(account) : hexOf(tx.from) === account
  }
  return false
}

function activityCheck(leg: PricedLeg, legs: readonly PricedLeg[], { txs, logs }: BlockData): ProofCheck {
  const title = "This activity"
  const tx = txs.find((candidate) => candidate.tx_hash === hexOf(leg.txHash))
  if (!tx) return { title, status: "failed", detail: "This transaction isn't in the checked data." }
  const parts = partsBehind(leg, legs)
  const wrong = parts.filter((part) => !partMatches(part, tx, logs))
  if (wrong.length > 0) return { title, status: "failed", detail: `The checked data disagrees with ${wrong.map(describePart).join(", and with ")}.` }
  const compared = parts.filter((part) => part.kind !== "gas" && part.kind !== "l1_fee").length
  const detail = compared === 0 ? "This transaction is in the checked data, sent by this wallet." : `This transaction is in the checked data, and ${compared === 1 ? "its movement matches" : `its ${compared} movements match`}, amounts included.`
  return { title, status: "passed", detail }
}

function commitmentCheck(title: string, commitment: Commitment, passed: string): ProofCheck {
  if (commitment.status === "passed") return { title, status: "passed", detail: passed }
  if (commitment.status === "unchecked") return { title, status: "unchecked", detail: commitment.reason }
  return { title, status: "failed", detail: `Worked out ${short(commitment.computed)}, but the block says ${short(commitment.expected)}.` }
}

const SUMMARIES: Record<CheckStatus, string> = {
  passed: "The data Amp stored for this block matches its header.",
  failed: "Some of the data Amp stored for this block doesn't match. Don't rely on this number until that's explained.",
  unchecked: "Part of this block couldn't be checked, so it isn't confirmed. Try again in a moment.",
}

export function verificationOf(leg: PricedLeg, legs: readonly PricedLeg[], data: BlockData, deposits: ReadonlyMap<string, DepositDetails> | null): VerificationResponse {
  const { block, txs, logs } = data
  const depositCount = depositHashes(txs).length
  const nodeHelped = depositCount === 0 ? "" : ` Amp doesn't store everything ${depositCount === 1 ? "a deposit's" : "deposits'"} hash covers, so Base's node supplied that, and a wrong answer would fail this.`
  const count = (n: number, one: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : `${one}s`}`
  const checks: ProofCheck[] = [
    commitmentCheck("Block fingerprint", checkHeader(block), `The block's stored details hash to its fingerprint, ${short(block.hash)}.`),
    commitmentCheck("Transactions", checkTransactions(block, txs, deposits), `${count(txs.length, "stored transaction")} rebuild the summary of them in the block's header.${nodeHelped}`),
    commitmentCheck("Results and logs", checkReceipts(block, txs, logs), `${count(txs.length, "stored result")} and ${count(logs.length, "log")} rebuild the summary of them in the block's header.`),
    activityCheck(leg, legs, data),
  ]
  const status: CheckStatus = checks.some((check) => check.status === "failed") ? "failed" : checks.some((check) => check.status === "unchecked") ? "unchecked" : "passed"
  return { blockNum: leg.blockNum, blockHash: `0x${block.hash}`, status, summary: SUMMARIES[status], checks }
}

export type ReadManifestHash = (dataset: string) => Promise<string | null>

const MANIFEST_TIMEOUT_MS = 10_000

/** A dataset version's fingerprint from Amp's admin API, or null when it can't be read. It's never worked out or remembered here, since a version can be moved. */
export function createManifestReader(adminUrl: string, token: string | undefined, send: typeof fetch = fetch): ReadManifestHash {
  return async (dataset) => {
    const parts = /^([^/@]+)\/([^/@]+)@([^/@]+)$/.exec(dataset)
    if (!parts) return null
    const [, namespace, name, revision] = parts as unknown as [string, string, string, string]
    try {
      const response = await send(`${adminUrl.replace(/\/$/, "")}/datasets/${namespace}/${name}/versions/${revision}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`status ${response.status}`)
      const hash = ((await response.json()) as { manifest_hash?: unknown }).manifest_hash
      return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash) ? hash : null
    } catch (error) {
      console.error("Couldn't read a dataset's fingerprint:", error instanceof Error ? error.message : "unknown error")
      return null
    }
  }
}

export type Proofs = {
  datasets(): Promise<ProofDataset[]>
  /** The check of a leg's block, or null when Amp doesn't have the block. */
  verify(leg: PricedLeg, legs: readonly PricedLeg[]): Promise<VerificationResponse | null>
}

const READ_ATTEMPTS = 4
const READ_PAUSE_MS = 2_000

/** Staging's gateway drops the odd connection, and a click shouldn't fail because of one. A block's rows can be read again safely. */
function retrying(query: Query, pauseMs: number): Query {
  return async <T>(sql: string, timeoutMs?: number) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await query<T>(sql, timeoutMs)
      } catch (error) {
        if (attempt === READ_ATTEMPTS) throw error
        console.warn("Retrying a block read:", describeError(error))
        await new Promise((resolve) => setTimeout(resolve, pauseMs))
      }
    }
  }
}

export function createProofs(query: Query, config: { baseDataset: string; dataset: string | null; readDeposits: ReadDeposits; readManifestHash: ReadManifestHash; retryPauseMs?: number }): Proofs {
  const blockQuery = retrying(query, config.retryPauseMs ?? READ_PAUSE_MS)
  return {
    async datasets() {
      const wanted = [...(config.dataset ? [{ title: "Prices and activity", name: config.dataset }] : []), { title: "Base's blocks", name: config.baseDataset }]
      return Promise.all(wanted.map(async ({ title, name }) => ({ title, name, hash: await config.readManifestHash(name) })))
    },
    async verify(leg, legs) {
      const data = await readBlock(blockQuery, config.baseDataset, leg.blockNum)
      return data && verificationOf(leg, legs, data, await config.readDeposits(depositHashes(data.txs)))
    },
  }
}
