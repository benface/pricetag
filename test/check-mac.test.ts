import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, test } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"

// The real scripts in a throwaway repo, with stand-ins for swift and xcodebuild that write down what they were asked to do.
let root: string
let repo: string
let calls: string
let env: Record<string, string | undefined>

// The queue's own tests have their own record, because they're not one of the steps in a turn.
const fakePnpm = `#!/bin/sh
echo "pnpm $*" >>"$FAKE_PNPM_CALLS"
[ -z "\${FAKE_QUEUE_TESTS_FAIL:-}" ] || exit 1
`

const fakeTool = (name: string) => `#!/bin/sh
case "$*" in
  *--version* | -version) echo "${name} \${FAKE_TOOLS:-1}"; exit 0 ;;
esac
echo "${name} $*" >>"$FAKE_CALLS"
[ -n "\${FAKE_ON_CALL:-}" ] && sh -c "$FAKE_ON_CALL"
case "$PWD $*" in
  *"\${FAKE_FAIL:-no such thing}"*) exit 3 ;;
esac
exit 0
`

function git(...args: string[]) {
  const { status, stdout, stderr } = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd: repo, encoding: "utf8" })
  assert.equal(status, 0, stderr)
  return stdout
}

function check(args: string[] = [], extra: Record<string, string> = {}) {
  writeFileSync(calls, "")
  const { status, stderr } = spawnSync(join(repo, "macos/check-mac.sh"), args, { env: { ...env, ...extra }, encoding: "utf8" })
  return { status, output: stderr, ran: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) }
}

// The records of passes, not of which run's latest.
const passes = () => readdirSync(join(root, "passes")).filter((name) => /^[0-9a-f]+$/.test(name))

// A full run that's paused right before it publishes its pass, for what can happen in that moment.
async function publishing() {
  const mv = join(root, "bin/mv")
  writeFileSync(mv, `#!/bin/sh
case "$1" in
  "$CHECK_MAC_PASSES/"*.new)
    touch "${root}/ready"
    until [ -e "${root}/release" ]; do sleep 0.05; done
    ;;
esac
exec /bin/mv "$@"
`)
  chmodSync(mv, 0o755)
  // Reading stderr so it's over when everything's done saying what happened, including the watcher of a script that's killed.
  const child = spawn(join(repo, "macos/check-mac.sh"), [], { env, stdio: ["ignore", "ignore", "pipe"] })
  child.stderr.resume()
  const ended = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)))
  const deadline = Date.now() + 30_000
  while (!existsSync(join(root, "ready"))) {
    assert.ok(Date.now() < deadline, "the run never got to publishing")
    await sleep(25)
  }
  rmSync(mv)
  return {
    child,
    release: () => {
      writeFileSync(join(root, "release"), "")
      return ended
    },
  }
}

