import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, parseAbi, type Hex } from "viem"
import { APPROVAL_FOR_ALL_TOPIC, APPROVAL_TOPIC, PERMIT2, PERMIT2_APPROVAL_TOPIC, PERMIT2_PERMIT_TOPIC, USDC_ADDRESS, WETH_ADDRESS, candidatesFromLogs, isActive, knownSpenderCandidates, mergeCandidates, type ApprovalLog, type Candidate } from "@pricetag/sdk/core"
import { callResult, createApprovals, decodeChecks, demoApprovals, encodeChecks, expiryOf, isTrustedCheck, sortViews, viewOf } from "../server/approvals.ts"
import { tablesSql } from "../dataset/build.ts"
import { DEMO_SAVINGS_WALLET, DEMO_WALLET } from "../src/core/fixtures.ts"
import { assertMatchesFixture } from "./support/fixtures.ts"

const ME = "0x00000000000000000000000000000000000a11ce"
const OTHER = "0x0000000000000000000000000000000000000b0b"
const SPENDER = "0x000000000000000000000000000000000000beef"
const COLLECTION = "0x000000000000000000000000000000000000c011"
const word = (address: string) => address.slice(2).padStart(64, "0")
const MAX = 2n ** 256n - 1n

let logIndex = 0
function log(block: number, address: string, topic0: string, topic1: string, topic2: string | null, topic3: string | null = null): ApprovalLog {
  return { block_num: block, timestamp: new Date(Date.UTC(2026, 10, 5) + block * 2000).toISOString(), tx_hash: block.toString(16).padStart(64, "0"), log_index: logIndex++, address: address.slice(2), topic0, topic1: word(topic1), topic2: topic2 && word(topic2), topic3: topic3 && word(topic3) }
}

const MULTICALL = parseAbi(["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)"])

/** What a node would answer for `aggregate3`, from what each call is asking. */
function answer(calldata: string, state: (call: { target: string; selector: string; args: Hex }) => Hex | null): string {
  const { args } = decodeFunctionData({ abi: MULTICALL, data: `0x${calldata}` })
  const results = args[0].map(({ target, callData }) => {
    const data = state({ target: target.toLowerCase(), selector: callData.slice(2, 10), args: `0x${callData.slice(10)}` })
    return data === null ? { success: false, returnData: "0x" as Hex } : { success: true, returnData: data }
  })
  return encodeFunctionResult({ abi: MULTICALL, functionName: "aggregate3", result: results }).slice(2)
}

describe("approvals in a wallet's history", () => {
  it("keeps each one's newest event, and only this owner's", () => {
    const found = candidatesFromLogs(ME, [
      log(10, USDC_ADDRESS, APPROVAL_TOPIC, ME, SPENDER),
      log(20, USDC_ADDRESS, APPROVAL_TOPIC, ME, SPENDER),
      log(15, USDC_ADDRESS, APPROVAL_TOPIC, OTHER, SPENDER),
      // An NFT's own approval has the token ID as a fourth topic, and isn't one of these.
      log(16, COLLECTION, APPROVAL_TOPIC, ME, SPENDER, OTHER),
      log(17, COLLECTION, APPROVAL_FOR_ALL_TOPIC, ME, SPENDER),
      log(18, PERMIT2, PERMIT2_APPROVAL_TOPIC, ME, USDC_ADDRESS, SPENDER),
      log(19, PERMIT2, PERMIT2_PERMIT_TOPIC, ME, WETH_ADDRESS, SPENDER),
      // Only Permit2's own events are Permit2 allowances.
      log(19, SPENDER, PERMIT2_APPROVAL_TOPIC, ME, USDC_ADDRESS, OTHER),
    ])
    assert.deepEqual(
      found.map(({ kind, token, spender, grant }) => [kind, token, spender, grant?.blockNum]).sort((a, b) => Number(a[3]) - Number(b[3])),
      [
        ["collection", COLLECTION, SPENDER, 17],
        ["permit2", USDC_ADDRESS, SPENDER, 18],
        ["permit2", WETH_ADDRESS, SPENDER, 19],
        ["token", USDC_ADDRESS, SPENDER, 20],
      ],
    )
  })

  it("checks well-known apps too, and a found approval keeps its event", () => {
    const known = knownSpenderCandidates()
    assert.ok(known.some((c) => c.kind === "token" && c.token === USDC_ADDRESS && c.spender === PERMIT2))
    assert.ok(known.some((c) => c.kind === "permit2" && c.token === USDC_ADDRESS))
    const found = candidatesFromLogs(ME, [log(5, USDC_ADDRESS, APPROVAL_TOPIC, ME, PERMIT2)])
    const merged = mergeCandidates(found, known)
    assert.equal(merged.length, known.length)
    assert.equal(merged.find((c) => c.kind === "token" && c.token === USDC_ADDRESS && c.spender === PERMIT2)?.grant?.blockNum, 5)
  })
})

