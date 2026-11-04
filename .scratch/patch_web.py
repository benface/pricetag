p='src/ui/App.tsx'; s=open(p).read()
s=s.replace('''import { hasStarted, isAddress, isBehind, type WalletResponse } from "../core/api.ts"
import type { Method } from "../core/fold.ts"
import { foldPositions, hasAnswer, pnlOverTime, sumTotals, unconfirmedAssets, unreadAssets, type Coverage, type Exclusion, type PnlPoint, type Position } from "../core/portfolio.ts"
''','''import { hasStarted, isAddress, isBehind, type WalletResponse } from "../core/api.ts"
import { linkedWallets } from "../core/book.ts"
import { exportCsv } from "../core/export.ts"
import type { Method } from "../core/fold.ts"
import { foldBook, hasAnswer, sumTotals, type Coverage, type Exclusion, type PnlPoint, type Position } from "../core/portfolio.ts"
''')
s=s.replace('''import { PnlChart } from "./PnlChart.tsx"
import { useWallet } from "./useWallet.ts"
''','''import { PnlChart } from "./PnlChart.tsx"
import { ResolvePanel } from "./ResolvePanel.tsx"
import { useBook, useOtherWallets } from "./useBook.ts"
import { useWallet } from "./useWallet.ts"
''')
s=s.replace('''function Holdings({ positions, onExplain }: { positions: Position[]; onExplain: (e: Explanation) => void }) {''','''const est = (text: string, isEstimate: boolean) => (isEstimate ? `≈${text}` : text)

function Holdings({ positions, resolvable, onExplain, onResolve }: { positions: Position[]; resolvable: ReadonlySet<string>; onExplain: (e: Explanation) => void; onResolve: (asset: string) => void }) {''')
s=s.replace('''{values.averageCostUsdMicros ? formatPrice(values.averageCostUsdMicros) : "⚠ Unknown"}''','''{values.averageCostUsdMicros ? est(formatPrice(values.averageCostUsdMicros), position.estimates.cost) : "⚠ Unknown"}''')
s=s.replace('''{values.valueUsdMicros ? formatUsd(values.valueUsdMicros) : "⚠ No price"}''','''{values.valueUsdMicros ? est(formatUsd(values.valueUsdMicros), position.estimates.value) : "⚠ No price"}''')
s=s.replace('''{values.realizedUsdMicros === null ? "⚠ PnL unavailable" : formatSignedUsd(values.realizedUsdMicros)}''','''{values.realizedUsdMicros === null ? "⚠ PnL unavailable" : est(formatSignedUsd(values.realizedUsdMicros), position.estimates.realized)}''')
s=s.replace('''                        <Num label={`${asset} unrealized PnL`} onClick={open(position, "unrealized")} tone={toneOf(values.unrealizedUsdMicros)}>
                          {values.unrealizedUsdMicros === null ? "⚠ PnL unavailable" : formatSignedUsd(values.unrealizedUsdMicros)}
                        </Num>
''','''                        <>
                          <Num label={`${asset} unrealized PnL`} onClick={open(position, "unrealized")} tone={toneOf(values.unrealizedUsdMicros)}>
                            {values.unrealizedUsdMicros === null ? "⚠ PnL unavailable" : est(formatSignedUsd(values.unrealizedUsdMicros), position.estimates.unrealized)}
                          </Num>
                          {unknown && resolvable.has(asset) ? (
                            <button type="button" className="resolve-button" aria-label={`Resolve ${asset}`} onClick={() => onResolve(asset)}>
                              Resolve
                            </button>
                          ) : null}
                        </>
''')
s=s.replace('''  const { wallet, loading, error } = useWallet(address)
''','''  const { wallet, loading, error } = useWallet(address)
  const { book, change, undo, canUndo } = useBook()
  const [resolving, setResolving] = useState<{ asset: string | null } | null>(null)
  const [cardSender, setCardSender] = useState<string | null>(null)
  const wanted = useMemo(() => [...new Set([...linkedWallets(book), ...(cardSender ? [cardSender] : [])])].filter((a) => a !== wallet?.address), [book, cardSender, wallet?.address])
  const others = useOtherWallets(wanted, wallet?.latest.blockNum ?? null)
''')
s=s.replace('''  const positions = useMemo(() => (wallet ? foldPositions(wallet.legs, method, wallet.prices, wallet) : []), [wallet, method])
  const unread = useMemo(() => (wallet ? unreadAssets(positions, wallet) : []), [wallet, positions])
  const totals = useMemo(() => sumTotals(positions, unread), [positions, unread])
  const points = useMemo(() => (wallet ? pnlOverTime(wallet.legs, method, wallet.prices, wallet.references, wallet.latest, unconfirmedAssets(positions, unread)) : []), [wallet, method, positions, unread])
''','''  const fold = useMemo(() => (wallet ? foldBook(wallet, others, method, book) : null), [wallet, others, method, book])
  const positions = fold?.positions ?? []
  const unread = fold?.unread ?? []
  const totals = fold?.totals ?? sumTotals([])
  const points = fold?.points ?? []
  const questions = fold?.questions ?? []
  const resolvable = useMemo(() => new Set(questions.flatMap((q) => q.arrivals.map((a) => a.asset))), [questions])
  const listed = positions.filter((p) => !p.noMarket)
  const noMarketCount = totals.noMarket.length + (wallet?.unlistedTokens.length ?? 0)
  const caveat = [BigInt(totals.unresolvedUsdMicros) > 0n ? `${formatUsd(totals.unresolvedUsdMicros)} unresolved` : null, BigInt(totals.estimatedUsdMicros) > 0n ? `${formatUsd(totals.estimatedUsdMicros)} estimated` : null].filter(Boolean).join(" · ")
  const download = () => {
    const link = document.createElement("a")
    link.href = URL.createObjectURL(new Blob([exportCsv(positions)], { type: "text/csv" }))
    link.download = `patina-${wallet?.address}.csv`
    link.click()
    URL.revokeObjectURL(link.href)
  }
''')
s=s.replace('''{totals.pnlUsdMicros === null ? "⚠ Unavailable" : formatSignedUsd(totals.pnlUsdMicros)}</span>
                  </Num>
''','''{totals.pnlUsdMicros === null ? "⚠ PnL unavailable" : est(formatSignedUsd(totals.pnlUsdMicros), BigInt(totals.estimatedUsdMicros) > 0n)}</span>
                  </Num>
                  {caveat ? <p className="caveat">{caveat}</p> : null}
                  {questions.length > 0 ? (
                    <button type="button" className="resolve-button big" onClick={() => setResolving({ asset: null })}>
                      Resolve {questions.length}
                    </button>
                  ) : null}
''')
s=s.replace('''value={totals.valueUsdMicros && formatUsd(totals.valueUsdMicros)} />''','''value={totals.valueUsdMicros && est(formatUsd(totals.valueUsdMicros), totals.estimated.value)} />''')
s=s.replace('''value={totals.realizedUsdMicros && formatSignedUsd(totals.realizedUsdMicros)} />''','''value={totals.realizedUsdMicros && est(formatSignedUsd(totals.realizedUsdMicros), totals.estimated.realized)} />''')
s=s.replace('''value={totals.unrealizedUsdMicros && formatSignedUsd(totals.unrealizedUsdMicros)} />''','''value={totals.unrealizedUsdMicros && est(formatSignedUsd(totals.unrealizedUsdMicros), totals.estimated.unrealized)} />''')
s=s.replace('''              {positions.length > 0 ? <Holdings positions={positions} onExplain={setExplanation} /> : null}
''','''              {listed.length > 0 ? <Holdings positions={listed} resolvable={resolvable} onExplain={setExplanation} onResolve={(asset) => setResolving({ asset })} /> : null}
              {noMarketCount > 0 ? (
                <p className="notice">
                  {noMarketCount} {noMarketCount === 1 ? "token" : "tokens"} with no market{totals.noMarket.length > 0 ? `: ${totals.noMarket.join(", ")}` : ""}
                  {wallet.unlistedTokens.length > 0 ? `${totals.noMarket.length > 0 ? ", plus" : ":"} ${wallet.unlistedTokens.length} we don't track` : ""}. Often spam, and not counted in any total.
                </p>
              ) : null}
              <p>
                <button type="button" className="link" onClick={download}>
                  Export as CSV
                </button>
              </p>
''')
s=s.replace('''      {explanation ? <ExplainPanel explanation={explanation} onClose={close} /> : null}
''','''      {explanation ? <ExplainPanel explanation={explanation} onClose={close} /> : null}
      {resolving && wallet ? <ResolvePanel wallet={wallet} others={others} method={method} book={book} firstAsset={resolving.asset} onChange={change} onUndo={undo} canUndo={canUndo} onCurrentSender={setCardSender} onClose={() => setResolving(null)} /> : null}
''')
open(p,'w').write(s)

