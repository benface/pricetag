import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import type { Tables, Through } from "./support/fake-amp.ts"

const ME = "00000000000000000000000000000000000000aa"
const AERO = "940181a94a35a4569e4529a3cdfb74e38fd98631"
const USDC = "833589fcd6edb6e08f4c7c32d4f71b54bda02913"
const ETH = "0000000000000000000000000000000000000000"
const reference = { block_num: "100", eth_usd: "240000000000", usdc_usd: "100000000" }

const leg = (token: string, side: string, amount: string, kind: string) => ({ block_num: "100", timestamp: 1_800_000_000_000, tx_hash: "aa", tx_index: 3, log_index: 0, token, account: ME, side, amount, kind })

/** Runs the real example, with only its Amp client replaced. */
function runExample(tables: Tables, through?: Through, example = "portfolio.ts", args: string[] = []) {
  const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))
  const { status, stdout, stderr } = spawnSync(process.execPath, ["--import", path("./support/example-hooks.ts"), path(`../packages/sdk/examples/${example}`), `0x${ME}`, ...args], {
    encoding: "utf8",
    env: { ...process.env, PRICETAG_START_BLOCK: "100", FAKE_AMP: JSON.stringify({ tables, through }) },
  })
  assert.equal(stderr.replace(/^\(node:\d+\).*\n|^\(Use `node.*\n/gm, ""), "")
  return { status, stdout }
}

describe("the example", () => {
  it("prints no totals when nothing in the range has been processed", () => {
    const { status, stdout } = runExample({}, null)
    assert.equal(status, 1)
    assert.match(stdout, /hasn't processed block 100/)
    assert.doesNotMatch(stdout, /\$|PnL/)
  })

  it("says the total is partial when gas couldn't be worked out, even with no legs", () => {
    const { stdout } = runExample({ legs: [leg(ETH, "debit", "", "gas")], reference_prices: [reference], balances: { 99: {}, 200: {} } })
    assert.match(stdout, /PnL: \$0\.00 \(partial\)/)
    assert.match(stdout, /leaving out: gas that couldn't be worked out, in 1 tx, so ETH is overstated/)
  })

  it("says so when gas had no price at its block", () => {
    const { stdout } = runExample({ legs: [leg(ETH, "credit", "5", "eth"), leg(ETH, "debit", "1", "gas")], reference_prices: [{ ...reference, eth_usd: "" }], balances: { 99: {}, 200: { ETH: "4" } } })
    assert.match(stdout, /PnL: unknown \(unavailable\), gas unknown, leaving out: .*gas with no price/)
  })

  it("says so when L1 fees are missing, and doesn't call ETH checked", () => {
    const { stdout } = runExample({ legs: [leg(ETH, "credit", "5", "eth"), leg(ETH, "debit", "1", "gas")], reference_prices: [reference], balances: { 99: {}, 200: { ETH: "4" } } })
    assert.match(stdout, /ETH: .*unchecked/)
    assert.match(stdout, /leaving out: .*the L1 fees of 1 tx/)
  })

  it("starts from what the wallet already held, and checks it against the chain", () => {
    const { stdout } = runExample({ legs: [leg(USDC, "credit", "1000000", "erc20")], reference_prices: [reference, { ...reference, block_num: "199" }], balances: { 99: { USDC: "5000000" }, 200: { USDC: "6000000" } } })
    assert.match(stdout, /USDC: 6 \| cost unknown \| value \$6\.00 \(oracle\) .*\| reconciled/)
    assert.match(stdout, /Latest: USDC in 0xaa/)
  })

  it("doesn't call a balance that couldn't be read zero", () => {
    const { stdout } = runExample({ legs: [leg(USDC, "credit", "1000000", "erc20")], reference_prices: [reference] })
    assert.match(stdout, /USDC: 1 .*\| unchecked/)
    assert.match(stdout, /leaving out: .*USDC \(not checked against its actual balance/)
    assert.match(stdout, /leaving out: .*ETH \(balance couldn't be read\)/)
  })

  it("prints a wallet's positions with what's left out, and its latest transaction's price and cost", () => {
    const { stdout } = runExample({
      legs: [leg(USDC, "debit", "1000000000", "erc20"), leg(AERO, "credit", "500000000000000000000", "erc20")],
      priced_legs: [{ block_num: "100", tx_hash: "aa", account: ME, sold_token: USDC, sold_amount: "1000000000", bought_token: AERO, bought_amount: "500000000000000000000", priced: { source: "swap", token: "AERO", usd_micros: "2000000" } }],
      reference_prices: [reference],
      balances: { 99: { USDC: "1000000000" }, 200: { AERO: "500000000000000000000" } },
    })
    assert.match(stdout, /AERO: 500 \| cost \$1,000\.00 \| value unknown \(no price\)/)
    assert.match(stdout, /leaving out: .*AERO/)
    assert.match(stdout, /Latest: AERO in 0xaa, price \$2\.00 \(swap\), cost paid/)
  })

  it("watches a wallet, and stops after as many updates as it's asked for", () => {
    const { status, stdout } = runExample({ legs: [leg(USDC, "credit", "1000000", "erc20")], reference_prices: [reference, { ...reference, block_num: "199" }], balances: { 99: { USDC: "5000000" }, 200: { USDC: "6000000" } } }, undefined, "watch.ts", ["1"])
    assert.equal(status, 0)
    assert.match(stdout, /^To block 200: 2 legs, value \$6\.00, PnL unknown \(unavailable\), leaving out: \d+ things?\n$/)
  })
})
