import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { DEPOSIT_TOPIC, TRANSFER_BATCH_TOPIC, TRANSFER_SINGLE_TOPIC, TRANSFER_TOPIC, WITHDRAWAL_TOPIC, decodeRoundAnswer, effectiveGasPrice, gasPaid, legRowsFromRaw, type RawLog, type RawTx } from "../server/raw.ts"
import { blockFilters } from "../server/source.ts"
import { ETH_ADDRESS, USDC_ADDRESS, WETH_ADDRESS } from "../src/core/tokens.ts"

const ME = "dd8795475306152abe5f45f1ce97c017fd2f02e7"
const OTHER = "f849e0d4a7a1d74cb278361ff29967dfb5a22c67"
const pad = (a: string) => a.padStart(64, "0")

// A real type 2 transaction, 0x98706a6c…, block 53510500, with its receipt:
// gasUsed 881954, cumulativeGasUsed 1339297, effectiveGasPrice 105009548.
const REAL_TX: RawTx = {
  block_num: 53510500,
  timestamp: "2026-11-04T00:00:00.000Z",
  tx_hash: "0x98706a6cda6af885aaa5d86a9979f5c4502e233e6a8288f9481ca4c5f848918f",
  tx_index: 3,
  from: ME,
  to: OTHER,
  value: "6000000000000000",
  gas_used: "1339297",
  gas_price: null,
  max_fee_per_gas: "131250000",
  max_priority_fee_per_gas: "100000000",
  status: true,
  type: 2,
}
const CONTEXT = {
  cumulativeGas: new Map([["53510500:2", String(1339297 - 881954)]]),
  baseFeeByBlock: new Map([[53510500, "5009548"]]),
}

const log = (partial: Partial<RawLog>): RawLog => ({
  block_num: 1,
  timestamp: "2026-11-04T00:00:00.000Z",
  tx_hash: "0xabc",
  tx_index: 1,
  log_index: 2,
  address: USDC_ADDRESS.slice(2),
  topic0: TRANSFER_TOPIC,
  topic1: null,
  topic2: null,
  topic3: null,
  data: (500).toString(16).padStart(64, "0"),
  ...partial,
})

describe("gas", () => {
  it("matches the real receipt: gas_used is cumulative, and gas_price is null on type 2", () => {
    assert.equal(effectiveGasPrice(REAL_TX, "5009548"), 105009548n)
    assert.equal(gasPaid(REAL_TX, CONTEXT), 92613590896792n)
  })

  it("the max fee caps the price", () => {
    assert.equal(effectiveGasPrice({ gas_price: null, max_fee_per_gas: "10", max_priority_fee_per_gas: "9" }, "5"), 10n)
  })

  it("uses gas_price when it's there", () => {
    assert.equal(effectiveGasPrice({ gas_price: "7", max_fee_per_gas: null, max_priority_fee_per_gas: null }, undefined), 7n)
  })

  it("is null rather than wrong when the previous transaction is missing", () => {
    assert.equal(gasPaid(REAL_TX, { ...CONTEXT, cumulativeGas: new Map() }), null)
    const { rows, gasUnknownTxs } = legRowsFromRaw({ account: ME, txs: [REAL_TX], logs: [], withdrawals: [], gas: { ...CONTEXT, cumulativeGas: new Map() } })
    assert.equal(gasUnknownTxs.length, 1)
    assert.equal(rows.filter((r) => r.kind === "gas").length, 0)
  })
})

