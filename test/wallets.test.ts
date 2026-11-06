import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { portfolioOf } from "../src/core/portfolio.ts"
import { USD_CONTEXT, explainMetric } from "../src/core/explain.ts"
import { createWallets, sharedMarket, type ReadL1Fees, type Source, type WindowRows } from "@pricetag/sdk/internal"
import { ASSETS, ETH_ADDRESS, LAST_2S_BLOCK, USDC_ADDRESS, foldWallet, msBetweenBlocks, pnlOverTime, priceSampleBlocks, shortHash, usdView, type FeedRound, type LegRow, type Reference } from "@pricetag/sdk/core"

const ME = "0x00000000000000000000000000000000000000aa"

const row = (block: number, amount = "5"): LegRow => ({
  block_num: block,
  timestamp: "2026-11-04T00:00:00.000Z",
  tx_hash: `0x${block.toString(16)}`,
  tx_index: 1,
  log_index: 0,
  token: ETH_ADDRESS,
  account: ME,
  side: "credit",
  amount,
  kind: "eth",
})
const reference = (block: number): Reference => ({ blockNum: block, ethUsd: "240000000000", usdcUsd: "100000000" })

function fake(
  chain: Map<number, LegRow[]>,
  latest: () => Reference | null,
  processed: (head: number) => number | null = (head) => head,
  balances: (block: number) => Promise<Record<string, string> | null> = async () => ({}),
  ethBalances: (blocks: readonly number[]) => Promise<Map<number, string>> = async () => new Map(),
) {
  const windows: [number, number][] = []
  const balanceReads: number[] = []
  const referenceReads: number[][] = []
  const ethReads: number[][] = []
  const source: Source = {
    mode: "raw",
    startBlock: null,
    historyFrom: (head) => head - 100,
    head: async () => null,
    processedThrough: async (_, head) => processed(head),
    async readWindow(_, from, to): Promise<WindowRows> {
      windows.push([from, to])
      return { rows: [...chain.entries()].filter(([b]) => b >= from && b <= to).flatMap(([, r]) => r), priced: null, gasUnknown: [] }
    },
    async readReferences(blocks) {
      referenceReads.push([...blocks])
      return blocks.map(reference)
    },
    readLatestReference: async () => latest(),
    async readBalances(_, block) {
      balanceReads.push(block)
      const amounts = await balances(block)
      return amounts && { blockNum: block, amounts }
    },
    async readEthBalances(_, blocks) {
      ethReads.push([...blocks])
      return ethBalances(blocks)
    },
  }
  return { source, windows, referenceReads, balanceReads, ethReads }
}

const noFees: ReadL1Fees = async () => new Map()

const headAt = (block: number) => async () => ({ blockNum: block, timestamp: "2026-11-04T00:00:00.000Z" })

describe("the wallet cache", () => {
  it("reads the full window once, then only new blocks plus a tail for reorgs", async () => {
    let head = 1000
    const chain = new Map([[950, [row(950)]]])
    const { source, windows, referenceReads } = fake(chain, () => reference(head))
    const wallets = createWallets(source, async () => headAt(head)(), noFees)
    assert.equal((await wallets.get(ME)).legs.length, 1)
    assert.deepEqual(windows, [[900, 1000]])
    assert.deepEqual(referenceReads[0], [950])

    head = 1002
    chain.set(1001, [row(1001)])
    const next = await wallets.get(ME)
    assert.deepEqual(windows[1], [971, 1002])
    assert.deepEqual(next.legs.map((l) => l.blockNum), [950, 1001])
    assert.deepEqual(next.coverage, { fromBlock: 900, toBlock: 1002 })
  })

  describe("when the dataset lags the chain", () => {
    it("a lag past the reorg tail, then recovery, loses nothing", async () => {
      let head = 1000
      let through = 960
      const chain = new Map([
        [950, [row(950)]],
        [970, [row(970)]],
      ])
      const { source, windows } = fake(chain, () => reference(head), () => through)
      const wallets = createWallets(source, async () => headAt(head)(), noFees)

      const behind = await wallets.get(ME)
      assert.deepEqual(behind.legs.map((l) => l.blockNum), [950])
      assert.deepEqual(behind.coverage, { fromBlock: 900, toBlock: 960 })
      assert.equal(behind.latest.blockNum, 1000)

      head = 1001
      through = 1001
      const recovered = await wallets.get(ME)
      assert.deepEqual(recovered.legs.map((l) => l.blockNum), [950, 970])
      assert.deepEqual(recovered.coverage, { fromBlock: 900, toBlock: 1001 })
      assert.deepEqual(windows.at(-1), [931, 1001])
    })

    it("no progress means no wallet read, but the head still moves", async () => {
      let head = 1000
      const { source, windows } = fake(new Map(), () => reference(head), () => 960)
      const wallets = createWallets(source, async () => headAt(head)(), noFees)
      await wallets.get(ME)
      head = 1005
      const wallet = await wallets.get(ME)
      assert.equal(windows.length, 1)
      assert.equal(wallet.latest.blockNum, 1005)
      assert.equal(wallet.coverage.toBlock, 960)
    })

    it("a stalled dataset's price expires instead of going stale", async () => {
      let head = 1000
      let latest: Reference | null = reference(960)
      const { source } = fake(new Map(), () => latest, () => 960)
      const wallets = createWallets(source, async () => headAt(head)(), noFees)
      assert.ok((await wallets.get(ME)).prices.ETH)
      head = 1100
      latest = null
      assert.equal((await wallets.get(ME)).prices.ETH, undefined)
    })

    it("a dataset that hasn't started says so, and reads from its start once it has", async () => {
      let head = 1000
      let through: number | null = null
      const chain = new Map([[905, [row(905)]]])
      const { source, windows } = fake(chain, () => null, () => through)
      const wallets = createWallets(source, async () => headAt(head)(), noFees)
      const empty = await wallets.get(ME)
      assert.deepEqual(empty.coverage, { fromBlock: 900, toBlock: 899 })
      assert.equal(windows.length, 0)
      head = 1001
      through = 910
      assert.deepEqual((await wallets.get(ME)).legs.map((l) => l.blockNum), [905])
      assert.deepEqual(windows[0], [900, 910])
    })
  })

  it("doesn't read again until there's a new block", async () => {
    const { source, windows } = fake(new Map(), () => reference(1000))
    const wallets = createWallets(source, headAt(1000), noFees)
    await wallets.get(ME)
    await wallets.get(ME)
    assert.equal(windows.length, 1)
  })

  it("a reorg near the tip replaces what it changed", async () => {
    let head = 1000
    const chain = new Map([[995, [row(995, "5")]]])
    const { source } = fake(chain, () => reference(head))
    const wallets = createWallets(source, async () => headAt(head)(), noFees)
    assert.equal((await wallets.get(ME)).legs[0]!.delta, "5")
    head = 1001
    chain.set(995, [row(995, "7")])
    const after = await wallets.get(ME)
    assert.equal(after.legs.length, 1)
    assert.equal(after.legs[0]!.delta, "7")
  })

  it("a derived table a block behind the head still gives a current price, with its own block on it", async () => {
    const { source } = fake(new Map(), () => reference(998))
    const wallet = await createWallets(source, headAt(1000), noFees).get(ME)
    assert.deepEqual(wallet.prices.ETH, { micros: "2400000000", source: "oracle", blockNum: 998 })
  })

  it("with no recent oracle read, there's no price, rather than an old one", async () => {
    let latest: Reference | null = reference(1000)
    let head = 1000
    const { source } = fake(new Map(), () => latest)
    const wallets = createWallets(source, async () => headAt(head)(), noFees)
    assert.ok((await wallets.get(ME)).prices.ETH)
    latest = null
    head = 1001
    assert.equal((await wallets.get(ME)).prices.ETH, undefined)
  })

  it("a failed oracle read at a wallet's block leaves that leg with no price", async () => {
    const { source } = fake(new Map([[950, [row(950)]]]), () => reference(1000))
    source.readReferences = async (blocks) => blocks.map((b) => ({ blockNum: b, ethUsd: "", usdcUsd: "" }))
    const [leg] = (await createWallets(source, headAt(1000), noFees).get(ME)).legs
    assert.equal(leg!.priceMicros, null)
  })

  it("concurrent reads of one wallet share a single query", async () => {
    const { source, windows } = fake(new Map(), () => reference(1000))
    const wallets = createWallets(source, headAt(1000), noFees)
    await Promise.all([wallets.get(ME), wallets.get(ME.toUpperCase().replace("0X", "0x"))])
    assert.equal(windows.length, 1)
  })
})

