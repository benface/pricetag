// A token's `market` price: what it recently traded at, from `priced_legs`, with guards so a thin pool can't set it.

import { msBetweenBlocks } from "./chain.ts"
import { worth } from "./fold.ts"
import { answerToMicros, isSanePrice, type LegRow, type PricedRow } from "./legs.ts"
import type { BalanceSnapshot } from "./reconcile.ts"
import { ETH_ADDRESS, TOKENS, normalizeAddress, tokenByAddress } from "./tokens.ts"

/** One account's trade of a token. A trade shows up once per account it went through, which is why these group by transaction. */
export type MarketTrade = { blockNum: number; txHash: string; asset: string; usdMicros: string; notionalUsdMicros: string }

/** `priced_legs`' pool and router rows are as good as a trader's here: they all imply the same price. */
export type MarketRow = Pick<PricedRow, "block_num" | "tx_hash" | "sold_token" | "sold_amount" | "bought_token" | "bought_amount" | "priced"> & { eth_usd: string }

/** Older than this, a trade doesn't say what a token's worth now. */
export const MARKET_MAX_AGE_MS = 1_800_000
/** No priced_legs row says how deep a pool is, so these stand in for it: real size, from several transactions. */
export const MIN_TRADE_USD_MICROS = 100_000_000n
const MIN_TRADES = 3
const MIN_VOLUME_USD_MICROS = 1_000_000_000n
/** The median of the last few, so one odd trade can't set the price. */
const LAST_TRADES = 5

export type MarketPrice = { usdMicros: string; blockNum: number }

const median = (values: readonly bigint[]) => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[(values.length - 1) >> 1] as bigint

/**
 * The trades in these rows whose price is plausible at their own block. Anything else has no usable price.
 * Without traces, native ETH bought in a swap can be a WETH unwrap credited to the sender, who may never have received it.
 * Nobody's checked that here, and it could set the price of what someone else holds, so those rows are left out.
 */
export function marketTrades(rows: readonly MarketRow[]): MarketTrade[] {
  return rows.flatMap((row) => {
    if (row.priced.source !== "swap" || !row.priced.usd_micros) return []
    if (normalizeAddress(row.bought_token) === ETH_ADDRESS) return []
    const token = TOKENS.find((t) => t.symbol === row.priced.token)
    if (!token || token.oracle) return []
    if (!isSanePrice(token, row.priced.usd_micros, answerToMicros(row.eth_usd))) return []
    const sold = tokenByAddress(row.sold_token)?.asset === token.asset
    const amount = sold ? row.sold_amount : row.bought_amount
    if (!/^\d+$/.test(amount)) return []
    return [{ blockNum: row.block_num, txHash: row.tx_hash, asset: token.asset, usdMicros: row.priced.usd_micros, notionalUsdMicros: worth(BigInt(amount), BigInt(row.priced.usd_micros), token.decimals).toString() }]
  })
}

/** What an asset traded at, at or before `block`, or null when too little real trading backs it. Never looks ahead. */
export function marketPrice(trades: readonly MarketTrade[], asset: string, block: number): MarketPrice | null {
  const byTx = new Map<string, { blockNum: number; prices: bigint[]; notional: bigint }>()
  for (const trade of trades) {
    if (trade.asset !== asset || trade.blockNum > block || msBetweenBlocks(trade.blockNum, block) > MARKET_MAX_AGE_MS) continue
    const notional = BigInt(trade.notionalUsdMicros)
    const tx = byTx.get(trade.txHash) ?? { blockNum: trade.blockNum, prices: [], notional: 0n }
    tx.prices.push(BigInt(trade.usdMicros))
    if (notional > tx.notional) tx.notional = notional
    byTx.set(trade.txHash, tx)
  }
  const real = [...byTx.values()].filter((tx) => tx.notional >= MIN_TRADE_USD_MICROS).sort((a, b) => b.blockNum - a.blockNum)
  if (real.length < MIN_TRADES) return null
  if (real.reduce((sum, tx) => sum + tx.notional, 0n) < MIN_VOLUME_USD_MICROS) return null
  const last = real.slice(0, LAST_TRADES)
  return { usdMicros: median(last.map((tx) => median(tx.prices))).toString(), blockNum: (last[0] as (typeof last)[number]).blockNum }
}

/** What a wallet's market-priced tokens traded at, in USD, by block and then asset. A price too little trading backs isn't in it. */
export type MarketMarks = Record<string, Record<string, string>>

/**
 * Each market-priced token at each block where it's held after one of this wallet's transactions, because each of those
 * gets a chart point. In the order the fold reads them, since a token can arrive and leave in different transactions of
 * one block. Newest first, because reads can run out.
 */
export function markNeeds(account: string, rows: readonly LegRow[], opening: Pick<BalanceSnapshot, "amounts"> | null): { asset: string; block: number }[] {
  const txs = new Map<string, { block: number; index: number; changes: Map<string, bigint> }>()
  for (const row of rows) {
    if (row.account !== account) continue
    const tx = txs.get(row.tx_hash) ?? { block: row.block_num, index: row.tx_index, changes: new Map<string, bigint>() }
    txs.set(row.tx_hash, tx)
    const token = tokenByAddress(row.token)
    if (token && !token.oracle) tx.changes.set(token.asset, (tx.changes.get(token.asset) ?? 0n) + (row.side === "credit" ? BigInt(row.amount) : -BigInt(row.amount)))
  }
  const held = new Map(TOKENS.filter((t) => !t.oracle).map((t) => [t.asset, BigInt(opening?.amounts[t.asset] ?? "0")]))
  const needs = new Map<string, { asset: string; block: number }>()
  for (const { block, changes } of [...txs.values()].sort((a, b) => a.block - b.block || a.index - b.index)) {
    for (const [asset, change] of changes) {
      const after = (held.get(asset) ?? 0n) + change
      // More can leave than we saw arrive, and what's left then is nothing, as in the fold.
      held.set(asset, after > 0n ? after : 0n)
    }
    for (const [asset, qty] of held) if (qty > 0n) needs.set(`${asset}:${block}`, { asset, block })
  }
  return [...needs.values()].reverse()
}
