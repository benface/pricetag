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
    assert.equal(aero.costUsdMicros, "1000000000")
    assert.equal(usdc.proceedsUsdMicros, "1000000000")
  })

  it("a plain transfer in has a price but an unknown cost, because price and cost are separate", () => {
    const [leg] = legsOf([row("0x1", ETH_ADDRESS, "credit", E18)])
    assert.equal(leg!.kind, "transfer")
    assert.equal(leg!.priceUsdMicros, "2400000000")
    assert.equal(leg!.priceSource, "oracle")
    assert.equal(leg!.costLabel, "unknown")
    assert.equal(leg!.costUsdMicros, null)
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

  describe("a swap's cost and proceeds come from what changed hands", () => {
    const refAt = (block: number, ethUsd: string): ReferenceRow => ({ block_num: block, eth_usd: ethUsd, usdc_usd: "100000000" })
    const at = (rows: LegRow[], block: number) => rows.map((r) => ({ ...r, block_num: block }))
    // Buys 1 ETH for 2,500 USDC while the oracle says $2,400, then sells it for 2,500 USDC while the oracle says $2,600.
    const rows = [
      ...at([row("0x1", USDC_ADDRESS, "debit", 2500n * E6), row("0x1", ETH_ADDRESS, "credit", E18)], 100),
      ...at([row("0x2", ETH_ADDRESS, "debit", E18), row("0x2", USDC_ADDRESS, "credit", 2500n * E6)], 200),
    ]
    const references = [refAt(100, "240000000000"), refAt(200, "260000000000")]

    for (const method of ["average", "fifo"] as const) {
      it(`a round trip at one price realizes $0, whatever the oracle did (${method})`, () => {
        const legs = legsOf(rows, references)
        const eth = foldPositions(legs, method, {}).find((p) => p.asset === "ETH")!
        assert.equal(eth.values.realizedUsdMicros, "0")
        assert.equal(eth.values.qty, "0")
      })
    }

    it("keeps the oracle price as the shared fact, next to what was paid", () => {
      const bought = legsOf(rows, references).find((l) => l.txHash === "0x1" && l.asset === "ETH")!
      assert.equal(bought.priceUsdMicros, "2400000000")
      assert.equal(bought.priceSource, "oracle")
      assert.equal(bought.costUsdMicros, "2500000000")
    })

    it("both sides share one value, so a USDC holder with a known cost doesn't lose on the spread", () => {
      const legs = legsOf(rows, references)
      const sold = legs.find((l) => l.txHash === "0x1" && l.asset === "USDC")!
      assert.equal(sold.proceedsUsdMicros, "2500000000")
      const received = legs.find((l) => l.txHash === "0x2" && l.asset === "USDC")!
      assert.equal(received.costUsdMicros, "2500000000")
    })

    it("uses ETH's value when the other side has no oracle", () => {
      const legs = legsOf([row("0x1", AERO, "debit", 100n * E18), row("0x1", ETH_ADDRESS, "credit", E18 / 20n)])
      const aero = legs.find((l) => l.asset === "AERO")!
      assert.equal(aero.proceedsUsdMicros, "120000000")
      assert.equal(legs.find((l) => l.asset === "ETH")!.costUsdMicros, "120000000")
    })

    it("a swap far from the oracle has no value at all, so it can't make a phantom gain", () => {
      const legs = legsOf([row("0x1", USDC_ADDRESS, "debit", 1n), row("0x1", ETH_ADDRESS, "credit", E18)])
      const eth = legs.find((l) => l.asset === "ETH")!
      assert.equal(eth.costLabel, "unknown")
      assert.equal(eth.costUsdMicros, null)
      assert.equal(eth.priceUsdMicros, "2400000000")
      assert.match(eth.priceNote!, /Rejected/)
      assert.equal(legs.find((l) => l.asset === "USDC")!.proceedsUsdMicros, null)
    })

    describe("with one oracle unavailable, what was paid is still known", () => {
      const noEth: ReferenceRow = { block_num: 100, eth_usd: "", usdc_usd: "100000000" }
      const noUsdc: ReferenceRow = { block_num: 100, eth_usd: "240000000000", usdc_usd: "" }
      const eth = (legs: ReturnType<typeof legsOf>) => legs.find((l) => l.asset === "ETH")!
      const usdc = (legs: ReturnType<typeof legsOf>) => legs.find((l) => l.asset === "USDC")!

      it("buying ETH with USDC, with no ETH oracle: the cost is known, and the price stays unavailable", () => {
        const legs = legsOf([row("0x1", USDC_ADDRESS, "debit", 2500n * E6), row("0x1", ETH_ADDRESS, "credit", E18)], [noEth])
        assert.equal(eth(legs).priceUsdMicros, null)
        assert.equal(eth(legs).priceSource, null)
        assert.equal(eth(legs).costLabel, "paid")
        assert.equal(eth(legs).costUsdMicros, "2500000000")
        assert.equal(usdc(legs).proceedsUsdMicros, "2500000000")
      })

      it("selling ETH for USDC, with no ETH oracle: the proceeds are known, so the gain is too", () => {
        const legs = legsOf(
          [
            { ...row("0x1", USDC_ADDRESS, "debit", 2400n * E6), block_num: 50 },
            { ...row("0x1", ETH_ADDRESS, "credit", E18), block_num: 50 },
            row("0x2", ETH_ADDRESS, "debit", E18),
            row("0x2", USDC_ADDRESS, "credit", 2500n * E6),
          ],
          [{ block_num: 50, eth_usd: "240000000000", usdc_usd: "100000000" }, noEth],
        )
        const sale = legs.find((l) => l.txHash === "0x2" && l.asset === "ETH")!
        assert.equal(sale.priceUsdMicros, null)
        assert.equal(sale.proceedsUsdMicros, "2500000000")
        assert.equal(foldPositions(legs, "fifo", {}).find((p) => p.asset === "ETH")!.values.realizedUsdMicros, "100000000")
      })

      it("buying USDC with ETH, with no USDC oracle: ETH sets the value", () => {
        const legs = legsOf([row("0x1", ETH_ADDRESS, "debit", E18), row("0x1", USDC_ADDRESS, "credit", 2400n * E6)], [noUsdc])
        assert.equal(usdc(legs).priceUsdMicros, null)
        assert.equal(usdc(legs).costUsdMicros, "2400000000")
        assert.equal(eth(legs).proceedsUsdMicros, "2400000000")
      })

      it("selling USDC for ETH, with no USDC oracle: ETH still sets the value", () => {
        const legs = legsOf([row("0x1", USDC_ADDRESS, "debit", 2400n * E6), row("0x1", ETH_ADDRESS, "credit", E18)], [noUsdc])
        assert.equal(usdc(legs).proceedsUsdMicros, "2400000000")
        assert.equal(eth(legs).costUsdMicros, "2400000000")
      })

      it("an absurd swap is still rejected when the oracle that would catch it is down", () => {
        const dust = legsOf([row("0x1", USDC_ADDRESS, "debit", 1n), row("0x1", ETH_ADDRESS, "credit", E18)], [noEth])
        assert.equal(eth(dust).costLabel, "unknown")
        assert.equal(eth(dust).costUsdMicros, null)
        assert.equal(usdc(dust).proceedsUsdMicros, null)
        assert.match(eth(dust).priceNote!, /Rejected/)
        const reversed = legsOf([row("0x1", ETH_ADDRESS, "debit", E18), row("0x1", USDC_ADDRESS, "credit", 1n)], [noEth])
        assert.equal(eth(reversed).proceedsUsdMicros, null)
        const badUsdc = legsOf([row("0x1", ETH_ADDRESS, "debit", E18), row("0x1", USDC_ADDRESS, "credit", 1n)], [noUsdc])
        assert.equal(usdc(badUsdc).costUsdMicros, null)
      })

      it("with both oracles down, nothing can value it", () => {
        const legs = legsOf([row("0x1", USDC_ADDRESS, "debit", 2500n * E6), row("0x1", ETH_ADDRESS, "credit", E18)], [{ block_num: 100, eth_usd: "", usdc_usd: "" }])
        assert.equal(eth(legs).costUsdMicros, null)
        assert.equal(usdc(legs).proceedsUsdMicros, null)
      })
    })

    it("a token with no swap price still has a known cost, checked against its plausible range", () => {
      // Two AERO credits from a split route pair twice, so `priced_legs` has no row for them.
      const split = [row("0x1", USDC_ADDRESS, "debit", 1000n * E6), row("0x1", AERO, "credit", 300n * E18), row("0x1", AERO, "credit", 500n * E18)]
      const aero = legsOf(split).find((l) => l.asset === "AERO")!
      assert.equal(aero.priceUsdMicros, null)
      assert.equal(aero.costLabel, "paid")
      assert.equal(aero.costUsdMicros, "1000000000")
      const absurd = legsOf([row("0x1", USDC_ADDRESS, "debit", 1n), row("0x1", AERO, "credit", 300n * E18), row("0x1", AERO, "credit", 500n * E18)]).find((l) => l.asset === "AERO")!
      assert.equal(absurd.costLabel, "unknown")
      assert.match(absurd.priceNote!, /Rejected/)
    })

    it("real slippage isn't rejected", () => {
      const legs = legsOf([row("0x1", USDC_ADDRESS, "debit", 2800n * E6), row("0x1", ETH_ADDRESS, "credit", E18)])
      assert.equal(legs.find((l) => l.asset === "ETH")!.costUsdMicros, "2800000000")
    })
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

describe("an entirely unknown result stays unavailable", () => {
  const gasOnly = legsOf([row("0x1", ETH_ADDRESS, "debit", E18 / 1000n, "gas")], [{ block_num: 100, eth_usd: "", usdc_usd: "" }])
  const unknownHolding = legsOf([row("0x1", AERO, "credit", E18)])

  it("gas with no price and no cost: every total is null, not $0", () => {
    const totals = sumTotals(foldPositions(gasOnly, "average", {}))
    assert.equal(totals.pnlUsdMicros, null)
    assert.equal(totals.realizedUsdMicros, null)
    assert.equal(totals.gasUsdMicros, null)
    assert.equal(totals.unpricedGas, true)
    // It spent ETH we never saw arrive, so it holds units we can't see. That isn't a value of $0 either.
    assert.equal(totals.valueUsdMicros, null)
    assert.equal(totals.unrealizedUsdMicros, null)
    assert.ok(totals.excluded.some((e) => e.reason === "incomplete history"))
  })

  it("sending out more than we saw arrive, with no sale, has no PnL answer in the headline or the chart", () => {
    const legs = legsOf([row("0x1", AERO, "debit", E18)])
    assert.equal(sumTotals(foldPositions(legs, "fifo", {})).pnlUsdMicros, null)
    assert.equal(pnlOverTime(legs, "fifo", {}, [REF], null).at(-1)!.pnlUsdMicros, null)
  })

  it("a holding with no cost and no price: PnL, value and unrealized are null, and nothing sold is a real $0", () => {
    const totals = sumTotals(foldPositions(unknownHolding, "average", {}))
    assert.equal(totals.pnlUsdMicros, null)
    assert.equal(totals.valueUsdMicros, null)
    assert.equal(totals.unrealizedUsdMicros, null)
    assert.equal(totals.realizedUsdMicros, "0")
  })

  it("the chart agrees, at every point", () => {
    const points = pnlOverTime(unknownHolding, "average", {}, [REF], { blockNum: 101, timestamp: "2026-11-04T00:00:00.000Z" })
    assert.ok(points.length > 0)
    assert.ok(points.every((p) => p.pnlUsdMicros === null))
  })

  describe("a sale that's part known, part unknown", () => {
    // Buys 1 ETH for 2,400 USDC, receives another ETH at an unknown cost, then sells both.
    const mixed = (saleUsdc: bigint) => [
      { ...row("0x1", USDC_ADDRESS, "debit", 2400n * E6), block_num: 100 },
      { ...row("0x1", ETH_ADDRESS, "credit", E18), block_num: 100 },
      { ...row("0x2", ETH_ADDRESS, "credit", E18), block_num: 101 },
      { ...row("0x3", ETH_ADDRESS, "debit", 2n * E18), block_num: 102 },
      { ...row("0x3", USDC_ADDRESS, "credit", saleUsdc * E6), block_num: 102 },
    ]
    const references = [100, 101, 102].map((block) => ({ ...REF, block_num: block }))
    const ethOnly = (rows: LegRow[]) => legsOf(rows, references).filter((l) => l.asset === "ETH")

    for (const method of ["average", "fifo"] as const) {
      for (const [name, sale, knownPart] of [["a profit", 5000n, 100_000_000n], ["a loss", 4000n, -400_000_000n]] as const) {
        it(`${name} stays out of every total, and never reads as $0 (${method})`, () => {
          const legs = ethOnly(mixed(sale))
          const positions = foldPositions(legs, method, {})
          const eth = positions.find((p) => p.asset === "ETH")!
          // The fold keeps the known part, and the position says it isn't the whole answer.
          assert.equal(BigInt(eth.state.realizedUsdMicros), knownPart)
          assert.equal(eth.values.realizedUsdMicros, null)
          const totals = sumTotals(positions)
          assert.equal(totals.realizedUsdMicros, null)
          assert.equal(totals.pnlUsdMicros, null)
          assert.deepEqual(totals.coverage.realized, { known: 0, missing: 1 })
          assert.ok(totals.excluded.some((e) => e.asset === "ETH" && e.reason === "sold at an unknown cost"))
          assert.equal(pnlOverTime(legs, method, {}, references, null).at(-1)!.pnlUsdMicros, null)
        })

        it(`${name} doesn't hide another position's known result (${method})`, () => {
          const aeroTrade = [
            { ...row("0x4", USDC_ADDRESS, "debit", 1000n * E6), block_num: 100 },
            { ...row("0x4", AERO, "credit", 800n * E18), block_num: 100 },
            { ...row("0x5", AERO, "debit", 800n * E18), block_num: 101 },
            { ...row("0x5", USDC_ADDRESS, "credit", 1200n * E6), block_num: 101 },
          ]
          const legs = legsOf([...mixed(sale), ...aeroTrade], references).filter((l) => l.asset !== "USDC")
          const totals = sumTotals(foldPositions(legs, method, {}))
          assert.equal(totals.realizedUsdMicros, "200000000")
          assert.deepEqual(totals.coverage.realized, { known: 1, missing: 1 })
          assert.equal(totals.pnlUsdMicros, "200000000")
          assert.equal(pnlOverTime(legs, method, {}, references, null).at(-1)!.pnlUsdMicros, "200000000")
        })
      }
    }

    it("known gas alongside it is still a real answer, and says what it leaves out", () => {
      const legs = [...ethOnly(mixed(5000n)), ...legsOf([row("0x9", ETH_ADDRESS, "debit", E18 / 1000n, "gas")])]
      const totals = sumTotals(foldPositions(legs, "fifo", {}))
      assert.equal(totals.realizedUsdMicros, null)
      assert.equal(totals.pnlUsdMicros, "-2400000")
      assert.ok(totals.excluded.length > 0)
    })
  })

  it("a genuine $0 stays $0: bought and sold at the same value", () => {
    const flat = [
      row("0x1", USDC_ADDRESS, "debit", 2400n * E6),
      row("0x1", ETH_ADDRESS, "credit", E18),
      row("0x2", ETH_ADDRESS, "debit", E18),
      row("0x2", USDC_ADDRESS, "credit", 2400n * E6),
    ]
    const positions = foldPositions(legsOf(flat), "fifo", {}).filter((p) => p.asset === "ETH")
    const totals = sumTotals(positions)
    assert.equal(totals.pnlUsdMicros, "0")
    assert.equal(totals.realizedUsdMicros, "0")
    assert.equal(pnlOverTime(legsOf(flat).filter((l) => l.asset === "ETH"), "fifo", {}, [REF], null).at(-1)!.pnlUsdMicros, "0")
  })

  it("known gas alone is an answer: it's a real, negative PnL", () => {
    const paidGas = legsOf([row("0x1", ETH_ADDRESS, "debit", E18 / 1000n, "gas")])
    const totals = sumTotals(foldPositions(paidGas, "average", {}))
    assert.equal(totals.pnlUsdMicros, "-2400000")
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
    assert.equal(totals.unrealizedUsdMicros, known.length === 0 ? null : known.reduce((sum, p) => sum + BigInt(p.values.unrealizedUsdMicros!), 0n).toString())
  })

  it("add up: PnL is realized plus unrealized, less gas", () => {
    assert.equal(BigInt(totals.pnlUsdMicros!), BigInt(totals.realizedUsdMicros ?? 0) + BigInt(totals.unrealizedUsdMicros ?? 0) - BigInt(totals.gasUsdMicros ?? 0))
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
