import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { balancesByAsset, decodeBalanceResults, encodeBalanceCalls, MULTICALL3 } from "../server/balances.ts"
import { DEMO_WALLET } from "../src/core/fixtures.ts"
import { buildPricedLegs, type LegRow, type ReferenceRow } from "../src/core/legs.ts"
import { foldPositions, pnlOverTime, sumTotals } from "../src/core/portfolio.ts"
import { openingLegs, type Onchain } from "../src/core/reconcile.ts"
import { ETH_ADDRESS, TOKENS, USDC_ADDRESS, WETH_ADDRESS } from "../src/core/tokens.ts"

const ME = "0x00000000000000000000000000000000000000aa"
const E18 = 10n ** 18n
const E6 = 10n ** 6n
const REF: ReferenceRow = { block_num: 100, eth_usd: "300000000000", usdc_usd: "100000000" }
const PRICES = { ETH: { usdMicros: "3000000000", source: "oracle" as const, blockNum: 200 } }

let counter = 0
function row(token: string, side: LegRow["side"], amount: bigint, kind: LegRow["kind"] = token === ETH_ADDRESS ? "eth" : "erc20", tx = `0x${(++counter).toString(16)}`): LegRow {
  return { block_num: 100, timestamp: "2026-11-04T00:00:00.000Z", tx_hash: tx, tx_index: 1, log_index: 0, token, account: ME, side, amount: amount.toString(), kind }
}
const legsOf = (rows: LegRow[]) => buildPricedLegs({ account: ME, rows, references: [REF], priced: [] })
const onchain = (amounts: Record<string, bigint>, l1FeeUnknownTxs: string[] = []): Onchain => ({
  balances: { blockNum: 200, amounts: Object.fromEntries(Object.entries(amounts).map(([asset, amount]) => [asset, amount.toString()])) },
  l1FeeUnknownTxs,
})
const assetOf = (positions: ReturnType<typeof foldPositions>, asset: string) => positions.find((p) => p.asset === asset)!

// Funded with some ETH and 3,000 USDC, then buys 1 ETH with the USDC and pays gas.
const SWAP = "0xswap"
const FUNDING = E18 / 10n
const WALLET_ROWS = [
  row(ETH_ADDRESS, "credit", FUNDING),
  row(USDC_ADDRESS, "credit", 3000n * E6),
  row(ETH_ADDRESS, "debit", 1000n, "gas", SWAP),
  row(USDC_ADDRESS, "debit", 3000n * E6, "erc20", SWAP),
  row(WETH_ADDRESS, "credit", E18, "erc20", SWAP),
]
const COMPUTED_ETH = FUNDING + E18 - 1000n

describe("a wallet that matches the chain", () => {
  const positions = foldPositions(legsOf(WALLET_ROWS), "average", PRICES, onchain({ ETH: COMPUTED_ETH, USDC: 0n }))

  it("is reconciled, and says so to the smallest unit", () => {
    assert.deepEqual(assetOf(positions, "ETH").reconciliation, { status: "reconciled", blockNum: 200, computedQty: COMPUTED_ETH.toString(), actualQty: COMPUTED_ETH.toString(), differenceQty: "0" })
    assert.equal(assetOf(positions, "USDC").reconciliation?.status, "reconciled")
  })

  it("keeps its PnL", () => {
    const paidFor = WALLET_ROWS.filter((r) => r.kind !== "gas" && r.amount !== FUNDING.toString())
    const known = foldPositions(legsOf(paidFor), "average", PRICES, onchain({ ETH: E18, USDC: 0n }))
    assert.equal(assetOf(known, "ETH").reconciliation?.status, "reconciled")
    assert.notEqual(assetOf(known, "ETH").values.unrealizedUsdMicros, null)
    assert.deepEqual(sumTotals(known).excluded.filter((e) => e.asset === "ETH"), [])
  })

  it("one wei off is a mismatch: there's no tolerance", () => {
    const off = foldPositions(legsOf(WALLET_ROWS), "average", PRICES, onchain({ ETH: COMPUTED_ETH - 1n, USDC: 0n }))
    assert.equal(assetOf(off, "ETH").reconciliation?.status, "incomplete")
  })
})

