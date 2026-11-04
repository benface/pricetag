import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react"
import { TOKENS, foldPositions, hasAnswer, isAddress, pnlOverTime, sumTotals, unconfirmedAssets, unreadAssets, type Coverage, type Method, type Position } from "@pricetag/sdk/core"
import { hasStarted, isBehind, type WalletResponse } from "../core/api.ts"
import { CURRENCIES, CURRENCY_CODES, isCurrencyCode, viewWallet, type CurrencyCode } from "../core/currency.ts"
import { ExplainPanel } from "./ExplainPanel.tsx"
import { explainContext, explainTarget, missingRatesLine, mismatchCause, type ExplainTarget, type Metric, type TotalMetric } from "../core/explain.ts"
import { formatAmount, formatMoney, formatPrice, formatSignedAmount, formatSignedMoney, formatTime } from "../core/format.ts"
import {
  AVERAGE_PRICE_PAID,
  BALANCE_CHECK,
  CHECK_LABELS,
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
  networkFeeUnknownSentence,
  staleSentence,
} from "../core/wording.ts"
import { PnlChart } from "./PnlChart.tsx"
import { RulesPanel } from "./RulesPanel.tsx"
import { useRules } from "./useRules.ts"
import { useWallet } from "./useWallet.ts"

function readAddress(): string | null {
  const value = new URLSearchParams(window.location.search).get("address")
  return value && (value === "demo" || isAddress(value)) ? value : null
}

const CURRENCY_KEY = "pricetag.currency"

/** Remembered in this browser, since there are no accounts. USD until it's changed. */
function readCurrency(): CurrencyCode {
  const value = localStorage.getItem(CURRENCY_KEY)
  return isCurrencyCode(value) ? value : "USD"
}

function Num({ onClick, label, children, tone }: { onClick: () => void; label: string; children: ReactNode; tone?: "gain" | "loss" | "warn" | null }) {
  return (
    <button type="button" className={`num-button ${tone ?? ""}`} onClick={onClick} aria-label={label}>
      {children}
    </button>
  )
}

const toneOf = (micros: string | null) => (micros === null ? "warn" : BigInt(micros) > 0n ? "gain" : BigInt(micros) < 0n ? "loss" : null)

function OnchainCheck({ position, onClick }: { position: Position; onClick: () => void }) {
  const status = position.reconciliation?.status
  if (status === "reconciled") return <Num label={`${position.asset} matches its actual balance`} onClick={onClick} tone="gain">✓ {CHECK_LABELS.reconciled}</Num>
  if (status === "incomplete") return <Num label={`${position.asset} doesn't match its actual balance`} onClick={onClick} tone="warn">⚠ {CHECK_LABELS.incomplete}</Num>
  return <Num label={`${position.asset} not checked against its actual balance`} onClick={onClick} tone="warn">⚠ {CHECK_LABELS.unchecked}</Num>
}