describe("reconciling", () => {
  const gas = (block: number): LegRow => ({ ...row(block, "1000"), kind: "gas", side: "debit" })
  const chain = () => new Map([[950, [row(950, "5000")]], [960, [gas(960)]]])
  const silenced = async (run: () => Promise<void>) => {
    const original = console.warn
    console.warn = () => {}
    try {
      await run()
    } finally {
      console.warn = original
    }
  }

  it("reads balances before the first block and at the last block covered, not the head", async () => {
    const { source, balanceReads } = fake(chain(), () => reference(1000), () => 990)
    const wallet = await createWallets(source, headAt(1000), noFees).get(ME)
    assert.deepEqual(balanceReads, [899, 990])
    assert.equal(wallet.balances?.blockNum, 990)
    assert.equal(wallet.coverage.toBlock, 990)
  })

  const every = (amount: string) => Object.fromEntries(ASSETS.map((asset) => [asset, amount]))

  it("reads the opening once, and the closing again only when coverage moves", async () => {
    let head = 1000
    let processed = 1000
    const { source, balanceReads } = fake(chain(), () => reference(head), () => processed, async () => every("0"))
    const wallets = createWallets(source, async () => headAt(head)(), noFees)
    await wallets.get(ME)
    head = 1001
    await wallets.get(ME)
    assert.deepEqual(balanceReads, [899, 1000])
    processed = 1001
    head = 1002
    await wallets.get(ME)
    assert.deepEqual(balanceReads, [899, 1000, 1001])
  })

  it("doesn't read a balance while a dataset hasn't reached its first block", async () => {
    const { source, balanceReads } = fake(chain(), () => null, () => null)
    const wallet = await createWallets(source, headAt(1000), noFees).get(ME)
    assert.deepEqual(balanceReads, [])
    assert.equal(wallet.balances, null)
  })

  it("adds the opening balance as a leg before everything else", async () => {
    const { source } = fake(chain(), () => reference(1000), undefined, async (block): Promise<Record<string, string>> => (block === 899 ? { ETH: "7", USDC: "0" } : { ETH: "7" }))
    const { legs } = await createWallets(source, headAt(1000), noFees).get(ME)
    assert.deepEqual(legs.map((l) => [l.id, l.delta]).slice(0, 2), [["opening:ETH", "7"], ["0x3b6:ETH", "5000"]])
    assert.equal(legs[0]!.timestamp, new Date(Date.parse("2026-11-04T00:00:00.000Z") - 101 * 2000).toISOString())
  })

  it("re-reads about a minute of chain for reorgs, whatever the block time", async () => {
    let head = LAST_2S_BLOCK + 1000
    const { source, windows } = fake(new Map(), () => reference(head))
    const wallets = createWallets(source, async () => headAt(head)(), noFees)
    await wallets.get(ME, { from: LAST_2S_BLOCK })
    head += 5
    await wallets.get(ME, { from: LAST_2S_BLOCK })
    // 300 blocks at 200 ms, ending at the last block covered.
    assert.deepEqual(windows.at(-1), [LAST_2S_BLOCK + 701, head])
  })

  describe("dating blocks at 200 ms", () => {
    // Block `LAST_2S_BLOCK` at 18:00:01.000, and the chain's timestamps in whole seconds after it.
    const FIRST_MS = Date.UTC(2026, 10, 5, 18, 0, 1)
    const secondOf = (block: number) => new Date(FIRST_MS + Math.floor(((block - LAST_2S_BLOCK) * 200) / 1000) * 1000).toISOString()
    const headOf = (block: number) => async () => ({ blockNum: block, timestamp: secondOf(block) })
    const balances = async (): Promise<Record<string, string>> => ({ ETH: "7", USDC: "0" })
    const BLOCK = LAST_2S_BLOCK + 5

    it("keeps a fixed read's block on its own second, wherever the head is in its second", async () => {
      for (let head = BLOCK + 1; head <= BLOCK + 10; head++) {
        const { source } = fake(new Map(), () => reference(head), undefined, balances)
        const { latest } = await createWallets(source, headOf(head), noFees).get(ME, { from: BLOCK - 2, to: BLOCK })
        assert.deepEqual(latest, { blockNum: BLOCK, timestamp: secondOf(BLOCK) }, `head ${head}`)
      }
    })

    it("keeps a wallet's opening on its own second as the head moves", async () => {
      for (let head = BLOCK + 1; head <= BLOCK + 10; head++) {
        const { source } = fake(new Map(), () => reference(head), undefined, balances)
        const { legs } = await createWallets(source, headOf(head), noFees).get(ME, { from: BLOCK + 1 })
        assert.equal(legs[0]?.timestamp, secondOf(BLOCK), `head ${head}`)
      }
    })

    it("keeps factsAt's block on its own second too", async () => {
      for (let head = BLOCK + 1; head <= BLOCK + 10; head++) {
        const { source } = fake(new Map(), () => reference(head), undefined, balances)
        const wallets = createWallets(source, headOf(head), noFees)
        await wallets.get(ME)
        const facts = await wallets.factsAt(ME, BLOCK, { withBalances: false })
        assert.deepEqual(facts?.latest, { blockNum: BLOCK, timestamp: secondOf(BLOCK) }, `head ${head}`)
      }
    })

    it("puts an opening just past midnight on the new day", async () => {
      const midnight = LAST_2S_BLOCK + ((Date.UTC(2026, 10, 6) - FIRST_MS) / 1000) * 5
      for (let head = midnight + 1; head <= midnight + 5; head++) {
        const { source } = fake(new Map(), () => reference(head), undefined, balances)
        const { legs } = await createWallets(source, headOf(head), noFees).get(ME, { from: midnight + 1 })
        assert.equal(legs[0]?.timestamp, "2026-11-06T00:00:00.000Z", `head ${head}`)
      }
    })
  })

  it("dates a wallet's opening across the change to 200 ms blocks", async () => {
    const head = LAST_2S_BLOCK + 50
    const { source } = fake(new Map(), () => reference(head), undefined, async (): Promise<Record<string, string>> => ({ ETH: "7", USDC: "0" }))
    const { legs } = await createWallets(source, headAt(head), noFees).get(ME, { from: LAST_2S_BLOCK - 9 })
    // 10 blocks at 2 s, then 50 at 200 ms.
    assert.equal(legs[0]!.timestamp, new Date(Date.parse("2026-11-04T00:00:00.000Z") - 30_000).toISOString())
  })

  it("a failed read takes down neither the wallet nor the check's retry", () =>
    silenced(async () => {
      let fail = true
      let head = 1000
      const { source } = fake(chain(), () => reference(head), undefined, async () => {
        if (fail) throw new Error("rpc down")
        return { ETH: "1" }
      })
      const wallets = createWallets(source, async () => headAt(head)(), noFees)
      const failed = await wallets.get(ME)
      assert.equal(failed.balances, null)
      assert.equal(failed.legs.length, 2)
      fail = false
      head = 1001
      assert.equal((await wallets.get(ME)).balances?.blockNum, 1001)
    }))

  describe("when an opening read fails for one asset", () => {
    const ONE_ETH = "1000000000000000000"
    const held = { ...every("0"), ETH: ONE_ETH }
    const withoutEth = () => {
      const { ETH: _, ...rest } = held
      return rest
    }

    it("leaves that asset unchecked instead of calling an unchanged holding a missing transfer, and still shows it", async () => {
      const { source } = fake(new Map(), () => reference(1000), undefined, async (block) => (block === 899 ? withoutEth() : held))
      const wallet = await createWallets(source, headAt(1000), noFees).get(ME)
      assert.deepEqual(wallet.openingUnread, ["ETH"])
      const portfolio = portfolioOf(wallet, "average")
      const eth = portfolio.positions.find((p) => p.asset === "ETH")!
      assert.equal(eth.reconciliation?.status, "unchecked")
      assert.equal(eth.values.qty, ONE_ETH)
      assert.equal(eth.values.valueMicros, "2400000000")
      assert.equal(eth.pnlMicros, null)
      assert.equal(portfolio.totals.valueMicros, "2400000000")
      assert.deepEqual(portfolio.totals.coverage.value, { known: 1, missing: 0 }, "the chain just said so, so the value isn't an estimate")
      assert.equal(portfolio.totals.pnlMicros, null)
      assert.equal(portfolio.pnlStatus, "unavailable")
      assert.equal(portfolio.points.at(-1)!.pnlMicros, null)
    })

    it("retries it on the next block, and then it reconciles", async () => {
      let head = 1000
      const { source, balanceReads } = fake(new Map(), () => reference(head), undefined, async (block) => (block === 899 && head === 1000 ? withoutEth() : held))
      const wallets = createWallets(source, async () => headAt(head)(), noFees)
      await wallets.get(ME)
      head = 1001
      const wallet = await wallets.get(ME)
      assert.deepEqual(balanceReads.filter((b) => b === 899).length, 2)
      assert.equal(wallet.balances?.amounts.ETH, ONE_ETH)
      assert.deepEqual(wallet.openingUnread, [])
      const eth = portfolioOf(wallet, "average").positions.find((p) => p.asset === "ETH")!
      assert.equal(eth.reconciliation?.status, "reconciled")
      head = 1002
      await wallets.get(ME)
      assert.deepEqual(balanceReads.filter((b) => b === 899).length, 2, "complete now, so it stops")
    })

    it("a retry that fails doesn't lose what was already read", async () => {
      let head = 1000
      const { source } = fake(new Map(), () => reference(head), undefined, async (block) => (block !== 899 ? held : head === 1000 ? withoutEth() : null))
      const wallets = createWallets(source, async () => headAt(head)(), noFees)
      await wallets.get(ME)
      head = 1001
      assert.equal((await wallets.get(ME)).balances?.amounts.USDC, "0")
    })

    it("a closing read missing an asset is retried even if coverage hasn't moved", async () => {
      let head = 1000
      const { source, balanceReads } = fake(new Map(), () => reference(head), () => 1000, async (block) => (block === 1000 && head === 1000 ? withoutEth() : held))
      const wallets = createWallets(source, async () => headAt(head)(), noFees)
      assert.equal((await wallets.get(ME)).balances?.amounts.ETH, undefined)
      head = 1001
      assert.equal((await wallets.get(ME)).balances?.amounts.ETH, ONE_ETH)
      assert.equal(balanceReads.filter((b) => b === 1000).length, 2)
    })
  })

  it("a closing balance alone isn't enough to compare, though it says what's held", async () => {
    const { source } = fake(chain(), () => reference(1000), undefined, async (block) => (block === 899 ? null : { ...every("0"), ETH: "1" }))
    const portfolio = portfolioOf(await createWallets(source, headAt(1000), noFees).get(ME), "average")
    const eth = portfolio.positions.find((p) => p.asset === "ETH")!
    assert.equal(eth.reconciliation?.status, "unchecked")
    assert.equal(eth.values.qty, "1")
  })

  describe("a holding only the chain knows about", () => {
    const ONE_ETH = "1000000000000000000"
    const held = { ...every("0"), ETH: ONE_ETH }
    const without = (asset: string) => Object.fromEntries(Object.entries(held).filter(([a]) => a !== asset))
    /** A wallet with no activity, whose balance reads answer however `closing` says. */
    function wallet(closing: (head: number) => Record<string, string> | null, opening: () => Record<string, string> | null = () => every("0")) {
      let head = 1000
      const { source } = fake(new Map(), () => reference(head), undefined, async (block) => (block === 899 ? opening() : closing(head)))
      const wallets = createWallets(source, async () => headAt(head)(), noFees)
      return { read: async () => portfolioOf(await wallets.get(ME), "average"), next: () => head++ }
    }

    it("stays when the next read fails, as unchecked, and isn't a complete $0", async () => {
      const { read, next } = wallet((head) => (head === 1000 ? held : null))
      const first = await read()
      assert.equal(first.positions.find((p) => p.asset === "ETH")!.reconciliation?.status, "incomplete")
      assert.equal(first.totals.valueMicros, "2400000000")

      next()
      const portfolio = await read()
      const eth = portfolio.positions.find((p) => p.asset === "ETH")!
      assert.equal(eth.reconciliation?.status, "unchecked")
      assert.equal(eth.values.qty, ONE_ETH)
      assert.equal(eth.values.valueMicros, "2400000000")
      assert.equal(eth.pnlMicros, null)
      assert.equal(portfolio.totals.valueMicros, "2400000000")
      assert.deepEqual(portfolio.totals.coverage.value.missing > 0, true, "it's an estimate now")
      assert.equal(portfolio.totals.pnlMicros, null)
      assert.equal(portfolio.pnlStatus, "unavailable")
      assert.ok(portfolio.totals.excluded.some((e) => e.asset === "ETH" && e.reason === "not checked against its actual balance"))
      assert.equal(portfolio.points.at(-1)!.pnlMicros, null)
    })

    it("stays when the read fails for just that asset", async () => {
      const { read, next } = wallet((head) => (head === 1000 ? held : without("ETH")))
      await read()
      next()
      const portfolio = await read()
      assert.equal(portfolio.positions.find((p) => p.asset === "ETH")!.values.qty, ONE_ETH)
      assert.deepEqual(portfolio.unreadAssets, [], "it has a position, so it isn't missing as well")
      assert.equal(portfolio.pnlStatus, "unavailable")
    })

    it("comes back as what it is once a read works", async () => {
      const { read, next } = wallet((head) => (head === 1001 ? null : held))
      await read()
      next()
      assert.equal((await read()).positions.find((p) => p.asset === "ETH")!.reconciliation?.status, "unchecked")
      next()
      const eth = (await read()).positions.find((p) => p.asset === "ETH")!
      assert.equal(eth.reconciliation?.status, "incomplete")
      assert.equal(eth.values.qty, ONE_ETH)
    })

    it("stops being unchecked, and starts matching, when the opening read recovers", async () => {
      let answered = false
      const { read, next } = wallet(() => held, () => {
        const opening = answered ? held : without("ETH")
        answered = true
        return opening
      })
      assert.equal((await read()).positions.find((p) => p.asset === "ETH")!.reconciliation?.status, "unchecked")
      next()
      const portfolio = await read()
      assert.equal(portfolio.positions.find((p) => p.asset === "ETH")!.reconciliation?.status, "reconciled")
      assert.equal(portfolio.totals.excluded.some((e) => e.reason === "not checked against its actual balance"), false)
    })

    it("adds what's moved since the last read, so the amount isn't stale", async () => {
      let head = 1000
      const moves = new Map<number, LegRow[]>()
      const { source } = fake(moves, () => reference(head), undefined, async (block) => (block === 899 ? every("0") : head === 1000 ? { ...every("0"), ETH: "100" } : null))
      const wallets = createWallets(source, async () => headAt(head)(), noFees)
      await wallets.get(ME)
      moves.set(1001, [row(1001, "5")])
      head = 1001
      const eth = portfolioOf(await wallets.get(ME), "average").positions.find((p) => p.asset === "ETH")!
      assert.equal(eth.reconciliation?.status, "unchecked")
      assert.equal(eth.values.qty, "105")
    })
  })

  describe("a balance that was never read", () => {
    it("isn't a confirmed zero: with nothing read, there's no answer", async () => {
      const { source } = fake(new Map(), () => reference(1000), undefined, async () => null)
      const portfolio = portfolioOf(await createWallets(source, headAt(1000), noFees).get(ME), "average")
      assert.deepEqual(portfolio.positions, [])
      assert.deepEqual(portfolio.unreadAssets, [...ASSETS])
      assert.equal(portfolio.totals.valueMicros, null)
      assert.equal(portfolio.totals.pnlMicros, null)
      assert.equal(portfolio.pnlStatus, "unavailable")
      assert.deepEqual(portfolio.totals.excluded.map((e) => e.asset), [...ASSETS])
      assert.ok(portfolio.totals.excluded.every((e) => e.reason === "balance couldn't be read"))
      assert.deepEqual(portfolio.points.map((p) => p.pnlMicros), [null])
    })

    it("a read that failed for one asset leaves the total partial, even if everything else is zero", async () => {
      const { ETH: _, ...others } = every("0")
      const { source } = fake(new Map(), () => reference(1000), undefined, async () => others)
      const portfolio = portfolioOf(await createWallets(source, headAt(1000), noFees).get(ME), "average")
      assert.deepEqual(portfolio.unreadAssets, ["ETH"])
      assert.equal(portfolio.totals.valueMicros, null)
      assert.notEqual(portfolio.pnlStatus, "complete")
    })

    it("a wallet last read as empty is still unknown while its reads fail", async () => {
      let head = 1000
      const { source } = fake(new Map(), () => reference(head), undefined, async () => (head === 1000 ? every("0") : null))
      const wallets = createWallets(source, async () => headAt(head)(), noFees)
      assert.equal(portfolioOf(await wallets.get(ME), "average").pnlStatus, "complete")
      head = 1001
      const portfolio = portfolioOf(await wallets.get(ME), "average")
      assert.deepEqual(portfolio.positions, [])
      assert.equal(portfolio.pnlStatus, "unavailable")
    })

    it("a wallet with everything read as zero is a real zero", async () => {
      const { source } = fake(new Map(), () => reference(1000), undefined, async () => every("0"))
      const portfolio = portfolioOf(await createWallets(source, headAt(1000), noFees).get(ME), "average")
      assert.deepEqual(portfolio.unreadAssets, [])
      assert.equal(portfolio.totals.valueMicros, "0")
      assert.equal(portfolio.pnlStatus, "complete")
    })

    it("isn't reported as unread before reads have started", async () => {
      const { source } = fake(new Map(), () => null, () => null)
      assert.deepEqual((await createWallets(source, headAt(1000), noFees).get(ME)).unreadBalances, [])
    })
  })

  it("adds the L1 fee to its gas leg, keeping both parts", async () => {
    const { source } = fake(chain(), () => reference(1000))
    const fees: ReadL1Fees = async (requests) => new Map(requests.map((r) => [r.txHash, "24"]))
    const { legs, l1FeeUnknownTxs } = await createWallets(source, headAt(1000), fees).get(ME)
    const leg = legs.find((l) => l.kind === "gas")!
    assert.equal(leg.delta, "-1024")
    assert.deepEqual(leg.parts.map((p) => [p.kind, p.amount]), [["gas", "1000"], ["l1_fee", "24"]])
    assert.deepEqual(l1FeeUnknownTxs, [])
  })

  it("reads an L1 fee once when its block is already past the reorg window", async () => {
    let head = 1000
    const reads: number[] = []
    const fees: ReadL1Fees = async (requests) => {
      reads.push(...requests.map((r) => r.blockNum))
      return new Map(requests.map((r) => [r.txHash, "24"]))
    }
    const { source } = fake(chain(), () => reference(head))
    const wallets = createWallets(source, async () => headAt(head)(), fees)
    await wallets.get(ME)
    head = 1001
    await wallets.get(ME)
    assert.deepEqual(reads, [960])
  })

  describe("a reorg that keeps a transaction at the same height", () => {
    const setup = () => {
      let fee = "24"
      const reads: number[] = []
      const fees: ReadL1Fees = async (requests) => {
        reads.push(...requests.map((r) => r.blockNum))
        return new Map(requests.map((r) => [r.txHash, fee]))
      }
      let head = 1000
      const { source } = fake(new Map([[995, [gas(995)]]]), () => reference(head))
      const wallets = createWallets(source, async () => headAt(head)(), fees)
      return { reads, wallets, setFee: (next: string) => (fee = next), setHead: (next: number) => (head = next) }
    }
    const paid = async (wallets: ReturnType<typeof setup>["wallets"]) => (await wallets.get(ME)).legs.find((l) => l.kind === "gas")!.delta

    it("settles on the new fee once its block is past the reorg window, so it can't stay wrong", async () => {
      const { reads, wallets, setFee, setHead } = setup()
      assert.equal(await paid(wallets), "-1024")
      setFee("34")
      setHead(1010)
      assert.equal(await paid(wallets), "-1024", "not re-read on every block")
      setHead(1025)
      assert.equal(await paid(wallets), "-1034")
      assert.deepEqual(reads, [995, 995])
      setHead(1040)
      await paid(wallets)
      assert.deepEqual(reads, [995, 995], "settled now")
    })

    it("keeps the fee it has if that last read fails, and tries again", async () => {
      let answer = true
      const reads: number[] = []
      const fees: ReadL1Fees = async (requests) => {
        reads.push(...requests.map((r) => r.blockNum))
        return new Map(answer ? requests.map((r) => [r.txHash, "24"]) : [])
      }
      let head = 1000
      const { source } = fake(new Map([[995, [gas(995)]]]), () => reference(head))
      const wallets = createWallets(source, async () => headAt(head)(), fees)
      await wallets.get(ME)
      answer = false
      head = 1025
      const wallet = await wallets.get(ME)
      assert.deepEqual(wallet.l1FeeUnknownTxs, [])
      assert.equal(wallet.legs.find((l) => l.kind === "gas")!.delta, "-1024")
      answer = true
      head = 1026
      await wallets.get(ME)
      assert.deepEqual(reads, [995, 995, 995])
    })
  })

  it("reads each L1 fee once, and retries what's missing on the next block", async () => {
    let head = 1000
    let answer = false
    const reads: string[][] = []
    const fees: ReadL1Fees = async (requests) => {
      reads.push(requests.map((r) => r.txHash))
      return new Map(answer ? requests.map((r) => [r.txHash, "24"]) : [])
    }
    const { source } = fake(chain(), () => reference(head))
    const wallets = createWallets(source, async () => headAt(head)(), fees)
    const hash = gas(960).tx_hash
    assert.deepEqual((await wallets.get(ME)).l1FeeUnknownTxs, [hash])
    answer = true
    head = 1001
    assert.deepEqual((await wallets.get(ME)).l1FeeUnknownTxs, [])
    head = 1002
    await wallets.get(ME)
    assert.deepEqual(reads, [[hash], [hash]])
  })

  it("keeps the last ETH balance read with every fee known, while a newer fee can't be read", async () => {
    let head = 1000
    let answer = true
    const fees: ReadL1Fees = async (requests) => new Map(answer ? requests.map((r) => [r.txHash, "24"]) : [])
    const blocks = chain()
    const { source } = fake(blocks, () => reference(head), undefined, async () => every("7"))
    const wallets = createWallets(source, async () => headAt(head)(), fees)
    assert.deepEqual((await wallets.get(ME)).lastCheckableEth, { blockNum: 1000, amount: "7" })

    answer = false
    head = 1001
    blocks.set(1001, [gas(1001)])
    const unread = await wallets.get(ME)
    assert.deepEqual(unread.l1FeeUnknownTxs, [gas(1001).tx_hash])
    assert.deepEqual(unread.lastCheckableEth, { blockNum: 1000, amount: "7" })

    answer = true
    head = 1002
    assert.deepEqual((await wallets.get(ME)).lastCheckableEth, { blockNum: 1002, amount: "7" })
  })

  it("reads an L1 fee again when a reorg moves its transaction to another block", async () => {
    let head = 1000
    const moved = chain()
    const reads: number[] = []
    const fees: ReadL1Fees = async (requests) => {
      reads.push(...requests.map((r) => r.blockNum))
      return new Map(requests.map((r) => [r.txHash, "24"]))
    }
    const { source } = fake(moved, () => reference(head))
    const wallets = createWallets(source, async () => headAt(head)(), fees)
    await wallets.get(ME)
    const tx = moved.get(960)![0]!
    moved.delete(960)
    moved.set(1001, [{ ...tx, block_num: 1001 }])
    head = 1001
    await wallets.get(ME)
    assert.deepEqual(reads, [960, 1001])
  })
})

