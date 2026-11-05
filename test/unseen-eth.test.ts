import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { ASSETS, ETH_ADDRESS, USDC_ADDRESS, buildPricedLegs, creditUnseenEth, foldPositions, payerOf, unseenEthSearchBlocks, worth, type LegRow, type PayoutTx, type Reference } from "@pricetag/sdk/core"
import { createWallets, readPayoutTxsAt, type Query, type ReadL1Fees, type Source } from "@pricetag/sdk/internal"
import { portfolioOf } from "../server/portfolio.ts"
import { costKey, emptyBook } from "../src/core/book.ts"
import { foldBook } from "../src/core/resolve.ts"
import type { WalletResponse } from "../src/core/api.ts"

// The real wallet and payout behind WORK-424: a contract paid it 0.00206183 ETH, and the transaction doesn't name it as `to`.
const ME = "0x3762620fbcb400b0f98365da4aad7d2a250e5d89"
const PAYOUT_BLOCK = 53525052
const PAYOUT_AMOUNT = 2061830000000000n
const PAYOUT_TX = "0x82a62dd6b8f47323f10fb120111c760a1e63c1fc79bde65db08923ad64033a26"
const PAYOUT_CONTRACT = "0x4b5c71082d027d16d2a146465d66f9eec11634f6"
const PAYOUT: PayoutTx = {
  blockNum: PAYOUT_BLOCK,
  txHash: PAYOUT_TX,
  txIndex: 93,
  from: "0xc2bee8f45dc998b18df043cb79edf88d7f9fd8ad",
  to: PAYOUT_CONTRACT,
  input:
    "1a1da0750000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000001569400000000000000000000000000000000000000000000000000000000000000010000000000000000000000003762620fbcb400b0f98365da4aad7d2a250e5d890000000000000000000000000000000000000000000000000007533934bcbc00",
}
const START = 53515446
const HEAD = 53529473
// What really happened after it: the wallet swapped some of that ETH for 1 USDC.
const SWAP_BLOCK = 53528000
const SWAP_TX = "0xacdf"
const SWAPPED = 412165072944549n
const FEES = 953094172270n

const row = (block: number, tx: string, token: string, side: LegRow["side"], amount: bigint, kind: LegRow["kind"]): LegRow => ({ block_num: block, timestamp: "2026-11-05T00:00:00.000Z", tx_hash: tx, tx_index: 5, log_index: 0, token, account: ME, side, amount: amount.toString(), kind })
const SWAP_ROWS = [row(SWAP_BLOCK, SWAP_TX, ETH_ADDRESS, "debit", FEES, "gas"), row(SWAP_BLOCK, SWAP_TX, ETH_ADDRESS, "debit", SWAPPED, "eth"), row(SWAP_BLOCK, SWAP_TX, USDC_ADDRESS, "credit", 1_000_000n, "erc20")]
const reference = (blockNum: number): Reference => ({ blockNum, ethUsd: "242445000000", usdcUsd: "100000000" })

const HELD = PAYOUT_AMOUNT - SWAPPED - FEES
const plainEth = (block: number) => (block < PAYOUT_BLOCK ? 0n : block < SWAP_BLOCK ? PAYOUT_AMOUNT : HELD)
const allFees: ReadL1Fees = async (requests) => new Map(requests.map((r) => [r.txHash, "0"]))

