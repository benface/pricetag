import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { portfolioOf } from "../server/portfolio.ts"
import { USD_CONTEXT, explainMetric } from "../src/core/explain.ts"
import { createWallets, sharedMarket, type ReadL1Fees, type Source, type WindowRows } from "@pricetag/sdk/internal"
import { ASSETS, ETH_ADDRESS, USDC_ADDRESS, foldWallet, shortHash, type FeedRound, type LegRow, type Reference } from "@pricetag/sdk/core"

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
    historyBlocks: 100,
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
    assert.deepEqual(reads, [[["AERO"], 990]], "only what's held, at the head's bucket")
    assert.equal(wallet.marketChecked, true)
    assert.ok(marketReads.every((asset) => asset === "AERO"))
    assert.equal(wallet.legs[0]?.priceSource, "market", "a past leg's price isn't what this changes")
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
    assert.equal(reads.length, 1)
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
    assert.deepEqual(reads, [[["AERO"], 990], [["AERO"], 960]], "the bucket at or before 985")
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
    assert.deepEqual(reads.map(([, block]) => block), [990, 1020])
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
    assert.deepEqual(reads, [[["AERO"], 930]])
    assert.equal(wallet.prices.AERO?.blockNum, 930)
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
    assert.deepEqual(wallet.legs.map((l) => l.kind), ["transfer", "swap"])
    const eth = portfolioOf({ ...wallet }, "average").positions.find((p) => p.asset === "ETH")!
    assert.deepEqual(eth.reconciliation?.status === "incomplete" && eth.reconciliation.unseenEth, wallet.unseenEth)
  })

  describe("when ETH's balance matches, but more of it left than arrived", () => {
    const E18 = 10n ** 18n
    const ethRow = (block: number, side: LegRow["side"]): LegRow => ({ ...row(block, E18.toString()), side })
    // 1 ETH arrives unseen at 950 as a token leaves, and leaves visibly at 960. Another arrives visibly at 970, and leaves unseen at 980.
    const chain = () => new Map([[950, [send(950)]], [960, [ethRow(960, "debit")]], [970, [ethRow(970, "credit")]]])
    const ranges: [string, { from: number; to: number } | undefined, number][] = [["a live read", undefined, 1000], ["a read as of a fixed block", { from: 900, to: 990 }, 2000]]

    for (const [name, range, head] of ranges) {
      it(`${name} still looks, marks the send and names it`, async () => {
        const { source, ethReads } = fake(chain(), () => reference(head), undefined, held("0"), rises(950, E18))
        const wallet = await createWallets(source, headAt(head), allFees).get(ME, range)
        assert.deepEqual(ethReads, [[949, 950]])
        const tx = `0x${(950).toString(16)}`
        assert.deepEqual(wallet.unseenEth, [{ blockNum: 950, amount: E18.toString(), txHashes: [tx] }])
        const sale = wallet.legs.find((l) => l.txHash === tx)!
        assert.deepEqual([sale.kind, sale.proceedsMicros], ["swap", null])
        for (const method of ["average", "fifo"] as const) {
          const { positions } = foldWallet(wallet, method)
          const eth = positions.find((p) => p.asset === "ETH")!
          assert.equal(eth.state.shortfallQty, E18.toString())
          assert.ok(eth.reconciliation?.status === "incomplete" && eth.reconciliation.differenceQty === "0")
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
    const wallets = createWallets({ ...source, historyBlocks: 950 }, async () => headAt(head)(), allFees)
    await wallets.get(ME)
    assert.equal(ethReads[0]!.length, 400)
    head = 1001
    await wallets.get(ME)
    assert.equal(ethReads[1]!.length, 200)
    head = 1002
    await wallets.get(ME)
    // Only what's still re-read for reorgs.
    assert.ok(ethReads[2]!.every((block) => block >= 1002 - 31))
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
