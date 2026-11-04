import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, it } from "node:test"
import { ASSETS, PRICE_FEEDS, type LegRow, type PricedLeg, type PriceFeed } from "@pricetag/sdk/core"
import { datasetReader, type PriceUpdate, type Query, type Source } from "@pricetag/sdk/internal"
import { createApi } from "../server/app.ts"
import { AGGREGATOR_SELECTOR, warnOfNewAggregators } from "../server/feeds.ts"
import { createProofs, feedBehind, proofOf, verificationOf, type BlockRead, type PriceBehind } from "../server/proof.ts"
import { ANSWER_UPDATED_TOPIC } from "../server/raw.ts"
import { keccak, type BlockRow, type DepositDetails, type LogRow, type TxRow } from "../server/verify.ts"
import type { ProofResponse, VerificationResponse } from "../src/core/api.ts"

/** A real block from Amp's Base dataset, small enough to keep, with an `AnswerUpdated` log at index 2. */
const FIXTURE = JSON.parse(readFileSync(new URL("./support/base-update-block.json", import.meta.url), "utf8")) as {
  block: { block: BlockRow; txs: TxRow[]; logs: LogRow[] }
  deposits: Record<string, DepositDetails>
}
const data = FIXTURE.block
const read: BlockRead = { data, deposits: new Map(Object.entries(FIXTURE.deposits)) }
const log = data.logs.find((candidate) => candidate.log_index === 2) as LogRow
const tx = data.txs.find((candidate) => candidate.tx_index === log.tx_index) as TxRow
const blockNum = Number(data.block.block_num)
const ANSWER = BigInt(`0x${log.topics[1]}`).toString()
const MICROS = (BigInt(ANSWER) / 100n).toString()

const [ETH_FEED, USDC_FEED] = PRICE_FEEDS
/** This block's contract isn't one of today's aggregators, so the test's feed lists it. */
const feed: PriceFeed = { ...ETH_FEED, aggregators: [`0x${log.address}`] }
const update: PriceUpdate = { block_num: blockNum, tx_hash: `0x${tx.tx_hash}`, log_index: log.log_index, answer: ANSWER }
const behind: PriceBehind = { feed, update }

const leg = (changes: Partial<PricedLeg> = {}): PricedLeg => ({
  id: "0xabc:ETH",
  asset: "ETH",
  delta: "-1000000000000000000",
  decimals: 18,
  kind: "transfer",
  priceMicros: MICROS,
  priceSource: "oracle",
  priceNote: null,
  costMicros: null,
  proceedsMicros: null,
  costLabel: "unknown",
  blockNum: blockNum + 40,
  timestamp: "2024-01-30T00:00:00.000Z",
  txHash: "0xabc",
  txIndex: 0,
  parts: [],
  ...changes,
})

const checkOf = (verification: VerificationResponse) => verification.checks.find((check) => check.title === "Chainlink's update")

describe("the topic and selector", () => {
  it("are the Keccak of what they're named after", () => {
    assert.equal(ANSWER_UPDATED_TOPIC, keccak(Buffer.from("AnswerUpdated(int256,uint256,uint256)")).toString("hex"))
    assert.equal(AGGREGATOR_SELECTOR, `0x${keccak(Buffer.from("aggregator()")).toString("hex").slice(0, 8)}`)
  })
})

describe("the feed behind a price", () => {
  it("is a leg's own, or for a swap price, the one that values what was paid", () => {
    assert.equal(feedBehind(leg(), []), ETH_FEED)
    const usdc = leg({ id: "x:USDC", asset: "USDC", delta: "-1000000000", decimals: 6, kind: "swap" })
    const aero = leg({ id: "x:AERO", asset: "AERO", delta: "2000000000000000000000", kind: "swap", priceSource: "swap" })
    assert.equal(feedBehind(usdc, [usdc, aero]), USDC_FEED)
    assert.equal(feedBehind(aero, [usdc, aero]), USDC_FEED)
    assert.equal(feedBehind(leg({ priceSource: null, priceMicros: null }), []), null)
  })
})

