import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { after, before, describe, it } from "node:test"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { ASSETS, ETH_ADDRESS, formatSignedMoney, type LegPart, type LegRow, type Method, type PricedLeg } from "@pricetag/sdk/core"
import type { RatesReader, Source } from "@pricetag/sdk/internal"
import { createApi } from "../server/app.ts"
import { combinedPortfolioOf, explainAcross, explainCombined, previewCombined, type AllYoursRead, type CombinedPortfolioResponse } from "../src/core/combined.ts"
import { portfolioOf } from "../src/core/portfolio.ts"
import { NO_FACTS, combinedFacts, type TransactionGain } from "../src/core/activity.ts"
import type { PortfolioResponse, WalletResponse } from "../src/core/api.ts"
import { DEMO_ADDRESS, DEMO_SAVINGS_ADDRESS, answerSender, emptyBook, yourWallets, type Book } from "../src/core/book.ts"
import { sortHoldings } from "../src/core/holdings.ts"
import { allYoursFailedSentence, allYoursOutdatedSentence, allYoursReadingSentence, allYoursUpdatingSentence, coverageSentence, excludedSentence, holdCaveatSentence } from "../src/core/wording.ts"
import { DEMO_WALLET, demoWallet } from "../src/core/fixtures.ts"

const HOT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const COLD = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const THIRD = "0xcccccccccccccccccccccccccccccccccccccccc"
const SHOP = "0xdddddddddddddddddddddddddddddddddddddddd"
const STRANGER = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
const ONE = 10n ** 18n
const FEE = 10n ** 15n

let block = 100
function leg(tx: string, delta: bigint, changes: Partial<PricedLeg> = {}): PricedLeg {
  block += 1
  return {
    id: `${tx}:ETH${changes.kind === "gas" ? ":gas" : ""}`,
    asset: "ETH",
    delta: delta.toString(),
    decimals: 18,
    kind: "transfer",
    priceMicros: "3000000000",
    priceSource: "oracle",
    priceNote: null,
    costMicros: null,
    proceedsMicros: null,
    costLabel: "unknown",
    blockNum: block,
    timestamp: "2026-11-04T00:00:00.000Z",
    txHash: tx,
    txIndex: 1,
    parts: [],
    ...changes,
  }
}
const moved = (account: string, side: LegPart["side"], amount: bigint, counterparty: string): LegPart => ({ logIndex: 0, token: ETH_ADDRESS, account, side, amount: amount.toString(), kind: "eth", counterparty })
const fee = (of: PricedLeg): PricedLeg => ({ ...leg(of.txHash, -FEE, { kind: "gas" }), blockNum: of.blockNum })
const at = (of: PricedLeg, next: PricedLeg): PricedLeg => ({ ...next, blockNum: of.blockNum })

function walletOf(address: string, legs: PricedLeg[]): WalletResponse {
  const amounts: Record<string, string> = {}
  for (const l of legs) amounts[l.asset] = (BigInt(amounts[l.asset] ?? 0) + BigInt(l.delta)).toString()
  // ETH at $3,000 in every block these legs are in, which is what money put in turns into ETH at.
  const references = legs.map((l) => ({ blockNum: l.blockNum, ethUsd: "300000000000", usdcUsd: "100000000" }))
  return { ...DEMO_WALLET, address, legs, references: [...DEMO_WALLET.references, ...references], balances: { blockNum: DEMO_WALLET.coverage.toBlock, amounts } }
}

// Spending money gets 2 ETH that cost $6,000, then moves 1 ETH to savings, paying a fee for it. Savings pays 0.5 ETH to a shop.
const buy = leg("0x1", 2n * ONE, { costLabel: "paid", costMicros: "6000000000", parts: [moved(HOT, "credit", 2n * ONE, SHOP)] })
const out = leg("0x2", -ONE, { parts: [moved(HOT, "debit", ONE, COLD)] })
const into = at(out, leg("0x2", ONE, { parts: [moved(COLD, "credit", ONE, HOT)] }))
const pay = leg("0x3", -ONE / 2n, { parts: [moved(COLD, "debit", ONE / 2n, SHOP)] })
const hot = walletOf(HOT, [buy, fee(buy), out, fee(out)])
const cold = walletOf(COLD, [into, pay, fee(pay)])
// Someone nobody's answered for sends a third wallet 1 ETH, so its cost is unknown.
const gift = leg("0x4", ONE, { parts: [moved(THIRD, "credit", ONE, STRANGER)] })
const third = walletOf(THIRD, [gift])

const noFacts = (gain: TransactionGain | null) => ({ ...NO_FACTS, gain })
const linking = (wallets: readonly WalletResponse[]): Book => ({ ...emptyBook(), linked: wallets.map((w) => w.address) })
/** Each wallet as it shows on its own, with the others linked so costs carry between them. */
const alone = (wallets: readonly WalletResponse[], method: Method) => wallets.map((wallet) => portfolioOf(wallet, method, wallets.filter((w) => w !== wallet), linking(wallets)))
const added = (portfolios: readonly PortfolioResponse[], pick: (p: PortfolioResponse) => string | null) => portfolios.reduce((sum, p) => sum + BigInt(pick(p) ?? "0"), 0n).toString()

