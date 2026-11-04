// Turns a wallet's rows in the dataset's shapes into the priced legs the fold reads.
// Pure, so it can run on fixtures, on the raw dataset's rows and on the Pricetag dataset's rows alike.

import { usdOf, type CostLabel, type FoldLeg } from "./fold.ts"
import { normalizeAddress, tokenByAddress, TOKENS, type Token } from "./tokens.ts"

export type PriceSource = "oracle" | "swap" | "market"
/**
 * Transfers of tokens off the allowlist. They have no position or price, but they say money went elsewhere.
 * `unlisted`: `amount` is a quantity, or empty when it can't be read, as with ERC-1155.
 * `unlisted_nft`: `amount` is an ERC-721 token ID, which identifies one asset and is not a quantity.
 */
export type LegKind = "erc20" | "eth" | "gas" | "l1_fee" | "wrap" | "unwrap" | "unlisted" | "unlisted_nft"

/** What a transaction cost to send. L2 gas comes from Amp's data, and the L1 data fee from its receipt. */
const isFeeRow = (row: LegRow) => row.kind === "gas" || row.kind === "l1_fee"

/** A row of `legs`. `token` and `account` are 0x-prefixed lowercase hex, `amount` a decimal string. */
export type LegRow = {
  block_num: number
  timestamp: string
  tx_hash: string
  tx_index: number
  log_index: number
  token: string
  account: string
  side: "debit" | "credit"
  amount: string
  kind: LegKind
  /** The other side of this movement, when it's known: who sent a credit, or who a debit went to. */
  counterparty?: string | null
}

/** A row of `reference_prices`, with Chainlink answers in 1e8 USD. Empty when a read failed. */
export type ReferenceRow = { block_num: number; eth_usd: string; usdc_usd: string }

/** The result of `pt_price`, in the shape `priced_legs` stores it. */
export type PtPrice = { token: string; usd_micros: string; source: "swap" | "unknown" }

/**
 * The result of `pt_net`. No side means it nets to zero, or an amount couldn't be read. No amount means most of it
 * cancelled out, as with what a router or pool kept: something moved, but it isn't a trade that can be priced.
 */
export type PtNet = { amount: string; side: "debit" | "credit" | "" }

/** A row of `priced_legs`. */
export type PricedRow = {
  block_num: number
  tx_hash: string
  account: string
  sold_token: string
  sold_amount: string
  bought_token: string
  bought_amount: string
  priced: PtPrice
}

export type PricedLeg = FoldLeg & {
  asset: string
  blockNum: number
  timestamp: string
  txHash: string
  txIndex: number
  priceSource: PriceSource | null
  /** Why this leg has no usable price. */
  priceNote: string | null
  /** The rows this leg nets together, so a click can show them. */
  parts: LegRow[]
  /** What the wallet already held before the first block read. It isn't a transaction, so `txHash` is empty. */
  opening?: boolean
}

/** The same calculation as the dataset's `pt_price` UDF. A test runs both on the same inputs. */
export function ptPrice(
  soldToken: string,
  soldAmount: string,
  boughtToken: string,
  boughtAmount: string,
  ethUsd: string,
  usdcUsd: string,
): PtPrice {
  const none: PtPrice = { token: "", usd_micros: "", source: "unknown" }
  const sold = tokenByAddress(soldToken)
  const bought = tokenByAddress(boughtToken)
  if (!sold || !bought || !ethUsd || !usdcUsd || !soldAmount || !boughtAmount) return none
  if (BigInt(soldAmount) === 0n || BigInt(boughtAmount) === 0n) return none
  if (sold.asset === bought.asset) return none
  const answer = (t: Token) => (t.oracle === "eth" ? ethUsd : t.oracle === "usdc" ? usdcUsd : null)
  const usdPerToken = (pricedAmount: string, pricedDecimals: number, refAmount: string, refDecimals: number, refAnswer: string) =>
    (
      (BigInt(refAmount) * BigInt(refAnswer) * 10n ** BigInt(pricedDecimals)) /
      (BigInt(pricedAmount) * 10n ** BigInt(refDecimals) * 100n)
    ).toString()
  const soldAnswer = answer(sold)
  if (soldAnswer) {
    return { token: bought.symbol, usd_micros: usdPerToken(boughtAmount, bought.decimals, soldAmount, sold.decimals, soldAnswer), source: "swap" }
  }
  const boughtAnswer = answer(bought)
  if (boughtAnswer) {
    return { token: sold.symbol, usd_micros: usdPerToken(soldAmount, sold.decimals, boughtAmount, bought.decimals, boughtAnswer), source: "swap" }
  }
  return none
}

