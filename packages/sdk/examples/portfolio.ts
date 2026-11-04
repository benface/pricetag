// Prints a wallet's positions and PnL. Run it with: pnpm example <address>
import { createPricetag, formatAmount, formatPrice, formatSignedUsd, formatUsd } from "@pricetag/sdk"

const env = process.env
const pricetag = createPricetag({ url: env.AMP_QUERY_URL!, token: env.AMP_QUERY_TOKEN, dataset: env.PRICETAG_DATASET!, startBlock: Number(env.PRICETAG_START_BLOCK), rpcUrl: env.BASE_RPC_URL || "https://mainnet.base.org" })

const { started, blocks, positions, totals, pnlStatus, missing, legs } = await pricetag.getPortfolio(process.argv[2]!)
if (!started) {
  console.log(`No answer yet: the dataset hasn't processed block ${blocks.fromBlock}.`)
  process.exit(1)
}

console.log(`Blocks ${blocks.fromBlock} to ${blocks.toBlock}`)
for (const { asset, decimals, values: v, price, reconciliation } of positions) {
  console.log(`${asset}: ${formatAmount(v.qty, decimals)} | cost ${formatUsd(v.costUsdMicros)} | value ${formatUsd(v.valueUsdMicros)} (${price?.source ?? "no price"}) | realized ${formatSignedUsd(v.realizedUsdMicros)} | unrealized ${formatSignedUsd(v.unrealizedUsdMicros)} | ${reconciliation?.status}`)
}
console.log(`PnL: ${formatSignedUsd(totals.pnlUsdMicros)} (${pnlStatus}), gas ${formatUsd(totals.gasUsdMicros)}, leaving out: ${missing.join(", ") || "nothing"}`)

const last = legs.findLast((leg) => !leg.opening)
if (last) console.log(`Latest: ${last.asset} in ${last.txHash}, price ${formatPrice(last.priceUsdMicros)} (${last.priceSource ?? "unknown"}), cost ${last.costLabel}`)