describe("working out a wallet's response", () => {
  it("does it once until there's a new block", async () => {
    let head = 1000
    const { source } = fake(new Map([[950, [row(950)]], [1001, [row(1001)]]]), () => reference(1000))
    const wallets = createWallets(source, async () => headAt(head)(), noFees)
    const first = await wallets.get(ME)
    assert.equal(await wallets.get(ME), first)
    assert.equal(wallets.peek(ME), first)
    head = 1001
    const next = await wallets.get(ME)
    assert.notEqual(next, first)
    assert.deepEqual(next.legs.filter((leg) => !leg.opening).map((leg) => leg.blockNum), [950, 1001])
  })
})

describe("current prices from the token feeds", () => {
  const AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631"
  const DAI = "0x50c5725949a6f0c72e6c4a641f24049a917db0cb"
  const WSTETH = "0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452"
  const NOW = Date.parse("2026-11-04T00:00:00.000Z") / 1000
  const held = (block: number, token: string): LegRow => ({ ...row(block), token, kind: "erc20", amount: (10n ** 18n).toString() })
  const round = (answer: string, block = 990, updatedAt = NOW - 60): FeedRound => ({ answer, updatedAt, blockNum: block, timestamp: "2026-11-04T00:00:00.000Z" })

  function feedFake(rows: LegRow[], answers: Record<string, FeedRound | undefined>, changes: Partial<Source> = {}) {
    const reads: [readonly string[], number][] = []
    const marketReads: string[] = []
    const { source } = fake(new Map(rows.map((r) => [r.block_num, [r]])), () => reference(1000))
    const withFeeds: Source = {
      ...source,
      marketReady: async () => true,
      async readMarketTrades(asset, _from, to) {
        marketReads.push(asset)
        return [1, 2, 3].map((n) => ({ blockNum: to - n, txHash: `0x${n}`, asset, usdMicros: "1300000", notionalUsdMicros: "500000000" }))
      },
      async readFeedRounds(assets, block) {
        reads.push([assets, block])
        return Object.fromEntries(assets.flatMap((asset) => (answers[asset] ? [[asset, answers[asset]]] : [])))
      },
      ...changes,
    }
    return { source: withFeeds, reads, marketReads }
  }

  it("values what's held at its feed, labeled as an oracle price, ahead of the market", async () => {
    const { source, reads, marketReads } = feedFake([held(950, AERO)], { AERO: round("63000000") })
    const wallet = await createWallets(source, headAt(1000), noFees).get(ME)
    assert.deepEqual(wallet.prices.AERO, { micros: "630000", source: "oracle", blockNum: 990 })
    assert.deepEqual(reads, [[["AERO"], 990], [["AERO"], 900]], "only what's held, at the head's bucket and then for the chart")
    assert.equal(wallet.marketChecked, true)
    assert.ok(marketReads.every((asset) => asset === "AERO"))
    assert.equal(wallet.legs[0]?.priceSource, "market", "a past leg's price isn't what this changes")
  })

  it("shows a price read for a wallet after its response was worked out", async () => {
    let down = true
    const { source } = feedFake([held(950, AERO)], {}, {
      async readMarketTrades(asset, _from, to) {
        if (down) throw new Error("no market")
        return [1, 2, 3].map((n) => ({ blockNum: to - n, txHash: `0x${n}`, asset, usdMicros: "1300000", notionalUsdMicros: "500000000" }))
      },
    })
    const wallets = createWallets(source, headAt(1000), noFees, { warn() {} })
    assert.equal((await wallets.get(ME)).marketMarks[950]?.AERO, undefined)
    down = false
    await wallets.marketOn(ME, (await wallets.factsAt(ME, 1000, { withBalances: false }))!, {})
    assert.equal(wallets.peek(ME)?.marketMarks[950]?.AERO, "1300000")
  })

  it("reads nothing for what a wallet doesn't hold", async () => {
    const { source, reads } = feedFake([], {})
    assert.deepEqual((await createWallets(source, headAt(1000), noFees).get(ME)).prices.AERO, undefined)
    assert.deepEqual(reads, [])
  })

  it("falls back to the market when the feed is too old, in the future or implausible", async () => {
    for (const answers of [{ AERO: round("63000000", 990, NOW - 26 * 3600 - 1) }, { AERO: round("63000000", 990, NOW + 1) }, { AERO: round("1", 990) }, {}]) {
      const { source } = feedFake([held(950, AERO)], answers)
      const wallet = await createWallets(source, headAt(1000), noFees).get(ME)
      assert.equal(wallet.prices.AERO?.source, "market", JSON.stringify(answers))
      assert.equal(wallet.marketChecked, true)
    }
  })

  it("has no price, and doesn't call that no market, with no feed and no trades", async () => {
    const { source } = feedFake([held(950, DAI)], { DAI: round("50000000") }, { readMarketTrades: async () => [] })
    const wallet = await createWallets(source, headAt(1000), noFees).get(ME)
    assert.equal(wallet.prices.DAI, undefined)
    assert.equal(wallet.marketChecked, false, "a depeg or an outage isn't a token nobody trades")
  })

  it("prices an answer in ETH with ETH's price, and has none without it", async () => {
    const rate = { wstETH: round("1250000000000000000") }
    const priced = await createWallets(feedFake([held(950, WSTETH)], rate).source, headAt(1000), noFees).get(ME)
    assert.deepEqual(priced.prices.wstETH, { micros: "3000000000", source: "oracle", blockNum: 990 })
    const noEth = { ...feedFake([held(950, WSTETH)], rate, { readMarketTrades: async () => [] }).source, readLatestReference: async () => null }
    assert.equal((await createWallets(noEth, headAt(1000), noFees).get(ME)).prices.wstETH, undefined)
  })

  it("rejects a USD answer outside bounds that are in ETH", async () => {
    const cbEth = "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22"
    const { source } = feedFake([held(950, cbEth)], { cbETH: round("500000000000") }, { readMarketTrades: async () => [] })
    assert.equal((await createWallets(source, headAt(1000), noFees).get(ME)).prices.cbETH, undefined, "$5,000 is over twice ETH's $2,400")
  })

  it("survives a failed read, and tries again", async () => {
    let fail = true
    const logged: string[] = []
    const logger = { ...console, warn: (message: string) => logged.push(message) }
    const { source } = feedFake([held(950, AERO)], { AERO: round("63000000") }, {
      async readFeedRounds() {
        if (fail) throw new Error("boom")
        return { AERO: round("63000000") }
      },
    })
    let head = 1000
    const wallets = createWallets(source, async () => headAt(head)(), noFees, logger)
    assert.equal((await wallets.get(ME)).prices.AERO?.source, "market")
    assert.match(logged[0] ?? "", /Feed read failed/)
    fail = false
    head = 1001
    assert.equal((await wallets.get(ME)).prices.AERO?.source, "oracle")
  })

  it("reads each feed once per bucket, whichever wallet asks", async () => {
    const OTHER = "0x00000000000000000000000000000000000000bb"
    const { source, reads } = feedFake([held(950, AERO), { ...held(951, AERO), account: OTHER }], { AERO: round("63000000") })
    const wallets = createWallets(source, headAt(1000), noFees)
    await wallets.get(ME)
    await wallets.get(OTHER)
    assert.equal(reads.length, 2, "the head's bucket, and the one both wallets' charts are in")
  })

  it("gives both rules the same answer, each with its own ETH price", async () => {
    const answers = { wstETH: round("1250000000000000000") }
    const first = feedFake([held(950, WSTETH)], answers)
    const second = feedFake([held(950, WSTETH)], {}, { async readFeedRounds() { throw new Error("boom") } })
    const [a, b] = [createWallets(first.source, headAt(1000), noFees), createWallets(second.source, headAt(1000), noFees)]
    await a.get(ME)
    await b.get(ME)
    const facts = (await a.factsAt(ME, 995, { withBalances: false }))!
    const eth = (usd: string) => ({ ETH: { micros: usd, source: "oracle" as const, blockNum: 995 } })
    assert.equal(a.pricedOn(ME, facts, eth("2400000000"), await a.marketOn(ME, facts, eth("2400000000")))!.prices.wstETH?.micros, "3000000000")
    assert.equal(b.pricedOn(ME, facts, eth("2000000000"), await b.marketOn(ME, facts, eth("2000000000")))!.prices.wstETH?.micros, "2500000000", "the other rule's read failed, and the facts still say this")
  })

  it("reads a comparison's feeds at its own block, not at what the last refresh read", async () => {
    const { source, reads } = feedFake([held(950, AERO)], {}, {
      async readFeedRounds(assets, block) {
        reads.push([assets, block])
        return { AERO: round("63000000", block) }
      },
    })
    const wallets = createWallets(source, headAt(1000), noFees)
    await wallets.get(ME)
    const facts = (await wallets.factsAt(ME, 985, { withBalances: false }))!
    assert.deepEqual(reads, [[["AERO"], 990], [["AERO"], 900], [["AERO"], 960]], "the bucket at or before 985")
    assert.deepEqual(wallets.pricedOn(ME, facts, {}, await wallets.marketOn(ME, facts, {}))!.prices.AERO, { micros: "630000", source: "oracle", blockNum: 960 })
  })

  it("isn't \"no market\" when a comparison's feed read fails or is too old", async () => {
    let answer: "fine" | "old" | "fail" = "fine"
    const { source } = feedFake([held(950, AERO)], {}, {
      readMarketTrades: async () => [],
      async readFeedRounds(_, block) {
        if (answer === "fail") throw new Error("boom")
        return { AERO: round("63000000", block, answer === "old" ? NOW - 26 * 3600 - 1 : NOW - 60) }
      },
    })
    const wallets = createWallets(source, headAt(1000), noFees, { ...console, warn: () => {} })
    assert.equal((await wallets.get(ME)).marketChecked, true)
    for (const [through, broken] of [[985, "fail"], [955, "old"]] as const) {
      answer = broken
      const facts = (await wallets.factsAt(ME, through, { withBalances: false }))!
      const compared = wallets.pricedOn(ME, facts, {}, await wallets.marketOn(ME, facts, {}))!
      assert.equal(compared.prices.AERO, undefined, broken)
      assert.equal(compared.marketChecked, false, broken)
    }
  })

  it("doesn't read a market price for a comparison when the feed has one, and falls back to it when not", async () => {
    let answer = "63000000"
    const { source, marketReads } = feedFake([held(950, AERO)], {}, {
      async readFeedRounds(_, block) {
        return { AERO: round(answer, block) }
      },
    })
    const wallets = createWallets(source, headAt(1000), noFees)
    await wallets.get(ME)
    const before = marketReads.length
    const priced = (await wallets.factsAt(ME, 995, { withBalances: false }))!
    const usingFeed = await wallets.marketOn(ME, priced, {})
    assert.equal(marketReads.length, before, "only the movement's bucket, already read")
    assert.equal(wallets.pricedOn(ME, priced, {}, usingFeed)!.prices.AERO?.source, "oracle")
    answer = "1"
    const rejected = (await wallets.factsAt(ME, 985, { withBalances: false }))!
    const usingMarket = await wallets.marketOn(ME, rejected, {})
    assert.equal(wallets.pricedOn(ME, rejected, {}, usingMarket)!.prices.AERO?.source, "market")
  })

  it("reads a stalled wallet's feeds at the head, so its price keeps moving and can go old", async () => {
    let head = 1000
    let updatedAt = NOW - 60
    const { source, reads } = feedFake([held(950, AERO)], {}, {
      processedThrough: async () => 960,
      readMarketTrades: async () => [],
      readFeedRounds: async (assets, block) => {
        reads.push([assets, block])
        return { AERO: round("63000000", block, updatedAt) }
      },
    })
    const wallets = createWallets(source, async () => headAt(head)(), noFees)
    assert.equal((await wallets.get(ME)).prices.AERO?.blockNum, 990, "not 960, where the tables stopped")
    head = 1030
    updatedAt = NOW - 26 * 3600 - 1
    const later = await wallets.get(ME)
    assert.deepEqual(reads.map(([, block]) => block), [990, 900, 1020], "and the chart's once")
    assert.equal(later.prices.AERO, undefined, "the feed itself has gone quiet")
    assert.equal(later.marketChecked, false)
  })

  it("reads a wallet as of a fixed block at that block", async () => {
    const { source, reads } = feedFake([held(950, AERO)], {}, {
      readFeedRounds: async (assets, block) => {
        reads.push([assets, block])
        return { AERO: round("63000000", block) }
      },
    })
    const wallet = await createWallets(source, headAt(1000), noFees).get(ME, { to: 955 })
    assert.deepEqual(reads, [[["AERO"], 930], [["AERO"], 900]])
    assert.equal(wallet.prices.AERO?.blockNum, 930)
  })
})

