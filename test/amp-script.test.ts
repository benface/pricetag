import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

const SCRIPT = new URL("../scripts/amp", import.meta.url).pathname
const ENV_BEFORE = "AMP_QUERY_URL=https://staging.example\n"
const ENV_BLOCK = "# >>> scripts/amp start (removed by scripts/amp stop)\nAMP_QUERY_URL=http://127.0.0.1:1602\n# <<< scripts/amp start\n"

// A copy of the script in a throwaway repo and home, with docker, lsof, curl and sleep replaced, so nothing real is touched.
let root: string
let repo: string
let stateA: string
let stateB: string

const stub = (dir: string, name: string, source: string) => {
  writeFileSync(join(dir, name), `#!/bin/bash\n${source}\n`)
  chmodSync(join(dir, name), 0o755)
}
const dockerLog = () => (existsSync(join(root, "docker.log")) ? readFileSync(join(root, "docker.log"), "utf8") : "")
const envFile = () => join(repo, ".env.local")
const setCurl = (body: string) => writeFileSync(join(root, "curl-response"), body)

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "amp-script-")))
  repo = join(root, "repo")
  stateA = join(root, "state-a")
  stateB = join(root, "state-b")
  mkdirSync(join(repo, "scripts"), { recursive: true })
  copyFileSync(SCRIPT, join(repo, "scripts/amp"))
  mkdirSync(stateA)
  mkdirSync(stateB)

  const amp = join(root, "home/.amp/bin")
  mkdirSync(amp, { recursive: true })
  for (const tool of ["ampd", "ampctl", "ampsql"]) stub(amp, tool, "exit 0")

  const bin = join(root, "bin")
  mkdirSync(bin)
  stub(
    bin,
    "docker",
    `echo "$*" >> "${root}/docker.log"
case "$1" in
  inspect) [ -f "${root}/container-owner" ] || exit 1; cat "${root}/container-owner" ;;
  rm) rm -f "${root}/container-owner" ;;
esac`,
  )
  stub(bin, "lsof", `[ -f "${root}/port-in-use" ]`)
  stub(bin, "curl", `[ -f "${root}/curl-response" ] || exit 22; cat "${root}/curl-response"`)
  stub(bin, "sleep", "exit 0")
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function run(args: string[], stateDir: string) {
  return spawnSync("bash", args, {
    cwd: repo,
    encoding: "utf8",
    env: { PATH: `${join(root, "bin")}:${process.env.PATH}`, HOME: join(root, "home"), PRICETAG_AMP_DIR: stateDir },
  })
}
const amp = (command: string, stateDir: string) => run([join(repo, "scripts/amp"), command], stateDir)
/** Runs `body` with the script's functions loaded, and one pass through any wait loop. */
const inScript = (body: string) =>
  run(
    [
      "-c",
      `source "${join(repo, "scripts/amp")}"
RPC_URL=http://rpc.invalid
HEAD_TIMEOUT_SECS=1
sleep() { SECONDS=100; }
running_ampd_pid() { :; }
running_throttle_pid() { :; }
${body}`,
    ],
    stateA,
  )

