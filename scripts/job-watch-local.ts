// Runs the job watch against real jobs on a local Amp, started by scripts/job-watch-local.sh.
//
// Amp's panic can't be forced, so each job dies the other way Amp has of making one FATAL: it's deployed with no retries, and its
// RPC answers garbage until the job errors. The RPC is fixed before Amp marks the job FATAL, so a restart can only work if the watch
// sends it. The watch's own code does the checking and the restarting, on its real interval. Only its URL, env and token differ.

import { strict as assert } from "node:assert"
import { createServer } from "node:http"
import { CHECK_EVERY_MS, createJobWatch } from "./job-watch.ts"

const { ADMIN_URL, ANVIL_URL, MAIN_RPC_PORT, FORK_RPC_PORT } = process.env as Record<string, string> & { ADMIN_URL: string; ANVIL_URL: string; MAIN_RPC_PORT: string; FORK_RPC_PORT: string }
const MAIN = "benface/watch_main@0.0.1"
const FORK = "benface/watch_fork@0.0.1"
const TIMEOUT_MS = 180_000

const startedAt = Date.now()
const say = (line: string) => console.log(`${((Date.now() - startedAt) / 1000).toFixed(1).padStart(6)} s  ${line}`)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const versionUrl = (ref: string) => {
  const [name, version] = ref.split("@")
  return `${ADMIN_URL}/materialized-datasets/${name}/versions/${version}`
}

/** An RPC in front of Anvil. While it's broken, it answers with something no block decodes from. */
function switchableRpc(port: number) {
  const rpc = { broken: false }
  createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    response.setHeader("content-type", "application/json")
    if (rpc.broken) return void response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { garbage: true } }))
    const upstream = await fetch(ANVIL_URL, { method: "POST", headers: { "content-type": "application/json" }, body: Buffer.concat(chunks) })
    response.statusCode = upstream.status
    response.end(await upstream.text())
  }).listen(port, "127.0.0.1").unref()
  return rpc
}

type Status = { id: number; composite: string; job: string; jobId: number; block: number; startBlock: number }

async function statusOf(ref: string): Promise<Status> {
  const body = (await (await fetch(versionUrl(ref))).json()) as any
  const network = body.materialization?.progress?.tables?.blocks?.networks?.[0]
  return { id: body.id, composite: body.status, job: body.materialization?.status, jobId: body.materialization?.job_id, block: network?.current_block ?? -1, startBlock: network?.start_block ?? -1 }
}

async function until(what: string, check: (status: Status) => boolean, ref: string): Promise<Status> {
  const deadline = Date.now() + TIMEOUT_MS
  for (;;) {
    const status = await statusOf(ref)
    if (check(status)) return status
    assert(Date.now() < deadline, `${ref}: timed out waiting until ${what}. Last: ${JSON.stringify(status)}`)
    await sleep(250)
  }
}

// Only the version's own jobs, because its other jobs, like the one that compacts, log events all the time.
async function eventCount(ref: string) {
  const { id, jobId } = await statusOf(ref)
  const { events } = (await (await fetch(`${versionUrl(ref)}/events`)).json()) as { events: { job_id: number }[] }
  return events.filter((event) => event.job_id === id || event.job_id === jobId).length
}

async function deploy(ref: string, provider: string) {
  const response = await fetch(versionUrl(ref), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider, retry_strategy: { strategy: "none" } }) })
  assert.equal(response.status, 202, `deploying ${ref}: ${await response.text()}`)
}

const rpcs: Record<string, { broken: boolean }> = { [MAIN]: switchableRpc(Number(MAIN_RPC_PORT)), [FORK]: switchableRpc(Number(FORK_RPC_PORT)) }
await deploy(MAIN, "main")
await deploy(FORK, "fork")
await until("it's running and has blocks", (status) => status.job === "RUNNING" && status.block > 3, MAIN)
await until("it's running and has blocks", (status) => status.job === "RUNNING" && status.block > 3, FORK)
say(`${MAIN} and ${FORK} are running`)

