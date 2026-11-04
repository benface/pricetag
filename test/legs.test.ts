import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildPricedLegs, derivePricedRows, isSanePrice, ptPrice, type LegRow, type ReferenceRow } from "../src/core/legs.ts"
import { foldPositions, pnlOverTime, sumTotals } from "../src/core/portfolio.ts"
import { DEMO_ADDRESS, DEMO_REFERENCES, DEMO_ROWS, DEMO_WALLET } from "../src/core/fixtures.ts"
import { ETH_ADDRESS, TOKENS, USDC_ADDRESS, WETH_ADDRESS, tokenByAddress } from "../src/core/tokens.ts"

const ME = "0x00000000000000000000000000000000000000aa"
const AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631"
const E18 = 10n ** 18n
const E6 = 10n ** 6n

function row(tx: string, token: string, side: LegRow["side"], amount: bigint, kind: LegRow["kind"] = token === ETH_ADDRESS ? "eth" : "erc20"): LegRow {
  return { block_num: 100, timestamp: "2026-11-04T00:00:00.000Z", tx_hash: tx, tx_index: 1, log_index: 0, token, account: ME, side, amount: amount.toString(), kind }
}
const REF: ReferenceRow = { block_num: 100, eth_usd: "240000000000", usdc_usd: "100000000" }

function legsOf(rows: LegRow[], references: ReferenceRow[] = [REF]) {
  return buildPricedLegs({ account: ME, rows, references, priced: derivePricedRows(rows, references) })
}

describe("pricing a wallet's rows", () => {
  it("a swap uses the oracle for ETH and USDC, and the implied price for the other token", () => {
    const legs = legsOf([row("0x1", USDC_ADDRESS, "debit", 1000n * E6), row("0x1", AERO, "credit", 800n * E18)])
    const usdc = legs.find((l) => l.asset === "USDC")!
    const aero = legs.find((l) => l.asset === "AERO")!
    assert.equal(usdc.priceSource, "oracle")
    assert.equal(usdc.priceUsdMicros, "1000000")
    assert.equal(usdc.kind, "swap")
    assert.equal(aero.priceSource, "swap")
    assert.equal(aero.priceUsdMicros, "1250000")
    assert.equal(aero.costLabel, "paid")
    assert.equal(aero.unitCostUsdMicros, "1250000")
  })

  it("a plain transfer in has a price but an unknown cost, because price and cost are separate", () => {
    const [leg] = legsOf([row("0x1", ETH_ADDRESS, "credit", E18)])
    assert.equal(leg!.kind, "transfer")
    assert.equal(leg!.priceUsdMicros, "2400000000")
    assert.equal(leg!.priceSource, "oracle")
    assert.equal(leg!.costLabel, "unknown")
    assert.equal(leg!.unitCostUsdMicros, null)
  })

  it("a token with no oracle and no swap has no price, and says why", () => {
    const [leg] = legsOf([row("0x1", AERO, "credit", E18)])
    assert.equal(leg!.priceUsdMicros, null)
    assert.equal(leg!.priceSource, null)
    assert.match(leg!.priceNote!, /No swap/)
  })

  it("rejects an absurd swap price, so it can't reach a total", () => {
    const legs = legsOf([row("0x1", USDC_ADDRESS, "debit", 1n), row("0x1", AERO, "credit", 50_000n * E18)])
    const aero = legs.find((l) => l.asset === "AERO")!
    assert.equal(aero.priceUsdMicros, null)
    assert.equal(aero.costLabel, "unknown")
    assert.match(aero.priceNote!, /Rejected/)
  })

  it("checks a token's sanity range against the ETH price where it's set that way", () => {
    const cbEth = tokenByAddress("0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22")!
    assert.equal(isSanePrice(cbEth, "2600000000", "2400000000"), true)
    assert.equal(isSanePrice(cbEth, "26000000", "2400000000"), false)
    assert.equal(isSanePrice(cbEth, "2600000000", null), false)
  })

  it("a failed oracle read leaves no price, never $0", () => {
    const [leg] = legsOf([row("0x1", ETH_ADDRESS, "credit", E18)], [{ block_num: 100, eth_usd: "", usdc_usd: "" }])
    assert.equal(leg!.priceUsdMicros, null)
    assert.match(leg!.priceNote!, /oracle/)
  })

  it("a transaction moving three tokens isn't treated as a swap", () => {
    const legs = legsOf([row("0x1", USDC_ADDRESS, "debit", 5n * E6), row("0x1", AERO, "credit", E18), row("0x1", ETH_ADDRESS, "credit", E18)])
    assert.ok(legs.every((l) => l.kind === "transfer" && l.costLabel === "unknown"))
  })

  it("wrapping nets to nothing, so its cost survives and nothing is realized", () => {
    const legs = legsOf([
      row("0x1", USDC_ADDRESS, "debit", 2400n * E6),
      row("0x1", ETH_ADDRESS, "credit", E18),
      row("0x2", ETH_ADDRESS, "debit", E18),
      row("0x2", WETH_ADDRESS, "credit", E18, "wrap"),
    ])
    assert.equal(legs.filter((l) => l.txHash === "0x2").length, 0)
    const eth = foldPositions(legs, "fifo", { ETH: { usdMicros: "3000000000", source: "oracle", blockNum: 100 } }).find((p) => p.asset === "ETH")!
    assert.equal(eth.values.qty, E18.toString())
    assert.equal(eth.values.costUsdMicros, "2400000000")
    assert.equal(eth.values.unrealizedUsdMicros, "600000000")
  })

  it("gas is its own leg, before the rest of its transaction, even in a swap", () => {
    const legs = legsOf([row("0x1", USDC_ADDRESS, "debit", 2400n * E6), row("0x1", WETH_ADDRESS, "credit", E18), row("0x1", ETH_ADDRESS, "debit", 5n, "gas")])
    assert.deepEqual(legs.map((l) => `${l.asset}:${l.kind}`), ["ETH:gas", "USDC:swap", "ETH:swap"])
  })

  it("ignores rows of other accounts", () => {
    assert.equal(legsOf([{ ...row("0x1", USDC_ADDRESS, "credit", 5n), account: "0xbb" }]).length, 0)
  })

  it("every allowlisted token nets into a token named after its asset", () => {
    for (const token of TOKENS) assert.ok(TOKENS.some((t) => t.symbol === token.asset))
  })
})

