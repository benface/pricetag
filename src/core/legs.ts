// Turns a wallet's rows in the dataset's shapes into the priced legs the fold reads.
// Pure, so it can run on fixtures, on the raw dataset's rows and on the Pricetag dataset's rows alike.

import { usdOf, type CostLabel, type FoldLeg } from "./fold.ts"
import { normalizeAddress, tokenByAddress, TOKENS, type Token } from "./tokens.ts"

export type PriceSource = "oracle" | "swap" | "market"
export type LegKind = "erc20" | "eth" | "gas" | "wrap" | "unwrap"

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
}

/** A row of `reference_prices`, with Chainlink answers in 1e8 USD. Empty when a read failed. */
export type ReferenceRow = { block_num: number; eth_usd: string; usdc_usd: string }

/** The result of `pt_price`, in the shape `priced_legs` stores it. */
export type PtPrice = { token: string; usd_micros: string; source: "swap" | "unknown" }

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

/**
 * What the dataset's `pairs`, `single_pairs` and `priced_legs` tables compute, for one wallet's rows.
 * Used when reading the raw dataset, and for fixtures, so both go through the same path as the real table.
 */
export function derivePricedRows(rows: readonly LegRow[], references: readonly ReferenceRow[]): PricedRow[] {
  const refs = new Map(references.map((r) => [r.block_num, r]))
  const byTx = new Map<string, LegRow[]>()
  for (const row of rows) {
    if (row.kind === "gas") continue
    const key = `${row.account}:${row.tx_hash}`
    byTx.set(key, [...(byTx.get(key) ?? []), row])
  }
  const result: PricedRow[] = []
  for (const txRows of byTx.values()) {
    const pairs = txRows
      .filter((a) => a.side === "debit")
      .flatMap((a) => txRows.filter((b) => b.side === "credit" && b.token !== a.token).map((b) => [a, b] as const))
    const [pair] = pairs
    if (!pair || pairs.length !== 1) continue
    const [sold, bought] = pair
    const ref = refs.get(sold.block_num)
    if (!ref) continue
    result.push({
      block_num: sold.block_num,
      tx_hash: sold.tx_hash,
      account: sold.account,
      sold_token: sold.token,
      sold_amount: sold.amount,
      bought_token: bought.token,
      bought_amount: bought.amount,
      priced: ptPrice(sold.token, sold.amount, bought.token, bought.amount, ref.eth_usd, ref.usdc_usd),
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

const REJECTED_NOTE = "Rejected this swap's implied price, because it's far from any plausible value."

type Input = {
  account: string
  rows: readonly LegRow[]
  references: readonly ReferenceRow[]
  priced: readonly PricedRow[]
}

/**
 * Nets each transaction per asset, so a wrap (ETH out, WETH in) or a split route is a single movement,
 * then labels each leg's price and cost. Gas stays its own leg. Ordered for the fold: by block, then transaction,
 * with gas first because it's paid before the transaction runs.
 */
export function buildPricedLegs({ account, rows, references, priced }: Input): PricedLeg[] {
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

    for (const row of txRows) {
      if (row.kind !== "gas") continue
      legs.push({
        ...base,
        id: `${row.tx_hash}:gas`,
        asset: "ETH",
        delta: `-${row.amount}`,
        decimals: 18,
        kind: "gas",
        priceUsdMicros: ethMicros,
        priceSource: ethMicros === null ? null : "oracle",
        priceNote: ethMicros === null ? "The oracle read failed at this block." : null,
        costUsdMicros: null,
        proceedsUsdMicros: null,
        costLabel: "unknown",
        parts: [row],
      })
    }

    const nets = new Map<string, { token: Token; delta: bigint; parts: LegRow[] }>()
    for (const row of txRows) {
      if (row.kind === "gas") continue
      const token = tokenByAddress(row.token)
      if (!token) continue
      const net = nets.get(token.asset) ?? { token: TOKENS.find((t) => t.symbol === token.asset)!, delta: 0n, parts: [] }
      net.delta += row.side === "credit" ? BigInt(row.amount) : -BigInt(row.amount)
      net.parts.push(row)
      nets.set(token.asset, net)
    }
    const moved = [...nets.values()].filter((n) => n.delta !== 0n)
    const isSwap = moved.length === 2 && moved.some((n) => n.delta > 0n) && moved.some((n) => n.delta < 0n)
    const pricedRow = priced.find((p) => p.tx_hash === first.tx_hash && p.account === me)

    const resolved = moved.map((net) => {
      let price = oracle(net.token)
      let priceSource: PriceSource | null = price === null ? null : "oracle"
      let priceNote: string | null = null
      let rejected = false
      if (net.token.oracle && price === null) priceNote = "The oracle read failed at this block."
      if (!net.token.oracle) {
        const swap = pricedRow?.priced.source === "swap" && pricedRow.priced.token === net.token.symbol ? pricedRow.priced.usd_micros : null
        if (swap === null) priceNote = isSwap ? "The other side of this swap has no price." : "No swap in this transaction, and no oracle for this token."
        else if (!isSwap) priceNote = "This transaction isn't a simple swap."
        else if (!isSanePrice(net.token, swap, ethMicros)) {
          priceNote = REJECTED_NOTE
          rejected = true
        } else {
          price = swap
          priceSource = "swap"
        }
      }
      return { net, price, priceSource, priceNote, rejected }
    })

    // The oracle price is the shared fact, but a swap's cost and proceeds are what actually changed hands. So both
    // sides share one USD value: the amount on the side an oracle can value, preferring USDC, whose oracle is closest
    // to what was really paid. Otherwise buying above the oracle and selling below it would show up as a profit.
    const usdcSide = resolved.find((r) => r.net.token.oracle === "usdc" && r.price !== null)
    const anchor = isSwap ? (usdcSide ?? resolved.find((r) => r.net.token.oracle === "eth" && r.price !== null)) : undefined
    const abs = (delta: bigint) => (delta < 0n ? -delta : delta)
    let tradeUsd = anchor ? usdOf(abs(anchor.net.delta), BigInt(anchor.price as string), anchor.net.token.decimals) : null
    const other = anchor && resolved.find((r) => r !== anchor)
    if (anchor && other && tradeUsd !== null) {
      const implied = (tradeUsd * 10n ** BigInt(other.net.token.decimals)) / abs(other.net.delta)
      const absurd = other.net.token.oracle && other.price !== null && !isSaneAgainstOracle(implied, other.price)
      if (other.rejected || absurd) {
        // A wrong trade value must never reach a total, so neither side gets one.
        tradeUsd = null
        anchor.priceNote = REJECTED_NOTE
        other.priceNote = REJECTED_NOTE
      }
    }

    for (const { net, price, priceSource, priceNote } of resolved) {
      const value = tradeUsd !== null && price !== null ? tradeUsd.toString() : null
      const paid = net.delta > 0n && value !== null
      const costLabel: CostLabel = paid ? "paid" : "unknown"
      legs.push({
        ...base,
        id: `${first.tx_hash}:${net.token.asset}`,
        asset: net.token.asset,
        delta: net.delta.toString(),
        decimals: net.token.decimals,
        kind: isSwap ? "swap" : "transfer",
        priceUsdMicros: price,
        priceSource,
        priceNote,
        costUsdMicros: paid ? value : null,
        proceedsUsdMicros: net.delta < 0n ? value : null,
        costLabel,
        parts: net.parts,
      })
    }
  }
  return legs
}
