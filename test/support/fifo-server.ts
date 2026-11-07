// The real server, in a process of its own, folding a synthetic history by oldest first under a real heap limit. Prints what
// each request answered and the most heap it used, read from V8's record of every collection, since the fold runs
// synchronously and nothing else on this thread could look while it did.
// `node --max-old-space-size=640 fifo-server.ts <shape> <count> [unchecked]`: `buys` is <count> purchases that all stay open,
// `mixed` is <count> legs that buy and sell, `bounce` is <count> lots moved between two wallets 20 times, and `linked` is
// <count> purchases each in two linked wallets that never trade. `unchecked` lifts the size check, to measure what a history
// really costs.

import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { GCProfiler, getHeapStatistics } from "node:v8"
import { ASSETS, USDC_ADDRESS, limitFolds, type LegRow } from "@pricetag/sdk/core"
import type { Source } from "@pricetag/sdk/internal"
import { createApi } from "../../server/app.ts"
import { createHandler } from "../../server/http.ts"

const [shape = "buys", countArg = "1000", unchecked] = process.argv.slice(2)
const count = Number(countArg)
const A = "0x00000000000000000000000000000000000000a1"
const B = "0x00000000000000000000000000000000000000b1"
const SOMEONE = "0x00000000000000000000000000000000000000d1"
const BOUNCES = 20

const usdc = (block: number, account: string, side: "credit" | "debit", amount: number, counterparty: string): LegRow => ({ block_num: block, timestamp: "2026-11-05T00:00:00.000Z", tx_hash: `0x${block.toString(16)}`, tx_index: 1, log_index: 0, token: USDC_ADDRESS, account, side, amount: String(amount), kind: "erc20", counterparty })
const rows: LegRow[] = []
if (shape === "buys") for (let i = 1; i <= count; i++) rows.push(usdc(i, A, "credit", 10_000, SOMEONE))
else if (shape === "mixed") for (let i = 1; i <= count; i++) rows.push(usdc(i, A, i % 3 === 0 ? "debit" : "credit", 10_000, SOMEONE))
else if (shape === "bounce") {
  for (let i = 1; i <= count; i++) rows.push(usdc(i, A, "credit", 10_000, SOMEONE))
  for (let i = 0; i < BOUNCES; i++) {
    const [from, to] = i % 2 === 0 ? [A, B] : [B, A]
    rows.push(usdc(count + i + 1, from, "debit", count * 10_000, to), usdc(count + i + 1, to, "credit", count * 10_000, from))
  }
} else if (shape === "linked") for (let i = 1; i <= count; i++) rows.push(usdc(i, A, "credit", 10_000, SOMEONE), usdc(i, B, "credit", 10_000, SOMEONE))
else throw new Error(`No shape ${shape}`)
const head = { blockNum: (rows.at(-1)?.block_num ?? 0) + 10, timestamp: "2026-11-05T00:00:00.000Z" }
const byAccount = new Map<string, LegRow[]>()
for (const r of rows) byAccount.set(r.account, byAccount.get(r.account) ?? []).get(r.account)?.push(r)
const held = (address: string, block: number) => (byAccount.get(address) ?? []).filter((r) => r.block_num <= block).reduce((sum, r) => sum + BigInt(r.amount) * (r.side === "credit" ? 1n : -1n), 0n)

const source: Source = {
  mode: "raw",
  startBlock: 1,
  historyFrom: null,
  head: async () => head,
  processedThrough: async (_, at) => at,
  readWindow: async (address, from, to) => ({ rows: (byAccount.get(address) ?? []).filter((r) => r.block_num >= from && r.block_num <= to), priced: null, gasUnknown: [] }),
  readReferences: async (blocks) => blocks.map((blockNum) => ({ blockNum, ethUsd: "300000000000", usdcUsd: "100000000" })),
  readLatestReference: async () => ({ blockNum: head.blockNum, ethUsd: "300000000000", usdcUsd: "100000000" }),
  readEthBalances: async () => new Map(),
  readBalances: async (address, blockNum) => ({ blockNum, amounts: Object.fromEntries(ASSETS.map((asset) => [asset, asset === "USDC" ? held(address, blockNum).toString() : "0"])) }),
}
const api = createApi({}, { source, readRates: async () => ({ byBlock: {}, latest: null }), proofs: { datasets: async () => [], priceBehind: async () => null, currentPriceBehind: async () => null, readBlock: async () => null } }, null)
if (unchecked === "unchecked") limitFolds(Number.POSITIVE_INFINITY)
const server = createServer(createHandler(api, null))
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`

// The heap only grows between collections, so its peak is what it held just before one of them, or at the end.
function heapPeak(profiler: GCProfiler) {
  const collections = profiler.stop()?.statistics ?? []
  return Math.max(getHeapStatistics().used_heap_size, ...collections.map((gc) => gc.beforeGC.heapStatistics.usedHeapSize))
}
let peak = 0
const answers: Record<string, { status: number; ms: number; peakMb: number; error?: string }> = {}
const only = process.env.ONLY?.split(",")
async function ask(name: string, path: string, body: unknown) {
  if (only && name !== "warm" && !only.includes(name)) return
  const profiler = new GCProfiler()
  profiler.start()
  const started = performance.now()
  const response = await fetch(`${base}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const text = await response.text()
  const ms = Math.round(performance.now() - started)
  const used = heapPeak(profiler)
  peak = Math.max(peak, used)
  answers[name] = { status: response.status, ms, peakMb: Math.round(used / 1e6), ...(response.status === 200 ? {} : { error: text.slice(0, 200) }) }
}

const linked = shape === "bounce" || shape === "linked" ? [A, B] : [A]
await ask("warm", "portfolio/all/wallets", { linked })
await ask("all", "portfolio/all", { method: "fifo", linked })
await ask("single", `portfolio/${shape === "bounce" ? B : A}`, { method: "fifo", linked })
await ask("tax", `tax-report/${A}`, { method: "fifo", country: "CA", scope: "per-wallet", also: linked.filter((a) => a !== A) })
console.log(JSON.stringify({ shape, count, rows: rows.length, peakMb: Math.round(peak / 1e6), answers }))
server.closeAllConnections()
server.close()
