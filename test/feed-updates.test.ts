import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, it } from "node:test"
import { ASSETS, PRICE_FEEDS, TOKEN_FEEDS, TOKEN_FEED_AGGREGATORS, type LatestPrice } from "@pricetag/sdk/core"
import type { Query, Source } from "@pricetag/sdk/internal"
import { feedUpdatesSql } from "../dataset/build.ts"
import { createApi } from "../server/app.ts"
import { warnOfNewTokenAggregators } from "../server/feeds.ts"
import { createProofs, currentProofOf, currentVerificationOf, type BlockRead, type CurrentPriceBehind, type Proofs } from "../server/proof.ts"
import { latestFeedUpdates, updateFeedRounds, type FeedUpdate } from "../server/source.ts"
import type { BlockRow, DepositDetails, LogRow, TxRow } from "../server/verify.ts"
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
const BLOCK = Number(data.block.block_num)
const ANSWER = BigInt(`0x${log.topics[1]}`).toString()
const logged = { block_num: BLOCK, tx_hash: `0x${tx.tx_hash}`, log_index: log.log_index, answer: ANSWER }
const reads = new Map([[BLOCK, read]])
const aero = { pair: "AERO/USD", proxy: TOKEN_FEEDS.AERO!.address, aggregators: [`0x${log.address}`] }

const row = (block: number, asset: string, answer: string, logIndex = 0) => ({ block_num: String(block), tx_hash: "ab", log_index: String(logIndex), asset, answer, updated_at: String(1_800_000_000 + block) })

describe("the feeds dataset", () => {
  const manifest = JSON.parse(readFileSync(new URL("../dataset/feeds.json", import.meta.url), "utf8")) as { dependencies: unknown; tables: Record<string, { input: { sql: string } }>; functions: object }
  const pricetag = JSON.parse(readFileSync(new URL("../dataset/cautious-eth.json", import.meta.url), "utf8")) as { tables: Record<string, { input: { sql: string } }> }
  const start = Number(/block_num\(\) >= (\d+)/.exec(pricetag.tables.reference_prices!.input.sql)![1])
  const sql = manifest.tables.feed_updates!.input.sql

  it("is what build.ts writes for the Pricetag dataset's start, with no RPC", () => {
    assert.deepEqual(Object.keys(manifest.tables), ["feed_updates"])
    assert.equal(sql, feedUpdatesSql(start))
    assert.doesNotMatch(sql, /eth_call/)
  })

  it("names every token feed's aggregator, and reaches back as far as an update there could still count", () => {
    assert.deepEqual(Object.keys(TOKEN_FEED_AGGREGATORS).sort(), Object.keys(TOKEN_FEEDS).sort())
    for (const [asset, aggregators] of Object.entries(TOKEN_FEED_AGGREGATORS)) for (const address of aggregators ?? []) assert.ok(sql.includes(`WHEN address = X'${address.slice(2)}' THEN '${asset}'`), asset)
    const from = Number(/block_num\(\) >= (\d+)/.exec(sql)![1])
    assert.ok(from <= start - 26 * 1800, "26 hours of 2 s blocks")
  })

  it("warns when a proxy reads from an aggregator it doesn't list", async () => {
    const warnings: string[] = []
    const send = (async (_url: string, init: RequestInit) => {
      const { to } = (JSON.parse(init.body as string) as { params: [{ to: string }] }).params[0]
      const known = TOKEN_FEEDS.AERO!.address === to ? TOKEN_FEED_AGGREGATORS.AERO![0] : `0x${"11".repeat(20)}`
      return new Response(JSON.stringify({ result: `0x${"0".repeat(24)}${(known as string).slice(2)}` }))
    }) as unknown as typeof fetch
    await warnOfNewTokenAggregators("http://rpc", send, (message) => warnings.push(message))
    assert.equal(warnings.length, Object.keys(TOKEN_FEEDS).length - 1)
    assert.ok(!warnings.some((warning) => warning.includes("AERO")))
  })
})