describe("totals", () => {
  const prices = DEMO_WALLET.prices
  const positions = foldPositions(DEMO_WALLET.legs, "average", prices)
  const totals = sumTotals(positions)

  it("say what they leave out, and never count unknown as $0", () => {
    const reasons = (asset: string) => totals.excluded.filter((e) => e.asset === asset).map((e) => e.reason)
    assert.deepEqual(reasons("cbBTC"), ["no current price", "unknown cost"])
    assert.ok(reasons("ETH").includes("unknown cost"))
    assert.ok(totals.coverage.unrealized.missing > 0)
    const known = positions.filter((p) => p.values.unrealizedUsdMicros !== null)
    assert.equal(totals.unrealizedUsdMicros, known.reduce((sum, p) => sum + BigInt(p.values.unrealizedUsdMicros!), 0n).toString())
  })

  it("add up: PnL is realized plus unrealized, less gas", () => {
    assert.equal(BigInt(totals.pnlUsdMicros), BigInt(totals.realizedUsdMicros) + BigInt(totals.unrealizedUsdMicros) - BigInt(totals.gasUsdMicros))
  })

  it("the chart's last point matches the headline, for both methods", () => {
    for (const method of ["average", "fifo"] as const) {
      const headline = sumTotals(foldPositions(DEMO_WALLET.legs, method, prices))
      const points = pnlOverTime(DEMO_WALLET.legs, method, prices, DEMO_WALLET.references, DEMO_WALLET.latest)
      assert.equal(points.at(-1)!.pnlUsdMicros, headline.pnlUsdMicros)
      assert.equal(points.at(-1)!.txHash, null)
    }
  })

  it("the demo wallet shows the hand-worked numbers", () => {
    const aero = positions.find((p) => p.asset === "AERO")!
    // Bought 800 for 1,000 USDC at $0.9998: $1.24975 each. Sold 300 for 450 USDC: $1.4997 each.
    assert.equal(aero.values.averageCostUsdMicros, "1249750")
    assert.equal(aero.values.realizedUsdMicros, "74985000")
    assert.equal(aero.values.qty, (500n * E18).toString())
    assert.equal(aero.values.unrealizedUsdMicros, null)
    assert.equal(aero.values.valueUsdMicros, null)
  })

  it("the demo wallet's rows are still that wallet's", () => {
    assert.ok(DEMO_ROWS.every((r) => r.account === DEMO_ADDRESS))
    assert.ok(DEMO_REFERENCES.length > 0)
  })
})
