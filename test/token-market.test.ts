import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { ETH_ADDRESS, TOKEN_MARKET_RULES, USDC_ADDRESS, buildPricedLegs, derivePricedRows, foldPositions, tokenMarketPrice, type LegRow, type Reference, type TokenActivity, type TokenPriceLookup } from "@pricetag/sdk/core"
import { ptNativeSource, ptTradeSource, tokensTablesSql } from "../dataset/build.ts"

const HOUR = 3_600_000
const NOW = 1_800_000_000_000
const TOKEN = "0x00000000000000000000000000000000000000cc"

const row = (ago: number, sender: string, side: "buy" | "sell", usd = 100, usdPerRaw = 2e-18): TokenActivity => ({ token: TOKEN, timeMs: NOW - ago, sender, side, usd, raw: usd / usdPerRaw, trades: 1 })

/** Trading that passes: 12 senders on each side, every hour for 12 hours. */
const healthy = (usdPerRaw = 2e-18) =>
  Array.from({ length: 12 }, (_, hour) => Array.from({ length: 12 }, (_, sender) => [row(hour * HOUR + sender * 1000, `b${sender}`, "buy", 100, usdPerRaw), row(hour * HOUR + sender * 2000, `s${sender}`, "sell", 100, usdPerRaw)])).flat(2)

describe("a token's market price", () => {
  it("comes from real trading on both sides, with no list and no decimals", () => {
    const price = tokenMarketPrice(healthy(), NOW).usdPerRaw as number
    assert.ok(Math.abs(price / 2e-18 - 1) < 1e-9)
  })

  it("never looks ahead", () => {
    assert.equal(tokenMarketPrice(healthy(), NOW - 13 * HOUR).refused, "tooFewBuyers")
    const later = [...healthy(), ...Array.from({ length: 200 }, (_, i) => ({ ...row(0, `x${i}`, "buy", 100, 9e-15), timeMs: NOW + HOUR }))]
    assert.ok(Math.abs((tokenMarketPrice(later, NOW).usdPerRaw as number) / 2e-18 - 1) < 1e-9)
  })

  describe("refuses", () => {
    it("wash trading by one sender, however much of it", () => {
      const wash = Array.from({ length: 24 }, (_, hour) => [row(hour * HOUR, "me", "buy", 100_000), row(hour * HOUR, "me", "sell", 100_000)]).flat()
      assert.equal(tokenMarketPrice(wash, NOW).refused, "tooFewBuyers")
    })

    it("wash trading by a crowd when one of them does nearly all of it", () => {
      const whale = Array.from({ length: 12 }, (_, hour) => [row(hour * HOUR, "me", "buy", 50_000), row(hour * HOUR, "me", "sell", 50_000)]).flat()
      assert.equal(tokenMarketPrice([...healthy(), ...whale], NOW).refused, "oneSender")
    })

    it("a token nobody can sell", () => {
      assert.equal(tokenMarketPrice(healthy().filter((r) => r.side === "buy"), NOW).refused, "tooFewSellers")
    })

    it("dust from many wallets", () => {
      const dust = Array.from({ length: 12 }, (_, hour) => Array.from({ length: 12 }, (_, sender) => [row(hour * HOUR, `b${sender}`, "buy", 10), row(hour * HOUR, `s${sender}`, "sell", 10)])).flat(2)
      assert.equal(tokenMarketPrice(dust.slice(0, 200), NOW).refused, "tooLittleTrading")
    })

    it("a burst, which is what a token made an hour ago looks like", () => {
      const burst = healthy().filter((r) => r.timeMs > NOW - HOUR)
      assert.equal(tokenMarketPrice(burst.map((r) => ({ ...r, usd: r.usd * 5, raw: r.raw * 5 })), NOW).refused, "tooFewHours")
    })

    it("a pool so thin that each trade moves the price", () => {
      const thin = healthy().map((r, i) => (r.timeMs > NOW - TOKEN_MARKET_RULES.priceWindowMs ? { ...r, raw: r.raw / (1 + (i % 2)) } : r))
      assert.equal(tokenMarketPrice(thin, NOW).refused, "priceTooWide")
    })

    it("trading that's stopped", () => {
      const stale = healthy().map((r) => ({ ...r, timeMs: r.timeMs - 2 * HOUR }))
      assert.equal(tokenMarketPrice(stale, NOW).refused, "noRecentTrades")
    })
  })

  it("one odd trade can't set a price or refuse one", () => {
    const price = tokenMarketPrice([...healthy(), row(1000, "x", "buy", 100, 2e-12)], NOW).usdPerRaw as number
    assert.ok(Math.abs(price / 2e-18 - 1) < 1e-9)
  })
})