describe("a missed internal ETH transfer", () => {
  const MISSED = E18 / 2n
  const positions = foldPositions(legsOf(WALLET_ROWS), "average", PRICES, onchain({ ETH: COMPUTED_ETH + MISSED, USDC: 0n }))
  const eth = assetOf(positions, "ETH")

  it("is incomplete, with computed, actual and the difference", () => {
    assert.deepEqual(eth.reconciliation, {
      status: "incomplete",
      blockNum: 200,
      computedQty: COMPUTED_ETH.toString(),
      actualQty: (COMPUTED_ETH + MISSED).toString(),
      differenceQty: MISSED.toString(),
    })
  })

  it("shows PnL as unavailable, whatever the known part says", () => {
    assert.equal(eth.values.realizedUsdMicros, null)
    assert.equal(eth.values.unrealizedUsdMicros, null)
    assert.equal(eth.values.averageCostUsdMicros, null)
  })

  it("holds and values what the chain says, because those are facts", () => {
    assert.equal(eth.values.qty, (COMPUTED_ETH + MISSED).toString())
    assert.equal(eth.values.valueUsdMicros, ((COMPUTED_ETH + MISSED) * 3000000000n / E18).toString())
  })

  it("is out of the totals, and they say so, with the value still counted", () => {
    const totals = sumTotals(positions)
    assert.deepEqual(totals.excluded.filter((e) => e.asset === "ETH"), [{ asset: "ETH", reason: "doesn't match its onchain balance" }])
    assert.equal(totals.valueUsdMicros, eth.values.valueUsdMicros)
    assert.equal(totals.coverage.unrealized.known, 0)
    assert.equal(totals.unrealizedUsdMicros, null)
  })

  it("is out of every point on the chart, and the last point still matches the headline", () => {
    const legs = legsOf(WALLET_ROWS)
    const incomplete = new Set(["ETH"])
    const points = pnlOverTime(legs, "average", PRICES, [REF], { blockNum: 200, timestamp: "2026-11-04T00:00:00.000Z" }, incomplete)
    assert.ok(points.at(-1)!.excludedCount > 0)
    assert.equal(points.at(-1)!.pnlUsdMicros, sumTotals(positions).pnlUsdMicros)
  })

  it("a wallet funded only by one has a position, with no legs at all", () => {
    const fresh = foldPositions([], "average", PRICES, onchain({ ETH: MISSED, USDC: 0n }))
    assert.deepEqual(fresh.map((p) => [p.asset, p.reconciliation?.status, p.values.qty]), [["ETH", "incomplete", MISSED.toString()]])
  })

  it("compares what actually moved, not the fold's amount, which stops at zero", () => {
    // 5 left and 3 arrived, so the legs say -2, while the fold holds 3 and notes a shortfall of 5.
    const rows = [row(USDC_ADDRESS, "debit", 5n), row(USDC_ADDRESS, "credit", 3n)]
    const [usdc] = foldPositions(legsOf(rows), "average", {}, onchain({ USDC: 3n }))
    assert.equal(usdc!.reconciliation?.status === "unchecked" ? null : usdc!.reconciliation?.computedQty, "-2")
  })

  it("the end balance matching doesn't excuse units that left without arriving", () => {
    const rows = [row(USDC_ADDRESS, "debit", 5n), row(USDC_ADDRESS, "credit", 5n)]
    const [usdc] = foldPositions(legsOf(rows), "average", {}, onchain({ USDC: 0n }))
    assert.equal(usdc!.reconciliation?.status, "incomplete")
  })
})

