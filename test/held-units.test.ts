import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { formatAmount, type Lot, type PricedLeg } from "@pricetag/sdk/core"
import type { WalletResponse } from "../src/core/api.ts"
import { emptyBook, parseUnitChoice, recordUnitChoices } from "../src/core/book.ts"
import { DEMO_WALLET } from "../src/core/fixtures.ts"
import { choiceOf, heldIn, heldOf, picksProblem } from "../src/core/held-units.ts"
import { taxRows } from "../src/core/tax.ts"

const USD = 1_000_000n
const ETH = 10n ** 18n
const A = "0x00000000000000000000000000000000000000a1"
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`
const at = (block: number) => new Date(Date.UTC(2026, 10, 4) + block * 2000).toISOString()
const format = (units: bigint) => `${formatAmount(units, 18)} ETH`

const leg = (block: number, delta: bigint, fields: Partial<PricedLeg> = {}): PricedLeg => ({
  id: `${hash(block)}:ETH`,
  asset: "ETH",
  decimals: 18,
  delta: delta.toString(),
  kind: "swap",
  priceMicros: (2000n * USD).toString(),
  priceSource: "oracle",
  priceNote: null,
  costMicros: null,
  proceedsMicros: null,
  costLabel: "unknown",
  blockNum: block,
  timestamp: at(block),
  txHash: hash(block),
  txIndex: 0,
  parts: [],
  ...fields,
})
const buy = (block: number, units: bigint, paid: bigint) => leg(block, units * ETH, { costMicros: (paid * USD).toString(), costLabel: "paid" })
const sell = (block: number, units: bigint, received: bigint) => leg(block, -units * ETH, { proceedsMicros: (received * USD).toString() })

function walletOf(legs: PricedLeg[]): WalletResponse {
  const amounts: Record<string, string> = {}
  for (const l of legs) amounts[l.asset] = (BigInt(amounts[l.asset] ?? 0) + BigInt(l.delta)).toString()
  return {
    ...DEMO_WALLET,
    address: A,
    mode: "dataset",
    coverage: { fromBlock: 1, toBlock: 1000 },
    latest: { blockNum: 1000, timestamp: at(1000) },
    legs,
    balances: { blockNum: 1000, amounts },
    lastBalances: {},
    lastCheckableEth: null,
    unreadBalances: [],
    openingUnread: [],
    gasUnknownTxs: [],
    l1FeeUnknownTxs: [],
    currency: "USD",
    rates: null,
  }
}

describe("what a send can name", () => {
  it("lists each purchase still held, oldest first, with what it cost", () => {
    const held = heldIn(walletOf([buy(20, 1n, 3000n), buy(10, 2n, 2000n), sell(30, 1n, 2500n)]), [], emptyBook(), "ETH")
    // Oldest first took 1 of the 2 bought at block 10.
    assert.deepEqual(held.purchases.map(({ boughtAt, units, costMicros }) => [boughtAt, units, costMicros]), [
      [at(10), ETH, 1000n * USD],
      [at(20), ETH, 3000n * USD],
    ])
    assert.equal(held.unnamed, 0n)
  })

  it("follows units an earlier send named", () => {
    const wallet = walletOf([buy(10, 1n, 1000n), buy(20, 1n, 3000n), sell(30, 1n, 2000n)])
    const book = recordUnitChoices(emptyBook(), [{ wallet: A, txHash: hash(30), asset: "ETH", recordedAt: at(29), takes: [{ boughtAt: at(20), units: ETH.toString() }] }])
    assert.deepEqual(heldIn(wallet, [], book, "ETH").purchases.map(({ boughtAt }) => boughtAt), [at(10)])
  })

  it("leaves out what nothing can name, and only lets all of a moment bought at different costs go together", () => {
    const lot = (qty: bigint, cost: bigint | null, fields: Partial<Lot> = {}): Lot => ({ qty: qty.toString(), costMicros: cost === null ? null : cost.toString(), label: "paid", legId: "x", acquiredAt: at(10), acquiredBlock: 10, ...fields })
    const held = heldOf([lot(ETH, 1000n * USD), lot(ETH, 3000n * USD), lot(ETH, null, { acquiredAt: at(20), unplaced: true }), lot(ETH, null, { acquiredAt: undefined, acquiredBlock: undefined })])
    assert.equal(held.purchases.length, 1)
    assert.equal(held.purchases[0]?.allOnly, true)
    assert.equal(held.unnamed, 2n * ETH)
    assert.match(picksProblem(held, new Map([[at(10), ETH]]), ETH, format) ?? "", /all 2 ETH or none/)
    assert.equal(picksProblem(held, new Map([[at(10), 2n * ETH]]), 2n * ETH, format), null)
  })

  it("says when the picks don't add up to what's sent, or ask for more than is left", () => {
    const held = heldIn(walletOf([buy(10, 1n, 1000n), buy(20, 1n, 3000n)]), [], emptyBook(), "ETH")
    assert.equal(picksProblem(held, new Map(), ETH, format), null)
    assert.match(picksProblem(held, new Map([[at(10), ETH / 2n]]), ETH, format) ?? "", /add up to 0.5 ETH, and this sends 1 ETH/)
    assert.match(picksProblem(held, new Map([[at(10), 2n * ETH]]), 2n * ETH, format) ?? "", /more than is left/)
    assert.match(picksProblem(held, new Map([[at(11), ETH]]), ETH, format) ?? "", /isn't held/)
    assert.equal(picksProblem(held, new Map([[at(10), ETH / 2n], [at(20), ETH / 2n]]), ETH, format), null)
  })

  it("makes a record the book keeps and a US report uses, since it was made before the send", () => {
    const wallet = walletOf([buy(10, 1n, 1000n), buy(20, 1n, 3000n), sell(30, 1n, 2000n)])
    const choice = choiceOf(A.toUpperCase().replace("0X", "0x"), hash(30).toUpperCase().replace("0X", "0x"), "ETH", at(29), new Map([[at(20), ETH], [at(10), 0n]]))
    assert.ok(choice)
    assert.deepEqual(parseUnitChoice(choice), choice)
    assert.deepEqual(choice.takes, [{ boughtAt: at(20), units: ETH.toString() }])
    const [row] = taxRows([wallet], { country: "US", method: "fifo", scope: "per-wallet" }, { book: recordUnitChoices(emptyBook(), [choice]) }).filter((r) => r.type === "Sold")
    assert.equal(row?.chosenUnits, "used")
    assert.equal(row?.gainMicros, (-1000n * USD).toString())
    assert.equal(choiceOf(A, hash(30), "ETH", at(29), new Map([[at(10), 0n]])), null)
  })
})
