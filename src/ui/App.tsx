import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react"
import { CURRENCIES, MAIN_CURRENCY_CODES, TOKENS, formatAmount, formatMoney, formatPrice, formatReturn, formatSignedAmount, formatSignedMoney, formatTime, hasAnswer, isAddress, isMainCurrency, msBetweenBlocks, normalizeAddress, returnBps, shortHash, sumTotals, type Coverage, type CurrencyCode, type HoldComparison, type Method, type Position } from "@pricetag/sdk/core"
import { hasStarted, isBehind, type WalletResponse } from "../core/api.ts"
import { ALL_YOURS, combinedPortfolioOf, explainAcross, exportCombined, type CombinedPosition, type PositionPart } from "../core/combined.ts"
import { ExplainPanel } from "./ExplainPanel.tsx"
import { firstSort, formatHoldingsSort, parseHoldingsSort, sortHoldings, type HoldingsColumn, type HoldingsSort } from "../core/holdings.ts"
import { explainTarget, missingRatesLine, mismatchCause, type ExplainTarget, type Metric, type TotalMetric } from "../core/explain.ts"
import {
  ALL_YOURS_TITLE,
  AVERAGE_PRICE_PAID,
  BALANCE_CHECK,
  CHECK_LABELS,
  DEMO_NOTICE,
  ETH_NOTE,
  HOLD_ETH,
  HOLD_PAST,
  HOLD_TITLE,
  HOLD_WALLET,
  HOLD_WALLETS,
  METHOD_HELP,
  METHOD_LABELS,
  METHOD_NAME,
  NETWORK_FEES,
  NOT_AN_ADDRESS,
  NOT_STARTED,
  PNL_HELP,
  PNL_UNAVAILABLE,
  READING,
  READING_ALL,
  ANSWER_QUESTIONS,
  REALIZED_HELP,
  RETURN_HELP,
  UNPRICED_FEES,
  UNREALIZED_HELP,
  allYoursFailedSentence,
  allYoursReadingSentence,
  answerQuestionsLabel,
  behindSentence,
  coverageSentence,
  excludedSentence,
  feedDetail,
  feesUnknownSentence,
  holdCaveatSentence,
  holdDifferenceSentence,
  inWallets,
  linkedFailedSentence,
  networkFeeUnknownSentence,
  withheldSentence,
  staleSentence,
  unknownCostIn,
  unseenEthCause,
  walletCount,
} from "../core/wording.ts"
import { PnlChart } from "./PnlChart.tsx"
import { ResolvePanel } from "./ResolvePanel.tsx"
import { useBook, useOtherWallets } from "./useBook.ts"
import { RulesPanel } from "./RulesPanel.tsx"
import { useRules } from "./useRules.ts"
import type { TaxYear } from "../core/tax.ts"
import { TaxPanel } from "./TaxPanel.tsx"
import { useAllYours, useWallet } from "./useWallet.ts"
import { linkedWallets, walletsBehind, yourWallets } from "../core/book.ts"
import { readCheckedAccounts } from "../core/device-accounts.ts"
import { parseDeviceLink, type DeviceLink } from "../core/device-link.ts"
import { exportCsv } from "../core/export.ts"
import { foldBook } from "../core/resolve.ts"

// Only loads when someone asks for it, so looking at a wallet never pulls in any device code.
const DevicePanel = lazy(() => import("./DevicePanel.tsx").then((m) => ({ default: m.DevicePanel })))

function readAddress(): string | null {
  const value = new URLSearchParams(window.location.search).get("address")
  return value && (value === "demo" || value === ALL_YOURS || isAddress(value)) ? value : null
}

const CURRENCY_KEY = "pricetag.currency"
const HOLDINGS_SORT_KEY = "pricetag.holdingsSort"

/** Remembered in this browser, since there are no accounts. USD until it's changed. */
function readCurrency(): CurrencyCode {
  const value = localStorage.getItem(CURRENCY_KEY)
  return isMainCurrency(value) ? value : "USD"
}

function Num({ onClick, label, children, tone }: { onClick: () => void; label: string; children: ReactNode; tone?: "gain" | "loss" | "warn" | null }) {
  return (
    <button type="button" className={`num-button ${tone ?? ""}`} onClick={onClick} aria-label={label}>
      {children}
    </button>
  )
}

