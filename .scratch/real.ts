import { createQuery, describeError } from "../server/amp.ts"
import { datasetSource } from "../server/source.ts"
import { marketPrice } from "../src/core/market.ts"
import { formatPrice } from "../src/core/format.ts"
const q = createQuery(process.env.AMP_QUERY_URL!, process.env.AMP_QUERY_TOKEN)
const s = datasetSource(q, { baseDataset: "edgeandnode/base_mainnet@0.0.2", dataset: process.env.PRICETAG_DATASET!, startBlock: Number(process.env.PRICETAG_START_BLOCK), network: "base_mainnet" })
const head = (await s.head(null))!.blockNum
console.log("head", head, "marketReady on 0.0.4:", await s.marketReady!())
for (const asset of ["AERO","cbBTC","VIRTUAL","DEGEN","DAI","USDT","cbETH","wstETH"]) {
  const t0 = Date.now()
  try {
    const trades = await s.readMarketTrades!(asset, head-900, head-60)
    const p = marketPrice(trades, asset, head-60)
    console.log(asset.padEnd(8), "trades", String(trades.length).padEnd(4), "price", p ? formatPrice(p.usdMicros) : "none", "age", p ? head-60-p.blockNum : "-", `${Date.now()-t0}ms`)
  } catch (e) { console.log(asset, "ERR", describeError(e).slice(0,160)) }
}
// A real recent receiver of USDC, for the sender lookup.
const rows = await q<any>(`SELECT account, block_num FROM "${process.env.PRICETAG_DATASET}".legs WHERE block_num BETWEEN ${head-200} AND ${head-100} AND kind='eth' AND side='credit' LIMIT 1`)
const account = `0x${rows[0].account}`
const w = await s.readWindow(account, head-200, head-100)
console.log("window rows", w.rows.length, w.rows.slice(0,3).map(r=>[r.kind,r.side,r.counterparty?.slice(0,10)]))
const b = [...new Set(w.rows.map(r=>r.block_num))].slice(0,3)
console.log("notes", await s.readNotes!(account, b))
process.exit(0)
