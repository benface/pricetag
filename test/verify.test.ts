import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import type { LegPart, PricedLeg } from "@pricetag/sdk/core"
import type { Query } from "@pricetag/sdk/internal"
import { createDepositReader, readBlock } from "../server/block.ts"
import { createManifestReader, createProofs, proofOf, verificationOf } from "../server/proof.ts"
import { checkHeader, checkReceipts, checkTransactions, encodeTransaction, keccak, rlp, trieRoot, type BlockRow, type DepositDetails, type LogRow, type TxRow } from "../server/verify.ts"

/** Real rows from Amp's Base dataset: a whole block, a current header, and one transaction of each kind. */
const FIXTURES = JSON.parse(readFileSync(new URL("./support/base-blocks.json", import.meta.url), "utf8")) as {
  block: { block: BlockRow; txs: TxRow[]; logs: LogRow[] }
  deposits: Record<string, DepositDetails>
  latestHeader: BlockRow
  samples: TxRow[]
  sampleDeposits: Record<string, DepositDetails>
}
const { block, txs, logs } = FIXTURES.block
const deposits = new Map(Object.entries(FIXTURES.deposits))
const data = { block, txs, logs }

const ascii = (text: string) => Buffer.from(text, "ascii")

describe("the encoding", () => {
  it("matches RLP's published examples", () => {
    assert.equal(rlp(ascii("dog")).toString("hex"), "83646f67")
    assert.equal(rlp([ascii("cat"), ascii("dog")]).toString("hex"), "c88363617483646f67")
    assert.equal(rlp(Buffer.alloc(0)).toString("hex"), "80")
    assert.equal(rlp([]).toString("hex"), "c0")
    assert.equal(rlp(Buffer.from([15])).toString("hex"), "0f")
    assert.equal(rlp(Buffer.from([4, 0])).toString("hex"), "820400")
    const long = ascii("Lorem ipsum dolor sit amet, consectetur adipisicing elit")
    assert.equal(rlp(long).toString("hex").slice(0, 4), "b838")
  })

  it("hashes with Keccak, which isn't the same as SHA-3", () => {
    assert.equal(keccak(Buffer.alloc(0)).toString("hex"), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")
  })

  it("matches the trie's published examples", () => {
    assert.equal(trieRoot([]), "56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421")
    const entries = [["doe", "reindeer"], ["dog", "puppy"], ["dogglesworth", "cat"]].map(([key, value]) => [ascii(key as string), ascii(value as string)] as const)
    assert.equal(trieRoot(entries), "8aad789dff2f538bca5d8ea56e8abe10f4c7ba3a5dea95fea4cd6e7c3a1168d3")
  })

  it("gives each kind of transaction the hash the chain gave it", () => {
    const types = FIXTURES.samples.map((tx) => tx.type)
    for (const type of [0, 1, 2, 4, 126]) assert.ok(types.includes(type), `no sample of type ${type}`)
    assert.ok(FIXTURES.samples.some((tx) => tx.accessList.length > 1), "no sample with an access list")
    for (const tx of FIXTURES.samples) {
      assert.equal(keccak(encodeTransaction(tx, FIXTURES.sampleDeposits[tx.tx_hash])).toString("hex"), tx.tx_hash, `type ${tx.type}`)
    }
  })
})

describe("checking a block", () => {
  it("passes a real block, and a current header with every field", () => {
    assert.deepEqual(checkHeader(block), { status: "passed" })
    assert.deepEqual(checkHeader(FIXTURES.latestHeader), { status: "passed" })
    assert.deepEqual(checkTransactions(block, txs, deposits), { status: "passed" })
    assert.deepEqual(checkReceipts(block, txs, logs), { status: "passed" })
  })

  it("fails a changed header field", () => {
    assert.equal(checkHeader({ ...block, gas_used: "1" }).status, "failed")
    assert.equal(checkHeader({ ...FIXTURES.latestHeader, requests_hash: "00".repeat(32) }).status, "failed")
    // A field that shouldn't be there at all isn't left out of the hash.
    assert.equal(checkHeader({ ...block, requests_hash: "00".repeat(32) }).status, "failed")
  })

  it("fails a changed, missing or reordered transaction", () => {
    const [deposit, user] = txs as [TxRow, TxRow]
    assert.equal(checkTransactions(block, [deposit, { ...user, value: "1" }], deposits).status, "failed")
    assert.equal(checkTransactions(block, [deposit], deposits).status, "failed")
    assert.equal(checkTransactions(block, [user, deposit], deposits).status, "failed")
  })

  it("fails a transaction's stored hash when it isn't its hash, even with the summary intact", () => {
    const [deposit, user] = txs as [TxRow, TxRow]
    assert.equal(checkTransactions(block, [deposit, { ...user, tx_hash: "00".repeat(32) }], deposits).status, "failed")
  })

  it("fails wrong details for a deposit, wherever they came from", () => {
    const [hash, details] = [...deposits][0] as [string, DepositDetails]
    assert.equal(checkTransactions(block, txs, new Map([[hash, { ...details, sourceHash: "00".repeat(32) }]])).status, "failed")
  })

  it("can't check a deposit with no details, which isn't a failure", () => {
    assert.equal(checkTransactions(block, txs, null).status, "unchecked")
    assert.equal(checkTransactions(block, txs, new Map()).status, "unchecked")
  })

  it("can't check a kind of transaction it doesn't read, which isn't a failure", () => {
    const [deposit, user] = txs as [TxRow, TxRow]
    assert.equal(checkTransactions(block, [deposit, { ...user, type: 3 }], deposits).status, "unchecked")
  })

  it("fails a changed, missing or moved log", () => {
    const [first, ...rest] = logs as [LogRow, ...LogRow[]]
    assert.equal(checkReceipts(block, txs, [{ ...first, data: `${first.data}00` }, ...rest]).status, "failed")
    assert.equal(checkReceipts(block, txs, rest).status, "failed")
    assert.equal(checkReceipts(block, txs, [...rest, first]).status, "failed")
    assert.equal(checkReceipts(block, txs, [{ ...first, topics: [] }, ...rest]).status, "failed")
  })

  it("fails a log that wouldn't be hashed, rather than counting it as checked", () => {
    const stray = { ...(logs[0] as LogRow), tx_index: 999, log_index: 999 }
    assert.deepEqual(checkReceipts(block, txs, [...logs, stray]).status, "failed")
    const check = verificationOf(legOf({}), [], { ...data, logs: [...logs, stray] }, deposits).checks[2]!
    assert.equal(check.status, "failed")
    assert.match(check.detail, /#999 says it's from a transaction this block doesn't have/)
  })

  it("fails a log whose number isn't its place in the block, which the activity check relies on", () => {
    const [first, second, third] = logs as [LogRow, LogRow, LogRow]
    assert.equal(checkReceipts(block, txs, [first, second, { ...third, log_index: 50 }]).status, "failed")
    assert.equal(checkReceipts(block, txs, [{ ...first, log_index: 1 }, { ...second, log_index: 0 }, third]).status, "failed")
  })

  it("fails a transaction whose stored position isn't its place in the block", () => {
    const [deposit, user] = txs as [TxRow, TxRow]
    assert.equal(checkTransactions(block, [deposit, { ...user, tx_index: 5 }], deposits).status, "failed")
  })

  it("fails a changed result", () => {
    const [deposit, user] = txs as [TxRow, TxRow]
    assert.equal(checkReceipts(block, [deposit, { ...user, status: !user.status }], logs).status, "failed")
    assert.equal(checkReceipts(block, [deposit, { ...user, gas_used: "1" }], logs).status, "failed")
  })
})

const user = txs[1] as TxRow
const account = `0x${user.from}`

const TRANSFER = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
const USDC = "833589fcd6edb6e08f4c7c32d4f71b54bda02913"
const ALICE = "aa".repeat(20)
const BOB = "bb".repeat(20)
/** Added to the fixture block for the activity check, which is why its summaries don't match in these tests. */
const transferLog: LogRow = { tx_index: user.tx_index, log_index: 50, address: USDC, topics: [TRANSFER, ALICE.padStart(64, "0"), BOB.padStart(64, "0")], data: (5_000_000n).toString(16).padStart(64, "0") }

/** What the fixture's transaction paid for gas, by hand: its gas in the block at its effective price. */
const paidForGas = (() => {
  const deposit = txs[0] as TxRow
  const baseFee = BigInt(block.base_fee_per_gas as string)
  const tipped = baseFee + BigInt(user.max_priority_fee_per_gas as string)
  const cap = BigInt(user.max_fee_per_gas as string)
  return (BigInt(user.gas_used) - BigInt(deposit.gas_used)) * (tipped < cap ? tipped : cap)
})()

const legRow = (changes: Partial<LegPart>): LegPart => ({
  logIndex: 0,
  token: "0x0000000000000000000000000000000000000000",
  account,
  side: "debit",
  amount: paidForGas.toString(),
  kind: "gas",
  ...changes,
})

const legOf = (changes: Partial<PricedLeg>): PricedLeg => ({
  id: `0x${user.tx_hash}:ETH`,
  asset: "ETH",
  delta: "-1000000000000000000",
  decimals: 18,
  kind: "transfer",
  priceMicros: "3000000000",
  priceSource: "oracle",
  priceNote: null,
  costMicros: null,
  proceedsMicros: null,
  costLabel: "unknown",
  blockNum: 9200017,
  timestamp: "2024-01-30T00:00:00.000Z",
  txHash: `0x${user.tx_hash}`,
  txIndex: user.tx_index,
  parts: [legRow({})],
  ...changes,
})

const activity = (leg: PricedLeg, legs: PricedLeg[] = []) => verificationOf(leg, legs, { block, txs, logs: [...logs, transferLog] }, deposits).checks.at(-1)!

describe("a leg against its checked block", () => {
  it("passes the whole check and says so", () => {
    const verification = verificationOf(legOf({}), [], data, deposits)
    assert.equal(verification.status, "passed")
    assert.equal(verification.blockHash, `0x${block.hash}`)
    assert.deepEqual(verification.checks.map((check) => check.status), ["passed", "passed", "passed", "passed"])
    assert.match(verification.summary, /matches its header/)
  })

  it("says the check leaned on Base's node for a deposit", () => {
    assert.match(verificationOf(legOf({}), [], data, deposits).checks[1]!.detail, /Base's node supplied/)
  })

  it("is only as good as its worst check", () => {
    assert.equal(verificationOf(legOf({}), [], data, null).status, "unchecked")
    assert.equal(verificationOf(legOf({}), [], { ...data, logs: logs.slice(1) }, deposits).status, "failed")
    const missing = verificationOf(legOf({ txHash: `0x${"00".repeat(32)}` }), [], data, deposits)
    assert.equal(missing.status, "failed")
    assert.match(missing.checks.at(-1)!.detail, /isn't in the checked data/)
  })

  it("matches a transfer to its log, down to the amount and who it names", () => {
    const row = legRow({ kind: "erc20", token: `0x${USDC}`, logIndex: transferLog.log_index, amount: "5000000", account: `0x${ALICE}`, side: "debit" })
    const to = `0x${BOB}`
    assert.equal(activity(legOf({ parts: [row] })).status, "passed")
    assert.equal(activity(legOf({ parts: [{ ...row, account: to, side: "credit" }] })).status, "passed")
    assert.equal(activity(legOf({ parts: [{ ...row, amount: "1" }] })).status, "failed")
    assert.equal(activity(legOf({ parts: [{ ...row, account: to }] })).status, "failed")
    assert.equal(activity(legOf({ parts: [{ ...row, token: "0x0000000000000000000000000000000000000001" }] })).status, "failed")
    assert.equal(activity(legOf({ parts: [{ ...row, logIndex: 999 }] })).status, "failed")
  })

  it("doesn't take an NFT's transfer for a token's", () => {
    const nft = logs[0] as LogRow
    assert.equal(nft.data, "")
    const from = `0x${(nft.topics[1] as string).slice(24)}`
    assert.equal(activity(legOf({ parts: [legRow({ kind: "erc20", token: `0x${nft.address}`, logIndex: nft.log_index, amount: "1", account: from })] })).status, "failed")
  })

  it("checks both sides of an exchange, since the price is worked out from them", () => {
    const paidRow = legRow({ kind: "erc20", token: `0x${USDC}`, logIndex: transferLog.log_index, amount: "5000000", account: `0x${ALICE}`, side: "debit" })
    const bought = legOf({ id: "x:AERO", asset: "AERO", kind: "swap", priceSource: "swap", parts: [] })
    const paid = legOf({ id: "x:USDC", asset: "USDC", delta: "-5000000", decimals: 6, kind: "swap", parts: [paidRow] })
    assert.equal(activity(bought, [bought, paid]).status, "passed")
    assert.equal(activity(bought, [bought, { ...paid, parts: [{ ...paidRow, amount: "1" }] }]).status, "failed")
    assert.ok(proofOf(bought, [bought, paid], "USD", [], null).movements.some((line) => /Log #50: 5 USDC sent/.test(line)))
  })

  it("matches direct ETH to the transaction's value", () => {
    const row = legRow({ kind: "eth", amount: user.value, side: "debit" })
    assert.equal(activity(legOf({ parts: [row] })).status, "passed")
    assert.equal(activity(legOf({ parts: [{ ...row, amount: `${user.value}1` }] })).status, "failed")
  })

  it("works out the fee paid to Base from what's hashed, and compares it", () => {
    const row = legRow({ amount: paidForGas.toString() })
    const check = activity(legOf({ kind: "gas", parts: [row] }))
    assert.equal(check.status, "passed")
    assert.match(check.detail, /fee paid to Base matches/)
    const wrong = activity(legOf({ kind: "gas", parts: [{ ...row, amount: "999999999999999999999999" }] }))
    assert.equal(wrong.status, "failed")
    assert.match(wrong.detail, /disagrees with Network fee/)
    assert.equal(activity(legOf({ kind: "gas", parts: [{ ...row, amount: "" }] })).status, "failed")
  })

  describe("only takes a fee from what its type of transaction hashes", () => {
    const gasUsed = BigInt(user.gas_used) - BigInt((txs[0] as TxRow).gas_used)
    /** The activity check on a fee row of this amount, with the fixture's transaction changed. */
    const feeCheck = (changes: Partial<TxRow>, amount: bigint) =>
      verificationOf(legOf({ kind: "gas", parts: [legRow({ amount: amount.toString() })] }), [], { block, txs: [txs[0] as TxRow, { ...user, ...changes }], logs }, deposits)

    it("doesn't believe a made-up price on a dynamic fee transaction, even with every commitment intact", () => {
      for (const type of [2, 4]) {
        const madeUp = 1_000_000_000_000_000_000_000_000n
        const verification = feeCheck({ type, gas_price: madeUp.toString() }, gasUsed * madeUp)
        assert.equal(verification.checks.at(-1)!.status, "failed", `type ${type}`)
        assert.equal(verification.status, "failed")
        assert.equal(feeCheck({ type, gas_price: madeUp.toString() }, paidForGas).checks.at(-1)!.status, "passed", `type ${type}`)
      }
    })

    it("works out a dynamic fee from what's signed and the base fee", () => {
      for (const type of [2, 4]) assert.equal(feeCheck({ type }, paidForGas).checks.at(-1)!.status, "passed", `type ${type}`)
      assert.equal(feeCheck({ max_fee_per_gas: null }, paidForGas).checks.at(-1)!.status, "failed")
      assert.equal(feeCheck({ max_priority_fee_per_gas: null }, paidForGas).checks.at(-1)!.status, "failed")
    })

    it("uses the signed price on legacy and access list transactions, and nothing else", () => {
      for (const type of [0, 1]) {
        assert.equal(feeCheck({ type, gas_price: "5" }, gasUsed * 5n).checks.at(-1)!.status, "passed", `type ${type}`)
        assert.equal(feeCheck({ type, gas_price: "5" }, gasUsed * 6n).checks.at(-1)!.status, "failed", `type ${type}`)
        // These two aren't hashed for this type, so with no price they can't stand in for one.
        assert.equal(feeCheck({ type, gas_price: null }, paidForGas).checks.at(-1)!.status, "failed", `type ${type}`)
      }
    })

    it("doesn't work out a fee for a deposit, which pays none on Base", () => {
      assert.equal(feeCheck({ type: 126 }, paidForGas).checks.at(-1)!.status, "failed")
      assert.equal(feeCheck({ type: 126, gas_price: "5" }, gasUsed * 5n).checks.at(-1)!.status, "failed")
    })
  })

  it("says the fee paid to Ethereum wasn't compared, whatever it claims", () => {
    const leg = legOf({ kind: "gas", parts: [legRow({ amount: paidForGas.toString() }), legRow({ kind: "l1_fee", amount: "999999999999999999999999" })] })
    const check = activity(leg)
    assert.equal(check.status, "passed")
    assert.match(check.detail, /fee paid to Ethereum wasn't compared/)
    assert.ok(proofOf(leg, [], "USD", [], null).scope.some((line) => /doesn't cover the fee paid to Ethereum/.test(line)))
  })

  it("says a sender isn't checked, since changing it and the row together still passes", () => {
    const stranger = "cc".repeat(20)
    const forged = { block, txs: [txs[0] as TxRow, { ...user, from: stranger }], logs }
    const leg = legOf({ kind: "gas", parts: [legRow({ amount: paidForGas.toString(), account: `0x${stranger}` })] })
    const verification = verificationOf(leg, [], forged, deposits)
    assert.equal(verification.status, "passed")
    assert.match(verification.checks.at(-1)!.detail, /sender is as Amp stored it, and isn't checked against the signature/)
    assert.ok(proofOf(leg, [], "USD", [], null).scope.some((line) => /doesn't confirm who sent this transaction/.test(line)))
    assert.match(activity(legOf({ parts: [legRow({ kind: "eth", amount: user.value, side: "debit" })] })).detail, /sender is as Amp stored it/)
  })

  it("doesn't bring up the sender when logs or the recipient already name the account", () => {
    const row = legRow({ kind: "erc20", token: `0x${USDC}`, logIndex: transferLog.log_index, amount: "5000000", account: `0x${ALICE}`, side: "debit" })
    const leg = legOf({ parts: [row] })
    assert.doesNotMatch(activity(leg).detail, /sender/)
    assert.ok(!proofOf(leg, [], "USD", [], null).scope.some((line) => /who sent/.test(line)))
  })

  it("says what's covered for a network fee, and not that its amounts all are", () => {
    const leg = legOf({ kind: "gas", parts: [legRow({ amount: "1" }), legRow({ kind: "l1_fee", amount: "5" })] })
    const scope = proofOf(leg, [], "USD", [], null).scope.join(" ")
    assert.match(scope, /covers the transaction and the fee paid to Base/)
    assert.doesNotMatch(scope, /the amounts/)
  })
})

describe("what the proof says", () => {
  it("says a market price feed's price isn't covered", () => {
    const proof = proofOf(legOf({}), [], "USD", [], null)
    assert.match(proof.source[0] as string, /Chainlink's ETH\/USD price on Base, read from its contract at block 9,200,017/)
    assert.ok(proof.scope.some((line) => /doesn't cover this price/.test(line)))
    assert.ok(proof.links.some((link) => link.url.includes("0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70")))
  })

  it("says what an exchange's price is built from, and that only its amounts are covered", () => {
    const usdc = legOf({ id: "x:USDC", asset: "USDC", delta: "-1000000000", decimals: 6, kind: "swap", priceSource: "oracle", parts: [] })
    const aero = legOf({ id: "x:AERO", asset: "AERO", delta: "2000000000000000000000", kind: "swap", priceSource: "swap", parts: [] })
    const proof = proofOf(aero, [usdc, aero], "USD", [], null)
    assert.match(proof.source[0] as string, /1,000 USDC for 2,000 AERO/)
    assert.match(proof.source[1] as string, /USDC is valued at Chainlink's USDC\/USD price/)
    assert.ok(proof.scope.some((line) => /covers the amounts exchanged/.test(line) && /doesn't cover Chainlink's price/.test(line)))
  })

  it("always says the header isn't proven real, and the calculations aren't proven right", () => {
    for (const leg of [legOf({}), legOf({ priceSource: "swap" }), legOf({ priceSource: null, priceMicros: null })]) {
      const [first] = proofOf(leg, [], "USD", [], null).scope
      assert.match(first as string, /matches the block's header/)
      assert.match(first as string, /doesn't show that the header is on Base's real chain/)
      assert.match(first as string, /or that the dataset's calculations ran correctly/)
      assert.match(first as string, /only identifies its recipe/)
    }
  })

  it("says the Ethereum fee and exchange rate aren't covered, when they're used", () => {
    const leg = legOf({ kind: "gas", parts: [legRow({}), legRow({ kind: "l1_fee", amount: "5" })] })
    const scope = proofOf(leg, [], "CAD", [], null).scope
    assert.ok(scope.some((line) => /fee paid to Ethereum/.test(line)))
    assert.ok(scope.some((line) => /USD to CAD rate/.test(line)))
    assert.ok(!proofOf(legOf({}), [], "USD", [], null).scope.some((line) => /fee paid to Ethereum|rate/.test(line)))
  })

  it("uses plain language", () => {
    const leg = legOf({ parts: [legRow({ kind: "erc20", logIndex: 3, amount: "5", token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" })] })
    const proof = proofOf(leg, [], "CAD", [{ title: "Base's blocks", name: "a/b@1", hash: null }], null)
    const verification = verificationOf(leg, [], data, deposits)
    const words = [...proof.source, ...proof.movements, ...proof.scope, ...proof.links.map((l) => l.title), verification.summary, ...verification.checks.flatMap((c) => [c.title, c.detail])].join(" ")
    assert.doesNotMatch(words, /\b(oracle|legs?|FIFO|Merkle|RLP|trie)\b/i)
  })
})

describe("reading a block", () => {
  /** Answers by which table a query reads. */
  const fakeQuery = (answers: { blocks: unknown[]; transactions?: unknown[]; logs?: unknown[]; entries?: unknown[]; keys?: unknown[]; authorizations?: unknown[] }): { query: Query; asked: string[] } => {
    const asked: string[] = []
    const query = (async (sql: string) => {
      asked.push(sql)
      if (sql.includes("key_count")) return answers.entries ?? []
      if (sql.includes("storage_key")) return answers.keys ?? []
      if (sql.includes("authorization_list")) return answers.authorizations ?? []
      if (sql.includes(".logs")) return answers.logs ?? []
      if (sql.includes(".transactions")) return answers.transactions ?? []
      return answers.blocks
    }) as Query
    return { query, asked }
  }

  it("says when Amp doesn't have the block", async () => {
    assert.equal(await readBlock(fakeQuery({ blocks: [] }).query, "a/b@1", 5), null)
  })

  it("only ever asks about that block", async () => {
    const { query, asked } = fakeQuery({ blocks: [{ hash: "ab", timestamp: 1000 }], entries: [{ tx_index: 0, address: "aa", key_count: "0" }] })
    await readBlock(query, "a/b@1", 53517959)
    assert.ok(asked.length >= 5)
    for (const sql of asked) assert.match(sql, /block_num = 53517959/)
  })

  it("puts access lists back together, including an entry with no keys, which unnest would drop", async () => {
    const { query } = fakeQuery({
      blocks: [{ hash: "ab", timestamp: 1000 }],
      transactions: [{ tx_index: 4, tx_hash: "cc", type: 2 }],
      entries: [
        { tx_index: 4, address: "01", key_count: "2" },
        { tx_index: 4, address: "02", key_count: null },
        { tx_index: 4, address: "03", key_count: "1" },
      ],
      keys: [
        { tx_index: 4, storage_key: "k1" },
        { tx_index: 4, storage_key: "k2" },
        { tx_index: 4, storage_key: "k3" },
      ],
    })
    const read = await readBlock(query, "a/b@1", 5)
    assert.deepEqual(read?.txs[0]?.accessList, [
      { address: "01", storageKeys: ["k1", "k2"] },
      { address: "02", storageKeys: [] },
      { address: "03", storageKeys: ["k3"] },
    ])
  })

  it("rides out a dropped connection, but not one that stays down", async () => {
    let failures = 2
    const flaky = fakeQuery({ blocks: [] })
    const query = (async (sql: string) => {
      if (failures-- > 0) throw new Error("upstream connect error")
      return flaky.query(sql)
    }) as Query
    const quiet = { warn: console.warn }
    console.warn = () => {}
    try {
      const config = { baseDataset: "a/b@1", dataset: null, readDeposits: async () => new Map(), readManifestHash: async () => null, retryPauseMs: 0 }
      assert.equal(await createProofs(query, config).readBlock(5), null)
      const down = (async () => {
        throw new Error("down")
      }) as Query
      await assert.rejects(createProofs(down, config).readBlock(5), /down/)
    } finally {
      console.warn = quiet.warn
    }
  })
})

describe("reading deposits", () => {
  const answer = (results: unknown) => new Response(JSON.stringify(results), { status: 200 })

  it("needs no read for a block with no deposits", async () => {
    const reader = createDepositReader("http://rpc", (async () => assert.fail("asked")) as typeof fetch)
    assert.deepEqual(await reader([]), new Map())
  })

  it("reads what Amp doesn't store", async () => {
    const send = (async () => answer([{ id: 0, result: { sourceHash: "0xaa", mint: "0x5", isSystemTx: true } }])) as unknown as typeof fetch
    assert.deepEqual(await createDepositReader("http://rpc", send)(["ab"]), new Map([["ab", { sourceHash: "0xaa", mint: "0x5", isSystemTx: true }]]))
  })

  it("waits out a 429", async () => {
    let calls = 0
    const send = (async () => (++calls === 1 ? new Response("", { status: 429 }) : answer([{ id: 0, result: { sourceHash: "0xaa" } }]))) as unknown as typeof fetch
    const read = await createDepositReader("http://rpc", send, 0)(["ab"])
    assert.equal(read?.get("ab")?.mint, "0x0")
    assert.equal(calls, 2)
  })

  it("gives nothing unless every deposit was read, and never logs the RPC's URL", async () => {
    const partial = (async () => answer([{ id: 0, result: { sourceHash: "0xaa" } }, { id: 1, result: null }])) as unknown as typeof fetch
    assert.equal(await createDepositReader("http://rpc", partial)(["ab", "cd"]), null)

    const logged: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => void logged.push(args.join(" "))
    try {
      const down = (async () => new Response("", { status: 500 })) as unknown as typeof fetch
      assert.equal(await createDepositReader("http://secret-key.rpc", down)(["ab"]), null)
    } finally {
      console.error = original
    }
    assert.ok(logged.length > 0)
    assert.ok(!logged.join(" ").includes("secret-key"))
  })
})

describe("a dataset's fingerprint", () => {
  const HASH = "bea12f7575e74575f2f0318213d61d421706eea0314e5d7116edebd4e77818a1"

  it("is read from the admin API with the server's token", async () => {
    const asked: { url: string; auth: unknown }[] = []
    const send = (async (url: string, init: RequestInit) => {
      asked.push({ url, auth: (init.headers as Record<string, string>).authorization })
      return new Response(JSON.stringify({ manifest_hash: HASH }), { status: 200 })
    }) as unknown as typeof fetch
    assert.equal(await createManifestReader("https://amp.example/controller/", "tok", send)("benface/pricetag@0.0.1"), HASH)
    assert.deepEqual(asked, [{ url: "https://amp.example/controller/datasets/benface/pricetag/versions/0.0.1", auth: "Bearer tok" }])
  })

  it("is null, never made up, when it can't be read", async () => {
    const original = console.error
    console.error = () => {}
    try {
      const down = (async () => new Response("", { status: 401 })) as unknown as typeof fetch
      assert.equal(await createManifestReader("https://amp.example", "tok", down)("a/b@1"), null)
      const odd = (async () => new Response(JSON.stringify({ manifest_hash: "nope" }), { status: 200 })) as unknown as typeof fetch
      assert.equal(await createManifestReader("https://amp.example", "tok", odd)("a/b@1"), null)
      const never = (async () => assert.fail("asked")) as typeof fetch
      assert.equal(await createManifestReader("https://amp.example", "tok", never)("not a dataset"), null)
    } finally {
      console.error = original
    }
  })
})
