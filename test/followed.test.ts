import assert from "node:assert/strict"
import { createServer as createHttp2Server } from "node:http2"
import type { AddressInfo } from "node:net"
import { after, before, describe, it } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"
import { tableFromArrays, tableToIPC } from "apache-arrow"
import { FollowedTable, createRowStream, createWallets, followedWallets, followedWindowSql, type BlockMark, type FollowedConfig, type Query, type StreamBatch } from "@pricetag/sdk/internal"
import { resolvingSource, sharedReads } from "../server/source.ts"
import { fakeAmp } from "./support/fake-amp.ts"

const ME = "0x00000000000000000000000000000000000000aa"
const HEAD = 60_000_000
const batch = (start: number, end: number, rows: unknown[] = [], { complete = true, hash = `0x${end}` }: { complete?: boolean; hash?: string } = {}): StreamBatch => ({ start, end, hash, complete, rows: rows as StreamBatch["rows"] })
const row = (block: number, tag = "a") => ({ block_num: block, tag })

describe("one table's rows from a stream", () => {
  const fresh = () => new FollowedTable({ blockNum: 100, hash: "0x100" })

  it("has nothing past what it was told is complete", () => {
    const table = fresh()
    table.apply(batch(101, 102, [row(101)], { complete: false }))
    assert.equal(table.read(101, 102), null, "that block could have more rows")
    table.apply(batch(101, 102, [row(102)]))
    assert.deepEqual(table.read(101, 102), [row(101), row(102)])
    assert.equal(table.read(101, 103), null)
  })

  it("has nothing from before it started", () => {
    assert.equal(fresh().read(100, 100), null)
  })

  it("only gives what's in the range asked", () => {
    const table = fresh()
    table.apply(batch(101, 103, [row(101), row(102), row(103)]))
    assert.deepEqual(table.read(102, 102), [row(102)])
  })

  it("adds nothing when the last block's said again", () => {
    const table = fresh()
    table.apply(batch(101, 101, [row(101)]))
    table.apply(batch(101, 101, [row(101)]))
    assert.deepEqual(table.read(101, 101), [row(101)])
  })

  it("replaces what a reorg replaced, and nothing before it", () => {
    const table = fresh()
    table.apply(batch(101, 103, [row(101), row(102, "old"), row(103, "old")]))
    table.apply(batch(102, 104, [row(102, "new"), row(104, "new")], { hash: "0xnew" }))
    assert.deepEqual(table.read(101, 104), [row(101), row(102, "new"), row(104, "new")])
  })

  it("doesn't claim a shorter chain's old blocks while a reorg's still arriving", () => {
    const table = fresh()
    table.apply(batch(101, 105, [row(105, "old")]))
    table.apply(batch(103, 106, [row(103, "new")], { complete: false, hash: "0xnew" }))
    assert.equal(table.through, 102)
    assert.equal(table.read(101, 103), null)
    assert.deepEqual(table.read(101, 102), [])
  })

  it("replaces a partial range when a reorg changes it", () => {
    const table = fresh()
    table.apply(batch(101, 103, [row(103, "old")], { complete: false }))
    table.apply(batch(101, 103, [row(103, "new")], { hash: "0xnew" }))
    assert.deepEqual(table.read(101, 103), [row(103, "new")])
  })

  it("won't go on when a reorg leaves part of a range it never finished", () => {
    const table = fresh()
    table.apply(batch(101, 103, [row(101)], { complete: false }))
    assert.throws(() => table.apply(batch(102, 103, [], { hash: "0xnew" })), /skipped from block 100 to 102/)
  })

  it("covers from wherever a reorg before its start went back to", () => {
    const table = fresh()
    table.apply(batch(101, 101))
    table.apply(batch(90, 102, [row(95)], { hash: "0xnew" }))
    assert.equal(table.from, 90)
    assert.deepEqual(table.read(90, 102), [row(95)])
  })

  it("won't go on past a gap, a rewind no reorg could be, or anything else it can't vouch for", () => {
    assert.throws(() => fresh().apply(batch(103, 104)), /skipped from block 100 to 103/)
    assert.throws(() => new FollowedTable({ blockNum: 5000, hash: "0x5000" }).apply(batch(1, 5001)), /went back to block 1 /)
  })

  it("forgets what's far enough behind, and then says it can't answer for it", () => {
    const table = fresh()
    const far = 100 + 100_000
    table.apply(batch(101, 101, [row(101)]))
    table.apply(batch(102, far, [row(far)]))
    assert.equal(table.read(101, far), null)
    assert.deepEqual(table.read(far, far), [row(far)])
    assert.ok(table.from > 101)
  })
})