const toneOf = (micros: string | null) => (micros === null ? "warn" : BigInt(micros) > 0n ? "gain" : BigInt(micros) < 0n ? "loss" : null)

/** A row of the holdings table, of one wallet or, with `wallets`, several. */
type Holding = Pick<Position, "asset" | "decimals" | "price" | "values" | "reconciliation" | "noMarket" | "estimates"> & { state: Pick<Position["state"], "shortfallQty">; wallets?: PositionPart[] }

const holdingOf = (position: CombinedPosition): Holding => ({ ...position, state: { shortfallQty: position.shortfallQty } })

/** The wallets a holding's parts qualify for. */
const partsWhere = ({ wallets }: Holding, has: (part: PositionPart) => boolean) => (wallets ?? []).filter(has).map(({ wallet }) => wallet)

function OnchainCheck({ position, onClick }: { position: Holding; onClick: () => void }) {
  const status = position.reconciliation?.status
  if (status === "reconciled") return <Num label={`${position.asset} matches its actual balance`} onClick={onClick} tone="gain">✓ {CHECK_LABELS.reconciled}</Num>
  if (status === "incomplete") return <Num label={`${position.asset} doesn't match its actual balance`} onClick={onClick} tone="warn">⚠ {CHECK_LABELS.incomplete}</Num>
  return <Num label={`${position.asset} not checked against its actual balance`} onClick={onClick} tone="warn">⚠ {CHECK_LABELS.unchecked}</Num>
}

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
function ReturnCell({ position, onClick }: { position: Holding; onClick: () => void }) {
  const { asset, values, estimates } = position
  const bps = returnBps(values)
  const text = bps !== null ? est(formatReturn(bps), estimates.unrealized) : values.costMicros === null ? "⚠ Unknown" : values.valueMicros === null ? "⚠ No price" : "—"
  return (
    <Num label={`${asset} return`} onClick={onClick} tone={bps === null ? (text === "—" ? null : "warn") : BigInt(bps) > 0n ? "gain" : BigInt(bps) < 0n ? "loss" : null}>
      {text}
    </Num>
  )
}

