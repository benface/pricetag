import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, test } from "node:test"

// `pnpm check:mac-install`: runs install.sh in a folder of its own, with a home of its own, and stubs for what would build, sign or
// touch this Mac's launchd. The server it starts is a stand-in that listens on a free port. So nothing here quits a running Patina,
// replaces the one in ~/Applications or installs a login agent.

let root: string
let repo: string
let home: string
let bin: string
let state: string
let port: number

function write(file: string, content: string, executable = false) {
  mkdirSync(join(file, ".."), { recursive: true })
  writeFileSync(file, content)
  if (executable) chmodSync(file, 0o755)
}

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as { port: number }
  await new Promise((resolve) => server.close(resolve))
  return port
}

function killFrom(file: string) {
  if (!existsSync(file)) return
  try {
    process.kill(Number(readFileSync(file, "utf8")))
  } catch {}
}

function install(env: Record<string, string> = {}) {
  return spawnSync(join(repo, "macos/install.sh"), [], {
    cwd: repo,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      PORT: String(port),
      STATE: state,
      ...env,
    },
    encoding: "utf8",
    timeout: 60_000,
  })
}

const installed = () => join(home, "Applications/Patina.app/Contents/MacOS/Patina")
const agent = () => join(home, "Library/LaunchAgents/com.benface.pricetag.server.plist")

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "mac-install-"))
  repo = join(root, "repo")
  home = join(root, "home")
  bin = join(root, "bin")
  state = join(root, "state")
  mkdirSync(state, { recursive: true })
  port = await freePort()

  mkdirSync(join(repo, "macos"), { recursive: true })
  copyFileSync("macos/install.sh", join(repo, "macos/install.sh"))
  chmodSync(join(repo, "macos/install.sh"), 0o755)
  write(join(repo, "macos/Config/App.xcconfig"), "APP_NAME = Patina\n")
  write(join(repo, "macos/install-bridge.sh"), "#!/bin/sh\nexit 0\n", true)
  // Builds whatever CONFIGURATION says, Release by default, like run.sh. NO_APP leaves nothing, like a build that stopped early.
  write(
    join(repo, "macos/run.sh"),
    `#!/bin/sh
set -eu
[ -z "\${NO_APP:-}" ] || exit 0
app="$(dirname "$0")/build/Build/Products/\${CONFIGURATION:-Release}/Patina.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Helpers"
printf '#!/bin/sh\\necho new\\n' >"$app/Contents/MacOS/Patina"
chmod +x "$app/Contents/MacOS/Patina"
`,
    true,
  )
  spawnSync("git", ["init", "-q", repo])

  // A previous install, which every failure has to leave as it was.
  write(installed(), "#!/bin/sh\necho old\n", true)

  write(join(bin, "codesign"), "#!/bin/sh\nexit 0\n", true)
  // The web app's build. TAKE_PORT has something else start listening on the port while it runs, after the installer's first look.
  write(
    join(bin, "pnpm"),
    `#!/bin/sh
[ -z "\${TAKE_PORT:-}" ] || { node "$STATE/../server.mjs" >/dev/null 2>&1 & echo $! >"$STATE/other.pid"; sleep 1; }
exit 0
`,
    true,
  )
  // Answers like the real server, and fails like it when the port's taken.
  write(
    join(root, "server.mjs"),
    `import { createServer } from "node:http"
createServer((_, response) => response.end("{}")).listen(Number(process.env.PORT), "127.0.0.1")
`,
  )
  // launchd, as far as install.sh uses it: one job, started in the background on bootstrap, with its pid in print.
  write(
    join(bin, "launchctl"),
    `#!/bin/sh
pidfile="$STATE/job.pid"
case "$1" in
  bootstrap)
    echo bootstrap >>"$STATE/calls"
    node "$STATE/../server.mjs" >/dev/null 2>&1 &
    echo $! >"$pidfile"
    ;;
  print)
    [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null || exit 113
    echo "	pid = $(cat "$pidfile")"
    ;;
  bootout)
    [ -f "$pidfile" ] || exit 3
    kill "$(cat "$pidfile")" 2>/dev/null
    rm -f "$pidfile"
    ;;
esac
`,
    true,
  )
})

afterEach(() => {
  killFrom(join(state, "job.pid"))
  killFrom(join(state, "other.pid"))
  rmSync(root, { recursive: true, force: true })
})

describe("install.sh", () => {
  test("installs a Release build and starts its server, whatever CONFIGURATION says", () => {
    const run = install({ CONFIGURATION: "Debug" })
    assert.equal(run.status, 0, run.stderr)
    assert.match(readFileSync(installed(), "utf8"), /echo new/)
    assert.ok(existsSync(agent()))
    assert.match(run.stdout, /its server runs on port/)
  })

  test("a build that leaves no app keeps the installed one", () => {
    const run = install({ NO_APP: "1" })
    assert.equal(run.status, 1)
    assert.match(run.stderr, /installed one stays as it was/)
    assert.match(readFileSync(installed(), "utf8"), /echo old/)
    assert.ok(!existsSync(join(state, "calls")))
  })

  test("an app that isn't validly signed keeps the installed one", () => {
    write(join(bin, "codesign"), "#!/bin/sh\nexit 1\n", true)
    const run = install()
    assert.equal(run.status, 1)
    assert.match(readFileSync(installed(), "utf8"), /echo old/)
  })

  test("a port that's already taken stops it before anything changes", async () => {
    const other = createServer().listen(port, "127.0.0.1")
    await new Promise((resolve) => other.once("listening", resolve))
    try {
      const run = install()
      assert.equal(run.status, 1)
      assert.match(
        run.stderr,
        new RegExp(`Something else is listening on port ${port} \\(pid ${process.pid}\\)`),
      )
      assert.match(readFileSync(installed(), "utf8"), /echo old/)
      assert.ok(!existsSync(join(state, "calls")))
      assert.ok(!existsSync(agent()))
    } finally {
      await new Promise((resolve) => other.close(resolve))
    }
  })

  test("another server answering in its place isn't taken for its own", () => {
    const run = install({ TAKE_PORT: "1" })
    assert.equal(run.status, 1, run.stdout)
    assert.match(run.stderr, /Something else is listening on port/)
    assert.doesNotMatch(run.stdout, /its server runs on port/)
    assert.ok(
      !existsSync(agent()),
      "the login agent should be gone, so it doesn't retry at every login",
    )
    assert.ok(!existsSync(join(state, "job.pid")))
  })
})
