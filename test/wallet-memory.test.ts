import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { after, before, describe, it } from "node:test"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { fileURLToPath } from "node:url"
import { ASSETS, ETH_ADDRESS, USDC_ADDRESS, WalletsTooBigError, applyLeg, assertFoldsFit, emptyPosition, limitFolds, type LegRow } from "@pricetag/sdk/core"
import { OldestFirstTooBigError, WalletTooBigError, buildPortfolio } from "@pricetag/sdk"
import { WalletsBusyError, createRowBudget, createWallets, foldBytesThatFit, pricetagClient, rowsThatFit, type Query, type Source } from "@pricetag/sdk/internal"
import { createApi } from "../server/app.ts"
import { createHandler } from "../server/http.ts"
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
  it("grows with the heap", () => {
    assert.equal(rowsThatFit(640 * MB), 44_000)
    assert.equal(rowsThatFit(4_400 * MB), 420_000)
    assert.equal(rowsThatFit(100 * MB), 1_000)
    assert.equal(foldBytesThatFit(640 * MB), 440 * MB)
    assert.equal(foldBytesThatFit(100 * MB), 0)
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

  describe("when a query alongside the rows fails", () => {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 1))
    const gate = () => {
      let open = () => {}
      const opened = new Promise<void>((resolve) => (open = resolve))
      return { opened, open: () => open() }
    }

    function failingPrice() {
      const source = fakeSource({ [ME]: rowsOf(90), [OTHER]: rowsOf(1, OTHER) })
      const fail = gate()
      const readLatestReference = source.readLatestReference
      let failing = true
      source.readLatestReference = async (block) => {
        if (!failing) return readLatestReference(block)
        failing = false
        await fail.opened
        throw new Error("Amp went away")
      }
      const budget = createRowBudget(90)
      return { source, budget, fail, wallets: createWallets(source, async () => HEAD, async () => new Map(), { warn() {} }, { budget }) }
    }

    it("gives back what the rows reserve, once they're read", async () => {
      const { source, budget, fail, wallets } = failingPrice()
      const window = gate()
      const readWindow = source.readWindow
      source.readWindow = async (address, from, to) => {
        if (address === ME) await window.opened
        return readWindow(address, from, to)
      }
      const failed = assert.rejects(wallets.get(ME), /Amp went away/)
      await settle()
      fail.open()
      await settle()
      window.open()
      await failed
      await settle()
      budget.reserve(90)()
      assert.deepEqual(wallets.progress(ME), { stage: "waiting", transfers: null })
      assert.equal((await wallets.get(OTHER)).address, OTHER)
    })

    it("doesn't start reading rows it was still waiting for room to read", async () => {
      const { source, budget, fail, wallets } = failingPrice()
      const release = budget.reserve(90)
      const failed = assert.rejects(wallets.get(ME), /Amp went away/)
      await settle()
      fail.open()
      await settle()
      release()
      await failed
      await settle()
      assert.deepEqual(source.reads, [])
      budget.reserve(90)()
      assert.deepEqual(wallets.progress(ME), { stage: "waiting", transfers: null })
      assert.equal((await wallets.get(OTHER)).address, OTHER)
      assert.deepEqual(source.reads, [OTHER])
    })
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
      if (/ORDER BY block_num DESC LIMIT 1/.test(sql)) return sql.split(" UNION ALL ").map(() => ({ block_num: "200", timestamp: Date.parse(HEAD.timestamp) })) as T[]
      const count = (sql.includes(".legs") ? legs : 0) + (sql.includes(".unlisted_legs") ? unlisted : 0)
      const limit = Number(/LIMIT (\d+)$/.exec(sql)?.[1] ?? Infinity)
      return Array.from({ length: Math.min(count, limit) }, (_, i) => leg(1 + i)) as T[]
    }
    return { sqls, client: pricetagClient(query, { dataset: "benface/pricetag@0.0.1", startBlock: 1, maxWalletRows: 10, logger: { warn() {} } }) }
  }
  const asked = (sqls: string[], table: string) => sqls.find((sql) => sql.includes(`.${table} WHERE`) && sql.includes("account ="))

  it("asks for no more rows than it needs to know it's too many", async () => {
    const { client, sqls } = amp(1_000, 0)
    await assert.rejects(client.getLegs(ME), WalletTooBigError)
    assert.match(asked(sqls, "legs")!, /LIMIT 11$/)
  })

  it("counts both tables together", async () => {
    const { client, sqls } = amp(7, 1_000)
    await assert.rejects(client.getLegs(ME), WalletTooBigError)
    assert.match(asked(sqls, "unlisted_legs")!, /LIMIT 11$/)
    assert.equal(asked(sqls, "unlisted_legs"), asked(sqls, "legs"))
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
  const leg = (i: number, delta = "1") => ({ id: `${i}`, asset: "ETH", delta, decimals: 18, kind: "transfer", priceMicros: "1", priceSource: "oracle", priceNote: null, costMicros: "1", proceedsMicros: null, costLabel: "paid", blockNum: i, timestamp: HEAD.timestamp, txHash: `0x${i}`, txIndex: 0, parts: [] }) as never
  after(() => limitFolds(Number.POSITIVE_INFINITY))

  it("is refused past the limit, and average cost isn't", () => {
    limitFolds(25_000)
    const legs = [leg(1), leg(2), leg(3)]
    assert.throws(() => buildPortfolio(legs, "fifo", {}), OldestFirstTooBigError)
    assert.equal(buildPortfolio(legs, "average", {}).method, "average")
    assert.equal(buildPortfolio(legs.slice(0, 2), "fifo", {}).method, "fifo")
  })

  it("counts the most lots open at once, so the same number of legs can fit when what arrives also leaves", () => {
    // Six legs, and six lots open at the end, or never more than one.
    limitFolds(6 * 10_000 + 3 * 500)
    const incoming = Array.from({ length: 6 }, (_, i) => leg(i))
    const inAndOut = Array.from({ length: 6 }, (_, i) => leg(i, i % 2 === 0 ? "1" : "-1"))
    assert.throws(() => buildPortfolio(incoming, "fifo", {}), OldestFirstTooBigError)
    assert.equal(buildPortfolio(inAndOut, "fifo", {}).method, "fifo")
  })

  it("adds wallets up, and leaves each less room the more of them there are", () => {
    const history = Array.from({ length: 10 }, (_, i) => leg(i))
    limitFolds(220_000)
    const of = (count: number) => Array.from({ length: count }, () => ({ legs: history }))
    assertFoldsFit(of(2), "average")
    assert.throws(() => assertFoldsFit(of(2), "fifo"), OldestFirstTooBigError)
    assert.throws(() => assertFoldsFit(of(3), "average"), WalletsTooBigError)
  })

  // One 10-unit lot of its own, then five older lots of 1 from another wallet, then 1 leaves. Oldest by when they were acquired, that's one of the five, which leaves 5 open. By when they arrived, it would leave 6.
  const piece = (block: number) => ({ qty: "1", costMicros: "1", label: "inherited", estimatedCostMicros: "0", acquiredBlock: block, acquiredAt: HEAD.timestamp }) as never
  const inherited = () => [leg(10, "10"), { ...(leg(20, "5") as object), pieces: [1, 2, 3, 4, 5].map(piece) } as never, leg(21, "-1")]

  it("counts every lot a leg inherited, in the order they were acquired", () => {
    const legs = 3 * 10_000
    // At most six open at once: its own, then the five it inherited.
    const lots = 6 * 500
    const copies = 5 * 500
    limitFolds(legs + lots + copies)
    assert.equal(buildPortfolio(inherited(), "fifo", {}).method, "fifo")
    limitFolds(legs + lots + copies - 1)
    assert.throws(() => buildPortfolio(inherited(), "fifo", {}), OldestFirstTooBigError)
  })

  it("fits nearly as many purchases still open as a wallet can hold rows, in the heap the server's measured on", () => {
    limitFolds(foldBytesThatFit(640 * MB))
    const purchases = Array.from({ length: 40_000 }, (_, i) => leg(i + 1))
    assertFoldsFit([{ legs: purchases }], "fifo")
    assertFoldsFit([{ legs: purchases.slice(0, 15_000) }, { legs: purchases.slice(25_000) }], "fifo")
    // What the legs alone cost is still the limit.
    assert.throws(() => assertFoldsFit([{ legs: [...purchases, ...purchases.slice(0, 4_000)] }], "fifo"), OldestFirstTooBigError)
  })

  it("keeps a line for each block paid at only while working out what's inherited", () => {
    const paidAt = [{ costMicros: "1", qty: "1", blockNum: 1 }]
    const pieces = [{ qty: "1", costMicros: "1", label: "inherited", estimatedCostMicros: "0", paidAt }] as never
    const credit = { ...(leg(1) as object), pieces } as never
    assert.equal(applyLeg(emptyPosition("average", 18), credit).lots[0]?.paidAt, undefined)
    assert.deepEqual(applyLeg(emptyPosition("average", 18, true), credit).lots[0]?.paidAt, paidAt)
  })
})

