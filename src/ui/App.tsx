import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react"
import { CURRENCIES, CURRENCY_CODES, TOKENS, formatAmount, formatMoney, formatPrice, formatSignedAmount, formatSignedMoney, formatTime, hasAnswer, isAddress, isCurrencyCode, msBetweenBlocks, sumTotals, type Coverage, type CurrencyCode, type HoldComparison, type Method, type Position } from "@pricetag/sdk/core"
import { hasStarted, isBehind, type WalletResponse } from "../core/api.ts"
import { ExplainPanel } from "./ExplainPanel.tsx"
import { explainTarget, missingRatesLine, mismatchCause, type ExplainTarget, type Metric, type TotalMetric } from "../core/explain.ts"
import {
  AVERAGE_PRICE_PAID,
  BALANCE_CHECK,
  CHECK_LABELS,
  DEMO_NOTICE,
  ETH_NOTE,
  HOLD_ETH,
  HOLD_PAST,
  HOLD_TITLE,
  HOLD_WALLET,
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
  holdCaveatSentence,
  holdDifferenceSentence,
  linkedFailedSentence,
  networkFeeUnknownSentence,
  withheldSentence,
  staleSentence,
  unseenEthCause,
} from "../core/wording.ts"
import { PnlChart } from "./PnlChart.tsx"
import { ResolvePanel } from "./ResolvePanel.tsx"
import { useBook, useOtherWallets } from "./useBook.ts"
import { RulesPanel } from "./RulesPanel.tsx"
import { useRules } from "./useRules.ts"
import { TaxPanel } from "./TaxPanel.tsx"
import { useWallet } from "./useWallet.ts"
import { linkedWallets, walletsBehind } from "../core/book.ts"
import { parseDeviceLink, type DeviceLink } from "../core/device-link.ts"
import { exportCsv } from "../core/export.ts"
import { foldBook } from "../core/resolve.ts"

// Only loads when someone asks for it, so looking at a wallet never pulls in any device code.
const DevicePanel = lazy(() => import("./DevicePanel.tsx").then((m) => ({ default: m.DevicePanel })))

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

const est = (text: string, isEstimate: boolean) => (isEstimate ? `≈${text}` : text)

