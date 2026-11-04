import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createL1FeeReader, l1FeeOf } from "../server/receipts.ts"

const HASH = (n: number) => `0x${n.toString(16).padStart(64, "0")}`
const request = (n: number) => ({ txHash: HASH(n), blockNum: 100 })
const silence = (run: () => Promise<void>) => async () => {
  const original = console.error
  console.error = () => {}
  try {
    await run()
  } finally {
    console.error = original
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
    const original = console.error
    console.error = (...args: unknown[]) => logged.push(...args)
    try {
      const failing = (async () => {
        throw new TypeError("fetch failed")
      }) as typeof fetch
      assert.equal((await createL1FeeReader("http://secret-key.example", failing)([request(1)])).size, 0)
      const odd = answering(() => Response.json({ error: "nope" }))
      assert.equal((await createL1FeeReader("http://secret-key.example", odd.send)([request(1)])).size, 0)
    } finally {
      console.error = original
    }
    assert.ok(logged.length > 0)
    assert.ok(!logged.join(" ").includes("secret-key"))
  })

})
