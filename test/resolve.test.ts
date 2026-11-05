import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { verifyLink } from "../server/links.ts"
import { explainPortfolio, portfolioOf } from "../server/portfolio.ts"
import { createWallets, type Source } from "@pricetag/sdk/internal"
import { ASSETS, ETH_ADDRESS, USDC_ADDRESS, buildPricedLegs, openingLegs, shortHash, type LegRow, type Method, type Reference, encodeNote, parseNote } from "@pricetag/sdk/core"
import type { WalletResponse } from "../src/core/api.ts"
import { answerSender, costKey, emptyBook, enterExchangeCosts, linkMessage, parseBook, type Book, type Money, type Receipt, type SenderAnswer } from "../src/core/book.ts"
import { matchWithdrawals, parseCoinbaseCsv } from "../src/core/exchange-import.ts"
import { exportCsv } from "../src/core/export.ts"
import { DEMO_ADDRESS, DEMO_SAVINGS_ADDRESS, DEMO_SAVINGS_WALLET, DEMO_WALLET, demoRates } from "../src/core/fixtures.ts"
import { allocateTaken, foldBook, isBalanced, missingWallets, previewBook, readKey, readsMatching } from "../src/core/resolve.ts"

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`
const [A, B, C, STRANGER] = [addr(0xa1), addr(0xb1), addr(0xc1), addr(0xd1)] as [string, string, string, string]
const AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631"
const COINBASE = "0x71660c4005ba85c37ccec55d0c4493e66fe775d3"
const ACROSS = "0x09aea4b2242abc8bb4bb78d537a67a245a7bec64"
const MINT = "0x0000000000000000000000000000000000000000"
const E18 = 10n ** 18n
const E6 = 10n ** 6n

const references = (blocks: number[]): Reference[] => blocks.map((blockNum) => ({ blockNum, ethUsd: "200000000000", usdcUsd: "100000000" }))

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
    gasUnknownBlocks: [],
    l1FeeUnknownTxs: [],
    balances: { blockNum: 100, amounts },
    openingUnread: [],
    lastBalances: {},
    lastCheckableEth: null,
    unreadBalances: [],
    unseenEth: [],
    notes: [],
    marketChecked: true,
    unlisted: [],
    ...changes,
    legs,
  }
}

const receipt = (wallet: string, tx: string, units: bigint, asset = "USDC"): Receipt => ({ wallet, legId: `${tx}:${asset}`, asset, units: units.toString() })
const exchange = (micros: string, ...receipts: Receipt[]): SenderAnswer => ({ kind: "my-exchange", costs: [{ ...usd(micros), asset: receipts[0]?.asset ?? "USDC", receipts }] })
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

    describe("from a wallet whose history can't be confirmed", () => {
      const linked = book({ [A]: { kind: "mine" } })
      const amount = (1000n * E6).toString()
      const fold = (from: WalletResponse, method: Method = "average") => foldBook(wallet(B, rows), [from], method, linked)
      // Its history says the USDC left, and the chain says it's still there.
      const mismatched = () => wallet(A, rows, { balances: { blockNum: 100, amounts: { USDC: amount, ETH: "0" } } })
      const unread = (changes: Partial<WalletResponse> = {}) => wallet(A, rows, { balances: null, unreadBalances: ["USDC", "ETH"], ...changes })
      const unknown = (result: ReturnType<typeof fold>) => [result.positions[0]?.values.costMicros, result.positions[0]?.effects[0]?.leg.costLabel, result.withheld]
      const withheld = [null, "unknown", [{ wallet: A, asset: "USDC" }]]
      const known = ["1000000000", "inherited", []]

      it("isn't known when the balance doesn't match", () => {
        const result = fold(mismatched())
        assert.deepEqual(unknown(result), withheld)
        assert.equal(result.positions[0]?.reconciliation?.status, "reconciled", "the wallet it arrived in adds up, which isn't what's in doubt")
      })

      it("says the same in both apps", () => {
        const response = portfolioOf(wallet(B, rows), "average", [mismatched()], linked)
        assert.deepEqual(response.withheld, [{ wallet: A, asset: "USDC" }])
        assert.equal(response.positions[0]?.values.costMicros, null)
      })

      it("stays unknown through another wallet, and names the first", () => {
        const chain = [...rows, ...send(30, "0x3", B, C, 400n * E6)]
        const links = book({ [A]: { kind: "mine" }, [B]: { kind: "mine" } })
        const from = wallet(A, chain, { balances: { blockNum: 100, amounts: { USDC: amount, ETH: "0" } } })
        const result = foldBook(wallet(C, chain), [from, wallet(B, chain)], "average", links)
        assert.equal(result.positions[0]?.values.costMicros, null)
        assert.deepEqual(result.withheld, [{ wallet: A, asset: "USDC" }])
      })

      it("only touches that asset, and only what came from there", () => {
        const eth = wallet(A, rows, { balances: { blockNum: 100, amounts: { USDC: "0", ETH: "5" } } })
        assert.deepEqual(unknown(fold(eth)), known)
        const both = [...rows, ...buy(25, "0x4", B, 500n)]
        assert.equal(foldBook(wallet(B, both), [mismatched()], "fifo", linked).positions.find((p) => p.asset === "USDC")?.effects[1]?.leg.costLabel, "paid")
      })

      it("doesn't warn about a wallet on its own screen, or about what didn't reach this one", () => {
        assert.deepEqual(foldBook(mismatched(), [wallet(B, rows)], "average", book({ [B]: { kind: "mine" } })).withheld, [])
        const other = [...send(30, "0x3", A, C, 5n * E6), ...buy(5, "0x0", A, 5n)]
        const elsewhere = wallet(A, other, { balances: { blockNum: 100, amounts: { USDC: "1", ETH: "0" } } })
        const links = book({ [A]: { kind: "mine" }, [C]: { kind: "mine" } })
        const paid = foldBook(wallet(B, buy(40, "0x5", B, 5n)), [elsewhere, wallet(C, other)], "average", links)
        assert.deepEqual(paid.withheld, [])
        const fromStranger = send(40, "0x5", STRANGER, B, 10n * E6)
        const unrelated = foldBook(wallet(B, fromStranger), [elsewhere, wallet(C, other)], "average", links)
        assert.equal(unrelated.positions[0]?.values.costMicros, null, "it has an unknown cost of its own")
        assert.deepEqual(unrelated.withheld, [])
        assert.deepEqual(foldBook(wallet(C, other), [elsewhere], "average", book({ [A]: { kind: "mine" } })).withheld, [{ wallet: A, asset: "USDC" }], "the wallet it did reach still says so")
      })

      describe("through another wallet", () => {
        const links = book({ [A]: { kind: "mine" }, [B]: { kind: "mine" } })
        const stranger = send(5, "0x0", STRANGER, B, 1000n * E6)
        // B holds what a stranger sent first, then what A sent, and passes on only the first 1,000.
        const moved = [...rows, ...stranger, ...send(30, "0x3", B, C, 1000n * E6)]
        const from = wallet(A, moved, { balances: { blockNum: 100, amounts: { USDC: amount, ETH: "0" } } })

        it("follows the units that actually moved, oldest first", () => {
          assert.deepEqual(foldBook(wallet(C, moved), [from, wallet(B, moved)], "fifo", links).withheld, [])
          assert.deepEqual(foldBook(wallet(B, moved), [from, wallet(C, moved)], "fifo", links).withheld, [{ wallet: A, asset: "USDC" }], "B did receive it")
          const after = [...stranger, ...rows, ...send(30, "0x3", B, C, 1500n * E6)]
          assert.deepEqual(foldBook(wallet(C, after), [wallet(A, after, { balances: { blockNum: 100, amounts: { USDC: amount, ETH: "0" } } }), wallet(B, after)], "fifo", links).withheld, [{ wallet: A, asset: "USDC" }], "and past the first 1,000, some of what moved is A's")
        })

        it("goes along with an average, where every unit shares what's unknown", () => {
          assert.deepEqual(foldBook(wallet(C, moved), [from, wallet(B, moved)], "average", links).withheld, [{ wallet: A, asset: "USDC" }])
        })

        it("names everyone behind an average, and only them", () => {
          const D = addr(0xe1)
          const two = [...rows, ...buy(12, "0x6", D, 1000n), ...send(22, "0x7", D, B, 1000n * E6), ...send(30, "0x3", B, C, 500n * E6)]
          const off = (address: string) => wallet(address, two, { balances: { blockNum: 100, amounts: { USDC: amount, ETH: "0" } } })
          const three = book({ [A]: { kind: "mine" }, [B]: { kind: "mine" }, [D]: { kind: "mine" } })
          assert.deepEqual(foldBook(wallet(C, two), [off(A), off(D), wallet(B, two)], "average", three).withheld, [{ wallet: A, asset: "USDC" }, { wallet: D, asset: "USDC" }])
          const fine = wallet(D, two)
          assert.deepEqual(foldBook(wallet(C, two), [off(A), fine, wallet(B, two)], "average", three).withheld, [{ wallet: A, asset: "USDC" }])
        })
      })

      it("keeps a cost the user entered for it", () => {
        const answered: Book = { ...linked, costs: { [costKey(B, wallet(B, rows).legs[0]?.id as string)]: usd("900000000") } }
        const result = foldBook(wallet(B, rows), [mismatched()], "average", answered)
        assert.equal(result.positions[0]?.values.costMicros, "900000000")
        assert.deepEqual(result.withheld, [], "so there's nothing to warn about")
      })

      it("isn't balanced while a cost is withheld, though nothing's left to ask yet", () => {
        const answers = { ...linked, senders: { ...linked.senders, [STRANGER]: { kind: "someone-else" as const } } }
        const result = foldBook(wallet(B, rows), [unread()], "average", answers)
        assert.equal(isBalanced(result.meter), true, "the meter only knows about questions")
        assert.equal(result.withheld.length, 1, "which is why both apps check this too")
      })

      describe("asks what it cost", () => {
        const legId = wallet(B, rows).legs[0]?.id as string
        const asked = (result: ReturnType<typeof fold>) => result.questions.map((q) => [q.kind, q.costKey])
        const question = [["cost", costKey(B, legId)]]
        const last = (block: number, units: string) => ({ USDC: { blockNum: block, amount: units }, ETH: { blockNum: block, amount: "0" } })

        it("once the balance doesn't match, for all of what arrived", () => {
          const [only] = fold(mismatched()).questions
          assert.deepEqual([only?.kind, only?.sender, only?.wallet, only?.arrivals], ["cost", null, B, [{ asset: "USDC", decimals: 6, units: amount }]])
          assert.equal(only?.noteAbout, "0x2", "a note could say the same")
          assert.deepEqual(only?.evidence, [`${shortHash(A)}, your wallet, sent this, and its USDC history can't be confirmed`])
        })

        it("in both apps", () => {
          assert.deepEqual(portfolioOf(wallet(B, rows), "average", [mismatched()], linked).questions.map((q) => q.costKey), [costKey(B, legId)])
        })

        it("not while there's nothing to compare it with, so a card can't appear and vanish", () => {
          assert.deepEqual(asked(fold(unread())), [])
          assert.deepEqual(asked(fold(wallet(A, rows, { openingUnread: ["USDC"] }))), [])
          assert.deepEqual(asked(fold(unread({ openingUnread: ["USDC"], lastBalances: last(50, amount) }))), [])
          assert.deepEqual(asked(fold(unread({ lastBalances: last(15, "1000000000") }))), [], "that read matched, and what left after it isn't known either way")
        })

        it("and a failed read doesn't take it away", () => {
          assert.deepEqual(asked(fold(mismatched())), question)
          assert.deepEqual(asked(fold(unread({ lastBalances: last(50, amount) }))), question, "the last read still says it doesn't match")
        })

        it("not for what a wallet confirmed before a failed read", () => {
          assert.deepEqual(asked(fold(unread({ lastBalances: last(50, "0") }))), [])
        })

        describe("about ETH", () => {
          const ethRows = [...send(10, "0x1", STRANGER, A, E18, ETH_ADDRESS), ...send(20, "0x2", A, B, E18, ETH_ADDRESS)]
          const ethLinks = { ...linked, senders: { ...linked.senders, [STRANGER]: { kind: "someone-else" as const } } }
          const off = { balances: { blockNum: 100, amounts: { USDC: "0", ETH: "5" } } }
          const asking = (from: Partial<WalletResponse>) => foldBook(wallet(B, ethRows), [wallet(A, ethRows, from)], "average", ethLinks).questions.map((q) => q.kind)

          it("once it doesn't match, since a contract's transfers never add up without traces", () => {
            assert.deepEqual(asking(off), ["cost"])
          })

          it("not while it could still clear by itself", () => {
            assert.deepEqual(asking({ ...off, gasUnknownTxs: ["0x9"], gasUnknownBlocks: [15] }), [])
            const claimed = wallet(A, ethRows, off)
            const unsettled = { ...claimed, legs: claimed.legs.map((leg) => (leg.txHash === "0x1" ? { ...leg, unsettledCredit: true } : leg)) }
            assert.deepEqual(foldBook(wallet(B, ethRows), [unsettled], "average", ethLinks).questions, [])
            assert.deepEqual(asking({ l1FeeUnknownTxs: ["0x9"], lastCheckableEth: { blockNum: 15, amount: E18.toString() } }), [])
            assert.deepEqual(asking({ l1FeeUnknownTxs: ["0x9"], lastCheckableEth: null }), [])
          })

          it("once the last balance it could be compared with didn't match", () => {
            assert.deepEqual(asking({ l1FeeUnknownTxs: ["0x9"], lastCheckableEth: { blockNum: 30, amount: E18.toString() } }), ["cost"])
          })

          describe("with something still unclear", () => {
            // The balance at block 30 already didn't match, and the read since then failed.
            const lastRead = { balances: { blockNum: 100, amounts: { USDC: "0" } }, unreadBalances: ["ETH"], lastBalances: { ETH: { blockNum: 30, amount: E18.toString() } } }
            const claimedAt = (block: number) => {
              const claim = [...ethRows, ...send(block, "0xc", STRANGER, A, E18, ETH_ADDRESS)]
              const from = wallet(A, claim, lastRead)
              return foldBook(wallet(B, claim), [{ ...from, legs: from.legs.map((leg) => (leg.txHash === "0xc" ? { ...leg, unsettledCredit: true } : leg)) }], "average", ethLinks).questions.map((q) => q.kind)
            }

            it("keeps asking when it's newer than the balance, which it can't explain", () => {
              assert.deepEqual(claimedAt(40), ["cost"])
              assert.deepEqual(asking({ ...lastRead, gasUnknownTxs: ["0x9"], gasUnknownBlocks: [40] }), ["cost"])
            })

            it("doesn't ask when it's part of what that balance was compared with", () => {
              assert.deepEqual(claimedAt(15), [])
              assert.deepEqual(asking({ ...lastRead, gasUnknownTxs: ["0x9"], gasUnknownBlocks: [15] }), [])
              assert.deepEqual(asking({ ...lastRead, gasUnknownTxs: ["0x9"], gasUnknownBlocks: [30] }), [], "or in that very block")
              assert.deepEqual(asking({ ...off, gasUnknownTxs: ["0x9"], gasUnknownBlocks: [40] }), [], "and a balance read at the end covers everything")
            })
          })
        })

        it("and an answer takes the question and the warning away, wherever it's moved since", () => {
          const chain = [...rows, ...send(30, "0x3", B, C, 400n * E6)]
          const links = book({ [A]: { kind: "mine" }, [B]: { kind: "mine" } })
          const from = wallet(A, chain, { balances: { blockNum: 100, amounts: { USDC: amount, ETH: "0" } } })
          const before = foldBook(wallet(C, chain), [from, wallet(B, chain)], "average", links)
          assert.deepEqual(before.withheld, [{ wallet: A, asset: "USDC" }])
          assert.deepEqual(before.questions.map((q) => [q.kind, q.wallet]), [["cost", B]], "it's asked where it arrived, and only there")
          const after = foldBook(wallet(C, chain), [from, wallet(B, chain)], "average", { ...links, costs: { [before.questions[0]?.costKey as string]: usd("900000000") } })
          assert.deepEqual(after.questions, [])
          assert.deepEqual(after.withheld, [])
          assert.equal(after.positions[0]?.values.costMicros, "360000000", "400 of the 1,000 it cost 900 for")
        })

        it("once, however many of its senders can't be confirmed", () => {
          const D = addr(0xe1)
          const both = [...buy(10, "0x1", A, 500n), ...buy(11, "0x6", D, 500n), ...send(20, "0x2", A, B, 500n * E6), ...send(20, "0x2", D, B, 500n * E6)]
          const off = (address: string) => wallet(address, both, { balances: { blockNum: 100, amounts: { USDC: amount, ETH: "0" } } })
          const [only, ...rest] = foldBook(wallet(B, both), [off(A), off(D)], "average", book({ [A]: { kind: "mine" }, [D]: { kind: "mine" } })).questions
          assert.deepEqual(rest, [])
          assert.deepEqual(only?.arrivals, [{ asset: "USDC", decimals: 6, units: amount }])
          assert.deepEqual(only?.evidence, [A, D].map((address) => `${shortHash(address)}, your wallet, sent some of this, and its USDC history can't be confirmed`))
        })

        describe("about a transaction with another sender too", () => {
          const D = addr(0xe1)
          const links = book({ [A]: { kind: "mine" }, [D]: { kind: "mine" } })
          const half = 500n * E6
          const mixed = [...buy(10, "0x1", A, 500n), ...buy(11, "0x6", D, 500n), ...send(20, "0x2", A, B, half), ...send(20, "0x2", D, B, half)]
          const fromA = wallet(A, mixed, { balances: { blockNum: 100, amounts: { USDC: half.toString(), ETH: "0" } } })
          const entered = (micros: string) => ({ ...links, costs: { [costKey(B, wallet(B, mixed).legs[0]?.id as string)]: usd(micros) } })

          it("says it's only some of it, and keeps what's inherited until it's answered", () => {
            const { questions, positions } = foldBook(wallet(B, mixed), [fromA, wallet(D, mixed)], "average", links)
            assert.deepEqual(questions.map((q) => q.evidence), [[`${shortHash(A)}, your wallet, sent some of this, and its USDC history can't be confirmed`]])
            assert.equal(positions[0]?.effects[0]?.leg.costMicros, null)
          })

          it("lets the answer cover all of it, or the question could never go away", () => {
            const { questions, withheld, positions } = foldBook(wallet(B, mixed), [fromA, wallet(D, mixed)], "average", entered("900000000"))
            assert.deepEqual([questions, withheld], [[], []])
            assert.equal(positions[0]?.values.costMicros, "900000000")
            assert.equal(positions[0]?.effects[0]?.leg.costLabel, "self-reported")
          })

          it("goes back to what's inherited if the history ever adds up", () => {
            const { questions, positions } = foldBook(wallet(B, mixed), [wallet(A, mixed), wallet(D, mixed)], "average", entered("900000000"))
            assert.deepEqual(questions, [])
            assert.equal(positions[0]?.values.costMicros, "1000000000")
          })

          it("says it's only some of it when the other sender's balance is unread too", () => {
            const unreadD = wallet(D, mixed, { balances: null, unreadBalances: ["USDC", "ETH"] })
            assert.deepEqual(foldBook(wallet(B, mixed), [fromA, unreadD], "average", links).questions.map((q) => q.evidence), [[`${shortHash(A)}, your wallet, sent some of this, and its USDC history can't be confirmed`]])
          })

          it("keeps what was entered while a sender can't be read, until its history adds up", () => {
            const at = (...others: WalletResponse[]) => {
              const { questions, withheld, positions } = foldBook(wallet(B, mixed), others, "average", entered("900000000"))
              return [questions.length, withheld.length, positions[0]?.values.costMicros, positions[0]?.effects[0]?.leg.costLabel]
            }
            const kept = [0, 0, "900000000", "self-reported"]
            assert.deepEqual(at(wallet(D, mixed)), kept, "A hasn't loaded, or failed")
            assert.deepEqual(at(fromA, wallet(D, mixed)), kept, "A doesn't match")
            assert.deepEqual(at(wallet(D, mixed)), kept, "A failed after that")
            assert.deepEqual(at(wallet(A, mixed), wallet(D, mixed)), [0, 0, "1000000000", "inherited"], "A adds up")
          })

          it("asks nothing about a sender that can't be read, with nothing entered", () => {
            const { questions, positions } = foldBook(wallet(B, mixed), [wallet(D, mixed)], "average", links)
            assert.deepEqual(questions, [])
            assert.equal(positions[0]?.effects[0]?.leg.costMicros, null)
          })

          it("also covers a stranger's part, whichever is answered first", () => {
            const withStranger = [...buy(10, "0x1", A, 500n), ...send(20, "0x2", A, B, half), ...send(20, "0x2", STRANGER, B, half)]
            const off = wallet(A, withStranger, { balances: { blockNum: 100, amounts: { USDC: half.toString(), ETH: "0" } } })
            const open = foldBook(wallet(B, withStranger), [off], "average", linked).questions
            assert.deepEqual(open.map((q) => q.kind).sort(), ["cost", "sender"])
            const key = open.find((q) => q.kind === "cost")?.costKey as string
            assert.deepEqual(foldBook(wallet(B, withStranger), [off], "average", { ...linked, costs: { [key]: usd("900000000") } }).questions, [])
            const named = foldBook(wallet(B, withStranger), [off], "average", book({ [A]: { kind: "mine" }, [STRANGER]: { kind: "someone-else" } }))
            assert.deepEqual(named.questions.map((q) => q.kind), ["cost"], "that part's answered, and the rest still isn't known")
          })
        })
      })

      describe("as a wallet's refreshed, from what's actually read", () => {
        const start = [...send(10, "0x1", STRANGER, A, E18, ETH_ADDRESS), ...send(20, "0x2", A, B, E18, ETH_ADDRESS)]
        // Half an ETH that no leg explains shows up at block 25, and never goes away.
        const heldByA = (at: number) => (at < 10 ? 0n : at < 20 ? E18 : at < 25 ? 0n : E18 / 2n)
        const gasAt = (block: number, tx: string) => move(block, tx, A, "debit", 1000n, null, ETH_ADDRESS)
        const gasRow = (block: number, tx: string): LegRow => ({ ...gasAt(block, tx), kind: "gas" })
        const claimRow = (block: number, tx: string): LegRow => ({ ...move(block, tx, A, "credit", 1000n, null, ETH_ADDRESS), kind: "unwrap" })
        const answers = book({ [A]: { kind: "mine" }, [STRANGER]: { kind: "someone-else" } })

        type World = {
          rows?: (head: number) => LegRow[]
          gasUnknown?: (head: number) => { tx_hash: string; block_num: number }[]
          balance?: (at: number, head: number) => bigint | null
          ethReads?: (head: number) => boolean
        }

        /** What's asked about B's ETH at each head, in order. */
        async function askedAt(heads: number[], { rows = () => [], gasUnknown = () => [], balance = (at) => heldByA(at), ethReads = () => true }: World) {
          let head = heads[0] as number
          const reference = (blockNum: number): Reference => ({ blockNum, ethUsd: "200000000000", usdcUsd: "100000000" })
          const at = () => ({ blockNum: head, timestamp: new Date(Date.UTC(2026, 10, 4) + head * 2000).toISOString() })
          const source: Source = {
            mode: "raw",
            startBlock: 1,
            historyFrom: null,
            head: async () => at(),
            processedThrough: async (_, through) => through,
            readWindow: async (address, from, to) => {
              const inWindow = (block: number) => block >= from && block <= to
              return { rows: [...start, ...rows(head)].filter((r) => r.account === address && inWindow(r.block_num)), priced: null, gasUnknown: address === A ? gasUnknown(head).filter((tx) => inWindow(tx.block_num)) : [] }
            },
            readReferences: async (blocks) => blocks.map(reference),
            readLatestReference: async (block) => reference(block),
            readBalances: async (address, block) => {
              const eth = address === A ? balance(block, head) : block >= 20 ? E18 : 0n
              if (eth === null) throw new Error("no answer")
              return { blockNum: block, amounts: { ...Object.fromEntries(ASSETS.map((asset) => [asset, "0"])), ETH: eth.toString() } }
            },
            readEthBalances: async (_, blocks) => {
              if (!ethReads(head)) throw new Error("no answer")
              return new Map(blocks.map((block) => [block, (balance(block, head) as bigint).toString()]))
            },
          }
          const wallets = createWallets(source, async () => at(), async (requests) => new Map(requests.map((r) => [r.txHash, "0"])), { warn: () => {} } as never)
          const asked: string[][] = []
          for (const next of heads) {
            head = next
            const [recipient, sender] = [await wallets.get(B), await wallets.get(A)]
            asked.push(foldBook(recipient, [sender], "average", answers).questions.filter((q) => q.wallet === B).map((q) => q.kind))
          }
          return asked
        }

        // These run with every read working, so nothing here is about a read that failed.
        it("keeps asking while newer gas is missing, and after it's read", async () => {
          const unknown = (head: number) => (head >= 40 && head < 46 ? [{ tx_hash: "0x9", block_num: 40 }] : [])
          assert.deepEqual(await askedAt([30, 45, 46], { gasUnknown: unknown, rows: (head) => (head >= 46 ? [gasRow(40, "0x9")] : []), balance: (block) => heldByA(block) - (block >= 40 ? 1000n : 0n) }), [["cost"], ["cost"], ["cost"]])
        })

        it("keeps asking while a newer claim hasn't settled, and after it has", async () => {
          assert.deepEqual(await askedAt([30, 45, 46], { rows: (head) => (head >= 40 ? [claimRow(40, "0x9")] : []), ethReads: (head) => head !== 45, balance: (block) => heldByA(block) + (block >= 40 ? 1000n : 0n) }), [["cost"], ["cost"], ["cost"]])
        })

        it("doesn't ask while what's missing is older than any balance that disagrees", async () => {
          const unknown = (head: number) => (head < 46 ? [{ tx_hash: "0x9", block_num: 17 }] : [])
          assert.deepEqual(await askedAt([30, 45, 46], { gasUnknown: unknown }), [[], [], ["cost"]])
          assert.deepEqual(await askedAt([30, 45, 46], { rows: () => [claimRow(17, "0x9")], ethReads: (head) => head >= 46, balance: (block) => heldByA(block) + (block >= 17 ? 1000n : 0n) }), [[], [], ["cost"]])
        })

        it("doesn't ask at all when newer gas is all that's wrong", async () => {
          const unknown = (head: number) => (head >= 40 ? [{ tx_hash: "0x9", block_num: 40 }] : [])
          assert.deepEqual(await askedAt([30, 45], { gasUnknown: unknown, balance: (block) => (block < 10 ? 0n : block < 20 ? E18 : 0n) - (block >= 40 ? 1000n : 0n) }), [[], []])
        })

        it("stops asking when its block is replaced and the new balance adds up", async () => {
          const unknown = (head: number) => (head >= 40 ? [{ tx_hash: "0x9", block_num: 40 }] : [])
          // Until head 45, block 30 said it held half an ETH. After a reorg, it held none, and the legs add up.
          const balance = (block: number, head: number) => (head >= 45 ? (block < 10 ? 0n : block < 20 ? E18 : 0n) : heldByA(block))
          assert.deepEqual(await askedAt([30, 45], { gasUnknown: unknown, balance }), [["cost"], []])
        })

        it("stops asking when corrected legs add up to what it read", async () => {
          const unknown = (head: number) => (head >= 40 ? [{ tx_hash: "0x9", block_num: 40 }] : [])
          const corrected = (head: number) => (head >= 45 ? send(25, "0x7", STRANGER, A, E18 / 2n, ETH_ADDRESS).filter((r) => r.account === A) : [])
          assert.deepEqual(await askedAt([30, 45], { gasUnknown: unknown, rows: corrected }), [["cost"], []])
        })

        it("keeps what it read when its block can't be read again, until it can", async () => {
          const unknown = (head: number) => (head >= 40 ? [{ tx_hash: "0x9", block_num: 40 }] : [])
          const balance = (block: number, head: number) => (head === 45 && block === 30 ? null : head >= 46 ? (block < 10 ? 0n : block < 20 ? E18 : 0n) : heldByA(block))
          assert.deepEqual(await askedAt([30, 45, 46], { gasUnknown: unknown, balance }), [["cost"], ["cost"], []])
        })

        it("recovers from a failed read with newer gas missing", async () => {
          const unknown = (head: number) => (head >= 40 && head < 50 ? [{ tx_hash: "0x9", block_num: 40 }] : [])
          const balance = (block: number, head: number) => (head === 45 ? null : heldByA(block))
          assert.deepEqual(await askedAt([30, 44, 45, 46], { gasUnknown: unknown, balance }), [["cost"], ["cost"], ["cost"], ["cost"]])
        })
      })

      describe("a read that fails", () => {
        const last = (block: number, units: string) => ({ USDC: { blockNum: block, amount: units }, ETH: { blockNum: block, amount: "0" } })

        it("doesn't turn a known cost unknown when the last read added up", () => {
          assert.deepEqual(unknown(fold(wallet(A, rows))), known)
          assert.deepEqual(unknown(fold(unread({ lastBalances: last(50, "0") }))), known)
          assert.deepEqual(unknown(fold(unread({ lastBalances: last(100, "0") }))), known)
          assert.deepEqual(unknown(fold(wallet(A, rows))), known)
        })

        it("is the same for one asset's read, with the whole read still there", () => {
          const partial = wallet(A, rows, { balances: { blockNum: 100, amounts: { ETH: "0" } }, unreadBalances: ["USDC"], lastBalances: { USDC: { blockNum: 50, amount: "0" } } })
          assert.deepEqual(unknown(fold(partial)), known)
        })

        it("can't bring back a cost the last read already ruled out", () => {
          assert.deepEqual(unknown(fold(unread({ lastBalances: last(50, amount) }))), withheld)
        })

        it("doesn't vouch for what left after it", () => {
          assert.deepEqual(unknown(fold(unread({ lastBalances: last(15, amount) }))), withheld)
        })

        it("has nothing to fall back on before a first read, then settles for good", () => {
          assert.deepEqual(unknown(fold(unread())), withheld)
          assert.deepEqual(unknown(fold(wallet(A, rows))), known)
        })

        it("doesn't vouch for a wallet whose starting balance is still unread", () => {
          assert.deepEqual(unknown(fold(wallet(A, rows, { openingUnread: ["USDC"] }))), withheld)
          assert.deepEqual(unknown(fold(unread({ openingUnread: ["USDC"], lastBalances: last(50, "0") }))), withheld)
        })
      })

      describe("a network fee that can't be read yet", () => {
        const ethRows = [...send(10, "0x1", STRANGER, A, E18, ETH_ADDRESS), ...send(20, "0x2", A, B, E18, ETH_ADDRESS)]
        const reasons = (lastCheckableEth: WalletResponse["lastCheckableEth"]) => foldBook(wallet(B, ethRows), [wallet(A, ethRows, { l1FeeUnknownTxs: ["0x9"], lastCheckableEth })], "average", linked).withheld

        it("goes by the last ETH balance its legs could be compared with", () => {
          assert.deepEqual(reasons({ blockNum: 30, amount: "0" }), [])
          assert.deepEqual(reasons({ blockNum: 15, amount: E18.toString() }), [{ wallet: A, asset: "ETH" }], "what left after it isn't vouched for")
          assert.deepEqual(reasons({ blockNum: 30, amount: E18.toString() }), [{ wallet: A, asset: "ETH" }], "and it didn't add up")
          assert.deepEqual(reasons(null), [{ wallet: A, asset: "ETH" }], "with nothing to go on")
        })
      })
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

    describe("what a note can answer", () => {
      const NOTE_TX = `0x${"ab".repeat(32)}`
      const questionFrom = (moved: LegRow[], sender: string, answers: Book) => foldBook(wallet(A, moved), [], "average", answers).questions.find((q) => q.sender === sender)
      const entered = (answers: Book, sender: string, micros: string, moved: LegRow[]) => enterExchangeCosts(answers, A, sender, questionFrom(moved, sender, answers)!.receipts, { USDC: usd(micros) })
      const asked = book({ [COINBASE]: { kind: "my-exchange" } })

      it("is one token's whole movement in one transaction, and the cost is the same once it's read back", () => {
        const moved = send(10, NOTE_TX, COINBASE, A, 100n * E6)
        assert.equal(questionFrom(moved, COINBASE, asked)?.noteAbout, NOTE_TX)
        const answered = entered(asked, COINBASE, "90000000", moved)
        const before = position(wallet(A, moved), [], answered).values.costMicros
        const published = wallet(A, moved, { notes: [{ noteTx: "0xn", blockNum: 20, txHash: NOTE_TX, asset: "USDC", usdMicros: "90000000" }] })
        assert.equal(before, "90000000")
        assert.equal(position(published, [], answered).values.costMicros, before)
        assert.equal(position(published, [], emptyBook()).values.costMicros, before)
      })

      it("isn't part of what arrived, because a note would replace the cost of the rest", () => {
        const moved = [...send(10, NOTE_TX, COINBASE, A, 100n * E6), ...send(10, NOTE_TX, ACROSS, A, 200n * E6)]
        assert.equal(questionFrom(moved, COINBASE, asked)?.receipts.length, 1)
        assert.equal(questionFrom(moved, COINBASE, asked)?.noteAbout, null)
      })

      it("isn't several transfers", () => {
        const moved = [...send(10, NOTE_TX, COINBASE, A, 100n * E6), ...send(11, `0x${"cd".repeat(32)}`, COINBASE, A, 200n * E6)]
        assert.equal(questionFrom(moved, COINBASE, asked)?.noteAbout, null)
      })
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

    it("doesn't lean on a credit the chain hasn't confirmed: no answer settles it, and nothing asks about it", () => {
      const claim: LegRow = { ...move(10, "0xc", A, "credit", E18, null, ETH_ADDRESS), kind: "unwrap" }
      const arrived = move(10, "0xc", A, "credit", 5n * E18, STRANGER, AERO)
      const legs = buildPricedLegs({ account: A, rows: [claim, arrived], references: references([10]), priced: [], market: () => "1300000" })
      const answered: Book = { ...answerSender(emptyBook(), A, STRANGER, { kind: "someone-else" }), costs: { [costKey(A, "0xc:ETH")]: { micros: "2000000000", currency: "USD" } } }
      const open = { ...wallet(A, [], { legs }), notes: [{ noteTx: "0xn", blockNum: 11, txHash: "0xc", asset: "ETH", usdMicros: "1" }] }
      const fold = foldBook(open, [], "average", answered)
      const resolved = fold.legs.filter((leg) => leg.kind !== "gas")
      assert.deepEqual(resolved.map((leg) => [leg.asset, leg.costLabel, leg.costMicros]), [["ETH", "unknown", null], ["AERO", "unknown", null]])
      assert.deepEqual(fold.questions, [])
      const aero = resolved.find((leg) => leg.asset === "AERO")!
      assert.deepEqual([aero.priceSource, aero.priceMicros], ["market", "1300000"], "what it's worth is a fact about the token")
      assert.ok(aero.priceNote, "and it still says why there's no cost")
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

describe("a transfer to several wallets", () => {
  const costOf = (focus: WalletResponse, others: WalletResponse[], answers: Book, method: Method) => position(focus, others, answers, "USDC", method).state.lots.map((l) => [l.qty, l.costMicros])
  /** A bought 100 USDC for $100 at $1, then 100 more at about $2 (a note says so), and sends 100 each to B and C in one transaction. */
  const rows = [
    ...buy(10, "0x1", A, 100n),
    ...send(11, "0x2", STRANGER, A, 100n * E6),
    move(20, "0x3", A, "debit", 100n * E6, B),
    { ...move(20, "0x3", A, "debit", 100n * E6, C), log_index: 1 },
    move(20, "0x3", B, "credit", 100n * E6, A),
    { ...move(20, "0x3", C, "credit", 100n * E6, A), log_index: 1 },
  ]
  const notes = [{ noteTx: "0xn", blockNum: 11, txHash: "0x2", asset: "USDC", usdMicros: "200000000" }]
  const a = wallet(A, rows, { notes })
  const linkedAll = book({ [A]: { kind: "mine" }, [B]: { kind: "mine" }, [C]: { kind: "mine" } })

  it("gives each recipient its own lots, oldest first, whichever wallet is open", () => {
    assert.deepEqual(costOf(wallet(B, rows), [a], linkedAll, "fifo"), [[(100n * E6).toString(), "100000000"]])
    assert.deepEqual(costOf(wallet(C, rows), [a], linkedAll, "fifo"), [[(100n * E6).toString(), "200000000"]])
  })

  it("doesn't depend on which wallets are read or in what order", () => {
    const [b, c] = [wallet(B, rows), wallet(C, rows)]
    for (const others of [[a], [a, c], [c, a]]) assert.deepEqual(costOf(b, others, linkedAll, "fifo"), [[(100n * E6).toString(), "100000000"]])
    for (const others of [[a], [a, b], [b, a]]) assert.deepEqual(costOf(c, others, linkedAll, "fifo"), [[(100n * E6).toString(), "200000000"]])
  })

  it("loses and invents no cost across all of them, by either method", () => {
    for (const method of ["fifo", "average"] as const) {
      const total = [B, C].reduce((sum, r) => sum + BigInt(position(wallet(r, rows), [a], linkedAll, "USDC", method).values.costMicros as string), 0n)
      assert.equal(total, 300_000_000n, method)
    }
  })

  it("gives each the same mix by average cost, unknown part included", () => {
    const short = [...buy(10, "0x1", A, 100n), move(20, "0x3", A, "debit", 100n * E6, B), { ...move(20, "0x3", A, "debit", 100n * E6, C), log_index: 1 }, move(20, "0x3", B, "credit", 100n * E6, A), { ...move(20, "0x3", C, "credit", 100n * E6, A), log_index: 1 }]
    const opening = openingLegs({ blockNum: 0, amounts: { USDC: (100n * E6).toString() } }, "2026-11-03T23:59:00.000Z")
    const from = wallet(A, short, { legs: opening })
    for (const recipient of [B, C]) {
      const usdc = position(wallet(recipient, short), [from], book({ [A]: { kind: "mine" } }))
      assert.equal(usdc.values.unknownCostQty, (50n * E6).toString(), recipient)
      assert.equal(usdc.values.costMicros, null, "half of it has no known cost, so neither recipient looks fully resolved")
      assert.equal(usdc.state.lots.find((l) => l.costMicros !== null)?.costMicros, "50000000")
    }
  })

  it("follows the order transfers went in, even when a wallet gets two of them", () => {
    // $100 of lots, then $200. 50 to B, 100 to C, then 50 more to B, so each gets half of each.
    const repeated = [
      ...buy(10, "0x1", A, 100n),
      ...send(11, "0x2", STRANGER, A, 100n * E6),
      move(20, "0x3", A, "debit", 50n * E6, B),
      { ...move(20, "0x3", A, "debit", 100n * E6, C), log_index: 1 },
      { ...move(20, "0x3", A, "debit", 50n * E6, B), log_index: 2 },
      move(20, "0x3", B, "credit", 50n * E6, A),
      { ...move(20, "0x3", C, "credit", 100n * E6, A), log_index: 1 },
      { ...move(20, "0x3", B, "credit", 50n * E6, A), log_index: 2 },
    ]
    const from = wallet(A, repeated, { notes })
    const [b, c] = [wallet(B, repeated), wallet(C, repeated)]
    const cost = (focus: WalletResponse, others: WalletResponse[], method: Method) => position(focus, others, linkedAll, "USDC", method).values.costMicros
    for (const others of [[from], [from, c], [c, from]]) assert.equal(cost(b, others, "fifo"), "150000000")
    for (const others of [[from], [from, b], [b, from]]) assert.equal(cost(c, others, "fifo"), "150000000")
    assert.equal(cost(b, [from], "average"), "150000000")
    assert.equal(cost(c, [from], "average"), "150000000")
  })

  it("doesn't let the order parts were read in change who got what", () => {
    const shuffled = rows.map((row) => row).reverse()
    assert.deepEqual(costOf(wallet(B, shuffled), [wallet(A, shuffled, { notes })], linkedAll, "fifo"), [[(100n * E6).toString(), "100000000"]])
  })

  it("still sets aside the share of a recipient that isn't one of the user's wallets", () => {
    const toStranger = [...buy(10, "0x1", A, 100n), ...send(11, "0x2", STRANGER, A, 100n * E6), move(20, "0x3", A, "debit", 100n * E6, STRANGER), { ...move(20, "0x3", A, "debit", 100n * E6, B), log_index: 1 }, { ...move(20, "0x3", B, "credit", 100n * E6, A), log_index: 1 }]
    assert.deepEqual(costOf(wallet(B, toStranger), [wallet(A, toStranger, { notes })], book({ [A]: { kind: "mine" } }), "fifo"), [[(100n * E6).toString(), "200000000"]])
  })

  it("adds up exactly, however it divides", () => {
    const taken = [{ qty: "10", costMicros: "100", label: "paid" as const, estimatedCostMicros: "7" }, { qty: "3", costMicros: null, label: "unknown" as const, estimatedCostMicros: "0" }]
    const parts = [{ address: "x", units: 4n }, { address: "y", units: 2n }, { address: "z", units: 7n }]
    const allocated = allocateTaken(taken, parts, "average")
    for (const { address, units } of parts) assert.equal(allocated.get(address)!.reduce((sum, p) => sum + BigInt(p.qty), 0n), units, address)
    const pieces = [...allocated.values()].flat()
    assert.equal(pieces.reduce((sum, p) => sum + BigInt(p.costMicros ?? "0"), 0n), 100n)
    assert.equal(pieces.reduce((sum, p) => sum + BigInt(p.estimatedCostMicros), 0n), 7n)
    assert.equal(pieces.filter((p) => p.costMicros === null).reduce((sum, p) => sum + BigInt(p.qty), 0n), 3n)
  })

  it("can't say who got what when something also came back, so it stays unknown", () => {
    const back = [...buy(10, "0x1", A, 100n), move(20, "0x3", A, "debit", 60n * E6, B), { ...move(20, "0x3", A, "credit", 10n * E6, B), log_index: 1 }, move(20, "0x3", B, "credit", 60n * E6, A), { ...move(20, "0x3", B, "debit", 10n * E6, A), log_index: 1 }]
    assert.equal(position(wallet(B, back), [wallet(A, back)], book({ [A]: { kind: "mine" } })).values.costMicros, null)
  })
})

describe("a saved exchange cost", () => {
  const first = send(10, "0x1", COINBASE, A, 100n * E6)
  const answered = enterExchangeCosts(emptyBook(), A, COINBASE, [receipt(A, "0x1", 100n * E6)], { USDC: usd("90000000") })

  it("covers what it was answered for", () => {
    assert.equal(position(wallet(A, first), [], answered).values.costMicros, "90000000")
    assert.deepEqual(foldBook(wallet(A, first), [], "average", answered).questions, [])
  })

  it("isn't rewritten by what arrives later, which stays open", () => {
    const later = [...first, ...send(20, "0x2", COINBASE, A, 100n * E6)]
    const fold = foldBook(wallet(A, later), [], "average", answered)
    const usdc = fold.positions[0]!
    assert.deepEqual(usdc.effects.map((e) => [e.leg.costLabel, e.leg.costMicros]), [["self-reported", "90000000"], ["unknown", null]])
    assert.equal(usdc.values.costMicros, null, "nothing's quietly treated as resolved")
    assert.equal(fold.questions.length, 1)
    assert.equal(fold.questions[0]?.needsCost, true)
    assert.deepEqual(fold.questions[0]?.receipts, [receipt(A, "0x2", 100n * E6)])
  })

  it("isn't redistributed by loading another wallet", () => {
    const toB = send(30, "0x3", COINBASE, B, 100n * E6)
    const linked: Book = { ...answered, senders: { ...answered.senders, [B]: { kind: "mine" } } }
    const fold = foldBook(wallet(A, [...first, ...toB]), [wallet(B, [...first, ...toB])], "average", linked)
    assert.equal(fold.positions[0]?.effects[0]?.leg.costMicros, "90000000")
    assert.deepEqual(fold.questions[0]?.receipts, [receipt(B, "0x3", 100n * E6)])
  })

  it("keeps earlier answers when a later receipt is answered", () => {
    const later = [...first, ...send(20, "0x2", COINBASE, A, 100n * E6)]
    const both = enterExchangeCosts(answered, A, COINBASE, [receipt(A, "0x2", 100n * E6)], { USDC: usd("95000000") })
    assert.equal(position(wallet(A, later), [], both).values.costMicros, "185000000")
  })

  it("splits exactly across what it covers, with nothing lost to rounding", () => {
    const three = [...send(10, "0x1", COINBASE, A, E6), ...send(20, "0x2", COINBASE, A, E6), ...send(30, "0x3", COINBASE, A, E6)]
    const split = enterExchangeCosts(emptyBook(), A, COINBASE, [receipt(A, "0x1", E6), receipt(A, "0x2", E6), receipt(A, "0x3", E6)], { USDC: usd("100") })
    const usdc = position(wallet(A, three), [], split)
    assert.equal(usdc.values.costMicros, "100")
    assert.deepEqual(usdc.effects.map((e) => e.leg.costMicros), ["33", "33", "34"])
  })

  it("won't apply to a receipt the chain no longer agrees with", () => {
    const changed = send(10, "0x1", COINBASE, A, 80n * E6)
    assert.equal(position(wallet(A, changed), [], answered).values.costMicros, null)
  })

  it("lets a new answer replace one that no longer matches the chain", () => {
    const changed = send(10, "0x1", COINBASE, A, 80n * E6)
    const before = foldBook(wallet(A, changed), [], "average", answered)
    assert.equal(before.positions[0]?.values.costMicros, null)
    assert.equal(before.questions[0]?.needsCost, true, "it reopened")
    const corrected = enterExchangeCosts(answered, A, COINBASE, before.questions[0]!.receipts, { USDC: usd("72000000") })
    const after = foldBook(wallet(A, changed), [], "average", corrected)
    assert.equal(after.positions[0]?.values.costMicros, "72000000")
    assert.deepEqual(after.questions, [])
  })

  it("lets a new answer replace one that can't be converted", () => {
    const rows = send(10, "0x1", COINBASE, A, 100n * E6)
    const noRate = wallet(A, rows, { currency: "CAD", rates: { byBlock: {}, latest: null } })
    const before = foldBook(noRate, [], "average", answered)
    assert.equal(before.positions[0]?.effects[0]?.leg.costMicros, null, "USD with no rate to CAD")
    const corrected = enterExchangeCosts(answered, A, COINBASE, before.questions[0]!.receipts, { USDC: { micros: "130000000", currency: "CAD" } })
    const after = foldBook(noRate, [], "average", corrected)
    assert.equal(after.positions[0]?.effects[0]?.leg.costMicros, "130000000")
    assert.deepEqual(after.questions, [])
  })

  it("lets a new answer correct one, leaving what else it covered alone", () => {
    const two = [...send(10, "0x1", COINBASE, A, 100n * E6), ...send(20, "0x2", COINBASE, A, 300n * E6)]
    const first = enterExchangeCosts(emptyBook(), A, COINBASE, [receipt(A, "0x1", 100n * E6), receipt(A, "0x2", 300n * E6)], { USDC: usd("400000000") })
    const corrected = enterExchangeCosts(first, A, COINBASE, [receipt(A, "0x2", 300n * E6)], { USDC: usd("600000000") })
    const usdc = position(wallet(A, two), [], corrected)
    assert.deepEqual(usdc.effects.map((e) => e.leg.costMicros), ["100000000", "600000000"], "the first keeps its $100 share of the $400")
    assert.equal(position(wallet(A, two), [], first).values.costMicros, "400000000", "and undoing brings back the old answer")
  })

  it("only covers each asset's own receipts", () => {
    const mixed = [...first, ...send(10, "0x9", COINBASE, A, E18, ETH_ADDRESS)]
    const fold = foldBook(wallet(A, mixed), [], "average", emptyBook())
    const both = enterExchangeCosts(emptyBook(), A, COINBASE, fold.questions[0]!.receipts, { USDC: usd("90000000"), ETH: usd("2000000000") })
    const after = foldBook(wallet(A, mixed), [], "average", both)
    assert.equal(after.positions.find((p) => p.asset === "USDC")?.values.costMicros, "90000000")
    assert.equal(after.positions.find((p) => p.asset === "ETH")?.values.costMicros, "2000000000")
    assert.deepEqual(after.questions, [])
  })
})

describe("acquisition dates", () => {
  const dates = (usdc: ReturnType<typeof position>) => usdc.state.lots.map((l) => [l.acquiredBlock, l.costMicros])
  /** A got 100 USDC at block 10, B bought 100 for $100 at block 20, and A sends its lot to B at block 30. */
  const scenario = (receipts: LegRow[]) => [...receipts, ...buy(20, "0x2", B, 100n), ...send(30, "0x3", A, B, 100n * E6)]

  it("come along with an exchange cost, so oldest first sells it first", () => {
    const rows = scenario(send(10, "0x1", COINBASE, A, 100n * E6))
    const answers: Book = { ...enterExchangeCosts(emptyBook(), A, COINBASE, [receipt(A, "0x1", 100n * E6)], { USDC: usd("50000000") }), senders: { [COINBASE]: exchange("50000000", receipt(A, "0x1", 100n * E6)), [A]: { kind: "mine" } } }
    const usdc = position(wallet(B, rows), [wallet(A, rows)], answers, "USDC", "fifo")
    assert.deepEqual(dates(usdc), [[10, "50000000"], [20, "100000000"]])
  })

  it("come along with an estimate too", () => {
    const rows = scenario(send(10, "0x1", ACROSS, A, 100n * E6))
    const usdc = position(wallet(B, rows), [wallet(A, rows)], book({ [A]: { kind: "mine" } }), "USDC", "fifo")
    assert.deepEqual(dates(usdc), [[10, "100000000"], [20, "100000000"]])
    assert.equal(usdc.state.lots[0]?.estimatedCostMicros, "100000000")
  })

  it("come along with what has no known cost, so it still goes first", () => {
    const rows = scenario(send(10, "0x1", STRANGER, A, 100n * E6))
    const usdc = position(wallet(B, rows), [wallet(A, rows)], book({ [A]: { kind: "mine" } }), "USDC", "fifo")
    assert.deepEqual(dates(usdc), [[10, null], [20, "100000000"]])
  })

  it("date what's received here to when it arrived", () => {
    const usdc = position(wallet(A, send(10, "0x1", ACROSS, A, 100n * E6)), [], emptyBook(), "USDC", "fifo")
    assert.equal(usdc.state.lots[0]?.acquiredBlock, 10)
    assert.ok(usdc.state.lots[0]?.acquiredAt)
  })
})

describe("no market, in another currency", () => {
  const aero = (changes: Partial<WalletResponse> = {}) => wallet(A, send(10, "0x1", STRANGER, A, E18, AERO), { currency: "CAD", rates: { byBlock: {}, latest: null }, ...changes })
  const priced = (rows: LegRow[]) => buildPricedLegs({ account: A, rows: rows.filter((r) => r.account === A), references: references([10]), priced: [], market: () => "1000000" })

  it("isn't what a missing exchange rate means, for a token with a price at the time", () => {
    const rows = send(10, "0x1", STRANGER, A, E18, AERO)
    const fold = foldBook({ ...aero(), legs: priced(rows) }, [], "average", emptyBook())
    assert.equal(fold.positions[0]?.noMarket, false)
    assert.deepEqual(fold.totals.noMarket, [])
    assert.equal(fold.questions.length, 1, "it's a real token, so it's still asked about")
  })

  it("isn't what a missing exchange rate means, for a token with only a current price", () => {
    const fold = foldBook(aero({ prices: { AERO: { micros: "1000000", source: "market", blockNum: 100 } } }), [], "average", emptyBook())
    assert.equal(fold.positions[0]?.noMarket, false)
    assert.ok(fold.totals.excluded.some((e) => e.asset === "AERO"), "it's flagged, not hidden")
  })

  it("is still what no price at all means", () => {
    assert.equal(foldBook(aero(), [], "average", emptyBook()).positions[0]?.noMarket, true)
  })

  it("doesn't ask what a trade cost when only the rate is missing", () => {
    const rows = buy(10, "0x1", A, 100n)
    const fold = foldBook(wallet(A, rows, { currency: "CAD", rates: { byBlock: {}, latest: null } }), [], "average", emptyBook())
    assert.equal(fold.positions.find((p) => p.asset === "USDC")?.values.costMicros, null)
    assert.deepEqual(fold.questions, [])
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

    const told = book({ [COINBASE]: exchange("90000000", receipt(A, "0x1", 100n * E6)) })
    assert.deepEqual(question(rows, told), [])
    const usdc = position(wallet(A, rows), [], told)
    assert.equal(usdc.effects[0]?.leg.costLabel, "self-reported")
    assert.equal(usdc.values.costMicros, "90000000")
  })

  it("splits an exchange's total across its transfers by size", () => {
    const rows = [...send(10, "0x1", COINBASE, A, 300n * E6), ...send(20, "0x2", COINBASE, A, 100n * E6)]
    const usdc = position(wallet(A, rows), [], book({ [COINBASE]: exchange("400000000", receipt(A, "0x1", 300n * E6), receipt(A, "0x2", 100n * E6)) }))
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
    const usdc = position(wallet(A, send(10, "0x1", ACROSS, A, 100n * E6)), [], book({ [ACROSS]: exchange("95000000", receipt(A, "0x1", 100n * E6)) }))
    assert.equal(usdc.effects[0]?.leg.costLabel, "self-reported")
  })

  it("a mint can't be anyone's wallet, so there's nothing to ask", () => {
    assert.deepEqual(question(send(10, "0x1", MINT, A, 100n * E6)), [])
  })
})

describe("asking as little as possible", () => {
  it("isn't balanced while a linked wallet is still being read, because what came from it is still unresolved", () => {
    const rows = send(10, "0x1", B, A, 100n * E6)
    const answers = book({ [B]: { kind: "mine" } })
    const waiting = foldBook(wallet(A, rows), [], "average", answers).meter
    assert.deepEqual(waiting, { open: 0, answered: 1, waiting: 1 })
    assert.equal(isBalanced(waiting), false)
    const read = foldBook(wallet(A, rows), [wallet(B, rows)], "average", answers).meter
    assert.equal(read.waiting, 0)
  })

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
    assert.deepEqual(before, { open: 2, answered: 0, waiting: 0 })
    const after = foldBook(wallet(A, rows), [], "average", book({ [STRANGER]: { kind: "someone-else" } })).meter
    assert.deepEqual(after, { open: 1, answered: 1, waiting: 0 })
    assert.deepEqual(foldBook(wallet(A, rows), [], "average", book({ [STRANGER]: { kind: "someone-else" }, [C]: { kind: "someone-else" } })).meter, { open: 0, answered: 2, waiting: 0 })
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

  const arrival = (units: bigint, minutes: number, overrides: { key?: string; wallet?: string; asset?: string } = {}) => ({ key: "a", wallet: A, asset: "ETH", units, timestamp: at(minutes), ...overrides })
  const matched = (one: ReturnType<typeof arrival>, from = withdrawals) => matchWithdrawals(from, [one]).get(one.key) ?? null

  it("matches a withdrawal by asset, amount and time, allowing for the network fee", () => {
    assert.equal(matched(arrival(E18 / 2n, 3))?.cost.micros, "1060000000")
    assert.ok(matched(arrival((E18 / 200n) * 99n, 3)))
  })

  it("doesn't match anything else", () => {
    assert.equal(matched(arrival(E18 / 2n, 3, { asset: "USDC" })), null, "another asset")
    assert.equal(matched(arrival(E18, 3)), null, "more than was sent")
    assert.equal(matched(arrival(E18 / 4n, 3)), null, "much less than was sent")
    assert.equal(matched(arrival(E18 / 2n, 120)), null, "too long after")
    assert.equal(matched(arrival(E18 / 2n, -30)), null, "before it was sent")
    assert.equal(matched(arrival(E18 / 2n, 3, { wallet: B })), null, "it says it went to another address")
  })

  it("won't pick between two withdrawals that fit", () => {
    const two = [...withdrawals, { ...withdrawals[0]!, at: at(10), toAddress: null }]
    assert.equal(matched(arrival(E18 / 2n, 12), two), null)
  })

  it("won't let one withdrawal explain two arrivals", () => {
    const both = [arrival(E18 / 2n, 3, { key: "first" }), arrival(E18 / 2n, 4, { key: "second" })]
    assert.equal(matchWithdrawals(withdrawals, both).size, 0)
  })

  it("leaves both unresolved when one withdrawal fits two receipts, rather than counting its cost twice", () => {
    const rows = [0, 10].map((seconds, i) => ({ ...move(60 + i, `0x${i + 1}`, A, "credit", E18 / 2n, COINBASE, ETH_ADDRESS), timestamp: new Date(Date.parse(at(3)) + seconds * 1000).toISOString() }))
    const fold = foldBook(wallet(A, rows), [], "average", { ...emptyBook(), withdrawals })
    assert.deepEqual(fold.positions[0]?.effects.map((e) => e.leg.costLabel), ["unknown", "unknown"])
    assert.equal(fold.positions[0]?.values.costMicros, null)
    assert.equal(fold.questions.length, 1)
  })

  it("won't use a withdrawal for what came from someone the user says isn't an exchange", () => {
    const rows = [{ ...move(60, "0x1", A, "credit", E18 / 2n, STRANGER, ETH_ADDRESS), timestamp: at(3) }]
    const fold = foldBook(wallet(A, rows), [], "average", { ...book({ [STRANGER]: { kind: "someone-else" } }), withdrawals })
    assert.equal(fold.positions[0]?.effects[0]?.leg.costLabel, "received at market")
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

  describe("says a realized gain rests on an estimate, with no answers at all", () => {
    const sold = (block: number, tx: string, account: string, usdc: bigint) => [move(block, tx, account, "debit", usdc * E6, null), move(block, tx, account, "credit", (E18 * usdc) / 2000n, null, ETH_ADDRESS)]
    const estimated = (focus: WalletResponse, others: WalletResponse[] = [], answers = emptyBook()) => foldBook(focus, others, "average", answers).totals.estimated.realized

    it("from a bridge, which is what an automatic sweep must not move", () => {
      const rows = [...send(10, "0x1", ACROSS, A, 100n * E6), ...sold(20, "0x2", A, 100n)]
      const { totals } = foldBook(wallet(A, rows), [], "average", emptyBook())
      assert.equal(totals.estimated.realized, true)
      assert.equal(totals.coverage.realized.missing, 0, "nothing's missing, so coverage alone wouldn't catch it")
    })

    it("from a cost inherited from a wallet that estimated it", () => {
      const rows = [...send(10, "0x1", ACROSS, A, 100n * E6), ...send(15, "0x9", A, B, 100n * E6), ...sold(20, "0x2", B, 100n)]
      assert.equal(estimated(wallet(B, rows), [wallet(A, rows)], book({ [A]: { kind: "mine" } })), true)
    })

    it("and not from what was really paid", () => {
      assert.equal(estimated(wallet(A, [...buy(10, "0x1", A, 100n), ...sold(20, "0x2", A, 100n)])), false)
    })
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

  it("exports a transfer out as what it carried, not as exact", () => {
    const statuses = (rows: LegRow[], answers = emptyBook()) => exportCsv(foldBook(wallet(A, rows), [], "average", answers).positions, "USD").trim().split("\n").slice(1).map((l) => l.split(",").at(-1))
    const out = (from: string) => [...send(10, "0x1", from, A, 100n * E6), ...send(20, "0x2", A, B, 100n * E6)]
    assert.deepEqual(statuses(out(STRANGER)), ["unresolved", "unresolved"], "unknown cost")
    assert.deepEqual(statuses(out(ACROSS)), ["estimated", "estimated"], "estimated cost")
    assert.deepEqual(statuses([...buy(5, "0x0", A, 100n), ...send(20, "0x2", A, B, 50n * E6)]).slice(-1), ["exact"], "paid")
    const partly = [...buy(5, "0x0", A, 100n), ...send(10, "0x1", STRANGER, A, 100n * E6), ...send(20, "0x2", A, B, 150n * E6)]
    assert.deepEqual(statuses(partly).slice(-1), ["unresolved"], "partly unknown")
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

describe("wallets read another way", () => {
  // A got 1 ETH from someone else and sent it on to linked B, so B's cost is what A's estimate says, by whichever rule.
  const eth = move(10, "0xin", A, "credit", E18, STRANGER, ETH_ADDRESS)
  const out = move(20, "0xout", A, "debit", E18, B, ETH_ADDRESS)
  const landed = move(20, "0xout", B, "credit", E18, A, ETH_ADDRESS)
  const answers = answerSender(answerSender(emptyBook(), B, A, { kind: "mine" }), B, STRANGER, { kind: "someone-else" })
  const RULES = { market: { rule: "market-price", ethUsd: "200000000000", micros: "2000000000" }, cautious: { rule: "cautious-eth", ethUsd: "198000000000", micros: "1980000000" } }
  const read = (address: string, rows: LegRow[], { rule, ethUsd, micros }: (typeof RULES)["market"], changes: Partial<WalletResponse> = {}) =>
    wallet(address, [], {
      rule,
      legs: buildPricedLegs({ account: address, rows, references: [10, 20].map((blockNum) => ({ blockNum, ethUsd, usdcUsd: "100000000" })), priced: [] }),
      prices: { ETH: { micros, source: "oracle", blockNum: 100 } },
      ...changes,
    })
  const shown = (by: (typeof RULES)["market"]) => read(B, [landed], by)
  const linked = (by: (typeof RULES)["market"]) => read(A, [eth, out], by)
  const headline = (focus: WalletResponse, others: WalletResponse[]) => {
    const { totals, positions } = foldBook(focus, others, "average", answers)
    return { pnl: totals.pnlMicros, cost: positions.find((p) => p.asset === "ETH")?.values.costMicros }
  }
  const store = (reads: Record<string, WalletResponse>, wallet: WalletResponse) => ({ ...reads, [readKey(wallet.address, wallet)]: wallet })
  const others = (reads: Record<string, WalletResponse>, focus: WalletResponse) => readsMatching(reads, [A], focus)
  const ZERO = { market: { pnl: "0", cost: "2000000000" }, cautious: { pnl: "0", cost: "1980000000" } }
  const WAITING = { pnl: null, cost: null }

  it("has no gain by either rule, when everything's read the same way", () => {
    assert.deepEqual(headline(shown(RULES.market), [linked(RULES.market)]), ZERO.market)
    assert.deepEqual(headline(shown(RULES.cautious), [linked(RULES.cautious)]), ZERO.cautious)
  })

  it("won't fold a cost by one rule with a value by another, even when handed them, in totals, a preview, an explanation or a CSV", () => {
    const [focus, other] = [shown(RULES.market), linked(RULES.cautious)]
    assert.deepEqual(headline(focus, [other]), WAITING, "not the +$20 that $2,000 of value and $1,980 of cost would make")
    const fold = foldBook(focus, [other], "average", answers)
    assert.equal(fold.meter.waiting, 1)
    assert.equal(previewBook(focus, [other], "average", answers).pnlMicros, null)
    assert.equal(previewBook(focus, [other], "average", answers).pending, true)
    assert.deepEqual(missingWallets(answers, focus, [other]), [A])
    assert.equal(explainPortfolio(focus, "average", { kind: "total", metric: "pnl" }, [other], answers)?.value, null)
    assert.ok(!exportCsv(fold.positions, fold.view.currency).includes("1980"))
  })

  it("won't fold one currency's cost with another's", () => {
    const rates = { byBlock: {}, latest: null }
    const focus = shown(RULES.market)
    const other = { ...linked(RULES.market), currency: "CAD" as const, rates }
    assert.deepEqual(headline(focus, [other]), WAITING)
    assert.deepEqual(readsMatching(store({}, other), [A], focus), [])
  })

  describe("after switching rules", () => {
    const before = store({}, linked(RULES.market))

    it("keeps the old set whole when a linked wallet's new read comes first", () => {
      const reads = store(before, linked(RULES.cautious))
      assert.deepEqual(headline(shown(RULES.market), others(reads, shown(RULES.market))), ZERO.market)
      assert.deepEqual(headline(shown(RULES.cautious), others(reads, shown(RULES.cautious))), ZERO.cautious)
    })

    it("says it's waiting when the wallet's own new read comes first", () => {
      const focus = shown(RULES.cautious)
      assert.deepEqual(headline(focus, others(before, focus)), WAITING)
      const reads = store(before, linked(RULES.cautious))
      assert.deepEqual(headline(focus, others(reads, focus)), ZERO.cautious)
    })

    it("never gets to a gain when a linked wallet's new read fails", () => {
      const focus = shown(RULES.cautious)
      assert.deepEqual(headline(shown(RULES.market), others(before, shown(RULES.market))), ZERO.market)
      assert.deepEqual(headline(focus, others(before, focus)), WAITING)
    })

    it("stays whole through quick switches, whichever read lands when", () => {
      // There and back before anything lands, then the abandoned rule's read lands late.
      let reads = before
      const back = shown(RULES.market)
      assert.deepEqual(headline(back, others(reads, back)), ZERO.market)
      reads = store(reads, linked(RULES.cautious))
      assert.deepEqual(headline(back, others(reads, back)), ZERO.market)
      reads = store(reads, linked(RULES.market))
      assert.deepEqual(headline(back, others(reads, back)), ZERO.market)
    })
  })
})
