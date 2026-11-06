import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it, mock } from "node:test"
import { ReadError, readResponse, type ReadFailure } from "../src/core/read-failure.ts"
import { feedProblem, panelProblem } from "../src/core/wording.ts"
import { followRead, liveError, type LiveState } from "../src/ui/useWallet.ts"

const INVITE = "This server needs an invite."
const refused = (): ReadError => new ReadError({ kind: "refused", said: INVITE })
const REFUSED: ReadFailure = { kind: "refused", said: INVITE }
const UNREACHABLE: ReadFailure = { kind: "unreachable" }

/** The update stream, moved by hand so each test picks the order things finish in. */
class FakeEvents {
  static readonly CLOSED = 2
  static opened: FakeEvents[] = []
  readyState = 1
  closed = false
  private listeners = new Map<string, () => void>()
  constructor() {
    FakeEvents.opened.push(this)
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener)
  }
  close() {
    this.closed = true
  }
  fire(type: "open" | "head" | "down") {
    this.listeners.get(type)?.()
  }
  /** A dropped connection, which the browser retries by itself. */
  drop() {
    this.listeners.get("error")?.()
  }
  /** An error response like a 401, which it doesn't. */
  refuse() {
    this.readyState = FakeEvents.CLOSED
    this.listeners.get("error")?.()
  }
}

/** Reads that stay open until a test finishes them. */
function follow(live = true) {
  const reads: { resolve: (value: string) => void; reject: (error: unknown) => void }[] = []
  let state: LiveState<string> = { value: null, loading: true, readFailure: null, updateFailure: null }
  const stop = followRead<string>(() => new Promise((resolve, reject) => reads.push({ resolve, reject })), { live }, (change) => (state = change(state)))
  // Lets a finished read's `then` and `finally` run, including a read they start.
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve))
  return {
    reads,
    stop,
    events: () => FakeEvents.opened.at(-1) as FakeEvents,
    error: () => liveError(state),
    state: () => state,
    finish: async (value: string) => {
      ;(reads.at(-1) as (typeof reads)[number]).resolve(value)
      await settle()
    },
    fail: async (error: unknown) => {
      ;(reads.at(-1) as (typeof reads)[number]).reject(error)
      await settle()
    },
  }
}

