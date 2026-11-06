import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"

const PRICETAG_RESOURCES = new URL("../../macos/PricetagKit/Tests/PricetagKitTests/Resources/", import.meta.url)

/**
 * The Swift package's tests read these, so a change to what the server sends or prints fails on both sides. Only `pnpm check:mac`
 * runs those tests, so regenerating one goes green here even when Swift is now wrong. Both messages say so.
 */
export function assertMatchesFixture(name: string, actual: unknown, resources: URL = PRICETAG_RESOURCES) {
  const url = new URL(name, resources)
  const text = `${JSON.stringify(actual, null, 2)}\n`
  if (process.env.UPDATE_FIXTURES) {
    if (readFileSync(url, { encoding: "utf8", flag: "a+" }) !== text) console.warn(`${name} changed. Run \`pnpm check:mac\`, since only Swift's tests say whether Swift still reads it.`)
    writeFileSync(url, text)
  }
  assert.equal(readFileSync(url, "utf8"), text, `${name} is out of date. Run with UPDATE_FIXTURES=1 if the change is on purpose, and run \`pnpm check:mac\`.`)
}
