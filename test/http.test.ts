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

  it("has no rules to choose from when it has only one", async () => {
    assert.deepEqual(JSON.parse((await get(server, "/api/rules")).body), { rules: [] })
  })

  it("won't quietly read by another rule than the one asked for", async () => {
    assert.equal((await get(server, "/api/wallet/demo?rule=nope")).status, 400)
    assert.equal((await get(server, "/api/portfolio/demo?rule=nope")).status, 400)
  })

  it("has nothing to compare with only one rule", async () => {
    assert.equal((await get(server, "/api/portfolio/demo/compare")).status, 404)
  })

  it("won't start with a fork it can't pin", () => {
    const env = { AMP_QUERY_URL: "http://127.0.0.1:1", PRICETAG_DATASET: "a/b@0.0.1", PRICETAG_START_BLOCK: "5", PRICETAG_FORK_DATASET: "a/c@0.0.1" }
    assert.throws(() => createApi(env), /manifest hash/)
    assert.throws(() => createApi({ ...env, PRICETAG_DATASET_HASH: "a".repeat(64) }), /manifest hash/)
    assert.throws(() => createApi({ ...env, PRICETAG_DATASET_HASH: "a".repeat(64), PRICETAG_FORK_HASH: "nope" }), /manifest hash/)
  })

  it("lists both rules by name, dataset and hash when there's a fork, with the default first", async () => {
    const hash = { PRICETAG_DATASET_HASH: "a".repeat(64), PRICETAG_FORK_HASH: "b".repeat(64) }
    const api = createApi({ AMP_QUERY_URL: "http://127.0.0.1:1", PRICETAG_DATASET: "a/b@0.0.1", PRICETAG_START_BLOCK: "5", PRICETAG_FORK_DATASET: "a/c@0.0.1", ...hash })
    const fork = createServer(createHandler(api, dist))
    await new Promise<void>((resolve) => fork.listen(0, "127.0.0.1", resolve))
    const { rules } = JSON.parse((await get(fork, "/api/rules")).body) as { rules: { id: string; dataset: string; hash: string }[] }
    assert.equal((await get(fork, "/api/portfolio/demo/compare")).status, 400)
    fork.close()
    assert.deepEqual(rules.map((r) => [r.dataset, r.hash]), [["a/b@0.0.1", "a".repeat(64)], ["a/c@0.0.1", "b".repeat(64)]])
  })

  it("shows the proof behind a demo row, and says there's no real block to check", async () => {
    const { legs } = JSON.parse((await get(server, "/api/wallet/demo")).body) as { legs: { id: string; opening?: boolean }[] }
    const leg = legs.find((candidate) => !candidate.opening) as { id: string }
    const query = `leg=${encodeURIComponent(leg.id)}`
    const proof = await get(server, `/api/portfolio/demo/proof?${query}`)
    assert.equal(proof.status, 200)
    const body = JSON.parse(proof.body) as { unavailable: string; datasets: unknown[]; scope: string[] }
    assert.match(body.unavailable, /demo wallet/)
    assert.deepEqual(body.datasets, [])
    assert.match(body.scope[0] as string, /matches the block's header/)
    assert.equal((await get(server, `/api/portfolio/demo/verify?${query}`)).status, 400)
  })

  it("has no proof for what isn't a transaction", async () => {
    assert.equal((await get(server, "/api/portfolio/demo/proof?leg=nope")).status, 404)
    assert.equal((await get(server, "/api/portfolio/demo/verify")).status, 404)
    assert.equal((await get(server, "/api/portfolio/demo/proof?leg=opening:ETH")).status, 404)
  })

  it("won't read a wallet for proof with no data source", async () => {
    const address = "0x1111111111111111111111111111111111111111"
    assert.equal((await get(server, `/api/portfolio/${address}/proof?leg=x`)).status, 503)
    assert.equal((await get(server, "/api/portfolio/nope/verify?leg=x")).status, 400)
  })

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

describe("a dataset whose tables haven't started", () => {
  const notStarted = { _tag: "ArrowFlightError", message: "", cause: { _tag: "ArrowFlightError", cause: { rawMessage: "failed to resolve batch query snapshot | Caused by: no common canonical watermark is available for batch snapshot" } } }
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
