import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { cautiousEthTablesSql, ptCautiousSource, ptGasSource, ptNetSource, ptPriceSource, tablesSql } from "../dataset/build.ts"
import { gasPaid, type RawTx } from "../server/raw.ts"
import { ETH_ADDRESS, PRICE_FEEDS, SEED_TX, TOKENS, USDC_ADDRESS, WETH_ADDRESS, blocksWithin, ptNet, ptPrice } from "@pricetag/sdk/core"
import { LATEST_ROUND_SELECTOR, localManifest, readFeedSeeds } from "../dataset/local.ts"
import { keccak } from "../server/verify.ts"

const manifest = JSON.parse(readFileSync(new URL("../dataset/pricetag.json", import.meta.url), "utf8")) as {
  dependencies: Record<string, string>
  tables: Record<string, { input: { sql: string } }>
  functions: Record<string, { source: { source: string } }>
}
const udf = <F>(name: string) => new Function(`${manifest.functions[name]!.source.source}; return ${name}`)() as F

type PtPrice = (a: string, b: string, c: string, d: string, e: string, f: string) => unknown

const AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631"
const CBBTC = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf"
const STRANGER = "0x0000000000000000000000000000000000000bad"

describe("the committed manifest", () => {
  it("is what build.ts generates, so the SQL and allowlist can't drift", () => {
    const start = Number(/block_num\(\) >= (\d+)/.exec(manifest.tables.legs!.input.sql)![1])
    const expected = tablesSql(start)
    assert.deepEqual(Object.fromEntries(Object.entries(manifest.tables).map(([k, v]) => [k, v.input.sql])), expected)
    assert.equal(manifest.functions.pt_price!.source.source, ptPriceSource())
    assert.equal(manifest.functions.pt_net!.source.source, ptNetSource())
    assert.equal(manifest.functions.pt_gas!.source.source, ptGasSource())
  })

  it("every table has exactly one top-level start filter, or its job walks from genesis", () => {
    for (const [name, table] of Object.entries(manifest.tables)) {
      assert.equal(table.input.sql.match(/block_num\(\) >= \d+/g)?.length, 1, name)
    }
  })

  it("a table with a GROUP BY has its start filter at the top level, because Amp can't infer a start through an aggregate", () => {
    const grouped = Object.entries(manifest.tables).filter(([, table]) => table.input.sql.includes("GROUP BY"))
    assert.ok(grouped.length >= 2)
    for (const [name, table] of grouped) {
      const before = table.input.sql.slice(0, table.input.sql.search(/block_num\(\) >= \d+/))
      assert.ok(before.includes("GROUP BY"), `${name}: the filter is under its GROUP BY`)
      assert.equal(before.split("(").length, before.split(")").length, `${name}: the filter is inside a subquery`)
    }
  })

  it("every table has at most one join", () => {
    for (const [name, table] of Object.entries(manifest.tables)) {
      assert.ok((table.input.sql.match(/\bJOIN\b/g)?.length ?? 0) <= 1, name)
    }
  })

  it("lists every allowlisted ERC-20 and depends only on the raw Base dataset", () => {
    for (const token of TOKENS) {
      if (token.address === ETH_ADDRESS) continue
      assert.ok(manifest.tables.base_legs!.input.sql.includes(token.address.slice(2)), token.symbol)
    }
    assert.deepEqual(manifest.dependencies, { base: "edgeandnode/base_mainnet@0.0.2" })
  })
})

