import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, it } from "node:test"
import { createApi } from "../server/app.ts"
import { createContractCheck } from "../server/contract.ts"

const ADDRESS = "0x00000000000000000000000000000000000000aa"
const answering = (result: unknown, status = 200) => {
  const calls: unknown[] = []
  const send = (async (_url: unknown, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string))
    return new Response(JSON.stringify({ result }), { status })
  }) as typeof fetch
  return { send, calls }
}

describe("whether an address is a contract", () => {
  it("says no for an address with no code", async () => {
    assert.equal(await createContractCheck("http://node", answering("0x").send)(ADDRESS), false)
  })

  it("says yes for an address with code", async () => {
    assert.equal(await createContractCheck("http://node", answering("0x6080604052").send)(ADDRESS), true)
  })

  it("says no for a wallet that only delegated its code, since someone still holds its key", async () => {
    assert.equal(await createContractCheck("http://node", answering(`0xef0100${"ab".repeat(20)}`).send)(ADDRESS), false)
  })

  it("doesn't know when the node doesn't say, and asks again next time", async () => {
    const failing = answering(undefined)
    const check = createContractCheck("http://node", failing.send)
    assert.equal(await check(ADDRESS), null)
    assert.equal(await check(ADDRESS), null)
    assert.equal(failing.calls.length, 2)
    assert.equal(await createContractCheck("http://node", answering("0x", 500).send)(ADDRESS), null)
    assert.equal(await createContractCheck("http://node", (async () => { throw new Error("down") }) as typeof fetch)(ADDRESS), null)
  })

  it("only asks once for an answer it has", async () => {
    const node = answering("0x")
    const check = createContractCheck("http://node", node.send)
    await check(ADDRESS)
    await check(ADDRESS)
    assert.equal(node.calls.length, 1)
  })
})

describe("asking how far a read has got", () => {
  const request = (path: string) => {
    const api = createApi({})
    const server = createServer((req, res) => void api(req, res))
    return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`)
          .then(async (response) => resolve({ status: response.status, body: (await response.json()) as Record<string, unknown> }))
          .catch(reject)
          .finally(() => server.close())
      })
    })
  }

  it("has nothing to do for the demo wallet", async () => {
    const { status, body } = await request("/api/wallet/demo/progress")
    assert.equal(status, 200)
    assert.deepEqual(body, { stage: "costs", transfers: null, isContract: false })
  })

  it("turns down what isn't an address", async () => {
    assert.equal((await request("/api/wallet/nope/progress")).status, 400)
  })
})
