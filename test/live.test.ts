import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { createServer as createHttp2Server } from "node:http2"
import type { AddressInfo } from "node:net"
import { after, before, describe, it, type TestContext } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"
import { createPricetag, type WalletUpdate } from "@pricetag/sdk"
import type { CostNote, RateRound } from "@pricetag/sdk/core"
import { createRangeStream, createWallets, datasetSource, followChain, parseStreamRange, pricetagClient, type BlockMark, type ChainTick, type FollowConfig, type Query, type Source, type StreamRange, type StreamRanges } from "@pricetag/sdk/internal"
import { createApi } from "../server/app.ts"
import { createRates } from "../server/rates.ts"
import { fakeAmp, type Tables } from "./support/fake-amp.ts"

const ME = "00000000000000000000000000000000000000aa"
const ADDRESS = `0x${ME}`
const ETH = "0000000000000000000000000000000000000000"
const REFERENCE = { eth_usd: "240000000000", usdc_usd: "100000000" }
const QUIET = { warn() {} }

const blockOf = (end: number, start = end, hash = `0x${end}`): StreamRange => ({ start, end, hash, complete: true })
const dataOf = (end: number, start = end, hash = `0x${end}`): StreamRange => ({ ...blockOf(end, start, hash), complete: false })

/** A stream a test feeds by hand. `ends` closes the current connection, with an error if it's given one. */
function handStream() {
  const queued: (StreamRange | Error)[] = []
  let wake = () => {}
  const resumes: BlockMark[] = []
  const stream: StreamRanges = async function* (_sql, resume, signal) {
    resumes.push(resume)
    signal.addEventListener("abort", () => wake())
    while (true) {
      signal.throwIfAborted()
      const next = queued.shift()
      if (next instanceof Error) throw next
      if (next) yield next
      else await new Promise<void>((resolve) => (wake = resolve))
    }
  }
  return {
    stream,
    resumes,
    send(...ranges: (StreamRange | Error)[]) {
      queued.push(...ranges)
      wake()
    },
  }
}

const MARK: BlockMark = { blockNum: 100, hash: "0x100" }
/** So a tick that never comes fails its test. Without it, the test would wait forever. */
const FOLLOWING = { timeout: 30_000 }

/** Follows until the test ends, however it ends, since a follower left running keeps the test run from exiting. */
function following(t: TestContext, overrides: Partial<FollowConfig>) {
  const ticks = followChain({ stream: null, sql: "SELECT 1", readMark: async () => MARK, logger: QUIET, pollMs: 1, tickMs: 0, ...overrides }, t.signal)
  return { next: async () => (await ticks.next()).value as ChainTick }
}

/** Waits for what a follower is about to do, for as long as the test lasts. */
async function until(t: TestContext, done: () => boolean) {
  while (!done()) await sleep(1, undefined, { signal: t.signal })
}