describe("prices from logs", () => {
  const start = Number(/block_num\(\) >= (\d+)/.exec(manifest.tables.legs!.input.sql)![1])
  const updates = manifest.tables.price_updates!.input.sql
  const carried = manifest.tables.carried!.input.sql
  const references = manifest.tables.reference_prices!.input.sql
  const priced = manifest.tables.priced_legs!.input.sql

  it("makes no eth_calls", () => {
    for (const [name, table] of Object.entries(manifest.tables)) assert.doesNotMatch(table.input.sql, /eth_call/, name)
  })

  it("only reads the feeds' aggregators, because 201 contracts emitted this event in a day", () => {
    for (const feed of PRICE_FEEDS) for (const address of feed.aggregators) assert.ok(updates.includes(`X'${address.slice(2)}'`), feed.pair)
    assert.match(updates, /topic0 = evm_topic\('AnswerUpdated\(int256 indexed current, uint256 indexed roundId, uint256 updatedAt\)'\) AND address IN/)
  })

  it("reads updates from the longest window before the start, so every feed has a price at its first block", () => {
    assert.ok(updates.includes(`block_num() >= ${start - 45_000}`))
    assert.ok(carried.includes(`block_num() >= ${start}`))
    assert.ok(references.includes(`block_num() >= ${start}`))
  })

  it("keeps each update for its own feed's window, in time, because blocks get 10x faster and feeds update on a clock", () => {
    assert.match(updates, /THEN timestamp \+ INTERVAL '2600 seconds' ELSE timestamp \+ INTERVAL '90000 seconds' END AS valid_until/)
    assert.deepEqual(PRICE_FEEDS.map((feed) => feed.validSeconds), [2_600, 90_000])
    assert.doesNotMatch(updates, /valid_blocks/)
  })

  it("starts on the block number, because several blocks can share a second, and an update can't count before its block", () => {
    assert.match(carried, /ON b\.block_num >= u\.block_num AND b\.timestamp < u\.valid_until/)
  })

  it("counts the blocks a time window spans on both sides of the 200ms upgrade", () => {
    const upgrade = 53_556_127
    assert.equal(blocksWithin(90_000, 53_515_446), 45_000)
    assert.equal(blocksWithin(90_000, upgrade), 45_000)
    assert.equal(blocksWithin(90_000, upgrade + 450_000), 450_000)
    assert.equal(blocksWithin(10, upgrade + 450_000), 50)
    // 1,000 s at 5 blocks a second, then the other 89,000 s at one block every 2 s.
    assert.equal(blocksWithin(90_000, upgrade + 5_000), 5_000 + 44_500)
    assert.ok(tablesSql(upgrade + 450_000).price_updates!.includes(`block_num() >= ${upgrade}`))
  })

  it("doesn't let the join rescan all of Base's blocks", () => {
    assert.ok(carried.includes(`b._block_num >= ${start}`))
  })

  it("keeps the shapes that run: the join and the aggregate in separate tables, with no subquery on the blocks side", () => {
    assert.match(carried, /FROM base\.blocks b\s+JOIN self\.price_updates u ON/)
    assert.doesNotMatch(carried, /GROUP BY/)
    assert.doesNotMatch(references, /JOIN/)
    assert.match(references, /FROM self\.carried GROUP BY block_num\(\), at_block, timestamp/)
  })

  it("takes the newest update per feed, ordered by block and then log", () => {
    for (const feed of ["eth", "usdc"]) {
      for (const column of ["answer", "tx_hash"]) assert.ok(references.includes(`last_value(${column} ORDER BY update_block, log_index) FILTER (WHERE feed = '${feed}')`), `${feed} ${column}`)
    }
  })

  it("keeps priced_legs on its watermark join, with the transactions behind its prices", () => {
    assert.match(priced, /JOIN self\.reference_prices r ON p\._block_num = r\._block_num/)
    assert.match(priced, /r\.eth_tx, r\.usdc_tx/)
    assert.match(priced, /r\.eth_answer, r\.usdc_answer\) AS priced/)
  })

  it("gives no price for a feed with no update in its window, because an empty answer arrives as null", () => {
    const dataset = udf<(...args: (string | null)[]) => unknown>("pt_price")
    const none = { source: "unknown", token: "", usd_micros: "" }
    assert.deepEqual(dataset(USDC_ADDRESS, "5", AERO, "5", null, "100000000"), none)
    assert.deepEqual(dataset(ETH_ADDRESS, "5", AERO, "5", "240000000000", null), none)
    assert.deepEqual(dataset(USDC_ADDRESS, "5", AERO, "5", null, null), none)
  })
})

