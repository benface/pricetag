import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createWallets } from "../server/wallets.ts"
import type { ReadL1Fees } from "../server/receipts.ts"
import type { Source, WindowRows } from "../server/source.ts"
import type { LegRow, ReferenceRow } from "../src/core/legs.ts"
import { ETH_ADDRESS } from "../src/core/tokens.ts"

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
const reference = (block: number): ReferenceRow => ({ block_num: block, eth_usd: "240000000000", usdc_usd: "100000000" })

function fake(
  chain: Map<number, LegRow[]>,
  latest: () => ReferenceRow | null,
  processed: (head: number) => number | null = (head) => head,
  balances: (block: number) => Promise<Record<string, string> | null> = async () => ({}),
) {
  const windows: [number, number][] = []
  const balanceReads: number[] = []
  const referenceReads: number[][] = []
  const source: Source = {
    mode: "raw",
    startBlock: null,
    historyBlocks: 100,
    head: async () => null,
    processedThrough: async (_, head) => processed(head),
    async readWindow(_, from, to): Promise<WindowRows> {
      windows.push([from, to])
      return { rows: [...chain.entries()].filter(([b]) => b >= from && b <= to).flatMap(([, r]) => r), priced: null, gasUnknownTxs: [] }
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
  }
  return { source, windows, referenceReads, balanceReads }
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
      let latest: ReferenceRow | null = reference(960)
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
    assert.deepEqual(wallet.prices.ETH, { usdMicros: "2400000000", source: "oracle", blockNum: 998 })
  })

  it("with no recent oracle read, there's no price, rather than an old one", async () => {
    let latest: ReferenceRow | null = reference(1000)
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
    source.readReferences = async (blocks) => blocks.map((b) => ({ block_num: b, eth_usd: "", usdc_usd: "" }))
    const [leg] = (await createWallets(source, headAt(1000), noFees).get(ME)).legs
    assert.equal(leg!.priceUsdMicros, null)
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
    const original = console.error
    console.error = () => {}
    try {
      await run()
    } finally {
      console.error = original
    }
  }

  it("reads balances before the first block and at the last block covered, not the head", async () => {
    const { source, balanceReads } = fake(chain(), () => reference(1000), () => 990)
    const wallet = await createWallets(source, headAt(1000), noFees).get(ME)
    assert.deepEqual(balanceReads, [899, 990])
    assert.equal(wallet.balances?.blockNum, 990)
    assert.equal(wallet.coverage.toBlock, 990)
  })

  it("reads the opening once, and the closing again only when coverage moves", async () => {
    let head = 1000
    let processed = 1000
    const { source, balanceReads } = fake(chain(), () => reference(head), () => processed)
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

  it("a closing balance alone isn't enough to compare", async () => {
    const { source } = fake(chain(), () => reference(1000), undefined, async (block) => (block === 899 ? null : { ETH: "1" }))
    assert.equal((await createWallets(source, headAt(1000), noFees).get(ME)).balances, null)
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
