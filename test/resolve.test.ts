import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { verifyLink } from "../server/links.ts"
import { explainPortfolio, portfolioOf } from "../server/portfolio.ts"
import { ETH_ADDRESS, USDC_ADDRESS, buildPricedLegs, openingLegs, type LegRow, type Method, type ReferenceRow } from "@pricetag/sdk/core"
import type { WalletResponse } from "../src/core/api.ts"
import { answerSender, costKey, emptyBook, linkMessage, parseBook, type Book, type Money, type SenderAnswer } from "../src/core/book.ts"
import { matchWithdrawal, parseCoinbaseCsv } from "../src/core/exchange-import.ts"
import { exportCsv } from "../src/core/export.ts"
import { DEMO_ADDRESS, DEMO_SAVINGS_ADDRESS, DEMO_SAVINGS_WALLET, DEMO_WALLET, demoRates } from "../src/core/fixtures.ts"
import { encodeNote, parseNote } from "../src/core/notes.ts"
import { foldBook } from "../src/core/resolve.ts"

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`
const [A, B, C, STRANGER] = [addr(0xa1), addr(0xb1), addr(0xc1), addr(0xd1)] as [string, string, string, string]
const AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631"
const COINBASE = "0x71660c4005ba85c37ccec55d0c4493e66fe775d3"
const ACROSS = "0x09aea4b2242abc8bb4bb78d537a67a245a7bec64"
const MINT = "0x0000000000000000000000000000000000000000"
const E18 = 10n ** 18n
const E6 = 10n ** 6n

const references = (blocks: number[]): ReferenceRow[] => blocks.map((block_num) => ({ block_num, eth_usd: "200000000000", usdc_usd: "100000000" }))

const move = (block: number, tx: string, account: string, side: LegRow["side"], amount: bigint, counterparty: string | null, token = USDC_ADDRESS): LegRow => ({
  block_num: block,
  timestamp: new Date(Date.UTC(2026, 10, 4) + block * 1000).toISOString(),
  tx_hash: tx,
  tx_index: 1,
  log_index: 0,
  token,
  account,
  side,
  amount: amount.toString(),
  kind: token === ETH_ADDRESS ? "eth" : "erc20",
  ...(counterparty ? { counterparty } : {}),
})

/** Both sides of a transfer between two wallets, so each can be read as its own wallet. */
const send = (block: number, tx: string, from: string, to: string, amount: bigint, token = USDC_ADDRESS) => [move(block, tx, from, "debit", amount, to, token), move(block, tx, to, "credit", amount, from, token)]

/** USDC bought with ETH at the feed's $2,000, so its cost is what was paid. */
const buy = (block: number, tx: string, account: string, usdc: bigint) => [move(block, tx, account, "debit", (E18 * usdc) / 2000n, null, ETH_ADDRESS), move(block, tx, account, "credit", usdc * E6, null)]

function wallet(address: string, rows: LegRow[], changes: Partial<WalletResponse> = {}): WalletResponse {
  const mine = rows.filter((r) => r.account === address)
  const refs = references([...new Set(rows.map((r) => r.block_num))])
  const legs = [...(changes.legs ?? []), ...buildPricedLegs({ account: address, rows: mine, references: refs, priced: [] })]
  // Balances that match its legs, so nothing here is also about the onchain check.
  const amounts: Record<string, string> = {}
  for (const leg of legs) amounts[leg.asset] = (BigInt(amounts[leg.asset] ?? 0) + BigInt(leg.delta)).toString()
  return {
    address,
    mode: "demo",
    coverage: { fromBlock: 1, toBlock: 100 },
    references: refs,
    prices: { USDC: { micros: "1000000", source: "oracle", blockNum: 100 }, ETH: { micros: "2000000000", source: "oracle", blockNum: 100 } },
    latest: { blockNum: 100, timestamp: "2026-11-04T00:10:00.000Z" },
    currency: "USD",
    rates: null,
    gasUnknownTxs: [],
    l1FeeUnknownTxs: [],
    balances: { blockNum: 100, amounts },
    openingUnread: [],
    lastBalances: {},
    unreadBalances: [],
    notes: [],
    marketChecked: true,
    unlistedTokens: [],
    ...changes,
    legs,
  }
}

const usd = (micros: string): Money => ({ micros, currency: "USD" })
const book = (senders: Record<string, SenderAnswer> = {}, costs: Record<string, string> = {}): Book => ({ senders, costs: Object.fromEntries(Object.entries(costs).map(([key, micros]) => [key, usd(micros)])), withdrawals: [] })

const position = (focus: WalletResponse, others: WalletResponse[], b: Book, asset = "USDC", method: Method = "average") => foldBook(focus, others, method, b).positions.find((p) => p.asset === asset)!

describe("the cost of an incoming leg", () => {
  it("paid: what the wallet paid in the same transaction, untouched by any answer", () => {
    const rows = buy(10, "0x1", A, 1000n)
    const usdc = position(wallet(A, rows), [], book({ [A]: { kind: "someone-else" } }))
    assert.equal(usdc.effects[0]?.leg.costLabel, "paid")
    assert.equal(usdc.values.costMicros, "1000000000")
    assert.equal(usdc.estimates.cost, false)
  })

  describe("inherited", () => {
    const rows = [...buy(10, "0x1", A, 1000n), ...send(20, "0x2", A, B, 1000n * E6)]

    it("carries over what the linked sender paid, and isn't an estimate", () => {
      const usdc = position(wallet(B, rows), [wallet(A, rows)], book({ [A]: { kind: "mine" } }))
      assert.equal(usdc.effects[0]?.leg.costLabel, "inherited")
      assert.equal(usdc.values.costMicros, "1000000000")
      assert.equal(usdc.estimates.cost, false)
    })

    it("needs the link: without it the cost stays unknown, even with the sender's wallet read", () => {
      const usdc = position(wallet(B, rows), [wallet(A, rows)], emptyBook())
      assert.equal(usdc.values.costMicros, null)
      assert.equal(usdc.effects[0]?.leg.costLabel, "unknown")
    })

    it("stays unknown while the linked wallet hasn't been read", () => {
      const fold = foldBook(wallet(B, rows), [], "average", book({ [A]: { kind: "mine" } }))
      assert.equal(fold.positions[0]?.values.costMicros, null)
      assert.deepEqual(fold.questions, [], "the answer's already in, so there's nothing to ask")
    })

    it("follows a chain of linked wallets", () => {
      const chain = [...rows, ...send(30, "0x3", B, C, 400n * E6)]
      const usdc = position(wallet(C, chain), [wallet(A, chain), wallet(B, chain)], book({ [A]: { kind: "mine" }, [B]: { kind: "mine" } }))
      assert.equal(usdc.values.costMicros, "400000000")
      assert.equal(usdc.effects[0]?.leg.costLabel, "inherited")
    })

    it("keeps each lot's acquisition date, so oldest-first sells what was really bought first", () => {
      const moved = [
        ...buy(10, "0x1", A, 1000n),
        ...buy(20, "0x2", B, 2000n),
        ...send(30, "0x3", A, B, 1000n * E6),
      ]
      const usdc = position(wallet(B, moved), [wallet(A, moved)], book({ [A]: { kind: "mine" } }), "USDC", "fifo")
      const lots = usdc.state.lots.map((l) => [l.acquiredBlock, l.qty])
      assert.deepEqual(lots, [[10, (1000n * E6).toString()], [20, (2000n * E6).toString()]], "the inherited lot goes first, though it arrived last")
      assert.equal(usdc.state.lots[0]?.acquiredAt, new Date(Date.UTC(2026, 10, 4) + 10 * 1000).toISOString())
    })

    it("gives the same totals by either method when everything carries over whole", () => {
      for (const method of ["average", "fifo"] as const) {
        const usdc = position(wallet(B, rows), [wallet(A, rows)], book({ [A]: { kind: "mine" } }), "USDC", method)
        assert.equal(usdc.values.costMicros, "1000000000")
      }
    })

    it("keeps a transfer of partly unresolved tokens partly unresolved", () => {
      // A held 500 at an unknown cost, bought 1,000 for $1,000, and sent 900 of its 1,500.
      const opening = openingLegs({ blockNum: 0, amounts: { USDC: (500n * E6).toString() } }, "2026-11-03T23:59:00.000Z")
      const moved = [...buy(10, "0x1", A, 1000n), ...send(20, "0x2", A, B, 900n * E6)]
      const a = wallet(A, moved, { legs: opening })
      const usdc = position(wallet(B, moved), [a], book({ [A]: { kind: "mine" } }))
      assert.equal(usdc.values.qty, (900n * E6).toString())
      assert.equal(usdc.values.unknownCostQty, (300n * E6).toString(), "a third of A's USDC had no known cost")
      assert.equal(usdc.values.costMicros, null, "the whole position's cost is unavailable, not just part of it")
      assert.equal(usdc.values.unrealizedMicros, null)
      assert.equal(usdc.state.lots.find((l) => l.costMicros !== null)?.costMicros, "600000000")
    })

    it("resolves downstream once the upstream cost is answered", () => {
      const opening = openingLegs({ blockNum: 0, amounts: { USDC: (500n * E6).toString() } }, "2026-11-03T23:59:00.000Z")
      const moved = send(20, "0x2", A, B, 500n * E6)
      const a = wallet(A, moved, { legs: opening })
      const linked = book({ [A]: { kind: "mine" } })
      assert.equal(position(wallet(B, moved), [a], linked).values.costMicros, null)
      const answered = book({ [A]: { kind: "mine" } }, { [costKey(A, "opening:USDC")]: "450000000" })
      assert.equal(position(wallet(B, moved), [a], answered).values.costMicros, "450000000")
    })

    it("carries an estimate along as an estimate, and an upstream shortfall as unknown", () => {
      const moved = [...send(10, "0x1", STRANGER, A, 100n * E6), ...send(20, "0x2", A, B, 100n * E6)]
      const answers = book({ [A]: { kind: "mine" }, [STRANGER]: { kind: "someone-else" } })
      const usdc = position(wallet(B, moved), [wallet(A, moved)], answers)
      assert.equal(usdc.effects[0]?.leg.costLabel, "inherited")
      assert.equal(usdc.estimates.cost, true)
      assert.equal(usdc.values.estimatedCostMicros, "100000000")

      const short = send(20, "0x2", A, B, 100n * E6)
      const carried = position(wallet(B, short), [wallet(A, short)], book({ [A]: { kind: "mine" } }))
      assert.equal(carried.values.unknownCostQty, (100n * E6).toString())
    })

    it("carries what one transaction sent to two wallets between them, without double-counting", () => {
      const split = [...buy(10, "0x1", A, 1000n), move(20, "0x2", A, "debit", 600n * E6, B), move(20, "0x2", A, "debit", 400n * E6, C), move(20, "0x2", B, "credit", 600n * E6, A), move(20, "0x2", C, "credit", 400n * E6, A)]
      const answers = book({ [A]: { kind: "mine" } })
      const a = wallet(A, split)
      const b = position(wallet(B, split), [a], answers)
      assert.equal(b.values.costMicros, "600000000")
    })

    it("realizes a gain on what was inherited, from the cost it inherited", () => {
      const moved = [...buy(10, "0x1", A, 1000n), ...send(20, "0x2", A, B, 1000n * E6)]
      const usdc = position(wallet(B, moved, { prices: { USDC: { micros: "1100000", source: "oracle", blockNum: 100 } } }), [wallet(A, moved)], book({ [A]: { kind: "mine" } }))
      assert.equal(usdc.values.unrealizedMicros, "100000000")
    })
  })

  describe("self-reported", () => {
    const rows = send(10, "0x1", STRANGER, A, 100n * E6)
    const note = { noteTx: "0xn", blockNum: 20, txHash: "0x1", asset: "USDC", usdMicros: "80000000" }

    it("uses the wallet's own note", () => {
      const usdc = position(wallet(A, rows, { notes: [note] }), [], emptyBook())
      assert.equal(usdc.effects[0]?.leg.costLabel, "self-reported")
      assert.equal(usdc.values.costMicros, "80000000")
    })

    it("uses a local entry, which beats a note, because the user can correct it", () => {
      const usdc = position(wallet(A, rows, { notes: [note] }), [], book({}, { [costKey(A, "0x1:USDC")]: "70000000" }))
      assert.equal(usdc.values.costMicros, "70000000")
    })

    it("beats received at market", () => {
      const usdc = position(wallet(A, rows, { notes: [note] }), [], book({ [STRANGER]: { kind: "someone-else" } }))
      assert.equal(usdc.effects[0]?.leg.costLabel, "self-reported")
      assert.equal(usdc.estimates.cost, false)
    })

    it("loses to inherited, but fills in when nothing could be inherited", () => {
      const moved = [...buy(5, "0x0", STRANGER, 100n), ...send(10, "0x1", STRANGER, A, 100n * E6)]
      const linked = book({ [STRANGER]: { kind: "mine" } })
      assert.equal(position(wallet(A, moved, { notes: [note] }), [wallet(STRANGER, moved)], linked).effects[0]?.leg.costLabel, "inherited")
      assert.equal(position(wallet(A, rows, { notes: [note] }), [wallet(STRANGER, rows)], linked).effects[0]?.leg.costLabel, "self-reported")
    })

    it("reads a note, and refuses anything else", () => {
      const hash = `0x${"ab".repeat(32)}`
      assert.deepEqual(parseNote(encodeNote(hash, "USDC", "80000000")), { txHash: hash, asset: "USDC", usdMicros: "80000000" })
      for (const bad of ["", "0x", "0xzz", "0x1", encodeNote("0x1", "USDC", "1"), encodeNote(hash, "USDC", "-1"), `0x${"00".repeat(300)}`]) assert.equal(parseNote(bad), null, bad)
    })
  })

  describe("received at market", () => {
    const rows = send(10, "0x1", STRANGER, A, 100n * E6)

    it("applies once it's someone else, at the price then, and is always an estimate", () => {
      const usdc = position(wallet(A, rows), [], book({ [STRANGER]: { kind: "someone-else" } }))
      assert.equal(usdc.effects[0]?.leg.costLabel, "received at market")
      assert.equal(usdc.values.costMicros, "100000000")
      assert.equal(usdc.estimates.cost, true)
      assert.equal(usdc.estimates.unrealized, true)
    })

    it("can't apply with no price, so it stays unknown", () => {
      const spam = send(10, "0x1", STRANGER, A, E18, AERO)
      const aero = position(wallet(A, spam), [], book({ [STRANGER]: { kind: "someone-else" } }), "AERO")
      assert.equal(aero.effects[0]?.leg.costLabel, "unknown")
      assert.equal(aero.values.costMicros, null)
    })
  })

  describe("unknown", () => {
    it("is never assumed away: an unanswered sender stays unknown, however likely the answer", () => {
      const rows = [...send(5, "0x0", A, STRANGER, 10n * E6), ...send(10, "0x1", STRANGER, A, 100n * E6)]
      const fold = foldBook(wallet(A, rows), [], "average", emptyBook())
      assert.equal(fold.positions[0]?.effects.at(-1)?.leg.costLabel, "unknown")
      assert.equal(fold.positions[0]?.values.costMicros, null)
    })

    it("is never $0: it stays out of totals, and the total says how much that is", () => {
      const rows = send(10, "0x1", STRANGER, A, 100n * E6)
      const { totals, pnlStatus } = foldBook(wallet(A, rows), [], "average", emptyBook())
      assert.equal(totals.pnlMicros, null)
      assert.equal(pnlStatus, "unavailable")
      assert.equal(totals.unresolvedMicros, "100000000")
    })

    it("a sale of what has an unknown cost has no realized PnL", () => {
      const rows = [...send(10, "0x1", STRANGER, A, 100n * E6), move(20, "0x2", A, "debit", 100n * E6, null), move(20, "0x2", A, "credit", E18 / 20n, null, ETH_ADDRESS)]
      const usdc = position(wallet(A, rows), [], emptyBook())
      assert.equal(usdc.values.realizedMicros, null)
    })
  })
})

describe("in another currency", () => {
  /** 1 CAD = 0.75 USD at every block, so 1 USD = 1.333333 CAD. */
  const rates = (blocks: number[]) => ({ byBlock: Object.fromEntries(blocks.map((b) => [b, { answer: "75000000", updatedAt: Date.UTC(2026, 10, 4) / 1000 }])), latest: { blockNum: 100, round: { answer: "75000000", updatedAt: Date.UTC(2026, 10, 4) / 1000 } } })
  const cad = (address: string, rows: LegRow[], changes: Partial<WalletResponse> = {}) => wallet(address, rows, { currency: "CAD", rates: rates([...new Set(rows.map((r) => r.block_num))]), ...changes })

  it("carries a cost between wallets in the currency it's reported in", () => {
    const rows = [...buy(10, "0x1", A, 750n), ...send(20, "0x2", A, B, 750n * E6)]
    const usdc = position(cad(B, rows), [cad(A, rows)], book({ [A]: { kind: "mine" } }))
    assert.equal(usdc.effects[0]?.leg.costLabel, "inherited")
    assert.equal(usdc.values.costMicros, "1000000000", "$750 USD at 0.75")
  })

  it("values what's received at market at the rate then", () => {
    const usdc = position(cad(A, send(10, "0x1", STRANGER, A, 75n * E6)), [], book({ [STRANGER]: { kind: "someone-else" } }))
    assert.equal(usdc.values.costMicros, "99999975", "75 at the feed's $1, which is $1.333333 CAD each")
  })

  it("keeps a cost entered in CAD as CAD, and converts one entered in USD", () => {
    const rows = send(10, "0x1", STRANGER, A, 100n * E6)
    const entered = (money: Money): Book => ({ ...emptyBook(), costs: { [costKey(A, "0x1:USDC")]: money } })
    assert.equal(position(cad(A, rows), [], entered({ micros: "90000000", currency: "CAD" })).values.costMicros, "90000000")
    assert.equal(position(cad(A, rows), [], entered(usd("75000000"))).values.costMicros, "100000000")
  })

  it("converts a note, which is always in USD", () => {
    const rows = send(10, "0x1", STRANGER, A, 100n * E6)
    const notes = [{ noteTx: "0xn", blockNum: 20, txHash: "0x1", asset: "USDC", usdMicros: "75000000" }]
    assert.equal(position(cad(A, rows, { notes }), [], emptyBook()).values.costMicros, "100000000")
  })

  it("never reads a CAD cost as USD: with no rate, it stays unknown", () => {
    const rows = send(10, "0x1", STRANGER, A, 100n * E6)
    const entered: Book = { ...emptyBook(), costs: { [costKey(A, "0x1:USDC")]: { micros: "90000000", currency: "CAD" } } }
    const usdc = position(wallet(A, rows), [], entered)
    assert.equal(usdc.effects[0]?.leg.costLabel, "unknown")
    assert.equal(usdc.values.costMicros, null)
  })

  it("gives the USD side of a CAD wallet its own folded answers", () => {
    const rows = send(10, "0x1", STRANGER, A, 100n * E6)
    const entered: Book = { ...emptyBook(), costs: { [costKey(A, "0x1:USDC")]: { micros: "120000000", currency: "CAD" } } }
    const side = foldBook(cad(A, rows), [], "average", entered, { usd: true })
    assert.equal(side.view.currency, "USD")
    assert.equal(side.positions[0]?.values.costMicros, "90000000", "$120 CAD at 0.75")
  })

  it("explains the demo in CAD with an answer in, with both sides agreeing it's known", () => {
    const cadDemo = { ...DEMO_WALLET, currency: "CAD" as const, rates: demoRates("CAD") }
    const answered = answerSender(emptyBook(), DEMO_ADDRESS, "0x000000000000000000000000000000000000be11", { kind: "someone-else" })
    const explained = explainPortfolio(cadDemo, "average", { kind: "asset", asset: "ETH", metric: "unrealized" }, [], answered)!
    assert.equal(explained.currency, "CAD")
    assert.ok(explained.value)
    assert.ok(explained.sourceValue, "the USD side knows it too")
  })
})

describe("each kind of sender", () => {
  const question = (rows: LegRow[], b: Book = emptyBook()) => foldBook(wallet(A, rows), [], "average", b).questions

  it("an own wallet gets evidence, never a preselected answer, and isn't assumed", () => {
    const rows = [...send(5, "0x0", A, B, 2n * E6), ...send(10, "0x1", B, A, 100n * E6)]
    const [q] = question(rows)
    assert.equal(q?.sender, B)
    assert.deepEqual(q?.evidence, ["You sent this address 2 USDC on Nov 4"])
    assert.equal(foldBook(wallet(A, rows), [], "average", emptyBook()).positions[0]?.effects.at(-1)?.leg.costLabel, "unknown")
  })

  it("a known exchange only says where it came from, and whose it was stays a question", () => {
    const rows = send(10, "0x1", COINBASE, A, 100n * E6)
    const [q] = question(rows)
    assert.deepEqual(q?.evidence, ["From a Coinbase address"])
    assert.equal(q?.known?.kind, "exchange")
    assert.equal(position(wallet(A, rows), [], emptyBook()).values.costMicros, null)
  })

  it("my exchange account asks for the cost, and stays open until it has one", () => {
    const rows = send(10, "0x1", COINBASE, A, 100n * E6)
    const asked = book({ [COINBASE]: { kind: "my-exchange" } })
    assert.equal(question(rows, asked)[0]?.needsCost, true)
    assert.equal(position(wallet(A, rows), [], asked).values.costMicros, null)

    const told = book({ [COINBASE]: { kind: "my-exchange", costs: { USDC: usd("90000000") } } })
    assert.deepEqual(question(rows, told), [])
    const usdc = position(wallet(A, rows), [], told)
    assert.equal(usdc.effects[0]?.leg.costLabel, "self-reported")
    assert.equal(usdc.values.costMicros, "90000000")
  })

  it("splits an exchange's total across its transfers by size", () => {
    const rows = [...send(10, "0x1", COINBASE, A, 300n * E6), ...send(20, "0x2", COINBASE, A, 100n * E6)]
    const usdc = position(wallet(A, rows), [], book({ [COINBASE]: { kind: "my-exchange", costs: { USDC: usd("400000000") } } }))
    assert.deepEqual(usdc.effects.map((e) => e.leg.costMicros), ["300000000", "100000000"])
  })

  it("someone else's exchange account is just someone else", () => {
    const usdc = position(wallet(A, send(10, "0x1", COINBASE, A, 100n * E6)), [], book({ [COINBASE]: { kind: "someone-else" } }))
    assert.equal(usdc.effects[0]?.leg.costLabel, "received at market")
  })

  it("a bridge defaults to received at market, with nothing to ask", () => {
    const rows = send(10, "0x1", ACROSS, A, 100n * E6)
    assert.deepEqual(question(rows), [])
    const usdc = position(wallet(A, rows), [], emptyBook())
    assert.equal(usdc.effects[0]?.leg.costLabel, "received at market")
    assert.equal(usdc.estimates.cost, true)
  })

  it("the user can still recategorize a bridge's transfer", () => {
    const usdc = position(wallet(A, send(10, "0x1", ACROSS, A, 100n * E6)), [], book({ [ACROSS]: { kind: "my-exchange", costs: { USDC: usd("95000000") } } }))
    assert.equal(usdc.effects[0]?.leg.costLabel, "self-reported")
  })

  it("a mint can't be anyone's wallet, so there's nothing to ask", () => {
    assert.deepEqual(question(send(10, "0x1", MINT, A, 100n * E6)), [])
  })
})

describe("asking as little as possible", () => {
  it("asks once per address, however many transfers", () => {
    const rows = [...send(10, "0x1", STRANGER, A, 100n * E6), ...send(20, "0x2", STRANGER, A, 50n * E6), ...send(30, "0x3", STRANGER, A, E18, ETH_ADDRESS)]
    const questions = foldBook(wallet(A, rows), [], "average", emptyBook()).questions
    assert.equal(questions.length, 1)
    assert.equal(questions[0]?.transfers, 3)
    assert.deepEqual(questions[0]?.arrivals.map((a) => [a.asset, a.units]).sort(), [["ETH", E18.toString()], ["USDC", (150n * E6).toString()]])
  })

  it("asks the most useful question first", () => {
    const rows = [...send(10, "0x1", STRANGER, A, E6), ...send(20, "0x2", C, A, 900n * E6)]
    assert.deepEqual(foldBook(wallet(A, rows), [], "average", emptyBook()).questions.map((q) => q.sender), [C, STRANGER])
  })

  it("doesn't ask about a token with no market anywhere", () => {
    assert.deepEqual(foldBook(wallet(A, send(10, "0x1", STRANGER, A, E18, AERO)), [], "average", emptyBook()).questions, [])
  })

  it("does ask when it can't tell there's no market, because the read failed", () => {
    assert.equal(foldBook(wallet(A, send(10, "0x1", STRANGER, A, E18, AERO), { marketChecked: false }), [], "average", emptyBook()).questions.length, 1)
  })

  it("asks what something cost when there's no sender to ask about", () => {
    const opening = openingLegs({ blockNum: 0, amounts: { USDC: (500n * E6).toString() } }, "2026-11-03T23:59:00.000Z")
    const [q] = foldBook(wallet(A, [], { legs: opening }), [], "average", emptyBook()).questions
    assert.equal(q?.kind, "cost")
    assert.equal(q?.costKey, costKey(A, "opening:USDC"))
  })

  it("links the wallet you're looking at too, when you say a sender's yours", () => {
    const answered = answerSender(emptyBook(), A, B, { kind: "mine" })
    assert.deepEqual(Object.keys(answered.senders).sort(), [A, B].sort())
    assert.deepEqual(answerSender(emptyBook(), "demo", B, { kind: "mine" }).senders, { [B]: { kind: "mine" } })
  })

  it("the meter drops with each answer, and counts what's answered", () => {
    const rows = [...send(10, "0x1", STRANGER, A, 100n * E6), ...send(20, "0x2", C, A, 50n * E6)]
    const before = foldBook(wallet(A, rows), [], "average", emptyBook()).meter
    assert.deepEqual(before, { open: 2, answered: 0 })
    const after = foldBook(wallet(A, rows), [], "average", book({ [STRANGER]: { kind: "someone-else" } })).meter
    assert.deepEqual(after, { open: 1, answered: 1 })
    assert.deepEqual(foldBook(wallet(A, rows), [], "average", book({ [STRANGER]: { kind: "someone-else" }, [C]: { kind: "someone-else" } })).meter, { open: 0, answered: 2 })
  })
})

describe("an imported Coinbase history", () => {
  const CSV = `You can use this transaction report to inform your likely tax obligations.