describe("a wallet with an opening balance", () => {
  const OPENING = 2n * E18
  const opening = openingLegs({ blockNum: 99, amounts: { ETH: OPENING.toString(), USDC: "0" } }, "2026-11-04T00:00:00.000Z")
  const spent = [row(ETH_ADDRESS, "debit", 1000n, "gas"), row(ETH_ADDRESS, "debit", E18)]
  const legs = [...opening, ...legsOf(spent)]

  it("becomes one leg per asset it held, at an unknown cost, and not a $0 one", () => {
    assert.deepEqual(opening.map((l) => [l.asset, l.delta, l.costLabel, l.costUsdMicros, l.opening]), [["ETH", OPENING.toString(), "unknown", null, true]])
  })

  it("reconciles when what it held plus what moved is what's onchain", () => {
    const [eth] = foldPositions(legs, "average", PRICES, onchain({ ETH: OPENING - E18 - 1000n }))
    assert.equal(eth!.reconciliation?.status, "reconciled")
  })

  it("its cost stays unknown, so PnL is unavailable instead of wrong", () => {
    const [eth] = foldPositions(legs, "average", PRICES, onchain({ ETH: OPENING - E18 - 1000n }))
    assert.equal(eth!.values.costUsdMicros, null)
    assert.equal(eth!.values.unrealizedUsdMicros, null)
    assert.equal(eth!.state.shortfallQty, "0")
    assert.ok(BigInt(eth!.values.unknownCostQty) > 0n)
  })

  it("a position that didn't move still shows", () => {
    const positions = foldPositions(openingLegs({ blockNum: 99, amounts: { DAI: "5" } }, "2026-11-04T00:00:00.000Z"), "average", {}, onchain({ DAI: 5n }))
    assert.deepEqual(positions.map((p) => [p.asset, p.reconciliation?.status, p.values.qty, p.decimals]), [["DAI", "reconciled", "5", 18]])
  })

  it("makes no point on the chart of its own, since it isn't a transaction", () => {
    const points = pnlOverTime(legs, "average", PRICES, [REF], null)
    assert.ok(points.every((p) => p.txHash !== ""))
  })
})

describe("when there's nothing to compare", () => {
  it("a failed read leaves positions unchecked, with their PnL", () => {
    const [position] = foldPositions(legsOf([row(USDC_ADDRESS, "credit", 5n)]), "average", {}, { balances: null, l1FeeUnknownTxs: [] })
    assert.equal(position!.reconciliation?.status, "unchecked")
    assert.deepEqual(sumTotals([position!]).excluded.filter((e) => e.reason === "doesn't match its onchain balance"), [])
  })

  it("an asset whose read failed is unchecked, and the others aren't", () => {
    const positions = foldPositions(legsOf([row(USDC_ADDRESS, "credit", 5n), row(ETH_ADDRESS, "credit", 5n)]), "average", {}, onchain({ ETH: 5n }))
    assert.equal(assetOf(positions, "USDC").reconciliation?.status, "unchecked")
    assert.equal(assetOf(positions, "ETH").reconciliation?.status, "reconciled")
  })

  it("an L1 fee that isn't in yet doesn't call ETH incomplete, and leaves other assets alone", () => {
    const positions = foldPositions(legsOf(WALLET_ROWS), "average", PRICES, onchain({ ETH: 1n, USDC: 0n }, ["0xabc"]))
    assert.equal(assetOf(positions, "ETH").reconciliation?.status, "unchecked")
    assert.equal(assetOf(positions, "USDC").reconciliation?.status, "reconciled")
  })

  it("a fold with no onchain data at all has no check", () => {
    assert.equal(foldPositions(legsOf(WALLET_ROWS), "average", {})[0]!.reconciliation, null)
  })
})

