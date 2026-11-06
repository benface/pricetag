import assert from "node:assert/strict"
import { describe, it, type TestContext } from "node:test"
import { createL1FeeReader, l1FeeOf, l1FeePace, relayRate } from "@pricetag/sdk/internal"

const HASH = (n: number) => `0x${n.toString(16).padStart(64, "0")}`
const request = (n: number) => ({ txHash: HASH(n), blockNum: 100 })
const silence = (run: () => Promise<void>) => async () => {
  const original = console.warn
  console.warn = () => {}
  try {
    await run()
  } finally {
    console.warn = original
  }
}

function answering(...responses: ((body: { id: number; params: [string] }[]) => Response)[]) {
  const calls: { id: number; params: [string] }[][] = []
  const send = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as { id: number; params: [string] }[]
    calls.push(body)
    // The last answer repeats.
    return (responses.length > 1 ? responses.shift()! : responses[0]!)(body)
  }) as typeof fetch
  return { send, calls }
}

const allFound = (body: { id: number }[]) => Response.json(body.map(({ id }) => ({ id, result: { blockNumber: "0x64", l1Fee: "0x10" } })))

/** Wallets of these sizes read at once on a fake clock from 0, with `onTick` called for each millisecond. Says when each batch was sent, and how big it was. */
async function readOnFakeClock(t: TestContext, limit: number, wallets: readonly number[], onTick: (now: number) => void = () => {}, respond: (now: number, calls: number) => Response | null = () => null) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 })
  const batches: { at: number; size: number }[] = []
  const { send } = answering((body) => {
    const refused = respond(Date.now(), body.length)
    if (refused) return refused
    batches.push({ at: Date.now(), size: body.length })
    return allFound(body)
  })
  const read = createL1FeeReader("http://rpc", send, 1_000, console, limit)
  let done = false
  const reads = Promise.all(wallets.map((size, wallet) => read(Array.from({ length: size }, (_, i) => request(wallet * 1_000 + i))))).finally(() => {
    done = true
  })
  for (let now = 0; !done; now++) {
    onTick(now)
    await new Promise((resolve) => setImmediate(resolve))
    if (!done) t.mock.timers.tick(1)
  }
  return { batches, fees: await reads }
}

/** The most calls in any second, the way an RPC counts them. */
const busiestSecond = (batches: readonly { at: number; size: number }[], windowMs = 1_000) =>
  Math.max(...batches.map(({ at }) => batches.filter((other) => other.at > at - windowMs && other.at <= at).reduce((sum, { size }) => sum + size, 0)))

describe("an L1 fee", () => {
  it("is read from the real receipt's hex", () => {
    // 0x98706a6c…, block 53510500.
    assert.equal(l1FeeOf({ blockNumber: "0x3308164", l1Fee: "0x579ffa450" }, 53510500), "23521633360")
  })

  it("isn't known from a receipt in another block, or no receipt", () => {
    assert.equal(l1FeeOf({ blockNumber: "0x65", l1Fee: "0x1" }, 100), null)
    assert.equal(l1FeeOf(null, 100), null)
    assert.equal(l1FeeOf(undefined, 100), null)
  })

  it("is zero when a receipt doesn't have one", () => {
    assert.equal(l1FeeOf({ blockNumber: "0x64" }, 100), "0")
  })
})

