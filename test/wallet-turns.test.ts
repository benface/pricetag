import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"
import { walletTurns } from "../server/shared.ts"

const ME = "0x00000000000000000000000000000000000000aa"
const OTHER = "0x00000000000000000000000000000000000000bb"

setFlagsFromString("--expose-gc")
const collectGarbage = runInNewContext("gc") as () => void

const nextTask = () => new Promise<void>((resolve) => setImmediate(resolve))

/** A read that stays open until a test finishes it. */
function open<T>() {
  let finish!: (value: T) => void
  let fail!: (error: Error) => void
  const result = new Promise<T>((resolve, reject) => {
    finish = resolve
    fail = reject
  })
  return { read: () => result, finish, fail }
}

describe("a wallet's turns", () => {
  it("doesn't hold on to what a finished read returned", async () => {
    const inTurn = walletTurns()
    const returned = await (async () => new WeakRef(await inTurn(ME, async () => ({ rows: ["a row"] }))))()
    // A WeakRef keeps its object until the task that made it ends.
    await nextTask()
    collectGarbage()
    assert.equal(returned.deref(), undefined)
  })

  it("doesn't hold on to what a failed read threw", async () => {
    const inTurn = walletTurns()
    const thrown = await (async () => {
      const error = new Error("failed")
      await assert.rejects(inTurn(ME, () => Promise.reject(error)))
      return new WeakRef(error)
    })()
    await nextTask()
    collectGarbage()
    assert.equal(thrown.deref(), undefined)
  })

  it("gives each caller its own read's result, one at a time", async () => {
    const inTurn = walletTurns()
    const first = open<string>()
    const started: string[] = []
    const a = inTurn(ME, () => (started.push("a"), first.read()))
    const b = inTurn(ME, async () => (started.push("b"), "b"))
    await nextTask()
    assert.deepEqual(started, ["a"])
    first.finish("a")
    assert.equal(await a, "a")
    assert.equal(await b, "b")
    assert.deepEqual(started, ["a", "b"])
  })

  it("goes on to the next read after a failure, which only reaches whoever asked", async () => {
    const inTurn = walletTurns()
    const first = open<string>()
    const started: string[] = []
    const a = inTurn(ME, () => (started.push("a"), first.read()))
    const b = inTurn(ME, async () => (started.push("b"), "b"))
    await nextTask()
    assert.deepEqual(started, ["a"])
    first.fail(new Error("a failed"))
    await assert.rejects(a, /a failed/)
    assert.equal(await b, "b")
    assert.deepEqual(started, ["a", "b"])
  })

  it("doesn't make one wallet wait for another", async () => {
    const inTurn = walletTurns()
    const mine = open<string>()
    const a = inTurn(ME, mine.read)
    assert.equal(await inTurn(OTHER, async () => "other"), "other")
    mine.finish("mine")
    assert.equal(await a, "mine")
  })
})