p='src/ui/ExplainPanel.tsx'; s=open(p).read()
s=s.replace('import { describeEffect, describeNetting, type Explanation } from "../core/explain.ts"','import { COST_WORDS, PRICE_WORDS, describeEffect, describeNetting, type Explanation } from "../core/explain.ts"')
s=s.replace('''{formatPrice(leg.priceUsdMicros)} · {leg.priceSource}''','''{formatPrice(leg.priceUsdMicros)} · {PRICE_WORDS[leg.priceSource]}''')
s=s.replace('''        {incoming ? <span className={leg.costLabel === "unknown" ? "tag warn" : "tag"}>{leg.costLabel === "unknown" ? "⚠ cost unknown" : `cost: ${leg.costLabel}`}</span> : null}
''','''        {incoming ? <span className={leg.costLabel === "unknown" ? "tag warn" : "tag"}>{leg.costLabel === "unknown" ? "⚠ cost unknown" : `cost: ${COST_WORDS[leg.costLabel]}`}</span> : null}
        {incoming && leg.costLabel !== "unknown" && leg.costUsdMicros === null ? <span className="tag warn">⚠ partly unknown</span> : null}
        {leg.estimated ? <span className="tag">≈ estimate</span> : null}
''')
open(p,'w').write(s)

p='src/core/explain.ts'; s=open(p).read()
s=s.replace('const COST_WORDS: Record<CostLabel, string>','export const COST_WORDS: Record<CostLabel, string>')
open(p,'w').write(s)