describe("wallets that pass lots between them", () => {
  const A = ME
  const B = OTHER
  const SOMEONE = "0x00000000000000000000000000000000000000cc"
  const LOTS = 30
  const SPENDS = 40
  const usdc = (block: number, account: string, side: "credit" | "debit", amount: number, counterparty: string): LegRow => ({ block_num: block, timestamp: HEAD.timestamp, tx_hash: `0x${block.toString(16)}`, tx_index: 1, log_index: 0, token: USDC_ADDRESS, account, side, amount: String(amount), kind: "erc20", counterparty })
  const rows: Record<string, LegRow[]> = {
    [A]: [...Array.from({ length: LOTS }, (_, i) => usdc(i + 1, A, "credit", 100, SOMEONE)), usdc(LOTS + 1, A, "debit", LOTS * 100, B)],
    [B]: [usdc(LOTS + 1, B, "credit", LOTS * 100, A), ...Array.from({ length: SPENDS }, (_, i) => usdc(LOTS + 2 + i, B, "debit", 1, SOMEONE))],
  }
  const book = { senders: { [SOMEONE]: { kind: "someone-else" } }, costs: {} }
  const body = { linked: [A, B], book }
  const source = fakeSource(rows)
  const usdcHeld = (address: string, block: number) => (rows[address] ?? []).filter((r) => r.block_num <= block).reduce((sum, r) => sum + BigInt(r.amount) * (r.side === "credit" ? 1n : -1n), 0n)
  source.readBalances = async (address, blockNum) => ({ blockNum, amounts: Object.fromEntries(ASSETS.map((asset) => [asset, asset === "USDC" ? usdcHeld(address, blockNum).toString() : "0"])) })
  let server: Server
  let base: string
  before(async () => {
    const api = createApi({}, { source, readRates: async () => ({ byBlock: {}, latest: null }), proofs: { datasets: async () => [], priceBehind: async () => null, currentPriceBehind: async () => null, readBlock: async () => null } }, null)
    server = createServer(createHandler(api, null))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(() => {
    limitFolds(Number.POSITIVE_INFINITY)
    server.close()
  })
  const post = (path: string, payload: unknown) => fetch(`${base}/api/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
  const together: [string, unknown][] = [
    ["portfolio/all", body],
    ["portfolio/all/export", body],
    ["portfolio/all/explain?metric=pnl", body],
    ["portfolio/all/preview", { ...body, candidates: [book] }],
  ]
  const one: [string, unknown][] = [
    [`portfolio/${B}`, body],
    [`portfolio/${B}/export`, body],
    [`portfolio/${B}/preview`, { ...body, candidates: [book] }],
    [`tax-report/${A}`, { country: "CA", scope: "per-wallet", also: [B], book }],
    [`tax-report/${A}`, { country: "CA", scope: "pooled", also: [B], book }],
  ]
  const withMethod = (payload: unknown, method: string) => ({ ...(payload as object), method })

  it("counts what the recipient inherited, every way of asking, and leaves the server usable", async () => {
    limitFolds(Number.POSITIVE_INFINITY)
    await post("portfolio/all/wallets", body)
    // Room for what each wallet's own legs say it holds, but not for what B holds once it inherits them all.
    const refused = async (limit: number, ways: [string, unknown][]) => {
      limitFolds(limit)
      for (const [path, payload] of ways) {
        const response = await post(path, withMethod(payload, "fifo"))
        assert.equal(response.status, 413, path)
        assert.match(response.headers.get("content-type") ?? "", /json/)
        assert.match(((await response.json()) as { error: string }).error, /oldest first.*Average cost still works/)
      }
    }
    await refused(840_000, together)
    await refused(420_000, one)
    limitFolds(840_000)
    assert.equal((await post("portfolio/all", withMethod(body, "average"))).status, 200)
    assert.equal((await post(`portfolio/${A}`, { method: "fifo" })).status, 200)
  })

  it("refuses by average too, when moves hold more lines than fit", async () => {
    limitFolds(Number.POSITIVE_INFINITY)
    await post("portfolio/all/wallets", body)
    limitFolds((rows[A]!.length + rows[B]!.length) * 11_000 + (LOTS - 1) * 150)
    for (const [path, payload] of together) {
      const response = await post(path, withMethod(payload, "average"))
      assert.equal(response.status, 413, path)
      assert.match(((await response.json()) as { error: string }).error, /too much history to add up/)
    }
    limitFolds((rows[A]!.length + rows[B]!.length) * 11_000 + LOTS * 150)
    assert.equal((await post("portfolio/all", withMethod(body, "average"))).status, 200)
  })

  it("reads them in full when they fit, with the costs carried across", async () => {
    limitFolds(Number.POSITIVE_INFINITY)
    const whole = await post(`portfolio/${B}`, withMethod(body, "fifo"))
    assert.equal(whole.status, 200)
    const { positions } = (await whole.json()) as { positions: { asset: string; values: { unknownCostQty: string; costMicros: string | null } }[] }
    const held = positions.find(({ asset }) => asset === "USDC")
    assert.equal(held?.values.unknownCostQty, "0")
    assert.notEqual(held?.values.costMicros, null)
  })
})

describe("counting a history that's too big to fold", () => {
  /** The heap the `Dockerfile` gives the server. */
  const answersOn512Mb = (lots: number, moves: number) => {
    const { status, stdout, stderr } = spawnSync(process.execPath, ["--max-old-space-size=512", fileURLToPath(new URL("./support/bounce-server.ts", import.meta.url)), String(lots), String(moves)], { encoding: "utf8" })
    assert.equal(status, 0, stderr.slice(0, 2_000))
    return JSON.parse(stdout) as Record<string, { status: number; type: string | null; error?: string }>
  }

  it("refuses partway, in the real heap, and the server goes on answering", () => {
    // 9,000 rows, well within what can be read, but nine million copies of a lot to count them all.
    const answers = answersOn512Mb(3_000, 3_000)
    assert.equal(answers.warm?.status, 200)
    for (const name of ["all", "export", "explain", "preview", "single", "tax"]) {
      assert.equal(answers[name]?.status, 413, name)
      assert.match(answers[name]?.type ?? "", /json/, name)
      assert.match(answers[name]?.error ?? "", /oldest first.*Average cost still works/, name)
    }
    assert.equal(answers.small?.status, 200)
  })

  it("stops at the first step past the limit, without looking at what's left", () => {
    const LOTS = 30
    const MOVES = 40
    const leg = (block: number, delta: number, counterparty?: string) => ({ asset: "USDC", delta: String(delta), blockNum: block, txIndex: 1, txHash: `0x${block.toString(16)}`, parts: counterparty ? [{ side: delta > 0 ? "credit" : "debit", counterparty, amount: String(Math.abs(delta)), logIndex: 0 }] : [] })
    const legs: Record<string, ReturnType<typeof leg>[]> = { [ME]: Array.from({ length: LOTS }, (_, i) => leg(i + 1, 100)), [OTHER]: [] }
    for (let i = 0; i < MOVES; i++) {
      const [from, to] = i % 2 === 0 ? [ME, OTHER] : [OTHER, ME]
      legs[from]!.push(leg(LOTS + i + 1, -LOTS * 100, to))
      legs[to]!.push(leg(LOTS + i + 1, LOTS * 100, from))
    }
    let reachedTheEnd = false
    const last = leg(LOTS + MOVES + 1, 100)
    legs[ME]!.push(Object.defineProperty(last, "parts", { get: () => ((reachedTheEnd = true), []) }))
    const count = LOTS + 2 * MOVES + 1
    // Room for what each wallet's legs cost, and for two moves' worth of inherited lots.
    limitFolds(count * 11_000 + 2 * LOTS * 500 + 20 * 1_000)
    assert.throws(() => assertFoldsFit(Object.entries(legs).map(([address, of]) => ({ address, legs: of })) as never, "fifo"), OldestFirstTooBigError)
    assert.equal(reachedTheEnd, false)
    limitFolds(1e12)
    assertFoldsFit(Object.entries(legs).map(([address, of]) => ({ address, legs: of })) as never, "fifo")
    assert.equal(reachedTheEnd, true)
    limitFolds(Number.POSITIVE_INFINITY)
  })
})

describe("what the API answers", () => {
  const source = fakeSource({ [ME]: rowsOf(11), [OTHER]: rowsOf(10, OTHER) })
  let server: Server
  let base: string
  before(async () => {
    const api = createApi({ PRICETAG_MAX_WALLET_ROWS: "10" }, { source, readRates: async () => ({ byBlock: {}, latest: null }), proofs: { datasets: async () => [], priceBehind: async () => null, currentPriceBehind: async () => null, readBlock: async () => null } }, null)
    server = createServer((req, res) => void api(req, res))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(() => {
    limitFolds(Number.POSITIVE_INFINITY)
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
    limitFolds(100_500)
    const refused = await fetch(`${base}/api/portfolio/${OTHER}?method=fifo`)
    assert.equal(refused.status, 413)
    assert.match(((await refused.json()) as { error: string }).error, /oldest first.*Average cost still works/)
    assert.equal((await post(OTHER, { method: "fifo" })).status, 413)
    assert.equal((await post("all", { method: "fifo", linked: [OTHER] })).status, 413)
    assert.equal((await fetch(`${base}/api/portfolio/${OTHER}`)).status, 200)
  })
})

describe("wallets that each fit, added up", () => {
  const A = ME
  const B = OTHER
  const source = fakeSource({ [A]: rowsOf(10, A), [B]: rowsOf(10, B) })
  let server: Server
  let base: string
  before(async () => {
    const api = createApi({}, { source, readRates: async () => ({ byBlock: {}, latest: null }), proofs: { datasets: async () => [], priceBehind: async () => null, currentPriceBehind: async () => null, readBlock: async () => null } }, null)
    server = createServer(createHandler(api, null))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(() => {
    limitFolds(Number.POSITIVE_INFINITY)
    server.close()
  })
  const post = (path: string, body: unknown) => fetch(`${base}/api/portfolio/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const both = { linked: [A, B] }
  const everyWay = ["all", "all/export", "all/preview", "all/explain?metric=pnl"]
  const body = (way: string, method: string) => ({ method, ...both, ...(way === "all/preview" ? { candidates: [{ costs: {}, senders: {} }] } : {}) })
  const refused = async (response: Response, why: RegExp) => {
    assert.equal(response.status, 413)
    assert.match(response.headers.get("content-type") ?? "", /json/)
    assert.match(((await response.json()) as { error: string }).error, why)
  }

  it("refuses oldest first every way of asking, while average and each wallet on its own still work", async () => {
    limitFolds(222_000)
    await post("all/wallets", both)
    for (const way of everyWay) await refused(await post(way, body(way, "fifo")), /oldest first.*Average cost still works/)
    assert.equal((await post("all", body("all", "average"))).status, 200)
    assert.equal((await post(A, { method: "fifo" })).status, 200)
    assert.equal((await post(B, { method: "fifo" })).status, 200)
  })

  it("refuses wallets too big together by any method, and says each can still be read", async () => {
    limitFolds(219_000)
    await post("all/wallets", both)
    for (const way of everyWay) await refused(await post(way, body(way, "average")), /too much history to add up.*on its own/)
    assert.equal((await post(A, { method: "average" })).status, 200)
  })

  it("answers an export it can do with a CSV", async () => {
    limitFolds(Number.POSITIVE_INFINITY)
    const response = await post("all/export", body("all/export", "fifo"))
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type") ?? "", /csv/)
  })
})