describe("rows from raw data", () => {
  const empty = { txs: [], logs: [], withdrawals: [], gas: CONTEXT }

  it("a sent transaction is gas plus its ETH value", () => {
    const { rows } = legRowsFromRaw({ ...empty, account: ME, txs: [REAL_TX] })
    assert.deepEqual(rows.map((r) => [r.kind, r.side, r.amount, r.token]), [
      ["gas", "debit", "92613590896792", ETH_ADDRESS],
      ["eth", "debit", "6000000000000000", ETH_ADDRESS],
    ])
  })

  it("a failed transaction costs gas, and moves no ETH", () => {
    const { rows } = legRowsFromRaw({ ...empty, account: ME, txs: [{ ...REAL_TX, status: false }] })
    assert.deepEqual(rows.map((r) => r.kind), ["gas"])
  })

  it("receiving ETH costs no gas", () => {
    const { rows } = legRowsFromRaw({ ...empty, account: OTHER, txs: [REAL_TX] })
    assert.deepEqual(rows.map((r) => [r.kind, r.side]), [["eth", "credit"]])
  })

  it("an OP Stack deposit costs no L2 gas", () => {
    const { rows } = legRowsFromRaw({ ...empty, account: ME, txs: [{ ...REAL_TX, type: 126, value: "0" }] })
    assert.equal(rows.length, 0)
  })

  it("decodes both sides of a transfer", () => {
    const logs = [log({ topic1: pad(ME), topic2: pad(OTHER) }), log({ topic1: pad(OTHER), topic2: pad(ME) })]
    const { rows } = legRowsFromRaw({ ...empty, account: ME, logs })
    assert.deepEqual(rows.map((r) => [r.side, r.amount, r.token, r.account]), [
      ["debit", "500", USDC_ADDRESS, `0x${ME}`],
      ["credit", "500", USDC_ADDRESS, `0x${ME}`],
    ])
  })

  describe("tokens off the allowlist", () => {
    const JACK = "000000000000000000000000000000000000f00d"

    it("a transfer is kept as evidence, on both sides", () => {
      const logs = [log({ address: JACK, topic1: pad(ME), topic2: pad(OTHER) }), log({ address: JACK, topic1: pad(OTHER), topic2: pad(ME) })]
      const { rows } = legRowsFromRaw({ ...empty, account: ME, logs })
      assert.deepEqual(rows.map((r) => [r.kind, r.side, r.amount, r.token]), [
        ["unlisted", "debit", "500", `0x${JACK}`],
        ["unlisted", "credit", "500", `0x${JACK}`],
      ])
    })

    it("an NFT keeps its ID apart from any quantity, including ID 0", () => {
      const logs = [log({ address: JACK, topic1: pad(OTHER), topic2: pad(ME), topic3: pad("2a"), data: "" }), log({ address: JACK, topic1: pad(ME), topic2: pad(OTHER), topic3: pad("0"), data: "" })]
      const { rows } = legRowsFromRaw({ ...empty, account: ME, logs })
      assert.deepEqual(rows.map((r) => [r.kind, r.side, r.amount]), [
        ["unlisted_nft", "credit", "42"],
        ["unlisted_nft", "debit", "0"],
      ])
    })

    for (const [name, topic0] of [["TransferSingle", TRANSFER_SINGLE_TOPIC], ["TransferBatch", TRANSFER_BATCH_TOPIC]] as const) {
      it(`ERC-1155 ${name} says something moved, by its from and to, not its operator`, () => {
        const logs = [
          log({ address: JACK, topic0, topic1: pad(ME), topic2: pad(OTHER), topic3: pad(OTHER) }),
          log({ address: JACK, topic0, topic1: pad(OTHER), topic2: pad(ME), topic3: pad(OTHER) }),
          log({ address: JACK, topic0, topic1: pad(OTHER), topic2: pad(OTHER), topic3: pad(ME) }),
        ]
        const { rows } = legRowsFromRaw({ ...empty, account: ME, logs })
        assert.deepEqual(rows.map((r) => [r.kind, r.side, r.amount]), [
          ["unlisted", "debit", ""],
          ["unlisted", "credit", ""],
        ])
      })
    }

    it("a contract that isn't WETH can't fake a Deposit or a Withdrawal", () => {
      const logs = [log({ address: JACK, topic0: DEPOSIT_TOPIC, topic1: pad(ME) }), log({ address: USDC_ADDRESS.slice(2), topic0: WITHDRAWAL_TOPIC, topic1: pad(ME) })]
      assert.equal(legRowsFromRaw({ ...empty, account: ME, logs }).rows.length, 0)
    })
  })

  it("WETH's Deposit and Withdrawal count, since WETH emits no Transfer for them", () => {
    const weth = WETH_ADDRESS.slice(2)
    const logs = [log({ address: weth, topic0: DEPOSIT_TOPIC, topic1: pad(ME) }), log({ address: weth, topic0: WITHDRAWAL_TOPIC, topic1: pad(ME) })]
    const { rows } = legRowsFromRaw({ ...empty, account: ME, logs })
    assert.deepEqual(rows.map((r) => [r.kind, r.side, r.token]), [
      ["wrap", "credit", WETH_ADDRESS],
      ["unwrap", "debit", WETH_ADDRESS],
    ])
  })

  it("without traces, a WETH Withdrawal in a transaction counts as ETH paid to its sender", () => {
    const withdrawal = log({ address: WETH_ADDRESS.slice(2), topic0: WITHDRAWAL_TOPIC, topic1: pad(OTHER), tx_hash: REAL_TX.tx_hash })
    const mine = legRowsFromRaw({ ...empty, account: ME, txs: [{ ...REAL_TX, value: "0" }], withdrawals: [withdrawal] })
    assert.deepEqual(mine.rows.filter((r) => r.kind === "unwrap").map((r) => [r.token, r.side, r.amount]), [[ETH_ADDRESS, "credit", "500"]])
    const notMine = legRowsFromRaw({ ...empty, account: ME, withdrawals: [withdrawal] })
    assert.equal(notMine.rows.length, 0)
  })
})

