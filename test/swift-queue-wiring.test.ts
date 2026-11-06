import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const read = (file: string) => readFileSync(file, "utf8")

test("what agents run to compile Swift goes through the queue, and pnpm mac doesn't", () => {
  assert.equal(JSON.parse(read("package.json")).scripts["check:mac"], "macos/check-mac.sh")
  assert.match(read("macos/check-mac.sh"), /exec "\$here\/swift-queue.sh"/)
  assert.match(read("macos/shot.sh"), /swift-queue\.sh" xcodebuild/)
  assert.match(read("macos/anvil-test.sh"), /swift-queue\.sh" swift test/)
  assert.match(read("macos/run.sh"), /"--build-only" \] && .*exec "\$here\/swift-queue\.sh"/)
})

test("check:mac runs the queue's own tests, which are out of pnpm test because they're slow", () => {
  const { scripts } = JSON.parse(read("package.json"))
  assert.match(scripts["check:swift-queue"], /macos\/swift-queue\.test\.ts/)
  assert.doesNotMatch(scripts["check:swift-queue"], /--test/)
  const check = read("macos/check-mac.sh")
  assert.ok(check.indexOf("check:swift-queue") < check.indexOf('exec "$here/swift-queue.sh"'))
})