function chain(changes: Partial<Source> = {}, { rows = SWAP_ROWS, eth = plainEth, head = HEAD, usdc = 1_000_000n }: { rows?: LegRow[]; eth?: (block: number) => bigint; head?: number; usdc?: bigint } = {}) {
  const ethRounds: number[][] = []
  const payerReads: number[][] = []
  const source: Source = {
    mode: "raw",
    startBlock: START,
    historyFrom: null,
    head: async () => null,
    processedThrough: async (_, to) => to,
    readWindow: async (_, from, to) => ({ rows: rows.filter((r) => r.block_num >= from && r.block_num <= to), priced: null, gasUnknown: [] }),
    readReferences: async (blocks) => blocks.map(reference),
    readLatestReference: async (block) => reference(block),
    readBalances: async (_, block) => ({ blockNum: block, amounts: { ...Object.fromEntries(ASSETS.map((asset) => [asset, "0"])), ETH: eth(block).toString(), USDC: (block >= SWAP_BLOCK ? usdc : 0n).toString() } }),
    async readEthBalances(_, blocks) {
      ethRounds.push([...blocks])
      return new Map(blocks.map((block) => [block, eth(block).toString()]))
    },
    async readPayoutTxs(_, blocks) {
      payerReads.push([...blocks])
      return blocks.includes(PAYOUT_BLOCK) ? [PAYOUT] : []
    },
    ...changes,
  }
  const wallets = createWallets(source, async () => ({ blockNum: head, timestamp: "2026-11-05T02:00:00.000Z" }), allFees, { warn() {} })
  return { source, wallets, ethRounds, payerReads }
}

const ethOf = (wallet: Parameters<typeof portfolioOf>[0]) => portfolioOf(wallet, "average").positions.find((p) => p.asset === "ETH")!
const unseenLeg = (wallet: { legs: { id: string }[] }) => wallet.legs.find((leg) => leg.id === `unseen:${PAYOUT_BLOCK}:ETH`) as Awaited<ReturnType<ReturnType<typeof createWallets>["get"]>>["legs"][number]

