import { createQuery } from "../server/amp.ts"
import { ERC20_ADDRESSES } from "../src/core/tokens.ts"
const q = createQuery(process.env.AMP_QUERY_URL!, process.env.AMP_QUERY_TOKEN)
const head = await q<any>(`SELECT block_num FROM "edgeandnode/base_mainnet@0.0.2".blocks ORDER BY block_num DESC LIMIT 1`)
const h = Number(head[0].block_num); console.log("head", h)
const c: Record<string,string> = {
 "coinbase1":"71660c4005ba85c37ccec55d0c4493e66fe775d3","coinbase2":"503828976d22510aad0201ac7ec88293211d23da","coinbase3":"ddfabcdc4d8ffc6d5beaf154f18b778f892a0740","coinbase4":"3cd751e6b0078be393132286c442345e5dc49699","coinbase5":"b5d85cbf7cb3ee0d56b3bb207d5fc4b82f43f511","coinbase6":"eb2629a2734e272bcc07bda959863f316f4bd4cf","coinbase10":"a9d1e08c7793af67e9d92fe308d5697fb81d3e43",
 "binanceBase":"3304e22ddaa22bcdc5fca2269b418046ae7b566a","binance8":"f977814e90da44bfa03b6295a0616a897441acec",
 "l2bridge":"4200000000000000000000000000000000000010","across":"09aea4b2242abc8bb4bb78d537a67a245a7bec64","stargateUSDC":"27a16dc786820b16e5c9028b75b99f6f604b5d26","stargateETH":"dc181bd607330aeebef6ea62e03e5e1fb4b6f7c7","relay":"f70da97812cb96acdf810712aa562db8dfa3dbef",
}
const topics = Object.values(c).map(a=>`X'${a.padStart(64,"0")}'`).join(",")
const allow = ERC20_ADDRESSES.map(a=>`X'${a.slice(2)}'`).join(",")
const rows = await q<any>(`SELECT topic1, COUNT(*) AS n, COUNT(DISTINCT topic2) AS recipients FROM "edgeandnode/base_mainnet@0.0.2".logs WHERE block_num BETWEEN ${h-1800} AND ${h} AND topic0 = X'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' AND address IN (${allow}) AND topic1 IN (${topics}) GROUP BY topic1`, 120000)
const byAddr = new Map(rows.map(r=>[String(r.topic1).slice(-40),r]))
for (const [k,a] of Object.entries(c)) { const r:any=byAddr.get(a); console.log(k,a, r?`${r.n} transfers to ${r.recipients}`:"none") }
const eth = await q<any>(`SELECT "from" AS f, COUNT(*) AS n, COUNT(DISTINCT "to") AS recipients FROM "edgeandnode/base_mainnet@0.0.2".transactions WHERE block_num BETWEEN ${h-1800} AND ${h} AND "from" IN (${Object.values(c).map(a=>`X'${a}'`).join(",")}) AND value <> '0' GROUP BY "from"`, 120000)
for (const r of eth) console.log("eth", String(r.f), r.n, r.recipients)
process.exit(0)