/** A stream a test drives by hand. */
function fakeStreams(tables: readonly string[] = ["t"]) {
  const started: { sql: string; resume: BlockMark; signal: AbortSignal; send(batch: StreamBatch): void; fail(error: Error): void }[] = []
  const stream: FollowedConfig<string>["stream"] = (sql, resume, signal) =>
    (async function* () {
      const queue: StreamBatch[] = []
      let wake = () => {}
      let failure: Error | null = null
      signal.addEventListener("abort", () => wake())
      started.push({ sql, resume, signal, send: (b) => (queue.push(b), wake()), fail: (e) => ((failure = e), wake()) })
      while (true) {
        if (signal.aborted) throw signal.reason
        if (failure) throw failure
        const next = queue.shift()
        if (next) yield next
        else await new Promise<void>((resolve) => (wake = resolve))
      }
    })()
  const warned: string[] = []
  const config: FollowedConfig<string> = {
    stream,
    sql: (address) => Object.fromEntries(tables.map((table) => [table, `${table} of ${address}`])),
    readMark: async () => ({ blockNum: HEAD, hash: "0xhead" }),
    readHashes: async (blocks) => new Map(blocks.map((block) => [block, `0x${block}`])),
    logger: { warn: (message) => warned.push(message) },
    waitMs: 50,
  }
  return { started, config, warned }
}

/** What each wallet's stream resumes from, once it's going. */
async function going(started: { resume: BlockMark }[], count = 1) {
  for (let i = 0; i < 200 && started.length < count; i++) await sleep(1)
  assert.ok(started.length >= count, "it should have started")
  return started[count - 1]!.resume.blockNum
}
/** Lets a stream's batches through. */
const settle = () => sleep(5)

