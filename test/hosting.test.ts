import assert from "node:assert/strict"
import { createServer, request, type IncomingMessage, type Server } from "node:http"
import { after, before, describe, it } from "node:test"
import { ASSETS } from "@pricetag/sdk/core"
import type { Source } from "@pricetag/sdk/internal"
import { createApi } from "../server/app.ts"
import { checkoutLimit, clientIpOf, createCounter, gate, hashOf, hostingOf, parseInvites, redact, useStructuredLogs } from "../server/hosting.ts"
import { createHandler } from "../server/http.ts"
import { laneOf } from "../server/lanes.ts"
import { createCoinbase } from "../server/coinbase.ts"
import type { Onramp } from "../server/onramp.ts"

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
    const hosting = hostingOf({ PRICETAG_HOSTED: "1", PRICETAG_INVITES: `ben:${hashOf(INVITE)}`, PRICETAG_CLIENT_IP_HEADER: "fly-client-ip" })
    assert.equal(hosting.host, "0.0.0.0")
    assert.equal(hosting.servesApp, false)
  })

  it("won't listen where others can reach it without invites, hosted or not", () => {
    for (const HOST of ["0.0.0.0", "::", "192.168.1.20", "my-mac.local"]) assert.throws(() => hostingOf({ HOST }), /PRICETAG_INVITES/, HOST)
    for (const HOST of ["127.0.0.1", "127.0.0.53", "::1", "localhost"]) assert.equal(hostingOf({ HOST }).host, HOST)
    assert.equal(hostingOf({ HOST: "0.0.0.0", PRICETAG_INVITES: `ben:${hashOf(INVITE)}` }).host, "0.0.0.0")
  })

  it("won't host without being told where the client's address is, which Coinbase would get wrong", () => {
    const invited = { PRICETAG_HOSTED: "1", PRICETAG_INVITES: `ben:${hashOf(INVITE)}` }
    assert.throws(() => hostingOf(invited), /PRICETAG_CLIENT_IP_HEADER/)
    assert.throws(() => hostingOf({ ...invited, PRICETAG_CLIENT_IP_HEADER: "  " }), /PRICETAG_CLIENT_IP_HEADER/)
    assert.equal(hostingOf({ ...invited, PRICETAG_CLIENT_IP_HEADER: "Fly-Client-IP" }).clientIpHeader, "fly-client-ip")
  })

  it("run three people's queries at once when hosted, unless told otherwise", () => {
    assert.equal(hostingOf({}).ampLanes, 3)
    assert.equal(hostingOf({ PRICETAG_AMP_LANES: "1" }).ampLanes, 1)
    assert.throws(() => hostingOf({ PRICETAG_AMP_LANES: "0" }), /PRICETAG_AMP_LANES/)
  })

  it("refuse an invite list with a typo rather than lock someone out", () => {
    assert.throws(() => parseInvites("ben"))
    assert.throws(() => parseInvites(`Ben:${hashOf(INVITE)}`))
    assert.deepEqual([...parseInvites(` ben:${hashOf(INVITE)} , ana:${hashOf("x")} `).values()], ["ben", "ana"])
  })

  it("read the client's address from the host's header only when told to", () => {
    const req = (headers: Record<string, string>, remoteAddress: string) => ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage
    assert.equal(clientIpOf(req({ "fly-client-ip": "203.0.113.9" }, "10.0.0.1"), "fly-client-ip"), "203.0.113.9")
    assert.equal(clientIpOf(req({ "fly-client-ip": "203.0.113.9" }, "198.51.100.7"), null), "198.51.100.7")
    assert.equal(clientIpOf(req({}, "::ffff:198.51.100.7"), null), "198.51.100.7")
    assert.equal(clientIpOf(req({}, "2001:db8::7"), null), "2001:db8::7")
  })

  it("say nothing rather than a wrong address", () => {
    const req = (headers: Record<string, string>, remoteAddress: string) => ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage
    for (const local of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "10.0.0.1", "192.168.1.5", "172.16.0.9", "fdaa::3", "fe80::1"]) assert.equal(clientIpOf(req({}, local), null), null, local)
    // Behind a proxy with no header set, the socket is the proxy, and a client's own `x-forwarded-for` doesn't change that.
    assert.equal(clientIpOf(req({ "x-forwarded-for": "203.0.113.9" }, "10.0.0.1"), null), null)
    assert.equal(clientIpOf(req({}, "10.0.0.1"), "fly-client-ip"), null, "the header's missing")
    assert.equal(clientIpOf(req({ "fly-client-ip": "203.0.113.9, 198.51.100.7" }, "198.51.100.1"), "fly-client-ip"), null, "a client's entry could be first in a list")
    assert.equal(clientIpOf(req({ "fly-client-ip": "not an address" }, "198.51.100.1"), "fly-client-ip"), null)
  })

  it("refuse to start on a header a client can write", () => {
    for (const header of ["x-forwarded-for", "X-Forwarded-For", "forwarded", "x-real-ip"]) assert.throws(() => hostingOf({ PRICETAG_CLIENT_IP_HEADER: header }), /a client can write its own/)
    assert.equal(hostingOf({ PRICETAG_CLIENT_IP_HEADER: "Fly-Client-IP" }).clientIpHeader, "fly-client-ip")
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

  it("stops taking the host's checks once it's shutting down", async () => {
    api.drain()
    assert.equal((await call(server, "/healthz")).status, 503)
  })
})