describe("marking the chart from the token feeds", () => {
  const AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631"
  const DAI = "0x50c5725949a6f0c72e6c4a641f24049a917db0cb"
  const WSTETH = "0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452"
  const NOW = Date.parse("2026-11-04T00:00:00.000Z") / 1000
  const TOO_OLD = NOW - 26 * 3600 - 1
  const holding = (block: number, token = AERO): LegRow => ({ ...row(block), token, kind: "erc20", amount: (10n ** 18n).toString() })
  const round = (answer: string, block: number, updatedAt = NOW - 60): FeedRound => ({ answer, updatedAt, blockNum: block, timestamp: "2026-11-04T00:00:00.000Z" })
  const chainOf = (rows: LegRow[]) => {
    const chain = new Map<number, LegRow[]>()
    for (const r of rows) chain.set(r.block_num, [...(chain.get(r.block_num) ?? []), r])
    return chain
  }

  /** Too little trading to pass the market's guards, unless a test says otherwise. Each feed answers 0.60 plus a cent per 100 blocks of its bucket. */
  function thin(rows: LegRow[], changes: Partial<Source> = {}, latest: () => Reference | null = () => reference(1000)) {
    const feedReads: [readonly string[], number][] = []
    const marketReads: [string, number][] = []
    const { source } = fake(chainOf(rows), latest)
    const withFeeds: Source = {
      ...source,
      historyFrom: (head) => head - 500,
      marketReady: async () => true,
      async readMarketTrades(asset, _, to) {
        marketReads.push([asset, to])
        return []
      },
      async readFeedRounds(assets, block) {
        feedReads.push([assets, block])
        return Object.fromEntries(assets.map((asset) => [asset, round(String(60_000_000 + block * 10_000), block)]))
      },
      ...changes,
    }
    return { source: withFeeds, feedReads, marketReads }
  }

  it("marks a token too thin for the market at each point, so the line doesn't wait for the last one", async () => {
    const paid: LegRow = { ...row(750, (10n ** 15n).toString()), side: "debit" }
    const { source, marketReads } = thin([paid, holding(750), row(950)])
    const wallet = await createWallets(source, headAt(1000), noFees).get(ME)
    assert.deepEqual(wallet.marketMarks, { 750: { AERO: "675000" }, 950: { AERO: "690000" } }, "each at its own bucket's answer, not the latest")
    assert.equal(wallet.prices.AERO?.micros, "699000", "what's held now is still its head bucket's")
    assert.deepEqual(marketReads.filter(([, to]) => to === 750 || to === 900), [], "a market read a feed made unnecessary is a query saved")
    const points = pnlOverTime(wallet.legs, "average", wallet.prices, usdView(wallet).markPrice, wallet.latest)
    const [atBuy, later, last] = points.map((point) => BigInt(point.pnlMicros!))
    assert.deepEqual([later! - atBuy!, last! - later!], [15_000n, 9_000n], "the line only moves by what the feed did")
  })

  it("uses the feed ahead of the market, where both have a price", async () => {
    const { source } = thin([holding(950)], { readMarketTrades: async (asset, _, to) => [1, 2, 3].map((n) => ({ blockNum: to - n, txHash: `0x${n}`, asset, usdMicros: "1300000", notionalUsdMicros: "500000000" })) })
    const wallet = await createWallets(source, headAt(1000), noFees).get(ME)
    assert.equal(wallet.marketMarks[950]?.AERO, "690000")
    assert.equal(wallet.legs[0]?.priceMicros, "1300000", "the leg keeps its market price")
  })

  it("falls back to the market when the answer is too old, in the future, implausible or missing", async () => {
    const answers: (Record<string, FeedRound> | ((block: number) => Record<string, FeedRound>))[] = [
      (block) => ({ AERO: round("63000000", block, TOO_OLD) }),
      (block) => ({ AERO: round("63000000", block, NOW + 1) }),
      (block) => ({ AERO: round("1", block) }),
      {},
    ]
    for (const answer of answers) {
      const { source, marketReads } = thin([holding(950)], {
        async readMarketTrades(asset, _, to) {
          marketReads.push([asset, to])
          return [1, 2, 3].map((n) => ({ blockNum: to - n, txHash: `0x${n}`, asset, usdMicros: "1300000", notionalUsdMicros: "500000000" }))
        },
        readFeedRounds: async (_, block) => (typeof answer === "function" ? answer(block) : answer),
      })
      const wallet = await createWallets(source, headAt(1000), noFees).get(ME)
      assert.equal(wallet.marketMarks[950]?.AERO, "1300000", String(answer))
    }
  })

  it("leaves a point out when neither has a price there", async () => {
    const { source } = thin([holding(950)], { readFeedRounds: async (_, block) => ({ AERO: round("63000000", block, TOO_OLD) }) })
    assert.deepEqual((await createWallets(source, headAt(1000), noFees).get(ME)).marketMarks, {})
  })

  it("prices an answer in ETH with ETH at that point, and needs it", async () => {
    const eth = (block: number) => (block === 750 ? "200000000000" : "240000000000")
    const answers: Partial<Source> = {
      readFeedRounds: async (assets, block) => Object.fromEntries(assets.map((asset) => [asset, round("1250000000000000000", block)])),
      readReferences: async (blocks) => blocks.flatMap((block) => (block === 850 ? [] : [{ ...reference(block), ethUsd: eth(block) }])),
    }
    const { source } = thin([holding(750, WSTETH), holding(850, WSTETH), holding(950, WSTETH)], answers)
    const { marketMarks } = await createWallets(source, headAt(1000), noFees).get(ME)
    assert.equal(marketMarks[750]?.wstETH, "2500000000")
    assert.equal(marketMarks[850], undefined, "no ETH price at that point, so no price for this")
    assert.equal(marketMarks[950]?.wstETH, "3000000000")
  })

  it("asks once per bucket, however many tokens are held", async () => {
    const { source, feedReads } = thin([holding(950), holding(951, DAI), holding(960, WSTETH)])
    await createWallets(source, headAt(1000), noFees).get(ME)
    assert.deepEqual(feedReads.filter(([, block]) => block === 900).map(([assets]) => [...assets].sort()), [["AERO", "DAI", "wstETH"]])
  })

  describe("where a feed gave no answer", () => {
    /** 2 s blocks, so 30 blocks is a minute. Answers nothing at bucket 900 until `answering`. */
    function silent() {
      const state = { head: 1000, answering: false }
      const { source, feedReads } = thin([holding(950)], {
        async readFeedRounds(assets, block) {
          feedReads.push([assets, block])
          return block === 900 && !state.answering ? {} : Object.fromEntries(assets.map((asset) => [asset, round("63000000", block)]))
        },
      })
      const asked = () => feedReads.filter(([, block]) => block === 900).length
      return { state, source, asked, wallets: createWallets(source, async () => headAt(state.head)(), noFees) }
    }

    it("recovers once the feed answers, without a restart", async () => {
      const { state, wallets, asked } = silent()
      assert.deepEqual((await wallets.get(ME)).marketMarks, {})
      state.head = 1001
      assert.deepEqual((await wallets.get(ME)).marketMarks, {})
      assert.equal(asked(), 1, "not asked again straight away")
      state.answering = true
      state.head = 1030
      assert.equal((await wallets.get(ME)).marketMarks[950]?.AERO, "630000")
      state.head = 2000
      await wallets.get(ME)
      assert.equal(asked(), 2, "and an answer isn't asked for again")
    })

    it("waits twice as long each time, then stops asking", async () => {
      const { state, wallets, asked } = silent()
      const askedAt = async (head: number) => {
        state.head = head
        await wallets.get(ME)
        return asked()
      }
      assert.deepEqual([await askedAt(1000), await askedAt(1029), await askedAt(1030), await askedAt(1089), await askedAt(1090)], [1, 1, 2, 2, 3], "1 minute, then 2")
      assert.deepEqual([await askedAt(1209), await askedAt(1210), await askedAt(1450), await askedAt(1930)], [3, 4, 5, 6], "then 4, 8 and 16")
      assert.equal(await askedAt(100_000), 6)
    })

    it("uses the market in the meantime, and the feed once it answers", async () => {
      const state = { head: 1000, answering: false }
      const { source } = thin([holding(950)], {
        readMarketTrades: async (asset, _, to) => [1, 2, 3].map((n) => ({ blockNum: to - n, txHash: `0x${n}`, asset, usdMicros: "1300000", notionalUsdMicros: "500000000" })),
        readFeedRounds: async (assets, block) => (block === 900 && !state.answering ? {} : Object.fromEntries(assets.map((asset) => [asset, round("63000000", block)]))),
      })
      const wallets = createWallets(source, async () => headAt(state.head)(), noFees)
      assert.equal((await wallets.get(ME)).marketMarks[950]?.AERO, "1300000")
      state.answering = true
      state.head = 1030
      assert.equal((await wallets.get(ME)).marketMarks[950]?.AERO, "630000")
    })

    it("asks only the feed that didn't answer again", async () => {
      const { source, feedReads } = thin([holding(950), holding(951, DAI)], {
        async readFeedRounds(assets, block) {
          feedReads.push([assets, block])
          return Object.fromEntries(assets.flatMap((asset) => (block === 900 && asset === "AERO" ? [] : [[asset, round("100000000", block)]])))
        },
      })
      let head = 1000
      const wallets = createWallets(source, async () => headAt(head)(), noFees)
      await wallets.get(ME)
      head = 1030
      const wallet = await wallets.get(ME)
      assert.deepEqual(feedReads.filter(([, block]) => block === 900).map(([assets]) => [...assets].sort()), [["AERO", "DAI"], ["AERO"]])
      assert.equal(wallet.marketMarks[950], undefined, "AERO's still missing, and 950 is before DAI arrives")
      assert.equal(wallet.marketMarks[951]?.DAI, "1000000")
    })

    it("asks every bucket once before asking any again", async () => {
      const rows = [holding(150), ...Array.from({ length: 40 }, (_, i) => row(300 + i * 150))]
      const { source, feedReads } = thin(rows, {
        historyFrom: () => 0,
        async readFeedRounds(assets, block) {
          feedReads.push([assets, block])
          return block < 6000 ? {} : Object.fromEntries(assets.map((asset) => [asset, round("63000000", block)]))
        },
      })
      const NEXT_HEAD = 300 + 39 * 150 + 30
      let head = NEXT_HEAD
      const wallets = createWallets(source, async () => headAt(head)(), noFees)
      const chartReads = () => feedReads.map(([, block]) => block).filter((block) => block < NEXT_HEAD)
      await wallets.get(ME)
      for (head = NEXT_HEAD + 30; new Set(chartReads()).size < 41; head += 30) {
        await wallets.get(ME)
        assert.ok(head < NEXT_HEAD + 3000, "it never got to the oldest")
        if (new Set(chartReads()).size < 41) assert.equal(new Set(chartReads()).size, chartReads().length, "nothing asked twice while something's still unasked")
      }
    })

    it("forgets that in a reorg of that block, so what replaced it is asked straight away", async () => {
      const { wallets, asked } = silent()
      await wallets.get(ME)
      await wallets.rewind(900, 1000)
      await wallets.get(ME)
      assert.equal(asked(), 2)
    })
  })

  it("tries a failed read again, without calling what prices the wallet unchecked", async () => {
    let fail = true
    let head = 1000
    const answer: Source["readFeedRounds"] = async (assets, block) => {
      if (fail && block === 900) throw new Error("boom")
      return Object.fromEntries(assets.map((asset) => [asset, round("63000000", block)]))
    }
    const { source } = thin([holding(950)], { readFeedRounds: answer })
    const wallets = createWallets(source, async () => headAt(head)(), noFees, { ...console, warn: () => {} })
    const failed = await wallets.get(ME)
    assert.deepEqual([failed.marketMarks, failed.marketChecked], [{}, true])
    fail = false
    head = 1001
    assert.equal((await wallets.get(ME)).marketMarks[950]?.AERO, "630000")
  })

  it("still marks from the market while feed reads keep failing, and from the feeds while market reads do", async () => {
    const quiet = { ...console, warn: () => {} }
    const market = thin([holding(950)], {
      readMarketTrades: async (asset, _, to) => [1, 2, 3].map((n) => ({ blockNum: to - n, txHash: `0x${n}`, asset, usdMicros: "1300000", notionalUsdMicros: "500000000" })),
      readFeedRounds: async () => {
        throw new Error("boom")
      },
    })
    assert.equal((await createWallets(market.source, headAt(1000), noFees, quiet).get(ME)).marketMarks[950]?.AERO, "1300000")
    const feed = thin([holding(950)], {
      readMarketTrades: async () => {
        throw new Error("boom")
      },
    })
    const wallet = await createWallets(feed.source, headAt(1000), noFees, quiet).get(ME)
    assert.deepEqual([wallet.marketMarks[950]?.AERO, wallet.marketChecked], ["690000", false])
  })

  it("forgets answers from a reorg's blocks, and keeps the ones before it", async () => {
    const { source, feedReads } = thin([holding(750), row(950)])
    const wallets = createWallets(source, headAt(1000), noFees)
    await wallets.get(ME)
    await wallets.rewind(900, 1000)
    feedReads.length = 0
    await wallets.get(ME)
    assert.deepEqual(feedReads.map(([, block]) => block).filter((block) => block < 990), [900], "not 750's")
  })

  it("doesn't keep an answer read across a reorg", async () => {
    let wallets: ReturnType<typeof createWallets>
    let rewinding: Promise<void> | undefined
    const { source } = thin([holding(950)], {
      async readFeedRounds(assets, block) {
        if (block === 900 && !rewinding) rewinding = wallets.rewind(900, 1000)
        return Object.fromEntries(assets.map((asset) => [asset, round("63000000", block)]))
      },
    })
    wallets = createWallets(source, headAt(1000), noFees)
    const wallet = await wallets.get(ME)
    await rewinding
    assert.deepEqual(wallet.marketMarks, {})
  })

  it("marks without a dataset that can be read for market prices", async () => {
    const { source, marketReads } = thin([holding(950)], { marketReady: async () => false })
    const wallet = await createWallets(source, headAt(1000), noFees).get(ME)
    assert.equal(wallet.marketMarks[950]?.AERO, "690000")
    assert.deepEqual([marketReads, wallet.marketChecked], [[], false])
  })

  it("marks both rules from the same answers in a comparison, each with its own ETH", async () => {
    const ethAt = (usd: string): Partial<Source> => ({ readReferences: async (blocks) => blocks.map((block) => ({ ...reference(block), ethUsd: usd })) })
    const answer = { readFeedRounds: async (assets: readonly string[], block: number) => Object.fromEntries(assets.map((asset) => [asset, round("1250000000000000000", block)])) }
    const a = createWallets(thin([holding(950, WSTETH)], { ...answer, ...ethAt("240000000000") }).source, headAt(1000), noFees)
    const b = createWallets(thin([holding(950, WSTETH)], { ...ethAt("200000000000"), readFeedRounds: async () => { throw new Error("boom") } }).source, headAt(1000), noFees, { ...console, warn: () => {} })
    await a.get(ME)
    await b.get(ME)
    const facts = (await a.factsAt(ME, 995, { withBalances: false }))!
    const [byA, byB] = [a.pricedOn(ME, facts, {}, await a.marketOn(ME, facts, {}))!, b.pricedOn(ME, facts, {}, await b.marketOn(ME, facts, {}))!]
    assert.equal(byA.marketMarks[950]?.wstETH, "3000000000")
    assert.equal(byB.marketMarks[950]?.wstETH, "2500000000", "the other rule's read failed, and the facts still say this")
  })

  describe("on a busy wallet", () => {
    const rows = [holding(150), ...Array.from({ length: 40 }, (_, i) => row(300 + i * 150))]
    const HEAD = 300 + 39 * 150
    // A head in a bucket of its own, so the head's feed read can't pass for one of the chart's.
    const NEXT_HEAD = HEAD + 30
    const chartFeedReads = (reads: [readonly string[], number][]) => reads.filter(([, block]) => block < NEXT_HEAD)

    it("shares the chart's read limit, newest first", async () => {
      const { source, feedReads, marketReads } = thin(rows, { historyFrom: () => 0 })
      let head = NEXT_HEAD
      const wallets = createWallets(source, async () => headAt(head)(), noFees)
      const first = await wallets.get(ME)
      assert.deepEqual([chartFeedReads(feedReads).length, marketReads.length], [19, 1], "the market read that prices the leg comes first, and a feed's read costs the same")
      assert.equal(first.marketChecked, true, "all that's waiting is chart points")
      assert.ok(first.marketMarks[HEAD]?.AERO)
      assert.equal(first.marketMarks[300], undefined, "the oldest waits")
      head += 1
      const second = await wallets.get(ME)
      assert.equal(chartFeedReads(feedReads).length, 39, "the next 20")
      head += 1
      const third = await wallets.get(ME)
      assert.equal(chartFeedReads(feedReads).length, 41, "only what's left")
      assert.ok(Object.keys(second.marketMarks).length > Object.keys(first.marketMarks).length)
      assert.equal(third.marketMarks[300]?.AERO, "630000")
    })

    it("leaves a chart's feeds waiting while what prices the wallet takes the limit", async () => {
      const { source, feedReads, marketReads } = thin(Array.from({ length: 30 }, (_, i) => holding(300 + i * 150)), { historyFrom: () => 0 })
      await createWallets(source, headAt(NEXT_HEAD), noFees).get(ME)
      assert.deepEqual([marketReads.length, chartFeedReads(feedReads).length], [20, 0])
    })

    describe("read as of a fixed block, which has no new block coming", () => {
      const RANGE = { from: 1, to: HEAD }
      const settled = async () => headAt(HEAD + 1000)()
      const readBalances: Source["readBalances"] = async (_, block) => ({ blockNum: block, amounts: Object.fromEntries(ASSETS.map((asset) => [asset, "0"])) })
      const marked = (wallet: { marketMarks: Record<string, unknown> }) => Object.keys(wallet.marketMarks).length

      it("keeps reading what the limit left, then stops", async () => {
        const { source, feedReads } = thin(rows, { readBalances })
        const wallets = createWallets(source, settled, noFees)
        const read = async () => [marked(await wallets.get(ME, RANGE)), feedReads.length]
        const [first, second, third] = [await read(), await read(), await read()]
        assert.deepEqual([first[0], second[0], third[0]], [19, 39, 41], "the first refresh's limit also pays for the market read that prices the leg")
        assert.deepEqual(await read(), third, "there's nothing left to read")
      })

      it("stops at a feed that never answers, and only reads again when it's time to ask", async () => {
        const { source, feedReads, marketReads } = thin([holding(150), row(300)], { readBalances, readEthBalances: async (_, blocks) => new Map(blocks.map((block) => [block, "0"])), readFeedRounds: async (assets, block) => (feedReads.push([assets, block]), {}) })
        const asked = () => feedReads.filter(([, block]) => block === 300).length
        let head = HEAD + 1000
        const wallets = createWallets(source, async () => headAt(head)(), noFees)
        const range = { from: 1, to: 340 }
        await wallets.get(ME, range)
        const reads = feedReads.length + marketReads.length
        await wallets.get(ME, range)
        assert.equal(feedReads.length + marketReads.length, reads, "with no new head, nothing's due")
        for (let i = 0; i < 8; i += 1) {
          head += 100_000
          await wallets.get(ME, range)
        }
        assert.equal(asked(), 6)
        const allReads = feedReads.length + marketReads.length
        head += 100_000
        await wallets.get(ME, range)
        assert.equal(feedReads.length + marketReads.length, allReads, "nothing's left to ask")
      })
    })
  })
})

