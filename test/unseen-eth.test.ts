import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { ASSETS, ETH_ADDRESS, USDC_ADDRESS, WETH_ADDRESS, buildPricedLegs, creditUnseenEth, foldPositions, openingLegs, payerOf, unseenEthSearchBlocks, worth, type EthPayer, type LegRow, type PayoutTx, type PricedLeg, type Reference } from "@pricetag/sdk/core"
import { createWallets, readPayoutTxsAt, type Query, type ReadL1Fees, type Source } from "@pricetag/sdk/internal"
import { portfolioOf } from "../src/core/portfolio.ts"
import { costKey, emptyBook } from "../src/core/book.ts"
import { describeEffect } from "../src/core/explain.ts"
import { foldBook } from "../src/core/resolve.ts"
import { taxReportOf, taxRows } from "../src/core/tax.ts"
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

  it("says the payout came from a Coinbase address, and whose it was stays a question", async () => {
    const wallet = await chain().wallets.get(ME)
    const { questions, positions } = foldBook(wallet as WalletResponse, [], "average", emptyBook())
    assert.equal(questions[0]!.known?.kind, "exchange")
    assert.ok(questions[0]!.evidence.includes("From a Coinbase address"))
    assert.equal(positions.find((p) => p.asset === "ETH")!.effects.find(({ leg }) => leg.id === `unseen:${PAYOUT_BLOCK}:ETH`)!.leg.costLabel, "unknown")
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
  const tx = (changes: Partial<PayoutTx>): PayoutTx => ({ ...PAYOUT, txHash: "0xother", to: "0x1111111111111111111111111111111111111111", input: `a9059cbb${ME.slice(2).padStart(64, "0")}${"1".padStart(64, "0")}`, ...changes })
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
      return [{ block_num: "7", tx_hash: "ab", from: "cd", to: null, input: "ef" }]
    }) as Query
    assert.deepEqual(await readPayoutTxsAt(query, "edgeandnode/base_mainnet@0.0.2", ME, [7]), [{ blockNum: 7, txHash: "0xab", from: "0xcd", to: null, input: "ef" }])
    assert.equal(queries.length, 1)
    assert.match(queries[0]!, /status/)
    assert.ok(queries[0]!.includes(`strpos(encode(input, 'hex'), '${ME.slice(2)}') > 0`))
    assert.ok(queries[0]!.includes(`"from" = X'${ME.slice(2)}'`))
  })
})

/** One block's worth of a wallet: what it held and what moved, with ETH's balance before and after. */
function blockOf({ account = ME, rows, before, after, payer, opening = 0n, amounts = {} }: { account?: string; rows: LegRow[]; before: bigint; after: bigint; payer?: EthPayer; opening?: bigint; amounts?: Record<string, string> }): WalletResponse {
  const BLOCK = 500
  const timestamp = "2026-11-05T00:00:00.000Z"
  const settled = creditUnseenEth({ rows, ethBalances: new Map([[BLOCK - 1, before.toString()], [BLOCK, after.toString()]]), feeUnknownTxs: [], gasUnknownBlocks: [], account, fromBlock: BLOCK, through: BLOCK, payers: new Map(payer ? [[BLOCK, payer]] : []), timestampOf: () => timestamp })
  const reference: Reference = { blockNum: BLOCK, ethUsd: "200000000000", usdcUsd: "100000000" }
  const legs: PricedLeg[] = [...(opening > 0n ? openingLegs({ blockNum: BLOCK - 1, amounts: { ETH: opening.toString() } }, timestamp) : []), ...buildPricedLegs({ account, rows: settled, references: [reference], priced: [] })]
  return {
    address: account,
    mode: "raw",
    currency: "USD",
    rates: null,
    coverage: { fromBlock: BLOCK, toBlock: BLOCK },
    latest: { blockNum: BLOCK, timestamp },
    references: [reference],
    legs,
    prices: { ETH: { micros: "2000000000", source: "oracle", blockNum: BLOCK } },
    balances: { blockNum: BLOCK, amounts: { ETH: after.toString(), ...amounts } },
    gasUnknownTxs: [],
    gasUnknownBlocks: [],
    l1FeeUnknownTxs: [],
    openingUnread: [],
    lastBalances: {},
    lastCheckableEth: null,
    unreadBalances: [],
    unseenEth: [],
    notes: [],
    marketChecked: true,
    marketMarks: {},
    unlisted: [],
  } as unknown as WalletResponse
}