describe("following wallets", () => {
  it("queries on the first read, then answers once the stream covers what's asked", async () => {
    const { started, config } = fakeStreams()
    const followed = followedWallets(config)
    assert.equal(await followed.read(ME, "t", HEAD - 5, HEAD), null)
    const resume = await going(started)
    assert.ok(resume < HEAD - 300, "from before anything a read re-reads for reorgs")
    assert.equal(started[0]!.sql, `t of ${ME}`)
    started[0]!.send(batch(resume + 1, HEAD, [row(HEAD)]))
    await settle()
    assert.deepEqual(await followed.read(ME, "t", HEAD, HEAD), [row(HEAD)])
    assert.equal(await followed.read(ME, "t", resume, HEAD), null, "before where it started")
    followed.rewind()
  })

  it("waits for a stream that's nearly there", async () => {
    const { started, config } = fakeStreams()
    const followed = followedWallets({ ...config, waitMs: 500 })
    await followed.read(ME, "t", HEAD, HEAD)
    const resume = await going(started)
    started[0]!.send(batch(resume + 1, HEAD))
    await settle()
    const reading = followed.read(ME, "t", HEAD + 1, HEAD + 1)
    await sleep(10)
    started[0]!.send(batch(HEAD + 1, HEAD + 1, [row(HEAD + 1)]))
    assert.deepEqual(await reading, [row(HEAD + 1)])
    followed.rewind()
  })

  it("stops waiting, and leaves it to a query", async () => {
    const { started, config } = fakeStreams()
    const followed = followedWallets(config)
    await followed.read(ME, "t", HEAD, HEAD)
    const resume = await going(started)
    started[0]!.send(batch(resume + 1, HEAD))
    await settle()
    const startedAt = Date.now()
    assert.equal(await followed.read(ME, "t", HEAD + 1, HEAD + 1), null)
    assert.ok(Date.now() - startedAt < 500)
    followed.rewind()
  })

  it("doesn't wait at all for a stream that's far behind", async () => {
    const { started, config } = fakeStreams()
    const followed = followedWallets({ ...config, waitMs: 5000 })
    await followed.read(ME, "t", HEAD, HEAD)
    const resume = await going(started)
    started[0]!.send(batch(resume + 1, resume + 1))
    await settle()
    const startedAt = Date.now()
    assert.equal(await followed.read(ME, "t", HEAD, HEAD), null)
    assert.ok(Date.now() - startedAt < 1000)
    followed.rewind()
  })

  it("doesn't wait for a stream that hasn't moved in a while", async () => {
    const { started, config } = fakeStreams()
    const followed = followedWallets({ ...config, waitMs: 20 })
    await followed.read(ME, "t", HEAD, HEAD)
    const resume = await going(started)
    started[0]!.send(batch(resume + 1, HEAD))
    await sleep(60)
    const startedAt = Date.now()
    assert.equal(await followed.read(ME, "t", HEAD + 1, HEAD + 1), null)
    assert.ok(Date.now() - startedAt < 15)
    followed.rewind()
  })

  it("stops a wallet's streams when one's lost, queries meanwhile, and tries again", async () => {
    const { started, config, warned } = fakeStreams(["a", "b"])
    const followed = followedWallets({ ...config, retryMs: 40 })
    await followed.read(ME, "a", HEAD, HEAD)
    const resume = await going(started, 2)
    for (const stream of started) stream.send(batch(resume + 1, HEAD))
    await settle()
    assert.deepEqual(await followed.read(ME, "a", HEAD, HEAD), [])
    started[1]!.fail(new Error("gone"))
    await settle()
    assert.equal(await followed.read(ME, "a", HEAD, HEAD), null)
    assert.ok(started[0]!.signal.aborted, "the other one goes too")
    assert.match(warned.join(), /gone/)
    assert.equal(started.length, 2, "not straight away")
    await sleep(50)
    await followed.read(ME, "a", HEAD, HEAD)
    await going(started, 3)
    followed.rewind()
  })

  it("counts a stream that stops saying new blocks as lost, even if it's still sending", async () => {
    const { started, config, warned } = fakeStreams()
    const followed = followedWallets({ ...config, stallMs: 30 })
    await followed.read(ME, "t", HEAD, HEAD)
    const resume = await going(started)
    started[0]!.send(batch(resume + 1, HEAD))
    await settle()
    for (let i = 0; i < 5; i++) {
      started[0]!.send(batch(resume + 1, HEAD))
      await sleep(10)
    }
    await sleep(30)
    assert.ok(started[0]!.signal.aborted)
    assert.match(warned.join(), /No new block/)
    followed.rewind()
  })

  it("starts nothing for a read that isn't near the head, and doesn't keep asking", async () => {
    const { started, config } = fakeStreams()
    let marks = 0
    const followed = followedWallets({ ...config, readMark: async () => (marks++, { blockNum: HEAD, hash: "0xhead" }) })
    assert.equal(await followed.read(ME, "t", 5, 10), null)
    await settle()
    assert.equal(await followed.read(ME, "t", 5, 10), null)
    await settle()
    assert.equal(started.length, 0)
    assert.equal(marks, 1)
  })

  it("leaves it to a query when it can't find where to resume", async () => {
    const { started, config } = fakeStreams()
    const followed = followedWallets({ ...config, readHashes: async () => new Map() })
    assert.equal(await followed.read(ME, "t", HEAD, HEAD), null)
    await settle()
    assert.equal(await followed.read(ME, "t", HEAD, HEAD), null)
    assert.equal(started.length, 0)
  })

  it("survives failing to start", async () => {
    const { started, config, warned } = fakeStreams()
    const followed = followedWallets({ ...config, readMark: async () => Promise.reject(new Error("no head")) })
    assert.equal(await followed.read(ME, "t", HEAD, HEAD), null)
    await settle()
    assert.equal(started.length, 0)
    assert.match(warned.join(), /no head/)
  })

  it("follows only so many wallets, and the rest just query, without pushing one out", async () => {
    const { started, config } = fakeStreams()
    const followed = followedWallets({ ...config, maxWallets: 1 })
    await followed.read(ME, "t", HEAD, HEAD)
    await going(started)
    assert.equal(await followed.read("0xother", "t", HEAD, HEAD), null)
    await settle()
    assert.equal(started.length, 1)
    assert.equal(started[0]!.signal.aborted, false)
    followed.rewind()
  })

  it("stops following a wallet nobody's reading, which makes room for another", async () => {
    const { started, config } = fakeStreams()
    const followed = followedWallets({ ...config, maxWallets: 1, idleMs: 30 })
    await followed.read(ME, "t", HEAD, HEAD)
    await going(started)
    await sleep(50)
    assert.ok(started[0]!.signal.aborted)
    await followed.read("0xother", "t", HEAD, HEAD)
    await going(started, 2)
    followed.rewind()
  })

  it("keeps following a wallet that's being read", async () => {
    const { started, config } = fakeStreams()
    const followed = followedWallets({ ...config, idleMs: 40 })
    await followed.read(ME, "t", HEAD, HEAD)
    await going(started)
    for (let i = 0; i < 6; i++) {
      await sleep(15)
      await followed.read(ME, "t", HEAD, HEAD)
    }
    assert.equal(started[0]!.signal.aborted, false)
    followed.rewind()
  })

  it("trusts nothing it holds once told of a reorg, and starts over on the next read", async () => {
    const { started, config } = fakeStreams()
    const followed = followedWallets(config)
    await followed.read(ME, "t", HEAD, HEAD)
    const resume = await going(started)
    started[0]!.send(batch(resume + 1, HEAD, [row(HEAD, "old")]))
    await settle()
    assert.deepEqual(await followed.read(ME, "t", HEAD, HEAD), [row(HEAD, "old")])
    followed.rewind()
    assert.ok(started[0]!.signal.aborted)
    assert.equal(await followed.read(ME, "t", HEAD, HEAD), null)
    const again = await going(started, 2)
    started[1]!.send(batch(again + 1, HEAD, [row(HEAD, "new")]))
    await settle()
    assert.deepEqual(await followed.read(ME, "t", HEAD, HEAD), [row(HEAD, "new")])
    followed.rewind()
  })

  it("gives a read that's waiting up to a query when it's told of a reorg", async () => {
    const { started, config } = fakeStreams()
    const followed = followedWallets({ ...config, waitMs: 1000 })
    await followed.read(ME, "t", HEAD, HEAD)
    const resume = await going(started)
    started[0]!.send(batch(resume + 1, HEAD))
    await settle()
    const reading = followed.read(ME, "t", HEAD + 1, HEAD + 1)
    await sleep(5)
    followed.rewind()
    assert.equal(await reading, null)
  })
})