describe("a swap for a token off the list", () => {
  const ME = "0x00000000000000000000000000000000000000aa"
  const E18 = 10n ** 18n
  const E6 = 10n ** 6n
  const REF: Reference = { blockNum: 100, ethUsd: "240000000000", usdcUsd: "100000000" }
  const leg = (tx: string, token: string, side: LegRow["side"], amount: bigint, kind: LegRow["kind"] = token === ETH_ADDRESS ? "eth" : "erc20"): LegRow => ({ block_num: 100, timestamp: "2026-11-04T00:00:00.000Z", tx_hash: tx, tx_index: 1, log_index: 0, token, account: ME, side, amount: amount.toString(), kind })
  const legsOf = (rows: LegRow[], tokenPrice?: TokenPriceLookup) => buildPricedLegs({ account: ME, rows, references: [REF], priced: derivePricedRows(rows, [REF]), ...(tokenPrice ? { tokenPrice } : {}) })
  /** $2 a token, in its smallest unit. */
  const market: TokenPriceLookup = (token) => (token === TOKEN ? 2e-18 : null)
  const sold = [leg("0x1", TOKEN, "debit", 500n * E18, "unlisted"), leg("0x1", USDC_ADDRESS, "credit", 1000n * E6)]

  it("costs what arrived was worth, as an estimate, when the token's market agrees", () => {
    const usdc = legsOf(sold, market).find((l) => l.asset === "USDC")!
    assert.equal(usdc.costLabel, "paid")
    assert.equal(usdc.costMicros, (1000n * E6).toString())
    assert.equal(usdc.estimated, true)
    assert.equal(usdc.priceNote, null)
  })

  it("values what was paid for a token the same way", () => {
    const eth = legsOf([leg("0x1", ETH_ADDRESS, "debit", E18), leg("0x1", TOKEN, "credit", 1200n * E18, "unlisted")], market).find((l) => l.asset === "ETH" && l.kind === "swap")!
    assert.equal(eth.proceedsMicros, (2400n * E6).toString())
    assert.equal(eth.estimated, true)
  })

  it("is exactly as before with no market lookup, which is every read without the dataset", () => {
    const usdc = legsOf(sold).find((l) => l.asset === "USDC")!
    assert.equal(usdc.costLabel, "unknown")
    assert.equal(usdc.costMicros, null)
    assert.equal(usdc.estimated, undefined)
  })

  const staysUnknown = (name: string, rows: LegRow[], tokenPrice: TokenPriceLookup = market) =>
    it(name, () => {
      for (const l of legsOf(rows, tokenPrice).filter((l) => l.kind !== "gas")) {
        assert.equal(l.costMicros, null)
        assert.equal(l.proceedsMicros, null)
        assert.equal(l.estimated, undefined)
      }
    })

  staysUnknown("stays unknown when the token has no market, like an LP share", sold, () => null)
  staysUnknown("stays unknown when what left isn't worth about what arrived, like a token made to look valuable", [leg("0x1", TOKEN, "debit", 50_000n * E18, "unlisted"), leg("0x1", USDC_ADDRESS, "credit", 1000n * E6)])
  staysUnknown("stays unknown when both only arrived, as in a claim", [leg("0x1", TOKEN, "credit", 500n * E18, "unlisted"), leg("0x1", USDC_ADDRESS, "credit", 1000n * E6)])
  staysUnknown("stays unknown when another token moved too", [...sold, leg("0x1", "0x00000000000000000000000000000000000000dd", "debit", 5n, "unlisted")])
  staysUnknown("stays unknown when an NFT moved too", [...sold, leg("0x1", "0x00000000000000000000000000000000000000dd", "debit", 5n, "unlisted_nft")])
  staysUnknown("stays unknown when an amount can't be read", [{ ...sold[0]!, amount: "" }, sold[1]!])

  it("leaves a sweep nothing to act on: selling what came this way is an estimated gain", () => {
    const later = (tx: string, side: LegRow["side"], token: string, amount: bigint): LegRow => ({ ...leg(tx, token, side, amount), block_num: 101, tx_index: 2 })
    const rows = [...sold, later("0x2", "debit", USDC_ADDRESS, 1000n * E6), later("0x2", "credit", ETH_ADDRESS, E18 / 2n)]
    const references = [REF, { ...REF, blockNum: 101 }]
    const legs = buildPricedLegs({ account: ME, rows, references, priced: derivePricedRows(rows, references), tokenPrice: market })
    const usdc = foldPositions(legs, "average", {}).find((p) => p.asset === "USDC")!
    assert.ok(BigInt(usdc.values.estimatedRealizedMicros) > 0n)
  })
})

describe("the token tables", () => {
  const trade = new Function(`${ptTradeSource()}; return pt_trade`)() as (...args: unknown[]) => string
  const native = new Function(`${ptNativeSource()}; return pt_native`)() as (...args: unknown[]) => string

  it("value a trade by its ETH or USDC side", () => {
    assert.equal(trade("4200000000000000000000000000000000000006", "1000000000000000000", "222976000000", "99984724"), "2229760000")
    assert.equal(trade("833589fcd6edb6e08f4c7c32d4f71b54bda02913", "1000000", "222976000000", "99984724"), "999847")
    assert.equal(trade("0000000000000000000000000000000000000000", "1000000000000000000", "222976000000", "99984724"), "2229760000")
  })

  it("never guess what a trade was worth, and never throw", () => {
    assert.equal(trade("4200000000000000000000000000000000000006", "1", "", "99984724"), "")
    assert.equal(trade("833589fcd6edb6e08f4c7c32d4f71b54bda02913", "1", "222976000000", null), "")
    assert.equal(trade("00000000000000000000000000000000000000cc", "1", "222976000000", "99984724"), "")
    assert.equal(trade("4200000000000000000000000000000000000006", "", "222976000000", "99984724"), "")
  })

  it("read a v4 swap's ETH only when its other side is what moved, the opposite way", () => {
    assert.equal(native("debit", "500", "-7", "500"), "7")
    assert.equal(native("credit", "500", "7", "-500"), "7")
    assert.equal(native("debit", "500", "-7", "499"), "", "it's not this token")
    assert.equal(native("credit", "500", "-7", "500"), "", "it went the other way")
    assert.equal(native("debit", "500", "7", "500"), "", "both came out")
    assert.equal(native("debit", "", null, "500"), "")
  })

  it("have a block filter on every table", () => {
    for (const [name, sql] of Object.entries(tokensTablesSql(100))) assert.match(sql, /block_num\(\) >= 100/, name)
  })
})
