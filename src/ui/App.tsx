import { Suspense, lazy, useCallback, useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react"
import { CURRENCIES, MAIN_CURRENCY_CODES, TOKENS, formatAmount, formatMoney, formatPrice, formatReturn, formatSignedMoney, formatTime, isAddress, isMainCurrency, msBetweenBlocks, returnBps, sumTotals, type CurrencyCode, type HoldComparison, type Method, type Position } from "@pricetag/sdk/core"
import { hasStarted, isBehind, type WalletResponse } from "../core/api.ts"
import { ExplainPanel } from "./ExplainPanel.tsx"
import { firstSort, formatHoldingsSort, parseHoldingsSort, sortHoldings, type HoldingsColumn, type HoldingsSort } from "../core/holdings.ts"
import { allBalancesMatch, attentionOf, attentionTarget, balanceFlag, isValuePartial, valueGaps, type Attention } from "../core/attention.ts"
import { explainTarget, type ExplainTarget, type Metric, type TotalMetric } from "../core/explain.ts"
import {
  ABOUT_THIS_DATA,
  AVERAGE_PAID,
  DEMO_NOTICE,
  ETH_NOTE,
  HOLD_PAST,
  HOLD_TITLE,
  METHOD_HELP,
  METHOD_LABELS,
  METHOD_NAME,
  NETWORK_FEES,
  NOT_AN_ADDRESS,
  NOT_STARTED,
  NO_PRICE,
  PNL_HELP,
  READING,
  REALIZED_HELP,
  RETURN_HELP,
  SHOW_MISSING,
  UNAVAILABLE,
  UNKNOWN,
  UNREALIZED_HELP,
  answerQuestionsLabel,
  behindSentence,
  coverageSentence,
  feedDetail,
  holdCaveatSentence,
  holdSummarySentence,
  linkedFailedSentence,
  noMarketSentence,
  pnlHelp,
  staleSentence,
  valueGapsSentence,
} from "../core/wording.ts"
import { PnlChart } from "./PnlChart.tsx"
import { ResolvePanel } from "./ResolvePanel.tsx"
import { useBook, useOtherWallets } from "./useBook.ts"
import { RulesPanel } from "./RulesPanel.tsx"
import { useRules } from "./useRules.ts"
import type { TaxYear } from "../core/tax.ts"
import { TaxPanel } from "./TaxPanel.tsx"
import { useWallet } from "./useWallet.ts"
import { currenciesIn, linkedWallets, walletsBehind } from "../core/book.ts"
import { parseDeviceLink, type DeviceLink } from "../core/device-link.ts"
import { exportCsv } from "../core/export.ts"
import { foldBook, type Question } from "../core/resolve.ts"

// Only loads when someone asks for it, so looking at a wallet never pulls in any device code.
const DevicePanel = lazy(() => import("./DevicePanel.tsx").then((m) => ({ default: m.DevicePanel })))

function readAddress(): string | null {
  const value = new URLSearchParams(window.location.search).get("address")
  return value && (value === "demo" || isAddress(value)) ? value : null
}

const CURRENCY_KEY = "pricetag.currency"
const HOLDINGS_SORT_KEY = "pricetag.holdingsSort"

/** Remembered in this browser, since there are no accounts. USD until it's changed. */
function readCurrency(): CurrencyCode {
  const value = localStorage.getItem(CURRENCY_KEY)
  return isMainCurrency(value) ? value : "USD"
}

function Num({ onClick, label, children, tone }: { onClick: () => void; label: string; children: ReactNode; tone?: "gain" | "loss" | "quiet" | null }) {
  return (
    <button type="button" className={`num-button ${tone ?? ""}`} onClick={onClick} aria-label={label}>
      {children}
    </button>
  )
}

// What's unknown says so in gray, and the warning under the headline says it once.
const toneOf = (micros: string | null) => (micros === null ? "quiet" : BigInt(micros) > 0n ? "gain" : BigInt(micros) < 0n ? "loss" : null)

const est = (text: string, isEstimate: boolean) => (isEstimate ? `≈${text}` : text)

/** A header that sorts by its column. Clicking it again turns the order around. */
function SortHeader({ column, sort, onSort, numeric = true, title, children }: { column: HoldingsColumn; sort: HoldingsSort; onSort: (column: HoldingsColumn) => void; numeric?: boolean; title?: string; children: ReactNode }) {
  const active = sort.column === column
  return (
    <th className={numeric ? "num" : ""} title={title} aria-sort={active ? (sort.descending ? "descending" : "ascending") : "none"}>
      <button type="button" className="sort-button" onClick={() => onSort(column)}>
        {children}
        <span className="sort-mark" aria-hidden="true">
          {active ? (sort.descending ? " ↓" : " ↑") : ""}
        </span>
      </button>
    </th>
  )
}

/** Unknown whenever its cost is, never 0%. With a known cost of nothing, there's no share to show. */
function ReturnCell({ position, onClick }: { position: Position; onClick: () => void }) {
  const { asset, values, estimates } = position
  const bps = returnBps(values)
  const text = bps !== null ? est(formatReturn(bps), estimates.unrealized) : values.costMicros === null ? UNKNOWN : values.valueMicros === null ? NO_PRICE : "—"
  return (
    <Num label={`${asset} return`} onClick={onClick} tone={bps === null ? "quiet" : BigInt(bps) > 0n ? "gain" : BigInt(bps) < 0n ? "loss" : null}>
      {text}
    </Num>
  )
}

/** What this covers, for whoever wants to know, one click away from the numbers. */
function AboutData({ lines }: { lines: string[] }) {
  const id = useId()
  return (
    <>
      <button type="button" className="about-button" popoverTarget={id} aria-label={ABOUT_THIS_DATA} title={ABOUT_THIS_DATA}>
        ⓘ
      </button>
      <div id={id} popover="auto" className="about-text small">
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
    </>
  )
}

function Holdings({ positions, unread, about, currency, questions, method, onMethod, explain, onResolve }: { positions: Position[]; unread: readonly string[]; about: string[]; currency: CurrencyCode; questions: readonly Question[]; method: Method; onMethod: (method: Method) => void; explain: (target: ExplainTarget) => void; onResolve: (asset: string) => void }) {
  const open = ({ asset }: Position, metric: Metric) => () => explain({ kind: "asset", asset, metric })
  const money = (micros: string) => formatMoney(micros, currency)
  const signed = (micros: string) => formatSignedMoney(micros, currency)
  const [sort, setSort] = useState<HoldingsSort>(() => parseHoldingsSort(localStorage.getItem(HOLDINGS_SORT_KEY)))
  const changeSort = (column: HoldingsColumn) => {
    const next = sort.column === column ? { column, descending: !sort.descending } : firstSort(column)
    localStorage.setItem(HOLDINGS_SORT_KEY, formatHoldingsSort(next))
    setSort(next)
  }
  const matches = allBalancesMatch(positions, unread)
  const questionsAbout = (asset: string) => questions.filter((q) => q.arrivals.some((a) => a.asset === asset)).length
  return (
    <section className="card">
      <div className="holdings-head">
        <h2>Holdings</h2>
        {matches ? <span className="matches small" title={matches}>✓ <span className="muted">{matches}</span></span> : null}
        <span className="spacer" />
        <label className="cost-method small" title={METHOD_HELP}>
          <span className="muted">Cost:</span>
          <select aria-label={METHOD_NAME} value={method} onChange={(e) => onMethod(e.target.value as Method)}>
            {(["average", "fifo"] as const).map((m) => (
              <option key={m} value={m}>
                {METHOD_LABELS[m]}
              </option>
            ))}
          </select>
        </label>
        {about.length > 0 ? <AboutData lines={about} /> : null}
      </div>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <SortHeader column="asset" sort={sort} onSort={changeSort} numeric={false}>
                Asset
              </SortHeader>
              <SortHeader column="amount" sort={sort} onSort={changeSort}>
                Amount
              </SortHeader>
              <SortHeader column="price" sort={sort} onSort={changeSort}>
                Price
              </SortHeader>
              <SortHeader column="average" sort={sort} onSort={changeSort}>
                {AVERAGE_PAID}
              </SortHeader>
              <SortHeader column="value" sort={sort} onSort={changeSort}>
                Value
              </SortHeader>
              <SortHeader column="realized" sort={sort} onSort={changeSort} title={REALIZED_HELP}>
                Realized
              </SortHeader>
              <SortHeader column="unrealized" sort={sort} onSort={changeSort} title={UNREALIZED_HELP}>
                Unrealized
              </SortHeader>
              <SortHeader column="return" sort={sort} onSort={changeSort} title={RETURN_HELP}>
                Return
              </SortHeader>
            </tr>
          </thead>
          <tbody>
            {sortHoldings(positions, sort).map((position) => {
              const { asset, decimals, values } = position
              const held = BigInt(values.qty) > 0n
              const unknown = BigInt(values.unknownCostQty) > 0n
              const flag = balanceFlag(position)
              const askable = held && unknown ? questionsAbout(asset) : 0
              return (
                <tr key={asset} className={held ? "" : "closed"}>
                  <td>
                    <strong>{asset}</strong>
                    {asset === "ETH" ? <span className="muted small"> {ETH_NOTE}</span> : null}
                    {/* Once per row, however many of its numbers it affects. */}
                    {flag ? (
                      <button type="button" className="row-flag" title={flag.help} aria-label={`${asset}: ${flag.label}`} onClick={open(position, flag.metric)}>
                        ⚠
                      </button>
                    ) : null}
                  </td>
                  <td className="num">
                    <Num label={`${asset} amount`} onClick={open(position, "amount")}>
                      {formatAmount(values.qty, decimals)}
                    </Num>
                  </td>
                  <td className="num">
                    {position.price ? (
                      <Num label={`${asset} price`} onClick={open(position, "price")}>
                        {est(formatPrice(position.price.micros, currency), position.estimates.value)}
                      </Num>
                    ) : (
                      <span className="muted">{NO_PRICE}</span>
                    )}
                  </td>
                  <td className="num">
                    {held ? (
                      <Num label={`${asset} ${AVERAGE_PAID.toLowerCase()}`} onClick={open(position, "average")} tone={unknown ? "quiet" : null}>
                        {values.averageCostMicros ? est(formatPrice(values.averageCostMicros, currency), position.estimates.cost) : UNKNOWN}
                      </Num>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="num">
                    {held ? (
                      <Num label={`${asset} value`} onClick={open(position, "value")} tone={values.valueMicros === null ? "quiet" : null}>
                        {values.valueMicros ? est(money(values.valueMicros), position.estimates.value) : NO_PRICE}
                      </Num>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="num" title={REALIZED_HELP}>
                    <Num label={`${asset} realized PnL`} onClick={open(position, "realized")} tone={toneOf(values.realizedMicros)}>
                      {values.realizedMicros === null ? UNKNOWN : est(signed(values.realizedMicros), position.estimates.realized)}
                    </Num>
                  </td>
                  <td className="num" title={UNREALIZED_HELP}>
                    {held ? (
                      <>
                        {askable > 0 ? (
                          <button type="button" className="row-action" title={`${answerQuestionsLabel(askable)} about ${asset}, so what you paid is known`} aria-label={`${answerQuestionsLabel(askable)} about ${asset}`} onClick={() => onResolve(asset)}>
                            ?
                          </button>
                        ) : null}
                        <Num label={`${asset} unrealized PnL`} onClick={open(position, "unrealized")} tone={toneOf(values.unrealizedMicros)}>
                          {values.unrealizedMicros === null ? UNKNOWN : est(signed(values.unrealizedMicros), position.estimates.unrealized)}
                        </Num>
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="num" title={RETURN_HELP}>
                    {held ? <ReturnCell position={position} onClick={open(position, "return")} /> : <span className="muted">—</span>}
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
  const [target, setTarget] = useState<ExplainTarget | null>(null)
  const [taxOpen, setTaxOpen] = useState(false)
  // Not remembered: opening the report starts on the newest year. Coming back from answering keeps the one it was on.
  const [taxYear, setTaxYear] = useState<TaxYear>("latest")
  const [chosenCurrency, setChosenCurrency] = useState<CurrencyCode>(readCurrency)
  const { rules, chosen: chosenRule, choose: chooseRule } = useRules()
  const { book, change, undo, canUndo, linkAccounts } = useBook()
  const paidIn = currenciesIn(book).filter((code) => code !== "USD").join(",")
  const { wallet, loading, error } = useWallet(address, chosenCurrency, chosenRule, paidIn)
  const [device, setDevice] = useState<{ link: DeviceLink | null } | null>(() => {
    const link = parseDeviceLink(window.location.search)
    return link ? { link } : null
  })
  const [resolving, setResolving] = useState<{ asset: string | null } | null>(null)
  // Another wallet's questions, asked for from a tax report that includes it: they open once it's read, and closing them
  // goes back to the report on the wallet that was showing.
  const [pendingResolve, setPendingResolve] = useState<{ wallet: string; returnTo: string } | null>(null)
  const [returnTo, setReturnTo] = useState<string | null>(null)
  const [cardSender, setCardSender] = useState<string | null>(null)
  const wanted = useMemo(() => [...new Set([...linkedWallets(book), ...(cardSender ? [cardSender] : [])])].filter((a) => a !== wallet?.address), [book, cardSender, wallet?.address])
  const { others, failed, retry } = useOtherWallets(wanted, chosenCurrency, chosenRule, paidIn, wallet?.latest.blockNum ?? null, wallet)
  const linkedFailed = useMemo(() => (wallet ? failed.filter((address) => walletsBehind(book, wallet).includes(address)) : []), [failed, book, wallet])

  useEffect(() => {
    const onPop = () => {
      setPendingResolve(null)
      setReturnTo(null)
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

  useEffect(() => {
    if (!pendingResolve || wallet?.address.toLowerCase() !== pendingResolve.wallet) return
    setReturnTo(pendingResolve.returnTo)
    setPendingResolve(null)
    setResolving({ asset: null })
  }, [pendingResolve, wallet])

  const resolveFromTax = (next: string) => {
    if (next === wallet?.address.toLowerCase()) {
      setTaxOpen(false)
      setResolving({ asset: null })
    } else if (address) {
      setPendingResolve({ wallet: next, returnTo: address })
      go(next)
    }
  }
  const closeResolve = () => {
    setResolving(null)
    if (returnTo === null) return
    setReturnTo(null)
    go(returnTo)
    setTaxOpen(true)
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
  const listed = positions.filter((p) => !p.noMarket)
  const attention = fold && wallet ? attentionOf({ positions, unread, totals, pnlStatus: fold.pnlStatus, gasUnknownTxs: wallet.gasUnknownTxs, l1FeeUnknownTxs: wallet.l1FeeUnknownTxs, withheld: fold.withheld, currency, missingRateTxs: fold.view.missingRateTxs, hasCurrentRate: currency === "USD" || fold.view.latestRate !== null }) : null
  const attentionBox = attention ? <AttentionBox attention={attention} questionCount={questions.length} onResolve={() => setResolving({ asset: null })} onShow={() => setTarget(attentionTarget(positions))} /> : null
  const noMarket = wallet ? noMarketSentence(totals.noMarket, wallet.unlisted.length) : null
  const about = wallet ? [...(hasStarted(wallet) ? [coverageSentence(wallet.coverage, TOKENS.length - 1, wallet.openingUnread.length > 0)] : []), ...(noMarket ? [noMarket] : [])] : []
  // With no table to sit beside, what it covers stays on the page.
  const aboutNotices = about.map((line) => <p className="notice" key={line}>{line}</p>)
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
            {MAIN_CURRENCY_CODES.map((code) => (
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
          {linkedFailed.length > 0 ? (
            <p className="notice warn">
              ⚠ {linkedFailedSentence(linkedFailed.length)}{" "}
              <button type="button" className="link" onClick={retry}>
                Try again
              </button>
            </p>
          ) : null}

          {positions.length === 0 && !hasStarted(wallet) ? attentionBox : positions.length === 0 && unread.length === 0 ? (
            <>
              {aboutNotices}
              {attentionBox}
              <section className="empty">
                <p>
                  No activity for <code>{wallet.address}</code> in this time.
                </p>
              </section>
            </>
          ) : (
            <>
              <section className="summary">
                <div className="lead">
                  <div title={isValuePartial(totals) ? valueGapsSentence(valueGaps(positions, unread)) : undefined}>
                    <span className="muted small">Value · {currency}</span>
                    <Num label={`Value${isValuePartial(totals) ? ", partial" : ""}`} onClick={() => openTotal("value")} tone={totals.valueMicros === null ? "quiet" : null}>
                      <span className="big">{totals.valueMicros === null ? UNAVAILABLE : est(formatMoney(totals.valueMicros, currency), totals.estimated.value)}</span>
                    </Num>
                  </div>
                  <div>
                    <span className="muted small" title={PNL_HELP}>
                      Total PnL
                    </span>
                    <Num label={`Total PnL${fold?.pnlStatus === "partial" ? ", partial" : ""}`} onClick={() => openTotal("pnl")} tone={toneOf(totals.pnlMicros)}>
                      <span className="second">{totals.pnlMicros === null ? UNAVAILABLE : est(formatSignedMoney(totals.pnlMicros, currency), BigInt(totals.estimatedMicros) > 0n)}</span>
                    </Num>
                  </div>
                </div>
                <dl className="stats">
                  <Stat label="Realized" help={REALIZED_HELP} partial={totals.coverage.realized.missing > 0} onClick={() => openTotal("realized")} value={totals.realizedMicros && est(formatSignedMoney(totals.realizedMicros, currency), totals.estimated.realized)} />
                  <Stat label="Unrealized" help={UNREALIZED_HELP} partial={totals.coverage.unrealized.missing > 0} onClick={() => openTotal("unrealized")} value={totals.unrealizedMicros && est(formatSignedMoney(totals.unrealizedMicros, currency), totals.estimated.unrealized)} />
                  <Stat label={NETWORK_FEES} partial={totals.unpricedGas} onClick={() => openTotal("gas")} value={totals.gasMicros && formatMoney(totals.gasMicros, currency)} />
                </dl>
              </section>
              {attentionBox}
              <PnlChart points={points} currency={currency} onSelect={(point) => setTarget({ kind: "tx", txHash: point.txHash as string })} />
              {listed.length > 0 ? <Holdings positions={listed} unread={unread} about={about} currency={currency} questions={questions} method={method} onMethod={setMethod} explain={setTarget} onResolve={(asset) => setResolving({ asset })} /> : aboutNotices}
              {fold ? <HoldLine comparison={fold.holdComparison} currency={currency} onOpen={() => setTarget({ kind: "hold" })} /> : null}
              <p className="exports">
                <button type="button" className="link" onClick={download}>
                  Export as CSV
                </button>
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setTaxYear("latest")
                    setTaxOpen(true)
                  }}
                >
                  Export a tax report…
                </button>
              </p>
            </>
          )}
        </main>
      ) : null}

      {explanation && wallet ? <ExplainPanel explanation={explanation} address={wallet.address} rule={wallet.rule ?? null} onClose={close} /> : null}
      {resolving && wallet ? <ResolvePanel wallet={wallet} others={others} failed={failed} onRetry={retry} method={method} book={book} firstAsset={resolving.asset} onChange={change} onUndo={undo} canUndo={canUndo} onPublish={(link) => setDevice({ link })} onCurrentSender={setCardSender} onClose={closeResolve} /> : null}
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
      {taxOpen && address ? <TaxPanel
          address={address}
          currency={chosenCurrency}
          book={book}
          year={taxYear}
          onYear={setTaxYear}
          overviewMethod={method}
          questionCount={questions.length}
          onResolve={resolveFromTax}
          onClose={() => setTaxOpen(false)}
        /> : null}
    </div>
  )
}

/** What the numbers above leave out, once, in a sentence, with what to do about it. The full list is a hover or a click away. */
function AttentionBox({ attention, questionCount, onResolve, onShow }: { attention: Attention; questionCount: number; onResolve: () => void; onShow: () => void }) {
  return (
    <section className="attention" title={attention.fullList ?? undefined}>
      <span className="attention-mark" role="img" aria-label="Warning">⚠</span>
      <div className="attention-text">
        <p title={pnlHelp(attention.title)}>{attention.title}</p>
        {attention.details.map((line) => (
          <p key={line} className="muted small" title={pnlHelp(line)}>
            {line}
          </p>
        ))}
      </div>
      {questionCount > 0 ? (
        <button type="button" className="quiet-button" onClick={onResolve}>
          {answerQuestionsLabel(questionCount)}
        </button>
      ) : (
        <button type="button" className="quiet-button" onClick={onShow}>
          {SHOW_MISSING}
        </button>
      )}
    </section>
  )
}

/** This wallet next to simply holding ETH, in a line. Calm on purpose: no colors for ahead or behind, and it asks nothing of anyone. Clicking it shows the numbers and how they're worked out. */
function HoldLine({ comparison, currency, onOpen }: { comparison: HoldComparison; currency: CurrencyCode; onOpen: () => void }) {
  // The fine print, a hover or a click away.
  const fine = [holdCaveatSentence(comparison, currency), comparison.status === "unavailable" ? null : HOLD_PAST].filter((part) => part !== null).join(" ")
  return (
    <button type="button" className="hold-line" title={fine} aria-label={`${HOLD_TITLE}. ${holdSummarySentence(comparison, currency)} Shows how this is worked out`} onClick={onOpen}>
      <span>{HOLD_TITLE}</span>
      <span className="muted">{holdSummarySentence(comparison, currency)}</span>
      <span className="muted" aria-hidden="true">›</span>
    </button>
  )
}

/** One of the sums beside the headline. What it leaves out is said once, under the headline. */
function Stat({ label, help, partial, onClick, value }: { label: string; help?: string; partial: boolean; onClick: () => void; value: string | null }) {
  return (
    <div>
      <dt className="muted small" title={help}>
        {label}
      </dt>
      <dd>
        <Num label={`${label}${value !== null && partial ? ", partial" : ""}`} onClick={onClick} tone={value === null ? "quiet" : null}>
          {value ?? UNAVAILABLE}
        </Num>
      </dd>
    </div>
  )
}

function LiveBadge({ wallet, stale }: { wallet: WalletResponse; stale: boolean }) {
  if (wallet.mode === "demo") return <span className="badge">Demo data</span>
  const detail = feedDetail(wallet.mode, wallet.coverage.toBlock)
  // The notice under it says what's wrong.
  if (stale) return <span className="badge" title={detail}>Not updating</span>
  if (isBehind(wallet)) return <span className="badge" title={detail}>Catching up</span>
  return <span className="badge live" title={detail}>Live</span>
}
