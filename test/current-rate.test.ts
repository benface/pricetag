import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it, mock } from "node:test"
import { setImmediate as settled } from "node:timers/promises"
import { followCurrentRate, readCurrentRate } from "../src/core/current-rate.ts"

const MINUTE = 60 * 1000

describe("an open form's current rate", () => {
  /** What the server will say next: a rate, no rate, or that it can't say. */
  let answer: string | null | Error
  let reads: number
  let seen: (string | null)[]
  let stop: () => void

  const start = async () => {
    stop = followCurrentRate(
      async () => {
        reads += 1
        if (answer instanceof Error) throw answer
        return answer
      },
      (rate) => seen.push(rate),
    )
    await settled()
  }
  const pass = async (ms: number) => {
    mock.timers.tick(ms)
    await settled()
  }

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] })
    answer = "1400000"
    reads = 0
    seen = []
  })
  afterEach(() => {
    stop()
    mock.timers.reset()
  })

  it("follows a rate that changes while it's open", async () => {
    await start()
    assert.deepEqual(seen, ["1400000"])
    answer = "1500000"
    await pass(4 * MINUTE)
    assert.deepEqual(seen, ["1400000"])
    await pass(MINUTE)
    assert.deepEqual(seen, ["1400000", "1500000"])
  })

  it("recovers from a first read that failed", async () => {
    answer = new Error("down")
    await start()
    assert.deepEqual(seen, [], "there was no rate, and there still isn't")
    answer = "1400000"
    await pass(30 * 1000)
    assert.deepEqual(seen, ["1400000"])
  })

  it("keeps a rate through failed reads only for an hour, then goes back to none, and recovers", async () => {
    await start()
    answer = new Error("down")
    await pass(5 * MINUTE)
    assert.deepEqual(seen, ["1400000"], "one failed read doesn't take the rate away")
    for (let elapsed = 5 * MINUTE; elapsed <= 59 * MINUTE; elapsed += 30 * 1000) await pass(30 * 1000)
    assert.deepEqual(seen, ["1400000"])
    for (let i = 0; i < 4; i += 1) await pass(30 * 1000)
    assert.deepEqual(seen, ["1400000", null])
    answer = "1500000"
    await pass(30 * 1000)
    assert.deepEqual(seen, ["1400000", null, "1500000"])
  })

  it("drops the rate straight away when the server says there's none", async () => {
    await start()
    answer = null
    await pass(5 * MINUTE)
    assert.deepEqual(seen, ["1400000", null])
  })

  it("stops reading and saying anything once it's stopped", async () => {
    await start()
    stop()
    const before = reads
    answer = "1500000"
    await pass(60 * MINUTE)
    assert.equal(reads, before)
    assert.deepEqual(seen, ["1400000"])
  })

  it("says nothing about a read that finishes after it's stopped", async () => {
    let finish: (rate: string) => void = () => {}
    const quiet = followCurrentRate(() => new Promise((resolve) => (finish = resolve)), (rate) => seen.push(rate))
    quiet()
    finish("1400000")
    await settled()
    assert.deepEqual(seen, [])
    stop = () => {}
  })
})

describe("reading the current rate", () => {
  const signal = new AbortController().signal
  const answering = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch

  it("asks for that currency, and reads a rate or an answer of none", async () => {
    let asked = ""
    const send = (async (url: string) => {
      asked = url
      return new Response(JSON.stringify({ rateMicros: "1400000" }))
    }) as unknown as typeof fetch
    assert.equal(await readCurrentRate("CAD", signal, send), "1400000")
    assert.equal(asked, "/api/rate?currency=CAD")
    assert.equal(await readCurrentRate("CAD", signal, answering(200, { rateMicros: null })), null)
  })

  it("counts anything else as a failed read, which isn't the same as no rate", async () => {
    await assert.rejects(readCurrentRate("CAD", signal, answering(503, { error: "down" })))
    await assert.rejects(readCurrentRate("CAD", signal, answering(200, {})))
    await assert.rejects(readCurrentRate("CAD", signal, answering(200, { rateMicros: "0" })))
    await assert.rejects(readCurrentRate("CAD", signal, answering(200, { rateMicros: 1400000 })))
  })
})