const E18 = 10n ** 18n
const at500 = (tx: string, token: string, side: LegRow["side"], amount: bigint, kind: LegRow["kind"], counterparty?: string): LegRow => ({ ...row(500, tx, token, side, amount, kind), ...(counterparty ? { counterparty } : {}) })
const UNSEEN = "unseen:500:ETH"
const usd = (micros: string) => ({ micros, currency: "USD" as const })

describe("ETH that arrived in a block where ETH also left", () => {
  const OTHER = "0x2222222222222222222222222222222222222222"
  // 1 ETH costing $1,000, 0.5 sent, and 1 received. Sent first it leaves $2,500 of cost, and received first $2,250 for this much. Nothing says which.
  const send = [at500("0xa1", ETH_ADDRESS, "debit", E18 / 2n, "eth", OTHER)]
  const answers = { ...emptyBook(), costs: { [costKey(ME, "opening:ETH")]: usd("1000000000"), [costKey(ME, UNSEEN)]: usd("2000000000") } }
  const wallet = (payer?: EthPayer) => blockOf({ rows: send, before: E18, after: (3n * E18) / 2n, opening: E18, ...(payer ? { payer } : {}) })
  const ethOf = (book = answers, method: "average" | "fifo" = "average", w = wallet()) => foldBook(w, [], method, book).positions.find((p) => p.asset === "ETH")!

  for (const method of ["average", "fifo"] as const) {
    it(`keeps the amount and leaves the cost unresolved, whatever was entered, by ${method}`, () => {
      const eth = ethOf(answers, method)
      assert.equal(eth.reconciliation?.status, "reconciled")
      assert.equal(eth.values.qty, ((3n * E18) / 2n).toString())
      assert.deepEqual([eth.values.costMicros, eth.values.unrealizedMicros], [null, null])
      const credit = eth.effects.find(({ leg }) => leg.id === UNSEEN)!.leg
      assert.deepEqual([credit.costLabel, credit.costMicros, credit.priceMicros], ["unknown", null, "2000000000"])
    })
  }

  it("doesn't let a named transaction settle the order, because that's only the likeliest one", () => {
    const named = ethOf(answers, "average", wallet({ txHash: "0xpay", sender: OTHER }))
    assert.deepEqual([named.values.costMicros, named.values.unrealizedMicros], [null, null])
    assert.equal(named.effects.find(({ leg }) => leg.id === UNSEEN)!.leg.txIndex, -1)
  })

  it("doesn't ask about it, because no answer could help, and says why", () => {
    const fold = foldBook(wallet(), [], "average", answers)
    assert.ok(!fold.questions.some((q) => q.receipts.some((r) => r.legId === UNSEEN)))
    const effect = fold.positions.find((p) => p.asset === "ETH")!.effects.find(({ leg }) => leg.id === UNSEEN)!
    assert.match(describeEffect(effect, "USD"), /nothing says which came first/)
  })

  it("leaves what was sent with no known cost, and says why", () => {
    const eth = ethOf()
    const sent = eth.effects.find(({ leg }) => BigInt(leg.delta) < 0n)!
    assert.equal(eth.state.transferredOutCostMicros, "0")
    assert.equal(eth.state.transferredOutUnknownQty, (E18 / 2n).toString())
    assert.match(describeEffect(sent, "USD"), /nothing says which came first/)
  })

  it("carries no cost to a linked wallet, by either method", () => {
    const received = blockOf({ account: OTHER, rows: [{ ...at500("0xa1", ETH_ADDRESS, "credit", E18 / 2n, "eth", ME), account: OTHER }], before: 0n, after: E18 / 2n })
    const linked = { ...answers, senders: { [ME]: { kind: "mine" as const }, [OTHER]: { kind: "mine" as const } } }
    for (const method of ["average", "fifo"] as const) {
      const eth = foldBook(received, [wallet()], method, linked).positions.find((p) => p.asset === "ETH")!
      assert.equal(eth.values.costMicros, null)
      const arrived = eth.effects.find(({ leg }) => BigInt(leg.delta) > 0n)!.leg
      assert.ok(arrived.pieces?.every((piece) => piece.costMicros === null))
    }
  })

  it("keeps the same result when what left was an exchange", () => {
    const swap = [at500("0xa2", ETH_ADDRESS, "debit", E18 / 2n, "eth"), at500("0xa2", USDC_ADDRESS, "credit", 1_000_000_000n, "erc20")]
    const eth = foldBook(blockOf({ rows: swap, before: E18, after: (3n * E18) / 2n, opening: E18, amounts: { USDC: "1000000000" } }), [], "average", answers).positions.find((p) => p.asset === "ETH")!
    assert.deepEqual([eth.values.costMicros, eth.values.realizedMicros], [null, null])
  })

  describe("when only a fee left", () => {
    // Paid first it leaves $2,009 of cost, and paid after it, about $2,008.01. Small, but nothing says which.
    const fee = at500("0xa3", ETH_ADDRESS, "debit", E18 / 1000n, "gas")
    const cases: [string, EthPayer | undefined][] = [["a separate transaction's fee", undefined], ["the fee of the wallet's own claim", { txHash: "0xa3", sender: OTHER }]]
    for (const [name, payer] of cases) {
      it(`leaves ${name} and the ETH unresolved`, () => {
        const claim = blockOf({ rows: [fee], before: E18 / 100n, after: E18 + E18 / 100n - E18 / 1000n, opening: E18 / 100n, ...(payer ? { payer } : {}) })
        const book = { ...emptyBook(), costs: { [costKey(ME, "opening:ETH")]: usd("10000000"), [costKey(ME, UNSEEN)]: usd("2000000000") } }
        for (const method of ["average", "fifo"] as const) {
          const eth = foldBook(claim, [], method, book).positions.find((p) => p.asset === "ETH")!
          assert.equal(eth.reconciliation?.status, "reconciled")
          assert.deepEqual([eth.values.costMicros, eth.values.realizedMicros], [null, null])
          assert.notEqual(eth.state.gasMicros, "0", "what the fee was worth is still known")
        }
      })
    }
  })

  it("keeps ETH that arrived alone in its block answerable", () => {
    const alone = blockOf({ rows: [], before: E18, after: 2n * E18, opening: E18 })
    for (const method of ["average", "fifo"] as const) {
      const eth = foldBook(alone, [], method, answers).positions.find((p) => p.asset === "ETH")!
      assert.equal(eth.effects.find(({ leg }) => leg.id === UNSEEN)!.leg.costMicros, "2000000000")
      assert.equal(eth.values.costMicros, "3000000000")
    }
  })
})