function Holdings({ positions, currency, explain }: { positions: Position[]; currency: CurrencyCode; explain: (target: ExplainTarget) => void }) {
  const open = ({ asset }: Position, metric: Metric) => () => explain({ kind: "asset", asset, metric })
  const money = (micros: string) => formatMoney(micros, currency)
  const signed = (micros: string) => formatSignedMoney(micros, currency)
  return (
    <section className="card">
      <h2>Holdings</h2>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Asset</th>
              <th>{BALANCE_CHECK}</th>
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
              const mismatch = position.reconciliation?.status === "incomplete" ? position.reconciliation : null
              const flagged = mismatch !== null || BigInt(state.shortfallQty) > 0n
              return (
                <Fragment key={asset}>
                  <tr className={`${held ? "" : "closed"} ${mismatch ? "mismatched" : ""}`}>
                    <td>
                      <strong>{asset}</strong>
                      {asset === "ETH" ? <span className="muted small"> {ETH_NOTE}</span> : null}
                    </td>
                    <td>
                      <OnchainCheck position={position} onClick={open(position, "onchain")} />
                    </td>
                    <td className="num">
                      <Num label={`${asset} amount`} onClick={open(position, "amount")} tone={flagged ? "warn" : null}>
                        {flagged ? "⚠ " : ""}
                        {formatAmount(values.qty, decimals)}
                      </Num>
                    </td>
                    <td className="num">
                      {held ? (
                        <Num label={`${asset} ${AVERAGE_PRICE_PAID.toLowerCase()}`} onClick={open(position, "average")} tone={unknown ? "warn" : null}>
                          {values.averageCostMicros ? formatPrice(values.averageCostMicros, currency) : "⚠ Unknown"}
                        </Num>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="num">
                      {held ? (
                        <Num label={`${asset} value`} onClick={open(position, "value")} tone={values.valueMicros === null ? "warn" : null}>
                          {values.valueMicros ? money(values.valueMicros) : "⚠ No price"}
                        </Num>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="num" title={REALIZED_HELP}>
                      <Num label={`${asset} realized PnL`} onClick={open(position, "realized")} tone={toneOf(values.realizedMicros)}>
                        {values.realizedMicros === null ? `⚠ ${PNL_UNAVAILABLE}` : signed(values.realizedMicros)}
                      </Num>
                    </td>
                    <td className="num" title={UNREALIZED_HELP}>
                      {held ? (
                        <Num label={`${asset} unrealized PnL`} onClick={open(position, "unrealized")} tone={toneOf(values.unrealizedMicros)}>
                          {values.unrealizedMicros === null ? `⚠ ${PNL_UNAVAILABLE}` : signed(values.unrealizedMicros)}
                        </Num>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                  {mismatch ? (
                    <tr className="mismatch">
                      <td colSpan={7}>
                        Worked out {formatAmount(mismatch.computedQty, decimals)} · Actual {formatAmount(mismatch.actualQty, decimals)} · Difference {formatSignedAmount(mismatch.differenceQty, decimals)} {asset}. {mismatchCause(asset, mismatch.differenceQty)}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
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
  const [target, setTarget] = useState<ExplainTarget | null>(null)
  const [chosenCurrency, setChosenCurrency] = useState<CurrencyCode>(readCurrency)
  const { rules, chosen: chosenRule, choose: chooseRule } = useRules()
  const { wallet, loading, error } = useWallet(address, chosenCurrency, chosenRule)

  useEffect(() => {
    const onPop = () => {
      setAddress(readAddress())
      setTarget(null)
    }
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  const go = (next: string) => {
    window.history.pushState(null, "", `?address=${next}`)
    setAddress(next)
    setTarget(null)
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

  const chooseCurrency = (next: CurrencyCode) => {
    localStorage.setItem(CURRENCY_KEY, next)
    setChosenCurrency(next)
  }

  const view = useMemo(() => (wallet ? viewWallet(wallet) : null), [wallet])
  // Whatever's on screen says what it's in, which for a moment after a change isn't what was just chosen.
  const currency = view?.currency ?? chosenCurrency
  const positions = useMemo(() => (view && wallet ? foldPositions(view.legs, method, view.prices, wallet) : []), [view, wallet, method])
  const unread = useMemo(() => (wallet ? unreadAssets(positions, wallet) : []), [wallet, positions])
  const totals = useMemo(() => sumTotals(positions, unread), [positions, unread])
  const points = useMemo(() => (view && wallet ? pnlOverTime(view.legs, method, view.prices, view.markPrice, wallet.latest, unconfirmedAssets(positions, unread)) : []), [view, wallet, method, positions, unread])
  // Worked out from what's on screen, so it can't go on showing numbers that have since changed, or that are in another currency.
  const explanation = useMemo(
    () => (target && view && wallet ? explainTarget(target, { positions, totals, points }, explainContext(wallet, view, method)) : null),
    [target, view, wallet, method, positions, totals, points],
  )
  const close = useCallback(() => setTarget(null), [])
  const openTotal = (metric: TotalMetric) => setTarget({ kind: "total", metric })

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
        <label className="currency">
          <span className="muted small">Main currency</span>
          <select value={chosenCurrency} onChange={(e) => chooseCurrency(e.target.value as CurrencyCode)}>
            {CURRENCY_CODES.map((code) => (
              <option key={code} value={code}>
                {code} · {CURRENCIES[code].name}
              </option>
            ))}
          </select>
        </label>
        {wallet ? <LiveBadge wallet={wallet} stale={error !== null} /> : null}
      </header>
      {inputError ? <p className="notice warn">⚠ {inputError}</p> : null}
      {rules.length > 1 ? <RulesPanel rules={rules} chosen={chosenRule} choose={chooseRule} current={wallet?.rule ?? null} address={address} method={method} currency={currency} /> : null}

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
          {hasStarted(wallet) ? <p className="notice">{coverageSentence(wallet.coverage, TOKENS.length - 1, wallet.openingUnread.length > 0)}</p> : null}
          {wallet.gasUnknownTxs.length > 0 ? <p className="notice warn">⚠ {feesUnknownSentence(wallet.gasUnknownTxs.length)}</p> : null}
          {view && view.missingRateTxs.length > 0 ? <p className="notice warn">⚠ {missingRatesLine(view.missingRateTxs.length, currency)}</p> : null}
          {currency !== "USD" && view && !view.latestRate ? <p className="notice warn">⚠ There's no current USD to {currency} rate, so what's held has no current value.</p> : null}
          {wallet.l1FeeUnknownTxs.length > 0 ? <p className="notice warn" title={PNL_HELP}>⚠ {networkFeeUnknownSentence(wallet.l1FeeUnknownTxs.length)}</p> : null}

          {positions.length === 0 && !hasStarted(wallet) ? null : positions.length === 0 && unread.length === 0 ? (
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
                    Total PnL · {currency}
                  </span>
                  <Num label="Total PnL" onClick={() => openTotal("pnl")} tone={toneOf(totals.pnlMicros)}>
                    <span className="big">{totals.pnlMicros === null ? "⚠ Unavailable" : formatSignedMoney(totals.pnlMicros, currency)}</span>
                  </Num>
                  {totals.excluded.length > 0 ? (
                    <p className="excluded">⚠ {excludedSentence(totals.excluded)}</p>
                  ) : (
                    <p className="muted small">Nothing excluded.</p>
                  )}
                  {totals.unpricedGas ? <p className="excluded">⚠ {UNPRICED_FEES}</p> : null}
                </div>
                <dl className="stats">
                  <Stat label="Value" onClick={() => openTotal("value")} coverage={totals.coverage.value} value={totals.valueMicros && formatMoney(totals.valueMicros, currency)} />
                  <Stat label="Realized" help={REALIZED_HELP} onClick={() => openTotal("realized")} coverage={totals.coverage.realized} value={totals.realizedMicros && formatSignedMoney(totals.realizedMicros, currency)} />
                  <Stat label="Unrealized" help={UNREALIZED_HELP} onClick={() => openTotal("unrealized")} coverage={totals.coverage.unrealized} value={totals.unrealizedMicros && formatSignedMoney(totals.unrealizedMicros, currency)} />
                  <Stat label={NETWORK_FEES} onClick={() => openTotal("gas")} coverage={{ known: 1, missing: totals.unpricedGas ? 1 : 0 }} value={totals.gasMicros && formatMoney(totals.gasMicros, currency)} />
                </dl>
                <div className="method" role="group" aria-label={METHOD_NAME} title={METHOD_HELP}>
                  {(["average", "fifo"] as const).map((m) => (
                    <button key={m} type="button" className={method === m ? "on" : ""} aria-pressed={method === m} onClick={() => setMethod(m)}>
                      {METHOD_LABELS[m]}
                    </button>
                  ))}
                </div>
              </section>
              <PnlChart points={points} currency={currency} onSelect={(point) => setTarget({ kind: "tx", txHash: point.txHash as string })} />
              {positions.length > 0 ? <Holdings positions={positions} currency={currency} explain={setTarget} /> : null}
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