describe("feeds' answers from logs", () => {
  const exactRound = (block: number) => ({ answer: "999", updatedAt: 1, blockNum: block, timestamp: "2026-11-04T00:00:00.000Z" })
  function reader(rows: object[] | Error) {
    const exact: { assets: readonly string[]; block: number }[] = []
    const sql: string[] = []
    const query = (async (text: string) => {
      sql.push(text)
      if (text.includes(".blocks")) return [{ timestamp: Date.parse("2026-11-05T00:00:00.000Z") }]
      if (rows instanceof Error) throw rows
      return rows
    }) as unknown as Query
    const read = updateFeedRounds(query, { baseDataset: "base", feedsDataset: "a/feeds@1" }, async (assets, block) => {
      exact.push({ assets, block })
      return Object.fromEntries(assets.map((asset) => [asset, exactRound(block)]))
    })
    return { exact, read, sql }
  }

  it("takes each asset's latest at or before the block, at that block's time, with no contract call", async () => {
    const { exact, read, sql } = reader([row(90, "AERO", "60"), row(95, "DAI", "100"), row(100, "AERO", "61", 1), row(100, "AERO", "62", 2), row(120, "AERO", "63")])
    assert.deepEqual(await read(["AERO", "DAI"], 110), {
      AERO: { answer: "62", updatedAt: 1_800_000_100, blockNum: 110, timestamp: "2026-11-05T00:00:00.000Z" },
      DAI: { answer: "100", updatedAt: 1_800_000_095, blockNum: 110, timestamp: "2026-11-05T00:00:00.000Z" },
    })
    assert.deepEqual(exact, [])
    assert.match(sql[0] as string, /FROM "a\/feeds@1"\.feed_updates WHERE block_num >= \d+ ORDER BY block_num, log_index$/)
  })

  it("reads the contract from the table's newest row on, so a lagging table never gives an old answer", async () => {
    const { exact, read } = reader([row(90, "AERO", "60"), row(100, "DAI", "100")])
    assert.equal((await read(["AERO"], 100)).AERO?.answer, "999")
    assert.equal((await read(["AERO"], 500)).AERO?.answer, "999")
    assert.deepEqual(exact.map(({ block }) => block), [100, 500])
  })

  it("stops reading the table for blocks past its newest row, and still reads it for older ones", async () => {
    const { exact, read, sql } = reader([row(90, "AERO", "60"), row(100, "DAI", "100")])
    await read(["AERO"], 500)
    const reads = () => sql.filter((text) => text.includes("feed_updates")).length
    assert.equal(reads(), 1)
    await read(["AERO"], 530)
    await read(["AERO"], 560)
    assert.equal(reads(), 1, "the head costs no read of the table")
    assert.deepEqual(exact.map(({ block }) => block), [500, 530, 560])
    assert.equal((await read(["AERO"], 95)).AERO?.answer, "60")
    assert.equal(reads(), 2)
  })

  it("asks the contract only about an asset the table has nothing on", async () => {
    const { exact, read } = reader([row(90, "AERO", "60"), row(200, "DAI", "100")])
    const rounds = await read(["AERO", "VIRTUAL"], 150)
    assert.equal(rounds.AERO?.answer, "60")
    assert.equal(rounds.VIRTUAL?.answer, "999")
    assert.deepEqual(exact, [{ assets: ["VIRTUAL"], block: 150 }])
  })

  it("falls back to the contract when the table can't be read or hasn't started", async () => {
    for (const failure of [new Error("Amp is down"), new Error("no common canonical watermark")]) {
      const { exact, read } = reader(failure)
      const warn = console.warn
      console.warn = () => {}
      assert.equal((await read(["AERO"], 100)).AERO?.answer, "999")
      console.warn = warn
      assert.equal(exact.length, 1)
    }
  })

  it("has nothing to ask about a token with no feed", async () => {
    const { read, sql } = reader([])
    assert.deepEqual(await read(["ETH"], 50), {})
    assert.equal(sql.length, 0)
  })

  it("keeps the last update per asset", () => {
    const updates: FeedUpdate[] = [row(1, "AERO", "1"), row(2, "AERO", "2"), row(3, "AERO", "3")].map((r) => ({ ...r, block_num: Number(r.block_num), log_index: 0, updatedAt: 0 }))
    assert.equal(latestFeedUpdates(updates, 2).get("AERO")?.answer, "2")
  })
})