function Holdings({ positions, currency, resolvable, explain, onResolve }: { positions: Position[]; currency: CurrencyCode; resolvable: ReadonlySet<string>; explain: (target: ExplainTarget) => void; onResolve: (asset: string) => void }) {
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
                          {values.averageCostMicros ? est(formatPrice(values.averageCostMicros, currency), position.estimates.cost) : "⚠ Unknown"}
                        </Num>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="num">
                      {held ? (
                        <Num label={`${asset} value`} onClick={open(position, "value")} tone={values.valueMicros === null ? "warn" : null}>
                          {values.valueMicros ? est(money(values.valueMicros), position.estimates.value) : "⚠ No price"}
                        </Num>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="num" title={REALIZED_HELP}>
                      <Num label={`${asset} realized PnL`} onClick={open(position, "realized")} tone={toneOf(values.realizedMicros)}>
                        {values.realizedMicros === null ? `⚠ ${PNL_UNAVAILABLE}` : est(signed(values.realizedMicros), position.estimates.realized)}
                      </Num>
                    </td>
                    <td className="num" title={UNREALIZED_HELP}>
                      {held ? (
                        <>
                          <Num label={`${asset} unrealized PnL`} onClick={open(position, "unrealized")} tone={toneOf(values.unrealizedMicros)}>
                            {values.unrealizedMicros === null ? `⚠ ${PNL_UNAVAILABLE}` : est(signed(values.unrealizedMicros), position.estimates.unrealized)}
                          </Num>
                          {unknown && resolvable.has(asset) ? (
                            <button type="button" className="resolve-button" aria-label={`Resolve ${asset}`} onClick={() => onResolve(asset)}>
                              Resolve
                            </button>
                          ) : null}
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                  {mismatch ? (
                    <tr className="mismatch">
                      <td colSpan={7}>
                        Worked out {formatAmount(mismatch.computedQty, decimals)} · Actual {formatAmount(mismatch.actualQty, decimals)} · Difference {formatSignedAmount(mismatch.differenceQty, decimals)} {asset}. {mismatchCause(asset, mismatch.differenceQty)}
                        {mismatch.unseenEth ? ` ${unseenEthCause(mismatch.unseenEth)}` : null}
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
  const [taxOpen, setTaxOpen] = useState(false)
  const [chosenCurrency, setChosenCurrency] = useState<CurrencyCode>(readCurrency)
  const { rules, chosen: chosenRule, choose: chooseRule } = useRules()
  const { wallet, loading, error } = useWallet(address, chosenCurrency, chosenRule)
  const { book, change, undo, canUndo, linkAccounts } = useBook()
  const [device, setDevice] = useState<{ link: DeviceLink | null } | null>(() => {
    const link = parseDeviceLink(window.location.search)
    return link ? { link } : null
  })
  const [resolving, setResolving] = useState<{ asset: string | null } | null>(null)
  const [cardSender, setCardSender] = useState<string | null>(null)
  const wanted = useMemo(() => [...new Set([...linkedWallets(book), ...(cardSender ? [cardSender] : [])])].filter((a) => a !== wallet?.address), [book, cardSender, wallet?.address])
  const { others, failed, retry } = useOtherWallets(wanted, chosenCurrency, chosenRule, wallet?.latest.blockNum ?? null, wallet)
  const linkedFailed = useMemo(() => (wallet ? failed.filter((address) => walletsBehind(book, wallet).includes(address)) : []), [failed, book, wallet])

  useEffect(() => {
    const onPop = () => {
      setAddress(readAddress())
      setTarget(null)
      setTaxOpen(false)
    }
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  const go = (next: string) => {
    window.history.pushState(null, "", `?address=${next}`)
    setAddress(next)
    setTarget(null)
    setTaxOpen(false)
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

  const fold = useMemo(() => (wallet ? foldBook(wallet, others, method, book) : null), [wallet, others, method, book])
  const view = fold?.view ?? null
  // Whatever's on screen says what it's in, which for a moment after a change isn't what was just chosen.
  const currency = view?.currency ?? chosenCurrency
  const positions = fold?.positions ?? []
  const unread = fold?.unread ?? []
  const totals = fold?.totals ?? sumTotals([])
  const points = fold?.points ?? []
  const questions = fold?.questions ?? []
  const resolvable = useMemo(() => new Set(questions.flatMap((q) => q.arrivals.map((a) => a.asset))), [questions])
  const listed = positions.filter((p) => !p.noMarket)
  const noMarketCount = totals.noMarket.length + (wallet?.unlisted.length ?? 0)
  const caveat = [BigInt(totals.unresolvedMicros) > 0n ? `${formatMoney(totals.unresolvedMicros, currency)} cost unknown` : null, BigInt(totals.estimatedMicros) > 0n ? `${formatMoney(totals.estimatedMicros, currency)} estimated` : null].filter(Boolean).join(" · ")
  const download = () => {
    const link = document.createElement("a")
    link.href = URL.createObjectURL(new Blob([exportCsv(positions, currency)], { type: "text/csv" }))
    link.download = `patina-${wallet?.address}.csv`
    link.click()
    URL.revokeObjectURL(link.href)
  }
  // Worked out from what's on screen, so it can't go on showing numbers that have since changed, or that are in another currency.
  const explanation = useMemo(() => {
    if (!target || !fold || !wallet) return null
    const usd = fold.view.currency === "USD" ? null : foldBook(wallet, others, method, book, { usd: true })
    return explainTarget(target, fold, { view: fold.view, ruleNote: wallet.ruleNote ?? null, source: usd && { positions: usd.positions, totals: usd.totals, points: usd.points, holdComparison: usd.holdComparison } })
  }, [target, fold, wallet, others, method, book])
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
        <button type="button" onClick={() => setDevice({ link: null })}>
          Hardware wallet
        </button>
        {wallet ? <LiveBadge wallet={wallet} stale={error !== null} /> : null}
      </header>
      {inputError ? <p className="notice warn">⚠ {inputError}</p> : null}
      {rules.length > 1 ? <RulesPanel rules={rules} chosen={chosenRule} choose={chooseRule} current={wallet?.rule ?? null} address={address} method={method} currency={currency} book={book} /> : null}

      {!address ? (
        <section className="empty">
          <h1>Every transfer gets a price.</h1>
          <p>Paste a Base address to see its holdings, cost and <span title={PNL_HELP}>PnL</span>, with every number explained. There are no keys here. Looking is all it does until you connect a hardware wallet, which signs everything on its own screen.</p>
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
            <p className="notice warn">⚠ {hasStarted(wallet) ? behindSentence(msBetweenBlocks(wallet.coverage.toBlock, wallet.latest.blockNum)) : NOT_STARTED}</p>
          ) : null}
          {wallet.mode === "demo" ? <p className="notice">{DEMO_NOTICE}</p> : null}
          {hasStarted(wallet) ? <p className="notice">{coverageSentence(wallet.coverage, TOKENS.length - 1, wallet.openingUnread.length > 0)}</p> : null}
          {wallet.gasUnknownTxs.length > 0 ? <p className="notice warn">⚠ {feesUnknownSentence(wallet.gasUnknownTxs.length)}</p> : null}
          {linkedFailed.length > 0 ? (
            <p className="notice warn">
              ⚠ {linkedFailedSentence(linkedFailed.length)}{" "}
              <button type="button" className="link" onClick={retry}>
                Try again
              </button>
            </p>
          ) : null}
          {fold?.withheld.map(({ wallet: from, asset }) => <p className="notice warn" key={`${from}:${asset}`}>⚠ {withheldSentence(from, asset)}</p>)}
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
                    <span className="big">{totals.pnlMicros === null ? `⚠ ${PNL_UNAVAILABLE}` : est(formatSignedMoney(totals.pnlMicros, currency), BigInt(totals.estimatedMicros) > 0n)}</span>
                  </Num>
                  {caveat ? <p className="caveat">{caveat}</p> : null}
                  {questions.length > 0 ? (
                    <button type="button" className="resolve-button big" onClick={() => setResolving({ asset: null })}>
                      Resolve {questions.length}
                    </button>
                  ) : null}
                  {totals.excluded.length > 0 ? (
                    <p className="excluded">⚠ {excludedSentence(totals.excluded)}</p>
                  ) : (
                    <p className="muted small">Nothing excluded.</p>
                  )}
                  {totals.unpricedGas ? <p className="excluded">⚠ {UNPRICED_FEES}</p> : null}
                </div>
                <dl className="stats">
                  <Stat label="Value" onClick={() => openTotal("value")} coverage={totals.coverage.value} value={totals.valueMicros && est(formatMoney(totals.valueMicros, currency), totals.estimated.value)} />
                  <Stat label="Realized" help={REALIZED_HELP} onClick={() => openTotal("realized")} coverage={totals.coverage.realized} value={totals.realizedMicros && est(formatSignedMoney(totals.realizedMicros, currency), totals.estimated.realized)} />
                  <Stat label="Unrealized" help={UNREALIZED_HELP} onClick={() => openTotal("unrealized")} coverage={totals.coverage.unrealized} value={totals.unrealizedMicros && est(formatSignedMoney(totals.unrealizedMicros, currency), totals.estimated.unrealized)} />
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
              <p className="tax-link">
                <button type="button" className="link" onClick={() => setTaxOpen(true)}>
                  Export a tax report…
                </button>
              </p>
              {fold ? <HoldCard comparison={fold.holdComparison} currency={currency} onOpen={() => setTarget({ kind: "hold" })} /> : null}
              <PnlChart points={points} currency={currency} onSelect={(point) => setTarget({ kind: "tx", txHash: point.txHash as string })} />
              {listed.length > 0 ? <Holdings positions={listed} currency={currency} resolvable={resolvable} explain={setTarget} onResolve={(asset) => setResolving({ asset })} /> : null}
              {noMarketCount > 0 ? (
                <p className="notice">
                  {noMarketCount} {noMarketCount === 1 ? "token" : "tokens"} with no market{totals.noMarket.length > 0 ? `: ${totals.noMarket.join(", ")}` : ""}
                  {wallet.unlisted.length > 0 ? `${totals.noMarket.length > 0 ? ", plus" : ":"} ${wallet.unlisted.length} we don't track` : ""}. Often spam, and not counted in any total.
                </p>
              ) : null}
              <p>
                <button type="button" className="link" onClick={download}>
                  Export as CSV
                </button>
              </p>
            </>
          )}
        </main>
      ) : null}

      {explanation && wallet ? <ExplainPanel explanation={explanation} address={wallet.address} rule={wallet.rule ?? null} onClose={close} /> : null}
      {resolving && wallet ? <ResolvePanel wallet={wallet} others={others} failed={failed} onRetry={retry} method={method} book={book} firstAsset={resolving.asset} onChange={change} onUndo={undo} canUndo={canUndo} onPublish={(link) => setDevice({ link })} onCurrentSender={setCardSender} onClose={() => setResolving(null)} /> : null}
      {device ? (
        <Suspense fallback={null}>
          <DevicePanel
            link={device.link}
            book={book}
            currency={chosenCurrency}
            onLink={linkAccounts}
            onView={(next) => {
              setDevice(null)
              go(next)
            }}
            onClose={() => {
              // A link has done its job, and reloading shouldn't start it over.
              if (parseDeviceLink(window.location.search)) window.history.replaceState(null, "", window.location.pathname)
              setDevice(null)
            }}
          />
        </Suspense>
      ) : null}
      {taxOpen && address ? <TaxPanel address={address} currency={chosenCurrency} book={book} onClose={() => setTaxOpen(false)} /> : null}
    </div>
  )
}

/** Calm on purpose: no colors for ahead or behind, and it asks nothing of anyone. Clicking it says how it's worked out. */
function HoldCard({ comparison, currency, onOpen }: { comparison: HoldComparison; currency: CurrencyCode; onOpen: () => void }) {
  const { walletMicros, walletLeavesOut, walletEstimated, holdMicros, differenceMicros, status, estimated } = comparison
  const caveat = holdCaveatSentence(comparison, currency)
  const signed = (micros: string | null, isEstimate: boolean) => (micros === null ? "⚠ Unavailable" : est(formatSignedMoney(micros, currency), isEstimate))
  return (
    <section className="card hold">
      <div className="card-head">
        <h2 className="muted small">{HOLD_TITLE} · {currency}</h2>
        <span className="muted small">{HOLD_PAST}</span>
      </div>
      <button type="button" className="hold-numbers" onClick={onOpen} aria-label={`${HOLD_TITLE}. Shows how this is worked out`}>
        <span>
          <span className="muted small">{HOLD_WALLET}</span>
          <strong>{signed(walletMicros, walletEstimated)}</strong>
          {walletMicros !== null && walletLeavesOut ? <span className="partial">⚠ partial</span> : null}
        </span>
        <span>
          <span className="muted small">{HOLD_ETH}</span>
          <strong>{signed(holdMicros, estimated)}</strong>
          {status === "partial" ? <span className="partial">⚠ partial</span> : null}
        </span>
        {differenceMicros !== null ? <span className="hold-difference">{holdDifferenceSentence(differenceMicros, currency, walletEstimated || estimated)}</span> : null}
      </button>
      {caveat ? <p className="caveat">⚠ {caveat}</p> : null}
    </section>
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
