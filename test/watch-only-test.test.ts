import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"

const script = join(import.meta.dirname, "../macos/watch-only-test.sh")
const bundleId = /^APP_BUNDLE_ID = (.+)$/m.exec(readFileSync(join(import.meta.dirname, "../macos/Config/WatchOnly.xcconfig"), "utf8"))![1]!

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "watch-only-test-"))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

// The real script with a .dmg that won't open, so it stops at once and cleans up, under a HOME that's only for this test.
test("stopping early leaves an installed copy's saved data alone, and only clears its own test folders", () => {
  const containers = join(root, "home/Library/Containers")
  const saved = join(containers, bundleId, "Data/saved")
  const testFolder = join(containers, `${bundleId}.check`)
  mkdirSync(join(containers, bundleId, "Data"), { recursive: true })
  mkdirSync(testFolder, { recursive: true })
  writeFileSync(saved, "wallets and an invite")
  const bin = join(root, "bin")
  mkdirSync(bin)
  writeFileSync(join(bin, "hdiutil"), "#!/bin/sh\nexit 1\n")
  chmodSync(join(bin, "hdiutil"), 0o755)

  const { status } = spawnSync("sh", [script, join(root, "missing.dmg")], { encoding: "utf8", env: { ...process.env, HOME: join(root, "home"), PATH: `${bin}:${process.env.PATH}`, TMPDIR: root } })

  assert.notEqual(status, 0)
  assert.equal(readFileSync(saved, "utf8"), "wallets and an invite")
  assert.equal(existsSync(testFolder), false)
})