/** The Swift package's tests read these, so a change to what the server sends fails on both sides. */
function assertMatchesFile(name: string, actual: unknown) {
  const url = new URL(`../macos/PricetagKit/Tests/PricetagKitTests/Resources/${name}`, import.meta.url)
  const text = `${JSON.stringify(actual, null, 2)}\n`
  if (process.env.UPDATE_FIXTURES) writeFileSync(url, text)
  assert.equal(readFileSync(url, "utf8"), text, `${name} is out of date. Run with UPDATE_FIXTURES=1 if the change is on purpose.`)
}

describe("all your wallets as one", () => {
  it("sends what the Mac app reads", () => {
    assertMatchesFile("all-yours-portfolio.json", combinedPortfolioOf([hot, cold, third], "average", emptyBook(), { reading: [SHOP], failed: [] }))
    assertMatchesFile("all-yours-explanation.json", explainCombined([hot, cold, third], "average", { kind: "asset", asset: "ETH", metric: "unrealized" }, emptyBook()))
    // The demo's two wallets, which move money between them, for the Mac app's scenes.
    const savings = demoWallet(DEMO_SAVINGS_ADDRESS) as WalletResponse
    assertMatchesFile("all-yours-demo-portfolio.json", combinedPortfolioOf([DEMO_WALLET, savings], "average", emptyBook()))
    assertMatchesFile("all-yours-demo-explanation.json", explainCombined([DEMO_WALLET, savings], "average", { kind: "total", metric: "pnl" }, emptyBook()))
  })

  for (const method of ["average", "fifo"] as const) {
    it(`adds up each wallet's numbers, by ${method}`, () => {
      const each = alone([hot, cold], method)
      const all = combinedPortfolioOf([hot, cold], method, emptyBook())
      for (const key of ["valueMicros", "realizedMicros", "unrealizedMicros", "gasMicros", "pnlMicros"] as const) {
        assert.equal(all.totals[key], added(each, (p) => p.totals[key]), key)
      }
      assert.equal(all.pnlStatus, "complete")
      // The chart ends where the headline is.
      assert.equal(all.points.at(-1)?.pnlMicros, all.totals.pnlMicros)
    })
  }

  it("doesn't count a move between them as money put in, and still counts its fee", () => {
    const [hotAlone, coldAlone] = alone([hot, cold], "average") as [PortfolioResponse, PortfolioResponse]
    const all = combinedPortfolioOf([hot, cold], "average", emptyBook())
    // Savings took the 1 ETH at the $3,000 it cost, which is what moved between them.
    assert.equal(coldAlone.holdComparison.putInMicros, "3000000000")
    assert.equal(all.holdComparison.putInMicros, (BigInt(hotAlone.holdComparison.putInMicros) + BigInt(coldAlone.holdComparison.putInMicros) - 3_000_000_000n).toString())
    assert.equal(all.holdComparison.putInMicros, "6000000000")
    // Three fees at $3,000 per ETH, the move's included.
    assert.equal(all.totals.gasMicros, "9000000")
    // Its cost carries over, so nothing in savings is unknown, and the move made no gain or loss.
    assert.equal(all.positions.find((p) => p.asset === "ETH")?.values.unknownCostQty, "0")
  })

  it("lists a move once, as a move, in both wallets", () => {
    const all = combinedPortfolioOf([hot, cold], "average", emptyBook())
    const move = all.points.find((p) => p.txHash === "0x2")
    assert.equal(move?.summary, "Moved 1 ETH between your wallets")
    assert.deepEqual(move?.wallets, [HOT, COLD])
    assert.deepEqual(all.points.find((p) => p.txHash === "0x3")?.wallets, [COLD])
    assert.equal(all.points.filter((p) => p.txHash !== null).length, 3)
  })

  it("says what each transaction moved, who with and what it made, across the wallets", () => {
    const all = combinedPortfolioOf([hot, cold], "average", emptyBook())
    const move = all.points.find((p) => p.txHash === "0x2")
    assert.deepEqual(move?.assets, ["ETH"])
    // Between their own wallets, so there's nobody else in it, and it's only counted once.
    assert.equal(move?.counterparty, null)
    assert.deepEqual(move?.amount, { direction: "trade", micros: "3000000000" })
    assert.equal(move?.gain, null)
    assert.deepEqual(move?.unknownCost, [])
    const payment = all.points.find((p) => p.txHash === "0x3")
    assert.equal(payment?.counterparty, SHOP)
    assert.deepEqual(payment?.amount, { direction: "out", micros: "1500000000" })
    const last = all.points.at(-1)
    assert.deepEqual([last?.txHash, last?.assets, last?.amount], [null, [], null])
  })

  it("keeps a gift's unknown cost on its transaction, with who sent it", () => {
    const all = combinedPortfolioOf([hot, cold, third], "average", emptyBook())
    const received = all.points.find((p) => p.txHash === "0x4")
    assert.deepEqual(received?.unknownCost, ["ETH"])
    assert.equal(received?.counterparty, STRANGER)
    assert.deepEqual(received?.amount, { direction: "in", micros: "3000000000" })
  })

  it("adds up what each wallet's sales made in one transaction, and doesn't guess when one isn't known", () => {
    assert.deepEqual(combinedFacts([], [noFacts({ micros: "5", estimated: false }), noFacts({ micros: "-2", estimated: true }), noFacts(null)], new Set()).gain, { micros: "3", estimated: true })
    assert.deepEqual(combinedFacts([], [noFacts({ micros: "5", estimated: false }), noFacts({ micros: null, estimated: false })], new Set()).gain, { micros: null, estimated: false })
    assert.equal(combinedFacts([], [noFacts(null)], new Set()).gain, null)
  })

  it("keeps what's unknown visible, saying which wallet it's in", () => {
    const all = combinedPortfolioOf([hot, cold, third], "average", emptyBook())
    assert.deepEqual(all.totals.excluded, [{ asset: "ETH", reason: "unknown cost", wallet: THIRD }])
    assert.equal(all.pnlStatus, "partial")
    const eth = all.positions.find((p) => p.asset === "ETH")
    assert.equal(eth?.values.unknownCostQty, ONE.toString())
    assert.equal(eth?.values.unrealizedMicros, null, "never as if it cost nothing")
    assert.deepEqual(eth?.wallets.filter((w) => w.unknownCostQty !== "0").map((w) => w.wallet), [THIRD])
    assert.deepEqual(all.questions.map((q) => [q.wallet, q.sender]), [[THIRD, STRANGER]])
    // What's known still adds up: the third wallet's unknown leaves out only its own share.
    const each = alone([hot, cold, third], "average")
    assert.equal(all.totals.pnlMicros, added(each, (p) => p.totals.pnlMicros))
  })

  it("explains a number with each wallet's side of it, and says which wallet each movement is in", () => {
    const pnl = explainCombined([hot, cold], "average", { kind: "total", metric: "pnl" }, emptyBook())
    assert.deepEqual(pnl?.parts.map((p) => p.wallet), [HOT, COLD])
    assert.equal(pnl?.value, formatSignedMoney(combinedPortfolioOf([hot, cold], "average", emptyBook()).totals.pnlMicros as string, "USD"))
    const tx = explainCombined([hot, cold], "average", { kind: "tx", txHash: "0x2" }, emptyBook())
    assert.deepEqual(new Set(tx?.legs.map((l) => l.wallet)), new Set([HOT, COLD]))
    const hold = explainCombined([hot, cold], "average", { kind: "hold" }, emptyBook())
    assert.ok(hold?.lines.some((line) => line.includes("neither are moves between them")))
    assert.equal(explainCombined([hot, cold], "average", { kind: "asset", asset: "USDC", metric: "value" }, emptyBook()), null)
  })
})