describe("a wallet's window, read through a stream", () => {
  const me = ME.slice(2)
  const leg = (block: number, kind = "erc20") => ({ block_num: block, timestamp: 1_700_000_000_000, tx_hash: `${block}`.padStart(64, "0"), tx_index: 0, log_index: 1, token: "aa".repeat(20), account: me, side: "credit", amount: "5", kind, counterparty: "cc".repeat(20) })
  const priced = (block: number) => ({ block_num: block, tx_hash: `${block}`.padStart(64, "0"), account: me, sold_token: "aa".repeat(20), sold_amount: "1", bought_token: "bb".repeat(20), bought_amount: "2", priced: { source: "swap" } })

  const setup = (answers: (table: string, from: number, to: number) => unknown[] | null) => {
    const queries: string[] = []
    const query = (async <T>(sql: string) => {
      queries.push(sql)
      return (sql.includes(".legs") ? [leg(5)] : sql.includes("priced_legs") ? [priced(5)] : []) as T[]
    }) as Query
    const followed = { read: async (_address: string, table: string, from: number, to: number) => answers(table, from, to) as never, rewind() {} }
    const source = resolvingSource(query, { baseDataset: "base", dataset: "ds", startBlock: 1, network: "base_mainnet", followed })
    return { queries, source }
  }

  it("asks no query for what the stream has, and comes out the same", async () => {
    const streamed = setup((table) => ({ legs: [leg(5)], unlisted_legs: [], priced_legs: [priced(5)] })[table]!)
    const queried = setup(() => null)
    const [viaStream, viaQuery] = [await streamed.source.readWindow(ME, 1, 10), await queried.source.readWindow(ME, 1, 10)]
    assert.deepEqual(streamed.queries, [])
    assert.equal(queried.queries.length, 2)
    assert.deepEqual(viaStream, viaQuery)
    assert.equal(viaStream.rows[0]?.counterparty, `0x${"cc".repeat(20)}`)
  })

  it("queries each table the stream can't answer for, on its own", async () => {
    const { queries, source } = setup((table) => (table === "priced_legs" ? null : { legs: [leg(5)], unlisted_legs: [] }[table]!))
    const { priced: rows } = await source.readWindow(ME, 1, 10)
    assert.equal(queries.length, 1)
    assert.match(queries[0]!, /priced_legs/)
    assert.equal(rows?.length, 1)
  })

  it("reads both kinds of leg together, so one can't be from before the other", async () => {
    const { queries } = (() => {
      const made = setup((table) => (table === "unlisted_legs" ? null : []))
      void made.source.readWindow(ME, 1, 10)
      return made
    })()
    await settle()
    assert.match(queries[0]!, /\.legs .*UNION ALL .*unlisted_legs/)
  })

  it("follows a leg's counterparty when the reader asks for it, which only `legs` has", () => {
    const sql = followedWindowSql(ME, "ds", { counterparties: true })
    assert.match(sql.legs, /, counterparty FROM "ds"\.legs/)
    assert.doesNotMatch(sql.unlisted_legs, /counterparty/)
    assert.doesNotMatch(followedWindowSql(ME, "ds").legs, /counterparty/)
  })

  it("tells the streams about a reorg", async () => {
    let told = 0
    const followed = { read: async () => null, rewind: () => void told++ }
    await sharedReads((async () => []) as unknown as Query, { baseDataset: "base", dataset: "ds", network: "base_mainnet", followed }).rewind(5, 10)
    assert.equal(told, 1)
  })
})