/** The same calculation as the dataset's `pt_net` UDF, on comma-separated signed amounts. A test runs both. */
export function ptNet(amounts: string): PtNet {
  const none: PtNet = { amount: "", side: "" }
  if (!amounts) return none
  let net = 0n
  let gross = 0n
  for (const part of amounts.split(",")) {
    if (!/^-?\d+$/.test(part)) return none
    const amount = BigInt(part)
    net += amount
    gross += amount < 0n ? -amount : amount
  }
  if (net === 0n) return none
  const size = net < 0n ? -net : net
  return { amount: size * 2n < gross ? "" : size.toString(), side: net > 0n ? "credit" : "debit" }
}

const isPlainAmount = (amount: string) => /^\d+$/.test(amount)

/**
 * What one account's rows of tokens off the allowlist amount to in one transaction, like the dataset's `unlisted_moves`.
 * `moves` has each asset's net movement that isn't zero, and `unreadable` says an amount couldn't be read.
 */
function netUnlisted(rows: readonly LegRow[]): { moves: bigint[]; unreadable: boolean } {
  const nets = new Map<string, bigint>()
  let unreadable = false
  for (const row of rows) {
    if (!isPlainAmount(row.amount)) {
      unreadable = true
      continue
    }
    // Fungible tokens net by contract. An NFT nets by contract and ID, each one counting once: IDs aren't amounts.
    const isNft = row.kind === "unlisted_nft"
    const asset = isNft ? `${row.token}#${row.amount}` : row.token
    const size = isNft ? 1n : BigInt(row.amount)
    nets.set(asset, (nets.get(asset) ?? 0n) + (row.side === "credit" ? size : -size))
  }
  return { moves: [...nets.values()].filter((delta) => delta !== 0n), unreadable }
}

/**
 * What the dataset's `net_legs`, `pairs`, `unlisted_moves`, `pair_counts`, `single_pairs` and `priced_legs` tables
 * compute, for one wallet's rows. Used when reading the raw dataset, and for fixtures, so both go through the same path
 * as the real table.
 */
export function derivePricedRows(rows: readonly LegRow[], references: readonly ReferenceRow[]): PricedRow[] {
  const refs = new Map(references.map((r) => [r.block_num, r]))
  const byTx = new Map<string, { first: LegRow; amounts: Map<string, string[]>; unlisted: LegRow[] }>()
  for (const row of rows) {
    // Like the dataset's `legs`, which pairs are made from: gas isn't traded.
    if (isFeeRow(row)) continue
    const key = `${row.account}:${row.tx_hash}`
    const tx = byTx.get(key) ?? { first: row, amounts: new Map<string, string[]>(), unlisted: [] }
    // Unlisted tokens have no decimals, so they make no pair, but they do stop the pair's price.
    if (row.kind === "unlisted" || row.kind === "unlisted_nft") tx.unlisted.push(row)
    else tx.amounts.set(row.token, [...(tx.amounts.get(row.token) ?? []), row.side === "credit" ? row.amount : `-${row.amount}`])
    byTx.set(key, tx)
  }
  const result: PricedRow[] = []
  for (const { first, amounts, unlisted } of byTx.values()) {
    const nets = [...amounts].map(([token, signed]) => ({ token, ...ptNet(signed.join(",")) }))
    const sold = nets.filter((n) => n.side === "debit")
    const bought = nets.filter((n) => n.side === "credit")
    if (sold.length !== 1 || bought.length !== 1) continue
    const { moves, unreadable } = netUnlisted(unlisted)
    if (unreadable || moves.length > 0) continue
    const ref = refs.get(first.block_num)
    if (!ref) continue
    const [out, into] = [sold[0]!, bought[0]!]
    result.push({
      block_num: first.block_num,
      tx_hash: first.tx_hash,
      account: first.account,
      sold_token: out.token,
      sold_amount: out.amount,
      bought_token: into.token,
      bought_amount: into.amount,
      priced: ptPrice(out.token, out.amount, into.token, into.amount, ref.eth_usd, ref.usdc_usd),
    })
  }
  return result
}

export const answerToMicros = (answer: string | undefined): string | null =>
  answer && BigInt(answer) > 0n ? (BigInt(answer) / 100n).toString() : null

/** True when a swap price is plausible next to the reference prices at that block. */
export function isSanePrice(token: Token, usdMicros: string, ethUsdMicros: string | null): boolean {
  const usd = Number(usdMicros) / 1e6
  if (!(usd > 0) || !token.sanity) return false
  if ("usd" in token.sanity) return usd >= token.sanity.usd[0] && usd <= token.sanity.usd[1]
  if (ethUsdMicros === null) return false
  const ratio = usd / (Number(ethUsdMicros) / 1e6)
  return ratio >= token.sanity.eth[0] && ratio <= token.sanity.eth[1]
}

