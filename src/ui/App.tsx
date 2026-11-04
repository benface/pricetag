import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react"
import { hasStarted, isAddress, isBehind, type WalletResponse } from "../core/api.ts"
import type { Method } from "../core/fold.ts"
import { foldPositions, hasAnswer, pnlOverTime, sumTotals, type Coverage, type PnlPoint, type Position } from "../core/portfolio.ts"
import { ExplainPanel } from "./ExplainPanel.tsx"
import { explainMetric, explainPoint, explainTotal, type Explanation, type Metric, type TotalMetric } from "../core/explain.ts"
import { formatAmount, formatPrice, formatSignedUsd, formatTime, formatUsd } from "../core/format.ts"
import { TOKENS } from "../core/tokens.ts"
import {
  AVERAGE_PRICE_PAID,
  DEMO_NOTICE,
  ETH_NOTE,
  METHOD_HELP,
  METHOD_LABELS,
  METHOD_NAME,
  NETWORK_FEES,
  NOT_AN_ADDRESS,
  NOT_STARTED,
  PNL_HELP,
  PNL_UNAVAILABLE,
  READING,
  REALIZED_HELP,
  UNPRICED_FEES,
  UNREALIZED_HELP,
  behindSentence,
  coverageSentence,
  excludedSentence,
  feedDetail,
  feesUnknownSentence,
  staleSentence,
} from "../core/wording.ts"
import { PnlChart } from "./PnlChart.tsx"
import { useWallet } from "./useWallet.ts"

function readAddress(): string | null {
  const value = new URLSearchParams(window.location.search).get("address")
  return value && (value === "demo" || isAddress(value)) ? value : null
}

function Num({ onClick, label, children, tone }: { onClick: () => void; label: string; children: ReactNode; tone?: "gain" | "loss" | "warn" | null }) {
  return (
    <button type="button" className={`num-button ${tone ?? ""}`} onClick={onClick} aria-label={label}>
      {children}
    </button>
  )
}

const toneOf = (micros: string | null) => (micros === null ? "warn" : BigInt(micros) > 0n ? "gain" : BigInt(micros) < 0n ? "loss" : null)