describe("a wallet's updates through a reorg, with its rows from streams", () => {
  const ETH = "0x0000000000000000000000000000000000000000"
  const leg = (block: number, tx: string) => ({ block_num: block, timestamp: 1_800_000_000_000, tx_hash: tx.padStart(64, "0"), tx_index: 0, log_index: 0, token: ETH.slice(2), account: ME.slice(2), side: "credit", amount: "5", kind: "eth" })
  const quiet = { warn() {} }
  const legsOf = (wallet: Awaited<ReturnType<ReturnType<typeof createWallets>["get"]>>) => wallet.legs.filter((l) => !l.opening).map((l) => l.txHash.slice(-3))

  async function setup() {
    const tables = { legs: [leg(HEAD - 10, "aaa")], unlisted_legs: [], priced_legs: [], reference_prices: [] }
    const through = { legs: HEAD, unlisted_legs: HEAD, priced_legs: HEAD, reference_prices: HEAD }
    const { query, queries } = fakeAmp(tables, through)
    const { started, config } = fakeStreams(["legs", "unlisted_legs", "priced_legs"])
    const followed = followedWallets(config)
    const shared = sharedReads(query, { baseDataset: "base", dataset: "ds", network: "base_mainnet", followed })
    const source = resolvingSource(query, { baseDataset: "base", dataset: "ds", startBlock: HEAD - 1000, network: "base_mainnet", followed }, shared)
    let head = HEAD
    const wallets = createWallets(source, async () => ({ blockNum: head, timestamp: "2027-01-15T08:00:00.000Z" }), async () => new Map(), quiet)
    const toBlock = (block: number) => {
      head = block
      for (const table of Object.keys(through) as (keyof typeof through)[]) through[table] = block
    }
    const sendAll = (make: (table: string, i: number) => StreamBatch) => started.slice(-3).forEach((stream, i) => stream.send(make(stream.sql.split(" ")[0]!, i)))
    return { tables, queries, started, wallets, shared, toBlock, sendAll }
  }
  const windowQueries = (queries: string[]) => queries.filter((sql) => /\.(legs|unlisted_legs) WHERE block_num BETWEEN/.test(sql)).length

  it("takes the new rows from the stream, and stays on the query's when it's told first", async () => {
    const { tables, queries, started, wallets, shared, toBlock, sendAll } = await setup()
    assert.deepEqual(legsOf(await wallets.get(ME)), ["aaa"])
    const resume = await going(started, 3)
    sendAll((table) => batch(resume + 1, HEAD, table === "legs" ? [leg(HEAD - 10, "aaa")] : []))
    await settle()

    // A new block, with its row only on the stream: what's held is what the wallet gets, and no query is asked.
    toBlock(HEAD + 1)
    sendAll((table) => batch(HEAD + 1, HEAD + 1, table === "legs" ? [leg(HEAD + 1, "bbb")] : []))
    await settle()
    let asked = windowQueries(queries)
    assert.deepEqual(legsOf(await wallets.get(ME)), ["aaa", "bbb"])
    assert.equal(windowQueries(queries), asked)

    // The stream says a reorg replaced them both.
    toBlock(HEAD + 2)
    sendAll((table) => batch(HEAD - 10, HEAD + 2, table === "legs" ? [leg(HEAD - 10, "ccc")] : [], { hash: "0xnew" }))
    await settle()
    asked = windowQueries(queries)
    assert.deepEqual(legsOf(await wallets.get(ME)), ["ccc"])
    assert.equal(windowQueries(queries), asked)

    // Told of another before any stream's said so: nothing held is used, and the query's rows are what's there.
    tables.legs = [leg(HEAD - 10, "ddd")]
    await shared.rewind(HEAD - 10, HEAD + 2)
    await wallets.rewind(HEAD - 10, HEAD + 2)
    toBlock(HEAD + 3)
    asked = windowQueries(queries)
    assert.deepEqual(legsOf(await wallets.get(ME)), ["ddd"])
    assert.ok(windowQueries(queries) > asked)
    await shared.rewind(HEAD, HEAD + 3)
  })

  it("carries on with queries when the stream dies, without losing a row", async () => {
    const { tables, queries, started, wallets, shared, toBlock, sendAll } = await setup()
    await wallets.get(ME)
    const resume = await going(started, 3)
    sendAll(() => batch(resume + 1, HEAD))
    await settle()
    started[0]!.fail(new Error("gone"))
    await settle()
    tables.legs = [leg(HEAD - 10, "aaa"), leg(HEAD + 1, "bbb")]
    toBlock(HEAD + 1)
    const asked = windowQueries(queries)
    assert.deepEqual(legsOf(await wallets.get(ME)), ["aaa", "bbb"])
    assert.ok(windowQueries(queries) > asked)
    await shared.rewind(HEAD, HEAD + 1)
  })
})