describe("the batched payout WORK-424 found", () => {
  it("finds the block, counts exactly what arrived, and ETH matches the chain to the wei", async () => {
    const wallet = await chain().wallets.get(ME)
    const leg = unseenLeg(wallet)
    assert.equal(leg.delta, PAYOUT_AMOUNT.toString())
    assert.deepEqual(ethOf(wallet).reconciliation && { status: ethOf(wallet).reconciliation!.status }, { status: "reconciled" })
  })

  it("prices it at its block, with an unknown cost, the same as a direct transfer", async () => {
    const leg = unseenLeg(await chain().wallets.get(ME))
    assert.deepEqual([leg.kind, leg.priceMicros, leg.priceSource, leg.costLabel, leg.costMicros], ["transfer", "2424450000", "oracle", "unknown", null])
    assert.equal(leg.blockNum, PAYOUT_BLOCK)
  })

  it("names the transaction that lists this wallet and this amount, and asks about the contract it called", async () => {
    const wallet = await chain().wallets.get(ME)
    const leg = unseenLeg(wallet)
    assert.equal(leg.txHash, PAYOUT_TX)
    assert.equal(leg.parts[0]!.counterparty, PAYOUT_CONTRACT)
    const { questions } = foldBook(wallet as WalletResponse, [], "average", emptyBook())
    assert.deepEqual(questions.map((q) => [q.kind, q.sender]), [["sender", PAYOUT_CONTRACT]])
    assert.ok(questions[0]!.evidence.some((line) => line.includes("no transaction showing it")))
  })

  it("is valued at its block's price once it's said to be from someone else", async () => {
    const wallet = await chain().wallets.get(ME)
    const book = { ...emptyBook(), senders: { [PAYOUT_CONTRACT]: { kind: "someone-else" as const } } }
    const { positions, questions } = foldBook(wallet as WalletResponse, [], "average", book)
    assert.deepEqual(questions, [])
    const eth = positions.find((p) => p.asset === "ETH")!
    assert.equal(eth.reconciliation?.status, "reconciled")
    assert.notEqual(eth.values.realizedMicros, null)
    assert.ok(eth.effects.some(({ leg }) => leg.id === `unseen:${PAYOUT_BLOCK}:ETH` && leg.costLabel === "received at market" && leg.costMicros === worth(PAYOUT_AMOUNT, 2424450000n, 18).toString()))
  })

  it("takes few reads, and none once ETH matches", async () => {
    const { wallets, ethRounds } = chain()
    await wallets.get(ME)
    assert.ok(ethRounds.length <= 7, `${ethRounds.length} rounds`)
    assert.ok(ethRounds.flat().length <= 40, `${ethRounds.flat().length} reads`)
    const again = chain({}, { head: HEAD + 1 })
    await again.wallets.get(ME)
    const before = again.ethRounds.length
    await again.wallets.get(ME)
    assert.equal(again.ethRounds.length, before)
  })

  it("reads nothing for a wallet whose ETH adds up", async () => {
    const { wallets, ethRounds, payerReads } = chain({}, { eth: (block) => (block < SWAP_BLOCK ? PAYOUT_AMOUNT : HELD) })
    const wallet = await wallets.get(ME)
    assert.deepEqual([ethRounds, payerReads], [[], []])
    assert.equal(unseenLeg(wallet), undefined)
  })

  it("finds it for a wallet with nothing else on the chain", async () => {
    const { wallets } = chain({}, { rows: [], eth: (block) => (block < PAYOUT_BLOCK ? 0n : PAYOUT_AMOUNT), usdc: 0n })
    const wallet = await wallets.get(ME)
    assert.equal(unseenLeg(wallet).delta, PAYOUT_AMOUNT.toString())
    assert.equal(ethOf(wallet).reconciliation?.status, "reconciled")
  })

  it("forgets it when a reorg replaces its block, and finds what's there now", async () => {
    let arrived = true
    const { wallets } = chain({}, { eth: (block) => (arrived ? plainEth(block) : block < SWAP_BLOCK ? PAYOUT_AMOUNT : HELD) })
    assert.ok(unseenLeg(await wallets.get(ME)))
    arrived = false
    await wallets.rewind(PAYOUT_BLOCK, HEAD)
    assert.equal(unseenLeg(await wallets.get(ME)), undefined)
  })

  it("stays out of a wallet read as of a block before it", async () => {
    const { wallets } = chain()
    await wallets.get(ME)
    const facts = await wallets.factsAt(ME, PAYOUT_BLOCK - 1, { withBalances: true })
    const data = wallets.pricedOn(ME, facts!, {}, { priced: new Set(), checked: true })
    assert.equal(unseenLeg(data!), undefined)
  })

  it("keeps the wallet up when the search fails, flagged as it was, and tries again", async () => {
    let fail = true
    const { wallets } = chain({ readEthBalances: async (_, blocks) => (fail ? Promise.reject(new Error("no RPC")) : new Map(blocks.map((block) => [block, plainEth(block).toString()]))) }, { head: HEAD })
    const first = await wallets.get(ME)
    assert.equal(ethOf(first).reconciliation?.status, "incomplete")
    assert.equal(unseenLeg(first), undefined)
    fail = false
    await wallets.rewind(HEAD, HEAD)
    assert.equal(ethOf(await wallets.get(ME)).reconciliation?.status, "reconciled")
  })
})

describe("when no transaction can be named", () => {
  const blind = (txs: PayoutTx[]) => chain({ readPayoutTxs: async () => txs })

  it("asks what it cost instead, with no transaction to link to or write a note about", async () => {
    const wallet = await blind([]).wallets.get(ME)
    const leg = unseenLeg(wallet)
    assert.deepEqual([leg.txHash, leg.txIndex], ["", -1])
    assert.equal(ethOf(wallet).reconciliation?.status, "reconciled")
    const { questions } = foldBook(wallet as WalletResponse, [], "average", emptyBook())
    assert.deepEqual(questions.map((q) => [q.kind, q.sender, q.noteAbout]), [["cost", null, null]])
  })

  it("adds no point to the chart, because there's nothing to click", async () => {
    const { points } = portfolioOf(await blind([]).wallets.get(ME), "average")
    assert.ok(points.every((point) => point.txHash !== ""))
  })

  it("keeps an answer about it when the transaction is named later", async () => {
    const answered = await blind([]).wallets.get(ME)
    const named = await chain().wallets.get(ME)
    assert.equal(unseenLeg(answered).id, unseenLeg(named).id)
    const book = { ...emptyBook(), costs: { [costKey(ME, unseenLeg(named).id)]: { micros: "4000000", currency: "USD" as const } } }
    const leg = foldBook(named as WalletResponse, [], "average", book).positions.find((p) => p.asset === "ETH")!.effects.find((e) => e.leg.id === unseenLeg(named).id)!.leg
    assert.deepEqual([leg.costLabel, leg.costMicros], ["self-reported", "4000000"])
  })

  it("still counts it when reading who's behind it fails, and reads that again", async () => {
    let fail = true
    const { wallets } = chain({ readPayoutTxs: async () => (fail ? Promise.reject(new Error("no answer")) : [PAYOUT]) })
    const first = await wallets.get(ME)
    assert.equal(unseenLeg(first).txHash, "")
    fail = false
    await wallets.rewind(HEAD, HEAD)
    assert.equal(unseenLeg(await wallets.get(ME)).txHash, PAYOUT_TX)
  })
})

