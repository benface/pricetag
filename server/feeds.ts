// Prices come from logs of the aggregators in `PRICE_FEEDS`. When Chainlink moves a feed to a new aggregator, its proxy
// emits no log, so a pinned address just goes quiet, and its price turns `unknown` once its window passes. No table can
// see that coming, but the proxy can be asked.

import { PRICE_FEEDS, hexOf } from "@pricetag/sdk"

/** The first four bytes of the Keccak of `aggregator()`. */
export const AGGREGATOR_SELECTOR = "0x245a7bfc"

const TIMEOUT_MS = 15_000

/** Warns about any feed whose proxy reads from an aggregator the dataset doesn't list. Never throws, because prices still work until the window passes. */
export async function warnOfNewAggregators(url: string, send: typeof fetch = fetch, warn: (message: string) => void = console.warn): Promise<void> {
  for (const feed of PRICE_FEEDS) {
    try {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: feed.proxy, data: AGGREGATOR_SELECTOR }, "latest"] })
      const response = await send(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!response.ok) throw new Error(`status ${response.status}`)
      const { result } = (await response.json()) as { result?: unknown }
      if (typeof result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(result)) throw new Error("no address in the answer")
      const current = result.slice(-40).toLowerCase()
      if (feed.aggregators.some((address) => hexOf(address) === current)) continue
      warn(`Chainlink's ${feed.pair} feed now reads from 0x${current}, which isn't in PRICE_FEEDS. Its price turns unknown within ${feed.validBlocks.toLocaleString("en-US")} blocks of its last update. Add the address and deploy a new dataset version.`)
    } catch (error) {
      // Not the URL: a dedicated RPC's has a key in it.
      warn(`Couldn't check which contract Chainlink's ${feed.pair} feed reads from: ${error instanceof Error ? error.message : "unknown error"}`)
    }
  }
}