describe("what's still held after ETH arrived and left in one block", () => {
  const OTHER = "0x2222222222222222222222222222222222222222"
  const BLOCK = 500
  const stamp = "2026-11-05T00:00:00.000Z"
  const reference = (blockNum: number, ethUsd = "200000000000"): Reference => ({ blockNum, ethUsd, usdcUsd: "100000000" })
  const book = { ...emptyBook(), costs: { [costKey(ME, "opening:ETH")]: usd("1000000000"), [costKey(ME, UNSEEN)]: usd("2000000000") } }
  const later = (tx: string, token: string, side: LegRow["side"], amount: bigint, kind: LegRow["kind"], counterparty?: string): LegRow => ({ ...at500(tx, token, side, amount, kind, counterparty), block_num: 501 })
  // 1 ETH costing $1,000, 0.5 sent and some received in one block. Then whatever `then` does in the next.
  const walletWith = (received: bigint, then: LegRow[], blockRows: LegRow[] = [at500("0xsend", ETH_ADDRESS, "debit", E18 / 2n, "eth", OTHER)], payer?: EthPayer) => {
    const left = blockRows.reduce((sum, row) => sum + (row.side === "debit" ? BigInt(row.amount) : 0n), 0n)
    const settled = creditUnseenEth({ rows: [...blockRows, ...then], ethBalances: new Map([[BLOCK - 1, E18.toString()], [BLOCK, (E18 - left + received).toString()]]), feeUnknownTxs: [], gasUnknownBlocks: [], account: ME, fromBlock: BLOCK, through: 501, payers: new Map(payer ? [[BLOCK, payer]] : []), timestampOf: () => stamp })
    const legs = [...openingLegs({ blockNum: BLOCK - 1, amounts: { ETH: E18.toString() } }, stamp), ...buildPricedLegs({ account: ME, rows: settled, references: [reference(BLOCK), reference(501)], priced: [] })]
    const moved = then.reduce((sum, row) => sum + (row.token !== ETH_ADDRESS ? 0n : row.side === "debit" ? -BigInt(row.amount) : BigInt(row.amount)), 0n)
    const usdc = then.filter((row) => row.token === USDC_ADDRESS).reduce((sum, row) => sum + BigInt(row.amount), 0n)
    return { ...blockOf({ rows: [], before: 0n, after: E18 - left + received + moved, amounts: { USDC: usdc.toString() } }), legs, coverage: { fromBlock: BLOCK, toBlock: 501 } } as WalletResponse
  }
  const sale = (eth: bigint, usdcUnits: bigint) => [later("0xsale", ETH_ADDRESS, "debit", eth, "eth"), later("0xsale", USDC_ADDRESS, "credit", usdcUnits, "erc20")]
  const ethOf = (wallet: WalletResponse, method: "average" | "fifo") => foldBook(wallet, [], method, book).positions.find((p) => p.asset === "ETH")!
  const methods = ["average", "fifo"] as const
  const scopes = ["per-wallet", "pooled"] as const

  for (const method of methods) {
    for (const scope of scopes) {
      it(`gives a later sale no gain, by ${method} in a ${scope} report`, () => {
        const wallet = walletWith(E18, sale((3n * E18) / 2n, 3_000_000_000n))
        assert.equal(ethOf(wallet, method).reconciliation?.status, "reconciled")
        const rows = taxRows([wallet], { method, scope }, { book }).filter((row) => row.type === "Sold" && row.asset === "ETH")
        assert.ok(rows.length > 0)
        assert.ok(rows.every((row) => row.gainMicros === null && row.costMicros === null && row.status === "unresolved"))
      })
    }

    it(`keeps a later sale out of the report's gain total, by ${method}`, () => {
      const report = taxReportOf([walletWith(E18, sale((3n * E18) / 2n, 3_000_000_000n))], { country: "CA", method, scope: "per-wallet" }, { book })
      assert.ok(BigInt(report.gainMicros ?? "0") === 0n, `gain ${report.gainMicros}`)
    })

    it(`leaves a later sale's PnL unavailable, by ${method}`, () => {
      const eth = ethOf(walletWith(E18, sale((3n * E18) / 2n, 3_000_000_000n)), method)
      assert.equal(eth.values.qty, "0")
      assert.equal(eth.values.realizedMicros, null)
    })

    it(`isn't cleared by a tiny arrival being used up in the send, by ${method}`, () => {
      const eth = ethOf(walletWith(1n, []), method)
      assert.equal(eth.reconciliation?.status, "reconciled")
      assert.equal(eth.values.qty, (E18 / 2n + 1n).toString())
      assert.deepEqual([eth.values.costMicros, eth.values.unrealizedMicros, eth.values.averageCostMicros], [null, null, null])
    })

    it(`carries no cost to a linked wallet later on, by ${method}`, () => {
      const sender = walletWith(E18, [later("0xnext", ETH_ADDRESS, "debit", E18, "eth", OTHER)])
      const received = buildPricedLegs({ account: OTHER, rows: [{ ...later("0xnext", ETH_ADDRESS, "credit", E18, "eth", ME), account: OTHER }], references: [reference(501)], priced: [] })
      const recipient = { ...blockOf({ account: OTHER, rows: [], before: 0n, after: E18 }), legs: received, coverage: { fromBlock: BLOCK, toBlock: 501 } } as WalletResponse
      const linked = { ...book, senders: { [ME]: { kind: "mine" as const }, [OTHER]: { kind: "mine" as const } } }
      const arrived = foldBook(recipient, [sender], method, linked).positions.find((p) => p.asset === "ETH")!.effects[0]!.leg
      assert.ok(arrived.pieces?.length && arrived.pieces.every((piece) => piece.costMicros === null))
    })

    it(`gives the same result whichever transaction is named, by ${method}`, () => {
      const read = (payer?: EthPayer) => {
        const eth = ethOf(walletWith(E18, sale(E18, 2_000_000_000n), undefined, payer), method)
        return [eth.values.costMicros, eth.values.realizedMicros, eth.state.lots.map((lot) => [lot.qty, lot.costMicros])]
      }
      assert.deepEqual(read(), read({ txHash: "0xguess", sender: OTHER }))
    })

    it(`loses what was held before when only a fee left, by ${method}`, () => {
      const fee = [at500("0xfee", ETH_ADDRESS, "debit", E18 / 1000n, "gas")]
      const eth = ethOf(walletWith(E18, sale(E18 / 2n, 1_000_000_000n), fee), method)
      assert.equal(eth.values.costMicros, null)
      assert.equal(eth.values.realizedMicros, null)
      assert.ok(eth.state.lots.every((lot) => lot.costMicros === null))
    })

    it(`keeps what the wallet buys afterward at what it paid, by ${method}`, () => {
      const buy = [later("0xbuy", USDC_ADDRESS, "debit", 2_000_000_000n, "erc20"), later("0xbuy", ETH_ADDRESS, "credit", E18, "eth")]
      const eth = ethOf(walletWith(E18, buy), method)
      const bought = eth.effects.find(({ leg }) => leg.txHash === "0xbuy")!.leg
      assert.deepEqual([bought.costLabel, bought.costMicros], ["paid", "2000000000"])
      assert.equal(eth.values.costMicros, null, "what's mixed with it still has no cost")
    })
  }

  it("leaves a block with nothing else moving ETH alone", () => {
    const quiet = walletWith(E18, [], [])
    const eth = ethOf(quiet, "average")
    assert.equal(eth.values.costMicros, "3000000000")
  })
})