describe("what an approval still allows", () => {
  const candidates: Candidate[] = [
    { kind: "token", token: USDC_ADDRESS, spender: SPENDER, grant: null },
    { kind: "permit2", token: USDC_ADDRESS, spender: SPENDER, grant: null },
    { kind: "collection", token: COLLECTION, spender: SPENDER, grant: null },
    { kind: "token", token: WETH_ADDRESS, spender: SPENDER, grant: null },
  ]

  it("reads each kind from its own contract, and leaves out a call that failed or answered nonsense", () => {
    const calls: string[] = []
    const data = answer(encodeChecks(ME, candidates), ({ target, selector }) => {
      calls.push(`${target}:${selector}`)
      if (selector === "dd62ed3e") return target === USDC_ADDRESS ? encodeAbiParameters([{ type: "uint256" }], [MAX]) : "0x1234"
      if (selector === "927da105") return encodeAbiParameters([{ type: "uint160" }, { type: "uint48" }, { type: "uint48" }], [500n, 1_900_000_000, 3])
      if (selector === "e985e9c5") return encodeAbiParameters([{ type: "bool" }], [true])
      return null
    })
    assert.deepEqual(calls, [`${USDC_ADDRESS}:dd62ed3e`, `${PERMIT2}:927da105`, `${COLLECTION}:e985e9c5`, `${WETH_ADDRESS}:dd62ed3e`])
    const checked = decodeChecks(data, candidates)!
    assert.deepEqual(checked.map((c) => c && [c.amount, c.expiresAt]), [[MAX, null], [500n, 1_900_000_000], [1n, null], null])
    assert.equal(decodeChecks("abcd", candidates), null)
  })

  it("only counts what can still be spent", () => {
    assert.equal(isActive({ kind: "token", amount: 0n, expiresAt: null }, 0), false)
    assert.equal(isActive({ kind: "token", amount: 1n, expiresAt: null }, 0), true)
    assert.equal(isActive({ kind: "permit2", amount: 5n, expiresAt: 99 }, 100), false)
    assert.equal(isActive({ kind: "permit2", amount: 5n, expiresAt: 101 }, 100), true)
    assert.equal(isActive({ kind: "collection", amount: 0n, expiresAt: null }, 0), false)
  })

  it("names tracked tokens and well-known spenders, and nothing else", () => {
    const limited = viewOf({ kind: "token", token: USDC_ADDRESS, spender: PERMIT2, grant: null, amount: 12_500_000n, expiresAt: null }, false)
    assert.equal(limited.amountText, "12.5 USDC")
    assert.equal(limited.spenderName, "Uniswap Permit2")
    assert.equal(limited.unlimited, false)
    assert.equal(limited.found, "known-spender")
    const stranger = viewOf({ kind: "token", token: COLLECTION, spender: SPENDER, grant: null, amount: 2n ** 200n, expiresAt: null }, true)
    assert.deepEqual([stranger.symbol, stranger.spenderName, stranger.amountText, stranger.unlimited], [null, null, null, true])
    assert.deepEqual(sortViews([limited, stranger]).map((v) => v.id), [stranger.id, limited.id])
  })
})

