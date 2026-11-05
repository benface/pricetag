import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { ETH_ADDRESS, TOKENS, USDC_ADDRESS, WETH_ADDRESS, buildPricedLegs, derivePricedRows, foldPositions, isSanePrice, pnlOverTime, referenceMarks, ptPrice, sumTotals, tokenByAddress, usdView, type LegRow, type Reference } from "@pricetag/sdk/core"
import { DEMO_ADDRESS, DEMO_REFERENCES, DEMO_ROWS, DEMO_WALLET } from "../src/core/fixtures.ts"

const ME = "0x00000000000000000000000000000000000000aa"
const AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631"
const E18 = 10n ** 18n
const E6 = 10n ** 6n

function row(tx: string, token: string, side: LegRow["side"], amount: bigint, kind: LegRow["kind"] = token === ETH_ADDRESS ? "eth" : "erc20"): LegRow {
  return { block_num: 100, timestamp: "2026-11-04T00:00:00.000Z", tx_hash: tx, tx_index: 1, log_index: 0, token, account: ME, side, amount: amount.toString(), kind }
}
const REF: Reference = { blockNum: 100, ethUsd: "240000000000", usdcUsd: "100000000" }

function legsOf(rows: LegRow[], references: Reference[] = [REF]) {
  return buildPricedLegs({ account: ME, rows, references, priced: derivePricedRows(rows, references) })
}

const marks = (references: Reference[]) => referenceMarks(references)