// What the watch sent, so we can tell which job it restarted.
const restarts: string[] = []
const watch = createJobWatch({
  controller: ADMIN_URL,
  fetch: (async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") restarts.push(String(url))
    return fetch(url, init)
  }) as typeof fetch,
  readEnv: () => ({ PRICETAG_DATASET: MAIN, PRICETAG_FORK_DATASET: FORK, AMP_QUERY_TOKEN: "local" }),
  // This Amp has no auth, so it doesn't look at this. It's not a real token.
  readAdminToken: () => "local",
  now: Date.now,
  log: (line) => say(`watch: ${line}`),
  alert: (line) => say(`watch ALERT: ${line}`),
})
let watching = true
const loop = (async () => {
  while (watching) {
    await watch.tick()
    await sleep(CHECK_EVERY_MS)
  }
})()

// Healthy jobs get no POST from the watch, and one sent by hand changes nothing.
const before = await statusOf(MAIN)
const eventsBefore = await eventCount(MAIN)
const noop = await fetch(versionUrl(MAIN), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
assert.equal(((await noop.json()) as { id: number }).id, before.id)
await sleep(CHECK_EVERY_MS + 2_000)
assert.equal(await eventCount(MAIN), eventsBefore, "a POST on a healthy job added a job event")
assert.equal((await statusOf(MAIN)).jobId, before.jobId)
assert.deepEqual(restarts, [], "the watch restarted a healthy job")
say(`A POST on healthy ${MAIN} returned the same id and added no event, and the watch sent none in a full check`)

async function killAndRecover(ref: string, other: string) {
  const sent = restarts.length
  const otherBefore = await statusOf(other)
  const { jobId, startBlock } = await statusOf(ref)

  rpcs[ref]!.broken = true
  say(`${ref}: its RPC is broken`)
  await until("it errors", (status) => status.job === "ERROR", ref)
  rpcs[ref]!.broken = false
  say(`${ref}: job errored, RPC fixed, nothing has been restarted`)

  const dead = await until("Amp marks it FATAL", (status) => status.job === "FATAL" && status.composite === "FATAL", ref)
  const diedAt = Date.now()
  assert.equal(restarts.length, sent, "the watch restarted a job that wasn't FATAL")
  say(`${ref}: FATAL at block ${dead.block}`)

  const back = await until("it runs again", (status) => status.job === "RUNNING", ref)
  const seconds = (Date.now() - diedAt) / 1000
  assert.equal(restarts.length, sent + 1, "expected exactly one restart")
  assert(restarts[sent]!.endsWith(`/materialized-datasets/${ref.replace("@", "/versions/")}`), `restarted the wrong job: ${restarts[sent]}`)
  assert.equal(back.jobId, jobId, "the restart should resume the same job")
  assert(seconds <= CHECK_EVERY_MS / 1000 + 5, `took ${seconds} s, with a check every ${CHECK_EVERY_MS / 1000} s`)
  say(`${ref}: RUNNING ${seconds.toFixed(1)} s after going FATAL, same job ${jobId}, from 1 restart`)

  const moving = await until("it passes the block it died at", (status) => status.block > dead.block + 5, ref)
  assert.equal(moving.startBlock, startBlock, "history should be kept")
  say(`${ref}: at block ${moving.block}, up from ${dead.block}, history still starts at ${moving.startBlock}`)

  const otherNow = await statusOf(other)
  assert.equal(otherNow.job, "RUNNING", `${other} should have kept running`)
  assert.equal(otherNow.jobId, otherBefore.jobId)
  assert(otherNow.block > otherBefore.block, `${other} should have kept moving`)
}

await killAndRecover(MAIN, FORK)
await killAndRecover(FORK, MAIN)

// Nothing else goes out once they're both healthy again.
const total = restarts.length
await sleep(CHECK_EVERY_MS + 2_000)
assert.equal(restarts.length, total)
assert.equal(total, 2)

watching = false
await loop
say(`Passed: both jobs died and came back, with ${total} restarts in all`)
process.exit(0)