Transactions
User,Someone,0000
Timestamp,Transaction Type,Asset,Quantity Transacted,Spot Price Currency,Spot Price at Transaction,Subtotal,"Total (inclusive of fees and/or spread)",Fees and/or Spread,Notes
2026-10-01T10:00:00Z,Buy,ETH,1.0,USD,$2000.00,$2000.00,"$2,020.00",$20.00,Bought 1 ETH
2026-10-02T10:00:00Z,Buy,ETH,1.0,USD,$2200.00,$2200.00,"$2,220.00",$20.00,Bought 1 ETH
2026-11-04T00:00:00Z,Send,ETH,0.5,USD,$2500.00,$1250.00,$1250.00,$0.00,Sent 0.5 ETH to ${A}
2026-11-04T01:00:00Z,Send,cbBTC,1,USD,$68000,$68000,$68000,$0,Sent 1 cbBTC to ${A}
2026-11-04T02:00:00Z,Buy,AERO,10,EUR,$1.80,$18,$18,$0,Bought with euros
2026-11-04T03:00:00Z,Send,AERO,10,EUR,$1.80,$18,$18,$0,Sent 10 AERO
`

  it("works out each withdrawal's cost from what was bought before it, fees included", () => {
    const { withdrawals, skipped } = parseCoinbaseCsv(CSV)!
    // 2 ETH cost $4,240, so half an ETH costs $1,060.
    assert.deepEqual(withdrawals[0], { exchange: "Coinbase", asset: "ETH", units: (E18 / 2n).toString(), at: "2026-11-04T00:00:00.000Z", cost: usd("1060000000"), toAddress: A })
    assert.equal(withdrawals.length, 1)
    assert.equal(skipped, 2, "one has no purchases behind it, and one was bought in a currency this app doesn't have")
  })

  it("keeps what a Canadian account paid in Canadian dollars, and won't mix two currencies", () => {
    const header = "Timestamp,Transaction Type,Asset,Quantity Transacted,Price Currency,Price at Transaction,Subtotal,Total (inclusive of fees and/or spread),Fees and/or Spread,Notes"
    const cad = parseCoinbaseCsv(`${header}\n2026-10-01T10:00:00Z,Buy,ETH,1,CAD,$3000,$3000,"$3,000.00",$0,x\n2026-10-02T10:00:00Z,Send,ETH,1,CAD,$3000,$3000,$3000,$0,x\n`)!
    assert.deepEqual(cad.withdrawals[0]?.cost, { micros: "3000000000", currency: "CAD" })
    const mixed = parseCoinbaseCsv(`${header}\n2026-10-01T10:00:00Z,Buy,ETH,1,CAD,$3000,$3000,$3000,$0,x\n2026-10-01T11:00:00Z,Buy,ETH,1,USD,$2000,$2000,$2000,$0,x\n2026-10-02T10:00:00Z,Send,ETH,1,CAD,$3000,$3000,$3000,$0,x\n`)!
    assert.deepEqual(mixed, { withdrawals: [], skipped: 1 })
  })

  it("isn't fooled by something that isn't one", () => {
    assert.equal(parseCoinbaseCsv("a,b,c\n1,2,3\n"), null)
  })

  const withdrawals = parseCoinbaseCsv(CSV)!.withdrawals
  const at = (minutes: number) => new Date(Date.parse("2026-11-04T00:00:00Z") + minutes * 60_000).toISOString()

  it("matches a withdrawal by asset, amount and time, allowing for the network fee", () => {
    assert.equal(matchWithdrawal(withdrawals, A, "ETH", E18 / 2n, at(3))?.cost.micros, "1060000000")
    assert.ok(matchWithdrawal(withdrawals, A, "ETH", (E18 / 200n) * 99n, at(3)))
  })

  it("doesn't match anything else", () => {
    assert.equal(matchWithdrawal(withdrawals, A, "USDC", E18 / 2n, at(3)), null, "another asset")
    assert.equal(matchWithdrawal(withdrawals, A, "ETH", E18, at(3)), null, "more than was sent")
    assert.equal(matchWithdrawal(withdrawals, A, "ETH", E18 / 4n, at(3)), null, "much less than was sent")
    assert.equal(matchWithdrawal(withdrawals, A, "ETH", E18 / 2n, at(120)), null, "too long after")
    assert.equal(matchWithdrawal(withdrawals, A, "ETH", E18 / 2n, at(-30)), null, "before it was sent")
    assert.equal(matchWithdrawal(withdrawals, B, "ETH", E18 / 2n, at(3)), null, "it says it went to another address")
  })

  it("won't pick between two that fit", () => {
    const two = [...withdrawals, { ...withdrawals[0]!, at: at(10), toAddress: null }]
    assert.equal(matchWithdrawal(two, A, "ETH", E18 / 2n, at(12)), null)
  })

  it("fills in the cost with no question asked", () => {
    const rows = [move(Math.floor(60), "0x1", A, "credit", E18 / 2n, COINBASE, ETH_ADDRESS)].map((r) => ({ ...r, timestamp: at(3) }))
    const fold = foldBook(wallet(A, rows), [], "average", { ...emptyBook(), withdrawals })
    assert.equal(fold.positions[0]?.effects[0]?.leg.costLabel, "self-reported")
    assert.equal(fold.positions[0]?.values.costMicros, "1060000000")
    assert.deepEqual(fold.questions, [])
  })
})

describe("what the UI gets", () => {
  it("groups a token with no market apart, counts it, and keeps it out of PnL", () => {
    const rows = [...buy(5, "0x0", A, 100n), ...send(10, "0x1", STRANGER, A, E18, AERO)]
    const { totals, positions, pnlStatus } = foldBook(wallet(A, rows), [], "average", emptyBook())
    assert.equal(positions.find((p) => p.asset === "AERO")?.noMarket, true)
    assert.deepEqual(totals.noMarket, ["AERO"])
    assert.ok(!totals.excluded.some((e) => e.asset === "AERO"))
    assert.notEqual(pnlStatus, "unavailable")
  })

  it("doesn't call it no market when the market couldn't be read", () => {
    const { positions } = foldBook(wallet(A, send(10, "0x1", STRANGER, A, E18, AERO), { marketChecked: false }), [], "average", emptyBook())
    assert.equal(positions[0]?.noMarket, false)
  })

  it("says how much of a total is an estimate", () => {
    const rows = send(10, "0x1", ACROSS, A, 100n * E6)
    const { totals } = foldBook(wallet(A, rows), [], "average", emptyBook())
    assert.equal(totals.estimatedMicros, "100000000")
    assert.equal(totals.estimated.unrealized, true)
    assert.equal(totals.unresolvedMicros, "0")
  })

  it("counts a realized gain on an estimated cost as estimated", () => {
    const rows = [...send(10, "0x1", ACROSS, A, 100n * E6), move(20, "0x2", A, "debit", 100n * E6, null), move(20, "0x2", A, "credit", E18 / 20n, null, ETH_ADDRESS)]
    const usdc = position(wallet(A, rows), [], emptyBook())
    assert.equal(usdc.estimates.realized, true)
    assert.ok(BigInt(usdc.values.estimatedRealizedMicros) > 0n)
  })

  it("marks a position resolvable only when an answer could help", () => {
    const portfolio = portfolioOf(DEMO_WALLET, "average")
    const of = (asset: string) => portfolio.positions.find((p) => p.asset === asset)!
    assert.equal(of("ETH").resolvable, true)
    assert.equal(of("AERO").resolvable, false)
    assert.equal(of("DEGEN").resolvable, false, "no market means no question")
  })

  it("exports marks what's exact, estimated, unresolved and without a market", () => {
    const { positions } = foldBook(DEMO_WALLET, [], "average", emptyBook())
    const lines = exportCsv(positions, "USD").trim().split("\n")
    assert.deepEqual(lines[0]?.split(","), ["time", "block", "transaction", "asset", "amount", "kind", "currency", "price", "price_source", "cost", "cost_source", "proceeds", "status"])
    const status = (asset: string, predicate = (_: string[]) => true) => lines.slice(1).map((l) => l.split(",")).filter((c) => c[3] === asset && predicate(c)).map((c) => c.at(-1))
    assert.ok(status("USDC").includes("unresolved"))
    assert.deepEqual(status("USDT"), ["estimated"])
    assert.ok(status("AERO").includes("exact"))
    assert.deepEqual(status("DEGEN"), ["no market"])
    assert.ok(lines.slice(1).every((l) => /,(exact|estimated|unresolved|no market)$/.test(l)))
  })

  it("asks about what's unresolved upstream too", () => {
    const answered = answerSender(emptyBook(), DEMO_ADDRESS, DEMO_SAVINGS_ADDRESS, { kind: "mine" })
    const portfolio = portfolioOf(DEMO_WALLET, "average", [DEMO_SAVINGS_WALLET], answered)
    assert.ok(portfolio.questions.some((q) => q.wallet === DEMO_SAVINGS_ADDRESS))
  })

  it("explains where a cost came from, in plain words", () => {
    const answered = answerSender(emptyBook(), DEMO_ADDRESS, DEMO_SAVINGS_ADDRESS, { kind: "mine" })
    const usdt = explainPortfolio(DEMO_WALLET, "average", { kind: "asset", asset: "USDT", metric: "unrealized" }, [DEMO_SAVINGS_WALLET], answered)!
    assert.match(usdt.lines.join(" "), /the price when it arrived/)
    assert.match(usdt.lines.join(" "), /of that is an estimate/)
    assert.equal(usdt.legs[0]?.estimated, true)
    const usdc = explainPortfolio(DEMO_WALLET, "average", { kind: "tx", txHash: DEMO_WALLET.legs.find((l) => l.asset === "USDC" && !l.opening)!.txHash }, [DEMO_SAVINGS_WALLET], answered)!
    assert.equal(usdc.legs[0]?.partlyUnknown, true)
    assert.match(usdc.legs[0]?.effect ?? "", /what your other wallet paid.*unknown cost/)
    assert.doesNotMatch([...usdt.lines, usdc.legs[0]?.effect].join(" "), /oracle|FIFO|\blegs?\b/i)
  })
})

describe("the demo", () => {
  const usdc = (b: Book) => foldBook(DEMO_WALLET, [DEMO_SAVINGS_WALLET], "average", b).positions.find((p) => p.asset === "USDC")!

  it("goes from unknown to resolved as it's answered", () => {
    const before = usdc(emptyBook())
    assert.equal(before.values.costMicros, null)
    assert.equal(before.effects[0]?.leg.costLabel, "unknown")

    const linked = answerSender(emptyBook(), DEMO_ADDRESS, DEMO_SAVINGS_ADDRESS, { kind: "mine" })
    const partly = usdc(linked)
    assert.equal(partly.effects[0]?.leg.costLabel, "inherited", "the note's cost carried over")
    assert.equal(partly.values.costMicros, null, "but the other wallet's older USDC still has no known cost")

    const answered: Book = { ...linked, costs: { [costKey(DEMO_SAVINGS_ADDRESS, "opening:USDC")]: usd((1_000n * E6).toString()) } }
    assert.notEqual(usdc(answered).values.costMicros, null)
    assert.equal(usdc(answered).reconciliation?.status, "reconciled")
  })

  it("clears its meter once everything's answered", () => {
    let current = emptyBook()
    current = answerSender(current, DEMO_ADDRESS, DEMO_SAVINGS_ADDRESS, { kind: "mine" })
    for (let i = 0; i < 12; i++) {
      const [q] = foldBook(DEMO_WALLET, [DEMO_SAVINGS_WALLET], "average", current).questions
      if (!q) break
      if (q.kind === "cost") current = { ...current, costs: { ...current.costs, [q.costKey as string]: usd("1000000") } }
      else current = answerSender(current, DEMO_ADDRESS, q.sender as string, { kind: "someone-else" })
    }
    const { meter, totals } = foldBook(DEMO_WALLET, [DEMO_SAVINGS_WALLET], "average", current)
    assert.equal(meter.open, 0)
    assert.ok(meter.answered > 0)
    assert.ok(totals.pnlMicros !== null)
    assert.ok(totals.excluded.some((e) => e.asset === "cbBTC"), "an answer doesn't explain a balance that doesn't match the chain")
  })

  it("works from the other wallet too, whose ETH from the demo wallet is partly unresolved", () => {
    const answered = answerSender(emptyBook(), DEMO_ADDRESS, DEMO_SAVINGS_ADDRESS, { kind: "mine" })
    const savings = foldBook(DEMO_SAVINGS_WALLET, [DEMO_WALLET], "average", answered)
    const eth = savings.positions.find((p) => p.asset === "ETH")!
    assert.equal(eth.effects[0]?.leg.costLabel, "inherited")
    assert.ok(BigInt(eth.values.unknownCostQty) > 0n)
    assert.equal(eth.values.costMicros, null)
    assert.equal(savings.positions.find((p) => p.asset === "USDC")?.values.qty, "0")
  })
})

describe("a book from a request", () => {
  it("reads what a client sends, lowercasing addresses", () => {
    const parsed = parseBook({ senders: { [A.toUpperCase().replace("0X", "0x")]: { kind: "mine" } }, costs: { "x:y": usd("5") } })
    assert.deepEqual(parsed, { senders: { [A]: { kind: "mine" } }, costs: { "x:y": usd("5") }, withdrawals: [] })
  })

  it("refuses anything else", () => {
    for (const bad of [null, 1, "x", [], { senders: [] }, { senders: { nope: { kind: "mine" } } }, { senders: { [A]: { kind: "nope" } } }, { costs: { x: "-1" } }, { costs: { x: 5 } }, { senders: { [A]: { kind: "my-exchange", costs: { USDC: "1" } } } }, { withdrawals: [{}] }]) {
      assert.equal(parseBook(bad), null, JSON.stringify(bad))
    }
  })

  it("drops fields it doesn't know, so nothing extra is carried along", () => {
    assert.deepEqual(parseBook({ senders: { [A]: { kind: "mine", extra: 1 } }, extra: true }), { senders: { [A]: { kind: "mine" } }, costs: {}, withdrawals: [] })
  })
})

describe("proving a wallet by signing", () => {
  const signature = `0x${"ab".repeat(65)}`

  it("links when the signer is the wallet, whatever its capitalization", async () => {
    assert.equal(await verifyLink(A, B, signature, async () => B.toUpperCase().replace("0X", "0x")), true)
  })

  it("signs a message saying what it does, naming both wallets", async () => {
    let signed = ""
    await verifyLink(A, B, signature, async ({ message }) => ((signed = message), B))
    assert.equal(signed, linkMessage(A, B))
    assert.ok(signed.includes(A) && signed.includes(B))
    assert.match(signed, /can't move funds/)
  })

  it("doesn't link anyone else's signature, or a malformed one", async () => {
    assert.equal(await verifyLink(A, B, signature, async () => C), false)
    assert.equal(await verifyLink(A, B, "0x1234", async () => B), false)
    assert.equal(await verifyLink(A, B, signature, async () => Promise.reject(new Error("bad"))), false)
  })
})
