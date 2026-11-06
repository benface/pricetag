import assert from "node:assert/strict"
import { createServer, type RequestListener, type Server } from "node:http"
import { connect, type AddressInfo } from "node:net"
import { describe, it } from "node:test"
import { createL1FeeReader, relayRate } from "@pricetag/sdk/internal"
import { createThrottle } from "../scripts/rpc-throttle.ts"

const listen = (server: Server) =>
  new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)))

async function withThrottle(perSecond: number, upstream: RequestListener, run: (url: string) => Promise<void>) {
  const rpc = createServer(upstream)
  const throttle = createThrottle(await listen(rpc), perSecond)
  try {
    await run(await listen(throttle))
  } finally {
    rpc.closeAllConnections()
    throttle.closeAllConnections()
    rpc.close()
    throttle.close()
  }
}

const call = (url: string, body = "{}") => fetch(url, { method: "POST", body })

describe("the RPC throttle", () => {
  it("passes the request and response through", async () => {
    await withThrottle(
      1000,
      (req, res) => {
        req.pipe(res)
      },
      async (url) => {
        const response = await call(url, '{"method":"eth_call"}')
        assert.equal(response.status, 200)
        assert.equal(await response.text(), '{"method":"eth_call"}')
      },
    )
  })

  it("holds a burst to its rate", async () => {
    const arrivals: number[] = []
    await withThrottle(
      50,
      (_req, res) => {
        arrivals.push(Date.now())
        res.end("{}")
      },
      async (url) => {
        await Promise.all(Array.from({ length: 10 }, () => call(url)))
      },
    )
    assert.equal(arrivals.length, 10)
    // 9 gaps of 20 ms, with room for timers firing a little early.
    assert.ok(arrivals.at(-1)! - arrivals[0]! >= 150)
  })

  it("retries a 429 instead of passing it on", async () => {
    let calls = 0
    await withThrottle(
      1000,
      (_req, res) => {
        calls += 1
        res.writeHead(calls === 1 ? 429 : 200)
        res.end(calls === 1 ? "slow down" : "ok")
      },
      async (url) => {
        const response = await call(url)
        assert.equal(response.status, 200)
        assert.equal(await response.text(), "ok")
      },
    )
    assert.equal(calls, 2)
  })

  it("passes on other errors, so Amp's own handling sees them", async () => {
    let calls = 0
    await withThrottle(
      1000,
      (_req, res) => {
        calls += 1
        res.writeHead(500)
        res.end("nope")
      },
      async (url) => {
        assert.equal((await call(url)).status, 500)
      },
    )
    assert.equal(calls, 1)
  })

  it("survives a client that disconnects partway through its request", async () => {
    await withThrottle(
      1000,
      (_req, res) => {
        res.end("ok")
      },
      async (url) => {
        const { hostname, port } = new URL(url)
        await new Promise<void>((resolve) => {
          const socket = connect(Number(port), hostname, () => {
            socket.write("POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\npartial", () => {
              socket.destroy()
              resolve()
            })
          })
        })
        await new Promise((resolve) => setTimeout(resolve, 50))
        assert.equal(await (await call(url)).text(), "ok")
      },
    )
  })

  it("survives a client that disconnects while waiting for the RPC", async () => {
    let calls = 0
    let answerLate = () => {}
    let markReached = () => {}
    const reached = new Promise<void>((resolve) => {
      markReached = resolve
    })
    await withThrottle(
      1000,
      (_req, res) => {
        calls += 1
        if (calls === 1) {
          answerLate = () => res.end("late")
          markReached()
        } else {
          res.end("ok")
        }
      },
      async (url) => {
        const abandoned = new AbortController()
        const request = fetch(url, { method: "POST", body: "{}", signal: abandoned.signal }).catch(() => null)
        await reached
        abandoned.abort()
        await request
        await new Promise((resolve) => setTimeout(resolve, 50))
        answerLate()
        await new Promise((resolve) => setTimeout(resolve, 50))
        assert.equal(await (await call(url)).text(), "ok")
      },
    )
  })

  it("answers 502 when the RPC's response breaks partway through", async () => {
    let calls = 0
    await withThrottle(
      1000,
      (_req, res) => {
        calls += 1
        if (calls === 1) {
          res.writeHead(200, { "content-length": "100" })
          res.write("partial", () => res.destroy())
        } else {
          res.end("ok")
        }
      },
      async (url) => {
        assert.equal((await call(url)).status, 502)
        assert.equal(await (await call(url)).text(), "ok")
      },
    )
  })

  it("answers 502 without quoting the URL when the RPC can't be reached", async () => {
    const throttle = createThrottle("http://127.0.0.1:1/secret-key", 1000)
    const logged: unknown[][] = []
    const original = console.error
    console.error = (...args: unknown[]) => void logged.push(args)
    try {
      const response = await call(await listen(throttle))
      assert.equal(response.status, 502)
      assert.doesNotMatch(await response.text(), /secret-key/)
      assert.doesNotMatch(JSON.stringify(logged), /secret-key/)
    } finally {
      console.error = original
      throttle.closeAllConnections()
      throttle.close()
    }
  })

  it("and L1 fees stay within an RPC's limit together, with several wallets reading", async () => {
    const limit = 100
    const sent: number[] = []
    let refused = 0
    const rpc = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { id: number }[] | { id: number }
      const now = Date.now()
      const calls = Array.isArray(body) ? body.length : 1
      // A real limit: calls in the last second, counting each one in a batch.
      if (sent.filter((at) => at > now - 1_000).length + calls > limit) {
        refused++
        res.writeHead(429).end()
        return
      }
      for (let i = 0; i < calls; i++) sent.push(now)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(Array.isArray(body) ? body.map(({ id }) => ({ id, result: { blockNumber: "0x64", l1Fee: "0x10" } })) : { id: body.id, result: "0x1" }))
    })
    const url = await listen(rpc)
    const throttle = createThrottle(url, relayRate(limit))
    const relayed = await listen(throttle)
    try {
      const read = createL1FeeReader(url, fetch, 100, console, limit)
      const wallet = (n: number) => read(Array.from({ length: 60 }, (_, i) => ({ txHash: `0x${n}${i}`, blockNum: 100 })))
      // 20 at a time, like a busy Amp, since this many sockets at once is more than a listening port queues.
      let left = 180
      const amp = async () => {
        while (left-- > 0) await call(relayed, JSON.stringify({ id: 1 }))
      }
      const [first, second] = await Promise.all([wallet(1), wallet(2), ...Array.from({ length: 20 }, amp)])
      assert.equal(first.size, 60)
      assert.equal(second.size, 60)
      // The two add up to exactly the limit, so a timer running late can tip a call over. Both wait those out.
      assert.ok(refused <= 10, `refused ${refused}`)
      assert.equal(sent.length, 300)
      // Both used their shares, rather than one starving the other: 300 calls at 100 a second.
      assert.ok(sent.at(-1)! - sent[0]! >= 2_400, `took ${sent.at(-1)! - sent[0]!} ms`)
    } finally {
      rpc.closeAllConnections()
      throttle.closeAllConnections()
      rpc.close()
      throttle.close()
    }
  })
})