describe("looking for ETH a token's sale brought in", () => {
  const send = (block: number): LegRow => ({ ...row(block, "5"), token: USDC_ADDRESS, side: "debit", kind: "erc20" })
  const allFees: ReadL1Fees = async (requests) => new Map(requests.map((r) => [r.txHash, "0"]))
  const every = (amount: string) => Object.fromEntries(ASSETS.map((asset) => [asset, amount]))
  const held = (eth: string) => async (block: number) => (block === 899 ? every("0") : { ...every("0"), ETH: eth })
  const rises = (block: number, amount: bigint) => async (blocks: readonly number[]) => new Map(blocks.map((b) => [b, (b >= block ? amount : 0n).toString()]))

  it("reads nothing for a wallet whose ETH adds up, however many tokens it sent", async () => {
    const { source, ethReads } = fake(new Map([[950, [send(950)]], [960, [send(960)]]]), () => reference(1000), undefined, held("0"))
    const wallet = await createWallets(source, headAt(1000), allFees).get(ME)
    assert.deepEqual(ethReads, [])
    assert.deepEqual(wallet.unseenEth, [])
    assert.ok(wallet.legs.every((l) => l.kind === "transfer"))
  })

  it("reads nothing while ETH's own balance is unknown, because that can't say it doesn't add up", async () => {
    const { source, ethReads } = fake(new Map([[950, [send(950)]]]), () => reference(1000))
    await createWallets(source, headAt(1000), allFees).get(ME)
    assert.deepEqual(ethReads, [])
  })

  it("reads each send's block when it doesn't, then marks the one where ETH rose", async () => {
    const { source, ethReads } = fake(new Map([[950, [send(950)]], [960, [send(960)]]]), () => reference(1000), undefined, held("800"), rises(960, 800n))
    const wallet = await createWallets(source, headAt(1000), allFees).get(ME)
    assert.deepEqual(ethReads, [[949, 950, 959, 960]])
    assert.deepEqual(wallet.unseenEth, [{ blockNum: 960, amount: "800", txHashes: [`0x${(960).toString(16)}`] }])
    // The ETH counts, for the rise, and the sale it may have come from still has no value.
    assert.deepEqual(wallet.legs.map((l) => [l.kind, l.asset]), [["transfer", "USDC"], ["transfer", "ETH"], ["swap", "USDC"]])
    assert.equal(portfolioOf({ ...wallet }, "average").positions.find((p) => p.asset === "ETH")!.reconciliation?.status, "reconciled")
  })

  describe("when ETH arrives with a sale, and later leaves unseen", () => {
    const E18 = 10n ** 18n
    const ethRow = (block: number, side: LegRow["side"]): LegRow => ({ ...row(block, E18.toString()), side })
    // 1 ETH arrives unseen at 950 as a token leaves, and leaves visibly at 960. Another arrives visibly at 970, and leaves unseen at 980.
    const chain = () => new Map([[950, [send(950)]], [960, [ethRow(960, "debit")]], [970, [ethRow(970, "credit")]]])
    const onchain = async (blocks: readonly number[]) => new Map(blocks.map((b) => [b, (b >= 950 && b < 960) || (b >= 970 && b < 980) ? E18.toString() : "0"]))
    const ranges: [string, { from: number; to: number } | undefined, number][] = [["a live read", undefined, 1000], ["a read as of a fixed block", { from: 900, to: 990 }, 2000]]

    for (const [name, range, head] of ranges) {
      it(`${name} still looks, marks the send and names it`, async () => {
        const { source, ethReads } = fake(chain(), () => reference(head), undefined, held("0"), onchain)
        const wallet = await createWallets(source, headAt(head), allFees).get(ME, range)
        // The sale's block first, because more ETH left than arrived. Then what's still off is searched for.
        assert.deepEqual(ethReads[0], [949, 950])
        assert.ok(ethReads.length > 1)
        const tx = `0x${(950).toString(16)}`
        assert.deepEqual(wallet.unseenEth, [{ blockNum: 950, amount: E18.toString(), txHashes: [tx] }])
        const sale = wallet.legs.find((l) => l.txHash === tx)!
        assert.deepEqual([sale.kind, sale.proceedsMicros], ["swap", null])
        for (const method of ["average", "fifo"] as const) {
          const { positions } = foldWallet(wallet, method)
          const eth = positions.find((p) => p.asset === "ETH")!
          assert.equal(eth.state.shortfallQty, "0")
          assert.ok(eth.reconciliation?.status === "incomplete" && eth.reconciliation.differenceQty === (-E18).toString())
          assert.ok(explainMetric(eth, "onchain", USD_CONTEXT).lines.some((line) => line.startsWith("It lines up") && line.includes(shortHash(tx))))
          assert.equal(positions.find((p) => p.asset === "USDC")!.values.realizedMicros, null)
        }
      })
    }

    it("a wallet whose ETH left only after it arrived needs no reads", async () => {
      const inOrder = new Map([[950, [send(950)]], [955, [ethRow(955, "credit")]], [960, [ethRow(960, "debit")]]])
      const { source, ethReads } = fake(inOrder, () => reference(1000), undefined, held("0"), rises(950, E18))
      assert.deepEqual((await createWallets(source, headAt(1000), allFees).get(ME)).unseenEth, [])
      assert.deepEqual(ethReads, [])
    })
  })

  it("caps what one refresh reads, and catches up on the next", async () => {
    let head = 1000
    const chain = new Map(Array.from({ length: 300 }, (_, i) => [i * 3 + 100, [send(i * 3 + 100)]] as [number, LegRow[]]))
    const { source, ethReads } = fake(chain, () => reference(head), undefined, async (block) => (block < 100 ? every("0") : { ...every("0"), ETH: "800" }), rises(10_000, 0n))
    const wallets = createWallets({ ...source, historyFrom: (head) => head - 950 }, async () => headAt(head)(), allFees)
    await wallets.get(ME)
    assert.equal(ethReads[0]!.length, 400)
    head = 1001
    await wallets.get(ME)
    assert.equal(ethReads[1]!.length, 200)
    const read = ethReads.length
    head = 1002
    await wallets.get(ME)
    // Only what's still re-read for reorgs.
    assert.ok(ethReads.slice(read).flat().every((block) => block >= 1002 - 31))
  })

  it("keeps the wallet up when the read fails, and tries again", async () => {
    let head = 1000
    let fail = true
    const read = async (blocks: readonly number[]) => {
      if (fail) throw new Error("no RPC")
      return rises(950, 800n)(blocks)
    }
    const { source } = fake(new Map([[950, [send(950)]]]), () => reference(head), undefined, held("800"), read)
    const original = console.warn
    console.warn = () => {}
    try {
      const wallets = createWallets(source, async () => headAt(head)(), allFees)
      assert.deepEqual((await wallets.get(ME)).unseenEth, [])
      fail = false
      head = 1001
      assert.equal((await wallets.get(ME)).unseenEth.length, 1)
    } finally {
      console.warn = original
    }
  })

  it("finishes a wallet read as of a fixed block without a new block to prompt it", async () => {
    let answers = false
    const read = async (blocks: readonly number[]) => (answers ? rises(950, 800n)(blocks) : new Map<number, string>())
    const { source, ethReads } = fake(new Map([[950, [send(950)]]]), () => reference(2000), undefined, held("800"), read)
    const wallets = createWallets(source, headAt(2000), allFees)
    assert.deepEqual((await wallets.get(ME, { from: 900, to: 960 })).unseenEth, [])
    answers = true
    assert.equal((await wallets.get(ME, { from: 900, to: 960 })).unseenEth.length, 1)
    const reads = ethReads.length
    await wallets.get(ME, { from: 900, to: 960 })
    assert.equal(ethReads.length, reads)
  })
})

