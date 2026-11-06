import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createL1FeeReader, l1FeeOf, l1FeePace } from "@pricetag/sdk/internal"

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

  it("stays at 5 receipts every 500 ms, at most 200 in a read, for the public RPC", () => {
    const pace = { batch: 5, pauseMs: 500, maxPerRead: 200 }
    assert.deepEqual(l1FeePace(), pace)
    assert.deepEqual(l1FeePace(20), pace)
    assert.deepEqual(l1FeePace(0), pace)
    assert.deepEqual(l1FeePace(-1), pace)
    assert.deepEqual(l1FeePace(Number.NaN), pace)
  })

  it("reads at half of a faster RPC's limit, in batches that any RPC takes", () => {
    assert.deepEqual(l1FeePace(100), { batch: 25, pauseMs: 500, maxPerRead: 1_000 })
    assert.deepEqual(l1FeePace(1_000), { batch: 25, pauseMs: 50, maxPerRead: 10_000 })
  })

  it("reads at half of a slower RPC's limit, one receipt at a time if it has to", () => {
    assert.deepEqual(l1FeePace(2), { batch: 1, pauseMs: 1_000, maxPerRead: 20 })
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