describe("a dataset with no blocks before its start", () => {
  const START = 53_600_000
  const [ETH, USDC] = PRICE_FEEDS
  const seeds = [
    { feed: ETH, answer: "242244728208", roundId: "101", updatedAt: 1_793_900_000 },
    { feed: USDC, answer: "99982711", roundId: "202", updatedAt: 1_793_800_000 },
  ]
  const local = localManifest(manifest, START, seeds)
  const updates = local.tables.price_updates!.input.sql as string

  it("reads nothing from before its start, in any table", () => {
    assert.deepEqual(Object.keys(local.tables), Object.keys(manifest.tables))
    for (const [name, table] of Object.entries(local.tables)) {
      assert.deepEqual([...new Set(table.input.sql!.match(/block_num\(\) >= \d+/g))], [`block_num() >= ${START}`], name)
    }
    assert.ok(local.tables.carried!.input.sql!.includes(`b._block_num >= ${START}`))
  })

  it("still has its start filter last and outside the UNION, or its job walks from genesis", () => {
    assert.match(updates, new RegExp(`\\) WHERE block_num\\(\\) >= ${START}$`))
    assert.equal(updates.match(/block_num\(\) >= \d+/g)?.length, 1)
  })

  it("starts every feed from its contract's price, at the first block, marked as no transaction", () => {
    assert.equal(updates.match(/UNION ALL/g)?.length, 2)
    assert.equal(updates.match(new RegExp(`FROM base\\.blocks WHERE block_num = ${START}`, "g"))?.length, 2)
    assert.equal(updates.match(new RegExp(`X'${SEED_TX.slice(2)}'`, "g"))?.length, 2)
    assert.ok(updates.includes("'eth' AS feed") && updates.includes("'242244728208' AS answer") && updates.includes("'101' AS round_id"))
    assert.ok(updates.includes("'usdc' AS feed") && updates.includes("'99982711' AS answer") && updates.includes("'202' AS round_id"))
  })

  it("lasts as long as the update it stands in for, so it can't make a price stale", () => {
    assert.ok(updates.includes(`to_timestamp_seconds(${1_793_900_000 + 2_600})`))
    assert.ok(updates.includes(`to_timestamp_seconds(${1_793_800_000 + 90_000})`))
  })

  it("keeps the same columns as the logs, in the same order, so the committed schemas hold", () => {
    const columns = manifest.tables.price_updates! as unknown as { schema: { arrow: { fields: { name: string }[] } } }
    const names = columns.schema.arrow.fields.map((field) => field.name).filter((name) => !name.startsWith("_"))
    assert.ok(updates.startsWith(`SELECT ${names.join(", ")} FROM (`))
    for (const part of updates.split("UNION ALL").slice(1)) {
      let at = -1
      for (const name of names.filter((n) => !["block_num", "timestamp"].includes(n))) {
        const next = part.indexOf(`AS ${name}`)
        assert.ok(next > at, name)
        at = next
      }
    }
  })

  it("leaves the committed manifest with no seed", () => {
    assert.doesNotMatch(manifest.tables.price_updates!.input.sql, /UNION ALL/)
    assert.doesNotMatch(manifest.tables.price_updates!.input.sql, new RegExp(SEED_TX.slice(2)))
  })

  const round = (id: bigint, answer: bigint, updatedAt: bigint) => `0x${[id, answer, updatedAt, updatedAt, id].map((word) => BigInt.asUintN(256, word).toString(16).padStart(64, "0")).join("")}`
  const answering = (result: unknown, calls: string[] = []) =>
    (async (_url: string, init: RequestInit) => {
      calls.push(init.body as string)
      return new Response(JSON.stringify({ result }))
    }) as typeof fetch

  it("reads each feed's latest round at the start block", async () => {
    const calls: string[] = []
    const read = await readFeedSeeds("https://rpc.example", START, answering(round(36893488147419103232n, 99982711n, 1_793_800_000n), calls), 0)
    assert.equal(LATEST_ROUND_SELECTOR, `0x${keccak(Buffer.from("latestRoundData()")).toString("hex").slice(0, 8)}`)
    assert.deepEqual(read.map(({ feed }) => feed.name), ["eth", "usdc"])
    assert.deepEqual(read[0], { feed: ETH, roundId: "36893488147419103232", answer: "99982711", updatedAt: 1_793_800_000 })
    const { params } = JSON.parse(calls[0] as string) as { params: [{ to: string; data: string }, string] }
    assert.deepEqual(params, [{ to: ETH!.proxy, data: LATEST_ROUND_SELECTOR }, `0x${START.toString(16)}`])
  })

  it("tries again, then fails, naming the feed but not the RPC, rather than starting with a price missing", async () => {
    let tries = 0
    const flaky = (async () => {
      tries += 1
      return tries === 1 ? new Response("nope", { status: 429 }) : new Response(JSON.stringify({ result: round(1n, 5n, 6n) }))
    }) as unknown as typeof fetch
    assert.equal((await readFeedSeeds("https://rpc.example", START, flaky, 0)).length, 2)
    for (const result of [undefined, "0x", round(1n, 0n, 6n), round(1n, -5n, 6n)]) {
      await assert.rejects(readFeedSeeds("https://rpc.example/secret-key", START, answering(result), 0), (error: Error) => /ETH\/USD/.test(error.message) && !error.message.includes("secret-key"))
    }
  })
})

