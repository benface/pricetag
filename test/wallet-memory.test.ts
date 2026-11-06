import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { ASSETS, ETH_ADDRESS, limitOldestFirst, type LegRow } from "@pricetag/sdk/core"
import { OldestFirstTooBigError, WalletTooBigError, buildPortfolio } from "@pricetag/sdk"
import { WalletsBusyError, createRowBudget, createWallets, oldestFirstLegsThatFit, pricetagClient, rowsThatFit, type Query, type Source } from "@pricetag/sdk/internal"
import { createApi } from "../server/app.ts"
import { rawSource, sharedReads } from "../server/source.ts"

const ME = "0x00000000000000000000000000000000000000aa"
const OTHER = "0x00000000000000000000000000000000000000bb"
const HEAD = { blockNum: 1_000, timestamp: "2026-11-05T00:00:00.000Z" }
const MB = 1_000_000

const row = (block: number, account = ME): LegRow => ({ block_num: block, timestamp: HEAD.timestamp, tx_hash: `0x${block.toString(16)}`, tx_index: 1, log_index: 0, token: ETH_ADDRESS, account, side: "credit", amount: "5", kind: "eth" })
const rowsOf = (count: number, account = ME) => Array.from({ length: count }, (_, i) => row(i + 1, account))

function fakeSource(rows: Record<string, LegRow[]>): Source & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    mode: "raw",
    startBlock: 1,
    historyFrom: null,
    head: async () => HEAD,
    processedThrough: async (_, head) => head,
    async readWindow(address, from, to) {
      reads.push(address)
      return { rows: (rows[address] ?? []).filter((r) => r.block_num >= from && r.block_num <= to), priced: null, gasUnknown: [] }
    },
    readReferences: async (blocks) => blocks.map((blockNum) => ({ blockNum, ethUsd: "300000000000", usdcUsd: "100000000" })),
    readLatestReference: async () => ({ blockNum: HEAD.blockNum, ethUsd: "300000000000", usdcUsd: "100000000" }),
    readEthBalances: async () => new Map(),
    readBalances: async (_, blockNum) => ({ blockNum, amounts: Object.fromEntries(ASSETS.map((asset) => [asset, "0"])) }),
  }
}

const walletsOn = (source: Source, maxRows: number, head = HEAD) => createWallets(source, async () => head, async () => new Map(), { warn() {} }, { budget: createRowBudget(maxRows) })

describe("how much history fits", () => {
  it("grows with the heap, and leaves oldest first far less", () => {
    assert.equal(rowsThatFit(640 * MB), 44_000)
    assert.equal(rowsThatFit(4_400 * MB), 420_000)
    assert.equal(rowsThatFit(100 * MB), 1_000)
    assert.equal(oldestFirstLegsThatFit(640 * MB), 14_832)
    assert.equal(oldestFirstLegsThatFit(100 * MB), 0)
  })
})

describe("the row budget", () => {
  const holder = (rows: number[]) => ({ rows, heldRows: () => rows.reduce((a, b) => a + b, 0), evictOldest: () => rows.shift() !== undefined })

  it("gives up what's kept, oldest first, only as far as it needs to", () => {
    const budget = createRowBudget(100)
    const kept = holder([40, 30, 20])
    budget.join(kept)
    budget.reserve(30)
    assert.deepEqual(kept.rows, [30, 20])
  })

  it("refuses a read other reads leave no room for, until they finish", () => {
    const budget = createRowBudget(100)
    const release = budget.reserve(80)
    assert.throws(() => budget.reserve(30), WalletsBusyError)
    release()
    release()
    budget.reserve(100)
  })

  it("lets a few wallets load at once, and the rest wait their turn", async () => {
    const budget = createRowBudget(90)
    const releases = [await budget.loading(), await budget.loading(), await budget.loading()]
    let fourth = false
    const waiting = budget.loading().then((release) => {
      fourth = true
      return release
    })
    await new Promise((resolve) => setTimeout(resolve, 1))
    assert.equal(fourth, false)
    releases[0]!()
    await waiting
    assert.equal(fourth, true)
  })

  it("makes a load wait for a read that leaves it no room, without giving up what's kept", async () => {
    const budget = createRowBudget(90)
    const kept = holder([60])
    budget.join(kept)
    const release = budget.reserve(70)
    assert.equal(kept.rows.length, 0)
    kept.rows.push(10)
    let loaded = false
    const waiting = budget.loading().then(() => (loaded = true))
    await new Promise((resolve) => setTimeout(resolve, 1))
    assert.equal(loaded, false)
    release()
    await waiting
    assert.deepEqual(kept.rows, [10])
  })
})