describe("rows from Amp's stream", () => {
  /** A table as the two Flight messages Amp sends for it: its schema, then its rows. */
  function flightMessages() {
    const ipc = tableToIPC(tableFromArrays({ block_num: new BigUint64Array([101n, 102n]), amount: ["5", "6"] }), "stream")
    const view = new DataView(ipc.buffer, ipc.byteOffset, ipc.byteLength)
    const schemaLength = view.getUint32(4, true)
    const schemaEnd = 8 + schemaLength
    const batchLength = view.getUint32(schemaEnd + 4, true)
    return {
      schemaIpc: Buffer.from(ipc.subarray(0, schemaEnd)),
      schema: Buffer.from(ipc.subarray(8, schemaEnd)),
      header: Buffer.from(ipc.subarray(schemaEnd + 8, schemaEnd + 8 + batchLength)),
      body: Buffer.from(ipc.subarray(schemaEnd + 8 + batchLength, ipc.length - 8)),
    }
  }

  const bytesField = (tag: number, value: Uint8Array) => {
    const length: number[] = []
    for (let rest = value.length; ; rest >>>= 7) {
      if (rest < 0x80) {
        length.push(rest)
        break
      }
      length.push((rest & 0x7f) | 0x80)
    }
    return Buffer.concat([Buffer.from([tag, ...length]), value])
  }
  const grpcFrame = (message: Buffer) => {
    const prefix = Buffer.alloc(5)
    prefix.writeUInt32BE(message.length, 1)
    return Buffer.concat([prefix, message])
  }
  const metadata = (start: number, end: number, complete: boolean) => Buffer.from(JSON.stringify({ ranges: [{ network: "base-mainnet", numbers: { start, end }, hash: `0x${end}`, prev_hash: "0x0" }], ranges_complete: complete }))
  const flightData = ({ header, body, meta }: { header?: Buffer; body?: Buffer; meta?: Buffer }) => Buffer.concat([header ? bytesField(0x12, header) : Buffer.alloc(0), meta ? bytesField(0x1a, meta) : Buffer.alloc(0), body ? Buffer.concat([Buffer.from([0xc2, 0x3e]), bytesField(0, body).subarray(1)]) : Buffer.alloc(0)])
  const flightInfo = (schemaIpc: Buffer) => Buffer.concat([bytesField(0x0a, schemaIpc), bytesField(0x1a, bytesField(0x0a, bytesField(0x0a, Buffer.from("ticket"))))])

  let port: number
  let close = () => {}
  before(async () => {
    const { schemaIpc, schema, header, body } = flightMessages()
    const server = createHttp2Server((req, res) => {
      req.resume()
      res.writeHead(200, { "content-type": "application/grpc+proto" })
      if (req.url.endsWith("/GetFlightInfo")) res.write(grpcFrame(flightInfo(schemaIpc)))
      else {
        // What Amp sends: the schema, a batch of rows, its watermark with no rows, then the empty keepalive, which isn't Arrow.
        res.write(grpcFrame(flightData({ header: schema })))
        res.write(grpcFrame(flightData({ header, body, meta: metadata(101, 102, false) })))
        res.write(grpcFrame(flightData({ meta: metadata(101, 102, true) })))
        res.write(grpcFrame(flightData({})))
        res.write(grpcFrame(flightData({ meta: metadata(103, 103, true) })))
      }
      res.addTrailers({ "grpc-status": "0" })
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    port = (server.address() as AddressInfo).port
    close = () => server.close()
  })
  after(() => close())

  it("reads each batch's rows and ranges, past a keepalive", async (t) => {
    const batches: StreamBatch[] = []
    for await (const b of createRowStream(`http://127.0.0.1:${port}`, undefined, "base-mainnet")("SELECT 1", { blockNum: 100, hash: "0x100" }, t.signal)) batches.push(b)
    assert.deepEqual(batches.map(({ start, end, complete }) => [start, end, complete]), [[101, 102, false], [101, 102, true], [103, 103, true]])
    assert.deepEqual(batches.map((b) => b.rows.length), [2, 0, 0])
    assert.equal(String(batches[0]!.rows[1]!.block_num), "102")
    assert.equal(batches[0]!.rows[1]!.amount, "6")
  })
})