// Only on macOS, the one place this runs: the real queue needs its lockf, ps and sw_vers.
describe("check:mac", { skip: process.platform !== "darwin" }, () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "check-mac-"))
    repo = join(root, "repo")
    mkdirSync(join(repo, "macos/Config"), { recursive: true })
    for (const file of ["check-mac.sh", "swift-queue.sh", "run.sh", "watch-only.sh", "hosted.sh", "Config/App.xcconfig", "Config/WatchOnly.xcconfig", "Config/Hosted.xcconfig"]) cpSync(join("macos", file), join(repo, "macos", file))
    writeFileSync(join(repo, "macos/Code.swift"), "let a = 1\n")
    for (const name of ["PricetagKit", "HotWalletKit"]) {
      mkdirSync(join(repo, "macos", name))
      writeFileSync(join(repo, "macos", name, "Package.swift"), "\n")
    }
    writeFileSync(join(repo, ".gitignore"), ".build/\nmacos/build/\n")
    git("init", "-q")
    git("add", "-A")
    git("commit", "-qm", "start")

    const bin = join(root, "bin")
    mkdirSync(bin)
    for (const tool of ["swift", "xcodebuild"]) {
      writeFileSync(join(bin, tool), fakeTool(tool))
      chmodSync(join(bin, tool), 0o755)
    }
    writeFileSync(join(bin, "pnpm"), fakePnpm)
    chmodSync(join(bin, "pnpm"), 0o755)
    calls = join(root, "calls")
    env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_CALLS: calls, FAKE_PNPM_CALLS: join(root, "pnpm-calls"), SWIFT_QUEUE_DIR: join(root, "queue"), CHECK_MAC_PASSES: join(root, "passes") }
    for (const name of ["SWIFT_QUEUE_TURN", "ANVIL_RPC_URL", "BASE_READ_RPC_URL", "CONFIGURATION", "npm_lifecycle_event", "CHECK_MAC_PASSED", "SWIFT_QUEUE_ON_PASS", "SWIFT_QUEUE_ON_STOP", "GIT_DIR", "GIT_INDEX_FILE"]) delete env[name]
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  test("a full run does every step", () => {
    const { status, ran } = check()
    assert.equal(status, 0)
    assert.equal(ran.filter((call) => call.startsWith("swift test")).length, 2)
    assert.ok(ran.some((call) => /PricetagKit --scratch-path/.test(call)))
    assert.ok(ran.some((call) => /HotWalletKit --scratch-path/.test(call)))
    assert.ok(ran.some((call) => call.includes("-scheme App") && call.includes("-configuration Release") && call.includes("APP_SIGN_IDENTITY=Apple Development")))
    assert.ok(ran.some((call) => call.includes("watch-only/build.xcconfig") && call.includes("CODE_SIGNING_ALLOWED=NO")))
    assert.match(readFileSync(join(repo, "macos/build/watch-only/build.xcconfig"), "utf8"), /^#include ".*WatchOnly\.xcconfig"\nPATINA_SERVER_HOST = \S+\n$/)
    assert.ok(ran.some((call) => call.includes("hosted/build.xcconfig") && call.includes("CODE_SIGNING_ALLOWED=NO")))
    assert.match(readFileSync(join(repo, "macos/build/hosted/build.xcconfig"), "utf8"), /^#include ".*Hosted\.xcconfig"\nPATINA_SERVER_HOST = \S+\n$/)
    assert.ok(ran.some((call) => call.includes("-scheme PricetagKit") && call.includes("generic/platform=iOS")))
    assert.ok(ran.some((call) => call.includes("-scheme HotWalletKit") && call.includes("generic/platform=iOS")))
  })

  const queueTestRuns = () => (existsSync(join(root, "pnpm-calls")) ? readFileSync(join(root, "pnpm-calls"), "utf8").trim().split("\n") : [])

  test("a full run does the queue's own tests, and a run that skips or only tests doesn't", () => {
    check()
    assert.deepEqual(queueTestRuns(), ["pnpm --silent check:swift-queue"])
    check()
    assert.equal(queueTestRuns().length, 1)
    check(["--quick"])
    assert.equal(queueTestRuns().length, 1)
    check(["--force"])
    assert.equal(queueTestRuns().length, 2)
  })

  test("the queue's own tests failing builds nothing, and forgets an earlier pass", () => {
    check()
    const { status, ran, output } = check(["--force"], { FAKE_QUEUE_TESTS_FAIL: "1" })
    assert.equal(status, 1)
    assert.deepEqual(ran, [])
    assert.match(output, /so nothing was built/)
    assert.equal(check().ran.length, 7)
  })

  test("the same code runs nothing the second time, and says so", () => {
    check()
    const { status, ran, output } = check()
    assert.equal(status, 0)
    assert.deepEqual(ran, [])
    assert.match(output, /Nothing ran: this exact code already passed/)
  })

  test("--force runs it again", () => {
    check()
    assert.equal(check(["--force"]).ran.length, 7)
  })

  for (const [what, change] of [
    ["an edit that isn't committed", () => appendFileSync(join(repo, "macos/Code.swift"), "let b = 2\n")],
    ["a new file that isn't committed", () => writeFileSync(join(repo, "macos/New.swift"), "let c = 3\n")],
    ["a deleted file", () => rmSync(join(repo, "macos/Code.swift"))],
    ["a commit", () => { appendFileSync(join(repo, "macos/Code.swift"), "let b = 2\n"); git("add", "-A"); git("commit", "-qm", "change") }],
  ] as const) {
    test(`${what} runs everything again`, () => {
      check()
      change()
      assert.equal(check().ran.length, 7)
    })
  }

  test("a change outside macos/, or to what's ignored, doesn't", () => {
    check()
    writeFileSync(join(repo, "README.md"), "hello\n")
    mkdirSync(join(repo, "macos/.build"))
    writeFileSync(join(repo, "macos/.build/product"), "built\n")
    assert.deepEqual(check().ran, [])
  })

  test("other tools run everything again", () => {
    check()
    assert.equal(check([], { FAKE_TOOLS: "2" }).ran.length, 7)
  })

  test("a pass carries over to another worktree of the same code", () => {
    check()
    const other = join(root, "other")
    git("worktree", "add", "-q", "--detach", other)
    writeFileSync(calls, "")
    const { status } = spawnSync(join(other, "macos/check-mac.sh"), [], { env, encoding: "utf8" })
    assert.equal(status, 0)
    assert.equal(readFileSync(calls, "utf8"), "")
  })

  for (const [step, pattern] of [
    ["a package's tests", "test --package-path"],
    ["the app's build", "-scheme App"],
    ["an iOS build", "-scheme HotWalletKit"],
  ] as const) {
    test(`${step} failing fails the check with its code, and isn't remembered`, () => {
      const failed = check([], { FAKE_FAIL: pattern })
      assert.notEqual(failed.status, 0)
      assert.match(failed.output, /failed/)
      assert.ok(!existsSync(join(root, "passes")) || passes().length === 0)
      assert.equal(check().ran.length, 7)
    })
  }

  test("a forced run that fails forgets the earlier pass, so the next run doesn't call it passed", () => {
    check()
    assert.equal(check(["--force"], { FAKE_FAIL: "HotWalletKit" }).status, 3)
    const next = check([], { FAKE_FAIL: "HotWalletKit" })
    assert.equal(next.status, 3)
    assert.doesNotMatch(next.output, /Nothing ran/)
  })

  test("a forced run that passes is remembered again", () => {
    check()
    assert.equal(check(["--force"]).status, 0)
    assert.deepEqual(check().ran, [])
  })

  test("--quick failing forgets the earlier pass, and passing leaves it", () => {
    check()
    assert.equal(check(["--quick"]).status, 0)
    assert.deepEqual(check().ran, [])
    assert.equal(check(["--quick"], { FAKE_FAIL: "HotWalletKit" }).status, 3)
    assert.equal(check().ran.length, 7)
  })

  test("a run the queue can't verify as clean isn't remembered, even with every step passing", () => {
    const flag = join(root, "ps-fails")
    const ps = join(root, "bin/ps")
    writeFileSync(ps, `#!/bin/sh\nif [ -e '${flag}' ] && [ "$1" = -axo ]; then exit 1; fi\nexec /bin/ps "$@"\n`)
    chmodSync(ps, 0o755)
    try {
      const failed = check([], { FAKE_ON_CALL: `touch '${flag}'` })
      assert.equal(failed.status, 69)
      assert.match(failed.output, /isn't a pass/)
      assert.equal(check().status, 69)
    } finally {
      rmSync(flag, { force: true })
    }
    const next = check()
    assert.equal(next.status, 0)
    assert.equal(next.ran.length, 7)
  })

  for (const [what, args] of [["a run", []], ["a forced run", ["--force"]]] as const) {
    test(`${what} stopped after its last step leaves no pass`, () => {
      if (args.length) check()
      // The last step's stand-in stops the queue's script, after the turn's done everything it does.
      const pid = join(root, "pid")
      const stop = `grep -q 'scheme HotWalletKit' "$FAKE_CALLS" && kill -TERM "$(cat '${pid}')"`
      writeFileSync(calls, "")
      const { status } = spawnSync("sh", ["-c", `"$0" "$@" & echo $! >'${pid}'; wait $!`, join(repo, "macos/check-mac.sh"), ...args], { env: { ...env, FAKE_ON_CALL: stop }, encoding: "utf8" })
      assert.notEqual(status, 0)
      assert.equal(check().ran.length, 7)
    })
  }

  test("a run that's still publishing its pass can't undo a newer run's failure", async () => {
    const older = await publishing()
    assert.equal(check(["--force"], { FAKE_FAIL: "HotWalletKit" }).status, 3)
    assert.equal(await older.release(), 0)
    const next = check([], { FAKE_FAIL: "HotWalletKit" })
    assert.equal(next.status, 3)
    assert.doesNotMatch(next.output, /Nothing ran/)
  })

  test("a run that's still publishing its pass doesn't count over a newer run that was stopped", async () => {
    const older = await publishing()
    const pid = join(root, "pid")
    const stop = `kill -TERM "$(cat '${pid}')"`
    spawnSync("sh", ["-c", `"$0" "$@" & echo $! >'${pid}'; wait $!`, join(repo, "macos/check-mac.sh"), "--force"], { env: { ...env, FAKE_ON_CALL: stop }, encoding: "utf8" })
    assert.equal(await older.release(), 0)
    assert.equal(check().ran.length, 7)
  })

  for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130], ["SIGHUP", 129], ["SIGKILL", null]] as const) {
    test(`${signal} while a run publishes its pass leaves no pass`, async () => {
      const run = await publishing()
      run.child.kill(signal)
      assert.equal(await run.release(), code)
      assert.equal(check().ran.length, 7)
    })
  }

  test("code that changed during the run isn't remembered as passing", () => {
    const { status, output } = check([], { FAKE_ON_CALL: `echo '// changed' >>${join(repo, "macos/Code.swift")}` })
    assert.equal(status, 0)
    assert.match(output, /won't be remembered/)
    assert.ok(!existsSync(join(root, "passes")) || passes().length === 0)
  })

  for (const setting of ["ANVIL_RPC_URL", "BASE_READ_RPC_URL"]) {
    test(`a run with ${setting} is never skipped or remembered`, () => {
      check([], { [setting]: "http://127.0.0.1:1" })
      assert.ok(!existsSync(join(root, "passes")) || passes().length === 0)
      check()
      assert.equal(check([], { [setting]: "http://127.0.0.1:1" }).ran.length, 7)
    })
  }

  test("a Debug run is never skipped or remembered", () => {
    check([], { CONFIGURATION: "Debug" })
    assert.ok(!existsSync(join(root, "passes")) || passes().length === 0)
  })

  test("--quick only runs the tests, even for code that's passed, and isn't a pass", () => {
    const quick = check(["--quick"])
    assert.equal(quick.status, 0)
    assert.deepEqual(quick.ran.map((call) => call.split(" ")[1]), ["test", "test"])
    assert.ok(!existsSync(join(root, "passes")) || passes().length === 0)
    assert.equal(check().ran.length, 7)
    assert.equal(check(["--quick"]).ran.length, 2)
  })

  test("--quick still fails when a test does", () => {
    assert.notEqual(check(["--quick"], { FAKE_FAIL: "HotWalletKit" }).status, 0)
  })

  test("it leaves what's staged alone", () => {
    appendFileSync(join(repo, "macos/Code.swift"), "let b = 2\n")
    writeFileSync(join(repo, "macos/New.swift"), "let c = 3\n")
    git("add", "macos/New.swift")
    const before = git("status", "--porcelain")
    check()
    assert.equal(git("status", "--porcelain"), before)
  })

  test("an unknown option isn't taken for a full check", () => {
    const { status, ran } = check(["--quik"])
    assert.equal(status, 64)
    assert.deepEqual(ran, [])
  })
})
