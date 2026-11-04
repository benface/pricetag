// Prints a wallet's positions and PnL. Run it with: pnpm example <address>
import { buildPortfolio, createPricetag } from "@pricetag/sdk"

const env = process.env
const pricetag = createPricetag({ url: env.AMP_QUERY_URL!, token: env.AMP_QUERY_TOKEN, dataset: env.PRICETAG_DATASET! })
const usd = (micros: string | null) => (micros === null ? "unknown" : (Number(micros) / 1e6).toLocaleString("en-US", { style: "currency", currency: "USD" }))

const { legs, blocks } = await pricetag.getLegs(process.argv[2]!, { from: Number(env.PRICETAG_START_BLOCK) })
const { positions, totals } = buildPortfolio(legs, "average", await pricetag.getLatestPrices())
console.log(`Blocks ${blocks.fromBlock} to ${blocks.toBlock}: ${legs.length} legs`)

for (const { asset, decimals, values: v, price } of positions) {
  const qty = Number(v.qty) / 10 ** decimals
  console.log(`${asset}: ${qty} | cost ${usd(v.costUsdMicros)} | value ${usd(v.valueUsdMicros)} (${price?.source ?? "no price"}) | realized ${usd(v.realizedUsdMicros)} | unrealized ${usd(v.unrealizedUsdMicros)}`)
}
console.log(`PnL: ${usd(totals.pnlUsdMicros)}, gas ${usd(totals.gasUsdMicros)}, leaving out: ${[...new Set(totals.excluded.map((e) => e.asset))].join(", ") || "nothing"}`)

const last = legs.at(-1)
if (last) console.log(`Latest: ${last.asset} in ${last.txHash}, price ${usd(last.priceUsdMicros)} (${last.priceSource ?? "unknown"}), cost ${last.costLabel}`)