/** How far a swap's implied price can be from the oracle of a token that has one. Wide enough for real slippage. */
const ORACLE_BAND: [min: number, max: number] = [0.8, 1.25]

function isSaneAgainstOracle(impliedUsdMicros: bigint, oracleUsdMicros: string): boolean {
  const ratio = Number(impliedUsdMicros) / Number(oracleUsdMicros)
  return ratio >= ORACLE_BAND[0] && ratio <= ORACLE_BAND[1]
}

/** The guarded price of an asset's recent trades at or before a block. See `market.ts`. */
export type MarketLookup = (asset: string, blockNum: number) => string | null

const REJECTED_NOTE = "Rejected this swap's implied price, because it's far from any plausible value."
const UNLISTED_NOTE = "This transaction also moved a token off the allowlist, so what was paid or received can't be split between them."

type Input = {
  account: string
  rows: readonly LegRow[]
  references: readonly ReferenceRow[]
  priced: readonly PricedRow[]
  market?: MarketLookup
}

/**
 * Nets each transaction per asset, so a wrap (ETH out, WETH in) or a split route is a single movement,
 * then labels each leg's price and cost. Gas stays its own leg. Ordered for the fold: by block, then transaction,
 * with gas first because it's paid before the transaction runs.
 */
export function buildPricedLegs({ account, rows, references, priced, market }: Input): PricedLeg[] {
  const me = normalizeAddress(account)
  const refs = new Map(references.map((r) => [r.block_num, r]))
  const txs = new Map<string, LegRow[]>()
  for (const row of rows) {
    if (row.account !== me) continue
    const txRows = txs.get(row.tx_hash)
    if (txRows) txRows.push(row)
    else txs.set(row.tx_hash, [row])
  }
  const ordered = [...txs.values()].sort((a, b) => a[0]!.block_num - b[0]!.block_num || a[0]!.tx_index - b[0]!.tx_index)

  const legs: PricedLeg[] = []
  for (const txRows of ordered) {
    const first = txRows[0]!
    const ref = refs.get(first.block_num)
    const ethMicros = answerToMicros(ref?.eth_usd)
    const usdcMicros = answerToMicros(ref?.usdc_usd)
    const oracle = (t: Token) => (t.oracle === "eth" ? ethMicros : t.oracle === "usdc" ? usdcMicros : null)
    const base = { blockNum: first.block_num, timestamp: first.timestamp, txHash: first.tx_hash, txIndex: first.tx_index }

    const feeRows = txRows.filter(isFeeRow)
    if (feeRows.length > 0) {
      legs.push({
        ...base,
        id: `${first.tx_hash}:gas`,
        asset: "ETH",
        delta: `-${feeRows.reduce((sum, row) => sum + BigInt(row.amount), 0n)}`,
        decimals: 18,
        kind: "gas",
        priceUsdMicros: ethMicros,
        priceSource: ethMicros === null ? null : "oracle",
        priceNote: ethMicros === null ? "The oracle read failed at this block." : null,
        costUsdMicros: null,
        proceedsUsdMicros: null,
        costLabel: "unknown",
        parts: feeRows,
      })
    }

    const nets = new Map<string, { token: Token; delta: bigint; parts: LegRow[] }>()
    const unlisted: LegRow[] = []
    for (const row of txRows) {
      if (isFeeRow(row)) continue
      const token = tokenByAddress(row.token)
      if (!token) {
        unlisted.push(row)
        continue
      }
      const net = nets.get(token.asset) ?? { token: TOKENS.find((t) => t.symbol === token.asset)!, delta: 0n, parts: [] }
      net.delta += row.side === "credit" ? BigInt(row.amount) : -BigInt(row.amount)
      net.parts.push(row)
      nets.set(token.asset, net)
    }
    const moved = [...nets.values()].filter((n) => n.delta !== 0n)
    // One token out and one in is only a swap if nothing else moved. Otherwise the payment could be for both.
    const { moves: unlistedMoves, unreadable: unlistedUnreadable } = netUnlisted(unlisted)
    const hasUnlisted = unlistedUnreadable || unlistedMoves.length > 0
    const isSwap = !hasUnlisted && moved.length === 2 && moved.some((n) => n.delta > 0n) && moved.some((n) => n.delta < 0n)
    // Something left and something arrived, but it can't be valued as a swap. It's still not a plain transfer: a debit
    // here was traded for something, so it has unknown proceeds, rather than no gain or loss at all.
    const anyOut = moved.some((n) => n.delta < 0n) || unlistedMoves.some((delta) => delta < 0n)
    const anyIn = moved.some((n) => n.delta > 0n) || unlistedMoves.some((delta) => delta > 0n)
    const isExchange = isSwap || unlistedUnreadable || (anyOut && anyIn)
    const pricedRow = priced.find((p) => p.tx_hash === first.tx_hash && p.account === me)

    const resolved = moved.map((net) => {
      let price = oracle(net.token)
      let priceSource: PriceSource | null = price === null ? null : "oracle"
      let priceNote: string | null = null
      let rejected = false
      if (net.token.oracle && price === null) priceNote = "The oracle read failed at this block."
      if (hasUnlisted) priceNote = UNLISTED_NOTE
      else if (!net.token.oracle) {
        const swap = pricedRow?.priced.source === "swap" && pricedRow.priced.token === net.token.symbol ? pricedRow.priced.usd_micros : null
        if (swap === null) priceNote = isSwap ? "This swap didn't give a usable price for this token." : "No swap in this transaction, and no oracle for this token."
        else if (!isSwap) priceNote = "This transaction isn't a simple swap."
        else if (!isSanePrice(net.token, swap, ethMicros)) {
          priceNote = REJECTED_NOTE
          rejected = true
        } else {
          price = swap
          priceSource = "swap"
        }
      }
      // A price is a fact about the token at this block, so a trade we couldn't value doesn't stop it having one.
      const marketPrice = price === null && !net.token.oracle ? (market?.(net.token.asset, first.block_num) ?? null) : null
      if (marketPrice !== null) {
        price = marketPrice
        priceSource = "market"
        if (!rejected && !hasUnlisted) priceNote = null
      }
      return { net, price, priceSource, priceNote, rejected }
    })

    // The oracle price is the shared fact, but a swap's cost and proceeds are what actually changed hands. So both
    // sides share one USD value: the amount on the side an oracle can value, preferring USDC, whose oracle is closest
    // to what was really paid. Otherwise buying above the oracle and selling below it would show up as a profit.
    const usdcSide = resolved.find((r) => r.net.token.oracle === "usdc" && r.price !== null)
    const oracleSide = isSwap ? (usdcSide ?? resolved.find((r) => r.net.token.oracle === "eth" && r.price !== null)) : undefined
    // With no feed on either side, what left is worth about its market price. That's an estimate, and it's labeled as one.
    const marketSide = isSwap && !oracleSide && !resolved.some((r) => r.rejected) ? (resolved.find((r) => r.net.delta < 0n && r.priceSource === "market") ?? resolved.find((r) => r.priceSource === "market")) : undefined
    const anchor = oracleSide ?? marketSide
    const abs = (delta: bigint) => (delta < 0n ? -delta : delta)
    let tradeUsd = anchor ? usdOf(abs(anchor.net.delta), BigInt(anchor.price as string), anchor.net.token.decimals) : null
    const other = anchor && resolved.find((r) => r !== anchor)
    if (anchor && other && tradeUsd !== null) {
      const implied = (tradeUsd * 10n ** BigInt(other.net.token.decimals)) / abs(other.net.delta)
      // Check against the token's oracle when it has a reading, and otherwise against its plausible range.
      const sane = other.price !== null && other.priceSource !== "swap" ? isSaneAgainstOracle(implied, other.price) : isSanePrice(other.net.token, implied.toString(), ethMicros)
      if (other.rejected || !sane) {
        // A wrong trade value must never reach a total, so neither side gets one.
        tradeUsd = null
        anchor.priceNote = REJECTED_NOTE
        other.priceNote = REJECTED_NOTE
      }
    }

    for (const { net, price, priceSource, priceNote } of resolved) {
      // What was paid is known even when the token's price isn't: price and cost are separate facts.
      const value = tradeUsd === null ? null : tradeUsd.toString()
      const paid = net.delta > 0n && value !== null
      const costLabel: CostLabel = paid ? "paid" : "unknown"
      legs.push({
        ...base,
        id: `${first.tx_hash}:${net.token.asset}`,
        asset: net.token.asset,
        delta: net.delta.toString(),
        decimals: net.token.decimals,
        kind: isExchange ? "swap" : "transfer",
        priceUsdMicros: price,
        priceSource,
        priceNote,
        costUsdMicros: paid ? value : null,
        proceedsUsdMicros: net.delta < 0n ? value : null,
        costLabel,
        ...(marketSide && value !== null ? { estimated: true } : {}),
        parts: net.parts,
      })
    }
  }
  return legs
}