describe("a current price's proof", () => {
  const current = (changes: Partial<CurrentPriceBehind["updates"][number]> = {}): CurrentPriceBehind => ({ asset: "AERO", blockNum: BLOCK + 40, updates: [{ feed: aero, update: logged, agrees: "yes", byRule: false, ...changes }] })

  it("names the log, links to it, and says what checking it covers", () => {
    const proof = currentProofOf("AERO", BLOCK + 40, "USD", [], null, current())
    assert.equal(proof.blockNum, BLOCK)
    assert.match(proof.source[0] as string, new RegExp(`Chainlink's AERO/USD update of .*in log #2 of block .*It was the latest at block`))
    assert.match(proof.links[0]?.url as string, new RegExp(`/tx/0x${tx.tx_hash}#eventlog`))
    assert.equal(proof.unavailable, null)
    assert.ok(proof.scope.some((line) => line.startsWith("It covers this price")))
    assert.ok(proof.scope.some((line) => line.includes("It doesn't show that Chainlink's number is right")))
  })

  it("says plainly when there's no log behind it, and that nothing can be verified", () => {
    const proof = currentProofOf("AERO", BLOCK, "USD", [], null, null)
    assert.match(proof.source[0] as string, /read from its contract/)
    assert.ok(proof.unavailable)
    assert.ok(proof.scope.some((line) => line.startsWith("It doesn't cover this price")))
    assert.ok(currentProofOf("AERO", BLOCK, "USD", [], null, current({ update: null })).unavailable)
  })

  it("says what it doesn't cover about another currency", () => {
    assert.ok(currentProofOf("AERO", BLOCK, "CAD", [], null, current()).scope.some((line) => line.includes("USD to CAD")))
  })

  it("passes when the block matches its header and the log works out to the price", () => {
    const { status, checks, blockNum, blockHash } = currentVerificationOf(current(), reads)
    assert.equal(status, "passed")
    assert.equal(blockNum, BLOCK)
    assert.equal(blockHash, `0x${data.block.hash}`)
    assert.match(checks[0]?.detail as string, /works out to the price shown here/)
  })

  it("isn't confirmed while the dataset hasn't reached the update, and fails once it has and still differs", () => {
    assert.equal(currentVerificationOf(current({ agrees: "unreached" }), reads).status, "unchecked")
    assert.equal(currentVerificationOf(current({ agrees: "differs" }), reads).status, "failed")
  })

  it("fails a log that isn't from this feed's contract, or doesn't say what the dataset says", () => {
    assert.equal(currentVerificationOf(current({ feed: { ...aero, aggregators: [`0x${"11".repeat(20)}`] } }), reads).status, "failed")
    assert.equal(currentVerificationOf(current({ update: { ...logged, answer: "1" } }), reads).status, "failed")
  })

  it("isn't confirmed when Amp doesn't have the block", () => {
    assert.equal(currentVerificationOf(current(), new Map()).status, "unchecked")
  })

  it("checks both updates of a price in ETH, and fails if either does", () => {
    const eth = { feed: { ...PRICE_FEEDS[0], aggregators: [`0x${log.address}`] }, update: logged, agrees: "yes" as const, byRule: false }
    const both = (agrees: "yes" | "differs"): CurrentPriceBehind => ({ asset: "wstETH", blockNum: BLOCK, updates: [{ feed: { ...aero, pair: "wstETH/ETH", answersInEth: true }, update: logged, agrees, byRule: false }, eth] })
    const passed = currentVerificationOf(both("yes"), reads)
    assert.equal(passed.status, "passed")
    assert.deepEqual(passed.checks.map(({ title }) => title), ["Chainlink's wstETH/ETH update", "Chainlink's ETH/USD update"])
    assert.match(passed.checks[0]?.detail as string, /is part of the price/)
    assert.equal(currentVerificationOf(both("differs"), reads).status, "failed")
    assert.match(currentProofOf("wstETH", BLOCK, "USD", [], null, both("yes")).source[0] as string, new RegExp(`update of .* ETH, in log`))
  })

  it("under a rule, says the update is what the rule starts from", () => {
    assert.match(currentVerificationOf(current({ byRule: true, agrees: "differs" }), reads).checks[0]?.detail as string, /this rule starts from/)
  })
})