describe("following the chain", FOLLOWING, () => {
  it("says each block when it's complete, not when its rows start", async (t) => {
    const hand = handStream()
    const chain = following(t, { stream: hand.stream })
    const first = chain.next()
    await new Promise((resolve) => setTimeout(resolve, 5))
    hand.send(dataOf(101), blockOf(101))
    assert.deepEqual(await first, { kind: "block", blockNum: 101, reorgFrom: null, via: "stream" })
    assert.deepEqual(hand.resumes, [MARK])
  })

  it("reports a reorg from where the new blocks start, whatever their height", async (t) => {
    const hand = handStream()
    const chain = following(t, { stream: hand.stream })
    const first = chain.next()
    await new Promise((resolve) => setTimeout(resolve, 5))
    hand.send(blockOf(101), blockOf(102))
    await first
    // A same-height replacement, then blocks after it that aren't one.
    hand.send(dataOf(102, 101, "0xnew"), blockOf(102, 101, "0xnew"))
    let tick = await chain.next()
    while (tick.kind === "block" && tick.reorgFrom === null) tick = await chain.next()
    assert.deepEqual(tick, { kind: "block", blockNum: 102, reorgFrom: 101, via: "stream" })
    hand.send(blockOf(103))
    assert.deepEqual(await chain.next(), { kind: "block", blockNum: 103, reorgFrom: null, via: "stream" })
  })

  it("gives a slow reader the newest block, and the reorg it missed", async (t) => {
    const hand = handStream()
    const chain = following(t, { stream: hand.stream })
    const first = chain.next()
    await new Promise((resolve) => setTimeout(resolve, 5))
    hand.send(blockOf(101))
    await first
    hand.send(blockOf(102), blockOf(101, 101, "0xnew"), blockOf(102, 102, "0xnew2"), blockOf(103))
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.deepEqual(await chain.next(), { kind: "block", blockNum: 103, reorgFrom: 101, via: "stream" })
  })

  it("keeps a reorg the stream reported before it died, and says it on the next tick", async (t) => {
    const hand = handStream()
    let mark = MARK
    const chain = following(t, { stream: hand.stream, readMark: async () => mark, retryMs: 60_000 })
    const first = chain.next()
    await new Promise((resolve) => setTimeout(resolve, 2))
    mark = { blockNum: 101, hash: "0xnew101" }
    hand.send(dataOf(101, 90, "0xnew101"), new Error("gone before the block was complete"))
    assert.deepEqual(await first, { kind: "block", blockNum: 101, reorgFrom: 90, via: "polling" })
    mark = { blockNum: 102, hash: "0xnew102" }
    assert.deepEqual(await chain.next(), { kind: "block", blockNum: 102, reorgFrom: null, via: "polling" })
  })

  it("finds a shorter chain after a reorg the stream reported before it died", async (t) => {
    const hand = handStream()
    const asked: (number | null)[] = []
    let mark = MARK
    const chain = following(t, { stream: hand.stream, readMark: async (after) => (asked.push(after), mark), retryMs: 60_000 })
    const first = chain.next()
    await new Promise((resolve) => setTimeout(resolve, 2))
    mark = { blockNum: 95, hash: "0xnew95" }
    hand.send(dataOf(95, 90, "0xnew95"), new Error("gone before the block was complete"))
    assert.deepEqual(await first, { kind: "block", blockNum: 95, reorgFrom: 90, via: "polling" })
    assert.equal(asked.at(-1), 89)
  })

  it("keeps the reorg through a reconnect that resumes from the old block", async (t) => {
    const hand = handStream()
    const chain = following(t, { stream: hand.stream, readMark: async () => MARK, retryMs: 5 })
    const first = chain.next()
    await new Promise((resolve) => setTimeout(resolve, 2))
    hand.send(dataOf(100, 90, "0xnew100"), new Error("gone before the block was complete"))
    await until(t, () => hand.resumes.length >= 2)
    hand.send(blockOf(100, 95, "0xnew100"))
    assert.deepEqual(await first, { kind: "block", blockNum: 100, reorgFrom: 90, via: "stream" })
  })

  it("polls when the stream fails, goes back to it from the last block it finished, and reads what polling said again once it catches up", async (t) => {
    const hand = handStream()
    let mark = MARK
    const chain = following(t, { stream: hand.stream, readMark: async () => mark, retryMs: 20 })
    const first = chain.next()
    await new Promise((resolve) => setTimeout(resolve, 2))
    mark = { blockNum: 102, hash: "0x102" }
    hand.send(new Error("no stream here"))
    assert.deepEqual(await first, { kind: "block", blockNum: 102, reorgFrom: null, via: "polling" })
    await until(t, () => hand.resumes.length >= 2)
    assert.deepEqual(hand.resumes[1], MARK)
    hand.send(blockOf(101), blockOf(102))
    assert.deepEqual(await chain.next(), { kind: "block", blockNum: 102, reorgFrom: 101, via: "stream" })
    hand.send(blockOf(103))
    assert.deepEqual(await chain.next(), { kind: "block", blockNum: 103, reorgFrom: null, via: "stream" })
  })

  it("doesn't say a reorg when the stream comes back and polling found nothing new", async (t) => {
    const hand = handStream()
    const chain = following(t, { stream: hand.stream, readMark: async () => ({ blockNum: 101, hash: "0x101" }), retryMs: 5 })
    const first = chain.next()
    await new Promise((resolve) => setTimeout(resolve, 2))
    hand.send(blockOf(102), new Error("connection lost"))
    assert.deepEqual(await first, { kind: "block", blockNum: 102, reorgFrom: null, via: "stream" })
    await until(t, () => hand.resumes.length >= 2)
    hand.send(blockOf(103))
    assert.deepEqual(await chain.next(), { kind: "block", blockNum: 103, reorgFrom: null, via: "stream" })
  })

  it("says a reorg that replaced the last streamed block while polling, however deep, once the stream is back", async (t) => {
    // Found on a real Amp (WORK-497): a derived table took longer than the stall timeout to recover from a 328-block reorg.
    const hand = handStream()
    let mark = MARK
    const chain = following(t, { stream: hand.stream, readMark: async () => mark, stallMs: 5, retryMs: 20 })
    const first = chain.next()
    await new Promise((resolve) => setTimeout(resolve, 2))
    hand.send(blockOf(101))
    assert.deepEqual(await first, { kind: "block", blockNum: 101, reorgFrom: null, via: "stream" })
    // The stream goes quiet, and polling only sees a higher head, which is on the new chain.
    mark = { blockNum: 500, hash: "0xnew500" }
    assert.deepEqual(await chain.next(), { kind: "block", blockNum: 500, reorgFrom: null, via: "polling" })
    await until(t, () => hand.resumes.length >= 2)
    assert.deepEqual(hand.resumes[1], { blockNum: 101, hash: "0x101" })
    hand.send(blockOf(501, 90, "0xnew501"))
    assert.deepEqual(await chain.next(), { kind: "block", blockNum: 501, reorgFrom: 90, via: "stream" })
  })

  describe("while it only polls", () => {
    /** A chain whose blocks a test can replace. The head is its highest block. */
    function polledChain(through: number) {
      const blocks = new Map<number, string>()
      const extend = (to: number, tag = "a") => {
        const from = Math.max(0, ...blocks.keys()) + 1
        for (let n = from; n <= to; n++) blocks.set(n, `0x${tag}${n}`)
      }
      extend(through)
      const asked: (readonly number[])[] = []
      return {
        blocks,
        asked,
        extend,
        /** Replaces every block from `from` on and goes on to `to`. */
        reorg(from: number, to: number) {
          for (const n of blocks.keys()) if (n >= from) blocks.delete(n)
          for (let n = from; n <= to; n++) blocks.set(n, `0xb${n}`)
        },
        config: {
          readMark: async (after: number | null) => {
            const head = Math.max(...blocks.keys())
            return after !== null && head < after ? null : { blockNum: head, hash: blocks.get(head)! }
          },
          readHashes: async (wanted: readonly number[]) => {
            asked.push(wanted)
            return new Map(wanted.flatMap((n) => (blocks.has(n) ? [[n, blocks.get(n)!] as const] : [])))
          },
        },
      }
    }

    it("says a deep reorg that made the chain longer, from after the newest block it said that's still there", async (t) => {
      // Found on a real Amp (WORK-497): 343 blocks replaced, with the stream down, and no tick ever said so.
      const chain = polledChain(100)
      const follow = following(t, chain.config)
      assert.deepEqual(await follow.next(), { kind: "block", blockNum: 100, reorgFrom: null, via: "polling" })
      chain.extend(200)
      assert.deepEqual(await follow.next(), { kind: "block", blockNum: 200, reorgFrom: null, via: "polling" })
      chain.extend(300)
      assert.deepEqual(await follow.next(), { kind: "block", blockNum: 300, reorgFrom: null, via: "polling" })
      chain.reorg(150, 643)
      assert.deepEqual(await follow.next(), { kind: "block", blockNum: 643, reorgFrom: 101, via: "polling" })
      chain.extend(644, "b")
      assert.deepEqual(await follow.next(), { kind: "block", blockNum: 644, reorgFrom: null, via: "polling" })
    })

    it("goes back to the oldest block it said when none of them are still there", async (t) => {
      const chain = polledChain(100)
      const follow = following(t, chain.config)
      await follow.next()
      chain.extend(200)
      await follow.next()
      chain.reorg(50, 400)
      assert.deepEqual(await follow.next(), { kind: "block", blockNum: 400, reorgFrom: 100, via: "polling" })
    })

    it("says a reorg that left a shorter chain once it's there, and only then", async (t) => {
      const chain = polledChain(100)
      const follow = following(t, chain.config)
      await follow.next()
      chain.extend(200)
      await follow.next()
      chain.reorg(150, 180)
      const next = follow.next()
      await new Promise((resolve) => setTimeout(resolve, 10))
      // The last block is gone rather than different, which a read that's behind looks like too.
      chain.reorg(181, 200)
      assert.deepEqual(await next, { kind: "block", blockNum: 200, reorgFrom: 101, via: "polling" })
    })

    it("checks the blocks the stream said once it's gone", async (t) => {
      const hand = handStream()
      const chain = polledChain(100)
      const follow = following(t, { ...chain.config, stream: hand.stream, retryMs: 60_000 })
      const first = follow.next()
      await new Promise((resolve) => setTimeout(resolve, 2))
      chain.extend(110)
      hand.send(blockOf(110, 101, chain.blocks.get(110)!))
      assert.deepEqual(await first, { kind: "block", blockNum: 110, reorgFrom: null, via: "stream" })
      chain.reorg(105, 500)
      hand.send(new Error("connection lost"))
      assert.deepEqual(await follow.next(), { kind: "block", blockNum: 500, reorgFrom: 101, via: "polling" })
    })

    it("keeps looking when the check fails, and says the reorg when it works again", async (t) => {
      const chain = polledChain(100)
      let failing = false
      const follow = following(t, {
        ...chain.config,
        readHashes: async (wanted) => {
          if (failing) throw new Error("down")
          return chain.config.readHashes(wanted)
        },
      })
      await follow.next()
      failing = true
      chain.reorg(100, 200)
      assert.deepEqual(await follow.next(), { kind: "down", message: "down" })
      failing = false
      assert.deepEqual(await follow.next(), { kind: "block", blockNum: 200, reorgFrom: 100, via: "polling" })
    })

    it("says a reorg that comes between a poll's two reads, and then the new head", async (t) => {
      // Found in WORK-520's review: the check saw the old chain, the head the new one, and only that head got checked after.
      const chain = polledChain(100)
      let between: (() => void) | null = null
      const afterRead = <T,>(result: T) => {
        const run = between
        between = null
        run?.()
        return result
      }
      const follow = following(t, {
        readMark: async (after) => afterRead(await chain.config.readMark(after)),
        readHashes: async (wanted) => afterRead(await chain.config.readHashes(wanted)),
      })
      await follow.next()
      chain.extend(200)
      assert.deepEqual(await follow.next(), { kind: "block", blockNum: 200, reorgFrom: null, via: "polling" })
      chain.extend(300)
      between = () => chain.reorg(150, 500)
      // The head it read first is from the old chain, so the reorg is said again once it's checked that one.
      assert.deepEqual(await follow.next(), { kind: "block", blockNum: 300, reorgFrom: 101, via: "polling" })
      assert.deepEqual(await follow.next(), { kind: "block", blockNum: 500, reorgFrom: 101, via: "polling" })
      chain.extend(501, "b")
      assert.deepEqual(await follow.next(), { kind: "block", blockNum: 501, reorgFrom: null, via: "polling" })
    })

    it("holds a reorg it found with no new head to say it on, until there is one", async (t) => {
      const chain = polledChain(100)
      let between: (() => void) | null = null
      const follow = following(t, {
        readMark: async (after) => {
          const mark = await chain.config.readMark(after)
          between?.()
          between = null
          return mark
        },
        readHashes: chain.config.readHashes,
      })
      await follow.next()
      chain.extend(200)
      await follow.next()
      between = () => chain.reorg(150, 500)
      assert.deepEqual(await follow.next(), { kind: "block", blockNum: 500, reorgFrom: 101, via: "polling" })
    })

    it("asks about one block on each poll, and remembers no more than any reorg could need", async (t) => {
      const chain = polledChain(100)
      const follow = following(t, chain.config)
      await follow.next()
      chain.extend(700)
      await follow.next()
      chain.extend(1500)
      await follow.next()
      assert.ok(chain.asked.every((blocks) => blocks.length === 1))
      chain.reorg(1000, 1600)
      assert.deepEqual(await follow.next(), { kind: "block", blockNum: 1600, reorgFrom: 701, via: "polling" })
      assert.deepEqual(chain.asked.at(-1), [700, 1500])
    })
  })

  it("counts what polling said after the last streamed block as replaced, when the stream comes back past it on another chain", async (t) => {
    // Found in WORK-497's review: block 101 still holds, so Amp resumes with plain new blocks and reports nothing.
    const hand = handStream()
    let mark = MARK
    const chain = following(t, { stream: hand.stream, readMark: async () => mark, retryMs: 20 })
    const first = chain.next()
    await new Promise((resolve) => setTimeout(resolve, 2))
    hand.send(blockOf(101))
    assert.deepEqual(await first, { kind: "block", blockNum: 101, reorgFrom: null, via: "stream" })
    mark = { blockNum: 500, hash: "0x500" }
    hand.send(new Error("connection lost"))
    assert.deepEqual(await chain.next(), { kind: "block", blockNum: 500, reorgFrom: null, via: "polling" })
    await until(t, () => hand.resumes.length >= 2)
    assert.deepEqual(hand.resumes[1], { blockNum: 101, hash: "0x101" })
    hand.send(blockOf(601, 102, "0xnew601"))
    assert.deepEqual(await chain.next(), { kind: "block", blockNum: 601, reorgFrom: 102, via: "stream" })
  })

  it("counts what polling said as replaced even when the stream gets to the newest polled block with its hash, since an earlier one can be from another chain", async (t) => {
    const hand = handStream()
    let mark = MARK
    const chain = following(t, { stream: hand.stream, readMark: async () => mark, retryMs: 20 })
    const first = chain.next()
    await new Promise((resolve) => setTimeout(resolve, 2))
    hand.send(blockOf(101))
    await first
    mark = { blockNum: 500, hash: "0xold500" }
    hand.send(new Error("connection lost"))
    assert.equal((await chain.next()).kind, "block")
    mark = { blockNum: 501, hash: "0xnew501" }
    assert.deepEqual(await chain.next(), { kind: "block", blockNum: 501, reorgFrom: null, via: "polling" })
    await until(t, () => hand.resumes.length >= 2)
    hand.send(blockOf(501, 102, "0xnew501"))
    assert.deepEqual(await chain.next(), { kind: "block", blockNum: 501, reorgFrom: 102, via: "stream" })
  })

  it("remembers the first block polling said through a stream that dies catching up", async (t) => {
    // Found in WORK-497's review: the next try resumes from block 300, but the replaced blocks can be before it.
    const hand = handStream()
    let mark = MARK
    const chain = following(t, { stream: hand.stream, readMark: async () => mark, retryMs: 20 })
    const first = chain.next()
    await new Promise((resolve) => setTimeout(resolve, 2))
    hand.send(blockOf(101))
    await first
    mark = { blockNum: 500, hash: "0xold500" }
    hand.send(new Error("connection lost"))
    assert.deepEqual(await chain.next(), { kind: "block", blockNum: 500, reorgFrom: null, via: "polling" })
    await until(t, () => hand.resumes.length >= 2)
    hand.send(blockOf(300, 102, "0xnew300"), new Error("connection lost again"))
    await until(t, () => hand.resumes.length >= 3)
    assert.deepEqual(hand.resumes[2], { blockNum: 300, hash: "0xnew300" })
    hand.send(blockOf(601, 301, "0xnew601"))
    assert.deepEqual(await chain.next(), { kind: "block", blockNum: 601, reorgFrom: 102, via: "stream" })
  })

  it("polls when the stream goes quiet, even though it's still connected", async (t) => {
    const hand = handStream()
    let mark = MARK
    const chain = following(t, { stream: hand.stream, readMark: async () => mark, stallMs: 5, retryMs: 60_000 })
    const first = chain.next()
    await new Promise((resolve) => setTimeout(resolve, 2))
    mark = { blockNum: 101, hash: "0x101" }
    assert.deepEqual(await first, { kind: "block", blockNum: 101, reorgFrom: null, via: "polling" })
  })

  it("won't replay the chain from a stream that ignored where to resume", async (t) => {
    const hand = handStream()
    const warnings: string[] = []
    let mark = { blockNum: 5000, hash: "0x5000" }
    const chain = following(t, { stream: hand.stream, readMark: async () => mark, retryMs: 60_000, logger: { warn: (message) => warnings.push(message) } })
    const first = chain.next()
    await new Promise((resolve) => setTimeout(resolve, 2))
    mark = { blockNum: 5001, hash: "0x5001" }
    hand.send(blockOf(1000, 0))
    assert.deepEqual(await first, { kind: "block", blockNum: 5001, reorgFrom: null, via: "polling" })
    assert.match(warnings.join(), /went back to block/)
  })

  it("doesn't tick faster than it's asked to, however fast the blocks come, and keeps what it merged", async (t) => {
    const hand = handStream()
    const chain = following(t, { stream: hand.stream, tickMs: 200 })
    const first = chain.next()
    await new Promise((resolve) => setTimeout(resolve, 2))
    // From before the first tick, since the wait counts from there: a stall after it would shorten what's left to wait.
    const started = Date.now()
    hand.send(blockOf(101))
    await first
    const second = chain.next()
    hand.send(blockOf(102), blockOf(101, 101, "0xnew"), blockOf(102, 102, "0xnew2"), blockOf(103))
    assert.deepEqual(await second, { kind: "block", blockNum: 103, reorgFrom: 101, via: "stream" })
    assert.ok(Date.now() - started >= 195)
  })

  it("sees a block replaced at the head while polling, and says when Amp is down", async (t) => {
    const answers: (BlockMark | Error)[] = [{ blockNum: 101, hash: "0xa" }, { blockNum: 101, hash: "0xb" }, new Error("down")]
    const chain = following(t, { readMark: async () => {
      const next = answers.shift()
      if (next instanceof Error) throw next
      return next ?? null
    } })
    assert.deepEqual(await chain.next(), { kind: "block", blockNum: 101, reorgFrom: null, via: "polling" })
    assert.deepEqual(await chain.next(), { kind: "block", blockNum: 101, reorgFrom: 101, via: "polling" })
    assert.deepEqual(await chain.next(), { kind: "down", message: "down" })
  })
})