describe("scripts/amp ownership", () => {
  beforeEach(() => {
    writeFileSync(join(root, "container-owner"), `${stateA}\n`)
    writeFileSync(envFile(), ENV_BEFORE + ENV_BLOCK)
    writeFileSync(join(stateA, "env_file"), envFile())
  })

  for (const command of ["start", "stop"]) {
    it(`${command} from another state directory changes nothing and names the owner`, () => {
      writeFileSync(join(stateB, "keep"), "")
      const result = amp(command, stateB)
      assert.equal(result.status, 1)
      assert.match(result.stderr, new RegExp(`PRICETAG_AMP_DIR=${stateA} scripts/amp stop`))
      assert.doesNotMatch(dockerLog(), /^rm /m)
      assert.equal(readFileSync(envFile(), "utf8"), ENV_BEFORE + ENV_BLOCK)
      assert.ok(existsSync(join(stateA, "env_file")))
    })
  }

  it("stop from the owning directory removes the container and the env block", () => {
    const result = amp("stop", stateA)
    assert.equal(result.status, 0, result.stderr)
    assert.match(dockerLog(), /^rm -f -v pricetag-amp-metadb$/m)
    assert.equal(readFileSync(envFile(), "utf8"), ENV_BEFORE)
    assert.ok(!existsSync(stateA))
  })

  it("recognizes its own directory through a symlink", () => {
    const link = join(root, "link-to-a")
    symlinkSync(stateA, link)
    assert.equal(amp("stop", link).status, 0)
    assert.match(dockerLog(), /^rm -f -v pricetag-amp-metadb$/m)
  })

  it("start from the owning directory clears what a crash left behind", () => {
    // No RPC answer, so it stops right after cleaning up.
    const result = amp("start", stateA)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /couldn't read Base's chain head/)
    assert.match(dockerLog(), /^rm -f -v pricetag-amp-metadb$/m)
    assert.equal(readFileSync(envFile(), "utf8"), ENV_BEFORE)
  })

  it("refuses a container it didn't label", () => {
    writeFileSync(join(root, "container-owner"), "\n")
    for (const command of ["start", "stop"]) {
      const result = amp(command, stateA)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /didn't start/)
    }
    assert.doesNotMatch(dockerLog(), /^rm /m)
  })

  it("start refuses a busy port before cleaning up, so another Amp's env block survives", () => {
    rmSync(join(root, "container-owner"))
    writeFileSync(join(root, "port-in-use"), "")
    const result = amp("start", stateB)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /port 1602 is already in use/)
    assert.doesNotMatch(dockerLog(), /^rm /m)
    assert.equal(readFileSync(envFile(), "utf8"), ENV_BEFORE + ENV_BLOCK)
  })

  it("stop with no record leaves the env block alone while another Amp holds the ports", () => {
    rmSync(join(root, "container-owner"))
    writeFileSync(join(root, "port-in-use"), "")
    const result = amp("stop", stateB)
    assert.equal(result.status, 0)
    assert.match(result.stderr, /something else is using port 1602/)
    assert.equal(readFileSync(envFile(), "utf8"), ENV_BEFORE + ENV_BLOCK)
  })
})

describe("scripts/amp chain head", () => {
  const FAILED_READS: Record<string, string> = {
    "a JSON-RPC error": '{"jsonrpc":"2.0","id":1,"error":{"code":-32007,"message":"25/second request limit reached"}}',
    "a malformed body": "<html>Bad Gateway</html>",
    "a non-hex result": '{"jsonrpc":"2.0","id":1,"result":"latest"}',
    "a null result": '{"jsonrpc":"2.0","id":1,"result":null}',
    "an empty body": "",
  }

  it("reads a good response", () => {
    setCurl('{"jsonrpc":"2.0","id":1,"result":"0x328b740"}')
    const result = inScript("rpc_head")
    assert.equal(result.status, 0)
    assert.equal(result.stdout, String(0x328b740))
  })

  for (const [name, body] of Object.entries(FAILED_READS)) {
    it(`prints nothing and fails on ${name}`, () => {
      setCurl(body)
      const result = inScript("rpc_head")
      assert.notEqual(result.status, 0)
      assert.equal(result.stdout, "")
    })

    it(`doesn't count ${name} as reaching chain head`, () => {
      setCurl(body)
      const result = inScript(`table_head() { printf 53000000; }\nwait_for_head "some/dataset blocks"`)
      assert.equal(result.status, 1)
      assert.doesNotMatch(result.stderr, /block /)
    })

    it(`retries ${name} until a good read, without keeping any of it`, () => {
      setCurl(body)
      const result = inScript(`sleep() { printf '{"result":"0x10"}' > "${root}/curl-response"; }\nrpc_head_with_retries`)
      assert.equal(result.stdout, "16")
    })
  }

  it("counts a table near the head as ready, and one far behind as not", () => {
    setCurl(`{"jsonrpc":"2.0","id":1,"result":"0x${(53000003).toString(16)}"}`)
    const check = (at: number) => inScript(`table_head() { printf ${at}; }\nwait_for_head "some/dataset blocks"`)
    const ready = check(53000000)
    assert.equal(ready.status, 0)
    assert.match(ready.stderr, /block 53000003, blocks 3 behind/)
    const behind = check(52000000)
    assert.equal(behind.status, 1)
    assert.match(behind.stderr, /blocks 1000003 behind/)
  })

  it("stops waiting if the RPC throttle has died", () => {
    setCurl('{"jsonrpc":"2.0","id":1,"result":"0x1"}')
    const result = inScript(`running_throttle_pid() { return 1; }\nwait_for_head "some/dataset blocks"`)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /the RPC throttle exited/)
  })
})
