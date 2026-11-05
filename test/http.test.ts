import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, request, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"
import { createApi } from "../server/app.ts"
import { createHandler } from "../server/http.ts"
import { REORG_BLOCKS, createWallets, datasetSource, describeError, isNotStarted, type ReadL1Fees } from "@pricetag/sdk/internal"
import { resolvingSource, settledL1Fees, sharedReads } from "../server/source.ts"
import { encodeNote } from "@pricetag/sdk/core"

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
    const trades = await resolvingSource(query, config).readMarketTrades!("AERO'; DROP", 100, 200)
    assert.deepEqual(trades, [{ blockNum: 9, txHash: "0xaa", asset: "AERO", usdMicros: "1250000", notionalUsdMicros: "500000000" }])
    assert.match(queries[0]!, /block_num BETWEEN 100 AND 200/)
    assert.match(queries[0]!, /get_field\(priced, 'token'\) = 'AERODROP'/)
    assert.match(queries[0]!, /ORDER BY block_num DESC LIMIT \d+/)
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
    assert.ok(reads('"ds".legs')[0]!.includes(`BETWEEN ${200 - REORG_BLOCKS + 1} AND 210`))
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
    const settled = { txHash: "0xold", blockNum: 100 - REORG_BLOCKS }
    const recent = { txHash: "0xnew", blockNum: 100 - REORG_BLOCKS + 1 }
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