describe("the balance read", () => {
  it("encodes a call per token, in the order of the allowlist, with native ETH through Multicall3", () => {
    const hex = encodeBalanceCalls(ME)
    assert.equal(hex.slice(0, 8), "82ad56cb")
    assert.equal((hex.length - 8) % 64, 0)
    const words = hex.slice(8).match(/.{64}/g)!
    assert.equal(BigInt(`0x${words[1]}`), BigInt(TOKENS.length))
    const first = 2 + TOKENS.length
    assert.equal(`0x${words[first]!.slice(24)}`, MULTICALL3)
    assert.equal(words[first + 4]!.slice(0, 8), "4d2301cc")
    assert.equal(`0x${words[first + 6 + 0]!.slice(24)}`, WETH_ADDRESS)
    assert.equal(words[first + 6 + 4]!.slice(0, 8), "70a08231")
  })

  it("adds ETH and WETH into one asset", () => {
    const results = TOKENS.map((t) => (t.symbol === "ETH" ? 2n : t.symbol === "WETH" ? 3n : 0n))
    assert.equal(balancesByAsset(results).ETH, "5")
  })

  it("leaves out an asset if any part of it failed, rather than undercounting", () => {
    const results = TOKENS.map((t) => (t.symbol === "WETH" ? null : 1n))
    const amounts = balancesByAsset(results)
    assert.equal(amounts.ETH, undefined)
    assert.equal(amounts.USDC, "1")
  })

  it("reads nothing from bytes that aren't an aggregate3 result", () => {
    assert.equal(decodeBalanceResults(null), null)
    assert.equal(decodeBalanceResults(""), null)
    assert.equal(decodeBalanceResults("00".repeat(31)), null)
    assert.equal(decodeBalanceResults("00".repeat(64)), null)
  })

  it("a call that failed or returned the wrong length is null, and the rest still read", () => {
    const word = (n: number | bigint) => BigInt(n).toString(16).padStart(64, "0")
    const count = TOKENS.length
    const items = TOKENS.map((_, i) => (i === 1 ? word(0) + word(0x40) + word(0) : i === 2 ? word(1) + word(0x40) + word(0) : word(1) + word(0x40) + word(32) + word(i + 10)))
    let offset = count * 32
    const offsets = items.map((item) => {
      const current = offset
      offset += item.length / 2
      return word(current)
    })
    const decoded = decodeBalanceResults(word(32) + word(count) + offsets.join("") + items.join(""))!
    assert.equal(decoded[0], 10n)
    assert.equal(decoded[1], null)
    assert.equal(decoded[2], null)
    assert.equal(decoded[3], 13n)
  })
})