describe("the oracle", () => {
  const word = (n: bigint) => (n < 0n ? (2n ** 256n + n) : n).toString(16).padStart(64, "0")

  it("reads the answer word of latestRoundData", () => {
    assert.equal(decodeRoundAnswer(word(9n) + word(243000000000n) + word(1n) + word(2n) + word(3n)), "243000000000")
  })

  it("a failed or negative read is empty, not a price", () => {
    assert.equal(decodeRoundAnswer(null), "")
    assert.equal(decodeRoundAnswer(""), "")
    assert.equal(decodeRoundAnswer(word(9n) + word(-5n)), "")
  })
})

describe("block filters", () => {
  it("always carry a range, which is what lets Amp skip files", () => {
    assert.deepEqual(blockFilters([5, 3, 3]), [{ filter: "block_num BETWEEN 3 AND 5 AND block_num IN (3, 5)", count: 2 }])
  })

  it("split long lists", () => {
    const filters = blockFilters(Array.from({ length: 450 }, (_, i) => i + 1))
    assert.deepEqual(filters.map((f) => f.count), [200, 200, 50])
    assert.match(filters[1]!.filter, /^block_num BETWEEN 201 AND 400 /)
  })
})

describe("who was on the other side", () => {
  const sender = "00000000000000000000000000000000000000dd"
  const log = { block_num: 1, timestamp: "2026-11-04T00:00:00.000Z", tx_hash: "aa", tx_index: 1, log_index: 2, address: USDC_ADDRESS, topic0: TRANSFER_TOPIC, topic3: null, data: (5n).toString(16).padStart(64, "0") }
  const rows = (logs: RawLog[], txs: RawTx[] = []) => legRowsFromRaw({ account: ME, txs, logs, withdrawals: [], gas: CONTEXT }).rows

  it("reads the sender of what arrived, and where what left went", () => {
    const [credit] = rows([{ ...log, topic1: pad(sender), topic2: pad(ME) }])
    assert.equal(credit?.counterparty, `0x${sender}`)
    const [debit] = rows([{ ...log, topic1: pad(ME), topic2: pad(sender) }])
    assert.equal(debit?.counterparty, `0x${sender}`)
  })

  it("reads it from a plain ETH transfer too", () => {
    const tx: RawTx = { ...REAL_TX, from: sender, to: ME, value: "9", status: true }
    assert.equal(rows([], [tx]).find((r) => r.kind === "eth")?.counterparty, `0x${sender}`)
  })
})