describe("all your wallets, in the browser", () => {
  it("counts the wallets the answers say are yours and device accounts, and never a watched one or the demo's", () => {
    let book = answerSender(emptyBook(), HOT, COLD, { kind: "mine" })
    book = answerSender(book, HOT, STRANGER, { kind: "someone-else" })
    book = answerSender(book, DEMO_ADDRESS, DEMO_SAVINGS_ADDRESS, { kind: "mine" })
    assert.deepEqual(new Set(yourWallets(book)), new Set([HOT, COLD]))
    assert.deepEqual(new Set(yourWallets(book, [THIRD.toUpperCase().replace("0X", "0x"), HOT])), new Set([HOT, COLD, THIRD]))
    assert.deepEqual(yourWallets(emptyBook()), [])
  })

  it("explains with the legs themselves, the same ones the server sends", () => {
    const shown = explainAcross([hot, cold], "average", { kind: "tx", txHash: "0x2" }, emptyBook())
    const sent = explainCombined([hot, cold], "average", { kind: "tx", txHash: "0x2" }, emptyBook())
    assert.deepEqual(shown?.effects.map(({ leg }) => [shown.walletOf(leg), leg.id]), sent?.legs.map((leg) => [leg.wallet, leg.id]))
    assert.deepEqual(shown?.parts, sent?.parts)
    assert.equal(shown?.value, sent?.value)
    // A move is the same leg id in both wallets, so anything listing them has to tell them apart by wallet.
    assert.deepEqual(new Set(shown?.effects.map(({ leg }) => shown.walletOf(leg))), new Set([HOT, COLD]))
  })

  it("previews what answering for a wallet would do to the total", () => {
    const [before] = previewCombined([hot, third], "average", [emptyBook()])
    const [answered] = previewCombined([hot, third], "average", [answerSender(emptyBook(), THIRD, STRANGER, { kind: "someone-else" })])
    assert.equal(before?.open, 1)
    assert.equal(answered?.open, 0)
    assert.notEqual(before?.unresolvedMicros, answered?.unresolvedMicros)
    assert.equal(previewCombined([hot], "average", [emptyBook()], { reading: [THIRD], failed: [] })[0]?.pending, true)
  })

  it("sorts its holdings the way it sorts one wallet's", () => {
    const { positions } = combinedPortfolioOf([hot, cold], "average", emptyBook())
    assert.deepEqual(sortHoldings(positions, { column: "asset", descending: true }).map((p) => p.asset), positions.map((p) => p.asset).sort().reverse())
  })

  it("says which wallet what's left out is in", () => {
    assert.equal(excludedSentence([{ asset: "ETH", reason: "unknown cost", wallet: THIRD }]), "Excludes ETH in 0xcccc…cccc (unknown cost).")
    assert.equal(excludedSentence([{ asset: "ETH", reason: "unknown cost" }]), "Excludes ETH (unknown cost).")
    const { holdComparison } = combinedPortfolioOf([third], "average", emptyBook())
    assert.match(holdCaveatSentence(holdComparison, "USD", { combined: true }) as string, /nothing put in your wallets/)
    assert.match(coverageSentence({ fromBlock: 1, toBlock: 100 }, 10, false, { combined: true }), /What your wallets held/)
    assert.equal(allYoursReadingSentence([THIRD]), "Still reading 0xcccc…cccc, so it isn't in these numbers yet.")
    assert.equal(allYoursFailedSentence([HOT, COLD]), "Couldn't read 0xaaaa…aaaa and 0xbbbb…bbbb, so they aren't in these numbers.")
    assert.equal(allYoursUpdatingSentence([THIRD]), "Updating 0xcccc…cccc. These numbers use its last read until then.")
    assert.equal(allYoursOutdatedSentence([HOT, COLD]), "Couldn't update 0xaaaa…aaaa and 0xbbbb…bbbb, so these numbers use their last read.")
  })
})

