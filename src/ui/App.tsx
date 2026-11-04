import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react"
import { foldPositions, hasAnswer, isAddress, pnlOverTime, sumTotals, unconfirmedAssets, unreadAssets, type Coverage, type Exclusion, type Method, type Position } from "@pricetag/sdk/core"
import { hasStarted, isBehind, type WalletResponse } from "../core/api.ts"
import { CURRENCIES, CURRENCY_CODES, isCurrencyCode, viewWallet, type CurrencyCode } from "../core/currency.ts"
import { ExplainPanel } from "./ExplainPanel.tsx"
import { explainContext, explainTarget, missingRatesLine, mismatchCause, type ExplainTarget, type Metric, type TotalMetric } from "../core/explain.ts"
import { formatAmount, formatDuration, formatMoney, formatPrice, formatSignedAmount, formatSignedMoney } from "../core/format.ts"
import { PnlChart } from "./PnlChart.tsx"
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

function describeExcluded(excluded: readonly Exclusion[]): string {
  const byReason = new Map<string, string[]>()
  for (const { asset, reason } of excluded) byReason.set(reason, [...(byReason.get(reason) ?? []), asset])
  return [...byReason.entries()].map(([reason, assets]) => `${assets.join(", ")} (${reason})`).join("; ")
}

function OnchainCheck({ position, onClick }: { position: Position; onClick: () => void }) {
  const status = position.reconciliation?.status
  if (status === "reconciled") return <Num label={`${position.asset} reconciled with its onchain balance`} onClick={onClick} tone="gain">✓ Reconciled</Num>
  if (status === "incomplete") return <Num label={`${position.asset} doesn't match its onchain balance`} onClick={onClick} tone="warn">⚠ Incomplete</Num>
  return <Num label={`${position.asset} not checked against its onchain balance`} onClick={onClick} tone="warn">⚠ Not checked</Num>
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
              <th>Onchain</th>
              <th className="num">Amount</th>
              <th className="num">Avg cost</th>
              <th className="num">Value</th>
              <th className="num">Realized</th>
              <th className="num">Unrealized</th>
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
                      {asset === "ETH" ? <span className="muted small"> incl. WETH</span> : null}
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
                        <Num label={`${asset} average cost`} onClick={open(position, "average")} tone={unknown ? "warn" : null}>
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
                    <td className="num">
                      <Num label={`${asset} realized PnL`} onClick={open(position, "realized")} tone={toneOf(values.realizedMicros)}>
                        {values.realizedMicros === null ? "⚠ PnL unavailable" : signed(values.realizedMicros)}
                      </Num>
                    </td>
                    <td className="num">
                      {held ? (
                        <Num label={`${asset} unrealized PnL`} onClick={open(position, "unrealized")} tone={toneOf(values.unrealizedMicros)}>
                          {values.unrealizedMicros === null ? "⚠ PnL unavailable" : signed(values.unrealizedMicros)}
                        </Num>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                  {mismatch ? (
                    <tr className="mismatch">
                      <td colSpan={7}>
                        Computed {formatAmount(mismatch.computedQty, decimals)} · Actual {formatAmount(mismatch.actualQty, decimals)} · Difference {formatSignedAmount(mismatch.differenceQty, decimals)} {asset}. {mismatchCause(asset, mismatch.differenceQty)}
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
  const { wallet, loading, error } = useWallet(address, chosenCurrency)

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
      setInputError("That isn't a Base address. It should be 0x followed by 40 hex characters.")
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

      {!address ? (
        <section className="empty">
          <h1>Every transfer gets a price.</h1>
          <p>Paste a Base address to see its holdings, cost and PnL, with every number explained. This is watch-only: there are no keys here, and nothing is signed.</p>
          <button type="button" onClick={() => go("demo")}>
            Try the demo wallet
          </button>
        </section>
      ) : null}

      {loading ? (
        <section className="empty">
          <p>Reading this wallet's history from Amp. The first read can take a minute, then only new blocks are read.</p>
        </section>
      ) : null}

      {!wallet && error ? <p className="notice warn">⚠ {error}</p> : null}

      {wallet ? (
        <main>
          {error ? <p className="notice warn">⚠ {error} These numbers are through block {wallet.coverage.toBlock.toLocaleString("en-US")} and aren't updating.</p> : null}
          {isBehind(wallet) ? (
            <p className="notice warn">
              ⚠{" "}
              {hasStarted(wallet)
                ? `The Pricetag dataset has only processed up to block ${wallet.coverage.toBlock.toLocaleString("en-US")}, ${(wallet.latest.blockNum - wallet.coverage.toBlock).toLocaleString("en-US")} blocks behind the chain. Anything after that isn't in these numbers yet.`
                : `The Pricetag dataset hasn't reached block ${wallet.coverage.fromBlock.toLocaleString("en-US")} yet, so there's nothing to show for this wallet so far.`}
            </p>
          ) : null}
          {wallet.mode === "demo" ? <p className="notice">Demo data, not a real wallet. Every case the app has to get right is in here.</p> : null}
          {hasStarted(wallet) ? (
            <p className="notice">
              Covers blocks {wallet.coverage.fromBlock.toLocaleString("en-US")} to {wallet.coverage.toBlock.toLocaleString("en-US")} (about {formatDuration(wallet.coverage.toBlock - wallet.coverage.fromBlock)}) and 10 tokens plus ETH.{" "}
              {wallet.openingUnread.length === 0
                ? "What the wallet held before that comes from the chain, at an unknown cost. Tokens off the list aren't counted."
                : "What the wallet held before that couldn't all be read yet, so some amounts may not be full balances. Tokens off the list aren't counted."}
            </p>
          ) : null}
          {wallet.gasUnknownTxs.length > 0 ? <p className="notice warn">⚠ Gas couldn't be worked out for {wallet.gasUnknownTxs.length} transactions, so ETH is overstated by that much.</p> : null}
          {view && view.missingRateTxs.length > 0 ? <p className="notice warn">⚠ {missingRatesLine(view.missingRateTxs.length, currency)}</p> : null}
          {currency !== "USD" && view && !view.latestRate ? <p className="notice warn">⚠ There's no current USD to {currency} rate, so what's held has no current value.</p> : null}
          {wallet.l1FeeUnknownTxs.length > 0 ? <p className="notice warn">⚠ Couldn't read the network fee of {wallet.l1FeeUnknownTxs.length} transactions yet, so gas paid is low and ETH's PnL is unavailable until it can.</p> : null}

          {positions.length === 0 && !hasStarted(wallet) ? null : positions.length === 0 && unread.length === 0 ? (
            <section className="empty">
              <p>
                No movements for <code>{wallet.address}</code> in these blocks.
              </p>
            </section>
          ) : (
            <>
              <section className="summary">
                <div className="headline">
                  <span className="muted small">Total PnL · {currency}</span>
                  <Num label="Total PnL" onClick={() => openTotal("pnl")} tone={toneOf(totals.pnlMicros)}>
                    <span className="big">{totals.pnlMicros === null ? "⚠ Unavailable" : formatSignedMoney(totals.pnlMicros, currency)}</span>
                  </Num>
                  {totals.excluded.length > 0 ? (
                    <p className="excluded">⚠ Excludes {describeExcluded(totals.excluded)}.</p>
                  ) : (
                    <p className="muted small">Nothing excluded.</p>
                  )}
                  {totals.unpricedGas ? <p className="excluded">⚠ Some gas had no price at its block, and isn't in this total.</p> : null}
                </div>
                <dl className="stats">
                  <Stat label="Value" onClick={() => openTotal("value")} coverage={totals.coverage.value} value={totals.valueMicros && formatMoney(totals.valueMicros, currency)} />
                  <Stat label="Realized" onClick={() => openTotal("realized")} coverage={totals.coverage.realized} value={totals.realizedMicros && formatSignedMoney(totals.realizedMicros, currency)} />
                  <Stat label="Unrealized" onClick={() => openTotal("unrealized")} coverage={totals.coverage.unrealized} value={totals.unrealizedMicros && formatSignedMoney(totals.unrealizedMicros, currency)} />
                  <Stat label="Gas paid" onClick={() => openTotal("gas")} coverage={{ known: 1, missing: totals.unpricedGas ? 1 : 0 }} value={totals.gasMicros && formatMoney(totals.gasMicros, currency)} />
                </dl>
                <div className="method" role="group" aria-label="Cost method">
                  {(["average", "fifo"] as const).map((m) => (
                    <button key={m} type="button" className={method === m ? "on" : ""} aria-pressed={method === m} onClick={() => setMethod(m)}>
                      {m === "average" ? "Average cost" : "FIFO"}
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

function Stat({ label, onClick, coverage, value }: { label: string; onClick: () => void; coverage: Coverage; value: string | null }) {
  return (
    <div>
      <dt className="muted small">{label}</dt>
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
  const source = wallet.mode === "dataset" ? "Pricetag dataset" : "raw dataset"
  const block = wallet.coverage.toBlock.toLocaleString("en-US")
  if (stale) return <span className="badge warn">⚠ Not updating · block {block} · {source}</span>
  if (isBehind(wallet)) return <span className="badge warn">⚠ Catching up · block {block} · {source}</span>
  return <span className="badge live">Live · block {block} · {source}</span>
}
