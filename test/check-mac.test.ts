import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, test } from "node:test"

// The real scripts in a throwaway repo, with stand-ins for swift and xcodebuild that write down what they were asked to do.
let root: string
let repo: string
let calls: string
let env: Record<string, string | undefined>

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

const passes = () => readdirSync(join(root, "passes"))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "check-mac-"))
  repo = join(root, "repo")
  mkdirSync(join(repo, "macos/Config"), { recursive: true })
  for (const file of ["check-mac.sh", "swift-queue.sh", "run.sh", "Config/App.xcconfig"]) cpSync(join("macos", file), join(repo, "macos", file))
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
  calls = join(root, "calls")
  env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_CALLS: calls, SWIFT_QUEUE_DIR: join(root, "queue"), CHECK_MAC_PASSES: join(root, "passes") }
  for (const name of ["SWIFT_QUEUE_TURN", "ANVIL_RPC_URL", "BASE_READ_RPC_URL", "CONFIGURATION", "npm_lifecycle_event", "GIT_DIR", "GIT_INDEX_FILE"]) delete env[name]
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("check:mac", () => {
  test("a full run does every step", () => {
    const { status, ran } = check()
    assert.equal(status, 0)
    assert.equal(ran.filter((call) => call.startsWith("swift test")).length, 2)
    assert.ok(ran.some((call) => /PricetagKit --scratch-path/.test(call)))
    assert.ok(ran.some((call) => /HotWalletKit --scratch-path/.test(call)))
    assert.ok(ran.some((call) => call.includes("-scheme App") && call.includes("-configuration Release") && call.includes("APP_SIGN_IDENTITY=Apple Development")))
    assert.ok(ran.some((call) => call.includes("-scheme PricetagKit") && call.includes("generic/platform=iOS")))
    assert.ok(ran.some((call) => call.includes("-scheme HotWalletKit") && call.includes("generic/platform=iOS")))
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
    assert.equal(check(["--force"]).ran.length, 5)
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
      assert.equal(check().ran.length, 5)
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
    assert.equal(check([], { FAKE_TOOLS: "2" }).ran.length, 5)
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
      assert.equal(check().ran.length, 5)
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
      assert.equal(check([], { [setting]: "http://127.0.0.1:1" }).ran.length, 5)
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
    assert.equal(check().ran.length, 5)
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