describe("pricing a wallet's rows", () => {
  it("a swap uses the oracle for ETH and USDC, and the implied price for the other token", () => {
    const legs = legsOf([row("0x1", USDC_ADDRESS, "debit", 1000n * E6), row("0x1", AERO, "credit", 800n * E18)])
    const usdc = legs.find((l) => l.asset === "USDC")!
    const aero = legs.find((l) => l.asset === "AERO")!
    assert.equal(usdc.priceSource, "oracle")
    assert.equal(usdc.priceMicros, "1000000")
    assert.equal(usdc.kind, "swap")
    assert.equal(aero.priceSource, "swap")
    assert.equal(aero.priceMicros, "1250000")
    assert.equal(aero.costLabel, "paid")
    assert.equal(aero.costMicros, "1000000000")
    assert.equal(usdc.proceedsMicros, "1000000000")
  })

  it("a plain transfer in has a price but an unknown cost, because price and cost are separate", () => {
    const [leg] = legsOf([row("0x1", ETH_ADDRESS, "credit", E18)])
    assert.equal(leg!.kind, "transfer")
    assert.equal(leg!.priceMicros, "2400000000")
    assert.equal(leg!.priceSource, "oracle")
    assert.equal(leg!.costLabel, "unknown")
    assert.equal(leg!.costMicros, null)
  })

  it("a token with no oracle and no swap has no price, and says why", () => {
    const [leg] = legsOf([row("0x1", AERO, "credit", E18)])
    assert.equal(leg!.priceMicros, null)
    assert.equal(leg!.priceSource, null)
    assert.match(leg!.priceNote!, /Nothing was exchanged/)
  })

  it("rejects an absurd swap price, so it can't reach a total", () => {
    const legs = legsOf([row("0x1", USDC_ADDRESS, "debit", 1n), row("0x1", AERO, "credit", 50_000n * E18)])
    const aero = legs.find((l) => l.asset === "AERO")!
    assert.equal(aero.priceMicros, null)
    assert.equal(aero.costLabel, "unknown")
    assert.match(aero.priceNote!, /Ignored the price/)
  })

  it("checks a token's sanity range against the ETH price where it's set that way", () => {
    const cbEth = tokenByAddress("0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22")!
    assert.equal(isSanePrice(cbEth, "2600000000", "2400000000"), true)
    assert.equal(isSanePrice(cbEth, "26000000", "2400000000"), false)
    assert.equal(isSanePrice(cbEth, "2600000000", null), false)
  })

  it("a failed oracle read leaves no price, never $0", () => {
    const [leg] = legsOf([row("0x1", ETH_ADDRESS, "credit", E18)], [{ blockNum: 100, ethUsd: "", usdcUsd: "" }])
    assert.equal(leg!.priceMicros, null)
    assert.match(leg!.priceNote!, /market price feed/)
  })

  describe("a swap's cost and proceeds come from what changed hands", () => {
    const refAt = (block: number, ethUsd: string): Reference => ({ blockNum: block, ethUsd: ethUsd, usdcUsd: "100000000" })
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
        assert.equal(eth.values.realizedMicros, "0")
        assert.equal(eth.values.qty, "0")
      })
    }

    it("keeps the oracle price as the shared fact, next to what was paid", () => {
      const bought = legsOf(rows, references).find((l) => l.txHash === "0x1" && l.asset === "ETH")!
      assert.equal(bought.priceMicros, "2400000000")
      assert.equal(bought.priceSource, "oracle")
      assert.equal(bought.costMicros, "2500000000")
    })

    it("both sides share one value, so a USDC holder with a known cost doesn't lose on the spread", () => {
      const legs = legsOf(rows, references)
      const sold = legs.find((l) => l.txHash === "0x1" && l.asset === "USDC")!
      assert.equal(sold.proceedsMicros, "2500000000")
      const received = legs.find((l) => l.txHash === "0x2" && l.asset === "USDC")!
      assert.equal(received.costMicros, "2500000000")
    })

    it("uses ETH's value when the other side has no oracle", () => {
      const legs = legsOf([row("0x1", AERO, "debit", 100n * E18), row("0x1", ETH_ADDRESS, "credit", E18 / 20n)])
      const aero = legs.find((l) => l.asset === "AERO")!
      assert.equal(aero.proceedsMicros, "120000000")
      assert.equal(legs.find((l) => l.asset === "ETH")!.costMicros, "120000000")
    })

    it("a swap far from the oracle has no value at all, so it can't make a phantom gain", () => {
      const legs = legsOf([row("0x1", USDC_ADDRESS, "debit", 1n), row("0x1", ETH_ADDRESS, "credit", E18)])
      const eth = legs.find((l) => l.asset === "ETH")!
      assert.equal(eth.costLabel, "unknown")
      assert.equal(eth.costMicros, null)
      assert.equal(eth.priceMicros, "2400000000")
      assert.match(eth.priceNote!, /Ignored the price/)
      assert.equal(legs.find((l) => l.asset === "USDC")!.proceedsMicros, null)
    })

    describe("with one oracle unavailable, what was paid is still known", () => {
      const noEth: Reference = { blockNum: 100, ethUsd: "", usdcUsd: "100000000" }
      const noUsdc: Reference = { blockNum: 100, ethUsd: "240000000000", usdcUsd: "" }
      const eth = (legs: ReturnType<typeof legsOf>) => legs.find((l) => l.asset === "ETH")!
      const usdc = (legs: ReturnType<typeof legsOf>) => legs.find((l) => l.asset === "USDC")!

      it("buying ETH with USDC, with no ETH oracle: the cost is known, and the price stays unavailable", () => {
        const legs = legsOf([row("0x1", USDC_ADDRESS, "debit", 2500n * E6), row("0x1", ETH_ADDRESS, "credit", E18)], [noEth])
        assert.equal(eth(legs).priceMicros, null)
        assert.equal(eth(legs).priceSource, null)
        assert.equal(eth(legs).costLabel, "paid")
        assert.equal(eth(legs).costMicros, "2500000000")
        assert.equal(usdc(legs).proceedsMicros, "2500000000")
      })

      it("selling ETH for USDC, with no ETH oracle: the proceeds are known, so the gain is too", () => {
        const legs = legsOf(
          [
            { ...row("0x1", USDC_ADDRESS, "debit", 2400n * E6), block_num: 50 },
            { ...row("0x1", ETH_ADDRESS, "credit", E18), block_num: 50 },
            row("0x2", ETH_ADDRESS, "debit", E18),
            row("0x2", USDC_ADDRESS, "credit", 2500n * E6),
          ],
          [{ blockNum: 50, ethUsd: "240000000000", usdcUsd: "100000000" }, noEth],
        )
        const sale = legs.find((l) => l.txHash === "0x2" && l.asset === "ETH")!
        assert.equal(sale.priceMicros, null)
        assert.equal(sale.proceedsMicros, "2500000000")
        assert.equal(foldPositions(legs, "fifo", {}).find((p) => p.asset === "ETH")!.values.realizedMicros, "100000000")
      })

      it("buying USDC with ETH, with no USDC oracle: ETH sets the value", () => {
        const legs = legsOf([row("0x1", ETH_ADDRESS, "debit", E18), row("0x1", USDC_ADDRESS, "credit", 2400n * E6)], [noUsdc])
        assert.equal(usdc(legs).priceMicros, null)
        assert.equal(usdc(legs).costMicros, "2400000000")
        assert.equal(eth(legs).proceedsMicros, "2400000000")
      })

      it("selling USDC for ETH, with no USDC oracle: ETH still sets the value", () => {
        const legs = legsOf([row("0x1", USDC_ADDRESS, "debit", 2400n * E6), row("0x1", ETH_ADDRESS, "credit", E18)], [noUsdc])
        assert.equal(usdc(legs).proceedsMicros, "2400000000")
        assert.equal(eth(legs).costMicros, "2400000000")
      })

      it("an absurd swap is still rejected when the oracle that would catch it is down", () => {
        const dust = legsOf([row("0x1", USDC_ADDRESS, "debit", 1n), row("0x1", ETH_ADDRESS, "credit", E18)], [noEth])
        assert.equal(eth(dust).costLabel, "unknown")
        assert.equal(eth(dust).costMicros, null)
        assert.equal(usdc(dust).proceedsMicros, null)
        assert.match(eth(dust).priceNote!, /Ignored the price/)
        const reversed = legsOf([row("0x1", ETH_ADDRESS, "debit", E18), row("0x1", USDC_ADDRESS, "credit", 1n)], [noEth])
        assert.equal(eth(reversed).proceedsMicros, null)
        const badUsdc = legsOf([row("0x1", ETH_ADDRESS, "debit", E18), row("0x1", USDC_ADDRESS, "credit", 1n)], [noUsdc])
        assert.equal(usdc(badUsdc).costMicros, null)
      })

      it("with both oracles down, nothing can value it", () => {
        const legs = legsOf([row("0x1", USDC_ADDRESS, "debit", 2500n * E6), row("0x1", ETH_ADDRESS, "credit", E18)], [{ blockNum: 100, ethUsd: "", usdcUsd: "" }])
        assert.equal(eth(legs).costMicros, null)
        assert.equal(usdc(legs).proceedsMicros, null)
      })
    })

    it("a token with no swap price still has a known cost, checked against its plausible range", () => {
      const legs = [row("0x1", USDC_ADDRESS, "debit", 1000n * E6), row("0x1", AERO, "credit", 800n * E18)]
      const aero = buildPricedLegs({ account: ME, rows: legs, references: [REF], priced: [] }).find((l) => l.asset === "AERO")!
      assert.equal(aero.priceMicros, null)
      assert.equal(aero.costLabel, "paid")
      assert.equal(aero.costMicros, "1000000000")
      const absurd = legsOf([row("0x1", USDC_ADDRESS, "debit", 1n), row("0x1", AERO, "credit", 300n * E18), row("0x1", AERO, "credit", 500n * E18)]).find((l) => l.asset === "AERO")!
      assert.equal(absurd.costLabel, "unknown")
      assert.match(absurd.priceNote!, /Ignored the price/)
    })

    it("a split route gets the price of what it netted to", () => {
      const single = legsOf([row("0x1", USDC_ADDRESS, "debit", 1000n * E6), row("0x1", AERO, "credit", 800n * E18)]).find((l) => l.asset === "AERO")!
      const split = legsOf([
        row("0x1", USDC_ADDRESS, "debit", 400n * E6),
        row("0x1", USDC_ADDRESS, "debit", 600n * E6),
        row("0x1", AERO, "credit", 300n * E18),
        row("0x1", AERO, "credit", 500n * E18),
      ]).find((l) => l.asset === "AERO")!
      assert.equal(split.priceSource, "swap")
      assert.equal(split.priceMicros, single.priceMicros)
      assert.equal(split.costMicros, "1000000000")
    })

    it("what came back of the same token reduces the amount, as a refund does", () => {
      const [priced] = derivePricedRows([row("0x1", USDC_ADDRESS, "debit", 1200n * E6), row("0x1", USDC_ADDRESS, "credit", 200n * E6), row("0x1", AERO, "credit", 800n * E18)], [REF])
      assert.equal(priced!.sold_amount, (1000n * E6).toString())
      assert.equal(priced!.bought_amount, (800n * E18).toString())
    })

    it("what mostly cancels out is what a router kept, so it's a pair with no price", () => {
      const rows = [row("0x1", USDC_ADDRESS, "debit", 1000n * E6), row("0x1", USDC_ADDRESS, "credit", 995n * E6), row("0x1", AERO, "credit", 8n * E18)]
      const [priced] = derivePricedRows(rows, [REF])
      assert.equal(priced!.sold_amount, "")
      assert.equal(priced!.bought_amount, (8n * E18).toString())
      assert.equal(priced!.priced.source, "unknown")
    })

    it("a token that mostly cancels out still counts, so it can't leave another pair looking single", () => {
      const rows = [row("0x1", USDC_ADDRESS, "debit", 1000n * E6), row("0x1", USDC_ADDRESS, "credit", 995n * E6), row("0x1", WETH_ADDRESS, "debit", E18), row("0x1", AERO, "credit", 8n * E18)]
      assert.deepEqual(derivePricedRows(rows, [REF]), [])
    })

    it("what passes straight through nets to nothing, so the rest is still a single pair", () => {
      const rows = [row("0x1", USDC_ADDRESS, "credit", 1000n * E6), row("0x1", USDC_ADDRESS, "debit", 1000n * E6), row("0x1", WETH_ADDRESS, "debit", E18), row("0x1", AERO, "credit", 800n * E18)]
      const [priced] = derivePricedRows(rows, [REF])
      assert.equal(priced!.sold_token, WETH_ADDRESS)
      assert.equal(priced!.priced.source, "swap")
    })

    it("ETH and WETH are separate tokens here, so paying with both has no price, but the cost is still known", () => {
      const rows = [row("0x1", ETH_ADDRESS, "debit", E18 / 2n), row("0x1", WETH_ADDRESS, "debit", E18 / 2n), row("0x1", AERO, "credit", 3000n * E18)]
      assert.deepEqual(derivePricedRows(rows, [REF]), [])
      const aero = legsOf(rows).find((l) => l.asset === "AERO")!
      assert.equal(aero.priceMicros, null)
      assert.equal(aero.costLabel, "paid")
    })

    it("a transaction netting to several tokens on a side still has no row", () => {
      const rows = [row("0x1", USDC_ADDRESS, "debit", 5n * E6), row("0x1", AERO, "credit", E18), row("0x1", ETH_ADDRESS, "credit", E18)]
      assert.deepEqual(derivePricedRows(rows, [REF]), [])
    })

    it("each account nets on its own", () => {
      const pool = "0x00000000000000000000000000000000000000bb"
      const rows = [row("0x1", USDC_ADDRESS, "debit", 5n * E6), row("0x1", AERO, "credit", E18), { ...row("0x1", USDC_ADDRESS, "credit", 5n * E6), account: pool }, { ...row("0x1", AERO, "debit", E18), account: pool }]
      assert.deepEqual(derivePricedRows(rows, [REF]).map((p) => p.account).sort(), [ME, pool].sort())
    })

    it("real slippage isn't rejected", () => {
      const legs = legsOf([row("0x1", USDC_ADDRESS, "debit", 2800n * E6), row("0x1", ETH_ADDRESS, "credit", E18)])
      assert.equal(legs.find((l) => l.asset === "ETH")!.costMicros, "2800000000")
    })
  })

  it("a transaction moving three tokens has no value on any side, and its debit isn't a plain transfer", () => {
    const legs = legsOf([row("0x1", USDC_ADDRESS, "debit", 5n * E6), row("0x1", AERO, "credit", E18), row("0x1", ETH_ADDRESS, "credit", E18)])
    assert.ok(legs.every((l) => l.kind === "swap" && l.costLabel === "unknown" && l.costMicros === null && l.proceedsMicros === null))
  })

  it("a payment with nothing coming back stays a plain transfer", () => {
    const [leg] = legsOf([row("0x1", USDC_ADDRESS, "debit", 5n * E6)])
    assert.equal(leg!.kind, "transfer")
  })

  describe("a transaction that also moves a token off the allowlist", () => {
    const JACK = "0x000000000000000000000000000000000000f00d"
    const OTHER = "0x000000000000000000000000000000000000beef"
    const unlisted = (tx: string, side: LegRow["side"], amount: bigint, token = JACK) => row(tx, token, side, amount, "unlisted")
    const aero = (legs: ReturnType<typeof legsOf>) => legs.find((l) => l.asset === "AERO")!

    for (const method of ["average", "fifo"] as const) {
      // The review's case: 1,000 USDC buys 300 + 200 AERO across two routes, plus an unlisted token.
      it(`a split route doesn't give AERO the whole payment, so a later sale can't show a false loss (${method})`, () => {
        const rows = [
          row("0x1", USDC_ADDRESS, "debit", 1000n * E6),
          row("0x1", AERO, "credit", 300n * E18),
          row("0x1", AERO, "credit", 200n * E18),
          unlisted("0x1", "credit", 7n),
          { ...row("0x2", AERO, "debit", 500n * E18), block_num: 101 },
          { ...row("0x2", USDC_ADDRESS, "credit", 600n * E6), block_num: 101 },
        ]
        const legs = legsOf(rows, [REF, { ...REF, blockNum: 101 }])
        const position = foldPositions(legs, method, {}).find((p) => p.asset === "AERO")!
        assert.equal(position.values.realizedMicros, null)
        assert.equal(sumTotals([position]).realizedMicros, null)
      })

      it(`a single route doesn't either (${method})`, () => {
        const legs = legsOf([row("0x1", USDC_ADDRESS, "debit", 1000n * E6), row("0x1", AERO, "credit", 500n * E18), unlisted("0x1", "credit", 7n)])
        const position = foldPositions(legs, method, {}).find((p) => p.asset === "AERO")!
        assert.equal(position.values.costMicros, null)
        assert.equal(position.values.averageCostMicros, null)
      })
    }

    it("what arrived has no cost or swap price, and says why", () => {
      const rows = [row("0x1", USDC_ADDRESS, "debit", 1000n * E6), row("0x1", AERO, "credit", 500n * E18), unlisted("0x1", "credit", 7n)]
      const legs = legsOf(rows)
      assert.equal(aero(legs).costLabel, "unknown")
      assert.equal(aero(legs).costMicros, null)
      assert.equal(aero(legs).priceMicros, null)
      assert.match(aero(legs).priceNote!, /a token we can't price yet/)
    })

    it("a row from a dataset deployed before unlisted_moves can't price it either", () => {
      const rows = [row("0x1", USDC_ADDRESS, "debit", 1000n * E6), row("0x1", AERO, "credit", 500n * E18)]
      const priced = derivePricedRows(rows, [REF])
      assert.equal(priced.length, 1)
      const legs = buildPricedLegs({ account: ME, rows: [...rows, unlisted("0x1", "credit", 7n)], references: [REF], priced })
      assert.equal(aero(legs).priceMicros, null)
    })

    it("selling for a listed token and an unlisted one leaves both sides unknown", () => {
      const legs = legsOf([row("0x1", AERO, "debit", 500n * E18), row("0x1", USDC_ADDRESS, "credit", 600n * E6), unlisted("0x1", "credit", 7n)])
      assert.equal(aero(legs).proceedsMicros, null)
      assert.equal(aero(legs).kind, "swap")
      assert.equal(legs.find((l) => l.asset === "USDC")!.costMicros, null)
    })

    it("paying with a listed and an unlisted token leaves what arrived unknown", () => {
      const legs = legsOf([row("0x1", USDC_ADDRESS, "debit", 600n * E6), unlisted("0x1", "debit", 7n), row("0x1", AERO, "credit", 500n * E18)])
      assert.equal(aero(legs).costMicros, null)
      assert.equal(legs.find((l) => l.asset === "USDC")!.proceedsMicros, null)
    })

    it("swapping into only an unlisted token has unknown proceeds, instead of hiding its gain as a transfer", () => {
      const [usdc] = legsOf([row("0x1", USDC_ADDRESS, "debit", 600n * E6), unlisted("0x1", "credit", 7n)])
      assert.equal(usdc!.kind, "swap")
      assert.equal(usdc!.proceedsMicros, null)
    })

    it("an unlisted token arriving with no payment is just a transfer in", () => {
      const legs = legsOf([row("0x1", AERO, "credit", E18), unlisted("0x1", "credit", 7n)])
      assert.equal(aero(legs).kind, "transfer")
      assert.equal(aero(legs).costLabel, "unknown")
    })

    it("sending listed and unlisted tokens with nothing back stays a transfer", () => {
      const [usdc] = legsOf([row("0x1", USDC_ADDRESS, "debit", 5n * E6), unlisted("0x1", "debit", 7n)])
      assert.equal(usdc!.kind, "transfer")
    })

    it("an unlisted token that nets to zero moved nothing, so the swap stands", () => {
      const legs = legsOf([row("0x1", USDC_ADDRESS, "debit", 1000n * E6), row("0x1", AERO, "credit", 500n * E18), unlisted("0x1", "credit", 7n), unlisted("0x1", "debit", 7n)])
      assert.equal(aero(legs).costMicros, "1000000000")
    })

    it("a zero-value transfer of an unlisted token moved nothing either", () => {
      const legs = legsOf([row("0x1", USDC_ADDRESS, "debit", 1000n * E6), row("0x1", AERO, "credit", 500n * E18), unlisted("0x1", "credit", 0n)])
      assert.equal(aero(legs).costMicros, "1000000000")
    })

    it("several unlisted tokens net separately", () => {
      const legs = legsOf([row("0x1", USDC_ADDRESS, "debit", 1000n * E6), row("0x1", AERO, "credit", 500n * E18), unlisted("0x1", "credit", 7n), unlisted("0x1", "debit", 7n, OTHER)])
      assert.equal(aero(legs).costMicros, null)
    })

    it("an amount that can't be read counts as a movement, and doesn't throw", () => {
      const legs = legsOf([row("0x1", USDC_ADDRESS, "debit", 1000n * E6), row("0x1", AERO, "credit", 500n * E18), { ...unlisted("0x1", "credit", 0n), amount: "" }])
      assert.equal(aero(legs).costMicros, null)
    })

    describe("NFTs are identities, not amounts", () => {
      const nft = (tx: string, side: LegRow["side"], id: bigint, token = JACK) => row(tx, token, side, id, "unlisted_nft")
      const paid = (extra: LegRow[]) => aero(legsOf([row("0x1", USDC_ADDRESS, "debit", 1000n * E6), row("0x1", AERO, "credit", 500n * E18), ...extra])).costMicros

      for (const method of ["average", "fifo"] as const) {
        it(`receiving ID 0 still means the payment was split, so a later sale can't show a false loss (${method})`, () => {
          const rows = [
            row("0x1", USDC_ADDRESS, "debit", 1000n * E6),
            row("0x1", AERO, "credit", 300n * E18),
            row("0x1", AERO, "credit", 200n * E18),
            nft("0x1", "credit", 0n),
            { ...row("0x2", AERO, "debit", 500n * E18), block_num: 101 },
            { ...row("0x2", USDC_ADDRESS, "credit", 600n * E6), block_num: 101 },
          ]
          const position = foldPositions(legsOf(rows, [REF, { ...REF, blockNum: 101 }]), method, {}).find((p) => p.asset === "AERO")!
          assert.equal(position.values.realizedMicros, null)
        })
      }

      it("sending IDs 1 and 2 and receiving ID 3 is three movements, though the numbers cancel", () => {
        assert.equal(paid([nft("0x1", "debit", 1n), nft("0x1", "debit", 2n), nft("0x1", "credit", 3n)]), null)
      })

      it("swapping one ID for an equal ID in another collection is two movements", () => {
        assert.equal(paid([nft("0x1", "debit", 5n), nft("0x1", "credit", 5n, OTHER)]), null)
      })

      it("a round trip of the same NFT moved nothing, so the swap stands", () => {
        assert.equal(paid([nft("0x1", "credit", 42n), nft("0x1", "debit", 42n)]), "1000000000")
      })

      it("a round trip of ID 0 moved nothing either", () => {
        assert.equal(paid([nft("0x1", "credit", 0n), nft("0x1", "debit", 0n)]), "1000000000")
      })

      it("an NFT and a fungible token of the same contract don't net against each other", () => {
        assert.equal(paid([nft("0x1", "credit", 7n), unlisted("0x1", "debit", 7n)]), null)
      })

      it("buying only an NFT has unknown proceeds, instead of hiding the gain as a transfer", () => {
        const [usdc] = legsOf([row("0x1", USDC_ADDRESS, "debit", 600n * E6), nft("0x1", "credit", 0n)])
        assert.equal(usdc!.kind, "swap")
        assert.equal(usdc!.proceedsMicros, null)
      })

      it("an ID that can't be read counts as a movement", () => {
        assert.equal(paid([{ ...nft("0x1", "credit", 1n), amount: "" }]), null)
      })

      it("never makes a pair", () => {
        assert.equal(derivePricedRows([row("0x1", USDC_ADDRESS, "debit", 5n * E6), nft("0x1", "credit", 7n)], [REF]).length, 0)
      })
    })

    it("an ERC-1155 movement has no readable amount, so the payment stays unknown", () => {
      const legs = legsOf([row("0x1", USDC_ADDRESS, "debit", 1000n * E6), row("0x1", AERO, "credit", 500n * E18), { ...unlisted("0x1", "credit", 0n), amount: "" }])
      assert.equal(aero(legs).costMicros, null)
      assert.equal(legs.find((l) => l.asset === "USDC")!.proceedsMicros, null)
    })

    it("the ETH and USDC oracle prices stay, as shared facts", () => {
      const legs = legsOf([row("0x1", USDC_ADDRESS, "debit", 2500n * E6), row("0x1", ETH_ADDRESS, "credit", E18), unlisted("0x1", "credit", 7n)])
      const eth = legs.find((l) => l.asset === "ETH")!
      assert.equal(eth.priceMicros, "2400000000")
      assert.equal(eth.costMicros, null)
    })

    it("another transaction's unlisted movement doesn't matter", () => {
      const legs = legsOf([row("0x1", USDC_ADDRESS, "debit", 1000n * E6), row("0x1", AERO, "credit", 500n * E18), unlisted("0x2", "credit", 7n)])
      assert.equal(aero(legs).costMicros, "1000000000")
    })

    it("a known payment still survives an oracle failure when nothing unlisted moved", () => {
      const legs = legsOf([row("0x1", USDC_ADDRESS, "debit", 2500n * E6), row("0x1", ETH_ADDRESS, "credit", E18)], [{ blockNum: 100, ethUsd: "", usdcUsd: "100000000" }])
      assert.equal(legs.find((l) => l.asset === "ETH")!.costMicros, "2500000000")
    })

    it("the rows that make the dataset's pairs leave unlisted tokens out", () => {
      assert.equal(derivePricedRows([row("0x1", USDC_ADDRESS, "debit", 5n * E6), unlisted("0x1", "credit", 7n)], [REF]).length, 0)
    })

    describe("the dataset's priced row", () => {
      const swap = [row("0x1", USDC_ADDRESS, "debit", 1000n * E6), row("0x1", AERO, "credit", 500n * E18)]
      const nft = (side: LegRow["side"], id: bigint) => row("0x1", JACK, side, id, "unlisted_nft")
      const pricedWith = (extra: LegRow[]) => derivePricedRows([...swap, ...extra], [REF]).length

      it("exists for a swap with nothing unlisted", () => assert.equal(pricedWith([]), 1))

      it("is left out when an unlisted token moved, whichever way", () => {
        assert.equal(pricedWith([unlisted("0x1", "credit", 7n)]), 0)
        assert.equal(pricedWith([unlisted("0x1", "debit", 7n)]), 0)
      })

      it("stays when the unlisted token nets to zero or a transfer moved nothing", () => {
        assert.equal(pricedWith([unlisted("0x1", "credit", 7n), unlisted("0x1", "debit", 7n)]), 1)
        assert.equal(pricedWith([unlisted("0x1", "credit", 0n)]), 1)
      })

      it("is left out when an amount can't be read, even if another row cancels what it can", () => {
        assert.equal(pricedWith([{ ...unlisted("0x1", "credit", 0n), amount: "" }]), 0)
        assert.equal(pricedWith([unlisted("0x1", "credit", 7n), unlisted("0x1", "debit", 7n), { ...unlisted("0x1", "debit", 0n), amount: "" }]), 0)
      })

      it("counts NFTs by ID, so one that came and went moved nothing, and a swapped one did", () => {
        assert.equal(pricedWith([nft("credit", 42n), nft("debit", 42n)]), 1)
        assert.equal(pricedWith([nft("credit", 42n), nft("debit", 43n)]), 0)
        assert.equal(pricedWith([nft("credit", 0n)]), 0)
      })

      it("ignores unlisted movements in another transaction or by another account", () => {
        assert.equal(pricedWith([unlisted("0x2", "credit", 7n)]), 1)
        assert.equal(pricedWith([{ ...unlisted("0x1", "credit", 7n), account: "0x000000000000000000000000000000000000dead" }]), 1)
      })
    })
  })

  it("wrapping nets to nothing, so its cost survives and nothing is realized", () => {
    const legs = legsOf([
      row("0x1", USDC_ADDRESS, "debit", 2400n * E6),
      row("0x1", ETH_ADDRESS, "credit", E18),
      row("0x2", ETH_ADDRESS, "debit", E18),
      row("0x2", WETH_ADDRESS, "credit", E18, "wrap"),
    ])
    assert.equal(legs.filter((l) => l.txHash === "0x2").length, 0)
    const eth = foldPositions(legs, "fifo", { ETH: { micros: "3000000000", source: "oracle", blockNum: 100 } }).find((p) => p.asset === "ETH")!
    assert.equal(eth.values.qty, E18.toString())
    assert.equal(eth.values.costMicros, "2400000000")
    assert.equal(eth.values.unrealizedMicros, "600000000")
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
  const gasOnly = legsOf([row("0x1", ETH_ADDRESS, "debit", E18 / 1000n, "gas")], [{ blockNum: 100, ethUsd: "", usdcUsd: "" }])
  const unknownHolding = legsOf([row("0x1", AERO, "credit", E18)])

  it("gas with no price and no cost: every total is null, not $0", () => {
    const totals = sumTotals(foldPositions(gasOnly, "average", {}))
    assert.equal(totals.pnlMicros, null)
    assert.equal(totals.realizedMicros, null)
    assert.equal(totals.gasMicros, null)
    assert.equal(totals.unpricedGas, true)
    // It spent ETH we never saw arrive, so it holds units we can't see. That isn't a value of $0 either.
    assert.equal(totals.valueMicros, null)
    assert.equal(totals.unrealizedMicros, null)
    assert.ok(totals.excluded.some((e) => e.reason === "incomplete history"))
  })

  it("sending out more than we saw arrive, with no sale, has no PnL answer in the headline or the chart", () => {
    const legs = legsOf([row("0x1", AERO, "debit", E18)])
    assert.equal(sumTotals(foldPositions(legs, "fifo", {})).pnlMicros, null)
    assert.equal(pnlOverTime(legs, "fifo", {}, marks([REF]), null).at(-1)!.pnlMicros, null)
  })

  it("a holding with no cost and no price: PnL, value and unrealized are null, and nothing sold is a real $0", () => {
    const totals = sumTotals(foldPositions(unknownHolding, "average", {}))
    assert.equal(totals.pnlMicros, null)
    assert.equal(totals.valueMicros, null)
    assert.equal(totals.unrealizedMicros, null)
    assert.equal(totals.realizedMicros, "0")
  })

  describe("a sale's reason names what's unknown", () => {
    const bought = [row("0x1", USDC_ADDRESS, "debit", 100n * E6), row("0x1", AERO, "credit", 200n * E18)]
    const absurdSale = (qty: bigint) => [{ ...row("0x2", AERO, "debit", qty), block_num: 101 }, { ...row("0x2", USDC_ADDRESS, "credit", 1n), block_num: 101 }]
    const received = { ...row("0x3", AERO, "credit", 200n * E18), block_num: 99 }
    const references = [REF, { ...REF, blockNum: 101 }, { ...REF, blockNum: 99 }]
    const reasons = (rows: LegRow[]) => sumTotals(foldPositions(legsOf(rows, references).filter((l) => l.asset === "AERO"), "fifo", {})).excluded.filter((e) => e.reason.startsWith("sold")).map((e) => e.reason)

    it("the price, when a swap's value is rejected", () => {
      assert.deepEqual(reasons([...bought, ...absurdSale(200n * E18)]), ["sold or spent at an unknown price"])
    })

    it("the cost, when what's sold arrived from elsewhere", () => {
      assert.deepEqual(reasons([received, { ...row("0x2", AERO, "debit", 200n * E18), block_num: 101 }, { ...row("0x2", USDC_ADDRESS, "credit", 100n * E6), block_num: 101 }]), ["sold at an unknown cost"])
    })

    it("both, when neither is known", () => {
      assert.deepEqual(reasons([received, ...absurdSale(200n * E18)]), ["sold at an unknown cost", "sold or spent at an unknown price"])
    })
  })

  it("the chart agrees, at every point", () => {
    const points = pnlOverTime(unknownHolding, "average", {}, marks([REF]), { blockNum: 101, timestamp: "2026-11-04T00:00:00.000Z" })
    assert.ok(points.length > 0)
    assert.ok(points.every((p) => p.pnlMicros === null))
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
    const references = [100, 101, 102].map((block) => ({ ...REF, blockNum: block }))
    const ethOnly = (rows: LegRow[]) => legsOf(rows, references).filter((l) => l.asset === "ETH")

    for (const method of ["average", "fifo"] as const) {
      for (const [name, sale, knownPart] of [["a profit", 5000n, 100_000_000n], ["a loss", 4000n, -400_000_000n]] as const) {
        it(`${name} stays out of every total, and never reads as $0 (${method})`, () => {
          const legs = ethOnly(mixed(sale))
          const positions = foldPositions(legs, method, {})
          const eth = positions.find((p) => p.asset === "ETH")!
          // The fold keeps the known part, and the position says it isn't the whole answer.
          assert.equal(BigInt(eth.state.realizedMicros), knownPart)
          assert.equal(eth.values.realizedMicros, null)
          const totals = sumTotals(positions)
          assert.equal(totals.realizedMicros, null)
          assert.equal(totals.pnlMicros, null)
          assert.deepEqual(totals.coverage.realized, { known: 0, missing: 1 })
          assert.ok(totals.excluded.some((e) => e.asset === "ETH" && e.reason === "sold at an unknown cost"))
          assert.equal(pnlOverTime(legs, method, {}, marks(references), null).at(-1)!.pnlMicros, null)
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
          assert.equal(totals.realizedMicros, "200000000")
          assert.deepEqual(totals.coverage.realized, { known: 1, missing: 1 })
          assert.equal(totals.pnlMicros, "200000000")
          assert.equal(pnlOverTime(legs, method, {}, marks(references), null).at(-1)!.pnlMicros, "200000000")
        })
      }
    }

    it("known gas alongside it is still a real answer, and says what it leaves out", () => {
      const legs = [...ethOnly(mixed(5000n)), ...legsOf([row("0x9", ETH_ADDRESS, "debit", E18 / 1000n, "gas")])]
      const totals = sumTotals(foldPositions(legs, "fifo", {}))
      assert.equal(totals.realizedMicros, null)
      assert.equal(totals.pnlMicros, "-2400000")
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
    assert.equal(totals.pnlMicros, "0")
    assert.equal(totals.realizedMicros, "0")
    assert.equal(pnlOverTime(legsOf(flat).filter((l) => l.asset === "ETH"), "fifo", {}, marks([REF]), null).at(-1)!.pnlMicros, "0")
  })

  it("known gas alone is an answer: it's a real, negative PnL", () => {
    const paidGas = legsOf([row("0x1", ETH_ADDRESS, "debit", E18 / 1000n, "gas")])
    const totals = sumTotals(foldPositions(paidGas, "average", {}))
    assert.equal(totals.pnlMicros, "-2400000")
  })
})

describe("totals", () => {
  const prices = DEMO_WALLET.prices
  const positions = foldPositions(DEMO_WALLET.legs, "average", prices)
  const totals = sumTotals(positions)

  it("say what they leave out, and never count unknown as $0", () => {
    const reasons = (asset: string) => totals.excluded.filter((e) => e.asset === asset).map((e) => e.reason)
    assert.deepEqual(reasons("cbBTC"), ["unknown cost"])
    assert.ok(reasons("ETH").includes("unknown cost"))
    assert.ok(totals.coverage.unrealized.missing > 0)
    const known = positions.filter((p) => p.values.unrealizedMicros !== null)
    assert.equal(totals.unrealizedMicros, known.length === 0 ? null : known.reduce((sum, p) => sum + BigInt(p.values.unrealizedMicros!), 0n).toString())
  })

  it("add up: PnL is realized plus unrealized, less gas", () => {
    assert.equal(BigInt(totals.pnlMicros!), BigInt(totals.realizedMicros ?? 0) + BigInt(totals.unrealizedMicros ?? 0) - BigInt(totals.gasMicros ?? 0))
  })

  it("the chart's last point matches the headline, for both methods", () => {
    for (const method of ["average", "fifo"] as const) {
      const headline = sumTotals(foldPositions(DEMO_WALLET.legs, method, prices))
      const points = pnlOverTime(DEMO_WALLET.legs, method, prices, usdView(DEMO_WALLET).markPrice, DEMO_WALLET.latest)
      assert.equal(points.at(-1)!.pnlMicros, headline.pnlMicros)
      assert.equal(points.at(-1)!.txHash, null)
    }
  })

  it("the chart doesn't jump at its last point when a token has a market price, because it's marked all along", () => {
    const points = pnlOverTime(DEMO_WALLET.legs, "average", prices, usdView(DEMO_WALLET).markPrice, DEMO_WALLET.latest)
    assert.equal(points.at(-2)!.pnlMicros, points.at(-1)!.pnlMicros, "nothing the chart counts changed price after the last transaction")
    assert.ok(points.some((p, i) => BigInt(p.pnlMicros ?? 0) > BigInt(points.at(-1)!.pnlMicros!) && i < points.length - 1), "AERO was worth more when it was sold")
    const unmarked = pnlOverTime(DEMO_WALLET.legs, "average", prices, usdView({ ...DEMO_WALLET, marketMarks: {} }).markPrice, DEMO_WALLET.latest)
    assert.ok(BigInt(unmarked.at(-1)!.pnlMicros!) - BigInt(unmarked.at(-2)!.pnlMicros!) > 70_000_000n, "without them, it would jump")
    assert.ok(points.at(-2)!.excludedCount < unmarked.at(-2)!.excludedCount, "and what has a price is no longer left out")
    assert.equal(points.at(-2)!.excludedCount, unmarked.at(-1)!.excludedCount)
  })

  it("leaves a token out of a point with no price at that block, as it does with no market", () => {
    const { marketMarks } = DEMO_WALLET
    const block = Number(Object.keys(marketMarks).find((b) => marketMarks[b]?.AERO))
    const points = pnlOverTime(DEMO_WALLET.legs, "average", prices, usdView({ ...DEMO_WALLET, marketMarks: { ...marketMarks, [block]: {} } }).markPrice, DEMO_WALLET.latest)
    const marked = pnlOverTime(DEMO_WALLET.legs, "average", prices, usdView(DEMO_WALLET).markPrice, DEMO_WALLET.latest)
    const at = (from: typeof points) => from.find((p) => p.blockNum === block)!
    assert.equal(at(points).excludedCount, at(marked).excludedCount + 1)
    assert.equal(points.at(-2)!.pnlMicros, marked.at(-2)!.pnlMicros, "and it's back at the next point")
  })

  it("the demo wallet shows the hand-worked numbers", () => {
    const aero = positions.find((p) => p.asset === "AERO")!
    // Bought 800 for 1,000 USDC at $0.9998: $1.24975 each. Sold 300 for 450 USDC: $1.4997 each.
    assert.equal(aero.values.averageCostMicros, "1249750")
    assert.equal(aero.values.realizedMicros, "74985000")
    assert.equal(aero.values.qty, (500n * E18).toString())
    // 500 at its $1.40 market price, less the $624.875 they cost. Its value rests on recent trades, so it's an estimate.
    assert.equal(aero.values.valueMicros, "700000000")
    assert.equal(aero.values.unrealizedMicros, "75125000")
    assert.deepEqual(aero.estimates, { cost: false, value: true, realized: false, unrealized: true })
  })

  it("the demo wallet's rows are still that wallet's", () => {
    assert.ok(DEMO_ROWS.every((r) => r.account === DEMO_ADDRESS))
    assert.ok(DEMO_REFERENCES.length > 0)
  })
})
