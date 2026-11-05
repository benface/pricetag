// Prices come from logs of the aggregators in `PRICE_FEEDS`. When Chainlink moves a feed to a new aggregator, its proxy
// emits no log, so a pinned address just goes quiet, and its price turns `unknown` once its window passes. No table can
// see that coming, but the proxy can be asked.

import { CURRENCIES, PRICE_FEEDS } from "@pricetag/sdk/core"
import { RpcAnswerError, describeRpcError, hexOf } from "@pricetag/sdk/internal"

/** The first four bytes of the Keccak of `aggregator()`. */
export const AGGREGATOR_SELECTOR = "0x245a7bfc"

const TIMEOUT_MS = 15_000

type Watched = { pair: string; proxy: string; aggregators: readonly string[]; lost: string }

async function warnOfNew(feeds: readonly Watched[], url: string, send: typeof fetch, warn: (message: string) => void): Promise<void> {
  for (const feed of feeds) {
    try {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: feed.proxy, data: AGGREGATOR_SELECTOR }, "latest"] })
      const response = await send(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!response.ok) throw new RpcAnswerError(`status ${response.status}`)
      const { result } = (await response.json()) as { result?: unknown }
      if (typeof result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(result)) throw new RpcAnswerError("no address in the answer")
      const current = result.slice(-40).toLowerCase()
      if (feed.aggregators.some((address) => hexOf(address) === current)) continue
      warn(`Chainlink's ${feed.pair} feed now reads from 0x${current}, ${feed.lost}`)
    } catch (error) {
      warn(`Couldn't check which contract Chainlink's ${feed.pair} feed reads from: ${describeRpcError(error)}`)
    }
  }
}

/** Warns about any feed whose proxy reads from an aggregator the dataset doesn't list. Never throws, because prices still work until the window passes. */
export function warnOfNewAggregators(url: string, send: typeof fetch = fetch, warn: (message: string) => void = console.warn): Promise<void> {
  const feeds = PRICE_FEEDS.map(({ pair, proxy, aggregators, validSeconds }) => ({
    pair,
    proxy,
    aggregators,
    lost: `which isn't in PRICE_FEEDS. Its price turns unknown within ${(validSeconds / 3600).toLocaleString("en-US", { maximumFractionDigits: 1 })} hours of its last update. Add the address and deploy a new dataset version.`,
  }))
  return warnOfNew(feeds, url, send, warn)
}

/** The same for exchange rates, when they're read from logs. Until a rate's age passes the limit, it's the last one the old contract gave. */
export function warnOfNewRateAggregators(url: string, send: typeof fetch = fetch, warn: (message: string) => void = console.warn): Promise<void> {
  const feeds = Object.values(CURRENCIES).flatMap(({ feed }) => (feed ? [{ pair: feed.pair, proxy: feed.address, aggregators: feed.aggregators, lost: "which isn't in CURRENCIES. That rate stops moving, and turns unknown within 3 days of its last update. Add the address and deploy a new version of the rates dataset." }] : []))
  return warnOfNew(feeds, url, send, warn)
}
