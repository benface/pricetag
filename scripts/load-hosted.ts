// `pnpm load:hosted`: the hosted server under several Macs at once, with one very busy wallet among them, and no Amp involved.
//
// Everything's real but Amp: the gate, the limits, the wallet reads and the HTTP. Amp is replaced by waits that replay what
// staging took on 2026-11-06, through the same turns as real queries, so nothing here can disturb staging. It shows how queries
// wait on each other. It says nothing about how many Amp itself can take, or about memory.
//
// node scripts/load-hosted.ts [--seconds 90] [--people 4] [--lanes 3 | --one-queue]

import { createServer, request, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { parseArgs } from "node:util"
import { ASSETS } from "@pricetag/sdk/core"
import { createTurns, type Source } from "@pricetag/sdk/internal"
import { createApi } from "../server/app.ts"
import { gate, hashOf, hostingOf } from "../server/hosting.ts"
import { createHandler } from "../server/http.ts"
import { laneOf } from "../server/lanes.ts"

const { values } = parseArgs({ options: { seconds: { type: "string", default: "90" }, people: { type: "string", default: "4" }, lanes: { type: "string", default: "3" }, "one-queue": { type: "boolean", default: false } } })
const seconds = Number(values.seconds)
const people = Number(values.people)

/** In ms, as recorded through `/api/portfolio` for a wallet with a few dozen movements. */
const FIRST_WINDOW = [1100, 1100, 1470, 1140, 470, 230, 410, 250, 150, 260, 270, 250, 500, 270, 470, 460, 530, 390, 390, 270, 1140]
const NEXT_WINDOW = [500, 400, 480]
/** WORK-587: one read of a very busy wallet's `legs` can take over 10 s. */
const BUSY_FIRST_WINDOW = [12_000, 12_000, 12_000, ...FIRST_WINDOW]
const BUSY_NEXT_WINDOW = [1500, 1000, 1000]

const inTurn = values["one-queue"] ? createTurns() : createTurns(Number(values.lanes), laneOf)
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const queries = async (durations: readonly number[]) => {
  for (const ms of durations) await inTurn(() => sleep(ms))
}

const BUSY = `0x${"b".repeat(40)}`
const firstHead = 100_000
const startedAt = Date.now()
const headNow = () => firstHead + Math.floor((Date.now() - startedAt) / 2000)
const seen = new Set<string>()
const source: Source = {
  mode: "raw",
  startBlock: firstHead - 1000,
  historyFrom: null,
  head: async () => {
    await queries([220])
    return { blockNum: headNow(), timestamp: new Date().toISOString() }
  },
  processedThrough: async (_, head) => {
    await queries([220])
    return head
  },
  readWindow: async (address) => {
    const first = !seen.has(address)
    seen.add(address)
    await queries(address === BUSY ? (first ? BUSY_FIRST_WINDOW : BUSY_NEXT_WINDOW) : first ? FIRST_WINDOW : NEXT_WINDOW)
    return { rows: [], priced: null, gasUnknown: [] }
  },
  readReferences: async (blocks) => blocks.map((blockNum) => ({ blockNum, ethUsd: "300000000000", usdcUsd: "100000000" })),
  readLatestReference: async () => {
    await queries([220])
    return { blockNum: headNow(), ethUsd: "300000000000", usdcUsd: "100000000" }
  },
  readEthBalances: async () => new Map(),
  readBalances: async (_, block) => {
    await queries([190])
    return { blockNum: block, amounts: Object.fromEntries(ASSETS.map((asset) => [asset, "0"])) }
  },
}

const names = ["busy", ...Array.from({ length: people }, (_, i) => `person${i}`)]
const inviteOf = (name: string) => `an-invite-for-this-load-test-${name}`
const hosting = hostingOf({ PRICETAG_INVITES: names.map((name) => `${name}:${hashOf(inviteOf(name))}`).join(","), HOST: "127.0.0.1" })
const created = { source, readRates: async () => ({ byBlock: {}, latest: null }), proofs: { datasets: async () => [], priceBehind: async () => null, currentPriceBehind: async () => null, readBlock: async () => null } }
const server = createServer(createHandler(gate(createApi({}, created, null, { maxWallets: 200 }), hosting, () => ({ amp: true, buying: false })), null))
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
const { port } = server.address() as AddressInfo

type Person = { name: string; first: number | null; reads: number[]; requests: number; limited: number; heads: number[] }

/** What the Mac app does: a stream of heads, its last read, then one read a head, and another straight after if one arrived during it. */
function act(name: string, address: string, until: number): Promise<Person> {
  const person: Person = { name, first: null, reads: [], requests: 0, limited: 0, heads: [] }
  const headers = { authorization: `Bearer ${inviteOf(name)}` }
  const post = (path: string) =>
    new Promise<number>((resolve, reject) => {
      person.requests++
      const req = request({ port, path, method: "POST", headers: { ...headers, "content-type": "application/json" } }, (res) => {
        res.resume()
        res.on("end", () => {
          if (res.statusCode === 429) person.limited++
          resolve(res.statusCode ?? 0)
        })
      })
      req.on("error", reject)
      req.end(JSON.stringify({ method: "average" }))
    })

  return new Promise((resolve) => {
    let busy = false
    let again = false
    const read = async (path: string) => {
      if (busy) {
        again = true
        return
      }
      busy = true
      const started = Date.now()
      await post(path)
      if (person.first === null) person.first = Date.now() - started
      else person.reads.push(Date.now() - started)
      busy = false
      if (again && Date.now() < until) {
        again = false
        void read(path)
      }
    }
    const path = `/api/portfolio/${address}`
    person.requests++
    const stream = request({ port, path: "/api/events", headers }, (res: IncomingMessage) => {
      res.on("data", (chunk: Buffer) => {
        if (chunk.includes("event: head")) {
          person.heads.push(Date.now())
          void read(path)
        }
      })
    })
    stream.on("error", () => {})
    stream.end()
    void post(`${path}/last`).then(() => read(path))
    setTimeout(() => {
      stream.destroy()
      resolve(person)
    }, until - Date.now())
  })
}

const percentile = (values: readonly number[], at: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * at))] ?? 0
}
const inSeconds = (ms: number | null) => (ms === null ? "none yet" : `${(ms / 1000).toFixed(1)} s`)

const until = Date.now() + seconds * 1000
const wallets = names.map((name, i) => (name === "busy" ? BUSY : `0x${(i + 1).toString(16).padStart(40, "0")}`))
const results = await Promise.all(names.map((name, i) => act(name, wallets[i] as string, until)))

console.log(`${values["one-queue"] ? "One queue, as before" : `Turns, ${values.lanes} lanes at once`}: ${people} people and one very busy wallet, for ${seconds} s`)
console.log("who       first read   later reads: median   p95      slowest   reads   requests/min   429s   longest gap in heads")
for (const { name, first, reads, requests, limited, heads } of results) {
  const gaps = heads.slice(1).map((at, i) => at - (heads[i] as number))
  console.log([name.padEnd(9), inSeconds(first).padEnd(12), inSeconds(percentile(reads, 0.5)).padEnd(21), inSeconds(percentile(reads, 0.95)).padEnd(8), inSeconds(Math.max(0, ...reads)).padEnd(9), String(reads.length).padEnd(7), String(Math.round((requests / seconds) * 60)).padEnd(14), String(limited).padEnd(6), inSeconds(Math.max(0, ...gaps))].join(" "))
}
process.exit(0)