describe("reading a wallet's approvals", () => {
  const head = { blockNum: 1_000, timestamp: new Date(1_800_000_000_000).toISOString() }
  const state = ({ target, selector }: { target: string; selector: string }) => {
    if (selector === "dd62ed3e") return encodeAbiParameters([{ type: "uint256" }], [target === USDC_ADDRESS ? MAX : 0n])
    if (selector === "927da105") return encodeAbiParameters([{ type: "uint160" }, { type: "uint48" }, { type: "uint48" }], [0n, 0, 0])
    return encodeAbiParameters([{ type: "bool" }], [false])
  }

  it("reads the dataset's table by owner, and checks what it found at the head", async () => {
    const queries: string[] = []
    const query = async <T>(sql: string): Promise<T[]> => {
      queries.push(sql)
      if (sql.includes("ORDER BY block_num DESC")) return [{ block_num: 990 }] as T[]
      if (sql.includes(".approvals")) return [{ ...log(500, USDC_ADDRESS, APPROVAL_TOPIC, ME, SPENDER), timestamp: 1_799_000_000_000 }] as T[]
      const calldata = /X'([0-9a-f]+)', 1000\) AS r/.exec(sql)![1]!
      return [{ r: { data: answer(calldata, state) } }] as T[]
    }
    const approvals = createApprovals(query, { baseDataset: "base", dataset: { reference: "pt", name: "benface/pricetag@0.2.0" }, network: "base_mainnet", historyFrom: () => 100 })
    const read = await approvals.read(ME, head)
    assert.equal(read.mode, "dataset")
    assert.deepEqual(read.history, { fromBlock: 100, throughBlock: 990, dataset: "benface/pricetag@0.2.0" })
    const first = read.approvals[0]!
    assert.deepEqual([first.spender, first.found, first.grantedBlock], [SPENDER, "history", 500])
    assert.ok(read.approvals.every((a) => a.token === USDC_ADDRESS))
    assert.ok(queries.some((sql) => sql.includes(`"pt".approvals WHERE block_num BETWEEN 100 AND 990 AND topic1 = X'${word(ME)}'`)))
    assert.ok(!queries.some((sql) => sql.includes(`"base".logs`)))

    // What the table hasn't reached yet is read next time, and what it has isn't read again.
    queries.length = 0
    await approvals.read(ME, head)
    assert.ok(!queries.some((sql) => sql.includes("topic1 =")))
  })

  it("reads the raw logs when the dataset has no such table, and only new blocks after that", async () => {
    const queries: string[] = []
    const query = async <T>(sql: string): Promise<T[]> => {
      queries.push(sql)
      if (sql.includes(".approvals")) throw new Error("table 'approvals' not found")
      if (sql.includes(".logs")) return [] as T[]
      const calldata = /X'([0-9a-f]+)', \d+\) AS r/.exec(sql)![1]!
      return [{ r: { data: answer(calldata, state) } }] as T[]
    }
    const approvals = createApprovals(query, { baseDataset: "base", dataset: { reference: "pt", name: "benface/pricetag@0.1.0" }, network: "base_mainnet", historyFrom: () => 100 })
    const read = await approvals.read(ME, head)
    assert.equal(read.mode, "raw")
    assert.equal(read.history.dataset, "base")
    assert.ok(queries.some((sql) => sql.includes(`"base".logs WHERE block_num BETWEEN 100 AND 1000 AND topic1 = X'${word(ME)}'`)))
    // A known spender's USDC approval shows even with nothing in the history.
    assert.ok(read.approvals.length > 0 && read.approvals.every((a) => a.found === "known-spender" && a.token === USDC_ADDRESS))
    queries.length = 0
    await approvals.read(ME, { ...head, blockNum: 1_010 })
    assert.deepEqual(queries.filter((sql) => sql.includes(".logs")).map((sql) => /BETWEEN (\d+) AND (\d+)/.exec(sql)!.slice(1)), [["1001", "1010"]])
    assert.ok(!queries.some((sql) => sql.includes(".approvals")), "it doesn't ask for the missing table again")
  })

  it("reads the blocks a reorg replaced again, so an approval granted on the new chain is found", async () => {
    let replaced = false
    const queries: string[] = []
    const query = async <T>(sql: string): Promise<T[]> => {
      queries.push(sql)
      if (sql.includes(".approvals")) throw new Error("table 'approvals' not found")
      if (sql.includes(".logs")) return (replaced && sql.includes("BETWEEN 995 AND 1000") ? [{ ...log(997, USDC_ADDRESS, APPROVAL_TOPIC, ME, SPENDER), timestamp: 1_799_000_000_000 }] : []) as T[]
      const calldata = /X'([0-9a-f]+)', \d+\) AS r/.exec(sql)![1]!
      return [{ r: { data: answer(calldata, state) } }] as T[]
    }
    const approvals = createApprovals(query, { baseDataset: "base", dataset: null, network: "base_mainnet", historyFrom: () => 100 })
    assert.ok(!(await approvals.read(ME, head)).approvals.some((a) => a.spender === SPENDER))
    replaced = true
    await approvals.rewind(995)
    queries.length = 0
    const read = await approvals.read(ME, head)
    assert.deepEqual(queries.filter((sql) => sql.includes(".logs")).map((sql) => /BETWEEN (\d+) AND (\d+)/.exec(sql)!.slice(1)), [["995", "1000"]])
    assert.ok(read.approvals.some((a) => a.spender === SPENDER && a.grantedBlock === 997))
  })
})