describe("who's named", () => {
  const tx = (changes: Partial<PayoutTx>): PayoutTx => ({ ...PAYOUT, txIndex: 7, txHash: "0xother", to: "0x1111111111111111111111111111111111111111", input: `a9059cbb${ME.slice(2).padStart(64, "0")}${"1".padStart(64, "0")}`, ...changes })
  const amount = PAYOUT_AMOUNT.toString()

  it("prefers the one with the exact amount over one that only names the wallet", () => {
    assert.equal(payerOf([tx({}), PAYOUT], ME, amount)?.txHash, PAYOUT_TX)
  })

  it("names the only one there is, even without the amount", () => {
    assert.equal(payerOf([tx({})], ME, amount)?.txHash, "0xother")
  })

  it("names nobody when several could be it", () => {
    assert.equal(payerOf([tx({}), tx({ txHash: "0xthird" })], ME, amount), null)
    assert.equal(payerOf([PAYOUT, { ...PAYOUT, txHash: "0xtwin" }], ME, amount), null)
    assert.equal(payerOf([], ME, amount), null)
  })

  it("asks about nobody when the transaction called the wallet itself or created a contract", () => {
    assert.equal(payerOf([tx({ to: ME })], ME, amount)?.sender, null)
    assert.equal(payerOf([tx({ to: null })], ME, amount)?.sender, null)
  })
})

describe("what must never be credited", () => {
  const BLOCK = 500
  const account = ME
  const tx = "0xaa"
  const gas = row(BLOCK, tx, ETH_ADDRESS, "debit", 100n, "gas")
  const balances = (before: bigint, after: bigint) => new Map([[BLOCK - 1, before.toString()], [BLOCK, after.toString()]])
  const credit = (rows: LegRow[], ethBalances: ReadonlyMap<number, string>, changes: { feeUnknownTxs?: string[]; gasUnknownBlocks?: number[]; through?: number; fromBlock?: number } = {}) =>
    creditUnseenEth({ rows, ethBalances, feeUnknownTxs: [], gasUnknownBlocks: [], account, fromBlock: 1, through: 1000, payers: new Map(), timestampOf: () => "2026-11-05T00:00:00.000Z", ...changes }).filter((r) => r.kind === "unseen_eth")

  it("a fall, or a change its rows explain", () => {
    assert.deepEqual(credit([gas], balances(1000n, 800n)), [])
    assert.deepEqual(credit([gas], balances(1000n, 900n)), [])
  })

  it("what's left of a rise after its rows, and no more", () => {
    assert.deepEqual(credit([gas, row(BLOCK, tx, ETH_ADDRESS, "credit", 50n, "eth")], balances(1000n, 1200n)).map((r) => r.amount), ["250"])
  })

  it("a block with a claim that hasn't settled, which could be what the rise is", () => {
    const claim = row(BLOCK, tx, ETH_ADDRESS, "credit", 500n, "unwrap")
    assert.deepEqual(credit([gas, claim], balances(1000n, 1400n)), [])
  })

  it("a block with a fee that isn't known yet", () => {
    assert.deepEqual(credit([gas], balances(1000n, 1400n), { feeUnknownTxs: [tx] }), [])
    assert.deepEqual(credit([], balances(1000n, 1400n), { gasUnknownBlocks: [BLOCK] }), [])
  })

  it("from balances that aren't the block and the one before it", () => {
    assert.deepEqual(credit([], new Map([[BLOCK - 2, "1000"], [BLOCK, "1400"]])), [])
  })

  it("outside the blocks being read", () => {
    assert.deepEqual(credit([], balances(1000n, 1400n), { through: BLOCK - 1 }), [])
    assert.deepEqual(credit([], balances(1000n, 1400n), { fromBlock: BLOCK + 1 }), [])
  })
})