describe("a local shutdown", () => {
  it("ends an open stream without invites, so it doesn't wait the full drain", async () => {
    const hosting = hostingOf({})
    const api = gate(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(": open\n\n")
      return true
    }, hosting, () => ({ amp: false, buying: false }))
    const server = createServer(createHandler(api, null))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const { port } = server.address() as { port: number }
      const ended = await new Promise<boolean>((resolve, reject) => {
        request({ host: "127.0.0.1", port, path: "/api/events" }, (res) => {
          res.once("data", () => api.drain())
          res.on("end", () => resolve(true))
          res.resume()
        }).on("error", reject).end()
        setTimeout(() => resolve(false), 2000).unref()
      })
      assert.ok(ended)
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })
})

describe("checkouts", () => {
  const OTHER = "another-invite-for-tests-only-0123456"
  const CHECKOUT = "/api/onramp/checkout"
  const valid = JSON.stringify({ address: ME, asset: "ETH", cryptoAmount: "0.01" })
  let now = 0
  let asked = 0

  async function serving(onramp: Onramp | null, limits: { checkoutsPerHour: number; checkoutsPerDay: number }): Promise<Server> {
    const base = hostingOf({ PRICETAG_INVITES: `ben:${hashOf(INVITE)},ana:${hashOf(OTHER)}` })
    const hosting = { ...base, limits: { ...base.limits, perMinute: 1000, ...limits } }
    const api = createApi({}, null, onramp, { limitCheckout: checkoutLimit(hosting, () => now) })
    const server = createServer(createHandler(gate(api, hosting, () => ({ amp: false, buying: onramp !== null }), () => now), null))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    return server
  }
  const onramp: Onramp = {
    checkout: async () => {
      asked += 1
      return { url: "https://pay.coinbase.com/buy", ref: "a-ref" }
    },
    orders: async () => [],
  }

  it("only use up the hour's when they're valid, and stop before Coinbase is asked", async () => {
    now = 0
    asked = 0
    const server = await serving(onramp, { checkoutsPerHour: 1, checkoutsPerDay: 100 })
    try {
      const invalid = [JSON.stringify({ address: "nope", asset: "ETH", cryptoAmount: "0.01" }), JSON.stringify({ address: ME, asset: "DOGE", cryptoAmount: "0.01" }), JSON.stringify({ address: ME, asset: "ETH", cryptoAmount: "lots" }), JSON.stringify({ address: ME, asset: "ETH", cryptoAmount: "1", fiat: { amount: "x", currency: "USD" } })]
      for (const body of invalid) assert.equal((await call(server, CHECKOUT, { method: "POST", invite: INVITE, body })).status, 400, body)
      assert.equal((await call(server, CHECKOUT, { method: "POST", invite: INVITE, body: valid })).status, 200, "None of those counted")
      const limited = await call(server, CHECKOUT, { method: "POST", invite: INVITE, body: valid })
      assert.equal(limited.status, 429)
      assert.equal(limited.headers["retry-after"], "3600")
      assert.equal(asked, 1)
      assert.equal((await call(server, CHECKOUT, { method: "POST", invite: OTHER, body: valid })).status, 200, "Each invite has its own")
    } finally {
      server.close()
    }
  })

  it("hold everyone together to the day's, without invalid ones using it up", async () => {
    now = 0
    const server = await serving(onramp, { checkoutsPerHour: 100, checkoutsPerDay: 1 })
    const logged = console.error
    console.error = () => {}
    try {
      assert.equal((await call(server, CHECKOUT, { method: "POST", invite: INVITE, body: JSON.stringify({ address: "nope" }) })).status, 400)
      assert.equal((await call(server, CHECKOUT, { method: "POST", invite: INVITE, body: valid })).status, 200)
      assert.equal((await call(server, CHECKOUT, { method: "POST", invite: OTHER, body: valid })).status, 429)
    } finally {
      console.error = logged
      server.close()
    }
  })

  it("answer plainly on a host with no Coinbase key, and take nothing from the limits", async () => {
    assert.equal(createCoinbase({}), null)
    assert.equal(createCoinbase({ COINBASE_ONRAMP_KEY_ID: "only-half-a-key" }), null)
    const server = await serving(null, { checkoutsPerHour: 1, checkoutsPerDay: 1 })
    try {
      assert.deepEqual(JSON.parse((await call(server, "/healthz")).body), { ok: true, amp: false, buying: false })
      for (const answer of [await call(server, CHECKOUT, { method: "POST", invite: INVITE, body: valid }), await call(server, CHECKOUT, { method: "POST", invite: INVITE, body: valid }), await call(server, "/api/onramp/orders/a-ref", { invite: INVITE })]) {
        assert.equal(answer.status, 503)
        assert.deepEqual(JSON.parse(answer.body), { error: "Buying isn't set up on this server." })
      }
      assert.equal((await call(server, CHECKOUT, { method: "POST", body: valid })).status, 401, "And it still takes an invite to find that out")
    } finally {
      server.close()
    }
  })
})