describe("a wallet with too much history", () => {
  it("reads in full at the limit, and is refused one row past it, never in part", async () => {
    const source = fakeSource({ [ME]: rowsOf(10), [OTHER]: rowsOf(11, OTHER) })
    const wallets = walletsOn(source, 10)
    assert.equal((await wallets.get(ME)).legs.filter((leg) => !leg.opening).length, 10)
    await assert.rejects(wallets.get(OTHER), WalletTooBigError)
  })

  it("isn't read again each time it's asked for", async () => {
    const source = fakeSource({ [ME]: rowsOf(11) })
    const wallets = walletsOn(source, 10)
    await assert.rejects(wallets.get(ME), WalletTooBigError)
    await assert.rejects(wallets.get(ME), WalletTooBigError)
    assert.equal(source.reads.length, 1)
    // A reorg can shrink it, so one is worth another look.
    await wallets.rewind(500, 600)
    await assert.rejects(wallets.get(ME), WalletTooBigError)
    assert.equal(source.reads.length, 2)
  })

  it("stops being shown once its history grows past the limit", async () => {
    let head = HEAD
    const history = rowsOf(10)
    const source = fakeSource({ [ME]: history })
    const wallets = createWallets(source, async () => head, async () => new Map(), { warn() {} }, { budget: createRowBudget(10) })
    await wallets.get(ME)
    assert.ok(wallets.peek(ME))
    history.push(row(1_001))
    head = { ...HEAD, blockNum: 1_001 }
    await assert.rejects(wallets.get(ME), WalletTooBigError)
    assert.equal(wallets.peek(ME), null)
  })

  it("makes room by forgetting wallets it keeps, which are read again when asked for", async () => {
    const source = fakeSource({ [ME]: rowsOf(6), [OTHER]: rowsOf(6, OTHER) })
    const wallets = walletsOn(source, 10)
    await wallets.get(ME)
    await wallets.get(OTHER)
    assert.equal(wallets.peek(ME), null)
    assert.ok(wallets.peek(OTHER))
    await wallets.get(ME)
    assert.equal(source.reads.filter((address) => address === ME).length, 2)
  })

  it("says so when wallets being read leave no room, and reads it once they're done", async () => {
    let finish = () => {}
    const waiting = new Promise<void>((resolve) => (finish = resolve))
    const source = fakeSource({ [ME]: rowsOf(6), [OTHER]: rowsOf(6, OTHER) })
    const wallets = createWallets(source, async () => HEAD, async () => new Map(), { warn() {} }, { budget: createRowBudget(10) })
    const readBalances = source.readBalances
    source.readBalances = async (address, block) => {
      if (address === ME) await waiting
      return readBalances(address, block)
    }
    const slow = wallets.get(ME)
    while (source.reads.length === 0) await new Promise((resolve) => setTimeout(resolve, 1))
    await new Promise((resolve) => setTimeout(resolve, 5))
    await assert.rejects(wallets.get(OTHER), WalletsBusyError)
    finish()
    await slow
    await wallets.get(OTHER)
  })
})

