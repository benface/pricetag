// An Amp that answers from fixtures, for tests of what the SDK reads.

import { TOKENS, TOKEN_FEEDS } from "@pricetag/sdk/core"
import { pricetagClient, type Query, type ReadL1Fees } from "@pricetag/sdk/internal"

export type Tables = {
  legs?: unknown[]
  unlisted_legs?: unknown[]
  priced_legs?: unknown[]
  reference_prices?: unknown[]
  /**
   * What the chain says each token's balance is, by symbol, at each block. Any other token holds none, and any other
   * block's read fails. Null fails the read of that one token.
   */
  balances?: Record<string, Record<string, string | null>>
  /** Plain ETH at the end of each block, for `settleUnwraps`. A block that isn't here has a failed read. */
  ethBalances?: Record<string, string>
  /** What each token's feed answers, by symbol, at every block. A feed that isn't here has a failed call. */
  feeds?: Record<string, { answer: bigint; updatedAt: number }>
}

/** How far each table has processed, or null if it hasn't started. One value applies to all of them. */
export type Through = number | null | Record<Exclude<keyof Tables, "balances" | "ethBalances" | "feeds">, number | null>

const word = (value: bigint | number) => BigInt(value).toString(16).padStart(64, "0")

/** What `aggregate3` returns for one balance call per token. */
function encodeBalances(amounts: Record<string, string | null>): string {
  const items = TOKENS.map(({ symbol }) => {
    const amount = amounts[symbol]
    return amount === null ? word(0) + word(0x40) + word(0) : word(1) + word(0x40) + word(32) + word(BigInt(amount ?? "0"))
  })
  let next = TOKENS.length * 32
  const offsets = items.map((item) => {
    const offset = word(next)
    next += item.length / 2
    return offset
  })
  return word(32) + word(TOKENS.length) + offsets.join("") + items.join("")
}

/** Answers by table, and keeps every query so a test can see what was asked. */
export function fakeAmp(tables: Tables, through: Through = 200, options: { startBlock?: number | undefined; readL1Fees?: ReadL1Fees } = {}) {
  const queries: string[] = []
  const query: Query = async <T>(sql: string) => {
    queries.push(sql)
    if (sql.includes("X'4d2301cc")) {
      const blocks = (/block_num IN \(([^)]*)\)/.exec(sql)?.[1] ?? /, (\d+)\) AS r$/.exec(sql)?.[1] ?? "").split(", ")
      const known = blocks.filter((block) => tables.ethBalances?.[block] !== undefined)
      return known.map((block) => ({ block_num: block, r: { data: word(BigInt(tables.ethBalances![block]!)) } })) as T[]
    }
    if (sql.includes("latestRoundData()")) {
      const block = /block_num IN \((\d+)\)/.exec(sql)?.[1]
      const answers = [...sql.matchAll(/evm_encode_hex\('([^']+)'\).*? AS (f\d+)/g)].map(([, address, column]) => {
        const round = tables.feeds?.[Object.keys(TOKEN_FEEDS).find((asset) => TOKEN_FEEDS[asset]?.address === address) as string]
        return [column, round ? { data: word(1) + word(round.answer) + word(0) + word(round.updatedAt) + word(1) } : null]
      })
      return [{ block_num: block, timestamp: 1_800_000_000_000, ...Object.fromEntries(answers) }] as T[]
    }
    const balanceRead = /eth_call\(.*, (\d+)\) AS r$/.exec(sql)
    if (balanceRead) {
      const amounts = tables.balances?.[balanceRead[1]!]
      return (amounts ? [{ r: { data: encodeBalances(amounts) } }] : []) as T[]
    }
    const table = /\.(legs|unlisted_legs|priced_legs|reference_prices) WHERE/.exec(sql)?.[1] as Exclude<keyof Tables, "balances" | "ethBalances" | "feeds">
    if (/ORDER BY block_num DESC LIMIT 1/.test(sql) && sql.includes("SELECT block_num FROM")) {
      const top = through !== null && typeof through === "object" ? through[table] : through
      return (top === null ? [] : [{ block_num: String(top) }]) as T[]
    }
    if (sql.includes(".blocks")) return [{ block_num: "200", timestamp: 1_800_000_000_000 }] as T[]
    // Like Amp, only what's in the range, which a re-read after a reorg depends on.
    const range = /block_num BETWEEN (\d+) AND (\d+)/.exec(sql)
    const rows = (tables[table] ?? []) as { block_num?: string | number }[]
    return (range ? rows.filter(({ block_num }) => Number(block_num) >= Number(range[1]) && Number(block_num) <= Number(range[2])) : rows) as T[]
  }
  return { query, queries, client: pricetagClient(query, { dataset: "benface/pricetag@0.0.1", ...options }) }
}
