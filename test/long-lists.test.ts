import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, it } from "node:test"
import { createApi } from "../server/app.ts"
import { createHandler } from "../server/http.ts"
import { withoutWhatItHas } from "../server/long-lists.ts"

const reply = (points: number, outgoingTxs = 0, change?: (list: { n: number; pnl: string }[]) => void) => {
  const list = Array.from({ length: points }, (_, n) => ({ n, pnl: String(n * 3) }))
  change?.(list)
  return { address: "0xa", points: list, outgoingTxs: Array.from({ length: outgoingTxs }, (_, n) => `0x${n}`) }
}

type Trimmed = ReturnType<typeof reply> & { marks?: { points?: string; outgoingTxs?: string }; kept?: { points?: number; outgoingTxs?: number } }
const send = (full: ReturnType<typeof reply>, since: unknown) => withoutWhatItHas(full, since) as Trimmed

/** What a client ends up with, from what it had and what it was sent. */
function restored(had: Trimmed, next: Trimmed) {
  return {
    points: [...had.points.slice(0, next.kept?.points ?? 0), ...next.points],
    outgoingTxs: [...had.outgoingTxs.slice(0, next.kept?.outgoingTxs ?? 0), ...next.outgoingTxs],
  }
}

describe("a reply without what the client has", () => {
  it("adds up to the whole reply, once more has happened", () => {
    const first = send(reply(5000, 3000), {})
    assert.equal(first.kept, undefined, "Nothing's left out of the first one")
    assert.equal(first.points.length, 5000)
    const whole = reply(5040, 3010)
    const next = send(whole, first.marks)
    assert.deepEqual(next.kept, { points: 4800, outgoingTxs: 2800 })
    assert.equal(next.points.length, 240)
    assert.equal(next.outgoingTxs.length, 210)
    assert.deepEqual(restored(first, next), { points: whole.points, outgoingTxs: whole.outgoingTxs })
  })

  it("can go on like that", () => {
    let had = send(reply(5000, 3000), {})
    for (const [points, txs] of [[5001, 3000], [5001, 3000], [5300, 3100]] as const) {
      const whole = reply(points, txs)
      const next = send(whole, had.marks)
      const { points: p, outgoingTxs: o } = restored(had, next)
      assert.deepEqual(p, whole.points)
      assert.deepEqual(o, whole.outgoingTxs)
      had = { ...next, points: p, outgoingTxs: o }
    }
  })

  it("sends the whole list when anything before the mark changed, however early", () => {
    const first = send(reply(5000), {})
    for (const at of [0, 2500, 4799]) {
      const whole = reply(5010, 0, (list) => {
        list[at]!.pnl = "changed"
      })
      const next = send(whole, first.marks)
      assert.equal(next.kept, undefined)
      assert.deepEqual(next.points, whole.points)
    }
  })

  it("still leaves out what it can when only what's recent changed", () => {
    const first = send(reply(5000), {})
    const whole = reply(5010, 0, (list) => {
      list[4800]!.pnl = "changed"
    })
    const next = send(whole, first.marks)
    assert.equal(next.kept?.points, 4800)
    assert.deepEqual(restored(first, next).points, whole.points)
  })

  it("sends the whole list when the chain rewound past the mark", () => {
    const first = send(reply(5000), {})
    const next = send(reply(1500), first.marks)
    assert.equal(next.kept, undefined)
    assert.equal(next.points.length, 1500)
  })

  it("decides each list by itself", () => {
    const first = send(reply(5000, 3000), {})
    const whole = reply(5000, 3000, (list) => {
      list[1]!.pnl = "changed"
    })
    const next = send(whole, first.marks)
    assert.deepEqual(next.kept, { outgoingTxs: 2800 })
    assert.equal(next.points.length, 5000)
  })

  for (const mark of ["nonsense", "", "4800:abc", `0:${"0".repeat(64)}`, `4800:${"0".repeat(64)}`, `99999:${"0".repeat(64)}`, 4800, null, ["4800"], `4800:${"A".repeat(64)}`]) {
    it(`ignores a mark of ${JSON.stringify(mark)}`, () => {
      const whole = reply(5000)
      const next = send(whole, { points: mark })
      assert.equal(next.kept, undefined)
      assert.deepEqual(next.points, whole.points)
    })
  }

  it("leaves a reply alone unless it's asked", () => {
    const whole = reply(5000, 3000)
    for (const since of [undefined, null, "marks", 3]) assert.equal(withoutWhatItHas(whole, since), whole)
  })

  it("leaves a short wallet's reply exactly as it was", () => {
    const whole = reply(999, 999)
    assert.equal(withoutWhatItHas(whole, {}), whole)
    assert.equal(withoutWhatItHas(whole, { points: `500:${"0".repeat(64)}` }), whole)
  })

  it("marks a list as soon as it's long, leaving a shorter one out of it", () => {
    const next = send(reply(1000, 10), {})
    assert.equal(next.marks?.points?.startsWith("800:"), true)
    assert.equal(next.marks?.outgoingTxs, undefined)
  })
})

describe("the portfolio route", () => {
  it("sends the demo the same reply whether or not it asks", async () => {
    const server = createServer(createHandler(createApi({}), "/nonexistent"))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const read = async (body: object) => {
        const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/portfolio/demo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "average", currency: "USD", ...body }) })
        assert.equal(response.status, 200)
        return JSON.parse(await response.text()) as object
      }
      const [plain, asked] = [await read({}), await read({ since: {} })]
      assert.deepEqual(asked, plain)
      assert.equal("marks" in asked, false)
    } finally {
      server.close()
    }
  })
})
