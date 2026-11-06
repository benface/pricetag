import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createTurns } from "@pricetag/sdk/internal"

/** Reads that stay open until a test finishes them, in a lane it picks, and what order they started in. */
function reading(lanesAtOnce?: number, noLaneAtOnce?: number) {
  let lane: string | undefined
  const inTurn = createTurns(lanesAtOnce, () => lane, noLaneAtOnce)
  const started: string[] = []
  const finishers = new Map<string, () => void>()
  const read = (name: string, inLane?: string) => {
    lane = inLane
    return inTurn(
      () =>
        new Promise<string>((resolve) => {
          started.push(name)
          finishers.set(name, () => resolve(name))
        }),
    )
  }
  const finish = async (name: string) => {
    finishers.get(name)!()
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return { read, finish, started }
}

describe("taking turns", () => {
  it("is one at a time, in order, with no lanes, which is a local server", async () => {
    const { read, finish, started } = reading()
    void read("a")
    void read("b")
    void read("c")
    assert.deepEqual(started, ["a"])
    await finish("a")
    assert.deepEqual(started, ["a", "b"])
    await finish("b")
    assert.deepEqual(started, ["a", "b", "c"])
  })

  it("holds up only the lane that's slow", async () => {
    const { read, finish, started } = reading(2)
    void read("busy 1", "busy")
    void read("busy 2", "busy")
    void read("ana 1", "ana")
    void read("ana 2", "ana")
    assert.deepEqual(started, ["busy 1", "ana 1"])
    await finish("ana 1")
    assert.deepEqual(started, ["busy 1", "ana 1", "ana 2"], "The busy wallet's second read waits for its first, and nobody else does")
  })

  it("never runs more lanes than it's allowed, and the one that's waited goes next", async () => {
    const { read, finish, started } = reading(1)
    void read("a 1", "a")
    void read("a 2", "a")
    void read("b 1", "b")
    void read("c 1", "c")
    assert.deepEqual(started, ["a 1"])
    await finish("a 1")
    assert.deepEqual(started, ["a 1", "b 1"], "Not a's second")
    await finish("b 1")
    assert.deepEqual(started, ["a 1", "b 1", "c 1"])
    await finish("c 1")
    assert.deepEqual(started, ["a 1", "b 1", "c 1", "a 2"])
  })

  it("doesn't make what's for everyone wait for anyone, and runs it one at a time too", async () => {
    const { read, finish, started } = reading(1)
    void read("a", "a")
    void read("b", "b")
    void read("head 1")
    void read("head 2")
    assert.deepEqual(started, ["a", "head 1"])
    await finish("head 1")
    assert.deepEqual(started, ["a", "head 1", "head 2"])
    assert.ok(!started.includes("b"))
  })

  it("runs a few at once with no lanes when it's told to, and the rest in order", async () => {
    const { read, finish, started } = reading(1, 2)
    void read("a")
    void read("b")
    void read("c")
    void read("d")
    assert.deepEqual(started, ["a", "b"])
    await finish("b")
    assert.deepEqual(started, ["a", "b", "c"])
    await finish("a")
    assert.deepEqual(started, ["a", "b", "c", "d"])
  })

  it("keeps each lane to one at a time, however many having no lane can run", async () => {
    const { read, finish, started } = reading(1, 2)
    void read("mine 1", "me")
    void read("mine 2", "me")
    void read("theirs", "them")
    void read("head 1")
    void read("head 2")
    assert.deepEqual(started, ["mine 1", "head 1", "head 2"])
    await finish("mine 1")
    assert.deepEqual(started, ["mine 1", "head 1", "head 2", "theirs"])
  })

  it("keeps going after a read fails, and passes on the failure", async () => {
    const inTurn = createTurns()
    await assert.rejects(
      inTurn(async () => {
        throw new Error("Amp's down")
      }),
      /Amp's down/,
    )
    assert.equal(await inTurn(async () => "next"), "next")
  })
})