describe("finding what's behind a current price", () => {
  const TX = "ab".repeat(32)
  function proofsOver(feedsDataset: string | null, rows: object[]) {
    const queries: string[] = []
    const query = (async (sql: string) => {
      queries.push(sql)
      if (sql.includes(".feed_updates")) return rows
      if (sql.includes(".reference_prices")) return [{ block_num: "1000", eth_usd: "300000000000", usdc_usd: "100000000", eth_tx: TX, usdc_tx: null }]
      if (sql.includes(".price_updates")) return [{ block_num: "990", tx_hash: TX, log_index: "3", answer: "300000000000" }]
      return []
    }) as unknown as Query
    return { queries, proofs: createProofs(query, { baseDataset: "a/base@1", dataset: { name: "a/pricetag@1", reference: "a/pricetag@1", hash: null }, feedsDataset, readDeposits: async () => new Map(), readManifestHash: async () => "c".repeat(64), retryPauseMs: 0 }) }
  }
  const price = (micros: string, blockNum = 1000): LatestPrice => ({ micros, source: "oracle", blockNum })

  it("agrees when the latest update works out to the price", async () => {
    const { proofs } = proofsOver("a/feeds@1", [row(900, "AERO", "63000000"), row(1100, "DAI", "100000000")])
    const behind = await proofs.currentPriceBehind("AERO", price("630000"), price("3000000000"), false)
    assert.equal(behind?.updates[0]?.agrees, "yes")
    assert.equal(behind?.updates[0]?.update?.block_num, 900)
  })

  it("tells a table that hasn't got there from one that disagrees", async () => {
    const behindTable = proofsOver("a/feeds@1", [row(900, "AERO", "60000000")])
    assert.equal((await behindTable.proofs.currentPriceBehind("AERO", price("630000"), undefined, false))?.updates[0]?.agrees, "unreached")
    const pastIt = proofsOver("a/feeds@1", [row(900, "AERO", "60000000"), row(1100, "DAI", "100000000")])
    assert.equal((await pastIt.proofs.currentPriceBehind("AERO", price("630000"), undefined, false))?.updates[0]?.agrees, "differs")
  })

  it("adds ETH's update to a price in ETH", async () => {
    const { proofs } = proofsOver("a/feeds@1", [row(900, "wstETH", "1250000000000000000"), row(1100, "DAI", "100000000")])
    const behind = await proofs.currentPriceBehind("wstETH", price("3750000000"), price("3000000000"), false)
    assert.deepEqual(behind?.updates.map(({ feed, agrees }) => [feed.pair, agrees]), [["wstETH/ETH", "yes"], ["ETH/USD", "yes"]])
  })

  it("reads ETH and USDC from the dataset's own prices, with no feeds dataset", async () => {
    const { proofs, queries } = proofsOver(null, [])
    const behind = await proofs.currentPriceBehind("ETH", price("3000000000"), undefined, false)
    assert.equal(behind?.updates[0]?.agrees, "yes")
    assert.equal(behind?.updates[0]?.update?.log_index, 3)
    assert.ok(!queries.some((sql) => sql.includes("feed_updates")))
  })

  it("has nothing behind a token's price with no feeds dataset", async () => {
    const { proofs, queries } = proofsOver(null, [])
    assert.equal(await proofs.currentPriceBehind("AERO", price("630000"), undefined, false), null)
    assert.equal(queries.length, 0)
  })

  it("lists the feeds dataset in the recipe only for a price that came from it", async () => {
    const { proofs } = proofsOver("a/feeds@1", [])
    assert.deepEqual((await proofs.datasets(null, "AERO")).map(({ name }) => name), ["a/feeds@1", "a/pricetag@1", "a/base@1"])
    assert.deepEqual((await proofs.datasets(null, "ETH")).map(({ name }) => name), ["a/pricetag@1", "a/base@1"])
    assert.deepEqual((await proofs.datasets()).map(({ name }) => name), ["a/pricetag@1", "a/base@1"])
  })
})

