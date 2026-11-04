// An Amp that answers from fixtures, for tests of what the SDK reads.

import { pricetagClient, type Query } from "@pricetag/sdk"

export type Tables = { legs?: unknown[]; unlisted_legs?: unknown[]; priced_legs?: unknown[]; reference_prices?: unknown[] }

/** How far each table has processed, or null if it hasn't started. One value applies to all of them. */
export type Through = number | null | Record<keyof Tables, number | null>

/** Answers by table, and keeps every query so a test can see what was asked. */
export function fakeAmp(tables: Tables, through: Through = 200) {
  const queries: string[] = []
  const query: Query = async <T>(sql: string) => {
    queries.push(sql)
    const table = /\.(legs|unlisted_legs|priced_legs|reference_prices) WHERE/.exec(sql)?.[1] as keyof Tables
    if (/ORDER BY block_num DESC LIMIT 1/.test(sql) && sql.includes("SELECT block_num FROM")) {
      const top = through !== null && typeof through === "object" ? through[table] : through
      return (top === null ? [] : [{ block_num: String(top) }]) as T[]
    }
    if (sql.includes(".blocks")) return [{ block_num: "200", timestamp: 1_800_000_000_000 }] as T[]
    return (tables[table] ?? []) as T[]
  }
  return { query, queries, client: pricetagClient(query, { dataset: "benface/pricetag@0.0.1" }) }
}