describe("many wallets read at once", () => {
  it("loads no more than a few at a time, and each gets its answer", async () => {
    const addresses = Array.from({ length: 8 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`)
    const source = fakeSource(Object.fromEntries(addresses.map((address) => [address, rowsOf(1, address)])))
    let loading = 0
    let most = 0
    const readWindow = source.readWindow
    source.readWindow = async (address, from, to) => {
      most = Math.max(most, ++loading)
      await new Promise((resolve) => setTimeout(resolve, 2))
      loading -= 1
      return readWindow(address, from, to)
    }
    const wallets = walletsOn(source, 30)
    const read = await Promise.all(addresses.map((address) => wallets.get(address)))
    assert.equal(most, 3)
    assert.equal(read.length, 8)
  })

  it("gives up its place when its load fails, so the rest still read", async () => {
    const source = fakeSource({ [ME]: rowsOf(1), [OTHER]: rowsOf(1, OTHER) })
    const readWindow = source.readWindow
    source.readWindow = async (address, from, to) => {
      if (address === ME) throw new Error("Amp went away")
      return readWindow(address, from, to)
    }
    const wallets = walletsOn(source, 1)
    await assert.rejects(wallets.get(ME), /Amp went away/)
    assert.equal((await wallets.get(OTHER)).address, OTHER)
  })
})

describe("what the SDK loads of it", () => {
  const leg = (i: number) => ({ block_num: String(i), timestamp: Date.parse(HEAD.timestamp), tx_hash: i.toString(16).padStart(64, "0"), tx_index: "1", log_index: "0", token: ETH_ADDRESS.slice(2), account: ME.slice(2), side: "credit", amount: "5", kind: "eth" })
  /** Like Amp, stops at the query's LIMIT. */
  function amp(legs: number, unlisted: number) {
    const sqls: string[] = []
    const query: Query = async <T>(sql: string) => {
      sqls.push(sql)
      if (sql.includes("X'4d2301cc") || sql.includes("eth_call")) return [] as T[]
      if (/ORDER BY block_num DESC LIMIT 1/.test(sql)) return [{ block_num: "200", timestamp: Date.parse(HEAD.timestamp) }] as T[]
      const count = sql.includes(".unlisted_legs") ? unlisted : sql.includes(".legs") ? legs : 0
      const limit = Number(/LIMIT (\d+)$/.exec(sql)?.[1] ?? Infinity)
      const first = sql.includes(".unlisted_legs") ? 1_000 : 1
      return Array.from({ length: Math.min(count, limit) }, (_, i) => leg(first + i)) as T[]
    }
    return { sqls, client: pricetagClient(query, { dataset: "benface/pricetag@0.0.1", startBlock: 1, maxWalletRows: 10, logger: { warn() {} } }) }
  }
  const asked = (sqls: string[], table: string) => sqls.find((sql) => sql.includes(`.${table} WHERE`) && sql.includes("account ="))

  it("asks for no more rows than it needs to know it's too many", async () => {
    const { client, sqls } = amp(1_000, 0)
    await assert.rejects(client.getLegs(ME), WalletTooBigError)
    assert.match(asked(sqls, "legs")!, /LIMIT 11$/)
    assert.equal(asked(sqls, "unlisted_legs"), undefined)
  })

  it("counts both tables together", async () => {
    const { client, sqls } = amp(7, 1_000)
    await assert.rejects(client.getLegs(ME), WalletTooBigError)
    assert.match(asked(sqls, "unlisted_legs")!, /LIMIT 4$/)
  })

  it("loses nothing from a wallet that fits", async () => {
    const { client } = amp(7, 3)
    assert.equal((await client.getLegs(ME)).legs.length, 10)
  })
})

describe("the server's other reads of a wallet", () => {
  const config = { baseDataset: "base", dataset: "pricetag", network: "base_mainnet" }
  const legRow = (i: number) => ({ block_num: String(i), timestamp: 0, tx_hash: "ab", tx_index: "1", log_index: "0", token: "cd", account: ME.slice(2), side: "credit", amount: "5", kind: "gas" })

  it("sharedReads refuses too many, and keeps no more than fit across wallets", async () => {
    let count = 6
    const query: Query = async <T>(sql: string) => (sql.includes(".legs WHERE") ? (Array.from({ length: count }, (_, i) => legRow(i + 1)) as T[]) : ([] as T[]))
    const shared = sharedReads(query, { ...config, maxWalletRows: 10 })
    await shared.readLegs(ME, 1, 100)
    await shared.readLegs(OTHER, 1, 100)
    // The first was let go to fit the second, so this reads it again, and now it has too many.
    count = 11
    await assert.rejects(shared.readLegs(ME, 1, 100), WalletTooBigError)
  })

  it("rawSource refuses a wallet with too many transactions and logs", async () => {
    const sqls: string[] = []
    const tx = { block_num: "1", timestamp: 0, tx_hash: "ab", tx_index: "1", from: ME.slice(2), to: OTHER.slice(2), value: "1", gas_used: "1", gas_price: "1", status: true, type: "2" }
    const query: Query = async <T>(sql: string) => {
      sqls.push(sql)
      return (sql.includes(".transactions") ? Array.from({ length: 11 }, () => tx) : []) as T[]
    }
    const source = rawSource(query, { baseDataset: "base", network: "base_mainnet", historyBlocks: 100, maxWalletRows: 10 })
    await assert.rejects(source.readWindow(ME, 1, 100), WalletTooBigError)
    assert.match(sqls[0]!, /LIMIT 11$/)
    assert.equal(sqls.length, 1)
  })
})

describe("oldest first on a long history", () => {
  const leg = (i: number) => ({ id: `${i}`, asset: "ETH", delta: "1", decimals: 18, kind: "transfer", priceMicros: "1", priceSource: "oracle", priceNote: null, costMicros: "1", proceedsMicros: null, costLabel: "paid", blockNum: i, timestamp: HEAD.timestamp, txHash: `0x${i}`, txIndex: 0, parts: [] }) as never
  after(() => limitOldestFirst(Number.POSITIVE_INFINITY))

  it("is refused past the limit, and average cost isn't", () => {
    limitOldestFirst(2)
    const legs = [leg(1), leg(2), leg(3)]
    assert.throws(() => buildPortfolio(legs, "fifo", {}), OldestFirstTooBigError)
    assert.equal(buildPortfolio(legs, "average", {}).method, "average")
    assert.equal(buildPortfolio(legs.slice(0, 2), "fifo", {}).method, "fifo")
  })
})

describe("what the API answers", () => {
  const source = fakeSource({ [ME]: rowsOf(11), [OTHER]: rowsOf(10, OTHER) })
  let server: Server
  let base: string
  before(async () => {
    const api = createApi({ PRICETAG_MAX_WALLET_ROWS: "10" }, { source, readRates: async () => ({ byBlock: {}, latest: null }), proofs: { datasets: async () => [], priceBehind: async () => null, readBlock: async () => null } }, null)
    server = createServer((req, res) => void api(req, res))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(() => {
    limitOldestFirst(Number.POSITIVE_INFINITY)
    server.close()
  })
  const post = (path: string, body: unknown) => fetch(`${base}/api/portfolio/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const tooBig = async (response: Response) => {
    assert.equal(response.status, 413)
    assert.match(((await response.json()) as { error: string }).error, /too much history/)
  }

  it("says a wallet's too big on every way of reading it", async () => {
    await tooBig(await fetch(`${base}/api/wallet/${ME}`))
    await tooBig(await fetch(`${base}/api/portfolio/${ME}`))
    await tooBig(await post(ME, { method: "average" }))
    await tooBig(await post("all", { method: "average", linked: [ME] }))
  })

  it("never adds a wallet up as if a too-big one weren't there", async () => {
    const all = (await (await post("all", { method: "average", linked: [ME, OTHER] })).json()) as { wallets: { address: string; state: string }[] }
    assert.deepEqual(all.wallets.map((w) => [w.address, w.state]), [[OTHER, "read"], [ME, "failed"]])
  })

  it("says oldest first is too much, and reads the same wallet by average", async () => {
    limitOldestFirst(2)
    const refused = await fetch(`${base}/api/portfolio/${OTHER}?method=fifo`)
    assert.equal(refused.status, 413)
    assert.match(((await refused.json()) as { error: string }).error, /oldest first.*Average cost still works/)
    assert.equal((await post(OTHER, { method: "fifo" })).status, 413)
    assert.equal((await post("all", { method: "fifo", linked: [OTHER] })).status, 413)
    assert.equal((await fetch(`${base}/api/portfolio/${OTHER}`)).status, 200)
  })
})
