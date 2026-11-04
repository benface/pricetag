import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, request, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"
import { createApi } from "../server/app.ts"
import { createHandler } from "../server/http.ts"
import { describeError, isNotStarted } from "@pricetag/sdk"
import { datasetSource } from "../server/source.ts"
import { encodeNote } from "../src/core/notes.ts"

/** Sends the path exactly as written, which fetch wouldn't. */
function get(server: Server, path: string): Promise<{ status: number; body: string }> {
  const { port } = server.address() as { port: number }
  return new Promise((resolve, reject) => {
    const req = request({ port, host: "127.0.0.1", path }, (res) => {
      let body = ""
      res.on("data", (chunk) => (body += chunk))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on("error", reject)
    req.end()
  })
}

describe("the server", () => {
  let server: Server
  let dist: string

  before(async () => {
    dist = mkdtempSync(join(tmpdir(), "pricetag-dist-"))
    writeFileSync(join(dist, "index.html"), "<title>app</title>")
    server = createServer(createHandler(createApi({}), dist))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  })
  after(() => {
    server.close()
    rmSync(dist, { recursive: true })
  })

  for (const path of ["/%", "/%E0%A4%A", "/api/%", "/api/wallet/%zz", "//"]) {
    it(`survives ${path} and still answers the next request`, async () => {
      const { status } = await get(server, path)
      assert.ok(status < 500, `got ${status}`)
      assert.equal((await get(server, "/")).status, 200)
      assert.equal((await get(server, "/api/wallet/demo")).status, 200)
    })
  }

  it("a malformed URL is a 400", async () => {
    assert.equal((await get(server, "/%")).status, 400)
    assert.equal((await get(server, "/api/%")).status, 400)
  })

  it("a handler that throws gets a 500, and the server carries on", async () => {
    const failing = createServer(createHandler(() => Promise.reject(new Error("boom")), dist))
    await new Promise<void>((resolve) => failing.listen(0, "127.0.0.1", resolve))
    assert.equal((await get(failing, "/")).status, 500)
    assert.equal((await get(failing, "/")).status, 500)
    failing.close()
  })

  it("doesn't serve files from outside the build", async () => {
    const { body } = await get(server, "/../package.json")
    assert.equal(body, "<title>app</title>")
    assert.equal((await get(server, "/..%2f..%2fpackage.json")).body, "<title>app</title>")
  })
})

const notStarted = { _tag: "ArrowFlightError", message: "", cause: { _tag: "ArrowFlightError", cause: { rawMessage: "failed to resolve batch query snapshot | Caused by: no common canonical watermark is available for batch snapshot" } } }

describe("the balance read", () => {
  it("is one eth_call at that exact block, with no table, so it can read before a dataset's first block", async () => {
    const queries: string[] = []
    const query = async <T>(sql: string) => {
      queries.push(sql)
      return [{ r: { data: null, message: "boom" } }] as T[]
    }
    const source = datasetSource(query, { baseDataset: "base", dataset: "ds", startBlock: 1, network: "base_mainnet" })
    assert.equal(await source.readBalances("0x00000000000000000000000000000000000000cc", 41), null)
    assert.equal(queries.length, 1)
    assert.match(queries[0]!, /^SELECT rpc\.base_mainnet\.eth_call\(NULL, /)
    assert.match(queries[0]!, /, 41\) AS r$/)
    assert.doesNotMatch(queries[0]!, /FROM/)
  })
})

describe("what a dataset adds to a wallet's rows", () => {
  const config = { baseDataset: "base", dataset: "ds", startBlock: 1, network: "base_mainnet" }
  const ME = "00000000000000000000000000000000000000cc"
  const SENDER = "00000000000000000000000000000000000000dd"
  const leg = { block_num: 5, timestamp: 1, tx_hash: "aa", tx_index: 1, log_index: 3, token: "833589fcd6edb6e08f4c7c32d4f71b54bda02913", account: ME, side: "credit", amount: "7", kind: "erc20" }

  it("says who sent each row, reading only the blocks that have one", async () => {
    const queries: string[] = []
    const query = async <T>(sql: string) => {
      queries.push(sql)
      if (sql.includes(".legs")) return [leg, { ...leg, log_index: 0, token: "0000000000000000000000000000000000000000", kind: "eth", tx_hash: "bb" }] as T[]
      if (sql.includes("base\".logs")) return [{ tx_hash: "aa", log_index: 3, topic1: SENDER.padStart(64, "0"), topic2: ME.padStart(64, "0") }] as T[]
      if (sql.includes("base\".transactions")) return [{ tx_hash: "bb", from: SENDER, to: ME }] as T[]
      return [] as T[]
    }
    const { rows } = await datasetSource(query, config).readWindow(`0x${ME}`, 1, 10)
    assert.deepEqual(rows.map((r) => r.counterparty), [`0x${SENDER}`, `0x${SENDER}`])
    const raw = queries.filter((q) => q.includes('"base"'))
    assert.equal(raw.length, 2)
    assert.ok(raw.every((q) => q.includes("block_num BETWEEN 5 AND 5")), "only that block")
  })

  it("doesn't touch the raw tables for a wallet with nothing to look up", async () => {
    const queries: string[] = []
    const query = async <T>(sql: string) => (queries.push(sql), [] as T[])
    await datasetSource(query, config).readWindow(`0x${ME}`, 1, 10)
    assert.ok(!queries.some((q) => q.includes('"base"')))
  })

  it("only trusts priced_legs from a dataset that has the fix for its wrong rows", async () => {
    const answer = (error: unknown) => datasetSource(async () => Promise.reject(error), config)
    assert.equal(await answer(new Error("Error during planning: table 'amp.benface/pricetag_scratch@0.0.4.unlisted_moves' not found")).marketReady!(), false)
    assert.equal(await answer(notStarted).marketReady!(), true, "it has the table, and hasn't written to it yet")
    await assert.rejects(answer(new Error("connection refused")).marketReady!(), "an outage says nothing about the dataset")
    assert.equal(await datasetSource(async <T>() => [] as T[], config).marketReady!(), true)
  })

  it("reads an asset's trades in a range, newest first, keeping only plausible prices", async () => {
    const queries: string[] = []
    const row = (usd_micros: string) => ({ block_num: 9, tx_hash: "aa", sold_token: "833589fcd6edb6e08f4c7c32d4f71b54bda02913", sold_amount: "500000000", bought_token: "940181a94a35a4569e4529a3cdfb74e38fd98631", bought_amount: "400000000000000000000", priced: { token: "AERO", usd_micros, source: "swap" }, eth_usd: "240000000000" })
    const query = async <T>(sql: string) => (queries.push(sql), [row("1250000"), row("6600000000000")] as T[])
    const trades = await datasetSource(query, config).readMarketTrades!("AERO'; DROP", 100, 200)
    assert.deepEqual(trades, [{ blockNum: 9, txHash: "0xaa", asset: "AERO", usdMicros: "1250000", notionalUsdMicros: "500000000" }])
    assert.match(queries[0]!, /block_num BETWEEN 100 AND 200/)
    assert.match(queries[0]!, /get_field\(priced, 'token'\) = 'AERODROP'/)
    assert.match(queries[0]!, /ORDER BY block_num DESC LIMIT \d+/)
  })

  it("reads only this wallet's own notes, from zero-value transactions to itself", async () => {
    const queries: string[] = []
    const hash = `0x${"ab".repeat(32)}`
    const query = async <T>(sql: string) => (queries.push(sql), [{ block_num: 5, tx_hash: "cc", input: encodeNote(hash, "USDC", "5").slice(2) }, { block_num: 5, tx_hash: "dd", input: "abcd" }] as T[])
    const notes = await datasetSource(query, config).readNotes!(`0x${ME}`, [5])
    assert.deepEqual(notes, [{ txHash: hash, asset: "USDC", usdMicros: "5", noteTx: "0xcc", blockNum: 5 }])
    assert.match(queries[0]!, new RegExp(`"from" = X'${ME}' AND "to" = X'${ME}' AND status AND value = '0'`))
  })
})

describe("a dataset whose tables haven't started", () => {
  const config = { baseDataset: "base", dataset: "ds", startBlock: 1, network: "base_mainnet" }

  it("reads as not processed yet, rather than as an outage", async () => {
    assert.ok(isNotStarted(notStarted))
    const source = datasetSource(() => Promise.reject(notStarted), config)
    assert.equal(await source.processedThrough(1, 100), null)
    assert.equal(await source.readLatestReference(100), null)
  })

  it("a real failure still fails", async () => {
    const outage = { cause: { rawMessage: "connection refused" } }
    assert.equal(isNotStarted(outage), false)
    assert.equal(describeError(outage), "connection refused")
    const source = datasetSource(() => Promise.reject(outage), config)
    await assert.rejects(source.processedThrough(1, 100))
  })

  it("the slowest table sets how far a read can go", async () => {
    const tops: Record<string, number> = { legs: 90, unlisted_legs: 95, priced_legs: 70, reference_prices: 80 }
    const query = async <T>(sql: string) => {
      const table = /\.(\w+) WHERE/.exec(sql)![1]!
      return [{ block_num: String(tops[table]) }] as T[]
    }
    assert.equal(await datasetSource(query, config).processedThrough(1, 100), 70)
    tops.unlisted_legs = 60
    assert.equal(await datasetSource(query, config).processedThrough(1, 100), 60)
  })

  it("keeps an NFT row's kind and ID, including ID 0, so both data paths net it the same way", async () => {
    const leg = { block_num: "5", timestamp: 0, tx_hash: "aa", tx_index: 1, log_index: 0, token: "bb", account: "cc", side: "credit" }
    const query = async <T>(sql: string) => (sql.includes(".unlisted_legs") ? [{ ...leg, amount: "0", kind: "unlisted_nft" }, { ...leg, amount: "0", kind: "unlisted" }] : []) as T[]
    const window = await datasetSource(query, config).readWindow("0x00000000000000000000000000000000000000cc", 1, 10)
    assert.deepEqual(window.rows.map((r) => [r.kind, r.amount]), [["unlisted_nft", "0"], ["unlisted", "0"]])
  })

  it("reads unlisted rows as evidence, even with a null amount, and still drops empty gas", async () => {
    const leg = { block_num: "5", timestamp: 0, tx_hash: "aa", tx_index: 1, log_index: 0, token: "bb", account: "cc", side: "credit" }
    const query = async <T>(sql: string) =>
      (sql.includes(".unlisted_legs") ? [{ ...leg, amount: null, kind: "unlisted" }] : sql.includes(".legs") ? [{ ...leg, amount: "", kind: "gas" }] : []) as T[]
    const window = await datasetSource(query, config).readWindow("0x00000000000000000000000000000000000000cc", 1, 10)
    assert.deepEqual(window.rows.map((r) => [r.kind, r.amount]), [["unlisted", ""]])
    assert.equal(window.gasUnknownTxs.length, 1)
  })
})