describe("market prices, notes and unlisted tokens", () => {
  const AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631"
  const trades = (block: number, usdMicros = "1300000") => [1, 2, 3].map((n) => ({ blockNum: block - n, txHash: `0x${n}`, asset: "AERO", usdMicros, notionalUsdMicros: "500000000" }))
  const aeroRow = (block: number): LegRow => ({ ...row(block), token: AERO, kind: "erc20", amount: (10n ** 18n).toString() })

  function marketFake(chain: Map<number, LegRow[]>, changes: Partial<Source>) {
    const reads: [string, number, number][] = []
    const { source } = fake(chain, () => reference(1000))
    const withMarket: Source = {
      ...source,
      marketReady: async () => true,
      async readMarketTrades(asset, from, to) {
        reads.push([asset, from, to])
        return trades(to)
      },
      ...changes,
    }
    return { source: withMarket, reads }
  }

  it("prices a plain transfer from its market at or before that block, and what's held at the head", async () => {
    const { source, reads } = marketFake(new Map([[950, [aeroRow(950)]]]), {})
    const wallet = await createWallets(source, headAt(1000), noFees).get(ME)
    assert.equal(wallet.marketChecked, true)
    assert.equal(wallet.legs[0]?.priceSource, "market")
    assert.equal(wallet.legs[0]?.priceMicros, "1300000")
    assert.equal(wallet.prices.AERO?.source, "market")
    assert.ok(reads.every(([, , to]) => to <= 1000))
    assert.ok(reads.some(([, , to]) => to <= 950), "the leg's own price comes from at or before its block")
  })

  it("keeps a market read's bucket and age about as long in time after the 200 ms upgrade", async () => {
    const head = LAST_2S_BLOCK + 20_000
    const { source, reads } = marketFake(new Map([[LAST_2S_BLOCK + 19_000, [aeroRow(LAST_2S_BLOCK + 19_000)]]]), { startBlock: LAST_2S_BLOCK + 18_000 })
    await createWallets(source, headAt(head), noFees).get(ME)
    const bucket = head - (head % 300)
    assert.ok(reads.some(([, from, to]) => to === bucket && msBetweenBlocks(from, to) === 1_800_000), JSON.stringify(reads))
  })

  it("doesn't read a dataset whose priced_legs can't be trusted, and doesn't call that no market", async () => {
    let read = false
    const { source } = marketFake(new Map([[950, [aeroRow(950)]]]), {
      marketReady: async () => false,
      async readMarketTrades() {
        read = true
        return []
      },
    })
    const wallet = await createWallets(source, headAt(1000), noFees).get(ME)
    assert.equal(read, false)
    assert.equal(wallet.marketChecked, false)
    assert.equal(wallet.legs[0]?.priceMicros, null)
  })

  it("says so when a read fails, gives no price, and tries again", async () => {
    let fail = true
    const { source } = marketFake(new Map([[950, [aeroRow(950)]]]), {
      async readMarketTrades(_, __, to) {
        if (fail) throw new Error("boom")
        return trades(to)
      },
    })
    let head = 1000
    const wallets = createWallets(source, async () => headAt(head)(), noFees)
    const failed = await wallets.get(ME)
    assert.equal(failed.marketChecked, false)
    assert.equal(failed.legs[0]?.priceMicros, null, "a failed read is no price, never a stale or zero one")
    fail = false
    head = 1001
    const retried = await wallets.get(ME)
    assert.equal(retried.marketChecked, true)
    assert.equal(retried.legs[0]?.priceMicros, "1300000")
  })

  it("has no market to check on a source without one", async () => {
    const { source } = fake(new Map([[950, [aeroRow(950)]]]), () => reference(1000))
    assert.equal((await createWallets(source, headAt(1000), noFees).get(ME)).marketChecked, false)
  })

  it("only reads a thin market once, and treats it as no price", async () => {
    let count = 0
    const { source } = marketFake(new Map([[950, [aeroRow(950)]]]), {
      async readMarketTrades() {
        count++
        return []
      },
    })
    let head = 1000
    const wallets = createWallets(source, async () => headAt(head)(), noFees)
    const first = await wallets.get(ME)
    assert.equal(first.marketChecked, true)
    assert.equal(first.legs[0]?.priceMicros, null)
    const after = count
    head = 1001
    await wallets.get(ME)
    assert.equal(count, after)
  })

  it("gives each rule its own market prices and check on one set of facts", async () => {
    const note = { noteTx: "0x1", blockNum: 999, txHash: "0x2", asset: "AERO", usdMicros: "5" }
    const first = marketFake(new Map([[950, [aeroRow(950)]]]), { readNotes: async () => [note] })
    const second = marketFake(new Map([[950, [aeroRow(950)]]]), { async readMarketTrades() { throw new Error("boom") } })
    const [a, b] = [createWallets(first.source, headAt(1000), noFees), createWallets(second.source, headAt(1000), noFees)]
    await a.get(ME)
    await b.get(ME)
    const facts = (await a.factsAt(ME, 995, { withBalances: false }))!
    const [marketA, marketB] = [await a.marketOn(ME, facts, {}), await b.marketOn(ME, facts, {})]
    assert.deepEqual([marketB.priced.size, marketB.checked], [0, false])
    const [byA, byB] = [a.pricedOn(ME, facts, {}, marketA)!, b.pricedOn(ME, facts, {}, marketB)!]
    assert.deepEqual([byA.prices.AERO?.source, byA.marketChecked], ["market", true])
    assert.deepEqual([byB.prices.AERO, byB.marketChecked], [undefined, false])
    assert.deepEqual(byA.legs.find((l) => l.asset === "AERO")?.priceSource, "market")
    assert.deepEqual(byB.legs.find((l) => l.asset === "AERO")?.priceSource, null)
    const older = (await a.factsAt(ME, 960, { withBalances: false }))!
    const atOlder = a.pricedOn(ME, older, {}, await a.marketOn(ME, older, {}))!
    assert.ok(atOlder.prices.AERO!.blockNum <= 960, "a price from after that block would be the wrong one")
    assert.deepEqual(older.notes, [], "nor a note from after it")
    assert.deepEqual([byA.marketMarks[950]?.AERO, byB.marketMarks[950]], ["1300000", undefined], "a chart's prices come from each rule's own trades too")
  })

  it("marks what's held at each later transaction's block, from at or before it", async () => {
    const { source, reads } = marketFake(new Map([[900, [row(900)]], [950, [aeroRow(950)]], [980, [row(980)]]]), {})
    const wallet = await createWallets(source, headAt(1000), noFees).get(ME)
    assert.deepEqual(wallet.marketMarks, { 950: { AERO: "1300000" }, 980: { AERO: "1300000" } })
    assert.equal(reads.filter(([, , to]) => to === 900).length, 1, "950 and 980 share a read, and 900 isn't held yet")
    assert.deepEqual(wallet.legs.map((l) => l.blockNum), [900, 950, 980], "and nothing else changes")
  })

  it("leaves a block out when too little trading backs a price there", async () => {
    const { source } = marketFake(new Map([[950, [aeroRow(950)]], [980, [row(980)]]]), {
      async readMarketTrades() {
        return []
      },
    })
    assert.deepEqual((await createWallets(source, headAt(1000), noFees).get(ME)).marketMarks, {})
  })

  describe("on a busy wallet", () => {
    const busy = new Map([[150, [aeroRow(150)]], ...Array.from({ length: 40 }, (_, i): [number, LegRow[]] => [300 + i * 150, [row(300 + i * 150)]])])
    const HEAD = 300 + 39 * 150

    it("reads what prices the wallet first, and fills in the chart over the next refreshes, newest first", async () => {
      const { source, reads } = marketFake(busy, { historyFrom: (head) => head - HEAD })
      let head = HEAD
      const wallets = createWallets(source, async () => headAt(head)(), noFees)
      const first = await wallets.get(ME)
      assert.equal(reads.length, 20, "the same limit as before")
      assert.equal(first.marketChecked, true, "all that's waiting is chart points")
      assert.equal(first.legs[0]?.priceMicros, "1300000")
      assert.equal(first.prices.AERO?.source, "market")
      assert.equal(first.marketMarks[HEAD]?.AERO, "1300000")
      assert.equal(first.marketMarks[450], undefined, "not read yet, so it has no price")
      head += 1
      const second = await wallets.get(ME)
      head += 1
      const third = await wallets.get(ME)
      assert.equal(second.marketChecked, true)
      assert.ok(Object.keys(third.marketMarks).length > Object.keys(first.marketMarks).length)
      assert.equal(third.marketMarks[450]?.AERO, "1300000")
    })

    it("still calls what prices the wallet checked when a read for the chart fails", async () => {
      let count = 0
      const { source } = marketFake(busy, {
        historyFrom: (head) => head - HEAD,
        async readMarketTrades(_, __, to) {
          if (++count > 5) throw new Error("boom")
          return trades(to)
        },
      })
      const wallet = await createWallets(source, headAt(HEAD), noFees).get(ME)
      assert.equal(count, 6, "it stops at the first failure")
      assert.equal(wallet.marketChecked, true)
      assert.equal(wallet.legs[0]?.priceMicros, "1300000")
    })

    describe("read as of a fixed block, which has no new block coming", () => {
      const RANGE = { from: 1, to: HEAD }
      const settled = async () => headAt(HEAD + 1000)()
      const readBalances: Source["readBalances"] = async (_, block) => ({ blockNum: block, amounts: Object.fromEntries(ASSETS.map((asset) => [asset, "0"])) })
      const marked = (wallet: { marketMarks: Record<string, unknown> }) => Object.keys(wallet.marketMarks).length

      it("keeps reading what the limit left, then stops", async () => {
        const { source, reads } = marketFake(busy, { readBalances })
        const wallets = createWallets(source, settled, noFees)
        assert.deepEqual([marked(await wallets.get(ME, RANGE)), reads.length], [20, 20])
        assert.deepEqual([marked(await wallets.get(ME, RANGE)), reads.length], [40, 40])
        assert.deepEqual([marked(await wallets.get(ME, RANGE)), reads.length], [41, 41])
        assert.deepEqual([marked(await wallets.get(ME, RANGE)), reads.length], [41, 41], "there's nothing left to read")
      })

      it("tries a failed read for the chart again, without calling what prices the wallet unchecked", async () => {
        let fail = true
        let count = 0
        const { source } = marketFake(busy, {
          readBalances,
          async readMarketTrades(_, __, to) {
            if (fail && ++count === 5) throw new Error("boom")
            return trades(to)
          },
        })
        const wallets = createWallets(source, settled, noFees)
        const failed = await wallets.get(ME, RANGE)
        assert.equal(failed.marketChecked, true)
        assert.equal(marked(failed), 4)
        fail = false
        const retried = await wallets.get(ME, RANGE)
        assert.equal(retried.marketChecked, true)
        assert.equal(marked(retried), 24)
      })

      it("tries a failed read of a price the wallet needs again, and says so until it works", async () => {
        let fail = true
        const { source } = marketFake(busy, {
          readBalances,
          async readMarketTrades(_, __, to) {
            if (fail) throw new Error("boom")
            return trades(to)
          },
        })
        const wallets = createWallets(source, settled, noFees)
        assert.equal((await wallets.get(ME, RANGE)).marketChecked, false)
        fail = false
        const retried = await wallets.get(ME, RANGE)
        assert.equal(retried.marketChecked, true)
        assert.equal(retried.legs[0]?.priceMicros, "1300000")
      })

      it("doesn't keep reading a dataset whose priced_legs can't be trusted, or a source with no market", async () => {
        let checks = 0
        const { source, windows } = fake(busy, () => reference(HEAD))
        const untrusted = createWallets({ ...source, readBalances, marketReady: async () => (checks++, false), readMarketTrades: async () => [] }, settled, noFees)
        await untrusted.get(ME, RANGE)
        await untrusted.get(ME, RANGE)
        assert.equal(checks, 1)
        const none = createWallets({ ...source, readBalances }, settled, noFees)
        const before = windows.length
        const first = await none.get(ME, RANGE)
        assert.equal(await none.get(ME, RANGE).then((w) => w.coverage.toBlock), first.coverage.toBlock)
        assert.equal(windows.length, before + 1)
      })
    })
  })

  it("reads a market price for the block it's asked about, when the wallet was read in another bucket", async () => {
    const { source, reads } = marketFake(new Map([[950, [aeroRow(950)]]]), {})
    const wallets = createWallets(source, headAt(1000), noFees)
    await wallets.get(ME)
    const facts = (await wallets.factsAt(ME, 985, { withBalances: false }))!
    reads.length = 0
    const market = await wallets.marketOn(ME, facts, {})
    assert.deepEqual(reads.map(([asset, , to]) => [asset, to]), [["AERO", 960]])
    assert.equal(market.checked, true)
    assert.ok(market.priced.has("AERO:960"))
    assert.equal(wallets.pricedOn(ME, facts, {}, market)!.prices.AERO?.source, "market")
  })

  it("uses only the market prices it's given, for what's held and for what moved", async () => {
    const { source } = marketFake(new Map([[950, [aeroRow(950)]]]), {})
    const wallets = createWallets(source, headAt(1000), noFees)
    await wallets.get(ME)
    const facts = (await wallets.factsAt(ME, 995, { withBalances: false }))!
    await wallets.marketOn(ME, facts, {})
    const wallet = wallets.pricedOn(ME, facts, {}, { priced: new Set(), checked: false })!
    assert.equal(wallet.prices.AERO, undefined)
    assert.equal(wallet.legs.find((l) => l.asset === "AERO")?.priceMicros, null)
    assert.equal(wallet.marketChecked, false, "a token left out for this has a market")
  })

  it("two rules share a market price only when both have it", () => {
    const one = { priced: new Set(["AERO:0", "DEGEN:0"]), checked: true }
    assert.deepEqual(sharedMarket(one, one), { priced: new Set(["AERO:0", "DEGEN:0"]), checked: true })
    assert.deepEqual(sharedMarket(one, { priced: new Set(["AERO:0"]), checked: true }), { priced: new Set(["AERO:0"]), checked: false })
    assert.deepEqual(sharedMarket({ priced: new Set(), checked: true }, { priced: new Set(), checked: false }), { priced: new Set(), checked: false })
  })

  it("looks for notes only in transactions with nothing but gas, and passes along what it finds", async () => {
    const gas = (block: number): LegRow => ({ ...row(block), side: "debit", kind: "gas", tx_hash: `0xg${block}` })
    const asked: number[][] = []
    const note = { noteTx: "0xg950", blockNum: 950, txHash: "0x1", asset: "USDC", usdMicros: "5" }
    const { source } = fake(new Map([[950, [gas(950)]], [960, [gas(960), { ...row(960), tx_hash: "0xg960" }]]]), () => reference(1000))
    source.readNotes = async (_, blocks) => {
      asked.push([...blocks])
      return blocks.includes(950) ? [note] : []
    }
    const wallet = await createWallets(source, headAt(1000), async () => new Map()).get(ME)
    assert.deepEqual(asked, [[950]])
    assert.deepEqual(wallet.notes, [note])
  })
})

