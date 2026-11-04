// A token's `market` price: what it recently traded at, from `priced_legs`, with guards so a thin pool can't set it.

import { blockBefore } from "./chain.ts"
import { worth } from "./fold.ts"
import { answerToMicros, isSanePrice, type PricedRow } from "./legs.ts"
import { ETH_ADDRESS, TOKENS, normalizeAddress, tokenByAddress } from "./tokens.ts"

/** One account's trade of a token. A trade shows up once per account it went through, which is why these group by transaction. */
export type MarketTrade = { blockNum: number; txHash: string; asset: string; usdMicros: string; notionalUsdMicros: string }

/** `priced_legs`' pool and router rows are as good as a trader's here: they all imply the same price. */
export type MarketRow = Pick<PricedRow, "block_num" | "tx_hash" | "sold_token" | "sold_amount" | "bought_token" | "bought_amount" | "priced"> & { eth_usd: string }

/** Older than this, a trade doesn't say what a token's worth now. */
export const MARKET_MAX_AGE_MS = 1_800_000
/** No priced_legs row says how deep a pool is, so these stand in for it: real size, from several transactions. */
const MIN_TRADE_USD_MICROS = 100_000_000n
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
    if (trade.asset !== asset || trade.blockNum > block || trade.blockNum < blockBefore(block, MARKET_MAX_AGE_MS)) continue
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
