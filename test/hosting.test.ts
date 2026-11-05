import assert from "node:assert/strict"
import { createServer, request, type IncomingMessage, type Server } from "node:http"
import { after, before, describe, it } from "node:test"
import { createApi } from "../server/app.ts"
import { clientIpOf, createCounter, gate, hashOf, hostingOf, parseInvites, redact, useStructuredLogs } from "../server/hosting.ts"
import { createHandler } from "../server/http.ts"

const INVITE = "an-invite-for-tests-only-0123456789"
const ME = "0x3762620fbcb400b0f98365da4aad7d2a250e5d89"

function call(server: Server, path: string, { method = "GET", invite, body }: { method?: string; invite?: string; body?: string } = {}): Promise<{ status: number; body: string; headers: IncomingMessage["headers"] }> {
  const { port } = server.address() as { port: number }
  return new Promise((resolve, reject) => {
    const req = request({ port, host: "127.0.0.1", path, method, headers: { ...(invite ? { authorization: `Bearer ${invite}` } : {}), ...(body ? { "content-type": "application/json" } : {}) } }, (res) => {
      let text = ""
      res.on("data", (chunk) => (text += chunk))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text, headers: res.headers }))
    })
    req.on("error", reject)
    req.end(body)
  })
}

describe("hosting settings", () => {
  it("stay local and open without PRICETAG_HOSTED", () => {
    const hosting = hostingOf({})
    assert.equal(hosting.host, "127.0.0.1")
    assert.equal(hosting.invites.size, 0)
    assert.equal(hosting.servesApp, true)
  })

  it("won't host without invites, which would share the token and key with anyone", () => {
    assert.throws(() => hostingOf({ PRICETAG_HOSTED: "1" }), /PRICETAG_INVITES/)
    const hosting = hostingOf({ PRICETAG_HOSTED: "1", PRICETAG_INVITES: `ben:${hashOf(INVITE)}` })
    assert.equal(hosting.host, "0.0.0.0")
    assert.equal(hosting.servesApp, false)
  })

  it("refuse an invite list with a typo rather than lock someone out", () => {
    assert.throws(() => parseInvites("ben"))
    assert.throws(() => parseInvites(`Ben:${hashOf(INVITE)}`))
    assert.deepEqual([...parseInvites(` ben:${hashOf(INVITE)} , ana:${hashOf("x")} `).values()], ["ben", "ana"])
  })

  it("read the client's address from the host's header only when told to", () => {
    const req = (headers: Record<string, string>, remoteAddress: string) => ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage
    assert.equal(clientIpOf(req({ "fly-client-ip": "203.0.113.9" }, "10.0.0.1"), "fly-client-ip"), "203.0.113.9")
    assert.equal(clientIpOf(req({ "fly-client-ip": "203.0.113.9" }, "10.0.0.1"), null), "10.0.0.1")
    assert.equal(clientIpOf(req({}, "127.0.0.1"), null), null)
  })
})

describe("the gate", () => {
  let server: Server
  let now = 0
  let api: ReturnType<typeof gate>

  before(async () => {
    const hosting = { ...hostingOf({ PRICETAG_INVITES: `ben:${hashOf(INVITE)}` }), limits: { perMinute: 3, streams: 1, checkoutsPerHour: 1, checkoutsPerDay: 5 } }
    api = gate(createApi({}, null, null), hosting, () => ({ amp: false, buying: false }), () => now)
    server = createServer(createHandler(api, null))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  })
  after(() => server.close())

  it("answers the host's health check without an invite, and with nothing private", async () => {
    const { status, body } = await call(server, "/healthz")
    assert.equal(status, 200)
    assert.deepEqual(JSON.parse(body), { ok: true, amp: false, buying: false })
  })

  it("turns away the API without an invite on the list, however the path is spelled", async () => {
    for (const path of ["/api/wallet/demo", "/%61pi/wallet/demo", "/api/rules"]) assert.equal((await call(server, path)).status, 401, path)
    assert.equal((await call(server, "/api/wallet/demo", { invite: "not-an-invite-on-the-list" })).status, 401)
  })

  it("answers an invite, until its minute is used up, and says when to come back", async () => {
    now = 0
    assert.equal((await call(server, "/api/wallet/demo", { invite: INVITE })).status, 200)
    assert.equal((await call(server, "/api/wallet/demo", { invite: INVITE })).status, 200)
    assert.equal((await call(server, "/api/wallet/demo", { invite: INVITE })).status, 200)
    const limited = await call(server, "/api/wallet/demo", { invite: INVITE })
    assert.equal(limited.status, 429)
    assert.equal(limited.headers["retry-after"], "60")
    now = 60_000
    assert.equal((await call(server, "/api/wallet/demo", { invite: INVITE })).status, 200)
  })

  it("holds an invite to its checkouts an hour, before Coinbase is asked", async () => {
    now = 120_000
    const body = JSON.stringify({ address: ME, asset: "ETH", cryptoAmount: "0.01" })
    // No provider here, so the first one gets through to say buying isn't set up.
    assert.equal((await call(server, "/api/onramp/checkout", { method: "POST", invite: INVITE, body })).status, 503)
    assert.equal((await call(server, "/api/onramp/checkout", { method: "POST", invite: INVITE, body })).status, 429)
  })

  it("stops taking the host's checks once it's shutting down", async () => {
    api.drain()
    assert.equal((await call(server, "/healthz")).status, 503)
  })
})

describe("counting", () => {
  it("starts a new window once the last one's over", () => {
    let now = 0
    const counter = createCounter(1000, () => now)
    assert.equal(counter.take("a", 1), null)
    assert.equal(counter.take("a", 1), 1)
    assert.equal(counter.take("b", 1), null, "each key has its own")
    now = 1000
    assert.equal(counter.take("a", 1), null)
  })
})

describe("hosted logs", () => {
  it("leave out addresses, hashes, URLs, bearer tokens and the env's secrets", () => {
    const line = redact(`Amp query failed: SELECT * FROM legs WHERE account = '${ME}' AND tx = '0x${"ab".repeat(32)}' at https://amp.example/query?key=abc (Bearer abc.def) sk-secret-value`, ["sk-secret-value"])
    assert.equal(line, "Amp query failed: SELECT * FROM legs WHERE account = '[address]' AND tx = '[hash]' at [url] (Bearer [secret]) [secret]")
  })

  it("write every console line as JSON, redacted, including the SDK's", () => {
    const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug }
    const lines: string[] = []
    try {
      useStructuredLogs({ AMP_QUERY_TOKEN: "a-long-amp-token" }, (line) => lines.push(line))
      console.error("Linked wallet read failed:", new Error(`no rows for ${ME} with a-long-amp-token`))
      console.log("plain", 3)
    } finally {
      Object.assign(console, saved)
    }
    const [first, second] = lines.map((line) => JSON.parse(line) as { level: string; message: string })
    assert.deepEqual([first?.level, first?.message], ["error", "Linked wallet read failed: no rows for [address] with [secret]"])
    assert.deepEqual([second?.level, second?.message], ["info", "plain 3"])
  })
})