describe("the proof and verify routes, for a current price", () => {
  const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  const NOW = "2026-11-05T00:00:00.000Z"
  const AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631"
  const source: Source = {
    mode: "dataset",
    startBlock: BLOCK,
    historyFrom: null,
    head: async () => ({ blockNum: BLOCK + 60, timestamp: NOW }),
    processedThrough: async (_after, head) => head,
    readWindow: async () => ({ rows: [{ block_num: BLOCK, timestamp: NOW, tx_hash: "0xfeed", tx_index: 1, log_index: 0, token: AERO, account: ME, side: "credit", amount: "1000000000000000000", kind: "erc20" }], priced: [], gasUnknown: [] }),
    readReferences: async (blocks) => blocks.map((blockNum) => ({ blockNum, ethUsd: ANSWER, usdcUsd: "100000000" })),
    readLatestReference: async () => ({ blockNum: BLOCK + 60, ethUsd: ANSWER, usdcUsd: "100000000" }),
    readBalances: async (_address, block) => ({ blockNum: block, amounts: { ...Object.fromEntries(ASSETS.map((asset) => [asset, "0"])), AERO: "1000000000000000000" } }),
    readEthBalances: async () => new Map(),
    readFeedRounds: async (assets, block) => Object.fromEntries(assets.map((asset) => [asset, { answer: "63000000", updatedAt: Date.parse(NOW) / 1000 - 60, blockNum: block, timestamp: NOW }])),
  }
  async function serve(currentPriceBehind: Proofs["currentPriceBehind"]) {
    const asked: string[] = []
    const blocksRead: number[] = []
    const proofs: Proofs = {
      datasets: async () => [],
      priceBehind: async () => null,
      currentPriceBehind: async (asset, ...rest) => {
        asked.push(asset)
        return currentPriceBehind(asset, ...rest)
      },
      readBlock: async (block) => {
        blocksRead.push(block)
        return read
      },
    }
    const api = createApi({}, { source, readRates: async () => ({ byBlock: {}, latest: null }), proofs })
    const server = createServer((req, res) => void api(req, res))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return {
      asked,
      blocksRead,
      close: () => server.close(),
      get: async <T>(path: string, asset: string) => {
        const response = await fetch(`${base}/api/portfolio/${ME}/${path}?asset=${asset}`)
        return { status: response.status, body: (await response.json()) as T }
      },
    }
  }
  const behind: CurrentPriceBehind = { asset: "AERO", blockNum: BLOCK + 60, updates: [{ feed: aero, update: logged, agrees: "yes", byRule: false }] }

  it("proves a held token's price from its update, and checks that block", async () => {
    const { get, asked, blocksRead, close } = await serve(async () => behind)
    const proof = await get<ProofResponse>("proof", "AERO")
    const verification = await get<VerificationResponse>("verify", "AERO")
    close()
    assert.equal(proof.status, 200)
    assert.match(proof.body.source[0] as string, /AERO\/USD update/)
    assert.equal(verification.status, 200)
    assert.equal(verification.body.status, "passed")
    assert.deepEqual(asked, ["AERO", "AERO"])
    assert.deepEqual(blocksRead, [BLOCK])
  })

  it("answers without a block to check when no log is behind it", async () => {
    const { get, blocksRead, close } = await serve(async () => null)
    const proof = await get<ProofResponse>("proof", "AERO")
    const verification = await get<{ error: string }>("verify", "AERO")
    close()
    assert.equal(proof.status, 200)
    assert.ok(proof.body.unavailable)
    assert.equal(verification.status, 404)
    assert.deepEqual(blocksRead, [])
  })

  it("has nothing to say about a token this wallet has no Chainlink price for", async () => {
    const { get, close, asked } = await serve(async () => behind)
    const { status } = await get<{ error: string }>("proof", "DEGEN")
    close()
    assert.equal(status, 404)
    assert.deepEqual(asked, [])
  })

  it("says Amp failed rather than guessing", async () => {
    const { get, close } = await serve(async () => {
      throw new Error("Amp is down")
    })
    const { status } = await get<{ error: string }>("verify", "AERO")
    close()
    assert.equal(status, 502)
  })
})
