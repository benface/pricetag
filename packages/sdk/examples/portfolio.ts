// Prints a wallet's positions and PnL. Run it with: pnpm example <address>
import { createPricetag, formatAmount, formatPrice, formatSignedMoney, formatMoney } from "@pricetag/sdk"

const env = process.env
const pricetag = createPricetag({ url: env.AMP_QUERY_URL!, token: env.AMP_QUERY_TOKEN, dataset: env.PRICETAG_DATASET!, startBlock: Number(env.PRICETAG_START_BLOCK), rpcUrl: env.BASE_RPC_URL || "https://mainnet.base.org", rpcRateLimit: Number(env.BASE_RPC_RATE_LIMIT) || undefined })

const { started, blocks, positions, totals, pnlStatus, missing, legs } = await pricetag.getPortfolio(process.argv[2]!)
if (!started) {
  console.log(`No answer yet: the dataset hasn't processed block ${blocks.fromBlock}.`)
  process.exit(1)
}

console.log(`Blocks ${blocks.fromBlock} to ${blocks.toBlock}`)
for (const { asset, decimals, values: v, price, reconciliation } of positions) {
  console.log(`${asset}: ${formatAmount(v.qty, decimals)} | cost ${formatMoney(v.costMicros)} | value ${formatMoney(v.valueMicros)} (${price?.source ?? "no price"}) | realized ${formatSignedMoney(v.realizedMicros)} | unrealized ${formatSignedMoney(v.unrealizedMicros)} | ${reconciliation?.status}`)
}
console.log(`PnL: ${formatSignedMoney(totals.pnlMicros)} (${pnlStatus}), gas ${formatMoney(totals.gasMicros)}, leaving out: ${missing.join(", ") || "nothing"}`)

const last = legs.findLast((leg) => !leg.opening)
if (last) console.log(`Latest: ${last.asset} in ${last.txHash}, price ${formatPrice(last.priceMicros)} (${last.priceSource ?? "unknown"}), cost ${last.costLabel}`)
