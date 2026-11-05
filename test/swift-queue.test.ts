import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, test } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"

const script = "macos/swift-queue.sh"

// Its own queue for each test, so these never wait for a real build or leave one waiting.
let dir: string
let env: Record<string, string | undefined>
let runs: ReturnType<typeof start>[]

function start(command: string, extra: Record<string, string> = {}) {
  const child = spawn(script, ["bash", "-c", command], { env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  child.stdout.on("data", (data) => (output += data))
  child.stderr.on("data", (data) => (output += data))
  const ended = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)))
  const run = { child, ended, output: () => output }
  runs.push(run)
  return run
}

// Generous, because these run on a Mac that's busy compiling. Nothing here waits for a set time.
async function until(condition: () => boolean) {
  const deadline = Date.now() + 180_000
  while (!condition()) {
    assert.ok(Date.now() < deadline, "This never happened.")
    await sleep(50)
  }
}

function lockIsFree() {
  return spawnSync("lockf", ["-k", "-s", "-t", "0", join(dir, "lock"), "true"]).status === 0
}

function isRunning(pid: number) {
  const { stdout } = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" })
  return stdout.trim() !== "" && !stdout.trim().startsWith("Z")
}

// Holds the lock until this test calls release(), however long the Mac takes to get there.
function holdLock() {
  const gate = join(dir, "release")
  const run = start(`echo holding; until [ -e ${gate} ]; do sleep 0.05; done`)
  return { ...run, release: () => writeFileSync(gate, "") }
}

// Starts something in its own process group, like swift test's helper, then says what it is.
const withStray = `set -m; sleep 300 & echo "stray $!"; set +m;`

function strayPid(output: string) {
  return Number(/stray (\d+)/.exec(output)?.[1])
}

function isTracked(pid: number) {
  return readdirSync(dir)
    .filter((name) => name.startsWith("job."))
    .some((name) => existsSync(join(dir, name, "pids")) && readFileSync(join(dir, name, "pids"), "utf8").includes(`${pid} `))
}

// Only on macOS, the one place this runs.
describe("swift-queue", { skip: process.platform !== "darwin" }, () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "swift-queue-"))
    env = { ...process.env, SWIFT_QUEUE_DIR: dir, SWIFT_QUEUE_WAIT: "", npm_lifecycle_event: "" }
    runs = []
  })

  afterEach(async () => {
    for (const run of runs) run.child.kill("SIGTERM")
    await Promise.all(runs.map((run) => run.ended))
    await until(() => readdirSync(dir).every((name) => !name.startsWith("job.")))
    rmSync(dir, { recursive: true, force: true })
  })

  test("keeps a command's exit status, so a failing check still fails", async () => {
    const run = start("exit 7")
    assert.equal(await run.ended, 7)
    assert.match(run.output(), /failed with exit 7/)
    assert.equal(await start("exit 0").ended, 0)
  })

  test("runs one at a time, and says what it's waiting for", async () => {
    const log = join(dir, "order")
    const first = holdLock()
    await until(() => first.output().includes("holding"))
    const second = start(`echo second > ${log}`)
    await until(() => second.output().includes("Waiting"))
    assert.ok(!existsSync(log))
    assert.match(second.output(), /Waiting .* not hung: .*bash -c .* has been running/)
    first.release()
    assert.equal(await first.ended, 0)
    assert.equal(await second.ended, 0)
    assert.equal(readFileSync(log, "utf8"), "second\n")
  })

  test("a wait that runs out says the command didn't run, with its own exit status", async () => {
    const holder = holdLock()
    await until(() => holder.output().includes("holding"))
    const waiter = start("echo RAN", { SWIFT_QUEUE_WAIT: "1" })
    assert.equal(await waiter.ended, 75)
    assert.doesNotMatch(waiter.output(), /^RAN$/m)
    assert.match(waiter.output(), /did not run.*isn't a failed check/)
    holder.release()
    assert.equal(await holder.ended, 0)
  })

  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    test(`${signal} frees the lock and leaves no strays`, async () => {
      const run = start(`${withStray} echo holding; wait`)
      await until(() => run.output().includes("holding"))
      const stray = strayPid(run.output())
      await until(() => isTracked(stray))
      run.child.kill(signal)
      await until(() => !isRunning(stray))
      await until(lockIsFree)
      await until(() => run.output().includes("no result"))
    })
  }

  test("stops what a finished command left running, before the next turn starts", async () => {
    const gate = join(dir, "release")
    const run = start(`${withStray} until [ -e ${gate} ]; do sleep 0.05; done; exit 3`)
    await until(() => run.output().includes("stray"))
    const stray = strayPid(run.output())
    await until(() => isTracked(stray))
    writeFileSync(gate, "")
    assert.equal(await run.ended, 3)
    assert.ok(!isRunning(stray))
    assert.ok(lockIsFree())
  })

  test("a killed wait leaves nothing behind", async () => {
    const holder = holdLock()
    await until(() => holder.output().includes("holding"))
    const waiter = start("echo RAN")
    await until(() => waiter.output().includes("Waiting"))
    waiter.child.kill("SIGKILL")
    await until(() => waiter.output().includes("never ran"))
    await until(() => readdirSync(dir).filter((name) => name.startsWith("job.")).length === 1)
    holder.release()
    assert.equal(await holder.ended, 0)
    assert.doesNotMatch(waiter.output(), /^RAN$/m)
    assert.ok(lockIsFree())
  })

  test("a command inside a turn doesn't queue again", () => {
    const { status, stdout } = spawnSync(script, ["echo", "nested"], { env: { ...env, SWIFT_QUEUE_TURN: "1" }, encoding: "utf8" })
    assert.equal(status, 0)
    assert.equal(stdout, "nested\n")
  })
})

test("what agents run to compile Swift goes through the queue, and pnpm mac doesn't", () => {
  const read = (file: string) => readFileSync(file, "utf8")
  assert.equal(JSON.parse(read("package.json")).scripts["check:mac"], "macos/check-mac.sh")
  assert.match(read("macos/check-mac.sh"), /exec "\$here\/swift-queue.sh"/)
  assert.match(read("macos/shot.sh"), /swift-queue\.sh" xcodebuild/)
  assert.match(read("macos/anvil-test.sh"), /swift-queue\.sh" swift test/)
  assert.match(read("macos/run.sh"), /"--build-only" \] && .*exec "\$here\/swift-queue\.sh"/)
})