function Holdings({ positions, onExplain }: { positions: Position[]; onExplain: (e: Explanation) => void }) {
  const open = (position: Position, metric: Metric) => () => onExplain(explainMetric(position, metric))
  return (
    <section className="card">
      <h2>Holdings</h2>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Asset</th>
              <th className="num">Amount</th>
              <th className="num">{AVERAGE_PRICE_PAID}</th>
              <th className="num">Value</th>
              <th className="num" title={REALIZED_HELP}>
                Realized
              </th>
              <th className="num" title={UNREALIZED_HELP}>
                Unrealized
              </th>
            </tr>
          </thead>
          <tbody>
            {positions.map((position) => {
              const { asset, decimals, values, state } = position
              const held = BigInt(values.qty) > 0n
              const unknown = BigInt(values.unknownCostQty) > 0n
              return (
                <tr key={asset} className={held ? "" : "closed"}>
                  <td>
                    <strong>{asset}</strong>
                    {asset === "ETH" ? <span className="muted small"> {ETH_NOTE}</span> : null}
                  </td>
                  <td className="num">
                    <Num label={`${asset} amount`} onClick={open(position, "amount")} tone={BigInt(state.shortfallQty) > 0n ? "warn" : null}>
                      {BigInt(state.shortfallQty) > 0n ? "⚠ " : ""}
                      {formatAmount(values.qty, decimals)}
                    </Num>
                  </td>
                  <td className="num">
                    {held ? (
                      <Num label={`${asset} ${AVERAGE_PRICE_PAID.toLowerCase()}`} onClick={open(position, "average")} tone={unknown ? "warn" : null}>
                        {values.averageCostUsdMicros ? formatPrice(values.averageCostUsdMicros) : "⚠ Unknown"}
                      </Num>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="num">
                    {held ? (
                      <Num label={`${asset} value`} onClick={open(position, "value")} tone={values.valueUsdMicros === null ? "warn" : null}>
                        {values.valueUsdMicros ? formatUsd(values.valueUsdMicros) : "⚠ No price"}
                      </Num>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="num" title={REALIZED_HELP}>
                    <Num label={`${asset} realized PnL`} onClick={open(position, "realized")} tone={toneOf(values.realizedUsdMicros)}>
                      {values.realizedUsdMicros === null ? `⚠ ${PNL_UNAVAILABLE}` : formatSignedUsd(values.realizedUsdMicros)}
                    </Num>
                  </td>
                  <td className="num" title={UNREALIZED_HELP}>
                    {held ? (
                      <Num label={`${asset} unrealized PnL`} onClick={open(position, "unrealized")} tone={toneOf(values.unrealizedUsdMicros)}>
                        {values.unrealizedUsdMicros === null ? `⚠ ${PNL_UNAVAILABLE}` : formatSignedUsd(values.unrealizedUsdMicros)}
                      </Num>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export function App() {
  const [address, setAddress] = useState(readAddress)
  const [input, setInput] = useState(() => (readAddress() === "demo" ? "" : (readAddress() ?? "")))
  const [inputError, setInputError] = useState<string | null>(null)
  const [method, setMethod] = useState<Method>("average")
  const [explanation, setExplanation] = useState<Explanation | null>(null)
  const { wallet, loading, error } = useWallet(address)

  useEffect(() => {
    const onPop = () => setAddress(readAddress())
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  const go = (next: string) => {
    window.history.pushState(null, "", `?address=${next}`)
    setAddress(next)
    setExplanation(null)
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const value = input.trim()
    if (!isAddress(value)) {
      setInputError(NOT_AN_ADDRESS)
      return
    }
    setInputError(null)
    go(value.toLowerCase())
  }

  const positions = useMemo(() => (wallet ? foldPositions(wallet.legs, method, wallet.prices) : []), [wallet, method])
  const totals = useMemo(() => sumTotals(positions), [positions])
  const points = useMemo(() => (wallet ? pnlOverTime(wallet.legs, method, wallet.prices, wallet.references, wallet.latest) : []), [wallet, method])
  const close = useCallback(() => setExplanation(null), [])
  const openTotal = (metric: TotalMetric) => setExplanation(explainTotal(positions, totals, metric))
  const openPoint = (point: PnlPoint) => setExplanation(explainPoint(positions, point))

  return (
    <div className="page">
      <header className="top">
        <a className="brand" href="/">
          Pricetag
        </a>
        <form className="address" onSubmit={submit}>
          <input
            aria-label="Base address"
            placeholder="Paste any Base address, 0x…"
            value={input}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setInput(e.target.value)}
          />
          <button type="submit">Look up</button>
        </form>
        {wallet ? <LiveBadge wallet={wallet} stale={error !== null} /> : null}
      </header>
      {inputError ? <p className="notice warn">⚠ {inputError}</p> : null}

      {!address ? (
        <section className="empty">
          <h1>Every transfer gets a price.</h1>
          <p>Paste a Base address to see its holdings, cost and <span title={PNL_HELP}>PnL</span>, with every number explained. This is view-only: there are no keys here, and it can't send anything.</p>
          <button type="button" onClick={() => go("demo")}>
            Try the demo wallet
          </button>
        </section>
      ) : null}

      {loading ? (
        <section className="empty">
          <p>{READING}</p>
        </section>
      ) : null}

      {!wallet && error ? <p className="notice warn">⚠ {error}</p> : null}

      {wallet ? (
        <main>
          {error ? <p className="notice warn">⚠ {error} {staleSentence(formatTime(wallet.latest.timestamp))}</p> : null}
          {isBehind(wallet) ? (
            <p className="notice warn">⚠ {hasStarted(wallet) ? behindSentence(wallet.latest.blockNum - wallet.coverage.toBlock) : NOT_STARTED}</p>
          ) : null}
          {wallet.mode === "demo" ? <p className="notice">{DEMO_NOTICE}</p> : null}
          {hasStarted(wallet) ? <p className="notice">{coverageSentence(wallet.coverage, TOKENS.length - 1)}</p> : null}
          {wallet.gasUnknownTxs.length > 0 ? <p className="notice warn">⚠ {feesUnknownSentence(wallet.gasUnknownTxs.length)}</p> : null}

          {wallet.legs.length === 0 && !hasStarted(wallet) ? null : wallet.legs.length === 0 ? (
            <section className="empty">
              <p>
                No activity for <code>{wallet.address}</code> in this time.
              </p>
            </section>
          ) : (
            <>
              <section className="summary">
                <div className="headline">
                  <span className="muted small" title={PNL_HELP}>
                    Total PnL
                  </span>
                  <Num label="Total PnL" onClick={() => openTotal("pnl")} tone={toneOf(totals.pnlUsdMicros)}>
                    <span className="big">{totals.pnlUsdMicros === null ? "⚠ Unavailable" : formatSignedUsd(totals.pnlUsdMicros)}</span>
                  </Num>
                  {totals.excluded.length > 0 ? (
                    <p className="excluded">⚠ {excludedSentence(totals.excluded)}</p>
                  ) : (
                    <p className="muted small">Nothing excluded.</p>
                  )}
                  {totals.unpricedGas ? <p className="excluded">⚠ {UNPRICED_FEES}</p> : null}
                </div>
                <dl className="stats">
                  <Stat label="Value" onClick={() => openTotal("value")} coverage={totals.coverage.value} value={totals.valueUsdMicros && formatUsd(totals.valueUsdMicros)} />
                  <Stat label="Realized" help={REALIZED_HELP} onClick={() => openTotal("realized")} coverage={totals.coverage.realized} value={totals.realizedUsdMicros && formatSignedUsd(totals.realizedUsdMicros)} />
                  <Stat label="Unrealized" help={UNREALIZED_HELP} onClick={() => openTotal("unrealized")} coverage={totals.coverage.unrealized} value={totals.unrealizedUsdMicros && formatSignedUsd(totals.unrealizedUsdMicros)} />
                  <Stat label={NETWORK_FEES} onClick={() => openTotal("gas")} coverage={{ known: 1, missing: totals.unpricedGas ? 1 : 0 }} value={totals.gasUsdMicros && formatUsd(totals.gasUsdMicros)} />
                </dl>
                <div className="method" role="group" aria-label={METHOD_NAME} title={METHOD_HELP}>
                  {(["average", "fifo"] as const).map((m) => (
                    <button key={m} type="button" className={method === m ? "on" : ""} aria-pressed={method === m} onClick={() => setMethod(m)}>
                      {METHOD_LABELS[m]}
                    </button>
                  ))}
                </div>
              </section>
              <PnlChart points={points} onSelect={openPoint} />
              <Holdings positions={positions} onExplain={setExplanation} />
            </>
          )}
        </main>
      ) : null}

      {explanation ? <ExplainPanel explanation={explanation} onClose={close} /> : null}
    </div>
  )
}

function Stat({ label, help, onClick, coverage, value }: { label: string; help?: string; onClick: () => void; coverage: Coverage; value: string | null }) {
  return (
    <div>
      <dt className="muted small" title={help}>
        {label}
      </dt>
      <dd>
        <Num label={label} onClick={onClick} tone={value === null ? "warn" : null}>
          {value ?? "⚠ Unavailable"}
        </Num>
        {value !== null && hasAnswer(coverage) && coverage.missing > 0 ? <span className="partial">⚠ partial</span> : null}
      </dd>
    </div>
  )
}

function LiveBadge({ wallet, stale }: { wallet: WalletResponse; stale: boolean }) {
  if (wallet.mode === "demo") return <span className="badge">Demo data</span>
  const detail = feedDetail(wallet.mode, wallet.coverage.toBlock)
  if (stale) return <span className="badge warn" title={detail}>⚠ Not updating</span>
  if (isBehind(wallet)) return <span className="badge warn" title={detail}>⚠ Catching up</span>
  return <span className="badge live" title={detail}>Live</span>
}
