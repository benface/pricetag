// Prints a wallet's PnL now, then again after each new block. Run it with: pnpm example:watch <address> [how many updates]
import { createPricetag, formatMoney, formatSignedMoney } from "@pricetag/sdk"

const env = process.env
const pricetag = createPricetag({ url: env.AMP_QUERY_URL!, token: env.AMP_QUERY_TOKEN, dataset: env.PRICETAG_DATASET!, startBlock: Number(env.PRICETAG_START_BLOCK), rpcUrl: env.BASE_RPC_URL || "https://mainnet.base.org", rpcRateLimit: Number(env.BASE_RPC_RATE_LIMIT) || undefined })

const [address, updates = "Infinity"] = process.argv.slice(2)
let left = Number(updates)

for await (const { blocks, legs, totals, pnlStatus, missing, via, reorgFrom } of pricetag.watchWallet(address!)) {
  // Each update is the whole wallet, so a reorg needs nothing undone. It's only printed to say it happened.
  if (reorgFrom !== null) console.log(`Read the blocks from ${reorgFrom} on again, since a reorg may have replaced them.`)
  console.log(`To block ${blocks.toBlock}${via ? `, by ${via}` : ""}: ${legs.length} legs, value ${formatMoney(totals.valueMicros)}, PnL ${formatSignedMoney(totals.pnlMicros)} (${pnlStatus}), leaving out: ${missing.length} ${missing.length === 1 ? "thing" : "things"}`)
  if (--left <= 0) break
}
