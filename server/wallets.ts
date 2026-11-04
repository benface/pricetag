// Keeps each wallet's rows in memory: one full read, then only new blocks, because a wallet read scans the whole range.

import type { Head, WalletResponse } from "../src/core/api.ts"
import { buildPricedLegs, derivePricedRows, answerToMicros, type LegRow, type PricedRow, type ReferenceRow } from "../src/core/legs.ts"
import type { LatestPrices } from "../src/core/portfolio.ts"
import type { Source } from "./source.ts"

/** Re-read this many blocks on each refresh, so a reorg near the tip replaces what it changed. */
const REORG_BLOCKS = 30
const MAX_WALLETS = 20

type Cached = {
  fromBlock: number
  coveredTo: number
  rows: LegRow[]
  priced: PricedRow[]
  references: Map<number, ReferenceRow>
  prices: LatestPrices
  latest: Head
  gasUnknownTxs: Set<string>
}

export function createWallets(source: Source, currentHead: () => Promise<Head>) {
  const wallets = new Map<string, Cached>()
  const inflight = new Map<string, Promise<Cached>>()

  async function refresh(address: string): Promise<Cached> {
    const head = await currentHead()
    const cached = wallets.get(address)
    if (cached && cached.coveredTo >= head.blockNum) return cached

    const fromBlock = cached?.fromBlock ?? source.startBlock ?? Math.max(0, head.blockNum - (source.historyBlocks ?? 0))
    const readFrom = cached ? Math.max(fromBlock, cached.coveredTo - REORG_BLOCKS + 1) : fromBlock
    const window = await source.readWindow(address, readFrom, head.blockNum)

    const rows = [...(cached?.rows.filter((r) => r.block_num < readFrom) ?? []), ...window.rows]
    const known = new Map(cached?.references ?? [])
    for (const block of known.keys()) if (block >= readFrom) known.delete(block)
    const missing = [...new Set(rows.map((r) => r.block_num))].filter((b) => !known.has(b))
    for (const reference of await source.readReferences(missing)) known.set(reference.block_num, reference)

    // Without a recent read, the price is gone rather than old: an old one would quietly mark the position wrong.
    const latest = await source.readLatestReference(head.blockNum)
    const eth = answerToMicros(latest?.eth_usd)
    const usdc = answerToMicros(latest?.usdc_usd)
    const prices: LatestPrices = {}
    if (latest && eth) prices.ETH = { usdMicros: eth, source: "oracle", blockNum: latest.block_num }
    if (latest && usdc) prices.USDC = { usdMicros: usdc, source: "oracle", blockNum: latest.block_num }

    const priced = window.priced
      ? [...(cached?.priced.filter((p) => p.block_num < readFrom) ?? []), ...window.priced]
      : derivePricedRows(rows, [...known.values()])

    const next: Cached = {
      fromBlock,
      coveredTo: head.blockNum,
      rows,
      priced,
      references: known,
      prices,
      latest: head,
      gasUnknownTxs: new Set([...(cached?.gasUnknownTxs ?? []), ...window.gasUnknownTxs]),
    }
    wallets.delete(address)
    wallets.set(address, next)
    if (wallets.size > MAX_WALLETS) wallets.delete(wallets.keys().next().value as string)
    return next
  }

  return {
    async get(address: string): Promise<WalletResponse> {
      const key = address.toLowerCase()
      let pending = inflight.get(key)
      if (!pending) {
        pending = refresh(key).finally(() => inflight.delete(key))
        inflight.set(key, pending)
      }
      const wallet = await pending
      const references = [...wallet.references.values()]
      return {
        address: key,
        mode: source.mode,
        coverage: { fromBlock: wallet.fromBlock, toBlock: wallet.coveredTo },
        legs: buildPricedLegs({ account: key, rows: wallet.rows, references, priced: wallet.priced }),
        references,
        prices: wallet.prices,
        latest: wallet.latest,
        gasUnknownTxs: [...wallet.gasUnknownTxs],
      }
    },
  }
}