describe("two arrivals in one block", () => {
  const OTHER = "0x2222222222222222222222222222222222222222"
  const DIRECT = "0xdirect:ETH"
  const BLOCK = 500
  // 1 ETH costing $1,000 directly and 1 costing $2,000 unseen, then 1 sold for $3,000. Oldest first, that's a gain of $2,000 or $1,000, by which came first.
  const reference = (blockNum: number): Reference => ({ blockNum, ethUsd: "200000000000", usdcUsd: "100000000" })
  const stamp = "2026-11-05T00:00:00.000Z"
  const withSale = (payer?: EthPayer) => {
    const rows = [at500("0xdirect", ETH_ADDRESS, "credit", E18, "eth"), { ...at500("0xsale", ETH_ADDRESS, "debit", E18, "eth"), block_num: 501 }, { ...at500("0xsale", USDC_ADDRESS, "credit", 3_000_000_000n, "erc20"), block_num: 501 }]
    const settled = creditUnseenEth({ rows, ethBalances: new Map([[BLOCK - 1, "0"], [BLOCK, (2n * E18).toString()]]), feeUnknownTxs: [], gasUnknownBlocks: [], account: ME, fromBlock: BLOCK, through: 501, payers: new Map(payer ? [[BLOCK, payer]] : []), timestampOf: () => stamp })
    const legs = buildPricedLegs({ account: ME, rows: settled, references: [reference(BLOCK), { ...reference(501), ethUsd: "300000000000" }], priced: [] })
    const base = blockOf({ rows: [], before: 0n, after: E18, amounts: { USDC: "3000000000" } })
    return { ...base, legs, coverage: { fromBlock: BLOCK, toBlock: 501 } } as WalletResponse
  }
  const answers = { ...emptyBook(), costs: { [costKey(ME, DIRECT)]: usd("1000000000"), [costKey(ME, UNSEEN)]: usd("2000000000") } }
  const named: [string, EthPayer | undefined][] = [["no transaction named", undefined], ["a transaction named", { txHash: "0xguess", sender: OTHER }]]

  for (const [name, payer] of named) {
    it(`oldest first has no answer, with ${name}`, () => {
      const fold = foldBook(withSale(payer), [], "fifo", answers)
      const eth = fold.positions.find((p) => p.asset === "ETH")!
      assert.equal(eth.reconciliation?.status, "reconciled")
      assert.deepEqual([eth.values.costMicros, eth.values.realizedMicros, eth.values.unrealizedMicros], [null, null, null])
      assert.ok(eth.effects.filter(({ leg }) => BigInt(leg.delta) > 0n).every(({ leg }) => leg.costMicros === null && leg.costLabel === "unknown"))
      assert.ok(!fold.questions.some((q) => q.receipts.some((r) => r.legId === UNSEEN || r.legId === DIRECT)))
    })

    it(`the average does, because either order comes to the same, with ${name}`, () => {
      const eth = foldBook(withSale(payer), [], "average", answers).positions.find((p) => p.asset === "ETH")!
      assert.deepEqual([eth.values.costMicros, eth.values.realizedMicros], ["1500000000", "1500000000"])
    })
  }

  it("gives the same answer when the transaction is only named after a first read", async () => {
    const results = [undefined, { txHash: "0xguess", sender: OTHER }].map((payer) => {
      const eth = foldBook(withSale(payer), [], "fifo", answers).positions.find((p) => p.asset === "ETH")!
      return [eth.values.costMicros, eth.values.realizedMicros, eth.effects.map(({ leg }) => leg.id)]
    })
    assert.deepEqual(results[0], results[1])
  })

  it("carries no cost to a linked wallet by oldest first", () => {
    const rows = [at500("0xdirect", ETH_ADDRESS, "credit", E18, "eth"), { ...at500("0xsend", ETH_ADDRESS, "debit", E18, "eth", OTHER), block_num: 501 }]
    const settled = creditUnseenEth({ rows, ethBalances: new Map([[BLOCK - 1, "0"], [BLOCK, (2n * E18).toString()]]), feeUnknownTxs: [], gasUnknownBlocks: [], account: ME, fromBlock: BLOCK, through: 501, payers: new Map(), timestampOf: () => stamp })
    const legs = buildPricedLegs({ account: ME, rows: settled, references: [reference(BLOCK), reference(501)], priced: [] })
    const sender = { ...blockOf({ rows: [], before: 0n, after: E18 }), legs, coverage: { fromBlock: BLOCK, toBlock: 501 } } as WalletResponse
    const received = buildPricedLegs({ account: OTHER, rows: [{ ...at500("0xsend", ETH_ADDRESS, "credit", E18, "eth", ME), account: OTHER, block_num: 501 }], references: [reference(501)], priced: [] })
    const recipient = { ...blockOf({ account: OTHER, rows: [], before: 0n, after: E18 }), legs: received, coverage: { fromBlock: BLOCK, toBlock: 501 } } as WalletResponse
    const linked = { ...answers, senders: { [ME]: { kind: "mine" as const }, [OTHER]: { kind: "mine" as const } } }
    const arrived = foldBook(recipient, [sender], "fifo", linked).positions.find((p) => p.asset === "ETH")!.effects[0]!.leg
    assert.ok(arrived.pieces?.every((piece) => piece.costMicros === null))
  })
})