describe("unlisted_legs", () => {
  const sql = manifest.tables.unlisted_legs!.input.sql

  it("keeps out every allowlisted token, and covers fungible and NFT transfers", () => {
    for (const token of TOKENS) {
      if (token.address !== ETH_ADDRESS) assert.ok(sql.includes(token.address.slice(2)), token.symbol)
    }
    assert.match(sql, /address NOT IN/)
    assert.match(sql, /topic3 IS NULL/)
    assert.match(sql, /topic3 IS NOT NULL/)
  })

  it("labels an NFT's ID as one, so nothing sums it as a quantity", () => {
    assert.match(sql, /t\.id AS amount, 'unlisted_nft' AS kind/)
    assert.doesNotMatch(sql, /t\.id AS amount, 'unlisted' AS kind/)
  })

  it("covers ERC-1155, with an empty amount that the app reads as a movement", () => {
    assert.match(sql, /TransferSingle\(/)
    assert.match(sql, /TransferBatch\(/)
    assert.equal(sql.match(/'' AS amount, 'unlisted' AS kind/g)?.length, 4)
  })

  it("isn't part of legs, so it can't make pairs of tokens with no decimals", () => {
    assert.doesNotMatch(manifest.tables.legs!.input.sql, /unlisted_legs/)
  })
})

describe("pairing", () => {
  const net = manifest.tables.net_legs!.input.sql

  it("pairs what each account netted per token, not its raw legs", () => {
    assert.match(net, /FROM self\.legs WHERE kind <> 'gas'/)
    assert.match(net, /GROUP BY block_num\(\), block_num, timestamp, tx_hash, account, token/)
    assert.match(manifest.tables.pairs!.input.sql, /FROM self\.net_legs a\s+JOIN self\.net_legs b/)
    assert.doesNotMatch(manifest.tables.pairs!.input.sql, /self\.legs/)
  })

  it("drops what nets to zero", () => {
    assert.match(net, /WHERE get_field\(net, 'side'\) <> ''/)
  })

  it("only prices an account's pair when nothing off the allowlist moved with it", () => {
    const counts = manifest.tables.pair_counts!.input.sql
    assert.match(counts, /FROM self\.pairs\s+UNION ALL\s+SELECT block_num, tx_hash, account FROM self\.unlisted_moves/)
    assert.match(manifest.tables.single_pairs!.input.sql, /c\.pair_count = 1/)
  })

  it("nets unlisted tokens per asset, with an NFT counting once per ID, and keeps what it can't read", () => {
    const moves = manifest.tables.unlisted_moves!.input.sql
    assert.match(moves, /FROM self\.unlisted_legs/)
    assert.match(moves, /GROUP BY block_num\(\), block_num, tx_hash, account, token, CASE WHEN kind = 'unlisted_nft' THEN amount ELSE '' END/)
    assert.match(moves, /CASE WHEN kind = 'unlisted_nft' THEN CASE WHEN side = 'credit' THEN '1' ELSE '-1' END/)
    assert.match(moves, /WHERE \(get_field\(net, 'side'\) <> '' OR unreadable\)/)
  })
})

describe("the UDFs match the app", () => {
  const dataset = udf<PtPrice>("pt_price")
  const cases: [string, string, string, string, string, string][] = [
    [USDC_ADDRESS, "891383219", WETH_ADDRESS, "368200000000000000", "242032000000", "99982711"],
    [USDC_ADDRESS, "1000000000", AERO, "800000000000000000000", "240000000000", "100000000"],
    [AERO, "800000000000000000000", USDC_ADDRESS, "1000000000", "240000000000", "100000000"],
    [ETH_ADDRESS, "500000000000000000", AERO, "900000000000000000000", "240000000000", "100000000"],
    [AERO, "900000000000000000000", WETH_ADDRESS, "500000000000000000", "240000000000", "100000000"],
    // Wrapping isn't a trade, two unreferenced tokens have no price, and missing inputs give no price.
    [ETH_ADDRESS, "5", WETH_ADDRESS, "5", "240000000000", "100000000"],
    [AERO, "5", CBBTC, "5", "240000000000", "100000000"],
    [STRANGER, "5", USDC_ADDRESS, "5", "240000000000", "100000000"],
    [USDC_ADDRESS, "0", AERO, "5", "240000000000", "100000000"],
    [USDC_ADDRESS, "5", AERO, "5", "", "100000000"],
  ]

  for (const c of cases) {
    it(`pt_price(${c[0].slice(0, 6)}, ${c[1]}, ${c[2].slice(0, 6)}, ${c[3]})`, () => {
      assert.deepEqual(dataset(...c), ptPrice(...c))
      // Amp passes binary columns through evm_decode_hex, with no 0x.
      assert.deepEqual(dataset(c[0].slice(2), c[1], c[2].slice(2), c[3], c[4], c[5]), ptPrice(...c))
    })
  }

  it("WORK-319's hand-checked swap still comes to $2,420.50", () => {
    assert.deepEqual(ptPrice(...cases[0]!), { token: "WETH", usd_micros: "2420502736", source: "swap" })
  })

  const ptNetDataset = udf<(amounts: string | null) => unknown>("pt_net")
  const MAX = (2n ** 256n - 1n).toString()
  const nets = ["5", "-5", "5,-3", "3,-5", "5,-5", "-1,-2,4", "4,-2", "4,-3", "1000,-995", `${MAX},${MAX}`, `-${MAX},-${MAX},1`, "", "-", "5,-", "5,", "5,abc", "1.5", "0"]

  for (const amounts of nets) {
    it(`pt_net(${JSON.stringify(amounts.slice(0, 24))})`, () => assert.deepEqual(ptNetDataset(amounts), ptNet(amounts)))
  }

  it("pt_net doesn't overflow on several 2^256 amounts", () => {
    assert.deepEqual(ptNet(`${MAX},${MAX}`), { amount: (2n * (2n ** 256n - 1n)).toString(), side: "credit" })
    assert.deepEqual(ptNet("-8,1"), { amount: "7", side: "debit" })
    assert.deepEqual(ptNet("5,-5"), { amount: "", side: "" })
  })

  it("pt_net keeps an amount until under half of what moved is left", () => {
    assert.deepEqual(ptNet("-1200,200"), { amount: "1000", side: "debit" })
    assert.deepEqual(ptNet("-300,100"), { amount: "200", side: "debit" })
    assert.deepEqual(ptNet("-300,101"), { amount: "", side: "debit" })
    assert.deepEqual(ptNet("1000,-995"), { amount: "", side: "credit" })
  })

  it("pt_net never returns null or throws, because that would stop the whole dataset", () => {
    for (const bad of [null, "", "-", "5,-", ",", "abc", "1e5"]) assert.deepEqual(ptNetDataset(bad), { amount: "", side: "" })
  })

  it("pt_gas matches the real receipt, and matches the app", () => {
    const ptGas = udf<(...args: (string | null)[]) => string>("pt_gas")
    assert.equal(ptGas("1339297", "457343", null, "131250000", "100000000", "5009548"), "92613590896792")
    const tx = { block_num: 1, tx_index: 3, gas_used: "1339297", gas_price: null, max_fee_per_gas: "131250000", max_priority_fee_per_gas: "100000000" } as RawTx
    const context = { cumulativeGas: new Map([["1:2", "457343"]]), baseFeeByBlock: new Map([[1, "5009548"]]) }
    assert.equal(gasPaid(tx, context)!.toString(), "92613590896792")
  })

  it("pt_gas never returns null or throws, because that would stop the whole dataset", () => {
    const ptGas = udf<(...args: (string | null)[]) => string>("pt_gas")
    assert.equal(ptGas(null, "1", "2", null, null, null), "")
    assert.equal(ptGas("3", null, "2", null, null, null), "")
    assert.equal(ptGas("3", "1", null, null, null, null), "")
    assert.equal(ptGas("3", "1", "2", null, null, null), "4")
  })
})

describe("the token stays on the server", () => {
  it("nothing under src/ imports the server or Amp, or reads the environment", () => {
    const files = readdirSync(new URL("../src/", import.meta.url), { recursive: true, encoding: "utf8" }).filter((f) => /\.tsx?$/.test(f))
    assert.ok(files.length > 5)
    for (const file of files) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8")
      assert.doesNotMatch(source, /from "[^"]*server\//, file)
      assert.doesNotMatch(source, /@edgeandnode\/amp|@connectrpc|process\.env|import\.meta\.env/, file)
    }
  })
})

describe("the fork", () => {
  const fork = JSON.parse(readFileSync(new URL("../dataset/cautious-eth.json", import.meta.url), "utf8")) as {
    dependencies: Record<string, string>
    tables: Record<string, { input: { sql: string } }>
    functions: Record<string, { source: { source: string } }>
  }
  const start = Number(/block_num\(\) >= (\d+)/.exec(fork.tables.reference_prices!.input.sql)![1])

  it("is what build.ts generates", () => {
    assert.deepEqual(Object.fromEntries(Object.entries(fork.tables).map(([k, v]) => [k, v.input.sql])), cautiousEthTablesSql(start))
    assert.equal(fork.functions.pt_price!.source.source, ptPriceSource())
    assert.equal(fork.functions.pt_cautious!.source.source, ptCautiousSource())
  })

  it("only has the tables a pricing rule decides, and depends only on what it forks", () => {
    assert.deepEqual(Object.keys(fork.tables).sort(), ["priced_legs", "reference_prices"])
    assert.deepEqual(Object.keys(fork.dependencies), ["pricetag"])
  })

  it("makes no eth_calls of its own", () => {
    for (const { input } of Object.values(fork.tables)) assert.doesNotMatch(input.sql, /eth_call/)
  })

  it("prices swaps with the same SQL as the dataset, reading the pairs it forks and its own reference prices", () => {
    assert.equal(fork.tables.priced_legs!.input.sql.replace("pricetag.single_pairs", "self.single_pairs"), manifest.tables.priced_legs!.input.sql.replace(/block_num\(\) >= \d+/, `block_num() >= ${start}`))
  })

  it("leaves USDC alone, and changes nothing else about a reference row", () => {
    assert.match(fork.tables.reference_prices!.input.sql, /SELECT block_num, timestamp, self\.pt_cautious\(eth_answer\) AS eth_answer, usdc_answer, eth_tx, usdc_tx\nFROM pricetag\.reference_prices/)
  })

  const cautious = new Function(`${ptCautiousSource()}; return pt_cautious`)() as (answer: unknown) => string

  it("pt_cautious takes 1% off, in BigInt", () => {
    assert.equal(cautious("240000000000"), "237600000000")
    assert.equal(cautious("115792089237316195423570985008687907853269984665640564039457584007913129639935"), ((2n ** 256n - 1n) * 99n / 100n).toString())
  })

  it("pt_cautious never returns null or throws, because that would stop the whole dataset", () => {
    for (const bad of [null, undefined, "", "-1", "1.5", "abc"]) assert.equal(cautious(bad), "")
  })
})