describe("settling unwrap credits", () => {
  const BLOCK = 950
  const TX = `0x${BLOCK.toString(16)}`
  const gas = (block = BLOCK, tx = TX): LegRow => ({ ...row(block, "100"), tx_hash: tx, side: "debit", kind: "gas" })
  const claim = (block = BLOCK, tx = TX): LegRow => ({ ...row(block, "1000"), tx_hash: tx, kind: "unwrap" })
  const allFees: ReadL1Fees = async (requests) => new Map(requests.map((r) => [r.txHash, "0"]))
  const nothingArrived = async (blocks: readonly number[]) => new Map(blocks.map((b) => [b, b === BLOCK ? "4900" : "5000"]))
  const TX990 = `0x${(990).toString(16)}`
  const ethDeltas = (legs: { asset: string; kind: string; delta: string }[]) => legs.filter((l) => l.asset === "ETH" && l.kind !== "gas").map((l) => l.delta)

  it("reads the balance on both sides of the block, and only for those blocks", async () => {
    const chain = new Map([[BLOCK, [gas(), claim()]], [960, [row(960)]]])
    const { source, ethReads } = fake(chain, () => reference(1000), undefined, undefined, nothingArrived)
    const wallet = await createWallets(source, headAt(1000), allFees).get(ME)
    assert.deepEqual(ethReads, [[BLOCK - 1, BLOCK]])
    assert.deepEqual(ethDeltas(wallet.legs), ["5"])
  })

  it("reads nothing when there's nothing to settle", async () => {
    const { source, ethReads } = fake(new Map([[960, [row(960)]]]), () => reference(1000))
    await createWallets(source, headAt(1000), allFees).get(ME)
    assert.deepEqual(ethReads, [])
  })

  it("reads a block once, and again after a reorg can have changed it", async () => {
    let head = 1000
    const chain = new Map([[BLOCK, [gas(), claim()]], [990, [gas(990), claim(990)]]])
    const { source, ethReads } = fake(chain, () => reference(head), undefined, undefined, nothingArrived)
    const wallets = createWallets(source, async () => headAt(head)(), allFees)
    await wallets.get(ME)
    assert.deepEqual(ethReads, [[BLOCK - 1, BLOCK, 989, 990]])
    head = 1001
    await wallets.get(ME)
    // Block 950 is past what's re-read for reorgs, so it's kept.
    assert.deepEqual(ethReads[1], [989, 990])
  })

  it("keeps the wallet up when the read fails, leaves the swap unknown, and tries again on the next block", async () => {
    let head = 1000
    let fail = true
    const read = async (blocks: readonly number[]) => {
      if (fail) throw new Error("no RPC")
      return nothingArrived(blocks)
    }
    const { source } = fake(new Map([[BLOCK, [gas(), claim()]]]), () => reference(head), undefined, undefined, read)
    const wallets = createWallets(source, async () => headAt(head)(), allFees)
    const first = await wallets.get(ME)
    assert.deepEqual(ethDeltas(first.legs), ["1000"])
    assert.equal(first.legs.find((l) => l.kind !== "gas")!.unsettledCredit, true)

    fail = false
    head = 1001
    assert.deepEqual(ethDeltas((await wallets.get(ME)).legs), [])
  })

  it("waits for the L1 fee, and settles as soon as it's read", async () => {
    let head = 1000
    let fees = noFees
    const { source } = fake(new Map([[BLOCK, [gas(), claim()]]]), () => reference(head), undefined, undefined, nothingArrived)
    const wallets = createWallets(source, async () => headAt(head)(), (requests) => fees(requests))
    assert.equal((await wallets.get(ME)).legs.find((l) => l.kind !== "gas")!.unsettledCredit, true)
    fees = allFees
    head = 1001
    assert.deepEqual(ethDeltas((await wallets.get(ME)).legs), [])
  })

  describe("when a transaction's gas can't be worked out", () => {
    // Sells cbBTC for 1 ETH. A fresh read of the same chain is the answer every cached one has to reach.
    const CBBTC = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf"
    const E18 = 10n ** 18n
    const sale = (tx = "0xdd"): LegRow[] => [{ ...claim(990, tx), amount: E18.toString() }, { ...row(990, "2884455"), tx_hash: tx, token: CBBTC, side: "debit", kind: "erc20" }]
    const paidGas = (tx = "0xdd") => gas(990, tx)
    const balancesFor = (blocks: readonly number[]) => new Map(blocks.map((b) => [b, b === 990 ? (5000n - 100n + E18).toString() : "5000"]))
    const saleLeg = (legs: { asset: string; proceedsMicros: string | null; unsettledCredit?: boolean }[]) => legs.find((l) => l.asset === "cbBTC")!

    function cachedWith(window: () => WindowRows) {
      let head = 1000
      const { source: base } = fake(new Map(), () => reference(head), undefined, undefined, async (blocks) => balancesFor(blocks))
      const wallets = createWallets({ ...base, readWindow: async () => window() }, async () => headAt(head)(), allFees)
      return { wallets, setHead: (next: number) => (head = next) }
    }

    it("doesn't settle its block, even when the transaction has no rows", async () => {
      const { wallets } = cachedWith(() => ({ rows: [paidGas(), ...sale()], priced: null, gasUnknown: [{ tx_hash: "0xnorows", block_num: 990 }] }))
      const wallet = await wallets.get(ME)
      assert.equal(saleLeg(wallet.legs).unsettledCredit, true)
      assert.deepEqual(wallet.gasUnknownTxs, ["0xnorows"])
      assert.equal(wallet.gasUnknownBlocks.length, 1, "with its block, since it has no legs to tell from")
    })

    it("recovers when the transaction stays and its gas becomes known, the same as a fresh read", async () => {
      let gasKnown = false
      const { wallets, setHead } = cachedWith(() => (gasKnown ? { rows: [paidGas(), ...sale()], priced: null, gasUnknown: [] } : { rows: sale(), priced: null, gasUnknown: [{ tx_hash: "0xdd", block_num: 990 }] }))
      const before = await wallets.get(ME)
      assert.equal(saleLeg(before.legs).proceedsMicros, null)
      assert.deepEqual(before.gasUnknownTxs, ["0xdd"])

      gasKnown = true
      setHead(1001)
      const after = await wallets.get(ME)
      assert.deepEqual(after.gasUnknownTxs, [])
      assert.equal(saleLeg(after.legs).unsettledCredit, undefined)

      const fresh = await cachedWith(() => ({ rows: [paidGas(), ...sale()], priced: null, gasUnknown: [] })).wallets.get(ME)
      assert.equal(saleLeg(after.legs).proceedsMicros, saleLeg(fresh.legs).proceedsMicros)
      assert.equal(saleLeg(after.legs).proceedsMicros, "2400000000")
    })

    it("recovers when the transaction with no rows goes away", async () => {
      let gone = false
      const { wallets, setHead } = cachedWith(() => ({ rows: [paidGas(), ...sale()], priced: null, gasUnknown: gone ? [] : [{ tx_hash: "0xnorows", block_num: 990 }] }))
      assert.equal(saleLeg((await wallets.get(ME)).legs).unsettledCredit, true)
      gone = true
      setHead(1001)
      const after = await wallets.get(ME)
      assert.deepEqual(after.gasUnknownTxs, [])
      assert.equal(saleLeg(after.legs).unsettledCredit, undefined)
    })

    it("keeps what's past the part of the chain that's re-read", async () => {
      let reads = 0
      const { wallets, setHead } = cachedWith(() => (reads++ === 0 ? { rows: [], priced: null, gasUnknown: [{ tx_hash: "0xold", block_num: 950 }] } : { rows: [], priced: null, gasUnknown: [] }))
      await wallets.get(ME)
      setHead(1001)
      assert.deepEqual((await wallets.get(ME)).gasUnknownTxs, ["0xold"])
    })
  })

  describe("a reorg that keeps a claim's transaction at the same height and changes its L1 fee", () => {
    const CBBTC = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf"
    const E18 = 10n ** 18n
    const rows = [gas(990, TX990), { ...claim(990, TX990), amount: E18.toString() }, { ...row(990, "2884455"), tx_hash: TX990, token: CBBTC, side: "debit" as const, kind: "erc20" as const }]

    function setup() {
      let head = 1000
      let fee = 1_000_000_000_000n
      let answer = true
      const feeReads: number[] = []
      const fees: ReadL1Fees = async (requests) => {
        feeReads.push(...requests.map((r) => r.blockNum))
        return new Map(answer ? requests.map((r) => [r.txHash, fee.toString()]) : [])
      }
      // The balance always shows what really happened, with the whole 1 ETH arriving.
      const read = async (blocks: readonly number[]) => new Map(blocks.map((b) => [b, b === 990 ? (E18 * 5n - 100n - fee + E18).toString() : (E18 * 5n).toString()]))
      const { source } = fake(new Map([[990, rows]]), () => reference(head), undefined, undefined, read)
      const wallets = createWallets(source, async () => headAt(head)(), fees)
      const sale = async () => (await wallets.get(ME)).legs.find((l) => l.asset === "cbBTC")!
      return { wallets, sale, feeReads, setHead: (next: number) => (head = next), setFee: (next: bigint) => (fee = next), setAnswer: (next: boolean) => (answer = next) }
    }
    const WHOLE = "2400000000"

    it("reads the fee again with the balance, so the change isn't taken for a smaller payout", async () => {
      const { sale, feeReads, setHead, setFee } = setup()
      assert.equal((await sale()).proceedsMicros, WHOLE)
      setFee(2_000_000_000_000n)
      setHead(1001)
      const after = await sale()
      assert.equal(after.proceedsMicros, WHOLE)
      assert.equal(after.unsettledCredit, undefined)
      assert.deepEqual(feeReads, [990, 990])
    })

    it("leaves the sale unknown if that read fails, and settles when it works", async () => {
      const { sale, setHead, setFee, setAnswer } = setup()
      await sale()
      setFee(2_000_000_000_000n)
      setAnswer(false)
      setHead(1001)
      const failed = await sale()
      assert.equal(failed.proceedsMicros, null)
      assert.equal(failed.unsettledCredit, true)

      setAnswer(true)
      setHead(1002)
      assert.equal((await sale()).proceedsMicros, WHOLE)
    })

    it("leaves the sale unknown if the last read before the block settles fails, and tries again", async () => {
      const { sale, feeReads, setHead, setFee, setAnswer } = setup()
      await sale()
      setFee(2_000_000_000_000n)
      setAnswer(false)
      setHead(1025)
      assert.equal((await sale()).proceedsMicros, null)

      setAnswer(true)
      setHead(1040)
      assert.equal((await sale()).proceedsMicros, WHOLE)
      const reads = feeReads.length
      setHead(1041)
      assert.equal((await sale()).proceedsMicros, WHOLE)
      assert.equal(feeReads.length, reads, "settled now")
    })

    it("reads another transaction's fee in that block too, whose stale fee would be just as wrong", async () => {
      const other = gas(990, "0xother")
      const feeReads: string[] = []
      const fees: ReadL1Fees = async (requests) => {
        feeReads.push(...requests.map((r) => r.txHash))
        return new Map(requests.map((r) => [r.txHash, "0"]))
      }
      let head = 1000
      const { source } = fake(new Map([[990, [...rows, other]]]), () => reference(head), undefined, undefined, async (blocks) => new Map(blocks.map((b) => [b, "5000"])))
      const wallets = createWallets(source, async () => headAt(head)(), fees)
      await wallets.get(ME)
      feeReads.length = 0
      head = 1001
      await wallets.get(ME)
      assert.deepEqual(feeReads.sort(), ["0xother", TX990].sort())
    })

    it("settles the same on one set of facts, whichever rule reads them and at an older block", async () => {
      const fees: ReadL1Fees = async (requests) => new Map(requests.map((r) => [r.txHash, "1000000000000"]))
      const read = async (blocks: readonly number[]) => new Map(blocks.map((b) => [b, b === 990 ? (E18 * 5n - 100n - 1_000_000_000_000n + E18).toString() : (E18 * 5n).toString()]))
      const first = fake(new Map([[990, rows]]), () => reference(1000), undefined, undefined, read)
      // The other rule's own balance read fails, which must not be what tells the two apart.
      const second = fake(new Map([[990, rows]]), () => reference(1000))
      const [a, b] = [createWallets(first.source, headAt(1000), fees), createWallets(second.source, headAt(1000), async () => new Map())]
      await a.get(ME)
      await b.get(ME)
      const facts = (await a.factsAt(ME, 995, { withBalances: false }))!
      const noMarket = { priced: new Set<string>(), checked: true }
      const sales = [a.pricedOn(ME, facts, {}, noMarket)!, b.pricedOn(ME, facts, {}, noMarket)!].map((wallet) => wallet.legs.find((l) => l.asset === "cbBTC")!)
      assert.deepEqual(sales.map((l) => [l.proceedsMicros, l.unsettledCredit]), [[WHOLE, undefined], [WHOLE, undefined]])
    })

    it("doesn't read a fee again in a block with no claim", async () => {
      const fees: string[] = []
      const read: ReadL1Fees = async (requests) => {
        fees.push(...requests.map((r) => r.txHash))
        return new Map(requests.map((r) => [r.txHash, "0"]))
      }
      let head = 1000
      const { source } = fake(new Map([[990, rows], [995, [gas(995, "0xplain")]]]), () => reference(head), undefined, undefined, async (blocks) => new Map(blocks.map((b) => [b, "5000"])))
      const wallets = createWallets(source, async () => headAt(head)(), read)
      await wallets.get(ME)
      fees.length = 0
      head = 1001
      await wallets.get(ME)
      assert.deepEqual(fees, [TX990])
    })
  })

  it("adds the L1 fee to what the balance has to explain", async () => {
    const fee: ReadL1Fees = async (requests) => new Map(requests.map((r) => [r.txHash, "30"]))
    const read = async (blocks: readonly number[]) => new Map(blocks.map((b) => [b, b === BLOCK ? "5870" : "5000"]))
    const { source } = fake(new Map([[BLOCK, [gas(), claim()]]]), () => reference(1000), undefined, undefined, read)
    assert.deepEqual(ethDeltas((await createWallets(source, headAt(1000), fee).get(ME)).legs), ["1000"])
  })
})