p='src/ui/styles.css'; s=open(p).read()
s=s.replace('''@media (max-width: 800px) {''','''.caveat { font-size: 13px; font-weight: 600; color: var(--warn-ink); margin-top: 2px; }
.resolve-button { font-size: 12px; font-weight: 600; margin-left: 8px; padding: 1px 8px; border-radius: 6px; border: 1px solid var(--warn-border); background: var(--warn-fill); color: var(--warn-ink); }
.resolve-button.big { font-size: 13px; margin: 8px 0 0; padding: 4px 12px; }
.resolve { width: min(520px, 100%); padding: 20px; border: 1px solid var(--border); border-radius: 16px; background: var(--surface-1); color: inherit; box-shadow: 0 12px 40px rgb(0 0 0 / 0.25); }
.resolve::backdrop { background: rgb(0 0 0 / 0.32); }
.resolve h2 { font-size: 20px; }
.resolve > * + * { margin-top: 12px; }
.meter { height: 6px; border-radius: 999px; background: var(--grid); overflow: hidden; }
.meter-fill { height: 100%; background: var(--warn-border); transition: width 0.25s ease-out; }
.meter-fill.done { background: var(--gain); }
.who-card { padding: 16px; border-radius: 14px; background: var(--surface-0); display: flex; flex-direction: column; gap: 6px; touch-action: none; user-select: none; }
.arrived { font-size: 18px; }
.answers { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.answers button { display: flex; align-items: baseline; gap: 12px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface-1); text-align: left; }
.answers button:hover { border-color: var(--axis); }
.answer-title { font-weight: 600; flex: 1; }
.key { font-family: ui-monospace, Menlo, monospace; white-space: nowrap; }
.cost-form { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.cost-form label { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.cost-form input { flex: 0 0 140px; text-align: right; }
.cost-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.cost-actions button, .file-button, .resolve-foot button, .finish button { padding: 6px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-1); font-size: 13px; cursor: pointer; }
.warn-text { color: var(--warn-ink); }
.finish { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 24px 0; text-align: center; }
.seal { width: 72px; height: 72px; border-radius: 50%; display: grid; place-items: center; font-size: 36px; background: var(--grid); }
.seal.done { background: var(--gain); color: var(--surface-1); animation: seal 0.45s cubic-bezier(0.2, 1.4, 0.4, 1); }
@keyframes seal { from { transform: scale(0.4); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .seal.done { animation: none; } .meter-fill { transition: none; } }
.resolve-foot { display: flex; gap: 8px; }
.resolve-foot button:disabled { opacity: 0.5; cursor: default; }
.spacer { flex: 1; }
@media (max-width: 800px) {''')
open(p,'w').write(s)