describe("a pooled tax report", () => {
  const A = ME
  const B = "0x2222222222222222222222222222222222222222"
  // A holds 1 ETH costing $1,000, and sells 0.5 for $1,000 in the block where B receives 1 unseen, costing $2,000.
  const sale = [at500("0xsale", ETH_ADDRESS, "debit", E18 / 2n, "eth"), at500("0xsale", USDC_ADDRESS, "credit", 1_000_000_000n, "erc20")]
  const seller = blockOf({ rows: sale, before: E18, after: E18 / 2n, opening: E18, amounts: { USDC: "1000000000" } })
  const book = { ...emptyBook(), costs: { [costKey(A, "opening:ETH")]: usd("1000000000"), [costKey(B, UNSEEN)]: usd("2000000000") } }
  const named: [string, EthPayer | undefined][] = [["no transaction named", undefined], ["a transaction named", { txHash: "0xguess", sender: A }]]

  for (const [name, payer] of named) {
    for (const method of ["average", "fifo"] as const) {
      it(`leaves a sale beside another wallet's unseen ETH unresolved, by ${method}, with ${name}`, () => {
        const receiver = blockOf({ account: B, rows: [], before: 0n, after: E18, ...(payer ? { payer } : {}) })
        const rows = taxRows([seller, receiver], { method, scope: "pooled" }, { book }).filter((row) => row.asset === "ETH" && row.type === "Sold")
        assert.deepEqual(rows.map((row) => [row.costMicros, row.gainMicros, row.status]), [[null, null, "unresolved"]])
      })
    }
  }

  it("keeps each wallet's own answer when they're reported apart, where the order can't matter", () => {
    const receiver = blockOf({ account: B, rows: [], before: 0n, after: E18 })
    const [row] = taxRows([seller, receiver], { method: "average", scope: "per-wallet" }, { book }).filter((r) => r.asset === "ETH" && r.type === "Sold")
    assert.deepEqual([row!.costMicros, row!.gainMicros], ["500000000", "500000000"])
  })
})

