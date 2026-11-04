// Prints the manifest for an Amp with no blocks before its start, like the one `pnpm amp:start` runs:
//
//   node dataset/local.ts <start block> <RPC URL> > pricetag.json
//
// Its first prices can't come from logs, because the last update can be up to a day before the start. So they're read
// from each feed's contract at the start block, which is the same price, with no log to back it up. The app says so.

import { readFileSync } from "node:fs"
import { PRICE_FEEDS } from "@pricetag/sdk/core"
import { tablesSql, type FeedSeed } from "./build.ts"

const MANIFEST = new URL("./pricetag.json", import.meta.url)

/** The first four bytes of the Keccak of `latestRoundData()`. */
export const LATEST_ROUND_SELECTOR = "0xfeaf968c"

const ATTEMPTS = 4
const TIMEOUT_MS = 15_000

/** Every feed's latest round at `block`. It throws unless all of them were read, since a missing one would be missing for up to a day. */
export async function readFeedSeeds(url: string, block: number, send: typeof fetch = fetch, pauseMs = 2_000): Promise<FeedSeed[]> {
  const readOne = async (feed: (typeof PRICE_FEEDS)[number]): Promise<FeedSeed> => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: feed.proxy, data: LATEST_ROUND_SELECTOR }, `0x${block.toString(16)}`] })
    const response = await send(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!response.ok) throw new Error(`status ${response.status}`)
    const { result } = (await response.json()) as { result?: unknown }
    // roundId, answer, startedAt, updatedAt, answeredInRound
    if (typeof result !== "string" || !/^0x[0-9a-fA-F]{320}$/.test(result)) throw new Error("no round in the answer")
    const word = (index: number) => BigInt(`0x${result.slice(2 + index * 64, 2 + (index + 1) * 64)}`)
    if (word(1) <= 0n || word(1) >> 255n === 1n) throw new Error("no price in the answer")
    return { feed, roundId: word(0).toString(), answer: word(1).toString(), updatedAt: Number(word(3)) }
  }
  const seeds: FeedSeed[] = []
  for (const feed of PRICE_FEEDS) {
    for (let attempt = 1; ; attempt++) {
      try {
        seeds.push(await readOne(feed))
        break
      } catch (error) {
        if (attempt === ATTEMPTS) throw new Error(`${feed.pair}: ${error instanceof Error ? error.message : "unknown error"}`)
        await new Promise((resolve) => setTimeout(resolve, pauseMs))
      }
    }
  }
  return seeds
}

/** The committed manifest, with its SQL for this start. A seed's columns are the same as a log's, so the schemas still hold. */
export function localManifest(committed: { tables: Record<string, { input: { sql: string } }> }, start: number, seeds: readonly FeedSeed[]) {
  const sql = tablesSql(start, seeds)
  return { ...committed, tables: Object.fromEntries(Object.entries(committed.tables).map(([name, table]) => [name, { ...table, input: { sql: sql[name] } }])) }
}

if (import.meta.main) {
  const [start, url] = [Number(process.argv[2]), process.argv[3]]
  if (!Number.isSafeInteger(start) || start <= 0 || !url) throw new Error("Usage: node dataset/local.ts <start block> <RPC URL>")
  try {
    const seeds = await readFeedSeeds(url, start)
    console.log(JSON.stringify(localManifest(JSON.parse(readFileSync(MANIFEST, "utf8")), start, seeds), null, 2))
  } catch (error) {
    // Only the message: a dedicated RPC's URL has a key in it.
    console.error(error instanceof Error ? error.message : "unknown error")
    process.exit(1)
  }
}
