import { createQuery } from "../server/amp.ts"
import { ERC20_ADDRESSES } from "../src/core/tokens.ts"
const q = createQuery(process.env.AMP_QUERY_URL!, process.env.AMP_QUERY_TOKEN)
const head = await q<any>(`SELECT block_num FROM "edgeandnode/base_mainnet@0.0.2".blocks ORDER BY block_num DESC LIMIT 1`)
const h = Number(head[0].block_num)
const ds = `"edgeandnode/base_mainnet@0.0.2"`
const eth = await q<any>(`SELECT "from" AS f, COUNT(*) AS n, COUNT(DISTINCT "to") AS recipients FROM ${ds}.transactions WHERE block_num BETWEEN ${h-1800} AND ${h} AND value <> '0' AND type <> 126 GROUP BY "from" ORDER BY recipients DESC LIMIT 15`, 120000)
for (const r of eth) console.log("eth", String(r.f), r.n, r.recipients)
process.exit(0)