function Holdings({ positions, currency, resolvable, explain, onResolve }: { positions: Holding[]; currency: CurrencyCode; resolvable: ReadonlyMap<string, readonly string[]>; explain: (target: ExplainTarget) => void; onResolve: (asset: string) => void }) {
  const open = ({ asset }: Holding, metric: Metric) => () => explain({ kind: "asset", asset, metric })
  const money = (micros: string) => formatMoney(micros, currency)
  const signed = (micros: string) => formatSignedMoney(micros, currency)
  const [sort, setSort] = useState<HoldingsSort>(() => parseHoldingsSort(localStorage.getItem(HOLDINGS_SORT_KEY)))
  const changeSort = (column: HoldingsColumn) => {
    const next = sort.column === column ? { column, descending: !sort.descending } : firstSort(column)
    localStorage.setItem(HOLDINGS_SORT_KEY, formatHoldingsSort(next))
    setSort(next)
  }
  return (
    <section className="card">
      <h2>Holdings</h2>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <SortHeader column="asset" sort={sort} onSort={changeSort} numeric={false}>
                Asset
              </SortHeader>
              <th>{BALANCE_CHECK}</th>
              <SortHeader column="amount" sort={sort} onSort={changeSort}>
                Amount
              </SortHeader>
              <SortHeader column="price" sort={sort} onSort={changeSort}>
                Price
              </SortHeader>
              <SortHeader column="average" sort={sort} onSort={changeSort}>
                {AVERAGE_PRICE_PAID}
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
              const { asset, decimals, values, state } = position
              const held = BigInt(values.qty) > 0n
              const unknown = BigInt(values.unknownCostQty) > 0n
              const mismatch = position.reconciliation?.status === "incomplete" ? position.reconciliation : null
              const flagged = mismatch !== null || BigInt(state.shortfallQty) > 0n
              const heldIn = partsWhere(position, ({ qty }) => BigInt(qty) > 0n)
              const unknownIn = partsWhere(position, ({ unknownCostQty }) => BigInt(unknownCostQty) > 0n)
              const mismatchedIn = partsWhere(position, ({ reconciliation }) => reconciliation === "incomplete")
              const askedIn = position.wallets ? (resolvable.get(asset) ?? []) : []
              return (
                <Fragment key={asset}>
                  <tr className={`${held ? "" : "closed"} ${mismatch ? "mismatched" : ""}`}>
                    <td>
                      <strong>{asset}</strong>
                      {asset === "ETH" ? <span className="muted small"> {ETH_NOTE}</span> : null}
                      {heldIn.length > 0 ? <span className="muted small holding-wallets" title={position.wallets?.map(({ wallet, qty }) => `${shortHash(wallet)}: ${formatAmount(qty, decimals)} ${asset}`).join("\n")}>{inWallets(heldIn)}</span> : null}
                      {unknownIn.length > 0 ? <span className="small holding-wallets warn-text">⚠ {unknownCostIn(unknownIn)}</span> : null}
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
                      {position.price ? (
                        <Num label={`${asset} price`} onClick={open(position, "price")}>
                          {est(formatPrice(position.price.micros, currency), position.estimates.value)}
                        </Num>
                      ) : (
                        <span className="muted">—</span>
                      )}
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
                            <button type="button" className="resolve-button" aria-label={`Answer questions about ${asset}${askedIn.length > 0 ? `, ${inWallets(askedIn).toLowerCase()}` : ""}`} title={askedIn.length > 0 ? inWallets(askedIn) : undefined} onClick={() => onResolve(asset)}>
                              {ANSWER_QUESTIONS}
                            </button>
                          ) : null}
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="num" title={RETURN_HELP}>
                      {held ? <ReturnCell position={position} onClick={open(position, "return")} /> : <span className="muted">—</span>}
                    </td>
                  </tr>
                  {mismatch ? (
                    <tr className="mismatch">
                      <td colSpan={9}>
                        {mismatchedIn.length > 0 ? `${inWallets(mismatchedIn)}. ` : null}Worked out {formatAmount(mismatch.computedQty, decimals)} · Actual {formatAmount(mismatch.actualQty, decimals)} · Difference {formatSignedAmount(mismatch.differenceQty, decimals)} {asset}. {mismatchCause(asset, mismatch.differenceQty)}
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
  const [input, setInput] = useState(() => (isAddress(readAddress() ?? "") ? (readAddress() as string) : ""))
  const [inputError, setInputError] = useState<string | null>(null)
  const [method, setMethod] = useState<Method>("average")
  const [target, setTarget] = useState<ExplainTarget | null>(null)
  const [taxOpen, setTaxOpen] = useState(false)
  // Not remembered: opening the report starts on the newest year. Coming back from answering keeps the one it was on.
  const [taxYear, setTaxYear] = useState<TaxYear>("latest")
  const [chosenCurrency, setChosenCurrency] = useState<CurrencyCode>(readCurrency)
  const { rules, chosen: chosenRule, choose: chooseRule } = useRules()
  const { book, change, undo, canUndo, linkAccounts } = useBook()
  const [device, setDevice] = useState<{ link: DeviceLink | null } | null>(() => {
    const link = parseDeviceLink(window.location.search)
    return link ? { link } : null
  })
  // Read again whenever the device panel closes, since that's where accounts get checked.
  const yours = useMemo(() => yourWallets(book, readCheckedAccounts().map((account) => account.address)), [book, device])
  // Taking back an answer can leave one wallet, or none, and then there's nothing to add up. It comes back with the next one.
  const isAll = address === ALL_YOURS && yours.length >= 2
  const single = address === ALL_YOURS ? (isAll ? null : (yours[0] ?? null)) : address
  const singleRead = useWallet(single, chosenCurrency, chosenRule)
  const allRead = useAllYours(isAll ? yours : null, chosenCurrency, chosenRule)
  const { wallet } = singleRead
  const { loading, error } = isAll ? allRead : singleRead
  const together = useMemo(() => (isAll && allRead.read && allRead.read.wallets.length > 0 ? { read: allRead.read.wallets, unread: allRead.read.unread } : null), [isAll, allRead.read])
  const [resolving, setResolving] = useState<{ asset: string | null } | null>(null)
  // Another wallet's questions, asked for from a tax report that includes it: they open once it's read, and closing them
  // goes back to the report on the wallet that was showing.
  const [pendingResolve, setPendingResolve] = useState<{ wallet: string; returnTo: string } | null>(null)
  const [returnTo, setReturnTo] = useState<string | null>(null)
  const [cardSender, setCardSender] = useState<string | null>(null)
  const wanted = useMemo(() => (isAll ? [] : [...new Set([...linkedWallets(book), ...(cardSender ? [cardSender] : [])])].filter((a) => a !== wallet?.address)), [isAll, book, cardSender, wallet?.address])
  const { others, failed, retry } = useOtherWallets(wanted, chosenCurrency, chosenRule, wallet?.latest.blockNum ?? null, wallet)
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
    setInput(isAddress(next) ? next : "")
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
    if (isAll || next === wallet?.address.toLowerCase()) {
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
  const combined = useMemo(() => (together ? combinedPortfolioOf(together.read, method, book, together.unread) : null), [together, method, book])
  const view = fold?.view ?? null
  // What's on screen, whether that's one wallet or all of them.
  const showing = combined ?? wallet
  const started = together ? together.read.some(hasStarted) : wallet !== null && hasStarted(wallet)
  const rule = (together?.read[0] ?? wallet)?.rule ?? null
  // Whatever's on screen says what it's in, which for a moment after a change isn't what was just chosen.
  const currency = combined?.currency ?? view?.currency ?? chosenCurrency
  const positions: Holding[] = useMemo(() => combined?.positions.map(holdingOf) ?? fold?.positions ?? [], [combined, fold])
  const unread = combined?.unreadAssets ?? fold?.unread ?? []
  const totals = combined?.totals ?? fold?.totals ?? sumTotals([])
  const points = combined?.points ?? fold?.points ?? []
  const questions = combined?.questions ?? fold?.questions ?? []
  const holdComparison = combined?.holdComparison ?? fold?.holdComparison ?? null
  const withheld = combined?.withheld ?? fold?.withheld ?? []
  const missingRateTxs = combined ? (combined.exchange?.missingRateTxs ?? []) : (view?.missingRateTxs ?? [])
  const noCurrentRate = combined ? combined.exchange !== null && combined.exchange.latestRateMicros === null : currency !== "USD" && view !== null && !view.latestRate
  /** Which wallets each asset's questions are about. */
  const resolvable = useMemo(() => {
    const byAsset = new Map<string, string[]>()
    for (const { wallet: where, arrivals } of questions) for (const { asset } of arrivals) byAsset.set(asset, [...new Set([...(byAsset.get(asset) ?? []), where])])
    return byAsset
  }, [questions])
  const listed = positions.filter((p) => !p.noMarket)
  const noMarketCount = totals.noMarket.length + (showing?.unlisted.length ?? 0)
  const caveat = [BigInt(totals.unresolvedMicros) > 0n ? `${formatMoney(totals.unresolvedMicros, currency)} cost unknown` : null, BigInt(totals.estimatedMicros) > 0n ? `${formatMoney(totals.estimatedMicros, currency)} estimated` : null].filter(Boolean).join(" · ")
  const download = () => {
    const link = document.createElement("a")
    link.href = URL.createObjectURL(new Blob([together ? exportCombined(together.read, method, book) : exportCsv(fold?.positions ?? [], currency)], { type: "text/csv" }))
    link.download = `patina-${together ? "all-yours" : wallet?.address}.csv`
    link.click()
    URL.revokeObjectURL(link.href)
  }
  // Worked out from what's on screen, so it can't go on showing numbers that have since changed, or that are in another currency.
  const explanation = useMemo(() => {
    if (!target) return null
    if (together) return explainAcross(together.read, method, target, book, together.unread)
    if (!fold || !wallet) return null
    const usd = fold.view.currency === "USD" ? null : foldBook(wallet, others, method, book, { usd: true })
    return explainTarget(target, fold, { view: fold.view, ruleNote: wallet.ruleNote ?? null, source: usd && { positions: usd.positions, totals: usd.totals, points: usd.points, holdComparison: usd.holdComparison } })
  }, [target, together, fold, wallet, others, method, book])
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
        {yours.length >= 2 ? (
          <label className="currency">
            <span className="muted small">Wallet</span>
            <select value={isAll ? ALL_YOURS : (address?.toLowerCase() ?? "")} onChange={(e) => go(e.target.value)}>
              {address === null ? <option value="">Choose one</option> : null}
              <option value={ALL_YOURS}>
                {ALL_YOURS_TITLE} · {walletCount(yours.length)}
              </option>
              {yours.map((one) => (
                <option key={one} value={one}>
                  {shortHash(one)}
                </option>
              ))}
              {address !== null && address !== ALL_YOURS && !yours.includes(normalizeAddress(address)) ? <option value={address.toLowerCase()}>{address === "demo" ? "Demo wallet" : `Watching ${shortHash(address)}`}</option> : null}
            </select>
          </label>
        ) : null}
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
        {showing ? <LiveBadge wallet={showing} stale={error !== null} updating={(combined?.linkedReading.length ?? 0) > 0} /> : null}
      </header>
      {inputError ? <p className="notice warn">⚠ {inputError}</p> : null}
      {rules.length > 1 ? <RulesPanel rules={rules} chosen={chosenRule} choose={chooseRule} current={rule} address={isAll ? null : single} method={method} currency={currency} book={book} /> : null}

      {!single && !isAll ? (
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
          <p>{isAll ? READING_ALL : READING}</p>
        </section>
      ) : null}

      {!showing && error ? <p className="notice warn">⚠ {error}</p> : null}

      {showing ? (
        <main>
          {error ? <p className="notice warn">⚠ {error} {staleSentence(formatTime(showing.latest.timestamp))}</p> : null}
          {combined && combined.linkedReading.length > 0 ? <p className="notice">{allYoursReadingSentence(combined.linkedReading)}</p> : null}
          {combined && combined.linkedFailed.length > 0 ? (
            <p className="notice warn">
              ⚠ {allYoursFailedSentence(combined.linkedFailed)}{" "}
              <button type="button" className="link" onClick={allRead.retry}>
                Try again
              </button>
            </p>
          ) : null}
          {isBehind(showing) ? (
            <p className="notice warn">⚠ {started ? behindSentence(msBetweenBlocks(showing.coverage.toBlock, showing.latest.blockNum)) : NOT_STARTED}</p>
          ) : null}
          {showing.mode === "demo" ? <p className="notice">{DEMO_NOTICE}</p> : null}
          {started ? <p className="notice">{coverageSentence(showing.coverage, TOKENS.length - 1, showing.openingUnread.length > 0, { combined: isAll })}</p> : null}
          {showing.gasUnknownTxs.length > 0 ? <p className="notice warn">⚠ {feesUnknownSentence(showing.gasUnknownTxs.length)}</p> : null}
          {linkedFailed.length > 0 ? (
            <p className="notice warn">
              ⚠ {linkedFailedSentence(linkedFailed.length)}{" "}
              <button type="button" className="link" onClick={retry}>
                Try again
              </button>
            </p>
          ) : null}
          {withheld.map(({ wallet: from, asset }) => <p className="notice warn" key={`${from}:${asset}`}>⚠ {withheldSentence(from, asset)}</p>)}
          {missingRateTxs.length > 0 ? <p className="notice warn">⚠ {missingRatesLine(missingRateTxs.length, currency)}</p> : null}
          {noCurrentRate ? <p className="notice warn">⚠ There's no current USD to {currency} rate, so what's held has no current value.</p> : null}
          {showing.l1FeeUnknownTxs.length > 0 ? <p className="notice warn" title={PNL_HELP}>⚠ {networkFeeUnknownSentence(showing.l1FeeUnknownTxs.length)}</p> : null}

          {positions.length === 0 && !started ? null : positions.length === 0 && unread.length === 0 ? (
            <section className="empty">
              <p>
                {wallet ? (
                  <>
                    No activity for <code>{wallet.address}</code> in this time.
                  </>
                ) : (
                  "No activity in your wallets in this time."
                )}
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
                      {answerQuestionsLabel(questions.length)}
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
              {holdComparison ? <HoldCard comparison={holdComparison} combined={isAll} currency={currency} onOpen={() => setTarget({ kind: "hold" })} /> : null}
              <PnlChart points={points} currency={currency} onSelect={(point) => setTarget({ kind: "tx", txHash: point.txHash as string })} />
              {listed.length > 0 ? <Holdings positions={listed} currency={currency} resolvable={resolvable} explain={setTarget} onResolve={(asset) => setResolving({ asset })} /> : null}
              {noMarketCount > 0 ? (
                <p className="notice">
                  {noMarketCount} {noMarketCount === 1 ? "token" : "tokens"} with no market{totals.noMarket.length > 0 ? `: ${totals.noMarket.join(", ")}` : ""}
                  {showing.unlisted.length > 0 ? `${totals.noMarket.length > 0 ? ", plus" : ":"} ${showing.unlisted.length} we don't track` : ""}. Often spam, and not counted in any total.
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

      {explanation && showing ? <ExplainPanel explanation={explanation} address={showing.address} rule={rule} onClose={close} /> : null}
      {resolving && together ? <ResolvePanel wallet={together.read[0] as WalletResponse} others={together.read.slice(1)} all={together.unread} failed={together.unread.failed} onRetry={allRead.retry} method={method} book={book} firstAsset={resolving.asset} onChange={change} onUndo={undo} canUndo={canUndo} onPublish={(link) => setDevice({ link })} onCurrentSender={setCardSender} onClose={closeResolve} /> : null}
      {resolving && !together && wallet ? <ResolvePanel wallet={wallet} others={others} failed={failed} onRetry={retry} method={method} book={book} firstAsset={resolving.asset} onChange={change} onUndo={undo} canUndo={canUndo} onPublish={(link) => setDevice({ link })} onCurrentSender={setCardSender} onClose={closeResolve} /> : null}
      {device ? (
        <Suspense fallback={null}>
          <DevicePanel
            link={device.link}
            book={book}
            currency={chosenCurrency}
            allYours={isAll}
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
      {taxOpen && (together || single) ? <TaxPanel
          // All of them is the first with the rest alongside, because the answers say the rest are theirs.
          address={together ? (together.read[0] as WalletResponse).address : (single as string)}
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

/** Calm on purpose: no colors for ahead or behind, and it asks nothing of anyone. Clicking it says how it's worked out. */
function HoldCard({ comparison, combined, currency, onOpen }: { comparison: HoldComparison; combined: boolean; currency: CurrencyCode; onOpen: () => void }) {
  const { walletMicros, walletLeavesOut, walletEstimated, holdMicros, differenceMicros, status, estimated } = comparison
  const caveat = holdCaveatSentence(comparison, currency, { combined })
  const signed = (micros: string | null, isEstimate: boolean) => (micros === null ? "⚠ Unavailable" : est(formatSignedMoney(micros, currency), isEstimate))
  return (
    <section className="card hold">
      <div className="card-head">
        <h2 className="muted small">{HOLD_TITLE} · {currency}</h2>
        <span className="muted small">{HOLD_PAST}</span>
      </div>
      <button type="button" className="hold-numbers" onClick={onOpen} aria-label={`${HOLD_TITLE}. Shows how this is worked out`}>
        <span>
          <span className="muted small">{combined ? HOLD_WALLETS : HOLD_WALLET}</span>
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

function LiveBadge({ wallet, stale, updating }: { wallet: Pick<WalletResponse, "mode" | "coverage" | "latest">; stale: boolean; updating: boolean }) {
  if (wallet.mode === "demo") return <span className="badge">Demo data</span>
  const detail = feedDetail(wallet.mode, wallet.coverage.toBlock)
  if (stale) return <span className="badge warn" title={detail}>⚠ Not updating</span>
  if (updating) return <span className="badge updating" title={detail}>Updating</span>
  if (isBehind(wallet)) return <span className="badge warn" title={detail}>⚠ Catching up</span>
  return <span className="badge live" title={detail}>Live</span>
}