describe("the receipt reader", () => {
  it("reads transactions in small batches", async () => {
    const { send, calls } = answering(allFound)
    const fees = await createL1FeeReader("http://rpc", send)([1, 2, 3, 4, 5, 6].map(request))
    assert.deepEqual(calls.map((c) => c.length), [5, 1])
    assert.equal(fees.size, 6)
    assert.equal(fees.get(HASH(1)), "16")
  })

  it("stays at 5 receipts every 550 ms, at most 180 in a read, for the public RPC", () => {
    const pace = { batch: 5, pauseMs: 550, maxPerRead: 180 }
    assert.deepEqual(l1FeePace(), pace)
    assert.deepEqual(l1FeePace(25), pace)
    assert.deepEqual(l1FeePace(0), pace)
    assert.deepEqual(l1FeePace(-1), pace)
    assert.deepEqual(l1FeePace(Number.NaN), pace)
  })

  it("reads at 40% of a faster RPC's limit, in batches that any RPC takes", () => {
    assert.deepEqual(l1FeePace(100), { batch: 20, pauseMs: 550, maxPerRead: 720 })
    assert.deepEqual(l1FeePace(1_000), { batch: 25, pauseMs: 68.75, maxPerRead: 7_250 })
  })

  it("reads at 40% of a slower RPC's limit, one receipt at a time if it has to", () => {
    assert.deepEqual(l1FeePace(5), { batch: 1, pauseMs: 550, maxPerRead: 36 })
    assert.deepEqual(l1FeePace(2), { batch: 1, pauseMs: 1_375, maxPerRead: 14 })
  })

  it("never fits more than its share in a second, whatever the limit", () => {
    for (const limit of [5, 25, 50, 100, 113, 150, 333, 1_000, 10_000]) {
      const { batch, pauseMs } = l1FeePace(limit)
      assert.ok(Math.ceil(1_000 / pauseMs) * batch <= limit * 0.4, `at ${limit}`)
    }
  })

  it("leaves the relay the rest of the limit", () => {
    assert.equal(relayRate(25), 15)
    assert.equal(relayRate(100), 60)
  })

  it("keeps wallets read at the same time to one pace", async () => {
    const sentAt: number[] = []
    const { send } = answering((body) => {
      sentAt.push(Date.now())
      return allFound(body)
    })
    const read = createL1FeeReader("http://rpc", send, 0, console, 100)
    const all = await Promise.all([1, 2, 3].map((wallet) => read(Array.from({ length: 20 }, (_, i) => request(wallet * 100 + i)))))
    assert.deepEqual(all.map((fees) => fees.size), [20, 20, 20])
    // 20 receipts every 550 ms, where each reading alone would have sent all three at once.
    assert.ok(sentAt[2]! - sentAt[0]! >= 950, `took ${sentAt[2]! - sentAt[0]!} ms`)
  })

  it("keeps batches of different sizes to its share of any second", async (t) => {
    const { batches, fees } = await readOnFakeClock(t, 100, [19, 20, 20])
    // Charging a batch to the one after it sent these at 0, 475 and 975 ms: 59 calls in a second, of a share of 40.
    assert.deepEqual(batches.map(({ at }) => at), [0, 550, 1_100])
    assert.deepEqual(fees.map((read) => read.size), [19, 20, 20])
    assert.ok(busiestSecond(batches) <= 40)
    // Still true with calls reaching the RPC up to 100 ms off their schedule.
    assert.ok(busiestSecond(batches, 1_100) <= 40)
  })

  it("stays within its share whatever the mix of sizes, and at any limit", async (t) => {
    const mixes = [[7, 7, 7, 7, 7, 7, 7], [1, 20, 1, 20, 1, 20], [20, 1, 1, 1, 20, 19, 2], [3, 11, 19, 5, 13, 17, 2, 20], [21, 19, 45, 1, 8]]
    for (const limit of [25, 50, 100, 113, 1_000]) {
      for (const wallets of mixes) {
        const { batches, fees } = await readOnFakeClock(t, limit, wallets)
        assert.deepEqual(fees.map((read) => read.size), wallets, `${wallets} at ${limit}`)
        assert.ok(busiestSecond(batches) <= limit * 0.4, `${busiestSecond(batches)} in a second, for ${wallets} at ${limit}`)
        t.mock.timers.reset()
      }
    }
  })

  it("never gets refused alongside a relay using the rest of the limit", async (t) => {
    const limit = 100
    let relayed = 0
    const calls: { at: number; size: number }[] = []
    let refused = 0
    const inLastSecond = (now: number) => calls.filter(({ at }) => at > now - 1_000).reduce((sum, { size }) => sum + size, 0)
    const { batches } = await readOnFakeClock(
      t,
      limit,
      [19, 20, 20, 7, 20, 13, 1, 20],
      (now) => {
        // The relay holds requests to a steady rate, so it sends one per gap for as long as this runs.
        for (; relayed <= Math.floor((now * relayRate(limit)) / 1_000); relayed++) {
          if (inLastSecond(now) + 1 > limit) refused++
          else calls.push({ at: now, size: 1 })
        }
      },
      (now, size) => {
        if (inLastSecond(now) + size > limit) {
          refused++
          return new Response("", { status: 429 })
        }
        calls.push({ at: now, size })
        return null
      },
    )
    assert.equal(refused, 0)
    assert.ok(busiestSecond(batches) <= 40)
    assert.ok(busiestSecond(calls) <= limit)
  })

  it("doesn't charge a small read a whole pause", async () => {
    const { send, calls } = answering(allFound)
    const read = createL1FeeReader("http://rpc", send)
    const started = Date.now()
    for (let i = 0; i < 5; i++) await read([request(i + 1)])
    assert.equal(calls.length, 5)
    assert.ok(Date.now() - started < 450, `took ${Date.now() - started} ms`)
  })

  it("gives up on what doesn't fit in its time, so a shared pace can't hold a read up", async (t) => {
    const { batches, fees } = await readOnFakeClock(t, 25, [180, 180])
    // Each alone would finish, but the two together have one read's time.
    assert.deepEqual(fees.map((read) => read.size), [95, 90])
    assert.ok(batches.at(-1)!.at <= 20_000, `last sent at ${batches.at(-1)!.at} ms`)
  })

  it("reads more in one go with a faster RPC", async () => {
    const { send, calls } = answering(allFound)
    const fees = await createL1FeeReader("http://rpc", send, 0, console, 10_000)(Array.from({ length: 60 }, (_, i) => request(i + 1)))
    assert.deepEqual(calls.map((c) => c.length), [25, 25, 10])
    assert.equal(fees.size, 60)
  })

  it("leaves out what the RPC doesn't have yet, so it's read again", async () => {
    const { send } = answering((body) => Response.json(body.map(({ id }) => (id === 0 ? { id, result: null } : { id, error: { code: -32005 } }))))
    assert.equal((await createL1FeeReader("http://rpc", send)([request(1), request(2)])).size, 0)
  })

  it("waits out a 429", async () => {
    const { send, calls } = answering(() => new Response("", { status: 429 }), allFound)
    const fees = await createL1FeeReader("http://rpc", send, 0)([request(1)])
    assert.equal(calls.length, 2)
    assert.equal(fees.size, 1)
  })

  it("keeps what it read before a failure, and stops", silence(async () => {
    const { send, calls } = answering(allFound, () => new Response("", { status: 500 }))
    const fees = await createL1FeeReader("http://rpc", send, 0)([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(request))
    assert.equal(fees.size, 5)
    assert.equal(calls.length, 2)
  }))

  it("a network failure or odd body isn't fatal, and the URL isn't logged, since it can hold a key", async () => {
    const logged: unknown[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => logged.push(...args)
    try {
      const failing = (async () => {
        throw new TypeError("fetch failed")
      }) as typeof fetch
      assert.equal((await createL1FeeReader("http://secret-key.example", failing)([request(1)])).size, 0)
      const odd = answering(() => Response.json({ error: "nope" }))
      assert.equal((await createL1FeeReader("http://secret-key.example", odd.send)([request(1)])).size, 0)
    } finally {
      console.warn = original
    }
    assert.ok(logged.length > 0)
    assert.ok(!logged.join(" ").includes("secret-key"))
  })

  it("logs what the RPC answered, but never what a failed read's error says, which can quote the URL and the key in it", async () => {
    const fake = "fake-password-for-this-test"
    const rpc = `https://user:${fake}@rpc.example/${fake}`
    const quoting = (async () => {
      throw new Error(`couldn't reach ${rpc}`)
    }) as typeof fetch
    const logged: string[] = []
    const logger = { warn: (message: string) => void logged.push(message) }
    // Node's own fetch refuses a URL with credentials in it, and quotes it in saying so.
    assert.equal((await createL1FeeReader(rpc, fetch, 0, logger)([request(1)])).size, 0)
    assert.equal((await createL1FeeReader(rpc, quoting, 0, logger)([request(1)])).size, 0)
    assert.equal(logged.length, 2)
    assert.ok(!logged.join(" ").includes(fake))

    logged.length = 0
    await createL1FeeReader(rpc, answering(() => new Response("", { status: 500 })).send, 0, logger)([request(1)])
    assert.match(logged.join(" "), /status 500/)
  })
})