describe("a trade in the same block", () => {
  const BLOCK = 500
  const reference500 = { ...reference(BLOCK), blockNum: BLOCK }
  const tx = "0xaa"
  const buy = [row(BLOCK, tx, ETH_ADDRESS, "debit", 10n ** 18n, "eth"), row(BLOCK, tx, USDC_ADDRESS, "credit", 2_400_000_000n, "erc20")]
  const legsOf = (rows: LegRow[], after: bigint) => {
    const settled = creditUnseenEth({ rows, ethBalances: new Map([[BLOCK - 1, (2n * 10n ** 18n).toString()], [BLOCK, after.toString()]]), feeUnknownTxs: [], gasUnknownBlocks: [], account: ME, fromBlock: 1, through: 1000, payers: new Map(), timestampOf: () => "2026-11-05T00:00:00.000Z" })
    return buildPricedLegs({ account: ME, rows: settled, references: [reference500], priced: [] })
  }

  it("has no value when ETH also rose, since that could be the change from what it paid", () => {
    const legs = legsOf(buy, 2n * 10n ** 18n - 9n * 10n ** 17n)
    const usdc = legs.find((l) => l.asset === "USDC")!
    assert.deepEqual([usdc.kind, usdc.costMicros, usdc.costLabel], ["swap", null, "unknown"])
    assert.equal(legs.find((l) => l.id === `unseen:${BLOCK}:ETH`)!.delta, (10n ** 17n).toString())
  })

  it("keeps its value when nothing unseen arrived", () => {
    const usdc = legsOf(buy, 10n ** 18n).find((l) => l.asset === "USDC")!
    assert.deepEqual([usdc.kind, usdc.costLabel], ["swap", "paid"])
  })

  it("never changes what it traded: the credit is its own movement", () => {
    const legs = legsOf(buy, 2n * 10n ** 18n - 9n * 10n ** 17n)
    assert.equal(legs.find((l) => l.asset === "ETH" && l.kind === "swap")!.delta, (-(10n ** 18n)).toString())
  })

  it("leaves a plain payment out of it, and a plain receipt too", () => {
    const pay = [row(BLOCK, tx, ETH_ADDRESS, "debit", 10n ** 17n, "eth")]
    assert.ok(legsOf(pay, 2n * 10n ** 18n + 10n ** 15n).every((l) => l.kind === "transfer"))
    const paid = [row(BLOCK, tx, USDC_ADDRESS, "credit", 5n, "erc20")]
    assert.ok(legsOf(paid, 2n * 10n ** 18n + 10n ** 15n).every((l) => l.kind === "transfer"))
  })

  it("comes ahead of what's spent in its block, so it doesn't look like more left than arrived", () => {
    const send = [row(BLOCK, tx, ETH_ADDRESS, "debit", 4n * 10n ** 17n, "eth")]
    const after = 6n * 10n ** 17n
    const settled = creditUnseenEth({ rows: send, ethBalances: new Map([[BLOCK - 1, "0"], [BLOCK, after.toString()]]), feeUnknownTxs: [], gasUnknownBlocks: [], account: ME, fromBlock: 1, through: 1000, payers: new Map(), timestampOf: () => "2026-11-05T00:00:00.000Z" })
    const legs = buildPricedLegs({ account: ME, rows: settled, references: [reference500], priced: [] })
    const [eth] = foldPositions(legs, "average", {}, { balances: { blockNum: BLOCK, amounts: { ETH: after.toString() } }, l1FeeUnknownTxs: [] })
    assert.equal(eth!.state.shortfallQty, "0")
    assert.equal(eth!.reconciliation?.status, "reconciled")
  })
})

