// Prints a wallet's positions and PnL. Run it with: pnpm example <address>
import { buildPortfolio, createPricetag, pnlStatus } from "@pricetag/sdk"

const env = process.env
const pricetag = createPricetag({ url: env.AMP_QUERY_URL!, token: env.AMP_QUERY_TOKEN, dataset: env.PRICETAG_DATASET! })
const usd = (micros: string | null) => (micros === null ? "unknown" : (Number(micros) / 1e6).toLocaleString("en-US", { style: "currency", currency: "USD" }))

const { legs, blocks, gasUnknownTxs } = await pricetag.getLegs(process.argv[2]!, { from: Number(env.PRICETAG_START_BLOCK) })
if (blocks.toBlock < blocks.fromBlock) {
  console.log(`No answer yet: the dataset hasn't processed block ${blocks.fromBlock}.`)
  process.exit(1)
}

const { positions, totals } = buildPortfolio(legs, "average", await pricetag.getLatestPrices())
console.log(`Blocks ${blocks.fromBlock} to ${blocks.toBlock}: ${legs.length} legs`)

for (const { asset, decimals, values: v, price } of positions) {
  const qty = Number(v.qty) / 10 ** decimals
  console.log(`${asset}: ${qty} | cost ${usd(v.costMicros)} | value ${usd(v.valueMicros)} (${price?.source ?? "no price"}) | realized ${usd(v.realizedMicros)} | unrealized ${usd(v.unrealizedMicros)}`)
}
const missing = [...new Set(totals.excluded.map((e) => e.asset))]
if (totals.unpricedGas) missing.push("gas with no price")
if (gasUnknownTxs.length > 0) missing.push(`gas that couldn't be worked out, in ${gasUnknownTxs.length} tx, so ETH is overstated`)
console.log(`PnL: ${usd(totals.pnlMicros)} (${pnlStatus(totals, gasUnknownTxs)}), gas ${usd(totals.gasMicros)}, leaving out: ${missing.join(", ") || "nothing"}`)

const last = legs.at(-1)
if (last) console.log(`Latest: ${last.asset} in ${last.txHash}, price ${usd(last.priceMicros)} (${last.priceSource ?? "unknown"}), cost ${last.costLabel}`)
