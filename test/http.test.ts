import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, request, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"
import { createApi, createSource } from "../server/app.ts"
import { createHandler } from "../server/http.ts"
import { createWallets, datasetSource, describeError, isNotStarted, settledThrough, type ReadL1Fees, type Source, type StreamRange, type StreamRanges } from "@pricetag/sdk/internal"
import { resolvingSource, settledL1Fees, sharedReads } from "../server/source.ts"
import { ETH_ADDRESS, encodeNote, marketPrice } from "@pricetag/sdk/core"
import type { WalletResponse } from "../src/core/api.ts"

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

  it("answers the demo's approvals, and says why it can't for anything else", async () => {
    const demo = JSON.parse((await get(server, "/api/approvals/demo")).body) as { mode: string; approvals: unknown[] }
    assert.equal(demo.mode, "demo")
    assert.ok(demo.approvals.length > 0)
    assert.equal((await get(server, "/api/approvals/nope")).status, 400)
    assert.equal((await get(server, `/api/approvals/0x${"1".repeat(40)}`)).status, 503)
  })

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

  it("bounds the first head lookup by the dataset's start block", async () => {
    const asked: string[] = []
    const query = Object.assign(async <T>(sql: string) => (asked.push(sql), [] as T[]), { aliased: () => query })
    const hash = { PRICETAG_DATASET_HASH: "a".repeat(64), PRICETAG_FORK_DATASET: "a/c@0.0.1", PRICETAG_FORK_HASH: "b".repeat(64) }
    const dataset = { AMP_QUERY_URL: "http://127.0.0.1:1", BASE_RPC_URL: "http://127.0.0.1:1", PRICETAG_DATASET: "a/b@0.0.1", PRICETAG_START_BLOCK: "5" }
    for (const env of [dataset, { ...dataset, ...hash }]) {
      const created = createSource(env, query)!
      asked.length = 0
      await created.source.head(null)
      await created.follow.readMark(null)
      assert.equal(asked.length, 2)
      for (const sql of asked) assert.match(sql, /\.blocks WHERE block_num >= 5 ORDER BY/)
    }
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

type MarketQueryRow = { block_num: number; sold_token: string; sold_amount: string; bought_token: string; bought_amount: string; priced: { usd_micros: string; source: string } }

/** Applies the parts of a market read that decide which rows fit under its limit, as far as the SQL asks for them. */
function answersLikeAmp(rows: readonly MarketQueryRow[]) {
  return async <T>(sql: string) => {
    const [, from, to] = sql.match(/BETWEEN (\d+) AND (\d+)/) as RegExpMatchArray
    const swapsOnly = sql.includes("get_field(priced, 'source') = 'swap'")
    const notBought = sql.match(/bought_token <> X'(\w+)'/)?.[1]
    const size = sql.match(/TRY_CAST\(get_field\(priced, 'usd_micros'\) AS DOUBLE\) \* TRY_CAST\(CASE WHEN sold_token = X'(\w+)' THEN sold_amount ELSE bought_amount END AS DOUBLE\) >= (\d+) \* (1e\d+)/)
    const limit = Number((sql.match(/LIMIT (\d+)/) as RegExpMatchArray)[1])
    return rows
      .filter((row) => row.block_num >= Number(from) && row.block_num <= Number(to))
      .filter((row) => !swapsOnly || row.priced.source === "swap")
      .filter((row) => row.bought_token !== notBought)
      .filter((row) => !size || Number(row.priced.usd_micros) * Number(row.sold_token === size[1] ? row.sold_amount : row.bought_amount) >= Number(size[2]) * Number(size[3]))
      .sort((a, b) => b.block_num - a.block_num)
      .slice(0, limit) as T[]
  }
}

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
    const { rows } = await resolvingSource(query, config).readWindow(`0x${ME}`, 1, 10)
    assert.deepEqual(rows.map((r) => r.counterparty), [`0x${SENDER}`, `0x${SENDER}`])
    const raw = queries.filter((q) => q.includes('"base"'))
    assert.equal(raw.length, 2)
    assert.ok(raw.every((q) => q.includes("block_num BETWEEN 5 AND 5")), "only that block")
  })

  it("doesn't touch the raw tables for a wallet with nothing to look up", async () => {
    const queries: string[] = []
    const query = async <T>(sql: string) => (queries.push(sql), [] as T[])
    await resolvingSource(query, config).readWindow(`0x${ME}`, 1, 10)
    assert.ok(!queries.some((q) => q.includes('"base"')))
  })

  it("only trusts priced_legs from a dataset that has the fix for its wrong rows", async () => {
    const answer = (error: unknown) => resolvingSource(async () => Promise.reject(error), config)
    assert.equal(await answer(new Error("Error during planning: table 'amp.benface/pricetag_scratch@0.0.4.unlisted_moves' not found")).marketReady!(), false)
    assert.equal(await answer(notStarted).marketReady!(), true, "it has the table, and hasn't written to it yet")
    await assert.rejects(answer(new Error("connection refused")).marketReady!(), "an outage says nothing about the dataset")
    assert.equal(await resolvingSource(async <T>() => [] as T[], config).marketReady!(), true)
  })

  it("reads an asset's trades in a range, newest first, keeping only plausible prices", async () => {
    const queries: string[] = []
    const row = (usd_micros: string) => ({ block_num: 9, tx_hash: "aa", sold_token: "833589fcd6edb6e08f4c7c32d4f71b54bda02913", sold_amount: "500000000", bought_token: "940181a94a35a4569e4529a3cdfb74e38fd98631", bought_amount: "400000000000000000000", priced: { token: "AERO", usd_micros, source: "swap" }, eth_usd: "240000000000" })
    const query = async <T>(sql: string) => (queries.push(sql), [row("1250000"), row("6600000000000")] as T[])
    const trades = await resolvingSource(query, config).readMarketTrades!("AERO", 100, 200)
    assert.deepEqual(trades, [{ blockNum: 9, txHash: "0xaa", asset: "AERO", usdMicros: "1250000", notionalUsdMicros: "500000000" }])
    assert.match(queries[0]!, /block_num BETWEEN 100 AND 200/)
    assert.match(queries[0]!, /get_field\(priced, 'token'\) = 'AERO'/)
    assert.match(queries[0]!, /ORDER BY block_num DESC LIMIT \d+/)
  })

  it("only asks about a token with a market price", async () => {
    const queries: string[] = []
    const source = resolvingSource(async <T>(sql: string) => (queries.push(sql), [] as T[]), config)
    assert.deepEqual(await source.readMarketTrades!("AERO'; DROP", 100, 200), [])
    assert.deepEqual(await source.readMarketTrades!("USDC", 100, 200), [])
    assert.deepEqual(queries, [])
  })

  it("finds real trades behind more small ones than the limit holds", async () => {
    const swap = (block_num: number, tx: string, usdc: bigint) => ({ block_num, tx_hash: tx, sold_token: "833589fcd6edb6e08f4c7c32d4f71b54bda02913", sold_amount: (usdc * 10n ** 6n).toString(), bought_token: "940181a94a35a4569e4529a3cdfb74e38fd98631", bought_amount: (usdc * 10n ** 18n).toString(), priced: { token: "AERO", usd_micros: "1000000", source: "swap" }, eth_usd: "240000000000" })
    const real = [swap(100, "a1", 500n), swap(101, "a2", 500n), swap(102, "a3", 500n)]
    const small = Array.from({ length: 600 }, (_, i) => swap(103 + i, `b${i}`, 5n))
    const usable = await resolvingSource(answersLikeAmp([...real, ...small]), config).readMarketTrades!("AERO", 100, 702)
    assert.equal(marketPrice(usable, "AERO", 702)?.usdMicros, "1000000")
  })

  it("leaves out what can't set a price before the limit, so it can't hide what can", async () => {
    const row = (block_num: number, bought_token: string, source = "swap", usd_micros = "1000000") => ({ block_num, tx_hash: `t${block_num}`, sold_token: "940181a94a35a4569e4529a3cdfb74e38fd98631", sold_amount: (500n * 10n ** 18n).toString(), bought_token, bought_amount: "1", priced: { token: "AERO", usd_micros, source }, eth_usd: "240000000000" })
    const usdc = "833589fcd6edb6e08f4c7c32d4f71b54bda02913"
    const rows = [row(10, usdc), ...Array.from({ length: 400 }, (_, i) => row(11 + i, ETH_ADDRESS.slice(2))), ...Array.from({ length: 400 }, (_, i) => row(500 + i, usdc, "unknown", ""))]
    const usable = await resolvingSource(answersLikeAmp(rows), config).readMarketTrades!("AERO", 1, 1_000)
    assert.deepEqual(usable.map((t) => t.blockNum), [10])
  })

  it("keeps a trade right at the guard's size, for the guard to judge", async () => {
    const at = (block_num: number, usdMicros: bigint) => ({ block_num, tx_hash: `t${block_num}`, sold_token: "833589fcd6edb6e08f4c7c32d4f71b54bda02913", sold_amount: usdMicros.toString(), bought_token: "940181a94a35a4569e4529a3cdfb74e38fd98631", bought_amount: (usdMicros * 10n ** 12n).toString(), priced: { token: "AERO", usd_micros: "1000000", source: "swap" }, eth_usd: "240000000000" })
    const usable = await resolvingSource(answersLikeAmp([at(9, 98_000_000n), at(10, 100_000_000n)]), config).readMarketTrades!("AERO", 1, 1_000)
    assert.deepEqual(usable.map((t) => t.blockNum), [10])
  })

  it("reads only this wallet's own notes, from zero-value transactions to itself", async () => {
    const queries: string[] = []
    const hash = `0x${"ab".repeat(32)}`
    const query = async <T>(sql: string) => (queries.push(sql), [{ block_num: 5, tx_hash: "cc", input: encodeNote(hash, "USDC", "5").slice(2) }, { block_num: 5, tx_hash: "dd", input: "abcd" }] as T[])
    const notes = await resolvingSource(query, config).readNotes!(`0x${ME}`, [5])
    assert.deepEqual(notes, [{ txHash: hash, asset: "USDC", usdMicros: "5", noteTx: "0xcc", blockNum: 5 }])
    assert.match(queries[0]!, new RegExp(`"from" = X'${ME}' AND "to" = X'${ME}' AND status AND value = '0'`))
  })
})

