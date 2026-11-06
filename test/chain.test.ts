import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { LAST_2S_BLOCK as LAST, blockBefore, msBetweenBlocks, priceSampleBlocks, timestampOfBlock } from "@pricetag/sdk/core"
import type { Query } from "@pricetag/sdk/internal"
import { rawSource } from "../server/source.ts"

describe("Base's block times", () => {
  it("is the first block at or after the upgrade, counting 2 s from genesis", () => {
    const at = 1686789347 + LAST * 2
    assert.ok(at >= Date.UTC(2026, 10, 5, 18) / 1000)
    assert.ok(at - 2 < Date.UTC(2026, 10, 5, 18) / 1000)
  })

  it("counts 2 s up to that block and 200 ms after it", () => {
    assert.equal(msBetweenBlocks(100, 130), 60_000)
    assert.equal(msBetweenBlocks(LAST - 1, LAST), 2000)
    assert.equal(msBetweenBlocks(LAST, LAST + 1), 200)
    assert.equal(msBetweenBlocks(LAST - 5, LAST + 10), 12_000)
    assert.equal(msBetweenBlocks(LAST + 5, LAST + 305), 60_000)
  })

  it("is no time at all when the blocks are the same or backwards", () => {
    assert.equal(msBetweenBlocks(LAST + 5, LAST + 5), 0)
    assert.equal(msBetweenBlocks(130, 100), 0)
    assert.equal(msBetweenBlocks(LAST + 5, LAST - 5), 0)
  })

  it("finds the block a span before another, on either side and across the change", () => {
    assert.equal(blockBefore(130, 60_000), 100)
    assert.equal(blockBefore(LAST + 300, 60_000), LAST)
    assert.equal(blockBefore(LAST + 1000, 60_000), LAST + 700)
    assert.equal(blockBefore(LAST + 10, 60_000), LAST - 29)
    assert.equal(blockBefore(LAST, 60_000), LAST - 30)
    assert.equal(blockBefore(10, 60_000), 0)
  })

  it("never lands short of the span", () => {
    for (const block of [LAST - 50, LAST, LAST + 1, LAST + 7, LAST + 299, LAST + 300, LAST + 301, LAST + 5000]) {
      for (const ms of [1, 200, 201, 1999, 2000, 60_000, 60_100, 3_600_000]) {
        const before = blockBefore(block, ms)
        assert.ok(msBetweenBlocks(before, block) >= ms, `${block} ${ms}`)
        // One block newer would be too close.
        assert.ok(msBetweenBlocks(before + 1, block) < ms, `${block} ${ms}`)
      }
    }
  })

  describe("a block's timestamp", () => {
    // What the chain would say: `LAST` at 18:00:01.000, in whole seconds from then on, and 2 s apart before it.
    const FIRST_MS = Date.UTC(2026, 10, 5, 18, 0, 1)
    const chainTimestamp = (block: number) => new Date(block <= LAST ? FIRST_MS - (LAST - block) * 2000 : FIRST_MS + Math.floor(((block - LAST) * 200) / 1000) * 1000).toISOString()
    const head = (blockNum: number) => ({ blockNum, timestamp: chainTimestamp(blockNum) })

    it("is the chain's, from any block after it, wherever in its second that block is", () => {
      for (const block of [LAST - 40, LAST - 1, LAST, LAST + 1, LAST + 4, LAST + 5, LAST + 6, LAST + 7, LAST + 8, LAST + 9, LAST + 10, LAST + 1234]) {
        for (let later = block; later <= block + 12; later++) {
          assert.equal(timestampOfBlock(block, head(later)), chainTimestamp(block), `${block} from ${later}`)
        }
      }
    })

    it("stays on the right day at midnight", () => {
      const midnight = LAST + ((Date.UTC(2026, 10, 6) - FIRST_MS) / 1000) * 5
      for (let later = midnight; later < midnight + 10; later++) assert.equal(timestampOfBlock(midnight, head(later)), "2026-11-06T00:00:00.000Z")
      assert.equal(timestampOfBlock(midnight - 1, head(midnight + 3)), "2026-11-05T23:59:59.000Z")
    })

    it("counts 2 s blocks as it always did", () => {
      assert.equal(timestampOfBlock(899, { blockNum: 1000, timestamp: "2026-11-04T00:00:00.000Z" }), new Date(Date.UTC(2026, 10, 4) - 202_000).toISOString())
    })
  })

  it("reads an hour of history unless it's told how many blocks", () => {
    const query = (async () => []) as unknown as Query
    const source = (historyBlocks: number | null) => rawSource(query, { baseDataset: "base", network: "base_mainnet", historyBlocks })
    assert.equal(source(null).historyFrom?.(1000), 0)
    assert.equal(source(null).historyFrom?.(5000), 3200)
    assert.equal(source(null).historyFrom?.(LAST + 20_000), LAST + 2000)
    assert.equal(source(300).historyFrom?.(LAST + 20_000), LAST + 19_700)
  })
})

