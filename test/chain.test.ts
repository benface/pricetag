import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { LAST_2S_BLOCK as LAST, blockBefore, msBetweenBlocks, timestampOfBlock } from "@pricetag/sdk/core"
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