/** The first block whose settled part reaches `tip`. */
const settledBackTo = (tip: number) => {
  let block = tip
  while (settledThrough(block) < tip) block += 1
  return block
}

describe("reading a wallet by two pricing rules", () => {
  const config = { baseDataset: "base", dataset: "ds", startBlock: 1, network: "base_mainnet" }
  const ME = "00000000000000000000000000000000000000cc"
  const SENDER = "00000000000000000000000000000000000000dd"
  const USDC = "833589fcd6edb6e08f4c7c32d4f71b54bda02913"
  const NOTE_TX = `0x${"ab".repeat(32)}`
  const inRange = (sql: string, block: number) => {
    const [, from, to] = /block_num BETWEEN (\d+) AND (\d+)/.exec(sql)!
    return block >= Number(from) && block <= Number(to) && (!sql.includes("block_num IN") || new RegExp(`block_num IN \\([^)]*\\b${block}\\b`).test(sql))
  }

  /** A chain where a wallet received a token in each of these blocks, with every query kept. */
  function chain(blocks: readonly number[], amountAt: (block: number) => string = () => "7") {
    const queries: string[] = []
    const query = async <T>(sql: string) => {
      queries.push(sql)
      const leg = (block: number) => ({ block_num: block, timestamp: 1, tx_hash: `aa${block}`, tx_index: 1, log_index: 3, token: USDC, account: ME, side: "credit", amount: amountAt(block), kind: "erc20" })
      if (sql.includes(".legs")) return blocks.filter((block) => inRange(sql, block)).map(leg) as T[]
      if (sql.includes('"base".logs')) return blocks.filter((block) => inRange(sql, block)).map((block) => ({ tx_hash: `aa${block}`, log_index: 3, topic1: SENDER.padStart(64, "0"), topic2: ME.padStart(64, "0") })) as T[]
      return [] as T[]
    }
    const reads = (table: string) => queries.filter((sql) => sql.includes(table))
    return { query, queries, reads }
  }

  it("reads what the rule doesn't change once, and each rule's own prices", async () => {
    const { query, reads } = chain([5, 150])
    const shared = sharedReads(query, config)
    const market = resolvingSource(query, { ...config, priceDataset: "market" }, shared)
    const cautious = resolvingSource(query, { ...config, priceDataset: "cautious" }, shared)
    const first = await market.readWindow(`0x${ME}`, 1, 200)
    const second = await cautious.readWindow(`0x${ME}`, 1, 200)
    assert.deepEqual(second.rows, first.rows)
    assert.deepEqual(first.rows.map((r) => r.counterparty), [`0x${SENDER}`, `0x${SENDER}`])
    assert.equal(reads('"market".priced_legs').length, 1)
    assert.equal(reads('"cautious".priced_legs').length, 1)
    assert.equal(reads('"ds".legs').filter((sql) => sql.includes("BETWEEN 1 AND 200")).length, 1, "the whole range once")
    assert.equal(reads('"base".logs').filter((sql) => inRange(sql, 5)).length, 1, "a block no reorg can reach has one lookup")
    assert.equal(reads('"base".logs').filter((sql) => inRange(sql, 150)).length, 1)
  })

  it("re-reads only what a reorg could reach, up to the blocks that are new", async () => {
    const { query, queries, reads } = chain([5, 190, 205])
    const shared = sharedReads(query, config)
    await shared.readLegs(`0x${ME}`, 1, 200)
    queries.length = 0
    const { rows } = await shared.readLegs(`0x${ME}`, 1, 210)
    assert.deepEqual(rows.map((r) => r.block_num).sort((a, b) => a - b), [5, 190, 205])
    assert.equal(reads('"ds".legs').length, 1)
    assert.ok(reads('"ds".legs')[0]!.includes(`BETWEEN ${settledThrough(200) + 1} AND 210`))
    assert.ok(!reads('"base".logs').some((sql) => inRange(sql, 5)), "an old block's lookup isn't repeated")
  })

  it("a reorg in the blocks it re-reads replaces what's held, and older blocks stay", async () => {
    let amount = "7"
    const { query } = chain([5, 190], () => amount)
    const shared = sharedReads(query, config)
    await shared.readLegs(`0x${ME}`, 1, 200)
    amount = "9"
    const { rows } = await shared.readLegs(`0x${ME}`, 1, 200)
    assert.deepEqual(rows.map((r) => [r.block_num, r.amount]).sort(), [[190, "9"], [5, "7"]])
  })

  it("a rule that's behind gets only what it asked for, and what's past that isn't lost", async () => {
    const { query } = chain([5, 150, 190])
    const shared = sharedReads(query, config)
    await shared.readLegs(`0x${ME}`, 1, 200)
    assert.deepEqual((await shared.readLegs(`0x${ME}`, 1, 160)).rows.map((r) => r.block_num).sort((a, b) => a - b), [5, 150])
    assert.deepEqual((await shared.readLegs(`0x${ME}`, 100, 195)).rows.map((r) => r.block_num).sort((a, b) => a - b), [150, 190])
    assert.deepEqual((await shared.readLegs(`0x${ME}`, 1, 200)).rows.map((r) => r.block_num).sort((a, b) => a - b), [5, 150, 190])
  })

  it("keeps a gas row it can't work out to its range, like the rows", async () => {
    const query = async <T>(sql: string) => (sql.includes(".legs") ? [{ block_num: 5, timestamp: 1, tx_hash: "ee", tx_index: 1, log_index: 0, token: USDC, account: ME, side: "debit", amount: "", kind: "gas" }].filter((r) => inRange(sql, r.block_num)) : []) as T[]
    const shared = sharedReads(query, config)
    assert.deepEqual((await shared.readLegs(`0x${ME}`, 1, 200)).gasUnknown, [{ tx_hash: "0xee", block_num: 5 }])
    assert.deepEqual((await shared.readLegs(`0x${ME}`, 6, 200)).gasUnknown, [])
  })

  it("a range that doesn't touch what's held is read in full", async () => {
    const { query, queries } = chain([5, 500])
    const shared = sharedReads(query, config)
    await shared.readLegs(`0x${ME}`, 100, 200)
    queries.length = 0
    assert.deepEqual((await shared.readLegs(`0x${ME}`, 1, 200)).rows.map((r) => r.block_num), [5])
    assert.ok(queries[0]!.includes("BETWEEN 1 AND 200"))
    queries.length = 0
    assert.deepEqual((await shared.readLegs(`0x${ME}`, 400, 600)).rows.map((r) => r.block_num), [500])
    assert.ok(queries[0]!.includes("BETWEEN 400 AND 600"))
  })

  it("a failed read keeps nothing, so the next one reads it all", async () => {
    let down = true
    const { query } = chain([5])
    const flaky = async <T>(sql: string) => {
      if (down) throw new Error("connection refused")
      return query<T>(sql)
    }
    const shared = sharedReads(flaky, config)
    await assert.rejects(shared.readLegs(`0x${ME}`, 1, 200), /connection refused/)
    down = false
    assert.deepEqual((await shared.readLegs(`0x${ME}`, 1, 200)).rows.map((r) => r.block_num), [5])
  })

  it("two rules asking at once share one read", async () => {
    const { query, reads } = chain([5])
    const shared = sharedReads(query, config)
    const [a, b] = await Promise.all([shared.readLegs(`0x${ME}`, 1, 200), shared.readLegs(`0x${ME}`, 1, 200)])
    assert.deepEqual(a.rows, b.rows)
    assert.equal(reads('"ds".legs').filter((sql) => sql.includes("BETWEEN 1 AND 200")).length, 1)
  })

  it("keeps notes for blocks past any reorg, including that a block has none, and reads newer ones again", async () => {
    const { query, queries } = chain([])
    const withNote = async <T>(sql: string) => {
      if (!sql.includes(".transactions")) return query<T>(sql)
      queries.push(sql)
      return (inRange(sql, 5) ? [{ block_num: 5, tx_hash: "cc", input: encodeNote(NOTE_TX, "USDC", "5").slice(2) }] : []) as T[]
    }
    const shared = sharedReads(withNote, config)
    await shared.readLegs(`0x${ME}`, 1, 200)
    const blocks = [5, 6, 199]
    assert.deepEqual((await shared.readNotes(`0x${ME}`, blocks)).map((note) => note.blockNum), [5])
    queries.length = 0
    assert.deepEqual((await shared.readNotes(`0x${ME}`, blocks)).map((note) => note.noteTx), ["0xcc"])
    assert.equal(queries.length, 1)
    assert.match(queries[0]!, /BETWEEN 199 AND 199/)
  })

  it("keeps ETH balances for blocks past any reorg, and tries again for one whose read failed", async () => {
    const { query, queries } = chain([])
    const balance = `${"00".repeat(31)}05`
    const failing = new Set([6])
    const withBalances = async <T>(sql: string) => {
      if (!sql.includes("eth_call")) return query<T>(sql)
      queries.push(sql)
      return [5, 6, 199].filter((block) => inRange(sql, block)).map((block) => ({ block_num: block, r: { data: failing.has(block) ? "" : balance } })) as T[]
    }
    const shared = sharedReads(withBalances, config)
    await shared.readLegs(`0x${ME}`, 1, 200)
    const first = await shared.readEthBalances(`0x${ME}`, [5, 6, 199])
    assert.deepEqual([...first.keys()].sort((a, b) => a - b), [5, 199])
    failing.clear()
    queries.length = 0
    const second = await shared.readEthBalances(`0x${ME}`, [5, 6, 199])
    assert.deepEqual([...second.keys()].sort((a, b) => a - b), [5, 6, 199])
    assert.equal(second.get(5), first.get(5))
    assert.equal(queries.length, 1)
    assert.ok(!inRange(queries[0]!, 5), "a block already known isn't read again")
    assert.ok(inRange(queries[0]!, 6) && inRange(queries[0]!, 199), "the failed one and one a reorg could reach are")
  })

  it("reads an L1 fee once it can't change, and otherwise every time", async () => {
    const asked: string[][] = []
    const read: ReadL1Fees = async (requests) => (asked.push(requests.map((r) => r.txHash)), new Map(requests.map((r) => [r.txHash, `fee-${r.blockNum}`])))
    const fees = settledL1Fees(read, () => 100)
    const settled = { txHash: "0xold", blockNum: settledThrough(100) }
    const recent = { txHash: "0xnew", blockNum: settledThrough(100) + 1 }
    assert.deepEqual([...(await fees([settled, recent]))].sort(), [["0xnew", `fee-${recent.blockNum}`], ["0xold", `fee-${settled.blockNum}`]])
    assert.deepEqual([...(await fees([settled, recent]))].sort(), [["0xnew", `fee-${recent.blockNum}`], ["0xold", `fee-${settled.blockNum}`]])
    assert.deepEqual(asked, [["0xold", "0xnew"], ["0xnew"]])
    await fees([{ txHash: "0xold", blockNum: 60 }])
    assert.deepEqual(asked.at(-1), ["0xold"], "a transaction that moved to another block is read again")
  })

  it("a failed L1 fee read isn't kept, and a second rule goes on from where the first's limit stopped", async () => {
    const asked: string[][] = []
    const read: ReadL1Fees = async (requests) => {
      asked.push(requests.map((r) => r.txHash))
      return new Map(requests.slice(0, 1).map((r) => [r.txHash, "1"]))
    }
    const fees = settledL1Fees(read, () => 100)
    const requests = [{ txHash: "0xa", blockNum: 1 }, { txHash: "0xb", blockNum: 2 }]
    assert.deepEqual([...(await fees(requests)).keys()], ["0xa"])
    assert.deepEqual([...(await fees(requests)).keys()].sort(), ["0xa", "0xb"])
    assert.deepEqual(asked, [["0xa", "0xb"], ["0xb"]])
  })

  it("only keeps an L1 fee that was already past any reorg when its read started", async () => {
    let head = 1000
    let fee = "24"
    let reads = 0
    const read: ReadL1Fees = async (requests) => {
      reads += 1
      const found = new Map(requests.map(({ txHash }) => [txHash, fee]))
      // A reorg changes the fee and the head moves on, both while this read is still running.
      if (reads === 1) [fee, head] = ["34", 1025]
      return found
    }
    const reference = (blockNum: number) => ({ blockNum, ethUsd: "240000000000", usdcUsd: "100000000" })
    const gas = { block_num: 995, timestamp: "2026-11-04T00:00:00.000Z", tx_hash: "0xabc", tx_index: 1, log_index: 0, token: ETH_ADDRESS, account: `0x${ME}`, side: "debit" as const, amount: "1000", kind: "gas" as const }
    const source: Source = {
      mode: "raw",
      startBlock: 900,
      historyFrom: null,
      head: async () => null,
      processedThrough: async (_, to) => to,
      readWindow: async (_, from, to) => ({ rows: [gas].filter((row) => row.block_num >= from && row.block_num <= to), priced: null, gasUnknown: [] }),
      readReferences: async (blocks) => blocks.map(reference),
      readLatestReference: async (to) => reference(to),
      readBalances: async (_, blockNum) => ({ blockNum, amounts: {} }),
      readEthBalances: async () => new Map(),
    }
    const wallets = createWallets(source, async () => ({ blockNum: head, timestamp: "2026-11-04T00:00:00.000Z" }), settledL1Fees(read, () => head))
    const paid = async () => (await wallets.get(`0x${ME}`)).legs.find((leg) => leg.kind === "gas")?.delta
    assert.equal(await paid(), "-1024")
    assert.equal(await paid(), "-1034", "the read once its block has settled is a real one")
    assert.equal(reads, 2)
    head = 1040
    assert.equal(await paid(), "-1034")
    assert.equal(reads, 2, "and that one's kept")
  })

  it("a head that moves on during a note or ETH balance read doesn't make its answer final", async () => {
    const note = `${encodeNote(NOTE_TX, "USDC", "5").slice(2)}`
    const balance = `${"00".repeat(31)}05`
    let to = 200
    const { query, queries } = chain([])
    let release = () => {}
    let held = false
    const reading = async <T>(sql: string) => {
      if (!sql.includes(".transactions") && !sql.includes("eth_call")) return query<T>(sql)
      queries.push(sql)
      if (held) await new Promise<void>((resolve) => (release = resolve))
      return (sql.includes("eth_call") ? [{ block_num: to - 5, r: { data: balance } }] : [{ block_num: to - 5, tx_hash: "cc", input: note }]) as T[]
    }
    const shared = sharedReads(reading, config)
    for (const reader of [shared.readNotes, shared.readEthBalances]) {
      to += 100
      await shared.readLegs(`0x${ME}`, 1, to)
      const block = to - 5
      const read = () => reader(`0x${ME}`, [block])
      held = true
      const first = read()
      const later = shared.readLegs(`0x${ME}`, 1, to + 100)
      await new Promise((resolve) => setImmediate(resolve))
      held = false
      release()
      await Promise.all([first, later])
      const answers = async () => {
        queries.length = 0
        await read()
        return queries.filter((sql) => sql.includes(".transactions") || sql.includes("eth_call")).length
      }
      assert.equal(await answers(), 1, "it wasn't past any reorg when that read started, so it's read again")
      assert.equal(await answers(), 0, "and that one's kept")
    }
  })

  describe("a reorg further back than what's re-read anyway", () => {
    const blocksOf = (rows: readonly { block_num: number }[]) => rows.map((r) => r.block_num).sort((a, b) => a - b)
    const amounts = (rows: readonly { block_num: number; amount: string }[]) => Object.fromEntries(rows.map((r) => [r.block_num, r.amount]))

    it("replaces what it changed, and keeps what's before it", async () => {
      let amount = "7"
      const { query } = chain([5, 100, 190], () => amount)
      const shared = sharedReads(query, config)
      await shared.readLegs(`0x${ME}`, 1, 200)
      amount = "9"
      await shared.rewind(90, 200)
      assert.deepEqual(amounts((await shared.readLegs(`0x${ME}`, 1, 200)).rows), { 5: "7", 100: "9", 190: "9" })
    })

    it("goes back to it on every read until the tables are past it, then stops", async () => {
      const { query, reads } = chain([100])
      const shared = sharedReads(query, config)
      await shared.readLegs(`0x${ME}`, 1, 200)
      await shared.rewind(90, 200)
      await shared.readLegs(`0x${ME}`, 1, 195)
      await shared.readLegs(`0x${ME}`, 1, 210)
      assert.match(reads('"ds".legs').at(-1)!, /BETWEEN 90 AND 210/, "210 isn't far enough past where the old chain reached")
      await shared.readLegs(`0x${ME}`, 1, settledBackTo(200))
      assert.match(reads('"ds".legs').at(-1)!, new RegExp(`BETWEEN 90 AND ${settledBackTo(200)}`), "the read that gets there still goes back")
      await shared.readLegs(`0x${ME}`, 1, settledBackTo(200) + 1)
      assert.match(reads('"ds".legs').at(-1)!, new RegExp(`BETWEEN ${settledThrough(settledBackTo(200)) + 1} AND ${settledBackTo(200) + 1}`))
    })

    it("starts over when it reaches the first block held", async () => {
      const { query } = chain([5, 150])
      const shared = sharedReads(query, config)
      await shared.readLegs(`0x${ME}`, 100, 200)
      await shared.rewind(100, 200)
      assert.deepEqual(blocksOf((await shared.readLegs(`0x${ME}`, 1, 200)).rows), [5, 150])
    })

    it("drops what a read that was already running found", async () => {
      let amount = "7"
      const { query } = chain([100], () => amount)
      let release = () => {}
      let holding = false
      const gated = async <T>(sql: string) => {
        if (holding && sql.includes(".unlisted_legs")) await new Promise<void>((resolve) => (release = resolve))
        return query<T>(sql)
      }
      const shared = sharedReads(gated, config)
      await shared.readLegs(`0x${ME}`, 1, 150)
      amount = "8"
      holding = true
      const running = shared.readLegs(`0x${ME}`, 1, 200)
      await new Promise((resolve) => setImmediate(resolve))
      const rewinding = shared.rewind(90, 200)
      amount = "9"
      holding = false
      release()
      await Promise.all([running, rewinding])
      assert.deepEqual(amounts((await shared.readLegs(`0x${ME}`, 1, 200)).rows), { 100: "9" })
    })

    it("reads notes and ETH balances again, and only keeps them once the tables are past it", async () => {
      const balance = `${"00".repeat(31)}05`
      const { query, queries } = chain([])
      const answering = async <T>(sql: string) => {
        if (!sql.includes(".transactions") && !sql.includes("eth_call")) return query<T>(sql)
        queries.push(sql)
        return (sql.includes("eth_call") ? [{ block_num: 100, r: { data: balance } }] : []) as T[]
      }
      const shared = sharedReads(answering, config)
      const reads = () => queries.filter((sql) => sql.includes(".transactions") || sql.includes("eth_call")).length
      const both = async () => {
        queries.length = 0
        await shared.readNotes(`0x${ME}`, [100])
        await shared.readEthBalances(`0x${ME}`, [100])
        return reads()
      }
      await shared.readLegs(`0x${ME}`, 1, 200)
      assert.equal(await both(), 2)
      assert.equal(await both(), 0, "held")
      await shared.rewind(90, 200)
      await shared.readLegs(`0x${ME}`, 1, 210)
      assert.equal(await both(), 2, "forgotten")
      assert.equal(await both(), 2, "the tables may not have rewritten it yet")
      await shared.readLegs(`0x${ME}`, 1, settledBackTo(200))
      assert.equal(await both(), 2)
      assert.equal(await both(), 0, "held again")
    })

    it("forgets L1 fees from then on, keeps older ones, and keeps none it can't be sure of", async () => {
      let head = 200
      const asked: string[][] = []
      const read: ReadL1Fees = async (requests) => (asked.push(requests.map((r) => r.txHash)), new Map(requests.map((r) => [r.txHash, "1"])))
      const fees = settledL1Fees(read, () => head)
      const [old, replaced] = [{ txHash: "0xold", blockNum: 50 }, { txHash: "0xnew", blockNum: 100 }]
      await fees([old, replaced])
      fees.rewind(90, 200)
      await fees([old, replaced])
      assert.deepEqual(asked.at(-1), ["0xnew"], "only what the reorg reached")
      asked.length = 0
      await fees([old, replaced])
      assert.deepEqual(asked, [["0xnew"]], "read after the reorg, but before the tables got past it")
      head = settledBackTo(200)
      await fees([old, replaced])
      asked.length = 0
      await fees([old, replaced])
      assert.deepEqual(asked, [], "past it now")
    })

    it("doesn't keep an L1 fee whose read crossed it", async () => {
      let release = () => {}
      let reads = 0
      const read: ReadL1Fees = async (requests) => {
        reads += 1
        await new Promise<void>((resolve) => (release = resolve))
        return new Map(requests.map((r) => [r.txHash, "24"]))
      }
      const fees = settledL1Fees(read, () => 1000)
      const running = fees([{ txHash: "0xa", blockNum: 100 }])
      await new Promise((resolve) => setImmediate(resolve))
      fees.rewind(900, 1000)
      release()
      assert.equal((await running).get("0xa"), "24")
      const again = fees([{ txHash: "0xa", blockNum: 100 }])
      await new Promise((resolve) => setImmediate(resolve))
      release()
      await again
      assert.equal(reads, 2)
    })

    it("reaches them all from the server, so a wallet read after it has the new chain", { timeout: 30_000 }, async (t) => {
      const GAS = { block_num: 100, timestamp: 1_800_000_000_000, tx_hash: "ab", tx_index: 1, log_index: 0, token: ETH_ADDRESS.slice(2), account: ME, side: "debit", amount: "1000", kind: "gas" }
      let state = { amount: "1000", fee: 24 }
      const rpc = createServer((req, res) => {
        let body = ""
        req.on("data", (chunk) => (body += chunk))
        req.on("end", () => {
          const calls = JSON.parse(body) as { id: number }[]
          res.setHeader("content-type", "application/json")
          res.end(JSON.stringify(calls.map(({ id }) => ({ id, result: { blockNumber: "0x64", l1Fee: `0x${state.fee.toString(16)}` } }))))
        })
      })
      await new Promise<void>((resolve) => rpc.listen(0, "127.0.0.1", resolve))
      const query = async <T>(sql: string) => {
        if (/ORDER BY block_num DESC LIMIT 1/.test(sql)) return [{ block_num: 200, timestamp: 1_800_000_000_000, hash: "00" }] as T[]
        if (sql.includes(".legs")) return (inRange(sql, 100) ? [{ ...GAS, amount: state.amount }] : []) as T[]
        return [] as T[]
      }
      const cfg = { baseDataset: "base", dataset: "ds", startBlock: 50, network: "base_mainnet" }
      const shared = sharedReads(query, cfg)
      const hand = { send: (_: StreamRange) => {} }
      const queued: StreamRange[] = []
      const stream: StreamRanges = async function* (_sql, _resume, signal) {
        while (!signal.aborted) {
          const next = queued.shift()
          if (next) yield next
          else await new Promise<void>((resolve) => {
            hand.send = (range) => {
              queued.push(range)
              resolve()
            }
            signal.addEventListener("abort", () => resolve())
          })
        }
      }
      const api = createApi({ BASE_RPC_URL: `http://127.0.0.1:${(rpc.address() as { port: number }).port}` }, {
        source: resolvingSource(query, cfg, shared),
        readRates: async () => ({ byBlock: {}, latest: null }),
        proofs: { datasets: async () => [], priceBehind: async () => null, readBlock: async () => null },
        follow: { stream, sql: "SELECT 1", readMark: async () => ({ blockNum: 200, hash: "0x200" }), logger: { warn() {} }, pollMs: 1, tickMs: 0 },
        shared,
      })
      const server = createServer((req, res) => void api(req, res))
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      const paid = async () => ((await (await fetch(`${base}/api/wallet/0x${ME}`)).json()) as WalletResponse).legs.find((leg) => leg.kind === "gas")?.delta
      try {
        assert.equal(await paid(), "-1024")
        const events = (await fetch(`${base}/api/events`, { signal: t.signal })).body!.getReader()
        await new Promise((resolve) => setTimeout(resolve, 20))
        state = { amount: "2000", fee: 34 }
        hand.send({ start: 100, end: 200, hash: "0xnew", complete: true })
        for (let seen = ""; !seen.includes("event: head"); ) seen += new TextDecoder().decode((await events.read()).value)
        assert.equal(await paid(), "-2034")
      } finally {
        server.closeAllConnections()
        server.close()
        rpc.close()
      }
    })
  })

  it("both rules' wallets end up with the same rows, from one read of the history", async () => {
    const { query, reads } = chain([5, 150])
    const head = { blockNum: 200, timestamp: "2026-11-04T00:00:00.000Z" }
    const withHead = async <T>(sql: string) => (sql.includes("eth_call") || /ORDER BY block_num DESC LIMIT 1/.test(sql) ? ([{ block_num: 200 }] as T[]) : query<T>(sql))
    const shared = sharedReads(withHead, config)
    const quiet = { log() {}, warn() {}, error() {} }
    const [a, b] = ["market", "cautious"].map((priceDataset) => createWallets(resolvingSource(withHead, { ...config, priceDataset }, shared), async () => head, async () => new Map(), quiet))
    const [wa, wb] = [await a!.get(`0x${ME}`), await b!.get(`0x${ME}`)]
    assert.deepEqual(wb.legs.map((leg) => [leg.txHash, leg.blockNum]), wa.legs.map((leg) => [leg.txHash, leg.blockNum]))
    assert.ok(wa.legs.length >= 2)
    assert.equal(reads('"ds".legs').filter((sql) => sql.includes("BETWEEN 1 AND 200")).length, 1)
    assert.equal(reads('"base".logs').filter((sql) => inRange(sql, 5)).length, 1)
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
    assert.deepEqual(window.gasUnknown, [{ tx_hash: "0xaa", block_num: 5 }])
  })
})
