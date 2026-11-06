import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, it } from "node:test"
import { createJobWatch, datasetsIn, expiryOf, type Env } from "../scripts/job-watch.ts"

const REF = "benface/pricetag@0.2.0"
const PATH = "/materialized-datasets/benface/pricetag/versions/0.2.0"
const NOW = Date.parse("2026-11-06T16:00:00Z")

const jwt = (exp: number) => `x.${Buffer.from(JSON.stringify({ exp: exp / 1000 })).toString("base64url")}.y`

type Call = { method: string; url: string; authorization: string | null; body?: string }

function setup(options: { status?: string; postStatus?: number; token?: () => string; env?: () => Env } = {}) {
  const state = { status: options.status ?? "RUNNING", postStatus: options.postStatus ?? 200, now: NOW, getStatus: 200 }
  const calls: Call[] = []
  const logs: string[] = []
  const alerts: string[] = []
  const watch = createJobWatch({
    controller: "http://amp.test",
    fetch: (async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET"
      const authorization = new Headers(init.headers).get("authorization")
      calls.push({ method, url, authorization, body: init.body as string | undefined })
      if (method === "POST") {
        if (state.postStatus === 200) state.status = "SCHEDULED"
        return new Response("{}", { status: state.postStatus })
      }
      return new Response(JSON.stringify({ status: "RUNNING", materialization: { status: state.status } }), { status: state.getStatus })
    }) as typeof fetch,
    readEnv: options.env ?? (() => ({ AMP_QUERY_TOKEN: "read-token", PRICETAG_DATASET: REF })),
    readAdminToken: options.token ?? (() => jwt(NOW + 3_600_000)),
    now: () => state.now,
    log: (line) => logs.push(line),
    alert: (line) => alerts.push(line),
  })
  const posts = () => calls.filter((call) => call.method === "POST")
  return { watch, state, calls, logs, alerts, posts }
}