describe("a block with no base fee", () => {
  const ME = "dd8795475306152abe5f45f1ce97c017fd2f02e7"
  const read = (baseFee: string | null) => {
    const tx = { block_num: 5, timestamp: 1_730_000_000_000, tx_hash: "ab", tx_index: 0, from: ME, to: null, value: "0", gas_used: "21000", gas_price: null, max_fee_per_gas: "200", max_priority_fee_per_gas: "100", status: true, type: 2 }
    const query = (async (sql: string) => (sql.includes(".transactions") ? [tx] : sql.includes(".blocks") ? [{ block_num: 5, base_fee_per_gas: baseFee }] : [])) as unknown as Query
    return rawSource(query, { baseDataset: "base", network: "base_mainnet", historyBlocks: null }).readWindow(`0x${ME}`, 0, 10)
  }

  it("leaves what a transaction paid unknown, rather than free", async () => {
    const { rows, gasUnknown } = await read(null)
    assert.deepEqual(rows.filter((row) => row.kind === "gas"), [])
    assert.deepEqual(gasUnknown, [{ tx_hash: "0xab", block_num: 5 }])
  })

  it("works it out when there is one", async () => {
    const { rows, gasUnknown } = await read("50")
    assert.equal(rows.find((row) => row.kind === "gas")?.amount, (21000n * 150n).toString())
    assert.deepEqual(gasUnknown, [])
  })
})

describe("where a chart reads prices between transactions", () => {
  const HOUR = 1800
  const DAY = 24 * HOUR

  it("reads more often the more recent it is", () => {
    const head = 100 * DAY
    const blocks = priceSampleBlocks(0, head)
    const within = (ms: number) => blocks.filter((block) => msBetweenBlocks(block, head) <= ms)
    assert.equal(within(3_600_000).length, 13, "every 5 minutes for the past hour")
    assert.ok(within(86_400_000).length <= 13 + 24, "every hour for the past day")
    assert.ok(blocks.length < 13 + 24 + 28 + 30 + 15, "and it's only a handful")
    assert.deepEqual(blocks, [...blocks].sort((a, b) => a - b))
  })

  it("comes back to the same blocks as the head moves, so each is only read once", () => {
    const blocks = priceSampleBlocks(0, 50 * DAY)
    const later = new Set(priceSampleBlocks(0, 50 * DAY + 10))
    assert.ok(blocks.filter((block) => !later.has(block)).length <= 1, "ten blocks later, at most the oldest of the finest step has gone")
    const hourLater = priceSampleBlocks(0, 50 * DAY + HOUR)
    assert.ok(hourLater.filter((block) => !blocks.includes(block)).length <= 13)
  })

  it("stays inside what it's asked for", () => {
    assert.deepEqual(priceSampleBlocks(1000, 900), [])
    const blocks = priceSampleBlocks(151, 449)
    assert.deepEqual(blocks, [300])
  })

  it("keeps a step's length in time across the upgrade, where blocks come ten times as often", () => {
    const blocks = priceSampleBlocks(LAST - 450, LAST + 4500)
    assert.ok(blocks.length > 0)
    for (const [i, block] of blocks.entries()) {
      if (i === 0) continue
      const gap = msBetweenBlocks(blocks[i - 1] as number, block)
      assert.ok(gap > 0 && gap <= 600_000, `${gap} ms before block ${block}`)
    }
  })
})
