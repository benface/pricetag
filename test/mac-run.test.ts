import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, test } from "node:test"

const macos = join(import.meta.dirname, "../macos")

// The real script in a throwaway folder, with a stand-in for xcodebuild. Its first build prints and exits with what the test says, and any later one passes.
const fakeXcodebuild = `#!/bin/sh
echo "$*" >>"$FAKE_CALLS"
[ "$(wc -l <"$FAKE_CALLS")" -eq 1 ] || exit 0
printf '%s\\n' "$FAKE_OUTPUT"
exit "$FAKE_STATUS"
`

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mac-run-"))
  mkdirSync(join(root, "macos/Config"), { recursive: true })
  mkdirSync(join(root, "bin"))
  cpSync(join(macos, "run.sh"), join(root, "macos/run.sh"))
  cpSync(join(macos, "Config/App.xcconfig"), join(root, "macos/Config/App.xcconfig"))
  writeFileSync(join(root, "bin/xcodebuild"), fakeXcodebuild)
  chmodSync(join(root, "bin/xcodebuild"), 0o755)
  writeFileSync(join(root, "bin/security"), "#!/bin/sh\nexit 0\n")
  chmodSync(join(root, "bin/security"), 0o755)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function build(output: string, status: number) {
  const calls = join(root, "calls")
  const result = spawnSync("sh", [join(root, "macos/run.sh"), "--build-only"], {
    encoding: "utf8",
    env: { ...process.env, SWIFT_QUEUE_TURN: "1", PATH: `${join(root, "bin")}:${process.env.PATH}`, FAKE_CALLS: calls, FAKE_OUTPUT: output, FAKE_STATUS: String(status) },
  })
  return { status: result.status, output: result.stdout + result.stderr, builds: readFileSync(calls, "utf8").trim().split("\n") }
}

const project = "/Users/me/pricetag/macos/App.xcodeproj"

describe("the first build of pnpm mac", () => {
  test("signs for the team when it passes", () => {
    const { status, output, builds } = build("", 0)
    assert.equal(status, 0)
    assert.equal(builds.length, 1)
    assert.match(builds[0]!, /APP_TEAM=R7TNNTC382/)
    assert.match(output, /Signed for team R7TNNTC382/)
  })

  // The first three are word for word what Xcode 27 printed for a team that isn't signed in.
  for (const error of [
    `${project}: error: No signing certificate "Mac Development" found: No "Mac Development" signing certificate matching team ID "R7TNNTC382" with a private key was found. (in target 'BridgeHost' from project 'App')`,
    `${project}: error: No Account for Team "R7TNNTC382". Add a new account in Accounts settings or verify that your accounts have valid credentials. (in target 'App' from project 'App')`,
    `${project}: error: No profiles for 'com.benface.pricetag.macos.wallet' were found: Xcode couldn't find any Mac App Development provisioning profiles matching 'com.benface.pricetag.macos.wallet'. (in target 'App' from project 'App')`,
    "error: No Accounts: Add a new account in Accounts settings.",
    `${project}: error: Signing for "App" requires a development team. Select a development team in the Signing & Capabilities editor. (in target 'App' from project 'App')`,
    `${project}: error: Provisioning profile "Mac Team Provisioning Profile: *" doesn't include the currently selected device "Studio". (in target 'App' from project 'App')`,
    "error: Unable to log in with account 'me@example.com'. The login details for account 'me@example.com' were rejected.",
  ]) {
    test(`falls back to a build with no team on: ${error.replace(project, "App.xcodeproj").slice(0, 60)}`, () => {
      const { status, output, builds } = build(error, 65)
      assert.equal(status, 0)
      assert.equal(builds.length, 2)
      assert.doesNotMatch(builds[1]!, /APP_TEAM|allowProvisioningUpdates|HotWallet\.entitlements/)
      assert.ok(output.includes(error))
      assert.match(output, /Couldn't provision this build/)
    })
  }

  for (const [name, error, code] of [
    ["a compile error", "/Users/me/pricetag/macos/App/Wallet.swift:12:5: error: cannot find 'wallet' in scope", 65],
    ["a compile error that sounds like signing", "/Users/me/pricetag/macos/App/Wallet.swift:12:5: error: No profiles for 'wallet' in scope", 65],
    ["a compile error in a file under the project", `${project}/../App/Wallet.swift:12:5: error: No Account for Team`, 65],
    ["a failure to reach Apple", `${project}: error: Communication with Apple failed: The request timed out. (in target 'App' from project 'App')`, 65],
    ["a failure to reach Apple that also leaves no profile", `${project}: error: The request timed out. (in target 'App' from project 'App')\n${project}: error: No profiles for 'com.benface.pricetag.macos.wallet' were found: Xcode couldn't find any Mac App Development provisioning profiles matching 'com.benface.pricetag.macos.wallet'. (in target 'App' from project 'App')`, 65],
    ["a crash", "Abort trap: 6", 134],
    ["a killed build, which prints nothing", "", 143],
    ["a full disk", "error: unable to write file: No space left on device", 65],
  ] as const) {
    test(`stops with xcodebuild's own error and exit code on ${name}`, () => {
      const { status, output, builds } = build(error, code)
      assert.equal(status, code)
      assert.equal(builds.length, 1)
      assert.ok(output.includes(error))
      assert.doesNotMatch(output, /Couldn't provision|Built /)
    })
  }
})