describe("Amp's stream on the wire", FOLLOWING, () => {
  const metadata = (start: number, end: number, complete: boolean, network = "base-mainnet") => Buffer.from(JSON.stringify({ ranges: [{ network, numbers: { start, end }, hash: `0x${end}`, prev_hash: "0x0" }], ranges_complete: complete }))

  // The two Flight messages this reads, by hand, so the bytes are what's on the wire and not what a library makes of them.
  const varint = (value: number): Buffer => (value < 0x80 ? Buffer.from([value]) : Buffer.concat([Buffer.from([(value & 0x7f) | 0x80]), varint(value >>> 7)]))
  const field = (number: number, bytes: Buffer) => (bytes.length === 0 ? Buffer.alloc(0) : Buffer.concat([varint((number << 3) | 2), varint(bytes.length), bytes]))
  const flightData = ({ header = 0, meta = Buffer.alloc(0), body = 0 }: { header?: number; meta?: Buffer; body?: number }) => Buffer.concat([field(2, Buffer.alloc(header)), field(3, meta), field(1000, Buffer.alloc(body))])
  const flightInfo = () => field(3, field(1, field(1, Buffer.from("ticket"))))
  const grpcFrame = (message: Buffer) => {
    const prefix = Buffer.alloc(5)
    prefix.writeUInt32BE(message.length, 1)
    return Buffer.concat([prefix, message])
  }

  const seen: Record<string, string | undefined>[] = []
  let port: number
  let close = () => {}

  before(async () => {
    const server = createHttp2Server((req, res) => {
      req.resume()
      res.writeHead(200, { "content-type": "application/grpc+proto" })
      if (req.url.endsWith("/GetFlightInfo")) {
        seen.push({ stream: req.headers["amp-stream"] as string, resume: req.headers["amp-resume"] as string, auth: req.headers.authorization })
        res.write(grpcFrame(flightInfo()))
      } else {
        // What Amp sends: the schema, a batch of rows, its watermark, then the empty keepalive, which isn't Arrow.
        res.write(grpcFrame(flightData({ header: 296 })))
        res.write(grpcFrame(flightData({ header: 312, body: 640, meta: metadata(101, 101, false) })))
        res.write(grpcFrame(flightData({ header: 296, body: 128, meta: metadata(101, 101, true) })))
        res.write(grpcFrame(flightData({})))
        res.write(grpcFrame(flightData({ header: 296, body: 128, meta: metadata(102, 102, true) })))
      }
      res.addTrailers({ "grpc-status": "0" })
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    port = (server.address() as AddressInfo).port
    close = () => server.close()
  })
  after(() => close())

  it("reads ranges past a keepalive, and resumes where it's asked with the token", async (t) => {
    const stream = createRangeStream(`http://127.0.0.1:${port}`, "secret", "base-mainnet")
    const ranges: StreamRange[] = []
    for await (const range of stream("SELECT 1", { blockNum: 100, hash: "0x100" }, t.signal)) ranges.push(range)
    assert.deepEqual(ranges, [{ start: 101, end: 101, hash: "0x101", complete: false }, { start: 101, end: 101, hash: "0x101", complete: true }, { start: 102, end: 102, hash: "0x102", complete: true }])
    assert.deepEqual(seen.at(-1), { stream: "true", resume: JSON.stringify({ "base-mainnet": { number: 100, hash: "0x100" } }), auth: "Bearer secret" })
  })

  it("fails on another network's ranges, since its resume wouldn't have counted", async () => {
    assert.throws(() => parseStreamRange(metadata(1, 1, true, "mainnet"), "base-mainnet"), /reports mainnet, not base-mainnet/)
  })

  it("watches a wallet through createPricetag, which polls when the stream is gone", async () => {
    // Nothing listens here, so both the stream and the reads fail, and it has to end cleanly anyway.
    const stop = new AbortController()
    const warnings: string[] = []
    const client = createPricetag({ url: "http://127.0.0.1:1", dataset: "benface/pricetag@0.0.1", startBlock: 50, logger: { warn: (message) => warnings.push(message) } })
    setTimeout(() => stop.abort(), 200)
    for await (const _ of client.watchWallet(ADDRESS, { signal: stop.signal })) assert.fail("there's nothing to read")
    assert.ok(warnings.some((w) => w.startsWith("Couldn't read")))
  })
})

/** A chain a test can move and reorg: what its tables hold, how far it's gone, and a stream of what happened. */
function chainAt(block: number, tables: Tables, onQuery: (sql: string) => void = () => {}, follow: Partial<FollowConfig> = {}) {
  const chain: { block: number; tables: Tables; through?: number; forkedFrom: number } = { block, tables, forkedFrom: Infinity }
  const hashOf = (n: number) => `${n >= chain.forkedFrom ? "b" : ""}${n}`.padStart(64, "0")
  const query: Query = async <T,>(sql: string) => {
    onQuery(sql)
    // A test's stream says hashes of its own, so only a test with no stream can check them.
    const asked = /\.blocks WHERE .*block_num IN \(([^)]*)\)/.exec(sql)
    if (asked) return (follow.stream === null ? asked[1]!.split(", ").filter((n) => Number(n) <= chain.block).map((n) => ({ block_num: n, hash: hashOf(Number(n)) })) : []) as T[]
    if (sql.includes(".blocks")) return [{ block_num: String(chain.block), hash: hashOf(chain.block), timestamp: 1_800_000_000_000 }] as T[]
    return fakeAmp(chain.tables, chain.through ?? chain.block).query<T>(sql)
  }
  const hand = handStream()
  const client = pricetagClient(query, { dataset: "benface/pricetag@0.0.1", startBlock: 50, stream: hand.stream, logger: QUIET, readL1Fees: async (txs) => new Map(txs.map((t) => [t.txHash, "0"])), follow: { pollMs: 1, tickMs: 0, ...follow } })
  return { chain, hand, client }
}

const creditAt = (block: number, tx: string, amount: string) => ({ block_num: String(block), timestamp: 1_800_000_000_000, tx_hash: tx, tx_index: 3, log_index: 0, token: ETH, account: ME, side: "credit", amount, kind: "eth" })
const balancesThrough = (through: number, eth: string) => Object.fromEntries([...Array(through + 1).keys()].map((block) => [String(block), { ETH: block < 49 ? "0" : eth }]))
const legsOf = (update: WalletUpdate) => update.legs.filter((leg) => !leg.opening).map((leg) => `${leg.blockNum}:${leg.txHash}:${leg.delta}`)

describe("watchWallet", FOLLOWING, () => {
  it("gives the wallet now, then again on each new block, with the blocks it covers", async (t) => {
    const { chain, hand, client } = chainAt(100, { legs: [creditAt(100, "aa", "5")], reference_prices: [{ ...REFERENCE, block_num: "100" }], balances: balancesThrough(120, "5") })
    const updates = client.watchWallet(ADDRESS, { signal: t.signal })
    const first = (await updates.next()).value as WalletUpdate
    assert.deepEqual(first.blocks, { fromBlock: 50, toBlock: 100 })
    assert.equal(first.via, null)
    assert.equal(first.reorgFrom, null)
    assert.deepEqual(legsOf(first), ["100:0xaa:5"])

    chain.block = 101
    chain.tables = { ...chain.tables, legs: [creditAt(100, "aa", "5"), creditAt(101, "bb", "2")] }
    hand.send(blockOf(101))
    const second = (await updates.next()).value as WalletUpdate
    assert.deepEqual(second.blocks, { fromBlock: 50, toBlock: 101 })
    assert.equal(second.via, "stream")
    assert.deepEqual(legsOf(second), ["100:0xaa:5", "101:0xbb:2"])
  })

  it("replaces what a reorg changed at the same height, and doesn't add to it", async (t) => {
    const { chain, hand, client } = chainAt(100, { legs: [creditAt(100, "aa", "5")], reference_prices: [{ ...REFERENCE, block_num: "100" }], balances: balancesThrough(120, "5") })
    const updates = client.watchWallet(ADDRESS, { signal: t.signal })
    await updates.next()

    // The head doesn't move, which polling can't tell from nothing having happened.
    chain.tables = { ...chain.tables, legs: [creditAt(100, "cc", "7")], balances: balancesThrough(120, "7") }
    hand.send(blockOf(100, 100, "0xnew"))
    const update = (await updates.next()).value as WalletUpdate
    assert.equal(update.reorgFrom, 100)
    assert.deepEqual(legsOf(update), ["100:0xcc:7"])
    assert.equal(update.positions.find((p) => p.asset === "ETH")?.values.qty, "7")
  })

  it("replaces a reorg deeper than the blocks it would re-read anyway", async (t) => {
    const { chain, hand, client } = chainAt(150, { legs: [creditAt(100, "aa", "5"), creditAt(149, "dd", "1")], reference_prices: [{ ...REFERENCE, block_num: "100" }, { ...REFERENCE, block_num: "149" }], balances: balancesThrough(200, "6") })
    const updates = client.watchWallet(ADDRESS, { signal: t.signal })
    assert.deepEqual(legsOf((await updates.next()).value as WalletUpdate), ["100:0xaa:5", "149:0xdd:1"])

    // 51 blocks back, and the new chain is shorter than the one it replaced.
    chain.block = 149
    chain.tables = { ...chain.tables, legs: [creditAt(120, "ee", "9")], reference_prices: [{ ...REFERENCE, block_num: "120" }, { ...REFERENCE, block_num: "149" }], balances: balancesThrough(200, "9") }
    hand.send(blockOf(149, 100, "0xnew"))
    const update = (await updates.next()).value as WalletUpdate
    assert.equal(update.reorgFrom, 100)
    assert.deepEqual(update.blocks, { fromBlock: 50, toBlock: 149 })
    assert.deepEqual(legsOf(update), ["120:0xee:9"])
  })

  // Before the fix, no update came, so this would wait forever.
  it("replaces a reorg that made the chain longer, past the blocks it would re-read anyway, with no stream at all", { timeout: 5_000 }, async (t) => {
    // Found on a real Amp (WORK-497): the replaced transfers stayed, and only the balance check said something was wrong.
    const { chain, client } = chainAt(100, { legs: [], reference_prices: [{ ...REFERENCE, block_num: "100" }], balances: balancesThrough(600, "0") }, undefined, { stream: null })
    const updates = client.watchWallet(ADDRESS, { signal: t.signal })
    assert.deepEqual(legsOf((await updates.next()).value as WalletUpdate), [])

    chain.block = 150
    chain.tables = { ...chain.tables, legs: [creditAt(149, "dd", "1")], reference_prices: [{ ...REFERENCE, block_num: "149" }], balances: balancesThrough(600, "1") }
    let update = (await updates.next()).value as WalletUpdate
    while (update.blocks.toBlock < 150) update = (await updates.next()).value as WalletUpdate
    assert.deepEqual(legsOf(update), ["149:0xdd:1"])
    await new Promise((resolve) => setTimeout(resolve, 10))

    // 350 blocks past the old head, so a re-read of recent blocks doesn't reach the replaced transfer.
    chain.forkedFrom = 120
    chain.block = 500
    chain.tables = { ...chain.tables, legs: [creditAt(120, "ee", "9")], reference_prices: [{ ...REFERENCE, block_num: "120" }, { ...REFERENCE, block_num: "500" }], balances: balancesThrough(600, "9") }
    update = (await updates.next()).value as WalletUpdate
    while (update.reorgFrom === null) update = (await updates.next()).value as WalletUpdate
    assert.equal(update.reorgFrom, 101)
    assert.equal(update.via, "polling")
    assert.deepEqual(legsOf(update), ["120:0xee:9"])
  })

  it("replaces a transfer when a reorg comes between a poll's two reads, with no stream at all", { timeout: 5_000 }, async (t) => {
    // Found in WORK-520's review: the wallet kept 160:0xdd:1 for good, though the dataset no longer had it.
    let between: (() => void) | null = null
    let seen: string | null = null
    const onQuery = (sql: string) => {
      if (!between || !sql.includes("SELECT block_num, hash FROM")) return
      const read = sql.includes(" IN (") ? "hashes" : "head"
      if (seen === null || seen === read) {
        seen = read
        return
      }
      between()
      between = null
    }
    const { chain, client } = chainAt(100, { legs: [], reference_prices: [{ ...REFERENCE, block_num: "100" }], balances: balancesThrough(600, "0") }, onQuery, { stream: null })
    const updates = client.watchWallet(ADDRESS, { signal: t.signal })
    assert.deepEqual(legsOf((await updates.next()).value as WalletUpdate), [])

    chain.block = 200
    chain.tables = { ...chain.tables, legs: [creditAt(160, "dd", "1")], reference_prices: [{ ...REFERENCE, block_num: "160" }], balances: balancesThrough(600, "1") }
    let update = (await updates.next()).value as WalletUpdate
    while (update.blocks.toBlock < 200) update = (await updates.next()).value as WalletUpdate
    assert.deepEqual(legsOf(update), ["160:0xdd:1"])

    chain.block = 300
    between = () => {
      chain.forkedFrom = 150
      chain.block = 500
      chain.tables = { ...chain.tables, legs: [], reference_prices: [{ ...REFERENCE, block_num: "500" }], balances: balancesThrough(600, "0") }
    }
    // A wallet read already underway can get to the new head with the old transfer, just before it's told about the reorg.
    update = (await updates.next()).value as WalletUpdate
    while (update.reorgFrom === null) update = (await updates.next()).value as WalletUpdate
    assert.equal(update.reorgFrom, 101)
    assert.deepEqual(legsOf(update), [])
  })

  it("replaces a transfer polling read from a chain that was replaced before the stream came back, past the blocks it would re-read anyway", { timeout: 5_000 }, async (t) => {
    const { chain, hand, client } = chainAt(100, { legs: [creditAt(100, "aa", "5")], reference_prices: [{ ...REFERENCE, block_num: "100" }], balances: balancesThrough(700, "5") }, undefined, { retryMs: 5 })
    const updates = client.watchWallet(ADDRESS, { signal: t.signal })
    await updates.next()
    chain.block = 101
    hand.send(blockOf(101))
    assert.equal(((await updates.next()).value as WalletUpdate).via, "stream")

    // The stream drops, and polling reads a transfer at block 200.
    chain.block = 500
    chain.tables = { ...chain.tables, legs: [creditAt(100, "aa", "5"), creditAt(200, "bb", "2")], reference_prices: [{ ...REFERENCE, block_num: "100" }, { ...REFERENCE, block_num: "200" }], balances: balancesThrough(700, "7") }
    hand.send(new Error("connection lost"))
    const polled = (await updates.next()).value as WalletUpdate
    assert.equal(polled.via, "polling")
    assert.deepEqual(legsOf(polled), ["100:0xaa:5", "200:0xbb:2"])

    // Then blocks from 200 on are replaced, with another transfer at 250, and the stream comes back from block 101.
    await until(t, () => hand.resumes.length >= 2)
    chain.block = 601
    chain.tables = { ...chain.tables, legs: [creditAt(100, "aa", "5"), creditAt(250, "cc", "3")], reference_prices: [{ ...REFERENCE, block_num: "100" }, { ...REFERENCE, block_num: "250" }], balances: balancesThrough(700, "8") }
    hand.send(blockOf(601, 102, "0xnew601"))
    const update = (await updates.next()).value as WalletUpdate
    assert.equal(update.reorgFrom, 102)
    assert.deepEqual(legsOf(update), ["100:0xaa:5", "250:0xcc:3"])
  })

  it("replaces a transfer polling read from a chain that was replaced, when the stream dies once more before it catches up", { timeout: 5_000 }, async (t) => {
    const { chain, hand, client } = chainAt(100, { legs: [creditAt(100, "aa", "5")], reference_prices: [{ ...REFERENCE, block_num: "100" }], balances: balancesThrough(700, "5") }, undefined, { retryMs: 5 })
    const updates = client.watchWallet(ADDRESS, { signal: t.signal })
    await updates.next()
    chain.block = 101
    hand.send(blockOf(101))
    assert.equal(((await updates.next()).value as WalletUpdate).via, "stream")

    // The stream drops, and polling reads a transfer at block 200.
    chain.block = 500
    chain.tables = { ...chain.tables, legs: [creditAt(100, "aa", "5"), creditAt(200, "bb", "2")], reference_prices: [{ ...REFERENCE, block_num: "100" }, { ...REFERENCE, block_num: "200" }], balances: balancesThrough(700, "7") }
    hand.send(new Error("connection lost"))
    assert.deepEqual(legsOf((await updates.next()).value as WalletUpdate), ["100:0xaa:5", "200:0xbb:2"])

    // Blocks from 200 on are replaced, and the stream comes back from block 101, but dies again at block 300.
    await until(t, () => hand.resumes.length >= 2)
    chain.tables = { ...chain.tables, legs: [creditAt(100, "aa", "5"), creditAt(250, "cc", "3")], reference_prices: [{ ...REFERENCE, block_num: "100" }, { ...REFERENCE, block_num: "250" }], balances: balancesThrough(700, "8") }
    hand.send(blockOf(300, 102, "0xnew300"), new Error("connection lost again"))
    await until(t, () => hand.resumes.length >= 3)

    chain.block = 601
    hand.send(blockOf(601, 301, "0xnew601"))
    let update = (await updates.next()).value as WalletUpdate
    while (update.reorgFrom === null) update = (await updates.next()).value as WalletUpdate
    assert.equal(update.reorgFrom, 102)
    assert.deepEqual(legsOf(update), ["100:0xaa:5", "250:0xcc:3"])
  })

  it("replaces a reorg the stream reported before it died, past the blocks it would re-read anyway", async (t) => {
    const { chain, hand, client } = chainAt(150, { legs: [creditAt(100, "aa", "5")], reference_prices: [{ ...REFERENCE, block_num: "100" }], balances: balancesThrough(200, "5") })
    const updates = client.watchWallet(ADDRESS, { signal: t.signal })
    assert.deepEqual(legsOf((await updates.next()).value as WalletUpdate), ["100:0xaa:5"])

    chain.block = 151
    chain.tables = { ...chain.tables, legs: [creditAt(120, "bb", "7")], reference_prices: [{ ...REFERENCE, block_num: "120" }], balances: balancesThrough(200, "7") }
    hand.send(dataOf(151, 100, "0xnew"), new Error("gone before the block was complete"))
    const update = (await updates.next()).value as WalletUpdate
    assert.equal(update.reorgFrom, 100)
    assert.equal(update.via, "polling")
    assert.deepEqual(legsOf(update), ["120:0xbb:7"])
  })

  describe("a reorg the tables haven't rewritten yet", () => {
    const OLD: Tables = { legs: [creditAt(100, "aa", "5")], reference_prices: [{ ...REFERENCE, block_num: "100" }], balances: balancesThrough(300, "5") }
    const NEW: Tables = { legs: [creditAt(120, "bb", "7")], reference_prices: [{ ...REFERENCE, block_num: "120" }], balances: balancesThrough(300, "7") }
    const legsAt = async (updates: AsyncGenerator<WalletUpdate, void, void>) => (await updates.next()).value as WalletUpdate

    it("replaces the blocks once they do, past the ones it would re-read anyway", async (t) => {
      const { chain, hand, client } = chainAt(150, OLD)
      const updates = client.watchWallet(ADDRESS, { signal: t.signal })
      await updates.next()

      // The chain has switched, and the tables still answer with the old rows, so this read looks like any other.
      chain.block = 151
      chain.through = 150
      hand.send(dataOf(151, 100, "0xnew"), new Error("gone before the block was complete"))
      const provisional = await legsAt(updates)
      assert.equal(provisional.reorgFrom, 100)
      assert.equal(provisional.unsettledFrom, 100)
      assert.deepEqual(legsOf(provisional), ["100:0xaa:5"])

      chain.tables = NEW
      chain.block = chain.through = 152
      const replaced = await legsAt(updates)
      assert.equal(replaced.reorgFrom, null)
      assert.equal(replaced.unsettledFrom, 100)
      assert.deepEqual(legsOf(replaced), ["120:0xbb:7"])
    })

    it("goes on for as long as the tables take, then goes back to reading recent blocks", async (t) => {
      const windows: string[] = []
      const { chain, hand, client } = chainAt(150, OLD, (sql) => {
        const window = /\.legs WHERE block_num BETWEEN (\d+) AND/.exec(sql)?.[1]
        if (window) windows.push(window)
      })
      const updates = client.watchWallet(ADDRESS, { signal: t.signal })
      await updates.next()
      chain.block = 151
      chain.through = 150
      hand.send(dataOf(151, 100, "0xnew"), new Error("gone before the block was complete"))
      await legsAt(updates)

      // Still the old rows for 29 blocks past the old tip, then the new ones at the last read that goes back.
      for (const block of [160, 180]) {
        chain.block = chain.through = block
        assert.deepEqual(legsOf(await legsAt(updates)), ["100:0xaa:5"])
      }
      chain.tables = NEW
      chain.block = chain.through = 181
      const settled = await legsAt(updates)
      assert.deepEqual(legsOf(settled), ["120:0xbb:7"])
      assert.equal(settled.unsettledFrom, null)
      assert.equal(windows.at(-1), "100")

      chain.block = chain.through = 182
      await legsAt(updates)
      assert.equal(windows.at(-1), "152")
    })

    it("replaces a wallet nobody read while it settled", async (t) => {
      const { chain, hand, client } = chainAt(150, OLD)
      const other = `0x${"00".repeat(19)}bb`
      assert.deepEqual(legsOf({ ...(await client.getPortfolio(ADDRESS)), via: null, reorgFrom: null }), ["100:0xaa:5"])
      const updates = client.watchWallet(other, { signal: t.signal })
      await updates.next()
      chain.block = 151
      chain.through = 150
      hand.send(dataOf(151, 100, "0xnew"), new Error("gone before the block was complete"))
      await legsAt(updates)
      assert.equal((await client.getPortfolio(ADDRESS)).unsettledFrom, 100)

      // Only the other wallet follows the chain, well past the point where it's settled. Then this one is read again.
      for (const block of [190, 191]) {
        chain.block = chain.through = block
        await legsAt(updates)
      }
      assert.equal((await client.getPortfolio(other)).unsettledFrom, null)
      chain.tables = NEW
      const late = await client.getPortfolio(ADDRESS)
      assert.deepEqual(late.legs.filter((leg) => !leg.opening).map((leg) => leg.txHash), ["0xbb"])
      assert.equal(late.unsettledFrom, null)
    })

    it("replaces them when the reorg reaches back past the wallet's first block", async (t) => {
      const { chain, hand, client } = chainAt(150, OLD)
      const updates = client.watchWallet(ADDRESS, { from: 110, signal: t.signal })
      await updates.next()
      chain.block = 151
      chain.through = 150
      chain.tables = { ...OLD, legs: [creditAt(115, "cc", "1")], reference_prices: [{ ...REFERENCE, block_num: "115" }] }
      hand.send(dataOf(151, 100, "0xnew"), new Error("gone before the block was complete"))
      assert.deepEqual(legsOf(await legsAt(updates)), ["115:0xcc:1"])

      chain.tables = NEW
      chain.block = chain.through = 152
      assert.deepEqual(legsOf(await legsAt(updates)), ["120:0xbb:7"])
    })

    it("won't let the chain's head settle a read as of a fixed block while the tables serve the old blocks", async () => {
      const state = { head: 150, through: 150, tables: OLD }
      let reads = 0
      const query: Query = async <T,>(sql: string) => {
        if (sql.includes(".legs WHERE block_num BETWEEN")) reads++
        return fakeAmp(state.tables, state.through).query<T>(sql)
      }
      const source = datasetSource(query, { dataset: "benface/pricetag@0.0.1", baseDataset: "b", startBlock: 50, network: "base_mainnet" })
      const wallets = createWallets(source, async () => ({ blockNum: state.head, timestamp: new Date(1_800_000_000_000).toISOString() }), async () => new Map(), QUIET)
      const range = { from: 50, to: 125 }
      const hashes = async () => (await wallets.get(ADDRESS, range)).legs.filter((leg) => !leg.opening).map((leg) => leg.txHash)
      assert.deepEqual(await hashes(), ["0xaa"])
      await wallets.rewind(100, 150)

      // The chain goes well past where it would be settled, with the tables still at the old tip.
      for (const head of [151, 180, 300]) {
        state.head = head
        assert.deepEqual(await hashes(), ["0xaa"])
        assert.equal(wallets.unsettledFrom(ADDRESS, range), 100)
      }

      state.tables = NEW
      state.through = 151
      assert.deepEqual(await hashes(), ["0xbb"])
      assert.equal(wallets.unsettledFrom(ADDRESS, range), 100)

      // Only once they're past it, and that read is the one that says so, with what they rewrote.
      state.tables = { ...NEW, legs: [creditAt(121, "cc", "8")], reference_prices: [{ ...REFERENCE, block_num: "121" }] }
      state.through = 180
      assert.deepEqual(await hashes(), ["0xcc"])
      assert.equal(wallets.unsettledFrom(ADDRESS, range), null)

      // Settled, and now it's fixed: nothing read again, even if a later table changed.
      const settled = reads
      state.head = 400
      await hashes()
      await hashes()
      assert.equal(reads, settled)
    })

    it("replaces cost notes and market prices from those blocks too, past the ones it would re-read anyway", async () => {
      const state = { through: 150, tables: { ...OLD, legs: [{ ...creditAt(100, "aa", "5"), kind: "gas", side: "debit" }, { ...creditAt(105, "dd", "5"), token: "940181a94a35a4569e4529a3cdfb74e38fd98631", kind: "erc20" }], reference_prices: [{ ...REFERENCE, block_num: "100" }, { ...REFERENCE, block_num: "105" }] } as Tables, note: "old", price: "1" }
      const query: Query = async <T,>(sql: string) => fakeAmp(state.tables, state.through).query<T>(sql)
      const noteAt = (blockNum: number): CostNote => ({ noteTx: `0x${state.note}`, blockNum, txHash: `0x${"ab".repeat(32)}`, asset: "ETH", usdMicros: "1" })
      const source: Source = {
        ...datasetSource(query, { dataset: "benface/pricetag@0.0.1", baseDataset: "b", startBlock: 50, network: "base_mainnet" }),
        readNotes: async (_address, blocks) => blocks.map(noteAt),
        marketReady: async () => true,
        readMarketTrades: async () => [],
      }
      const marketReads: number[] = []
      const counting: Source = { ...source, readMarketTrades: async (_asset, _from, to) => (marketReads.push(to), []) }
      const wallets = createWallets(counting, async () => ({ blockNum: state.through, timestamp: new Date(1_800_000_000_000).toISOString() }), async () => new Map(), QUIET)
      const noteTxs = async () => (await wallets.get(ADDRESS, { from: 50 })).notes.map((note) => note.noteTx)
      assert.deepEqual(await noteTxs(), ["0xold"])

      marketReads.length = 0
      await wallets.rewind(100, 150)
      // The tables haven't rewritten anything yet, so the read gets the old note back.
      assert.deepEqual(await noteTxs(), ["0xold"])
      assert.ok(marketReads.length > 0, "a market price from the replaced blocks is read again")

      state.note = "new"
      state.through = 151
      assert.deepEqual(await noteTxs(), ["0xnew"])
    })

    it("doesn't keep a price read outside a wallet's own read that crossed the reorg", async () => {
      const tables: Tables = { ...OLD, legs: [{ ...creditAt(105, "dd", "5"), token: "940181a94a35a4569e4529a3cdfb74e38fd98631", kind: "erc20" }], reference_prices: [{ ...REFERENCE, block_num: "105" }, { ...REFERENCE, block_num: "150" }] }
      const query: Query = async <T,>(sql: string) => fakeAmp(tables, 150).query<T>(sql)
      const held = heldPromise()
      const started = heldPromise()
      let holding = false
      const asked: number[] = []
      const source: Source = {
        ...datasetSource(query, { dataset: "benface/pricetag@0.0.1", baseDataset: "b", startBlock: 50, network: "base_mainnet" }),
        marketReady: async () => true,
        readMarketTrades: async (_asset, _from, to) => {
          asked.push(to)
          if (holding) {
            started.resolve()
            await held.promise
          }
          return []
        },
      }
      const wallets = createWallets(source, async () => ({ blockNum: 150, timestamp: new Date(1_800_000_000_000).toISOString() }), async () => new Map(), QUIET)
      await wallets.get(ADDRESS, {})
      const facts = await wallets.factsAt(ADDRESS, 150, { withBalances: false })
      await wallets.rewind(150, 150)

      // The comparison's own read of a price, which isn't one of the reads a reorg waits for.
      holding = true
      const crossing = wallets.marketOn(ADDRESS, facts!, {})
      await started.promise
      await wallets.rewind(150, 150)
      holding = false
      held.resolve()
      assert.equal((await crossing).checked, false)

      asked.length = 0
      await wallets.get(ADDRESS, {})
      assert.ok(asked.includes(150), "the price is read again, from the chain that replaced it")
    })

    it("doesn't touch a read as of a block before the reorg", async () => {
      const { chain, client } = chainAt(150, { ...OLD, legs: [creditAt(90, "aa", "5")], reference_prices: [{ ...REFERENCE, block_num: "90" }] })
      const asOf = { to: 95 }
      assert.equal((await client.getPortfolio(ADDRESS, asOf)).unsettledFrom, null)
      chain.block = chain.through = 190
      assert.equal((await client.getPortfolio(ADDRESS, asOf)).unsettledFrom, null)
    })

    it("replaces a read as of a fixed block, which never gets past the reorg itself", async (t) => {
      const { chain, hand, client } = chainAt(150, OLD)
      const asOf = { to: 125 }
      const hashes = async () => (await client.getPortfolio(ADDRESS, asOf)).legs.filter((leg) => !leg.opening).map((leg) => leg.txHash)
      assert.deepEqual(await hashes(), ["0xaa"])
      // Past any ordinary reorg: this read is fixed now.
      chain.block = chain.through = 180
      await hashes()
      chain.block = chain.through = 181
      await hashes()

      const updates = client.watchWallet(ADDRESS, { signal: t.signal })
      await updates.next()
      chain.block = 182
      chain.through = 181
      hand.send(dataOf(182, 100, "0xnew"), new Error("gone before the block was complete"))
      await legsAt(updates)
      assert.deepEqual(await hashes(), ["0xaa"])
      assert.equal((await client.getPortfolio(ADDRESS, asOf)).unsettledFrom, 100)

      chain.tables = NEW
      assert.deepEqual(await hashes(), ["0xbb"])
      chain.block = chain.through = 212
      await hashes()
      assert.equal((await client.getPortfolio(ADDRESS, asOf)).unsettledFrom, null)
    })
  })

  it("gives each block the dataset finishes while it's behind a head that doesn't move", async (t) => {
    const { chain, hand, client } = chainAt(105, { legs: [], reference_prices: [{ ...REFERENCE, block_num: "100" }], balances: balancesThrough(120, "0") })
    chain.through = 100
    const updates = client.watchWallet(ADDRESS, { signal: t.signal })
    assert.equal(((await updates.next()).value as WalletUpdate).blocks.toBlock, 100)

    chain.through = 101
    hand.send(blockOf(101))
    assert.equal(((await updates.next()).value as WalletUpdate).blocks.toBlock, 101)

    chain.through = 102
    chain.tables = { ...chain.tables, legs: [creditAt(102, "bb", "7")], reference_prices: [{ ...REFERENCE, block_num: "102" }], balances: balancesThrough(120, "7") }
    hand.send(blockOf(102))
    const update = (await updates.next()).value as WalletUpdate
    assert.equal(update.blocks.toBlock, 102)
    assert.deepEqual(legsOf(update), ["102:0xbb:7"])
  })

  it("keeps going after a read fails, and doesn't lose the reorg it was reading", async (t) => {
    const warnings: string[] = []
    const tables: Tables = { legs: [creditAt(100, "aa", "5")], reference_prices: [{ ...REFERENCE, block_num: "100" }], balances: balancesThrough(120, "5") }
    const chain = { block: 100, tables, failing: false }
    const query: Query = async <T,>(sql: string) => {
      if (sql.includes(".legs") && chain.failing) throw new Error("hiccup")
      if (sql.includes(".blocks")) return [{ block_num: String(chain.block), hash: "ab", timestamp: 1_800_000_000_000 }] as T[]
      return fakeAmp(chain.tables, chain.block).query<T>(sql)
    }
    const hand = handStream()
    const client = pricetagClient(query, { dataset: "benface/pricetag@0.0.1", startBlock: 50, stream: hand.stream, logger: { warn: (message) => warnings.push(message) }, follow: { tickMs: 0 } })
    const updates = client.watchWallet(ADDRESS, { signal: t.signal })
    await updates.next()

    chain.failing = true
    chain.tables = { ...tables, legs: [creditAt(100, "cc", "7")], balances: balancesThrough(120, "7") }
    hand.send(blockOf(100, 100, "0xnew"))
    const next = updates.next()
    await until(t, () => warnings.length > 0)
    chain.failing = false
    chain.block = 101
    hand.send(blockOf(101))
    const update = (await next).value as WalletUpdate
    assert.equal(update.reorgFrom, 100)
    assert.deepEqual(legsOf(update), ["100:0xcc:7"])
  })

  it("rejects an address it can't read, and stops when told to", async (t) => {
    const { client } = chainAt(100, { legs: [], reference_prices: [], balances: balancesThrough(120, "0") })
    await assert.rejects(client.watchWallet("nope").next(), /isn't a Base address/)
    const stop = new AbortController()
    const updates: WalletUpdate[] = []
    for await (const update of client.watchWallet(ADDRESS, { signal: AbortSignal.any([stop.signal, t.signal]) })) {
      updates.push(update)
      stop.abort()
    }
    assert.equal(updates.length, 1)
  })
})

describe("wallets.rewind", () => {
  it("waits for a read in progress, so it can't undo the rewind", async () => {
    const tables: Tables = { legs: [creditAt(100, "aa", "5")], reference_prices: [{ ...REFERENCE, block_num: "100" }], balances: balancesThrough(120, "5") }
    const { query } = fakeAmp(tables, 100)
    // Every query that's waiting, because a read can have several going at once.
    const waiting: (() => void)[] = []
    let held = false
    const gated: Query = async <T,>(sql: string, timeoutMs?: number) => {
      if (held) await new Promise<void>((resolve) => waiting.push(resolve))
      return query<T>(sql, timeoutMs)
    }
    const source = datasetSource(gated, { dataset: "benface/pricetag@0.0.1", baseDataset: "b", startBlock: 50, network: "base_mainnet" })
    const wallets = createWallets(source, async () => ({ blockNum: 100, timestamp: new Date(1_800_000_000_000).toISOString() }), async () => new Map(), QUIET)
    held = true
    const reading = wallets.get(ADDRESS, { from: 50 })
    let rewound = false
    const rewinding = wallets.rewind(100, 100).then(() => (rewound = true))
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(rewound, false)
    held = false
    for (const release of waiting) release()
    await reading
    await rewinding
    tables.legs = [creditAt(100, "cc", "7")]
    const after = await wallets.get(ADDRESS, { from: 50 })
    assert.deepEqual(after.legs.filter((l) => !l.opening).map((l) => l.txHash), ["0xcc"])
  })
})

describe("the server's live events while the dataset catches up", FOLLOWING, () => {
  const hand = handStream()
  const state = { through: 100 }
  const tables: Tables = { legs: [], reference_prices: [{ ...REFERENCE, block_num: "100" }], balances: balancesThrough(120, "0") }
  let server: Server
  let base: string

  before(async () => {
    const query: Query = async <T,>(sql: string) => fakeAmp(tables, state.through).query<T>(sql)
    const source = { ...datasetSource(query, { dataset: "benface/pricetag@0.0.1", baseDataset: "b", startBlock: 50, network: "base_mainnet" }), head: async () => ({ blockNum: 105, timestamp: new Date(1_800_000_000_000).toISOString() }) }
    const api = createApi({}, {
      source,
      readRates: async () => ({ byBlock: {}, latest: null }),
      proofs: { datasets: async () => [], priceBehind: async () => null, readBlock: async () => null },
      follow: { stream: hand.stream, sql: "SELECT 1", readMark: async () => MARK, logger: QUIET, tickMs: 0 },
    })
    server = createServer((req, res) => void api(req, res))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(() => {
    server.closeAllConnections()
    server.close()
  })

  it("sends a head for each block it finishes under one chain head, and a read reaches it", async (t) => {
    const toBlock = async () => ((await (await fetch(`${base}/api/wallet/${ADDRESS}`)).json()) as { coverage: { toBlock: number } }).coverage.toBlock
    assert.equal(await toBlock(), 100)

    const events = await fetch(`${base}/api/events`, { signal: t.signal })
    const reader = events.body!.pipeThrough(new TextDecoderStream()).getReader()
    await reader.read()
    await until(t, () => hand.resumes.length > 0)

    for (const through of [101, 102]) {
      state.through = through
      hand.send(blockOf(through))
      assert.match((await reader.read()).value!, /^event: head\ndata: \{"blockNum":105,/)
      assert.equal(await toBlock(), through)
    }
  })
})

describe("the head a wallet read starts from", () => {
  async function serving() {
    const hand = handStream()
    const tables: Tables = { legs: [], reference_prices: [{ ...REFERENCE, block_num: "100" }], balances: balancesThrough(120, "0") }
    const state = { heads: 0, hold: null as Promise<void> | null }
    const query: Query = async <T,>(sql: string) => fakeAmp(tables, 100).query<T>(sql)
    const source = {
      ...datasetSource(query, { dataset: "benface/pricetag@0.0.1", baseDataset: "b", startBlock: 50, network: "base_mainnet" }),
      head: async () => {
        state.heads += 1
        await state.hold
        return { blockNum: 105, timestamp: new Date(1_800_000_000_000).toISOString() }
      },
    }
    const api = createApi({}, {
      source,
      readRates: async () => ({ byBlock: {}, latest: null }),
      proofs: { datasets: async () => [], priceBehind: async () => null, readBlock: async () => null },
      follow: { stream: hand.stream, sql: "SELECT 1", readMark: async () => MARK, logger: QUIET, tickMs: 0 },
    })
    const server = createServer((req, res) => void api(req, res))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const stop = new AbortController()
    return {
      hand,
      state,
      read: () => fetch(`${base}/api/wallet/${ADDRESS}`).then((res) => res.json()),
      async follow() {
        const reader = (await fetch(`${base}/api/events`, { signal: stop.signal })).body!.pipeThrough(new TextDecoderStream()).getReader()
        await reader.read()
        while (hand.resumes.length === 0) await new Promise((resolve) => setTimeout(resolve, 2))
        return reader
      },
      close() {
        stop.abort()
        server.closeAllConnections()
        server.close()
      },
    }
  }

  it("is read each time while nothing's following the chain", async () => {
    const { state, read, close } = await serving()
    await read()
    await read()
    assert.equal(state.heads, 2)
    close()
  })

  it("is the one a tick just read while the chain's followed, until it's seconds old", async (t) => {
    const { hand, state, read, follow, close } = await serving()
    const reader = await follow()
    hand.send(blockOf(101))
    assert.match((await reader.read()).value!, /^event: head/)
    assert.equal(state.heads, 1)
    await read()
    await read()
    assert.equal(state.heads, 1)
    const now = Date.now()
    t.mock.method(Date, "now", () => now + 6000)
    await read()
    assert.equal(state.heads, 2)
    close()
  })

  it("isn't the old one once a reorg was told about", async () => {
    const { hand, state, read, follow, close } = await serving()
    const reader = await follow()
    hand.send(blockOf(101))
    await reader.read()
    assert.equal(state.heads, 1)
    let release = () => {}
    state.hold = new Promise((resolve) => (release = resolve))
    hand.send(blockOf(101, 101, "0xreplaced"))
    while (state.heads === 1) await new Promise((resolve) => setTimeout(resolve, 2))
    assert.equal(state.heads, 2, "the tick is reading the new chain's")
    const reading = read()
    while (state.heads === 2) await new Promise((resolve) => setTimeout(resolve, 2))
    release()
    await reading
    close()
  })
})

describe("exchange rates after a reorg", () => {
  it("reads a settled block's rate again once a reorg replaced it, and only then", async () => {
    const asked: number[][] = []
    const round = (block: number, answer: string) => ({ roundId: "1", answer, updatedAt: block }) as unknown as RateRound
    let answer = "1"
    const readRates = createRates(async (_feed, blocks) => {
      asked.push([...blocks])
      return new Map(blocks.map((block) => [block, round(block, answer)]))
    })
    const wallet = { latest: { blockNum: 200, timestamp: new Date(1_800_000_000_000).toISOString() }, legs: [{ blockNum: 100 }, { blockNum: 150 }] } as Parameters<typeof readRates>[1]
    await readRates("CAD", wallet)
    assert.deepEqual(asked.at(-1), [100, 150, 200])
    await readRates("CAD", wallet)
    assert.equal(asked.length, 1)

    answer = "2"
    readRates.rewind!(120)
    const rates = await readRates("CAD", wallet)
    assert.deepEqual(asked.at(-1), [150, 200])
    assert.equal((rates?.byBlock[150] as unknown as { answer: string }).answer, "2")
    assert.equal((rates?.byBlock[100] as unknown as { answer: string }).answer, "1")
  })
})

function heldPromise() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve: () => resolve() }
}

describe("an exchange rate read that crosses a reorg", () => {
  const WALLET = (blockNum: number) => ({ latest: { blockNum, timestamp: new Date(1_800_000_000_000).toISOString() }, legs: [{ blockNum: 150 }] }) as Parameters<ReturnType<typeof createRates>>[1]

  /** Rates that answer with what `answer` is now, and hold their first read until the test lets it finish. */
  function heldRates() {
    const state = { answer: "1", calls: 0 }
    const started = heldPromise()
    const release = heldPromise()
    const rates = createRates(async (_feed, blocks) => {
      state.calls += 1
      const result = new Map(blocks.map((block) => [block, { answer: state.answer, updatedAt: block } satisfies RateRound]))
      if (state.calls === 1) {
        started.resolve()
        await release.promise
      }
      return result
    })
    return { state, started, release, rates }
  }

  it("doesn't keep a settled block's rate it read from the replaced chain", async () => {
    const { state, started, release, rates } = heldRates()
    const before = rates("CAD", WALLET(200))
    await started.promise
    rates.rewind!(120)
    state.answer = "2"
    release.resolve()
    await before

    const after = await rates("CAD", WALLET(201))
    assert.equal(after?.byBlock[150]?.answer, "2")
    assert.equal(after?.latest?.round.answer, "2")
    assert.equal(state.calls, 2)

    // And what that read gets is kept again, since no reorg crossed it.
    await rates("CAD", WALLET(201))
    assert.equal(state.calls, 2)
  })

  it("doesn't keep the head's rate it read from the replaced chain", async () => {
    const { state, started, release, rates } = heldRates()
    const before = rates("CAD", WALLET(200))
    await started.promise
    rates.rewind!(200)
    state.answer = "2"
    release.resolve()
    await before

    // The same height, so a head's rate that was kept would answer with no read.
    const after = await rates("CAD", WALLET(200))
    assert.equal(after?.latest?.round.answer, "2")
  })

  it("keeps what a read gets when the reorg came before it started", async () => {
    const { state, started, release, rates } = heldRates()
    rates.rewind!(120)
    release.resolve()
    const read = rates("CAD", WALLET(200))
    await started.promise
    await read
    await rates("CAD", WALLET(200))
    assert.equal(state.calls, 1)
  })
})

describe("the server after a reorg the tables haven't rewritten yet", FOLLOWING, () => {
  const hand = handStream()
  const state: { head: number; through: number; tables: Tables } = { head: 150, through: 150, tables: { legs: [creditAt(100, "aa", "5")], reference_prices: [{ ...REFERENCE, block_num: "100" }], balances: balancesThrough(200, "5") } }
  let server: Server
  let base: string

  before(async () => {
    const query: Query = async <T,>(sql: string) => fakeAmp(state.tables, state.through).query<T>(sql)
    const source = { ...datasetSource(query, { dataset: "benface/pricetag@0.0.1", baseDataset: "b", startBlock: 50, network: "base_mainnet" }), head: async () => ({ blockNum: state.head, timestamp: new Date(1_800_000_000_000).toISOString() }) }
    const readMark = async () => ({ blockNum: state.head, hash: `0x${state.head}` })
    const api = createApi({}, {
      source,
      readRates: async () => ({ byBlock: {}, latest: null }),
      proofs: { datasets: async () => [], priceBehind: async () => null, readBlock: async () => null },
      follow: { stream: hand.stream, sql: "SELECT 1", readMark, logger: QUIET, pollMs: 1, retryMs: 60_000, tickMs: 0 },
    })
    server = createServer((req, res) => void api(req, res))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(() => {
    server.closeAllConnections()
    server.close()
  })

  it("replaces the blocks once they do", async (t) => {
    const hashes = async () => ((await (await fetch(`${base}/api/wallet/${ADDRESS}`)).json()) as { legs: { txHash: string; opening?: boolean }[] }).legs.filter((l) => !l.opening).map((l) => l.txHash)
    assert.deepEqual(await hashes(), ["0xaa"])

    const events = await fetch(`${base}/api/events`, { signal: t.signal })
    const reader = events.body!.pipeThrough(new TextDecoderStream()).getReader()
    await reader.read()
    await until(t, () => hand.resumes.length > 0)

    state.head = 151
    hand.send(dataOf(151, 100, "0xnew"), new Error("gone before the block was complete"))
    assert.match((await reader.read()).value!, /"via":"polling"/)
    assert.deepEqual(await hashes(), ["0xaa"])

    state.tables = { legs: [creditAt(120, "bb", "7")], reference_prices: [{ ...REFERENCE, block_num: "120" }], balances: balancesThrough(200, "7") }
    state.head = state.through = 152
    await reader.read()
    assert.deepEqual(await hashes(), ["0xbb"])
  })
})

describe("the server's live events", FOLLOWING, () => {
  let server: Server
  let base: string
  const hand = handStream()
  const tables: Tables = { legs: [creditAt(100, "aa", "5")], reference_prices: [{ ...REFERENCE, block_num: "100" }], balances: balancesThrough(120, "5") }
  const { query } = fakeAmp(tables, 100)

  before(async () => {
    const source = datasetSource(query, { dataset: "benface/pricetag@0.0.1", baseDataset: "b", startBlock: 50, network: "base_mainnet" })
    const headAt100 = { ...source, head: async () => ({ blockNum: 100, timestamp: new Date(1_800_000_000_000).toISOString() }) }
    const api = createApi({}, {
      source: headAt100,
      readRates: async () => ({ byBlock: {}, latest: null }),
      proofs: { datasets: async () => [], priceBehind: async () => null, readBlock: async () => null },
      follow: { stream: hand.stream, sql: "SELECT 1", readMark: async () => MARK, logger: QUIET, tickMs: 0 },
    })
    server = createServer((req, res) => void api(req, res))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(() => {
    server.closeAllConnections()
    server.close()
  })

  it("sends a head when a block is replaced at the same height, and the next read has the new rows", async (t) => {
    const legs = async () => ((await (await fetch(`${base}/api/wallet/${ADDRESS}`)).json()) as { legs: { txHash: string; opening?: boolean }[] }).legs.filter((l) => !l.opening).map((l) => l.txHash)
    assert.deepEqual(await legs(), ["0xaa"])

    const events = await fetch(`${base}/api/events`, { signal: t.signal })
    const reader = events.body!.pipeThrough(new TextDecoderStream()).getReader()
    assert.match((await reader.read()).value!, /connected/)
    await until(t, () => hand.resumes.length > 0)

    tables.legs = [creditAt(100, "cc", "7")]
    hand.send(blockOf(100, 100, "0xnew"))
    const { value } = await reader.read()
    assert.match(value!, /^event: head\ndata: \{"blockNum":100,.*"via":"stream"\}/)
    assert.deepEqual(await legs(), ["0xcc"])
  })
})
