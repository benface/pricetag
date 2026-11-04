p='test/legs.test.ts'; s=open(p).read()
s=s.replace('''    assert.deepEqual(reasons("cbBTC"), ["no current price", "unknown cost"])''','''    assert.deepEqual(reasons("cbBTC"), ["unknown cost"])''')
s=s.replace('''    assert.equal(aero.values.unrealizedUsdMicros, null)
    assert.equal(aero.values.valueUsdMicros, null)''','''    // 500 at its $1.40 market price, less the $624.875 they cost. Its value rests on recent trades, so it's an estimate.
    assert.equal(aero.values.valueUsdMicros, "700000000")
    assert.equal(aero.values.unrealizedUsdMicros, "75125000")
    assert.deepEqual(aero.estimates, { cost: false, value: true, realized: false, unrealized: true })''')
open(p,'w').write(s)
p='test/portfolio.test.ts'; s=open(p).read()
s=s.replace('''import { foldPositions, sumTotals } from "../src/core/portfolio.ts"''','''import { emptyBook } from "../src/core/book.ts"
import { foldBook } from "../src/core/portfolio.ts"''')
s=s.replace('''      const positions = foldPositions(DEMO_WALLET.legs, method, DEMO_WALLET.prices, DEMO_WALLET)
      const portfolio = portfolioOf(DEMO_WALLET, method)
      assert.deepEqual(portfolio.totals, sumTotals(positions))
      assert.deepEqual(portfolio.positions.map((p) => p.values), positions.map((p) => p.values))''','''      const { positions, totals } = foldBook(DEMO_WALLET, [], method, emptyBook())
      const portfolio = portfolioOf(DEMO_WALLET, method)
      assert.deepEqual(portfolio.totals, totals)
      assert.deepEqual(portfolio.positions.map((p) => p.values), positions.map((p) => p.values))''')
s=s.replace('''    assert.equal(position("AERO")?.pnlUsdMicros, null, "AERO has a known cost, but no current price")''','''    assert.equal(position("DEGEN")?.pnlUsdMicros, null, "DEGEN has no market at all")''')
s=s.replace('''    assert.equal(explainPortfolio(wallet, "average", { kind: "total", metric: "value" })?.value, null)
    assert.equal(explainPortfolio(wallet, "average", { kind: "total", metric: "unrealized" })?.value, null)''','''    assert.equal(explainPortfolio(wallet, "average", { kind: "total", metric: "unrealized" })?.value, null)''')
s=s.replace('''"+$74.28")''','''"+$149.30")''')
open(p,'w').write(s)
p='server/links.ts'; s=open(p).read()
s=s.replace('''/** Whether `signature` is `address` signing the message that links it to `owner`. A malformed one just isn't. */
export async function verifyLink(owner: string, address: string, signature: string): Promise<boolean> {''','''type Recover = (args: { message: string; signature: `0x${string}` }) => Promise<string>

/** Whether `signature` is `address` signing the message that links it to `owner`. A malformed one just isn't. */
export async function verifyLink(owner: string, address: string, signature: string, recover: Recover = recoverMessageAddress): Promise<boolean> {''')
s=s.replace('''    const signer = await recoverMessageAddress({ message''','''    const signer = await recover({ message''')
open(p,'w').write(s)
