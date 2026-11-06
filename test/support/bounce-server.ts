// The real server, in a process of its own, on a wallet's lots moved back and forth between two wallets. Run under a real heap
// limit, since a lowered `limitFolds` can't show memory running out while it's being counted. Prints what each request answered.

import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { ASSETS, USDC_ADDRESS, type LegRow } from "@pricetag/sdk/core"
import type { Source } from "@pricetag/sdk/internal"
import { createApi } from "../../server/app.ts"
import { createHandler } from "../../server/http.ts"

const [lots = 3_000, moves = 3_000] = process.argv.slice(2).map(Number)
const A = "0x00000000000000000000000000000000000000a1"
const B = "0x00000000000000000000000000000000000000b1"
const SMALL = "0x00000000000000000000000000000000000000c1"
const SOMEONE = "0x00000000000000000000000000000000000000d1"
const HEAD = { blockNum: lots + moves + 10, timestamp: "2026-11-05T00:00:00.000Z" }

const usdc = (block: number, account: string, side: "credit" | "debit", amount: number, counterparty: string): LegRow => ({ block_num: block, timestamp: HEAD.timestamp, tx_hash: `0x${block.toString(16)}`, tx_index: 1, log_index: 0, token: USDC_ADDRESS, account, side, amount: String(amount), kind: "erc20", counterparty })
const rows = [usdc(1, SMALL, "credit", 10_000, SOMEONE)]
for (let i = 1; i <= lots; i++) rows.push(usdc(i, A, "credit", 10_000, SOMEONE))
for (let i = 0; i < moves; i++) {
  const [from, to] = i % 2 === 0 ? [A, B] : [B, A]
  rows.push(usdc(lots + i + 1, from, "debit", lots * 10_000, to), usdc(lots + i + 1, to, "credit", lots * 10_000, from))
}
const held = (address: string, block: number) => rows.filter((r) => r.account === address && r.block_num <= block).reduce((sum, r) => sum + BigInt(r.amount) * (r.side === "credit" ? 1n : -1n), 0n)

const source: Source = {
  mode: "raw",
  startBlock: 1,
  historyFrom: null,
  head: async () => HEAD,
  processedThrough: async (_, head) => head,
  readWindow: async (address, from, to) => ({ rows: rows.filter((r) => r.account === address && r.block_num >= from && r.block_num <= to), priced: null, gasUnknown: [] }),
  readReferences: async (blocks) => blocks.map((blockNum) => ({ blockNum, ethUsd: "300000000000", usdcUsd: "100000000" })),
  readLatestReference: async () => ({ blockNum: HEAD.blockNum, ethUsd: "300000000000", usdcUsd: "100000000" }),
  readEthBalances: async () => new Map(),
  readBalances: async (address, blockNum) => ({ blockNum, amounts: Object.fromEntries(ASSETS.map((asset) => [asset, asset === "USDC" ? held(address, blockNum).toString() : "0"])) }),
}
const api = createApi({}, { source, readRates: async () => ({ byBlock: {}, latest: null }), proofs: { datasets: async () => [], priceBehind: async () => null, currentPriceBehind: async () => null, readBlock: async () => null } }, null)
const server = createServer(createHandler(api, null))
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`

const answers: Record<string, { status: number; type: string | null; error?: string }> = {}
async function ask(name: string, path: string, body: unknown) {
  const response = await fetch(`${base}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const type = response.headers.get("content-type")
  const text = await response.text()
  answers[name] = { status: response.status, type, ...(response.status === 200 ? {} : { error: (JSON.parse(text) as { error: string }).error }) }
}

const linked = { method: "fifo", linked: [A, B] }
await ask("warm", "portfolio/all/wallets", { linked: [A, B] })
await ask("all", "portfolio/all", linked)
await ask("export", "portfolio/all/export", linked)
await ask("explain", "portfolio/all/explain?metric=pnl", linked)
await ask("preview", "portfolio/all/preview", { ...linked, candidates: [{ senders: {}, costs: {} }] })
await ask("single", `portfolio/${B}`, linked)
await ask("tax", `tax-report/${A}`, { method: "fifo", country: "CA", scope: "per-wallet", also: [B] })
await ask("small", `portfolio/${SMALL}`, { method: "fifo" })

console.log(JSON.stringify(answers))
server.closeAllConnections()
server.close()