describe("checking contracts nobody vouches for", () => {
  const head = { blockNum: 1_000, timestamp: new Date(1_800_000_000_000).toISOString() }
  const UNTRACKED = "0x000000000000000000000000000000000000f00d"

  it("only lets tracked tokens and Permit2 share a batch", () => {
    assert.ok(isTrustedCheck({ kind: "token", token: USDC_ADDRESS }))
    assert.ok(isTrustedCheck({ kind: "permit2", token: UNTRACKED }))
    assert.ok(!isTrustedCheck({ kind: "token", token: UNTRACKED }))
    assert.ok(!isTrustedCheck({ kind: "collection", token: COLLECTION }))
  })

  it("reads each of them in a call of its own, so one can't change what another answers", async () => {
    const queries: string[] = []
    const query = async <T>(sql: string): Promise<T[]> => {
      queries.push(sql)
      if (sql.includes("ORDER BY block_num DESC")) return [{ block_num: 990 }] as T[]
      if (sql.includes(".approvals"))
        return [
          { ...log(500, UNTRACKED, APPROVAL_TOPIC, ME, SPENDER), timestamp: 1 },
          { ...log(501, COLLECTION, APPROVAL_FOR_ALL_TOPIC, ME, SPENDER), timestamp: 1 },
        ] as T[]
      if (sql.includes(" AS r")) {
        const calldata = /X'([0-9a-f]+)', 1000\) AS r/.exec(sql)![1]!
        return [{ r: { data: answer(calldata, () => encodeAbiParameters([{ type: "uint256" }], [0n])) } }] as T[]
      }
      // An untracked token's own call answers for itself, and the collection's call fails.
      const row: Record<string, unknown> = {}
      for (const [, target, column] of sql.matchAll(/evm_encode_hex\('(0x[0-9a-f]+)'\), X'[0-9a-f]+', 1000\) AS (c\d+)/g)) {
        row[column!] = target === UNTRACKED ? { data: encodeAbiParameters([{ type: "uint256" }], [100n]).slice(2) } : { data: null }
      }
      return [row] as T[]
    }
    const approvals = createApprovals(query, { baseDataset: "base", dataset: { reference: "pt", name: "pt" }, network: "base_mainnet", historyFrom: () => 100 })
    const read = await approvals.read(ME, head)
    const batch = queries.find((sql) => sql.includes(" AS r"))!
    const batched = decodeFunctionData({ abi: MULTICALL, data: `0x${/X'([0-9a-f]+)', 1000\) AS r/.exec(batch)![1]}` }).args[0].map((call) => call.target.toLowerCase())
    assert.ok(!batched.includes(UNTRACKED) && !batched.includes(COLLECTION), "nothing untrusted shares the batch")
    const isolated = queries.filter((sql) => sql.includes(" AS c0"))
    assert.equal(isolated.length, 1)
    assert.equal([...isolated[0]!.matchAll(/eth_call/g)].length, 2)
    assert.deepEqual(read.approvals.map((a) => [a.token, a.amount]), [[UNTRACKED, "100"]])
    // The collection's check failed, so what it allows isn't known, and the page has to say so.
    assert.equal(read.unreadable, 1)
  })
})