describe("whose queries they are", () => {
  it("are the invite's, except the head's and the chain's, which are everyone's", async () => {
    const lanes: Record<string, (string | undefined)[]> = { head: [], window: [] }
    const blocks = { blockNum: 20, timestamp: "2026-11-04T00:00:00.000Z" }
    const source: Source = {
      mode: "raw",
      startBlock: 1,
      historyFrom: null,
      head: async () => {
        lanes.head!.push(laneOf())
        return blocks
      },
      processedThrough: async (_, head) => head,
      readWindow: async () => {
        lanes.window!.push(laneOf())
        return { rows: [], priced: null, gasUnknown: [] }
      },
      readReferences: async () => [],
      readLatestReference: async () => null,
      readEthBalances: async () => new Map(),
      readBalances: async (_, block) => ({ blockNum: block, amounts: {} }),
    }
    const created = { source, readRates: async () => ({ byBlock: {}, latest: null }), proofs: { datasets: async () => [], priceBehind: async () => null, currentPriceBehind: async () => null, readBlock: async () => null } }
    const hosting = hostingOf({ PRICETAG_INVITES: `ben:${hashOf(INVITE)}` })
    const server = createServer(createHandler(gate(createApi({}, created, null), hosting, () => ({ amp: true, buying: false })), null))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      assert.equal((await call(server, `/api/portfolio/${ME}`, { method: "POST", invite: INVITE, body: "{}" })).status, 200)
      assert.ok(lanes.window!.length > 0)
      assert.ok(lanes.window!.every((lane) => lane === "ben"), "The wallet's read is theirs")
      assert.ok(lanes.head!.length > 0)
      assert.ok(lanes.head!.every((lane) => lane === undefined), "The head isn't, even when their read asked for it")
    } finally {
      server.close()
    }
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

  it("leave out addresses and hashes the way the SQL spells them", () => {
    const me = ME.slice(2)
    // As `readLegs`, `readWindow` and the calldata search write them.
    const sql = [
      `SELECT * FROM p.legs WHERE account = X'${me}'`,
      `AND (topic1 = X'${me.padStart(64, "0")}' OR topic2 = x'${me.padStart(64, "0")}')`,
      `AND tx_hash = X'${"ab".repeat(32)}'`,
      `eth_call(NULL, evm_encode_hex('0xca11bde05977b3631167028862be2a173976ca11'), X'70a08231${me.padStart(64, "0")}', 5)`,
      `OR strpos(encode(input, 'hex'), '${me}') > 0)`,
      `account ${ME.toUpperCase().replace("0X", "0x")}`,
    ].join(" ")
    const line = redact(`Amp query failed: ${sql}`, [])
    assert.ok(!line.toLowerCase().includes(me), line)
    assert.ok(!line.includes("ab".repeat(32)), line)
    assert.match(line, /account = X'\[hex\]'/)
    assert.match(line, /strpos\(encode\(input, 'hex'\), '\[hex\]'\)/)
    assert.equal(redact("block 12345 in 0.25 s, feed ETH/USD", []), "block 12345 in 0.25 s, feed ETH/USD", "Numbers that aren't hex stay readable")
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

describe("one request's reads", () => {
  let server: Server
  let reads = 0
  const source: Source = {
    mode: "raw",
    startBlock: 1,
    historyFrom: null,
    head: async () => ({ blockNum: 20, timestamp: "2026-11-04T00:00:00.000Z" }),
    processedThrough: async (_, head) => head,
    readWindow: async () => {
      reads += 1
      return { rows: [], priced: null, gasUnknown: [] }
    },
    readReferences: async (blocks) => blocks.map((blockNum) => ({ blockNum, ethUsd: "300000000000", usdcUsd: "100000000" })),
    readLatestReference: async () => ({ blockNum: 20, ethUsd: "300000000000", usdcUsd: "100000000" }),
    readEthBalances: async () => new Map(),
    readBalances: async (_, block) => ({ blockNum: block, amounts: Object.fromEntries(ASSETS.map((asset) => [asset, "0"])) }),
  }
  const wallet = (i: number) => `0x${i.toString(16).padStart(40, "0")}`
  const post = (path: string, body: unknown) => call(server, path, { method: "POST", body: JSON.stringify(body) })

  before(async () => {
    server = createServer(createHandler(createApi({}, { source, readRates: async () => ({ byBlock: {}, latest: null }), proofs: { datasets: async () => [], priceBehind: async () => null, currentPriceBehind: async () => null, readBlock: async () => null } }), null))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  })
  after(() => server.close())

  it("are bounded before any starts, however the wallets are named", async () => {
    reads = 0
    const many = Array.from({ length: 300 }, (_, i) => wallet(i + 1))
    const mine = (from: number) => ({ senders: Object.fromEntries(Array.from({ length: 3 }, (_, i) => [wallet(from + i), { kind: "mine" }])), costs: {}, withdrawals: [] })
    const refused = [
      await post(`/api/portfolio/${ME}`, { method: "average", linked: many }),
      await post(`/api/portfolio/${ME}/compare`, { method: "average", linked: many }),
      await post(`/api/portfolio/${ME}`, { method: "average", book: { ...mine(1000), senders: Object.fromEntries(many.map((address) => [address, { kind: "mine" }])) } }),
      // Eight candidates of three wallets each are 24 in all.
      await post(`/api/portfolio/${ME}/preview`, { method: "average", candidates: Array.from({ length: 8 }, (_, i) => mine(2000 + i * 3)) }),
    ]
    assert.deepEqual(refused.map(({ status }) => status), [400, 400, 400, 400])
    assert.match(refused[0]!.body, /up to 20 other wallets/)
    assert.equal(reads, 0, "Nothing was read for them")
  })

  it("still reads a request within the bound", async () => {
    reads = 0
    const { status } = await post(`/api/portfolio/${ME}`, { method: "average", linked: [wallet(1), wallet(2)] })
    assert.equal(status, 200)
    assert.ok(reads >= 1)
  })
})