describe("a server that says to slow down", () => {
  const slowedDown = (retryAfter: number) => new ReadError({ kind: "slowedDown", said: "Too many requests from this invite.", retryAfter })

  it("says so, skips new blocks while it waits, and reads again by itself when it's time", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
    FakeEvents.opened = []
    ;(globalThis as { EventSource?: unknown }).EventSource = FakeEvents
    const run = follow()
    try {
      await run.fail(slowedDown(60))
      assert.equal(run.error()?.kind, "slowedDown")
      run.events().fire("head")
      assert.equal(run.reads.length, 1, "A new block doesn't ask again")
      t.mock.timers.tick(59_000)
      run.events().fire("head")
      assert.equal(run.reads.length, 1)
      t.mock.timers.tick(1000)
      assert.equal(run.reads.length, 2, "Its minute's up")
      await run.finish("back")
      assert.equal(run.error(), null, "And the warning's gone once a read works")
      assert.equal(run.state().value, "back")
      run.events().fire("head")
      assert.equal(run.reads.length, 3, "New blocks count again")
    } finally {
      run.stop()
    }
  })

  it("reads the wait from the answer, and a minute if it doesn't say", async () => {
    const answer = (headers: Record<string, string>) => new Response(JSON.stringify({ error: "Too many." }), { status: 429, headers })
    await assert.rejects(readResponse(answer({ "retry-after": "17" })), (error: ReadError) => error.failure.kind === "slowedDown" && error.failure.retryAfter === 17)
    await assert.rejects(readResponse(answer({})), (error: ReadError) => error.failure.kind === "slowedDown" && error.failure.retryAfter === 60)
    await assert.rejects(readResponse(answer({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" })), (error: ReadError) => error.failure.kind === "slowedDown" && error.failure.retryAfter === 60)
  })

  it("is worded as something that clears by itself, without telling anyone to restart anything", () => {
    const { message } = feedProblem({ kind: "slowedDown", said: "x", retryAfter: 60 }, "https://patina.example")
    assert.match(message, /slow down/)
    assert.match(message, /by themselves/)
    assert.doesNotMatch(message, /restart/i)
    assert.equal(panelProblem({ kind: "slowedDown", said: "Too many requests.", retryAfter: 60 }, "https://patina.example").message, "Too many requests.")
  })
})

describe("a read and its updates failing", () => {
  let stops: (() => void)[] = []
  const started = (live = true) => {
    const run = follow(live)
    stops.push(run.stop)
    return run
  }

  beforeEach(() => {
    FakeEvents.opened = []
    ;(globalThis as { EventSource?: unknown }).EventSource = FakeEvents
    mock.timers.enable({ apis: ["setTimeout"] })
  })
  afterEach(() => {
    stops.forEach((stop) => stop())
    stops = []
    delete (globalThis as { EventSource?: unknown }).EventSource
    mock.timers.reset()
  })

  it("keeps a refusal when the updates are refused after it", async () => {
    const run = started()
    await run.fail(refused())
    run.events().refuse()
    assert.deepEqual(run.error(), REFUSED)
    assert.equal(run.state().value, null)
  })

  it("keeps a refusal when the updates are refused before it", async () => {
    const run = started()
    run.events().refuse()
    await run.fail(refused())
    assert.deepEqual(run.error(), REFUSED)
    assert.equal(run.state().value, null)
  })

  it("keeps a refusal through each retry of the updates", async () => {
    const run = started()
    await run.fail(refused())
    run.events().refuse()
    for (let tries = 0; tries < 3; tries++) {
      mock.timers.tick(3000)
      run.events().refuse()
      assert.deepEqual(run.error(), REFUSED)
    }
  })

  it("keeps a refusal when the data source is also down", async () => {
    const run = started()
    await run.fail(refused())
    run.events().fire("down")
    assert.deepEqual(run.error(), REFUSED)
  })

  it("keeps saying it's still reading when the updates fail first", async () => {
    const run = started()
    run.events().drop()
    assert.equal(run.error(), null)
    assert.equal(run.state().loading, true)
  })

  it("warns that wallet numbers are old when the updates fail during the first read", async () => {
    const run = started()
    run.events().drop()
    await run.finish("first")
    assert.equal(run.state().value, "first")
    assert.deepEqual(run.error(), UNREACHABLE)
  })

  it("warns when a wallet that read fine loses its updates", async () => {
    const run = started()
    await run.finish("first")
    assert.equal(run.error(), null)
    run.events().drop()
    assert.equal(run.state().value, "first")
    assert.deepEqual(run.error(), UNREACHABLE)
  })

  it("says the data source is down when a wallet that read fine hears so", async () => {
    const run = started()
    await run.finish("first")
    run.events().fire("down")
    assert.deepEqual(run.error(), { kind: "unavailable", said: "Can't reach the data source." })
  })

  it("keeps the numbers, and the refusal, when a later read is refused and the updates drop", async () => {
    for (const refusedFirst of [true, false]) {
      const run = started()
      await run.finish("first")
      run.events().fire("head")
      if (refusedFirst) await run.fail(refused())
      run.events().drop()
      if (!refusedFirst) await run.fail(refused())
      assert.equal(run.state().value, "first")
      assert.deepEqual(run.error(), REFUSED)
    }
  })

  it("prefers what the server said over a read that got no answer", async () => {
    const run = started()
    await run.finish("first")
    run.events().fire("head")
    await run.fail(new TypeError("Failed to fetch"))
    assert.deepEqual(run.error(), UNREACHABLE)
    run.events().fire("down")
    assert.deepEqual(run.error(), { kind: "unavailable", said: "Can't reach the data source." })
  })

  it("doesn't let an old refusal outlive a read that worked", async () => {
    const run = started()
    await run.finish("first")
    run.events().fire("head")
    await run.fail(refused())
    run.events().drop()
    run.events().fire("open")
    assert.equal(run.reads.length, 3)
    run.events().drop()
    await run.finish("second")
    assert.equal(run.state().value, "second")
    assert.deepEqual(run.error(), UNREACHABLE)
  })

  it("clears everything once a read works and the updates are back", async () => {
    const run = started()
    await run.fail(refused())
    run.events().refuse()
    mock.timers.tick(3000)
    run.events().fire("open")
    assert.equal(run.reads.length, 2)
    await run.finish("first")
    assert.equal(run.state().value, "first")
    assert.equal(run.error(), null)
  })

  it("keeps the warning until the catch-up read after reconnecting works", async () => {
    const run = started()
    await run.finish("first")
    run.events().drop()
    run.events().fire("open")
    assert.deepEqual(run.error(), UNREACHABLE)
    await run.finish("second")
    assert.equal(run.error(), null)
  })

  it("doesn't let a read from before the drop clear its warning", async () => {
    const run = started()
    await run.finish("first")
    run.events().fire("head")
    run.events().drop()
    run.events().fire("open")
    assert.equal(run.reads.length, 2, "the catch-up read waits for this one")
    await run.finish("second")
    assert.deepEqual(run.error(), UNREACHABLE)
    assert.equal(run.reads.length, 3)
    await run.finish("third")
    assert.equal(run.error(), null)
  })

  it("has no updates to lose on the demo wallet", async () => {
    const run = started(false)
    await run.fail(refused())
    assert.equal(FakeEvents.opened.length, 0)
    assert.deepEqual(run.error(), REFUSED)
  })
})
