import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createWallets } from "../server/wallets.ts"
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

function fake(chain: Map<number, LegRow[]>, latest: () => ReferenceRow | null, processed: (head: number) => number | null = (head) => head) {
  const windows: [number, number][] = []
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
  }
  return { source, windows, referenceReads }
}

const headAt = (block: number) => async () => ({ blockNum: block, timestamp: "2026-11-04T00:00:00.000Z" })

describe("the wallet cache", () => {
  it("reads the full window once, then only new blocks plus a tail for reorgs", async () => {
    let head = 1000
    const chain = new Map([[950, [row(950)]]])
    const { source, windows, referenceReads } = fake(chain, () => reference(head))
    const wallets = createWallets(source, async () => headAt(head)())
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
      const wallets = createWallets(source, async () => headAt(head)())

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
      const wallets = createWallets(source, async () => headAt(head)())
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
      const wallets = createWallets(source, async () => headAt(head)())
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
      const wallets = createWallets(source, async () => headAt(head)())
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
    const wallets = createWallets(source, headAt(1000))
    await wallets.get(ME)
    await wallets.get(ME)
    assert.equal(windows.length, 1)
  })

  it("a reorg near the tip replaces what it changed", async () => {
    let head = 1000
    const chain = new Map([[995, [row(995, "5")]]])
    const { source } = fake(chain, () => reference(head))
    const wallets = createWallets(source, async () => headAt(head)())
    assert.equal((await wallets.get(ME)).legs[0]!.delta, "5")
    head = 1001
    chain.set(995, [row(995, "7")])
    const after = await wallets.get(ME)
    assert.equal(after.legs.length, 1)
    assert.equal(after.legs[0]!.delta, "7")
  })

  it("a derived table a block behind the head still gives a current price, with its own block on it", async () => {
    const { source } = fake(new Map(), () => reference(998))
    const wallet = await createWallets(source, headAt(1000)).get(ME)
    assert.deepEqual(wallet.prices.ETH, { usdMicros: "2400000000", source: "oracle", blockNum: 998 })
  })

  it("with no recent oracle read, there's no price, rather than an old one", async () => {
    let latest: ReferenceRow | null = reference(1000)
    let head = 1000
    const { source } = fake(new Map(), () => latest)
    const wallets = createWallets(source, async () => headAt(head)())
    assert.ok((await wallets.get(ME)).prices.ETH)
    latest = null
    head = 1001
    assert.equal((await wallets.get(ME)).prices.ETH, undefined)
  })

  it("a failed oracle read at a wallet's block leaves that leg with no price", async () => {
    const { source } = fake(new Map([[950, [row(950)]]]), () => reference(1000))
    source.readReferences = async (blocks) => blocks.map((b) => ({ block_num: b, eth_usd: "", usdc_usd: "" }))
    const [leg] = (await createWallets(source, headAt(1000)).get(ME)).legs
    assert.equal(leg!.priceUsdMicros, null)
  })

  it("concurrent reads of one wallet share a single query", async () => {
    const { source, windows } = fake(new Map(), () => reference(1000))
    const wallets = createWallets(source, headAt(1000))
    await Promise.all([wallets.get(ME), wallets.get(ME.toUpperCase().replace("0X", "0x"))])
    assert.equal(windows.length, 1)
  })
})