describe("what the proof says about an update", () => {
  it("names the update and links its transaction, instead of the contract", () => {
    const proof = proofOf(leg(), [], "USD", [], null, behind)
    assert.match(proof.source[0] as string, new RegExp(`update of \\$[\\d,.]+, in log #2 of block ${blockNum.toLocaleString("en-US")}`))
    assert.match(proof.source[0] as string, /It was the latest at block/)
    assert.ok(proof.links.some((link) => link.url === `https://basescan.org/tx/0x${tx.tx_hash}#eventlog`))
    assert.ok(!proof.links.some((link) => link.url.includes("/address/")))
  })

  it("says the price is covered, and what still isn't", () => {
    const words = proofOf(leg(), [], "USD", [], null, behind).scope.join(" ")
    assert.match(words, /It covers this price/)
    assert.doesNotMatch(words, /doesn't cover this price/)
    assert.match(words, /doesn't show that Chainlink's number is right/)
    assert.match(words, /comes from the dataset's calculations/)
    assert.match(words, /doesn't show that the header is on Base's real chain/)
    assert.match(words, /or that the dataset's calculations ran correctly/)
  })

  it("names the update behind what valued an exchange", () => {
    const usdc = leg({ id: "x:USDC", asset: "USDC", delta: "-1000000000", decimals: 6, kind: "swap" })
    const aero = leg({ id: "x:AERO", asset: "AERO", delta: "2000000000000000000000", kind: "swap", priceSource: "swap" })
    const proof = proofOf(aero, [usdc, aero], "USD", [], null, { feed: USDC_FEED, update })
    assert.match(proof.source[1] as string, /The USDC is valued at Chainlink's USDC\/USD update of/)
    assert.ok(proof.scope.some((line) => /It covers the amounts exchanged and Chainlink's price/.test(line)))
  })

  it("says so when the update can't be found, and doesn't claim the price is covered", () => {
    const proof = proofOf(leg(), [], "USD", [], null, { feed: ETH_FEED, update: null })
    assert.match(proof.source[0] as string, /couldn't be found/)
    assert.ok(proof.scope.some((line) => /doesn't cover this price/.test(line)))
    assert.ok(proof.links.some((link) => link.url.includes(ETH_FEED.proxy)))
  })

  it("keeps the old words when prices come from calling the contract", () => {
    const proof = proofOf(leg(), [], "USD", [], null)
    assert.match(proof.source[0] as string, /read from its contract/)
    assert.ok(proof.scope.some((line) => /comes from calling a contract/.test(line)))
  })

  it("still says an exchange rate isn't covered", () => {
    assert.ok(proofOf(leg(), [], "CAD", [], null, behind).scope.some((line) => /USD to CAD rate/.test(line)))
  })

  it("uses plain language", () => {
    const proof = proofOf(leg(), [], "CAD", [], null, behind)
    const verification = verificationOf(leg(), [], data, read.deposits, { behind, read })
    const words = [...proof.source, ...proof.scope, ...proof.links.map((link) => link.title), verification.summary, ...verification.checks.flatMap((check) => [check.title, check.detail])].join(" ")
    assert.doesNotMatch(words, /\b(oracle|legs?|FIFO|Merkle|RLP|trie|aggregator)\b/i)
  })
})

describe("checking an update", () => {
  const verify = (changes: Partial<PricedLeg> = {}, checked: Partial<{ behind: PriceBehind; read: BlockRead | null }> = {}) => verificationOf(leg(changes), [], data, read.deposits, { behind, read, ...checked })

  it("passes when the block checks out and its log works out to the price", () => {
    const check = checkOf(verify())
    assert.equal(check?.status, "passed")
    assert.match(check?.detail ?? "", /log #2/)
    assert.match(check?.detail ?? "", /The dataset says it was the latest/)
  })

  it("says both were checked when everything passes", () => {
    const verification = verificationOf(leg({ txHash: `0x${tx.tx_hash}` }), [], data, read.deposits, { behind, read })
    assert.equal(verification.status, "passed")
    assert.match(verification.summary, /and so does Chainlink's update/)
  })

  it("adds nothing when prices come from calling the contract", () => {
    assert.equal(checkOf(verificationOf(leg(), [], data, read.deposits)), undefined)
  })

  it("fails when the price shown isn't what the log says", () => {
    const verification = verify({ priceMicros: (BigInt(MICROS) + 1n).toString() })
    assert.equal(checkOf(verification)?.status, "failed")
    assert.equal(verification.status, "failed")
  })

  it("fails when the dataset says something other than the log", () => {
    assert.equal(checkOf(verify({}, { behind: { feed, update: { ...update, answer: (BigInt(ANSWER) + 1n).toString() } } }))?.status, "failed")
    assert.equal(checkOf(verify({}, { behind: { feed, update: { ...update, answer: "" } } }))?.status, "failed")
  })

  it("fails a log from a contract that isn't this feed's", () => {
    assert.equal(checkOf(verify({}, { behind: { feed: ETH_FEED, update } }))?.status, "failed")
  })

  it("fails a log from another transaction, or one that isn't there", () => {
    assert.equal(checkOf(verify({}, { behind: { feed, update: { ...update, tx_hash: "0x12" } } }))?.status, "failed")
    assert.equal(checkOf(verify({}, { behind: { feed, update: { ...update, log_index: 9999 } } }))?.status, "failed")
  })

  it("fails a log that isn't an update, even from the right contract", () => {
    const other = data.logs.find((candidate) => candidate.topics[0] !== ANSWER_UPDATED_TOPIC) as LogRow
    const otherUpdate = { ...update, log_index: other.log_index, tx_hash: `0x${(data.txs.find((candidate) => candidate.tx_index === other.tx_index) as TxRow).tx_hash}` }
    assert.equal(checkOf(verify({}, { behind: { feed: { ...feed, aggregators: [`0x${other.address}`] }, update: otherUpdate } }))?.status, "failed")
  })

  it("fails when the update's block doesn't match its header, whatever the log says", () => {
    const tampered = { ...data, logs: data.logs.filter((candidate) => candidate.log_index !== 0) }
    const check = checkOf(verify({}, { read: { data: tampered, deposits: read.deposits } }))
    assert.equal(check?.status, "failed")
    assert.match(check?.detail ?? "", /which has this update/)
  })

  it("isn't confirmed when something's missing, which isn't a failure", () => {
    assert.equal(checkOf(verify({}, { behind: { feed, update: null }, read: null }))?.status, "unchecked")
    assert.equal(checkOf(verify({}, { read: null }))?.status, "unchecked")
    assert.equal(checkOf(verify({}, { read: { data, deposits: null } }))?.status, "unchecked")
    // With a row that's in the block, and so nothing failing, that's the whole result.
    const verification = verificationOf(leg({ txHash: `0x${tx.tx_hash}` }), [], data, read.deposits, { behind, read: null })
    assert.equal(verification.status, "unchecked")
    assert.match(verification.summary, /Chainlink's update couldn't be checked/)
  })

  it("works out an exchange's price from what was paid", () => {
    // 1 of the fixture's ETH price paid for 2,000 AERO.
    const paid = leg({ id: "x:ETH", delta: "-1000000000000000000", kind: "swap" })
    const expected = (BigInt(ANSWER) * 10n ** 18n * 10n ** 18n) / (2000n * 10n ** 18n * 10n ** 18n * 100n)
    const aero = leg({ id: "x:AERO", asset: "AERO", delta: "2000000000000000000000", kind: "swap", priceSource: "swap", priceMicros: expected.toString() })
    assert.equal(checkOf(verificationOf(aero, [paid, aero], data, read.deposits, { behind, read }))?.status, "passed")
    assert.equal(checkOf(verificationOf({ ...aero, priceMicros: "1" }, [paid, aero], data, read.deposits, { behind, read }))?.status, "failed")
  })
})

describe("reading an update", () => {
  const TX = "ab".repeat(32)
  const answers = (sql: string) => {
    if (sql.includes(".reference_prices")) return [{ block_num: "500000", eth_usd: "300000000000", usdc_usd: "100000000", eth_tx: TX, usdc_tx: null }]
    if (sql.includes(".price_updates")) return [{ block_num: "499990", tx_hash: TX, log_index: "7", answer: "300000000000" }]
    return []
  }
  const proofsOver = (dataset: string | null) => {
    const queries: string[] = []
    const query = (async (sql: string) => {
      queries.push(sql)
      return answers(sql)
    }) as Query
    return { queries, proofs: createProofs(query, { baseDataset: "a/base@1", dataset, readDeposits: async () => new Map(), readManifestHash: async () => null, retryPauseMs: 0 }) }
  }

  it("follows the block's transaction to its update, and stays in the feed's window", async () => {
    const { proofs, queries } = proofsOver("a/pricetag@1")
    assert.deepEqual(await proofs.priceBehind(ETH_FEED, 500000), { feed: ETH_FEED, update: { block_num: 499990, tx_hash: `0x${TX}`, log_index: 7, answer: "300000000000" } })
    const sql = queries.find((q) => q.includes(".price_updates")) as string
    assert.match(sql, /block_num BETWEEN 498701 AND 500000/)
    assert.match(sql, /feed = 'eth'/)
    assert.ok(sql.includes(`tx_hash = X'${TX}'`))
  })

  it("has no update for a feed with no price at that block", async () => {
    const { proofs, queries } = proofsOver("a/pricetag@1")
    assert.deepEqual(await proofs.priceBehind(USDC_FEED, 500000), { feed: USDC_FEED, update: null })
    assert.ok(!queries.some((q) => q.includes(".price_updates")))
  })

  it("has nothing to say when prices don't come from the dataset", async () => {
    const { proofs, queries } = proofsOver(null)
    assert.equal(await proofs.priceBehind(ETH_FEED, 500000), null)
    assert.equal(queries.length, 0)
  })

  it("reads the answers and their transactions from reference_prices", async () => {
    const queries: string[] = []
    const reader = datasetReader((async (sql: string) => {
      queries.push(sql)
      return answers(sql)
    }) as Query, { baseDataset: "a/base@1", dataset: "a/pricetag@1" })
    assert.deepEqual(await reader.readReferences([500000]), [{ blockNum: 500000, ethUsd: "300000000000", usdcUsd: "100000000", ethTx: `0x${TX}`, usdcTx: undefined }])
    assert.match(queries[0] as string, /eth_answer AS eth_usd, usdc_answer AS usdc_usd, eth_tx, usdc_tx/)
  })
})

describe("the proof and verify routes", () => {
  const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  const LEG_BLOCK = blockNum + 40
  const legRow: LegRow = { block_num: LEG_BLOCK, timestamp: "2024-01-30T00:00:00.000Z", tx_hash: "0xfeed", tx_index: 1, log_index: 0, token: "0x0000000000000000000000000000000000000000", account: ME, side: "credit", amount: "1000000000000000000", kind: "eth" }
  const source: Source = {
    mode: "dataset",
    startBlock: LEG_BLOCK,
    historyBlocks: null,
    head: async () => ({ blockNum: LEG_BLOCK, timestamp: "2024-01-30T00:00:00.000Z" }),
    processedThrough: async (_after, head) => head,
    readWindow: async () => ({ rows: [legRow], priced: [], gasUnknown: [] }),
    readReferences: async (blocks) => blocks.map((blockNum) => ({ blockNum, ethUsd: ANSWER, usdcUsd: "100000000" })),
    readLatestReference: async () => ({ blockNum: LEG_BLOCK, ethUsd: ANSWER, usdcUsd: "100000000" }),
    readBalances: async (_address, block) => ({ blockNum: block, amounts: { ...Object.fromEntries(ASSETS.map((asset) => [asset, "0"])), ETH: "1000000000000000000" } }),
    readEthBalances: async () => new Map(),
  }
  const serve = async (priceBehind: (f: PriceFeed, at: number) => Promise<PriceBehind | null>) => {
    const blocksRead: number[] = []
    const readBlock = async (n: number) => {
      blocksRead.push(n)
      return read
    }
    const api = createApi({}, { source, readRates: async () => ({ byBlock: {}, latest: null }), proofs: { datasets: async () => [], priceBehind, readBlock } })
    const server = createServer((req, res) => void api(req, res))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return {
      blocksRead,
      close: () => server.close(),
      get: async <T>(path: string) => {
        const response = await fetch(`${base}/api/portfolio/${ME}/${path}?leg=${encodeURIComponent("0xfeed:ETH")}`)
        return { status: response.status, body: (await response.json()) as T }
      },
    }
  }

  it("checks the update's block as well as the row's, and says so", async () => {
    const { get, blocksRead, close } = await serve(async () => behind)
    const { status, body } = await get<VerificationResponse>("verify")
    close()
    assert.equal(status, 200)
    assert.deepEqual(blocksRead, [LEG_BLOCK, blockNum])
    assert.equal(checkOf(body)?.status, "passed")
  })

  it("doesn't read a block twice when the update is in the row's", async () => {
    const { get, blocksRead, close } = await serve(async () => ({ feed, update: { ...update, block_num: LEG_BLOCK } }))
    await get<VerificationResponse>("verify")
    close()
    assert.deepEqual(blocksRead, [LEG_BLOCK])
  })

  it("names the update in the proof, and still answers when it can't be read", async () => {
    const good = await serve(async () => behind)
    const named = await good.get<ProofResponse>("proof")
    good.close()
    assert.match(named.body.source[0] as string, /in log #2/)
    const bad = await serve(async () => {
      throw new Error("Amp is down")
    })
    const failed = await bad.get<ProofResponse>("proof")
    assert.equal(failed.status, 200)
    assert.match(failed.body.source[0] as string, /couldn't be found/)
    assert.equal((await bad.get<{ error: string }>("verify")).status, 502)
    bad.close()
  })
})

describe("the startup check of the feeds", () => {
  const rpc = (aggregators: Record<string, string>) =>
    (async (_url: string, init: RequestInit) => {
      const { params } = JSON.parse(init.body as string) as { params: [{ to: string; data: string }, string] }
      assert.equal(params[0].data, AGGREGATOR_SELECTOR)
      return new Response(JSON.stringify({ result: `0x${(aggregators[params[0].to] as string).replace(/^0x/, "").toLowerCase().padStart(64, "0")}` }))
    }) as typeof fetch
  const current = Object.fromEntries(PRICE_FEEDS.map((f) => [f.proxy, f.aggregators[0] as string]))
  const warnings = async (send: typeof fetch) => {
    const messages: string[] = []
    await warnOfNewAggregators("https://rpc.example/secret-key", send, (message) => messages.push(message))
    return messages
  }

  it("says nothing when both aggregators are listed", async () => {
    assert.deepEqual(await warnings(rpc(current)), [])
  })

  it("warns about a feed that moved, whatever the address's case", async () => {
    const moved = "0x000000000000000000000000000000000000dEaD"
    const messages = await warnings(rpc({ ...current, [USDC_FEED.proxy]: moved }))
    assert.equal(messages.length, 1)
    assert.match(messages[0] as string, /USDC\/USD/)
    assert.ok((messages[0] as string).includes(moved.slice(2).toLowerCase()))
    assert.match(messages[0] as string, /45,000 blocks/)
  })

  it("warns, without throwing or naming the RPC, when it can't check", async () => {
    const failures: (typeof fetch)[] = [
      (async () => {
        throw new Error("connection refused")
      }) as typeof fetch,
      (async () => new Response("nope", { status: 500 })) as typeof fetch,
      (async () => new Response(JSON.stringify({ error: { message: "bad" } }))) as typeof fetch,
    ]
    for (const send of failures) {
      const messages = await warnings(send)
      assert.equal(messages.length, 2)
      assert.ok(messages.every((message) => /Couldn't check/.test(message) && !message.includes("secret-key")))
    }
  })
})