describe("a cost note about a transaction", () => {
  const TX = `0x${"aa".repeat(32)}`
  const NOTE = { noteTx: `0x${"bb".repeat(32)}`, blockNum: 501, txHash: TX, asset: "ETH", usdMicros: "1000000000" }
  const PAYER = "0x2222222222222222222222222222222222222222"
  // 1,000 USDC sold for 0.4 WETH, with 0.1 ETH rising in the same block, and this transaction named as the likeliest source.
  const sale = [at500(TX, USDC_ADDRESS, "debit", 1_000_000_000n, "erc20"), at500(TX, WETH_ADDRESS, "credit", (4n * E18) / 10n, "erc20")]
  const mixed = (notes: unknown[] = []) => ({ ...blockOf({ rows: sale, before: 0n, after: E18 / 10n, payer: { txHash: TX, sender: PAYER }, amounts: { ETH: (E18 / 2n).toString(), USDC: "0" } }), notes }) as WalletResponse
  const ethOf = (wallet: WalletResponse, book = emptyBook()) => foldBook(wallet, [], "average", book).positions.find((p) => p.asset === "ETH")!

  it("isn't offered for either receipt when it could be about both", () => {
    const { questions } = foldBook(mixed(), [], "average", emptyBook())
    assert.ok(questions.length >= 2)
    assert.ok(questions.every((q) => q.noteAbout === null))
  })

  it("gives neither receipt its cost, so it's never counted twice, or shared out by a guess", () => {
    const eth = ethOf(mixed([NOTE]))
    assert.equal(eth.reconciliation?.status, "reconciled")
    assert.ok(eth.effects.every(({ leg }) => leg.costMicros === null))
    assert.deepEqual([eth.values.costMicros, eth.values.unrealizedMicros], [null, null])
  })

  it("leaves each receipt answerable on its own", () => {
    const book = { ...emptyBook(), costs: { [costKey(ME, `${TX}:ETH`)]: usd("800000000"), [costKey(ME, UNSEEN)]: usd("200000000") } }
    assert.equal(ethOf(mixed([NOTE]), book).values.costMicros, "1000000000")
  })

  it("still covers ETH found from a balance when nothing else arrived with it, once", () => {
    const alone = { ...blockOf({ rows: [], before: 0n, after: E18 / 10n, payer: { txHash: TX, sender: PAYER } }), notes: [NOTE] } as WalletResponse
    const eth = ethOf(alone)
    assert.equal(eth.effects.find(({ leg }) => leg.id === UNSEEN)!.leg.costMicros, "1000000000")
    assert.equal(eth.values.costMicros, "1000000000")
    const unanswered = foldBook({ ...alone, notes: [] } as WalletResponse, [], "average", emptyBook())
    assert.equal(unanswered.questions[0]!.noteAbout, TX)
  })

  it("still covers an ordinary receipt when nothing unseen shares its transaction", () => {
    const receipt = [at500(TX, WETH_ADDRESS, "credit", (4n * E18) / 10n, "erc20")]
    const plain = blockOf({ rows: receipt, before: 0n, after: 0n, amounts: { ETH: ((4n * E18) / 10n).toString() } })
    assert.deepEqual(foldBook(plain, [], "average", emptyBook()).questions.map((q) => q.noteAbout), [TX])
    const eth = ethOf({ ...plain, notes: [NOTE] } as WalletResponse)
    assert.equal(eth.reconciliation?.status, "reconciled")
    assert.equal(eth.values.costMicros, "1000000000")
  })

  it("doesn't reach ETH with no transaction named", () => {
    const blind = { ...blockOf({ rows: [], before: 0n, after: E18 / 10n }), notes: [NOTE] } as WalletResponse
    assert.equal(ethOf(blind).values.costMicros, null)
  })
})
