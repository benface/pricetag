import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { ASSETS, ETH_ADDRESS, TOKEN_MARKET_RULES, USDC_ADDRESS, buildPricedLegs, derivePricedRows, foldPositions, msBetweenBlocks, tokenMarketPrice, type LegRow, type Reference, type TokenActivity, type TokenPriceLookup } from "@pricetag/sdk/core"
import { createWallets, sharedMarket, type Query, type Source } from "@pricetag/sdk/internal"
import { ptNativeSource, ptTradeSource, tokensTablesSql } from "../dataset/build.ts"
import { resolvingSource } from "../server/source.ts"

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

describe("a wallet reading a token's market", () => {
  const ME = "0x00000000000000000000000000000000000000aa"
  const OTHER = "0x00000000000000000000000000000000000000bb"
  const E18 = 10n ** 18n
  const E6 = 10n ** 6n
  const COST = (1000n * E6).toString()
  /** All in Base's 2 s blocks, so an hour is 1,800 of them and a pricing bucket is 150. */
  const HOUR_BLOCKS = 1800
  const SALE = 50_000_100
  const LATER = SALE + 1000
  const ANCHOR = { blockNum: SALE + 100_000, ms: NOW }
  const timeOf = (block: number) => ANCHOR.ms - msBetweenBlocks(block, ANCHOR.blockNum)
  const quiet = { warn() {}, error() {}, log() {}, info() {}, debug() {} } as unknown as Console

  type Trade = { block: number; activity: TokenActivity }
  /** 12 senders on each side, every hour for 12 hours, up to `block`. */
  const healthyTo = (block: number): Trade[] =>
    Array.from({ length: 12 }, (_, hour) => Array.from({ length: 12 }, (_, sender) =>
      (["buy", "sell"] as const).map((side) => {
        const at = block - hour * HOUR_BLOCKS - sender
        return { block: at, activity: { token: TOKEN, timeMs: timeOf(at), sender: `${side}${sender}`, side, usd: 100, raw: 100 / 2e-18, trades: 1 } }
      }),
    )).flat(2)

  const legRow = (account: string, block: number, tx: string, token: string, side: LegRow["side"], amount: bigint, kind: LegRow["kind"]): LegRow => ({ block_num: block, timestamp: new Date(timeOf(block)).toISOString(), tx_hash: tx, tx_index: 1, log_index: 0, token, account, side, amount: amount.toString(), kind })
  /** Sold 500 of the token for 1,000 USDC, so at $2 a token its market agrees. */
  const sale = (account: string, block: number) => [legRow(account, block, `0x${block.toString(16)}`, TOKEN, "debit", 500n * E18, "unlisted"), legRow(account, block, `0x${block.toString(16)}`, USDC_ADDRESS, "credit", 1000n * E6, "erc20")]

  function setup(rows: LegRow[], trades: Trade[], start = { head: LATER, reached: LATER as number | null }) {
    const state = { ...start, trades, reads: [] as [number, number][], asked: 0, fail: false, rows }
    const source: Source = {
      mode: "raw",
      startBlock: null,
      historyFrom: () => SALE - 2 * 24 * HOUR_BLOCKS,
      head: async () => null,
      processedThrough: async (_, head) => head,
      readWindow: async (address, from, to) => ({ rows: state.rows.filter((r) => r.account === address && r.block_num >= from && r.block_num <= to), priced: null, gasUnknown: [] }),
      readReferences: async (blocks) => blocks.map((blockNum) => ({ blockNum, ethUsd: "240000000000", usdcUsd: "100000000" })),
      readLatestReference: async (blockNum) => ({ blockNum, ethUsd: "240000000000", usdcUsd: "100000000" }),
      readBalances: async (_, blockNum) => ({ blockNum, amounts: Object.fromEntries(ASSETS.map((asset) => [asset, "0"])) }),
      readEthBalances: async () => new Map(),
      async tokenActivityThrough(after, head) {
        state.asked += 1
        return state.reached === null || state.reached < after ? null : Math.min(state.reached, head)
      },
      async readTokenActivity(_, from, to) {
        if (state.fail) throw new Error("down")
        state.reads.push([from, to])
        return state.trades.filter((t) => t.block >= from && t.block <= to && t.block <= (state.reached ?? -1)).map((t) => t.activity)
      },
    }
    const wallets = createWallets(source, async () => ({ blockNum: state.head, timestamp: new Date(timeOf(state.head)).toISOString() }), async () => new Map(), quiet)
    return { state, wallets, source }
  }

  const usdcOf = async (wallets: ReturnType<typeof setup>["wallets"], address = ME, range = {}) => (await wallets.get(address, range)).legs.find((l) => l.asset === "USDC")!
  const assertPriced = (leg: { costMicros: string | null; estimated?: boolean | undefined }) => {
    assert.equal(leg.costMicros, COST)
    assert.equal(leg.estimated, true)
  }
  const assertUnknown = (leg: { costMicros: string | null; costLabel: string; estimated?: boolean | undefined }) => {
    assert.equal(leg.costMicros, null)
    assert.equal(leg.costLabel, "unknown")
    assert.equal(leg.estimated, undefined)
  }

  describe("after a reorg", () => {
    const BUCKET = SALE - (SALE % 150)
    const REORG = BUCKET - HOUR_BLOCKS - 100

    it("goes back to unknown when the trading behind a price was replaced", async () => {
      const { state, wallets } = setup(sale(ME, SALE), healthyTo(BUCKET))
      assertPriced(await usdcOf(wallets))
      const reads = state.reads.length

      state.trades = state.trades.filter((t) => t.block < REORG)
      await wallets.rewind(REORG, LATER)
      state.head = LATER + 100
      state.reached = state.head
      assertUnknown(await usdcOf(wallets))
      assert.ok(state.reads.length > reads, "the replacement was read")
      assert.ok(state.reads.at(-1)![1] >= BUCKET)
    })

    it("has no price while the dataset's still serving what was replaced, even if it says it's past it", async () => {
      const { state, wallets } = setup(sale(ME, SALE), healthyTo(BUCKET))
      assertPriced(await usdcOf(wallets))
      await wallets.rewind(REORG, LATER)

      // The old trades are still there, and it's reached the old tip, but not by as long as a reorg is re-read for.
      state.head = LATER + 10
      state.reached = state.head
      assertUnknown(await usdcOf(wallets))
      assert.ok(state.reads.every(([, to], i) => i === 0 || to < REORG), "nothing from there on was believed")

      state.head = LATER + 100
      state.reached = state.head
      assertPriced(await usdcOf(wallets))
    })

    it("keeps a price whose trades all came before it, without looking ahead", async () => {
      const { state, wallets } = setup(sale(ME, SALE), healthyTo(BUCKET))
      assertPriced(await usdcOf(wallets))
      const after = BUCKET + 50
      await wallets.rewind(after, LATER)
      state.head = LATER + 10
      state.reached = state.head
      assertPriced(await usdcOf(wallets))
    })

    it("drops a read that a reorg happened during", async () => {
      const { state, wallets, source } = setup(sale(ME, SALE), healthyTo(BUCKET))
      const read = source.readTokenActivity!
      let rewinding: Promise<void> | undefined
      source.readTokenActivity = async (tokens, from, to) => {
        const rows = await read(tokens, from, to)
        rewinding ??= wallets.rewind(REORG, LATER)
        return rows
      }
      assertUnknown(await usdcOf(wallets))
      await rewinding
      state.trades = []
      state.head = LATER + 100
      state.reached = state.head
      assertUnknown(await usdcOf(wallets))
    })
  })

  describe("when two reads share a token", () => {
    const OLDER = SALE - 23 * HOUR_BLOCKS
    const bucketOf = (block: number) => block - (block % 150)
    const trades = [...healthyTo(bucketOf(SALE)), ...healthyTo(bucketOf(OLDER))]

    it("gives the older trade the same price after a recent one as on its own", async () => {
      const warmed = setup([...sale(ME, SALE), ...sale(OTHER, OLDER)], trades)
      assertPriced(await usdcOf(warmed.wallets, ME))
      const reads = warmed.state.reads.length
      assertPriced(await usdcOf(warmed.wallets, OTHER))
      assert.equal(warmed.state.reads.length, reads + 1, "its lookback wasn't all read")

      const fresh = setup(sale(OTHER, OLDER), trades)
      assert.deepEqual(await usdcOf(warmed.wallets, OTHER), await usdcOf(fresh.wallets, OTHER))
    })

    it("keeps the recent trade's price after widening for an older one", async () => {
      const { wallets } = setup([...sale(ME, SALE), ...sale(OTHER, OLDER)], trades)
      await usdcOf(wallets, ME)
      await usdcOf(wallets, OTHER)
      assertPriced(await usdcOf(wallets, ME))
    })

    it("doesn't read again what it already has", async () => {
      const { state, wallets } = setup([...sale(ME, SALE), ...sale(OTHER, SALE + 1)], trades)
      await usdcOf(wallets, ME)
      const reads = state.reads.length
      assertPriced(await usdcOf(wallets, OTHER))
      assert.equal(state.reads.length, reads)
    })
  })

  describe("when the token dataset is behind", () => {
    const BUCKET = SALE - (SALE % 150)

    it("catches up with no new transaction, in a live read", async () => {
      const { state, wallets } = setup(sale(ME, SALE), healthyTo(BUCKET), { head: LATER, reached: BUCKET - 10 })
      assertUnknown(await usdcOf(wallets))
      assert.equal(state.reads.length, 0, "there's nothing to read until it's reached the block")

      state.head = LATER + 1
      state.reached = state.head
      assertPriced(await usdcOf(wallets))
    })

    it("catches up in a read as of a fixed block", async () => {
      const range = { to: SALE + 10 }
      const { state, wallets } = setup(sale(ME, SALE), healthyTo(BUCKET), { head: LATER + 200, reached: BUCKET - 10 })
      assertUnknown(await usdcOf(wallets, ME, range))
      await wallets.get(ME, range)
      assert.equal(state.asked, 1, "it asks once per block, however often it's read")

      state.head += 1
      state.reached = state.head
      assertPriced(await usdcOf(wallets, ME, range))
    })

    it("treats a dataset that hasn't started the same way", async () => {
      const { state, wallets } = setup(sale(ME, SALE), healthyTo(BUCKET), { head: LATER, reached: null })
      assertUnknown(await usdcOf(wallets))
      state.head += 1
      state.reached = state.head
      assertPriced(await usdcOf(wallets))
    })

    it("only prices what it's reached, and doesn't freeze the rest", async () => {
      const newer = SALE + 2 * HOUR_BLOCKS
      const rows = [...sale(ME, SALE), ...sale(ME, newer)]
      const { state, wallets } = setup(rows, [...healthyTo(BUCKET), ...healthyTo(newer - (newer % 150))], { head: newer + 200, reached: BUCKET + 10 })
      const priced = async () => (await wallets.get(ME)).legs.filter((l) => l.asset === "USDC" && l.costMicros !== null).map((l) => l.blockNum)
      assert.deepEqual(await priced(), [SALE])
      state.head += 1
      state.reached = state.head
      assert.deepEqual(await priced(), [SALE, newer])
    })

    it("asks nothing once everything's read", async () => {
      const { state, wallets } = setup(sale(ME, SALE), healthyTo(BUCKET))
      await wallets.get(ME)
      const { asked } = state
      state.head += 1
      state.reached = state.head
      await wallets.get(ME)
      assert.equal(state.asked, asked)
    })

    it("tries a failed read again", async () => {
      const { state, wallets } = setup(sale(ME, SALE), healthyTo(BUCKET))
      state.fail = true
      assertUnknown(await usdcOf(wallets))
      state.fail = false
      state.head += 1
      state.reached = state.head
      assertPriced(await usdcOf(wallets))
    })
  })

  describe("when two rules are compared", () => {
    const BUCKET = SALE - (SALE % 150)
    const compared = async (first: ReturnType<typeof setup>["wallets"], second: ReturnType<typeof setup>["wallets"]) => {
      const facts = await first.factsAt(ME, LATER, { withBalances: false })
      const market = sharedMarket(await first.marketOn(ME, facts!, {}), await second.marketOn(ME, facts!, {}))
      const costOf = (wallet: typeof first) => wallet.pricedOn(ME, facts!, {}, market)!.legs.find((l) => l.asset === "USDC")!.costMicros
      return [costOf(first), costOf(second)]
    }

    it("uses a token's price when both have it", async () => {
      const [a, b] = [setup(sale(ME, SALE), healthyTo(BUCKET)), setup(sale(ME, SALE), healthyTo(BUCKET))]
      await Promise.all([a.wallets.get(ME), b.wallets.get(ME)])
      assert.deepEqual(await compared(a.wallets, b.wallets), [COST, COST])
    })

    it("doesn't use it when only one has read that far, since that isn't the rule", async () => {
      const a = setup(sale(ME, SALE), healthyTo(BUCKET))
      const b = setup(sale(ME, SALE), healthyTo(BUCKET), { head: LATER, reached: BUCKET - 10 })
      await Promise.all([a.wallets.get(ME), b.wallets.get(ME)])
      assert.deepEqual(await compared(a.wallets, b.wallets), [null, null])
    })
  })

  it("asks the token dataset how far its own table has got", async () => {
    const sql: string[] = []
    const query = Object.assign(async () => [], {
      snapshotEnd: async (statement: string) => {
        sql.push(statement)
        return 500
      },
    }) as unknown as Query
    const source = resolvingSource(query, { baseDataset: "base", dataset: "pricetag", tokensDataset: "benface/pricetag_tokens@0.1.1", startBlock: 0, network: "base" })
    assert.equal(await source.tokenActivityThrough!(100, 900), 500)
    assert.equal(await source.tokenActivityThrough!(600, 900), null)
    assert.match(sql[0]!, /"benface\/pricetag_tokens@0\.1\.1"\.token_trades/)
  })

  it("is off with no token dataset", () => {
    const source = resolvingSource(Object.assign(async () => []) as unknown as Query, { baseDataset: "base", dataset: "pricetag", startBlock: 0, network: "base" })
    assert.equal(source.tokenActivityThrough, undefined)
    assert.equal(source.readTokenActivity, undefined)
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