describe("a failed call", () => {
  const head = { blockNum: 1_000, timestamp: new Date(1_800_000_000_000).toISOString() }
  const UNTRACKED = "0x000000000000000000000000000000000000f00d"
  const zero = encodeAbiParameters([{ type: "uint256" }], [0n]).slice(2)

  it("is never an answer, even when its revert bytes are the size of one", () => {
    assert.equal(callResult({ data: zero, message: "execution reverted" }), null)
    assert.equal(callResult({ data: zero, message: null }), zero)
    assert.equal(callResult({ data: null, message: null }), null)
    assert.equal(callResult(null), null)
  })

  it("leaves what a reverted check covers unknown, never zero", async () => {
    const query = async <T>(sql: string): Promise<T[]> => {
      if (sql.includes("ORDER BY block_num DESC")) return [{ block_num: 990 }] as T[]
      if (sql.includes(".approvals")) return [{ ...log(500, UNTRACKED, APPROVAL_TOPIC, ME, SPENDER), timestamp: 1 }] as T[]
      if (sql.includes(" AS r")) {
        const calldata = /X'([0-9a-f]+)', 1000\) AS r/.exec(sql)![1]!
        return [{ r: { data: answer(calldata, () => encodeAbiParameters([{ type: "uint256" }], [0n])), message: null } }] as T[]
      }
      return [{ c0: { data: zero, message: "execution reverted" } }] as T[]
    }
    const approvals = createApprovals(query, { baseDataset: "base", dataset: { reference: "pt", name: "pt" }, network: "base_mainnet", historyFrom: () => 100 })
    const read = await approvals.read(ME, head)
    assert.deepEqual(read.approvals, [])
    assert.equal(read.unreadable, 1)
  })

  it("fails the whole read when the shared batch reverts", async () => {
    const query = async <T>(sql: string): Promise<T[]> => {
      if (sql.includes("ORDER BY block_num DESC")) return [{ block_num: 990 }] as T[]
      if (sql.includes(".approvals")) return [] as T[]
      const calldata = /X'([0-9a-f]+)', 1000\) AS r/.exec(sql)![1]!
      return [{ r: { data: answer(calldata, () => encodeAbiParameters([{ type: "uint256" }], [0n])), message: "execution reverted" } }] as T[]
    }
    const approvals = createApprovals(query, { baseDataset: "base", dataset: { reference: "pt", name: "pt" }, network: "base_mainnet", historyFrom: () => 100 })
    await assert.rejects(approvals.read(ME, head), /didn't answer/)
  })
})

describe("a Permit2 expiry", () => {
  it("that never comes is null rather than an error, however far off", () => {
    assert.equal(expiryOf(null), null)
    assert.equal(expiryOf(2 ** 48 - 1), null)
    assert.equal(expiryOf(1_900_000_000), new Date(1_900_000_000_000).toISOString())
    const view = viewOf({ kind: "permit2", token: USDC_ADDRESS, spender: SPENDER, grant: null, amount: 5n, expiresAt: 2 ** 48 - 1 }, false)
    assert.equal(view.expiresAt, null)
  })
})

describe("the dataset's approvals table", () => {
  it("is every approval event from the start block, as the logs have it", () => {
    const sql = tablesSql(123).approvals!
    assert.match(sql, /FROM base\.logs/)
    assert.match(sql, /block_num\(\) >= 123/)
    for (const topic of [APPROVAL_TOPIC, APPROVAL_FOR_ALL_TOPIC, PERMIT2_APPROVAL_TOPIC, PERMIT2_PERMIT_TOPIC]) assert.ok(sql.includes(topic))
  })
})

describe("the demo's approvals", () => {
  it("has one of each kind, and an old one in the savings wallet", () => {
    const demo = demoApprovals(DEMO_WALLET)
    assert.deepEqual(new Set(demo.approvals.map((a) => a.kind)), new Set(["token", "permit2", "collection"]))
    assert.equal(demo.mode, "demo")
    assert.equal(demoApprovals(DEMO_SAVINGS_WALLET).approvals.length, 1)
  })

  it("is what the Swift tests read", () => {
    assertMatchesFixture("demo-approvals.json", demoApprovals(DEMO_WALLET))
  })
})