describe("the job watch", () => {
  it("leaves a healthy job alone, checking with the read token", async () => {
    const { watch, calls, alerts, posts } = setup()
    await watch.tick()
    assert.equal(posts().length, 0)
    assert.deepEqual(alerts, [])
    assert.equal(calls[0]!.url, `http://amp.test${PATH}?view=basic`)
    assert.equal(calls[0]!.authorization, "Bearer read-token")
  })

  it("restarts a FATAL job once, with the admin token and an empty object, and reports it", async () => {
    const token = jwt(NOW + 3_600_000)
    const { watch, state, alerts, logs, posts } = setup({ status: "FATAL", token: () => token })
    await watch.tick()
    assert.equal(posts().length, 1)
    assert.equal(posts()[0]!.url, `http://amp.test${PATH}`)
    assert.equal(posts()[0]!.authorization, `Bearer ${token}`)
    assert.equal(posts()[0]!.body, "{}")
    assert.equal(alerts.length, 1)
    assert.match(alerts[0]!, /FATAL/)

    state.status = "FATAL" // The restart hasn't shown up yet.
    state.now += 30_000
    await watch.tick()
    assert.equal(posts().length, 1)

    state.status = "RUNNING"
    state.now += 30_000
    await watch.tick()
    assert.ok(logs.some((line) => /running again 60 s after/.test(line)))
    assert.ok(!logs.some((line) => line.includes(token)))
  })

  it("restarts a job that dies again after it recovered", async () => {
    const { watch, state, posts } = setup({ status: "FATAL" })
    await watch.tick()
    state.status = "RUNNING"
    await watch.tick()
    state.status = "FATAL"
    await watch.tick()
    assert.equal(posts().length, 2)
  })

  it("restarts again and says so if it's still FATAL 5 minutes later", async () => {
    const { watch, state, alerts, posts } = setup({ status: "FATAL" })
    await watch.tick()
    state.status = "FATAL"
    state.now += 5 * 60_000
    await watch.tick()
    assert.equal(posts().length, 2)
    assert.ok(alerts.some((line) => /still FATAL/.test(line)))
  })

  it("sees a FATAL job from the parent's status too", async () => {
    const fatalParent = createJobWatch({
      controller: "http://amp.test",
      fetch: (async () => new Response(JSON.stringify({ status: "FATAL", materialization: { status: "STOPPED" } }))) as typeof fetch,
      readEnv: () => ({ PRICETAG_DATASET: REF }),
      readAdminToken: () => jwt(NOW + 1000),
      now: () => NOW,
      log: () => {},
      alert: () => {},
    })
    await fatalParent.tick()
    assert.deepEqual(fatalParent.statuses(), [`${REF} FATAL`])
  })

  it("doesn't restart a job that was stopped on purpose, or one in a recoverable error", async () => {
    for (const status of ["STOPPED", "STOPPING", "STOP_REQUESTED", "ERROR", "SCHEDULED", "COMPLETED"]) {
      const { watch, posts } = setup({ status })
      await watch.tick()
      assert.equal(posts().length, 0, status)
    }
  })

  it("says plainly when the token expires, once, without trying to write, and keeps checking", async () => {
    const { watch, state, alerts, posts, calls } = setup({ status: "RUNNING", token: () => jwt(NOW - 1000) })
    await watch.tick()
    await watch.tick()
    assert.equal(alerts.length, 1)
    assert.match(alerts[0]!, /admin token expired/)
    state.status = "FATAL"
    await watch.tick()
    assert.equal(posts().length, 0)
    assert.equal(calls.length, 3)
  })

  it("says plainly when the token is refused, and restarts once a new one's in place", async () => {
    const { watch, state, alerts, logs, posts } = setup({ status: "FATAL", postStatus: 401 })
    await watch.tick()
    await watch.tick()
    assert.equal(alerts.length, 1)
    assert.match(alerts[0]!, /admin token was refused \(401\)/)
    state.postStatus = 200
    await watch.tick()
    assert.equal(posts().length, 3)
    assert.match(alerts[1]!, /restarted/)
    assert.ok(logs.includes("The admin token works again."))
  })

  it("retries a restart that failed for another reason", async () => {
    const { watch, state, alerts, posts } = setup({ status: "FATAL", postStatus: 503 })
    await watch.tick()
    await watch.tick()
    assert.equal(alerts.length, 1)
    state.postStatus = 200
    await watch.tick()
    assert.equal(posts().length, 3)
  })

  it("logs an outage once and survives it", async () => {
    let online = false
    const logs: string[] = []
    const watch = createJobWatch({
      controller: "http://amp.test",
      fetch: (async () => {
        if (!online) throw new TypeError("fetch failed with http://secret.test")
        return new Response(JSON.stringify({ status: "RUNNING", materialization: { status: "RUNNING" } }))
      }) as typeof fetch,
      readEnv: () => ({ PRICETAG_DATASET: REF }),
      readAdminToken: () => jwt(NOW + 1000),
      now: () => NOW,
      log: (line) => logs.push(line),
      alert: () => {},
    })
    await watch.tick()
    await watch.tick()
    assert.equal(logs.filter((line) => /a request failed \(TypeError\)/.test(line)).length, 1)
    assert.ok(!logs.some((line) => line.includes("secret")))
    online = true
    await watch.tick()
    assert.ok(logs.some((line) => /requests work again/.test(line)))
  })

  it("follows the env file, and keeps what it last read when it can't be read", async () => {
    let env: Env = { PRICETAG_DATASET: REF }
    const { watch, calls, alerts } = setup({ env: () => {
      if (!env) throw new Error("gone")
      return env
    } })
    await watch.tick()
    env = { PRICETAG_DATASET: "benface/pricetag@0.3.0" }
    await watch.tick()
    assert.match(calls[1]!.url, /pricetag\/versions\/0\.3\.0/)
    env = undefined as unknown as Env
    await watch.tick()
    assert.match(calls[2]!.url, /pricetag\/versions\/0\.3\.0/)
    assert.match(alerts[0]!, /env file can't be read/)
  })

  it("works over real HTTP", async () => {
    let status = "FATAL"
    const requests: string[] = []
    const server = createServer((req, res) => {
      let body = ""
      req.on("data", (chunk) => (body += chunk))
      req.on("end", () => {
        requests.push(`${req.method} ${req.url} ${body}`)
        if (req.method === "POST") status = "SCHEDULED"
        res.end(JSON.stringify({ status: "RUNNING", materialization: { status } }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const watch = createJobWatch({
        controller: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        fetch,
        readEnv: () => ({ PRICETAG_DATASET: REF }),
        readAdminToken: () => jwt(Date.now() + 60_000),
        now: Date.now,
        log: () => {},
        alert: () => {},
      })
      await watch.tick()
      assert.deepEqual(requests, [`GET ${PATH}?view=basic `, `POST ${PATH} {}`])
    } finally {
      server.close()
    }
  })
})

describe("datasetsIn", () => {
  it("takes the dataset, fork, rates and feeds, without repeats", () => {
    assert.deepEqual(
      datasetsIn({
        PRICETAG_DATASET: REF,
        PRICETAG_FORK_DATASET: "benface/pricetag_cautious@0.2.0",
        PRICETAG_RATES_DATASET: "benface/pricetag_rates@0.1.0",
        PRICETAG_FEEDS_DATASET: REF,
        PRICETAG_BASE_DATASET: "benface/base@1.0.0",
      }),
      [REF, "benface/pricetag_cautious@0.2.0", "benface/pricetag_rates@0.1.0"],
    )
  })

  it("never touches anything outside benface/", () => {
    assert.deepEqual(datasetsIn({ PRICETAG_DATASET: "edgeandnode/base_mainnet@0.0.2", PRICETAG_FORK_DATASET: "" }), [])
  })
})

describe("expiryOf", () => {
  it("reads a JWT's expiry, and doesn't guess at anything else", () => {
    assert.equal(expiryOf(jwt(NOW)), NOW)
    assert.equal(expiryOf("not a token"), undefined)
  })
})