describe("searching the balance", () => {
  const search = (rows: LegRow[], known: Record<number, bigint>, through = 1000, fromBlock = 1) => unseenEthSearchBlocks({ rows, ethBalances: new Map(Object.entries(known).map(([block, amount]) => [Number(block), amount.toString()])), fromBlock, through })

  it("starts from both ends", () => {
    assert.deepEqual(search([], {}), [0, 1000])
    assert.deepEqual(search([], { 0: 0n }), [1000])
  })

  it("leaves a stretch alone when its rows explain the change", () => {
    assert.deepEqual(search([row(500, "0x1", ETH_ADDRESS, "credit", 7n, "eth")], { 0: 0n, 1000: 7n }), [])
  })

  it("cuts up what they don't, and stops at one block", () => {
    assert.deepEqual(search([], { 0: 0n, 800: 5n }, 800), [100, 200, 300, 400, 500, 600, 700])
    assert.deepEqual(search([], { 0: 0n, 3: 5n }, 3), [1, 2])
    assert.deepEqual(search([], { 0: 0n, 1: 5n }, 1), [])
  })

  it("doesn't let a claim that stands explain anything, or read past what it was asked", () => {
    const claim = row(500, "0x1", ETH_ADDRESS, "credit", 7n, "unwrap")
    assert.equal(search([claim], { 0: 0n, 1000: 7n }).length, 7)
    assert.deepEqual(search([], { 0: 0n, 10: 0n, 20: 5n }, 10), [])
  })

  it("looks for ETH that left too, which can hide ETH that arrived", () => {
    assert.equal(search([], { 0: 5n, 1000: 0n }).length, 7)
  })

  it("finds each of several, over a few days of blocks", async () => {
    const rises = [53_520_111, 53_520_112, 53_560_000]
    const onchain = (block: number) => rises.reduce((sum, at, i) => sum + (block >= at ? BigInt(i + 1) : 0n), 0n)
    const known = new Map<number, string>()
    const [from, to] = [53_515_446, 53_600_000]
    let reads = 0
    for (let blocks = unseenEthSearchBlocks({ rows: [], ethBalances: known, fromBlock: from, through: to }); blocks.length > 0; blocks = unseenEthSearchBlocks({ rows: [], ethBalances: known, fromBlock: from, through: to })) {
      reads += blocks.length
      for (const block of blocks) known.set(block, onchain(block).toString())
    }
    const found = rises.filter((block) => known.has(block) && known.has(block - 1) && known.get(block) !== known.get(block - 1))
    assert.deepEqual(found, rises)
    assert.ok(reads < 100, `${reads} reads`)
  })
})

describe("reading who's behind it", () => {
  it("asks for successful transactions naming the wallet or sent by it, in those blocks", async () => {
    const queries: string[] = []
    const query = (async (sql: string) => {
      queries.push(sql)
      return [{ block_num: "7", tx_hash: "ab", tx_index: "3", from: "cd", to: null, input: "ef" }]
    }) as Query
    assert.deepEqual(await readPayoutTxsAt(query, "edgeandnode/base_mainnet@0.0.2", ME, [7]), [{ blockNum: 7, txHash: "0xab", txIndex: 3, from: "0xcd", to: null, input: "ef" }])
    assert.equal(queries.length, 1)
    assert.match(queries[0]!, /status/)
    assert.ok(queries[0]!.includes(`strpos(encode(input, 'hex'), '${ME.slice(2)}') > 0`))
    assert.ok(queries[0]!.includes(`"from" = X'${ME.slice(2)}'`))
  })
})