describe("all your wallets over the api", () => {
  const row = (block: number, tx: string, account: string, side: LegRow["side"], amount: bigint): LegRow => ({
    block_num: block,
    timestamp: "2026-11-04T00:00:00.000Z",
    tx_hash: tx,
    tx_index: 0,
    log_index: 0,
    token: ETH_ADDRESS,
    account,
    side,
    amount: amount.toString(),
    counterparty: null,
    kind: "eth",
  })
  const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
  const rows: Record<string, LegRow[]> = {
    [HOT]: [row(10, "0x1", HOT, "credit", ONE), { ...row(10, "0x1", HOT, "debit", 3_000_000_000n), token: USDC, kind: "erc20" }, { ...row(11, "0x2", HOT, "debit", ONE), counterparty: COLD }],
    [COLD]: [{ ...row(11, "0x2", COLD, "credit", ONE), counterparty: HOT }],
  }
  /** A wallet whose first read never finishes while this is set. */
  let stuck: string | null = THIRD
  const source: Source = {
    mode: "raw",
    startBlock: 1,
    historyFrom: null,
    head: async () => ({ blockNum: 20, timestamp: "2026-11-04T00:00:00.000Z" }),
    processedThrough: async (_, head) => head,
    readWindow: async (address) => {
      while (address === stuck) await new Promise((resolve) => setTimeout(resolve, 20))
      return { rows: rows[address] ?? [], priced: null, gasUnknown: [] }
    },
    readReferences: async (blocks) => blocks.map((block_num) => ({ blockNum: block_num, ethUsd: "300000000000", usdcUsd: "100000000" })),
    readLatestReference: async () => ({ blockNum: 20, ethUsd: "400000000000", usdcUsd: "100000000" }),
    readEthBalances: async () => new Map(),
    readBalances: async (address, block) => {
      const amounts: Record<string, string> = Object.fromEntries(ASSETS.map((asset) => [asset, "0"]))
      for (const r of rows[address] ?? []) {
        if (r.block_num > block) continue
        const asset = r.token === USDC ? "USDC" : "ETH"
        amounts[asset] = (BigInt(amounts[asset] as string) + (r.side === "credit" ? BigInt(r.amount) : -BigInt(r.amount))).toString()
      }
      return { blockNum: block, amounts }
    },
  }
  let server: Server
  let base: string
  before(async () => {
    const api = createApi({}, { source, readRates: async () => ({ byBlock: {}, latest: null }), proofs: { datasets: async () => [], priceBehind: async () => null, currentPriceBehind: async () => null, readBlock: async () => null } })
    server = createServer((req, res) => void api(req, res))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(() => {
    stuck = null
    server.close()
  })
  const post = (path: string, body: unknown) => fetch(`${base}/api/portfolio/all${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

  it("answers with the wallets that are read, while a slow one is still reading", async () => {
    const started = Date.now()
    const all = (await (await post("", { method: "average", linked: [HOT, COLD, THIRD] })).json()) as CombinedPortfolioResponse
    assert.ok(Date.now() - started < 10_000)
    assert.equal(all.address, "all")
    assert.deepEqual(all.linkedReading, [THIRD])
    assert.deepEqual(all.wallets.map((w) => [w.address, w.state]), [[HOT, "read"], [COLD, "read"], [THIRD, "reading"]])
    const eth = all.positions.find((p) => p.asset === "ETH")
    // The move's cost carries over: 1 ETH that cost $3,000, now worth $4,000.
    assert.equal(eth?.values.costMicros, "3000000000")
    assert.equal(eth?.values.unrealizedMicros, "1000000000")
    assert.deepEqual(eth?.wallets.map((w) => w.wallet), [HOT, COLD])
  })

  it("explains, previews and exports across them", async () => {
    const explained = (await (await post("/explain?metric=pnl", { method: "average", linked: [HOT, COLD] })).json()) as { parts: { wallet: string }[] }
    assert.deepEqual(explained.parts.map((p) => p.wallet), [HOT, COLD])
    const previews = (await (await post("/preview", { method: "average", linked: [HOT, COLD], candidates: [{}] })).json()) as { previews: { pnlMicros: string }[] }
    assert.equal(previews.previews.length, 1)
    const csv = await (await post("/export", { method: "average", linked: [HOT, COLD] })).text()
    assert.match(csv.split("\n")[0] as string, /,wallet$/)
    assert.ok(csv.includes(COLD))
  })

  it("gives the browser the wallets to fold itself, and it comes to the same numbers", async () => {
    const body = { method: "average", linked: [HOT, COLD, THIRD] }
    const { wallets, unread } = (await (await post("/wallets", body)).json()) as AllYoursRead
    assert.deepEqual(wallets.map((w) => w.address.toLowerCase()), [HOT, COLD])
    assert.deepEqual(unread, { reading: [THIRD], failed: [] })
    const answered = (await (await post("", body)).json()) as CombinedPortfolioResponse
    const folded = combinedPortfolioOf(wallets, "average", emptyBook(), unread)
    assert.deepEqual(JSON.parse(JSON.stringify(folded)), answered)
  })

  it("reads the rates for what the browser's answers are in, without being sent them", async () => {
    const { wallets } = (await (await post("/wallets", { method: "average", linked: [HOT, COLD], paid: "CAD" })).json()) as AllYoursRead
    assert.ok(wallets.some((wallet) => wallet.paidRates?.CAD))
    assert.equal((await post("/wallets", { method: "average", linked: [HOT, COLD], paid: "CAD,XXX" })).status, 400)
  })

  it("only reads wallets together for all of them", async () => {
    assert.equal((await fetch(`${base}/api/portfolio/${HOT}/wallets`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404)
  })

  it("refuses what isn't a list of wallets, and comparing rules", async () => {
    assert.equal((await post("", { method: "average", linked: ["nope"] })).status, 400)
    assert.equal((await post("", { method: "average", linked: [] })).status, 400)
    assert.equal((await post("/compare", { method: "average", linked: [HOT] })).status, 400)
  })
})

describe("all your wallets, when one of them can't keep up", () => {
  const row = (block: number, tx: string, account: string, side: LegRow["side"], amount: bigint, counterparty: string | null = null): LegRow => ({
    block_num: block,
    timestamp: "2026-11-04T00:00:00.000Z",
    tx_hash: tx,
    tx_index: 0,
    log_index: 0,
    token: ETH_ADDRESS,
    account,
    side,
    amount: amount.toString(),
    counterparty,
    kind: "eth",
  })
  // Savings already has 1 ETH, from someone nobody's answered for. It moves to spending money at block 15.
  const before: Record<string, LegRow[]> = { [HOT]: [], [COLD]: [row(5, "0x1", COLD, "credit", ONE, STRANGER)] }
  const move = { [HOT]: [row(15, "0x2", HOT, "credit", ONE, COLD)], [COLD]: [row(15, "0x2", COLD, "debit", ONE, HOT)] }

  /** A server over wallets whose rows and head the test moves on, with `trouble` for what one wallet's read or rates, or the price at a block, run into. */
  function serve(trouble: { read?: (address: string) => Promise<void>; rates?: (address: string, block: number) => Promise<void>; reference?: () => Promise<void>; rollingHistory?: boolean; tokenReads?: string[]; maxWallets?: number }) {
    const state = { head: 10, rows: structuredClone(before) as Record<string, LegRow[]>, troubled: false }
    const source: Source = {
      mode: "raw",
      startBlock: trouble.rollingHistory ? null : 1,
      historyFrom: trouble.rollingHistory ? (head) => head : null,
      head: async () => ({ blockNum: state.head, timestamp: "2026-11-04T00:00:00.000Z" }),
      processedThrough: async (_, head) => head,
      readWindow: async (address, from, to) => {
        if (state.troubled) await trouble.read?.(address)
        return { rows: (state.rows[address] ?? []).filter((r) => r.block_num >= from && r.block_num <= to), priced: null, gasUnknown: [] }
      },
      readReferences: async (blocks) => blocks.map((block_num) => ({ blockNum: block_num, ethUsd: "300000000000", usdcUsd: "100000000" })),
      readLatestReference: async (head) => {
        if (state.troubled) await trouble.reference?.()
        return { blockNum: head, ethUsd: "300000000000", usdcUsd: "100000000" }
      },
      readEthBalances: async () => new Map(),
      readBalances: async (address, block) => {
        const amounts: Record<string, string> = Object.fromEntries(ASSETS.map((asset) => [asset, "0"]))
        for (const r of state.rows[address] ?? []) if (r.kind !== "unlisted" && r.block_num <= block) amounts.ETH = (BigInt(amounts.ETH as string) + (r.side === "credit" ? BigInt(r.amount) : -BigInt(r.amount))).toString()
        return { blockNum: block, amounts }
      },
      readTokenFacts: async (address, requests) => {
        trouble.tokenReads?.push(address)
        return new Map(requests.map(({ token }) => [token, { balance: "5", name: "Jackfruit", symbol: "JACK", decimals: 0 }]))
      },
    }
    // Rates are read for one wallet at a time, which the server doesn't say here, so it's told apart by its transactions.
    const readRates: RatesReader = async (_currency, wallet) => {
      if (state.troubled) await trouble.rates?.(wallet.legs.some((leg) => leg.txHash === "0x1") ? COLD : wallet.legs.some((leg) => leg.txHash === "0x2") ? HOT : THIRD, wallet.latest.blockNum)
      return { byBlock: {}, latest: null }
    }
    const api = createApi({}, { source, readRates, proofs: { datasets: async () => [], priceBehind: async () => null, currentPriceBehind: async () => null, readBlock: async () => null } }, null, { maxWallets: trouble.maxWallets })
    const server = createServer((req, res) => void api(req, res))
    const ready = new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)))
    const post = async (path: string, body: unknown) => (await fetch(`${await ready}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<CombinedPortfolioResponse>
    /** The move happens, and from then on the troubled wallet runs into its trouble. */
    const moveOn = () => {
      for (const [address, rows] of Object.entries(move)) state.rows[address]?.push(...rows)
      state.head = 20
      state.troubled = true
    }
    return { post, moveOn, state, close: () => server.close() }
  }
  const ethOf = (all: CombinedPortfolioResponse) => all.positions.find((p) => p.asset === "ETH")?.values.qty
  const stuck = () => new Promise<void>(() => {})
  const body = { method: "average", linked: [HOT, COLD] }

  /** Both wallets at block 10, where savings has the 1 ETH, and neither has its transactions' worth of the move. */
  const asLastRead = (all: CombinedPortfolioResponse) => all.positions.find((p) => p.asset === "ETH")?.wallets.map((w) => [w.wallet, w.qty])
  const beforeTheMove = [[COLD, ONE.toString()]]

  it("keeps a wallet in the total as it was last read when its read fails, with the others at that same block", async () => {
    const api = serve({ read: async (address) => (address === COLD ? Promise.reject(new Error("nope")) : undefined) })
    assert.equal(ethOf(await api.post("/api/portfolio/all", body)), ONE.toString())
    api.moveOn()
    const all = await api.post("/api/portfolio/all", body)
    // Savings' last read still has the ETH that's now in spending money, so spending money stays at that block too. Counting both would say 2 ETH.
    assert.deepEqual(asLastRead(all), beforeTheMove)
    assert.deepEqual(all.wallets.map((w) => [w.address, w.state]), [[HOT, "read"], [COLD, "outdated"]])
    assert.deepEqual([all.linkedOutdated, all.linkedUpdating, all.linkedFailed, all.linkedReading], [[COLD], [], [], []])
    assert.equal(all.coverage.toBlock, 10)
    // And what's already been read says so too.
    assert.deepEqual((await api.post("/api/portfolio/all/last", body)).linkedOutdated, [COLD])
    api.close()
  })

  it("gives the browser the same wallets, as it last read them", async () => {
    const api = serve({ read: async (address) => (address === COLD ? Promise.reject(new Error("nope")) : undefined) })
    await api.post("/api/portfolio/all/wallets", body)
    api.moveOn()
    const { wallets, unread } = (await api.post("/api/portfolio/all/wallets", body)) as unknown as AllYoursRead
    assert.deepEqual(wallets.map((w) => w.address.toLowerCase()), [HOT, COLD])
    assert.deepEqual(unread, { reading: [], failed: [], updating: [], outdated: [COLD] })
    assert.deepEqual(asLastRead(combinedPortfolioOf(wallets, "average", emptyBook(), unread)), beforeTheMove)
    api.close()
  })

  it("keeps a wallet in the total as it was last read while its read takes too long", async () => {
    let release = () => {}
    const api = serve({ read: async (address) => (address === COLD ? new Promise<void>((resolve) => (release = resolve)) : undefined) })
    await api.post("/api/portfolio/all", body)
    api.moveOn()
    const started = Date.now()
    const all = await api.post("/api/portfolio/all", body)
    assert.ok(Date.now() - started < 10_000)
    assert.deepEqual(asLastRead(all), beforeTheMove)
    assert.deepEqual(all.wallets.map((w) => [w.address, w.state]), [[HOT, "read"], [COLD, "updating"]])
    assert.deepEqual([all.linkedUpdating, all.linkedReading, all.linkedOutdated], [[COLD], [], []])
    // Once it's back, the move's there, once.
    release()
    const caughtUp = await api.post("/api/portfolio/all", body)
    assert.deepEqual(asLastRead(caughtUp), [[HOT, ONE.toString()], [COLD, "0"]])
    assert.deepEqual(caughtUp.wallets.map((w) => w.state), ["read", "read"])
    assert.deepEqual(caughtUp.linkedUpdating, [])
    api.close()
  })

  it("doesn't wait on every wallet being slow when it has a last answer", async () => {
    const api = serve({ read: stuck })
    await api.post("/api/portfolio/all", body)
    api.moveOn()
    const started = Date.now()
    const all = await api.post("/api/portfolio/all", body)
    assert.ok(Date.now() - started < 10_000)
    assert.deepEqual(asLastRead(all), beforeTheMove)
    assert.deepEqual(all.linkedUpdating.sort(), [HOT, COLD].sort())
    api.close()
  })

  it("keeps a wallet in the total when the server has forgotten it, as memory running short does", async () => {
    const api = serve({ maxWallets: 1 })
    await api.post("/api/portfolio/all", body)
    const last = await api.post("/api/portfolio/all/last", body)
    assert.equal(ethOf(last), ONE.toString())
    assert.deepEqual([last.linkedUpdating, last.linkedReading], [[HOT], []])
    assert.deepEqual(last.wallets.map((w) => w.state), ["updating", "read"])
    api.close()
  })

  it("adds a wallet's first read without taking anything away", async () => {
    const api = serve({ read: async (address) => (address === THIRD ? stuck() : undefined) })
    const linked = [HOT, COLD, THIRD]
    api.state.troubled = true
    await api.post("/api/portfolio/all", { ...body, linked })
    api.moveOn()
    const all = await api.post("/api/portfolio/all", { ...body, linked })
    assert.deepEqual([all.linkedReading, all.linkedUpdating], [[THIRD], []], "it's never been in the numbers, so nothing's held back for it")
    assert.deepEqual(asLastRead(all), [[HOT, ONE.toString()], [COLD, "0"]])
    api.close()
  })

  it("keeps out a wallet that's only just been read when the others have to stay where they were", async () => {
    let waitingOn = THIRD
    const api = serve({ read: async (address) => (address === waitingOn ? stuck() : undefined) })
    const linked = [HOT, COLD, THIRD]
    api.state.troubled = true
    await api.post("/api/portfolio/all", { ...body, linked })
    api.moveOn()
    waitingOn = COLD
    const all = await api.post("/api/portfolio/all", { ...body, linked })
    assert.deepEqual(all.wallets.map((w) => [w.address, w.state]), [[HOT, "read"], [COLD, "updating"], [THIRD, "reading"]])
    assert.deepEqual(asLastRead(all), beforeTheMove)
    api.close()
  })

  it("doesn't keep a preview's answer, whose rates are for answers the user hasn't given", async () => {
    const api = serve({ read: async (address) => (address === COLD ? stuck() : undefined) })
    for (const address of [HOT, COLD]) await api.post(`/api/portfolio/${address}`, { method: "average" })
    await api.post("/api/portfolio/all/preview", { ...body, candidates: [{}] })
    api.moveOn()
    const all = await api.post("/api/portfolio/all", body)
    assert.deepEqual([all.linkedReading, all.linkedUpdating], [[COLD], []])
    api.close()
  })

  it("reads every wallet at the same block, so a move is never in both", async () => {
    const api = serve({})
    await api.post("/api/portfolio/all", body)
    api.moveOn()
    // Spending money alone has read past the move. Savings was last read before it.
    await api.post(`/api/portfolio/${HOT}`, { method: "average" })
    const last = await api.post("/api/portfolio/all/last", body)
    assert.equal(ethOf(last), ONE.toString())
    assert.deepEqual(last.wallets.map((w) => w.state), ["read", "read"])
    // Once both have read it, the move's there, once.
    const all = await api.post("/api/portfolio/all", body)
    assert.deepEqual(all.positions.find((p) => p.asset === "ETH")?.wallets.map((w) => [w.wallet, w.qty]), [[HOT, ONE.toString()], [COLD, "0"]])
    api.close()
  })

  describe("with a token we have no price for", () => {
    const JACK = "0x00000000000000000000000000000000000000f1"
    const jack = (account: string, block_num: number, side: LegRow["side"] = "credit"): LegRow => ({ block_num, timestamp: "2026-11-04T00:00:00.000Z", tx_hash: `0xjack${block_num}`, tx_index: 0, log_index: 0, token: JACK, account, side, amount: "5", kind: "unlisted", counterparty: null }) as LegRow
    const tokenReadsFinish = () => new Promise((resolve) => setTimeout(resolve, 20))
    const jackOf = (all: CombinedPortfolioResponse) => all.otherTokens.map((t) => [t.token, t.state, t.balance])
    /** Both hold it and have been read. Spending money then reads past the move by itself, so All Yours takes it back to savings' block. */
    async function aligned(afterMove: readonly LegRow[] = []) {
      const api = serve({})
      for (const address of [HOT, COLD]) api.state.rows[address]?.push(jack(address, 5))
      await api.post("/api/portfolio/all", body)
      await tokenReadsFinish()
      api.moveOn()
      api.state.rows[HOT]?.push(...afterMove)
      await api.post(`/api/portfolio/${HOT}`, { method: "average" })
      await tokenReadsFinish()
      return api
    }

    it("keeps it when one wallet is taken back to an earlier block", async () => {
      const api = await aligned()
      assert.deepEqual(jackOf(await api.post("/api/portfolio/all/last", body)), [[JACK, "read", "10"]])
      api.close()
    })

    it("has no sum when it moved between that block and the read", async () => {
      const api = await aligned([jack(HOT, 15, "debit")])
      assert.deepEqual(jackOf(await api.post("/api/portfolio/all/last", body)), [[JACK, "reading", null]])
      api.close()
    })

    it("fills in every wallet from refreshes of them all, with no wallet opened by itself", async () => {
      const tokenReads: string[] = []
      const api = serve({ tokenReads })
      for (const address of [HOT, COLD]) api.state.rows[address]?.push(jack(address, 5))
      for (let refresh = 0; refresh < 3; refresh++) {
        api.state.head += 1
        await api.post("/api/portfolio/all", body)
        await tokenReadsFinish()
      }
      assert.deepEqual([...new Set(tokenReads)].sort(), [COLD, HOT].sort())
      assert.ok(tokenReads.length <= 2 * 2 * 3, "at most two queries for each wallet read")
      assert.deepEqual(jackOf(await api.post("/api/portfolio/all/last", body)), [[JACK, "read", "10"]])
      api.close()
    })
  })

  it("leaves out a wallet whose rates fail or take too long, and answers with the rest", async () => {
    const failing = serve({ rates: async (address) => (address === COLD ? Promise.reject(new Error("no rate")) : undefined) })
    failing.moveOn()
    const failed = await failing.post("/api/portfolio/all", { ...body, currency: "CAD" })
    assert.deepEqual([failed.currency, failed.linkedFailed, failed.linkedReading], ["CAD", [COLD], []])
    failing.close()
    const slow = serve({ rates: async (address) => (address === COLD ? stuck() : undefined) })
    slow.moveOn()
    const started = Date.now()
    const waiting = await slow.post("/api/portfolio/all", { ...body, currency: "CAD" })
    assert.ok(Date.now() - started < 10_000)
    assert.deepEqual([waiting.linkedReading, waiting.linkedFailed], [[COLD], []])
    slow.close()
  })

  /** Spending money and any others have read past the move, in their own requests, and savings was last read before it. Only then does `trouble` start. */
  async function behindTheMove(trouble: Parameters<typeof serve>[0], others: readonly string[], arm: () => void) {
    const api = serve(trouble)
    await api.post("/api/portfolio/all", body)
    api.moveOn()
    for (const address of [HOT, ...others]) await api.post(`/api/portfolio/${address}`, { method: "average" })
    arm()
    return api
  }

  it("keeps out a wallet that finishes while the others are being taken to the same block", async () => {
    let armed = false
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const api = await behindTheMove(
      {
        // The third wallet is what's being taken back to block 10, for as long as spending money's rates are still coming.
        reference: async () => (armed ? wait(700) : undefined),
        rates: async (address) => (armed && address === HOT ? wait(2_700) : undefined),
      },
      [THIRD],
      () => (armed = true),
    )
    const last = await api.post("/api/portfolio/all/last", { ...body, currency: "CAD", linked: [HOT, COLD, THIRD] })
    // Spending money at block 20 has the ETH that savings still has at block 10. These three have no last answer together to fall back on.
    assert.equal(ethOf(last), ONE.toString())
    assert.deepEqual([last.linkedReading, last.linkedFailed], [[HOT], []])
    assert.deepEqual(last.wallets.map((w) => [w.address, w.state]), [[COLD, "read"], [THIRD, "read"], [HOT, "reading"]])
    api.close()
  })

  it("answers with the oldest wallet when the price at its block takes too long", async () => {
    let armed = false
    const api = await behindTheMove({ reference: async () => (armed ? stuck() : undefined) }, [], () => (armed = true))
    const started = Date.now()
    const last = await api.post("/api/portfolio/all/last", body)
    assert.ok(Date.now() - started < 10_000)
    assert.equal(ethOf(last), ONE.toString())
    assert.deepEqual([last.linkedUpdating, last.linkedReading, last.linkedFailed], [[HOT], [], []], "its last answer stands")
    assert.deepEqual(asLastRead(last), beforeTheMove)
    api.close()
  })

  it("says a wallet failed when it can't be taken to the same block", async () => {
    let failing: "price" | "rates" | null = null
    const api = await behindTheMove(
      {
        reference: async () => (failing === "price" ? Promise.reject(new Error("no price")) : undefined),
        // Spending money's rates are fine at the block it's at, and only fail at the one it's taken back to.
        rates: async (address, block) => (failing === "rates" && address !== COLD && block === 10 ? Promise.reject(new Error("no rate")) : undefined),
      },
      [],
      () => {},
    )
    for (const trouble of ["price", "rates"] as const) {
      failing = trouble
      const last = await api.post("/api/portfolio/all/last", { ...body, currency: "CAD" })
      assert.equal(ethOf(last), ONE.toString())
      // In this currency, these wallets have no last answer to fall back on.
      assert.deepEqual([last.linkedFailed, last.linkedReading], [[HOT], []], trouble)
    }
    failing = "price"
    const last = await api.post("/api/portfolio/all/last", body)
    assert.deepEqual(asLastRead(last), beforeTheMove)
    assert.deepEqual([last.linkedOutdated, last.linkedFailed, last.linkedReading], [[HOT], [], []])
    api.close()
  })

  it("says a wallet failed when its history starts after that block", async () => {
    const api = serve({ rollingHistory: true })
    await api.post(`/api/portfolio/${COLD}`, { method: "average" })
    api.moveOn()
    // Spending money's first read is after the move, so its history starts there.
    await api.post(`/api/portfolio/${HOT}`, { method: "average" })
    const last = await api.post("/api/portfolio/all/last", body)
    assert.equal(ethOf(last), ONE.toString())
    assert.deepEqual([last.linkedFailed, last.linkedReading], [[HOT], []])
    api.close()
  })
})
