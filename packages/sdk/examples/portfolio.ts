// Prints a wallet's positions and PnL. Run it with: pnpm example <address> [currency]
import { createPricetag, formatAmount, formatPrice, formatSignedMoney, formatMoney, type CurrencyCode } from "@pricetag/sdk"

const env = process.env
const pricetag = createPricetag({ url: env.AMP_QUERY_URL!, token: env.AMP_QUERY_TOKEN, dataset: env.PRICETAG_DATASET!, startBlock: Number(env.PRICETAG_START_BLOCK), ratesDataset: env.PRICETAG_RATES_DATASET, rpcUrl: env.BASE_RPC_URL || "https://mainnet.base.org", rpcRateLimit: Number(env.BASE_RPC_RATE_LIMIT) || undefined })
const currency = (process.argv[3] ?? "USD") as CurrencyCode

const { started, blocks, positions, totals, pnlStatus, missing, legs } = await pricetag.getPortfolio(process.argv[2]!, { currency })
if (!started) {
  console.log(`No answer yet: the dataset hasn't processed block ${blocks.fromBlock}.`)
  process.exit(1)
}

console.log(`Blocks ${blocks.fromBlock} to ${blocks.toBlock}`)
for (const { asset, decimals, values: v, price, reconciliation } of positions) {
  console.log(`${asset}: ${formatAmount(v.qty, decimals)} | cost ${formatMoney(v.costMicros, currency)} | value ${formatMoney(v.valueMicros, currency)} (${price?.source ?? "no price"}) | realized ${formatSignedMoney(v.realizedMicros, currency)} | unrealized ${formatSignedMoney(v.unrealizedMicros, currency)} | ${reconciliation?.status}`)
}
console.log(`PnL: ${formatSignedMoney(totals.pnlMicros, currency)} (${pnlStatus}), gas ${formatMoney(totals.gasMicros, currency)}, leaving out: ${missing.join(", ") || "nothing"}`)

const last = legs.findLast((leg) => !leg.opening)
if (last) console.log(`Latest: ${last.asset} in ${last.txHash}, price ${formatPrice(last.priceMicros, currency)} (${last.priceSource ?? "unknown"}), cost ${last.costLabel}`)
