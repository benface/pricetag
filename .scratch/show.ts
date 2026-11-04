import { DEMO_WALLET, DEMO_SAVINGS_WALLET, DEMO_SAVINGS_ADDRESS } from "../src/core/fixtures.ts"
import { foldBook } from "../src/core/portfolio.ts"
import { answerSender, emptyBook, costKey } from "../src/core/book.ts"
import { formatSignedUsd, formatUsd } from "../src/core/format.ts"
const show = (label: string, book: any, method: any = "average") => {
  const f = foldBook(DEMO_WALLET, [DEMO_SAVINGS_WALLET], method, book)
  console.log(`\n== ${label}: pnl ${f.totals.pnlUsdMicros && formatSignedUsd(f.totals.pnlUsdMicros)} status ${f.pnlStatus} unresolved ${formatUsd(f.totals.unresolvedUsdMicros)} est ${formatUsd(f.totals.estimatedUsdMicros)} noMarket ${f.totals.noMarket} meter ${JSON.stringify(f.meter)}`)
  for (const p of f.positions) console.log(p.asset.padEnd(8), "qty", p.values.qty.padEnd(24), "cost", String(p.values.costUsdMicros).padEnd(12), "val", String(p.values.valueUsdMicros).padEnd(12), "real", String(p.values.realizedUsdMicros).padEnd(10), "unr", String(p.values.unrealizedUsdMicros).padEnd(11), p.reconciliation?.status, p.noMarket?"NOMARKET":"", JSON.stringify(p.estimates).replace(/"|true|false/g,m=>m==="true"?"1":m==="false"?"0":""))
  for (const q of f.questions) console.log("  Q", q.id.slice(0,40), q.arrivals.map(a=>a.asset+":"+a.units).join(","), q.transfers, q.valueUsdMicros, q.evidence)
  console.log("  excluded", f.totals.excluded.map(e=>e.asset+":"+e.reason).join("; "))
}
let b = emptyBook(); show("empty", b)
b = answerSender(b, DEMO_WALLET.address, DEMO_SAVINGS_ADDRESS, {kind:"mine"}); show("savings mine", b); show("savings mine fifo", b, "fifo")
b = {...b, costs:{...b.costs,[costKey(DEMO_SAVINGS_ADDRESS,"opening:USDC")]:"1000000000"}}; show("savings opening", b)
b = answerSender(b, DEMO_WALLET.address, "0x000000000000000000000000000000000000be11", {kind:"someone-else"}); show("stranger", b)
