// An Amp that answers from fixtures, for tests of what the SDK reads.

import { TOKENS } from "@pricetag/sdk/core"
import { pricetagClient, type Query, type ReadL1Fees } from "@pricetag/sdk/internal"

export type Tables = {
  legs?: unknown[]
  unlisted_legs?: unknown[]
  priced_legs?: unknown[]
  reference_prices?: unknown[]
  /** What the chain says each token's balance is, by symbol, at each block. Any other token holds none, and any other block's read fails. */
  balances?: Record<string, Record<string, string>>
}

/** How far each table has processed, or null if it hasn't started. One value applies to all of them. */
export type Through = number | null | Record<Exclude<keyof Tables, "balances">, number | null>

const word = (value: bigint | number) => BigInt(value).toString(16).padStart(64, "0")

/** What `aggregate3` returns for one balance call per token. */
function encodeBalances(amounts: Record<string, string>): string {
  const item = (token: (typeof TOKENS)[number]) => word(1) + word(0x40) + word(32) + word(BigInt(amounts[token.symbol] ?? "0"))
  const items = TOKENS.map(item)
  const offsets = items.map((_, i) => word(TOKENS.length * 32 + (i * items[0]!.length) / 2))
  return word(32) + word(TOKENS.length) + offsets.join("") + items.join("")
}

/** Answers by table, and keeps every query so a test can see what was asked. */
export function fakeAmp(tables: Tables, through: Through = 200, options: { startBlock?: number | undefined; readL1Fees?: ReadL1Fees } = {}) {
  const queries: string[] = []
  const query: Query = async <T>(sql: string) => {
    queries.push(sql)
    const balanceRead = /eth_call\(.*, (\d+)\) AS r$/.exec(sql)
    if (balanceRead) {
      const amounts = tables.balances?.[balanceRead[1]!]
      return (amounts ? [{ r: { data: encodeBalances(amounts) } }] : []) as T[]
    }
    const table = /\.(legs|unlisted_legs|priced_legs|reference_prices) WHERE/.exec(sql)?.[1] as Exclude<keyof Tables, "balances">
    if (/ORDER BY block_num DESC LIMIT 1/.test(sql) && sql.includes("SELECT block_num FROM")) {
      const top = through !== null && typeof through === "object" ? through[table] : through
      return (top === null ? [] : [{ block_num: String(top) }]) as T[]
    }
    if (sql.includes(".blocks")) return [{ block_num: "200", timestamp: 1_800_000_000_000 }] as T[]
    return (tables[table] ?? []) as T[]
  }
  return { query, queries, client: pricetagClient(query, { dataset: "benface/pricetag@0.0.1", ...options }) }
}
