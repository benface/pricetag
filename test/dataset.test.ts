import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { ptGasSource, ptPriceSource, tablesSql } from "../dataset/build.ts"
import { gasPaid, type RawTx } from "../server/raw.ts"
import { ETH_ADDRESS, TOKENS, USDC_ADDRESS, WETH_ADDRESS, ptPrice } from "@pricetag/sdk/core"

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
    assert.equal(manifest.functions.pt_gas!.source.source, ptGasSource())
  })

  it("every table has exactly one top-level start filter, or its job walks from genesis", () => {
    for (const [name, table] of Object.entries(manifest.tables)) {
      assert.equal(table.input.sql.match(/block_num\(\) >= \d+/g)?.length, 1, name)
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