describe("a real Base wallet", () => {
  // 0xfab06cb5…4803f, blocks 53,513,939 to 53,515,739. 11 transactions, recorded from staging, the public RPC's
  // receipts, and an `eth_call` through Multicall3 at both ends. Each is [hash, block, index, time, L2 gas, L1 fee].
  const ADDRESS = "0xfab06cb53cab198a3145226c1cd064925194803f"
  const TXS = [
  ["0x9c0757cd3c055b4720fc1d8e757b26ed5678918f6317737a08e236cfc3391967", 53514941, 461, "2026-11-04T19:07:09.000Z", "244669295308", "2493098770"],
  ["0x194cd262351d8434278af06e111b505b308f3cc56428d8ead31b78e4e24e0a07", 53514948, 363, "2026-11-04T19:07:23.000Z", "972503026404", "2613102982"],
  ["0xfd097647d85f9e63050408014c25d82b16bfc1d96efeebf6d4d2f93ea8adaac6", 53514952, 48, "2026-11-04T19:07:31.000Z", "934017270888", "2628287431"],
  ["0xc85c872c0677cfdf4677535de065606032adb0e9d8021d2b2c88a3b605ebc65c", 53514961, 272, "2026-11-04T19:07:49.000Z", "984979489689", "2691569777"],
  ["0x8ca841e4fabc5b83548e35cebafccbc2a667312a417be3d0cecf9cc011bd6a81", 53514970, 109, "2026-11-04T19:08:07.000Z", "940398804028", "2638076146"],
  ["0x5f6055aea9b86b060719fc09369474170810af630a73601384d7e77b006aef43", 53514983, 178, "2026-11-04T19:08:33.000Z", "901676343343", "2578602620"],
  ["0x79de6e833c3e11f179dbe1da2962d05b07a9cf989c61124ce36fb5bed0a478e5", 53515009, 235, "2026-11-04T19:09:25.000Z", "918045799495", "2535356399"],
  ["0xcc5ab08c023224a63a4bb8d11f0f457d1843130c7c85faf471946ee673662926", 53515048, 208, "2026-11-04T19:10:43.000Z", "1023302754095", "2931727112"],
  ["0x393bbb80568a26218931537f0ed6a0b658507bac92c64d6957b52ef0c9c9d599", 53515083, 280, "2026-11-04T19:11:53.000Z", "995975972316", "3007378828"],
  ["0x1c60c375d2a9943176b2ba41b7a452d936578ade6b3239608feff161b33f0904", 53515089, 215, "2026-11-04T19:12:05.000Z", "957443606691", "2979591555"],
  ["0x5ca28752ca915c95e8e98bf63e82bce5f6d766429a8b8b13b477d426d546533b", 53515089, 438, "2026-11-04T19:12:05.000Z", "826175437024", "2979591555"],
  ] as const
  const OPENING_ETH = "48039201907511540"
  /** The real `aggregate3` result at the last block. */
  const CLOSING_RESULT = "0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000b000000000000000000000000000000000000000000000000000000000000016000000000000000000000000000000000000000000000000000000000000001e0000000000000000000000000000000000000000000000000000000000000026000000000000000000000000000000000000000000000000000000000000002e0000000000000000000000000000000000000000000000000000000000000036000000000000000000000000000000000000000000000000000000000000003e0000000000000000000000000000000000000000000000000000000000000046000000000000000000000000000000000000000000000000000000000000004e0000000000000000000000000000000000000000000000000000000000000056000000000000000000000000000000000000000000000000000000000000005e0000000000000000000000000000000000000000000000000000000000000066000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000aaa28d07a7ac3c0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000"
  const CLOSING_ETH = "48029472643329084"

  const rows: LegRow[] = TXS.flatMap(([hash, block, index, time, l2, l1]) => {
    const base = { block_num: block, timestamp: time, tx_hash: hash, tx_index: index, log_index: 0, token: ETH_ADDRESS, account: ADDRESS, side: "debit" as const }
    return [{ ...base, amount: l2, kind: "gas" as const }, { ...base, amount: l1, kind: "l1_fee" as const }]
  })
  const decoded = balancesByAsset(decodeBalanceResults(CLOSING_RESULT)!)
  const legs = [
    ...openingLegs({ blockNum: 53513938, amounts: { ETH: OPENING_ETH } }, "2026-11-04T19:00:00.000Z"),
    ...buildPricedLegs({ account: ADDRESS, rows, references: [], priced: [] }),
  ]
  const [eth] = foldPositions(legs, "average", {}, { balances: { blockNum: 53515739, amounts: decoded }, l1FeeUnknownTxs: [] })

  it("decodes the real balance read", () => {
    assert.equal(decoded.ETH, CLOSING_ETH)
    assert.equal(decoded.USDC, "0")
  })

  it("reconciles exactly on ETH, across 11 transactions", () => {
    assert.equal(eth!.reconciliation?.status, "reconciled")
    assert.equal(eth!.effects.filter((e) => e.leg.kind === "gas").length, 11)
  })

  it("wouldn't without the L1 fees, which is what they're for", () => {
    const l2Only = buildPricedLegs({ account: ADDRESS, rows: rows.filter((r) => r.kind === "gas"), references: [], priced: [] })
    const [position] = foldPositions([...legs.filter((l) => l.opening), ...l2Only], "average", {}, { balances: { blockNum: 53515739, amounts: decoded }, l1FeeUnknownTxs: [] })
    assert.equal(position!.reconciliation?.status, "incomplete")
  })
})

describe("the demo wallet", () => {
  const positions = foldPositions(DEMO_WALLET.legs, "average", DEMO_WALLET.prices, DEMO_WALLET)

  it("shows both outcomes", () => {
    const incomplete = positions.filter((p) => p.reconciliation?.status === "incomplete").map((p) => p.asset)
    assert.deepEqual(incomplete, ["cbBTC"])
    assert.ok(positions.filter((p) => p.reconciliation?.status === "reconciled").length > 3)
  })

  it("has an opening balance that hasn't moved", () => {
    assert.equal(assetOf(positions, "DAI").effects.length, 1)
    assert.equal(assetOf(positions, "DAI").effects[0]!.leg.opening, true)
  })
})