describe("prices between a wallet's transactions", () => {
  const HEAD = 4000
  const started = (head: () => number = () => HEAD) => {
    const chain = new Map([[1000, [row(1000)]]])
    const faked = fake(chain, () => reference(head()), () => head())
    faked.source.historyFrom = () => 900
    return { ...faked, chain, wallets: createWallets(faked.source, async () => headAt(head())(), noFees, quiet, { priceSamples: true }) }
  }
  const quiet = { info() {}, warn() {}, error() {} } as unknown as Parameters<typeof createWallets>[3]
  const wanted = (from: number, to: number) => priceSampleBlocks(from, to)
  /** What the row says, so ETH is confirmed, and a price is all a point could be missing. */
  const matching = async (block: number) => Object.fromEntries(ASSETS.map((asset) => [asset, asset === "ETH" && block >= 1000 ? "5" : "0"]))

  it("reads none unless asked to, like for an SDK's legs", async () => {
    const { source, referenceReads } = fake(new Map([[950, [row(950)]]]), () => reference(1000))
    const wallet = await createWallets(source, headAt(1000), noFees).get(ME)
    assert.equal(wallet.priceSamples, undefined)
    assert.deepEqual(referenceReads, [[950]])
  })

  it("reads each from the wallet's first movement to its head, once", async () => {
    let head = HEAD
    const { wallets, referenceReads, chain } = started(() => head)
    const wallet = await wallets.get(ME)
    assert.deepEqual(wallet.priceSamples?.map((sample) => sample.blockNum), wanted(1000, HEAD))
    assert.ok(wallet.priceSamples!.every((sample) => sample.ethUsd === "240000000000"))
    assert.deepEqual(wallet.references.map((r) => r.blockNum), [1000], "they aren't the wallet's own references")
    const read = referenceReads.flat()
    head += 1
    chain.set(HEAD + 1, [row(HEAD + 1)])
    const before = referenceReads.length
    await wallets.get(ME)
    assert.deepEqual(referenceReads.slice(before), [[HEAD + 1]], "nothing it already has")
    assert.ok(read.length > 1)
  })

  it("marks the chart with them", async () => {
    const { wallets } = started()
    const wallet = await wallets.get(ME)
    const { points } = foldWallet(wallet, "average")
    const between = points.filter((p) => p.txHash === null).slice(0, -1)
    assert.equal(between.length, wanted(1000, HEAD).filter((block) => block > 1000 && block < HEAD).length)
    assert.ok(points.slice(1).every((p) => p.valueRead === true))
  })

  it("keeps the wallet up when a read fails, says it's unread, and tries again", async () => {
    let failing = true
    const { source, referenceReads } = fake(new Map([[1000, [row(1000)]]]), () => reference(HEAD), (at) => at, matching)
    source.historyFrom = () => 900
    const read = source.readReferences
    source.readReferences = async (blocks) => {
      if (failing && !blocks.includes(1000)) throw new Error("no")
      return read(blocks)
    }
    let head = HEAD
    const wallets = createWallets(source, async () => headAt(head)(), noFees, quiet, { priceSamples: true })
    const wallet = await wallets.get(ME)
    assert.equal(wallet.legs.length, 1)
    assert.deepEqual(wallet.priceSamples?.map((sample) => sample.blockNum), wanted(1000, HEAD), "still where a chart wants a price")
    assert.ok(wallet.priceSamples!.every((sample) => sample.ethUsd === ""))
    const { points } = foldWallet(wallet, "average")
    assert.deepEqual(points.map((p) => [p.txHash, p.valueRead]), [["0x3e8", undefined], [null, undefined]], "so what's between them stays a guess")
    failing = false
    head += 1
    assert.ok((await wallets.get(ME)).priceSamples!.every((sample) => sample.ethUsd === "240000000000"))
    assert.ok(referenceReads.length > 0)
  })

  describe("at a block with a transaction in it", () => {
    const BLOCK = 3600
    const reading = (failing: () => boolean) => {
      const { source, referenceReads } = fake(new Map([[BLOCK, [row(BLOCK)]]]), () => reference(HEAD), (at) => at, async (block) => Object.fromEntries(ASSETS.map((asset) => [asset, asset === "ETH" && block >= BLOCK ? "5" : "0"])))
      source.historyFrom = () => 900
      const read = source.readReferences
      source.readReferences = async (blocks) => {
        if (failing() && !blocks.includes(BLOCK)) throw new Error("no")
        return read(blocks)
      }
      return { source, referenceReads, wallets: createWallets(source, async () => headAt(HEAD)(), noFees, quiet, { priceSamples: true }) }
    }

    it("uses the read it has, rather than reading it twice", async () => {
      assert.ok(wanted(BLOCK, HEAD).includes(BLOCK))
      const { wallets, referenceReads } = reading(() => false)
      const wallet = await wallets.get(ME)
      assert.equal(referenceReads.flat().filter((block) => block === BLOCK).length, 1)
      assert.equal(wallet.priceSamples?.find((sample) => sample.blockNum === BLOCK)?.ethUsd, "240000000000")
    })

    it("keeps its value when the other reads fail", async () => {
      const { source, wallets } = reading(() => true)
      const wallet = await wallets.get(ME)
      assert.ok(wallet.priceSamples!.some((sample) => sample.ethUsd === ""), "so the other samples are empty")
      const without = await createWallets(source, async () => headAt(HEAD)(), noFees, quiet).get(ME)
      const atTx = ({ points }: ReturnType<typeof foldWallet>) => points.filter((p) => p.txHash !== null).map((p) => [p.txHash, p.pnlMicros, p.valueMicros])
      assert.deepEqual(atTx(foldWallet(wallet, "average")), atTx(foldWallet(without, "average")))
      assert.ok(atTx(foldWallet(wallet, "average"))[0]![2] !== null)
    })
  })

  it("doesn't ask again about a block the table has no row for", async () => {
    const { source, referenceReads } = fake(new Map([[1000, [row(1000)]]]), () => reference(HEAD))
    source.historyFrom = () => 900
    source.readReferences = async (blocks) => {
      referenceReads.push([...blocks])
      return blocks.filter((block) => block === 1000).map(reference)
    }
    let head = HEAD
    const wallets = createWallets(source, async () => headAt(head)(), noFees, quiet, { priceSamples: true })
    await wallets.get(ME)
    head += 1
    const before = referenceReads.length
    await wallets.get(ME)
    assert.equal(referenceReads.slice(before).flat().length, 0)
  })

  it("waits for what a table that's behind hasn't reached, which stays unread until it does", async () => {
    let through = 3000
    let head = HEAD
    const { source } = fake(new Map([[1000, [row(1000)]]]), () => reference(HEAD), () => through, matching)
    source.historyFrom = () => 900
    const wallets = createWallets(source, async () => headAt(head)(), noFees, quiet, { priceSamples: true })
    const behind = await wallets.get(ME)
    const after = behind.priceSamples!.filter((sample) => sample.blockNum > 3000)
    assert.ok(after.length > 0)
    assert.ok(after.every((sample) => sample.ethUsd === ""))
    const { points } = foldWallet(behind, "average")
    assert.equal(points.at(-1)!.valueRead, undefined, "so the stretch up to now is still a guess")
    through = HEAD + 1
    head = HEAD + 1
    assert.ok((await wallets.get(ME)).priceSamples!.every((sample) => sample.ethUsd !== ""))
  })

  it("reads again what a reorg replaced", async () => {
    const { source, referenceReads } = fake(new Map([[1000, [row(1000)]]]), () => reference(HEAD))
    source.historyFrom = () => 900
    let head = HEAD
    const wallets = createWallets(source, async () => headAt(head)(), noFees, quiet, { priceSamples: true })
    await wallets.get(ME)
    const before = referenceReads.length
    await wallets.rewind(3500, HEAD)
    head += 1
    const wallet = await wallets.get(ME)
    assert.ok(referenceReads.slice(before).flat().some((block) => block >= 3500 && wanted(1000, HEAD).includes(block)))
    assert.ok(wallet.priceSamples!.every((sample) => sample.ethUsd !== ""))
  })

  it("leaves them out when two rules are compared at one block", async () => {
    const { wallets } = started()
    await wallets.get(ME)
    const facts = await wallets.factsAt(ME, HEAD, { withBalances: false })
    const priced = wallets.pricedOn(ME, facts!, {}, { priced: new Set(), checked: true })
    assert.equal(priced?.priceSamples, undefined)
  })
})
