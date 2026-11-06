import { Suspense, lazy, useCallback, useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react"
import { CURRENCIES, MAIN_CURRENCY_CODES, TOKENS, formatAmount, formatMoney, formatPrice, formatReturn, formatSignedMoney, formatTime, isAddress, isMainCurrency, msBetweenBlocks, normalizeAddress, returnBps, shortHash, sumTotals, type CurrencyCode, type HoldComparison, type Method, type Position } from "@pricetag/sdk/core"
import { hasStarted, isBehind, type WalletResponse } from "../core/api.ts"
import { ALL_YOURS, combinedPortfolioOf, explainAcross, exportCombined, type CombinedPosition, type PositionPart } from "../core/combined.ts"
import { ExplainPanel } from "./ExplainPanel.tsx"
import { firstSort, formatHoldingsSort, parseHoldingsSort, sortHoldings, type HoldingsColumn, type HoldingsSort } from "../core/holdings.ts"
import { allBalancesMatch, attentionOf, attentionTarget, balanceFlag, isValuePartial, pastCostsNote, valueGaps, type Attention } from "../core/attention.ts"
import { explainTarget, type ExplainTarget, type Metric, type TotalMetric } from "../core/explain.ts"
import {
  ABOUT_THIS_DATA,
  ALL_YOURS_TITLE,
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
  READING_ALL,
  REALIZED_HELP,
  RETURN_HELP,
  SHOW_MISSING,
  UNAVAILABLE,
  UNKNOWN,
  UNREALIZED_HELP,
  allYoursFailedSentence,
  allYoursReadingSentence,
  answerQuestionsLabel,
  behindSentence,
  coverageSentence,
  feedDetail,
  holdCaveatSentence,
  feedProblem,
  holdSummarySentence,
  inWallets,
  linkedFailedSentence,
  NOT_SAVED,
  noMarketSentence,
  pnlHelp,
  staleSentence,
  unknownCostIn,
  valueGapsSentence,
  walletCount,
  est,
} from "../core/wording.ts"
import { PnlChart } from "./PnlChart.tsx"
import { ResolvePanel } from "./ResolvePanel.tsx"
import { useBook, useOtherWallets } from "./useBook.ts"
import { RulesPanel } from "./RulesPanel.tsx"
import { useRules } from "./useRules.ts"
import type { TaxYear } from "../core/tax.ts"
import { TaxPanel } from "./TaxPanel.tsx"
import { useAllYours, useWallet } from "./useWallet.ts"
import { ProblemNotice } from "./ProblemNotice.tsx"
import { currenciesIn, walletsBehind, walletsToRead, yourWallets } from "../core/book.ts"
import { readCheckedAccounts } from "../core/device-accounts.ts"
import { parseDeviceLink, type DeviceLink } from "../core/device-link.ts"
import { exportCsv } from "../core/export.ts"
import { foldBook, type Question } from "../core/resolve.ts"
import { PurchaseList } from "./PurchaseList.tsx"
import { usePurchases } from "./usePurchases.ts"

// Only loads when someone asks for it, so looking at a wallet never pulls in any device code.
const DevicePanel = lazy(() => import("./DevicePanel.tsx").then((m) => ({ default: m.DevicePanel })))
const BuyPanel = lazy(() => import("./BuyPanel.tsx").then((m) => ({ default: m.BuyPanel })))

function readAddress(): string | null {
  const value = new URLSearchParams(window.location.search).get("address")
  return value && (value === "demo" || value === ALL_YOURS || isAddress(value)) ? value : null
}

const NONE: readonly string[] = []

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

/** A row of the holdings table, of one wallet or, with `wallets`, several. */
type Holding = Pick<Position, "asset" | "decimals" | "price" | "values" | "reconciliation" | "noMarket" | "estimates"> & { state: Pick<Position["state"], "shortfallQty">; wallets?: PositionPart[] }

const holdingOf = (position: CombinedPosition): Holding => ({ ...position, state: { shortfallQty: position.shortfallQty } })

/** The wallets a holding's parts qualify for. */
const partsWhere = ({ wallets }: Holding, has: (part: PositionPart) => boolean) => (wallets ?? []).filter(has).map(({ wallet }) => wallet)


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

function Holdings({ positions, unread, about, currency, questions, method, onMethod, explain, onResolve }: { positions: Holding[]; unread: readonly string[]; about: string[]; currency: CurrencyCode; questions: readonly Question[]; method: Method; onMethod: (method: Method) => void; explain: (target: ExplainTarget) => void; onResolve: (asset: string) => void }) {
  const open = ({ asset }: Holding, metric: Metric) => () => explain({ kind: "asset", asset, metric })
  const money = (micros: string) => formatMoney(micros, currency)
  const signed = (micros: string) => formatSignedMoney(micros, currency)
  const [sort, setSort] = useState<HoldingsSort>(() => parseHoldingsSort(localStorage.getItem(HOLDINGS_SORT_KEY)))
  const changeSort = (column: HoldingsColumn) => {
    const next = sort.column === column ? { column, descending: !sort.descending } : firstSort(column)
    localStorage.setItem(HOLDINGS_SORT_KEY, formatHoldingsSort(next))
    setSort(next)
  }
  const matches = allBalancesMatch(positions, unread)
  const questionsAbout = (asset: string) => questions.filter((q) => q.arrivals.some((a) => a.asset === asset))
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
              const flag = balanceFlag(position, { combined: position.wallets !== undefined })
              const askable = held && unknown ? questionsAbout(asset).length : 0
              const heldIn = partsWhere(position, ({ qty }) => BigInt(qty) > 0n)
              const unknownIn = partsWhere(position, ({ unknownCostQty }) => BigInt(unknownCostQty) > 0n)
              const mismatchedIn = partsWhere(position, ({ reconciliation }) => reconciliation === "incomplete")
              const askedIn = position.wallets ? [...new Set(questionsAbout(asset).map(({ wallet }) => wallet))] : []
              return (
                <tr key={asset} className={held ? "" : "closed"}>
                  <td>
                    <strong>{asset}</strong>
                    {asset === "ETH" ? <span className="muted small"> {ETH_NOTE}</span> : null}
                    {/* Once per row, however many of its numbers it affects. */}
                    {flag ? (
                      <button type="button" className="row-flag" title={mismatchedIn.length > 0 ? `${inWallets(mismatchedIn)}. ${flag.help}` : flag.help} aria-label={`${asset}: ${flag.label}`} onClick={open(position, flag.metric)}>
                        ⚠
                      </button>
                    ) : null}
                    {heldIn.length > 0 ? <span className="muted small holding-wallets" title={position.wallets?.map(({ wallet, qty }) => `${shortHash(wallet)}: ${formatAmount(qty, decimals)} ${asset}`).join("\n")}>{inWallets(heldIn)}</span> : null}
                    {unknownIn.length > 0 ? <span className="muted small holding-wallets">{unknownCostIn(unknownIn)}</span> : null}
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
                          <button type="button" className="row-action" title={`${answerQuestionsLabel(askable)} about ${asset}, so what you paid is known${askedIn.length > 0 ? `. ${inWallets(askedIn)}` : ""}`} aria-label={`${answerQuestionsLabel(askable)} about ${asset}${askedIn.length > 0 ? `, ${inWallets(askedIn).toLowerCase()}` : ""}`} onClick={() => onResolve(asset)}>
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
  const [input, setInput] = useState(() => (isAddress(readAddress() ?? "") ? (readAddress() as string) : ""))
  const [inputError, setInputError] = useState<string | null>(null)
  const [method, setMethod] = useState<Method>("average")
  const [target, setTarget] = useState<ExplainTarget | null>(null)
  const [taxOpen, setTaxOpen] = useState(false)
  // Not remembered: opening the report starts on the newest year. Coming back from answering keeps the one it was on.
  const [taxYear, setTaxYear] = useState<TaxYear>("latest")
  const [chosenCurrency, setChosenCurrency] = useState<CurrencyCode>(readCurrency)
  const { rules, chosen: chosenRule, choose: chooseRule } = useRules()
  const { book, change, undo, canUndo, notSaved, linkAccounts, addPurchase } = useBook()
  const { purchases, problem: purchasesProblem, begin: beginPurchase, dismiss: dismissPurchase } = usePurchases(addPurchase)
  const [buying, setBuying] = useState(false)
  const paidIn = currenciesIn(book).join(",")
  const [device, setDevice] = useState<{ link: DeviceLink | null } | null>(() => {
    const link = parseDeviceLink(window.location.search)
    return link ? { link } : null
  })
  // Read again whenever the device panel closes, since that's where accounts get checked.
  const yours = useMemo(() => yourWallets(book, readCheckedAccounts().map((account) => account.address)), [book, device])
  // Taking back an answer can leave one wallet, or none, and then there's nothing to add up. It comes back with the next one.
  const isAll = address === ALL_YOURS && yours.length >= 2
  const single = address === ALL_YOURS ? (isAll ? null : (yours[0] ?? null)) : address
  const singleRead = useWallet(single, chosenCurrency, chosenRule, paidIn)
  const allRead = useAllYours(isAll ? yours : null, chosenCurrency, chosenRule, paidIn)
  const { wallet } = singleRead
  const { error, retry: retryRead } = isAll ? allRead : singleRead
  // A read that came back with none of them yet has nothing to show, and it's still reading until one does.
  const loading = isAll ? allRead.loading || (allRead.read !== null && allRead.read.wallets.length === 0 && allRead.read.unread.reading.length > 0) : singleRead.loading
  const together = useMemo(() => (isAll && allRead.read && allRead.read.wallets.length > 0 ? { read: allRead.read.wallets, unread: allRead.read.unread } : null), [isAll, allRead.read])
  const [resolving, setResolving] = useState<{ asset: string | null } | null>(null)
  // Another wallet's questions, asked for from a tax report that includes it: they open once it's read, and closing them
  // goes back to the report on the wallet that was showing.
  const [pendingResolve, setPendingResolve] = useState<{ wallet: string; returnTo: string } | null>(null)
  const [returnTo, setReturnTo] = useState<string | null>(null)
  const [cardSender, setCardSender] = useState<string | null>(null)
  const wanted = useMemo(() => (isAll ? [] : walletsToRead(book, wallet?.address ?? null, cardSender)), [isAll, book, cardSender, wallet?.address])
  const { others, failed, retry } = useOtherWallets(wanted, chosenCurrency, chosenRule, paidIn, wallet?.latest.blockNum ?? null, wallet)
  const linkedFailed = useMemo(() => (wallet ? failed.filter((address) => walletsBehind(book, wallet).includes(address)) : []), [failed, book, wallet])

  useEffect(() => {
    const onPop = () => {
      setPendingResolve(null)
      setReturnTo(null)
      const next = readAddress()
      setAddress(next)
      setInput(next && isAddress(next) ? next : "")
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
    if (!address) return
    if (next === wallet?.address.toLowerCase()) {
      setReturnTo(address)
      setTaxOpen(false)
      setResolving({ asset: null })
    } else {
      setPendingResolve({ wallet: next, returnTo: address })
      go(next)
    }
  }
  const closeResolve = () => {
    setResolving(null)
    if (returnTo === null) return
    setReturnTo(null)
    if (returnTo !== address) go(returnTo)
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
  const pnlStatus = combined?.pnlStatus ?? fold?.pnlStatus ?? null
  const holdComparison = combined?.holdComparison ?? fold?.holdComparison ?? null
  const withheld = combined?.withheld ?? fold?.withheld ?? []
  const missingRateTxs = combined ? (combined.exchange?.missingRateTxs ?? []) : (view?.missingRateTxs ?? [])
  const noCurrentRate = combined ? combined.exchange !== null && combined.exchange.latestRateMicros === null : currency !== "USD" && view !== null && !view.latestRate
  /** How many questions each wallet on screen has. A wallet that isn't read yet isn't here, since that isn't known. */
  const questionsIn = useMemo(() => {
    const counts = new Map<string, number>()
    if (!together) return single ? counts.set(single.toLowerCase(), questions.length) : counts
    for (const { address: one } of together.read) counts.set(one.toLowerCase(), 0)
    for (const { wallet: where } of questions) counts.set(where, (counts.get(where) ?? 0) + 1)
    return counts
  }, [together, single, questions])
  const listed = positions.filter((p) => !p.noMarket)
  const attention = showing && pnlStatus ? attentionOf({ positions, unread, totals, pnlStatus, gasUnknownTxs: showing.gasUnknownTxs, l1FeeUnknownTxs: showing.l1FeeUnknownTxs, withheld, currency, missingRateTxs, hasCurrentRate: !noCurrentRate }) : null
  const pastCosts = pastCostsNote(attention, questions.length)
  const attentionBox = attention ? <AttentionBox attention={attention} questionCount={questions.length} onResolve={() => setResolving({ asset: null })} onShow={() => setTarget(attentionTarget(positions))} /> : pastCosts ? <PastCostsLine note={pastCosts} questionCount={questions.length} onResolve={() => setResolving({ asset: null })} /> : null
  const noMarket = showing ? noMarketSentence(totals.noMarket, showing.unlisted.length) : null
  const about = showing ? [...(started ? [coverageSentence(showing.coverage, TOKENS.length - 1, showing.openingUnread.length > 0, { combined: isAll })] : []), ...(noMarket ? [noMarket] : [])] : []
  // With no table to sit beside, what it covers stays on the page.
  const aboutNotices = about.map((line) => <p className="notice" key={line}>{line}</p>)
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
  const tryRead = (
    <button type="button" className="link" onClick={retryRead}>
      Try again
    </button>
  )
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
        <button type="button" onClick={() => setBuying(true)}>
          Buy
        </button>
        {showing ? <LiveBadge wallet={showing} stale={error !== null} updating={(combined?.linkedReading.length ?? 0) > 0} /> : null}
      </header>
      {inputError ? <p className="notice warn">⚠ {inputError}</p> : null}
      {notSaved ? <p className="notice warn" role="alert">⚠ {NOT_SAVED}</p> : null}
      {rules.length > 1 ? <RulesPanel rules={rules} chosen={chosenRule} choose={chooseRule} current={rule} address={isAll ? null : single} method={method} currency={currency} book={book} /> : null}

      <PurchaseList purchases={purchases} problem={purchasesProblem} matches={combined?.purchases ?? fold?.purchases ?? []} currency={chosenCurrency} showing={wallet?.address ?? null} onView={go} onDismiss={dismissPurchase} />

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

      {!showing && error ? <ProblemNotice problem={feedProblem(error, location.origin)} action={tryRead} /> : null}

      {showing ? (
        <main>
          {error ? <ProblemNotice problem={feedProblem(error, location.origin, started ? staleSentence(formatTime(showing.latest.timestamp)) : null)} action={tryRead} /> : null}
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
          {linkedFailed.length > 0 ? (
            <p className="notice warn">
              ⚠ {linkedFailedSentence(linkedFailed.length)}{" "}
              <button type="button" className="link" onClick={retry}>
                Try again
              </button>
            </p>
          ) : null}

          {positions.length === 0 && !started ? attentionBox : positions.length === 0 && unread.length === 0 ? (
            <>
              {aboutNotices}
              {attentionBox}
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
                    <Num label={`Total PnL${pnlStatus === "partial" ? ", partial" : ""}`} onClick={() => openTotal("pnl")} tone={toneOf(totals.pnlMicros)}>
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
              {holdComparison ? <HoldLine comparison={holdComparison} combined={isAll} currency={currency} onOpen={() => setTarget({ kind: "hold" })} /> : null}
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

      {explanation && showing ? <ExplainPanel explanation={explanation} address={showing.address} rule={rule} onClose={close} /> : null}
      {resolving && together ? <ResolvePanel wallet={together.read[0] as WalletResponse} others={together.read.slice(1)} all={together.unread} failed={together.unread.failed} onRetry={allRead.retry} method={method} book={book} firstAsset={resolving.asset} onChange={change} onUndo={undo} canUndo={canUndo} notSaved={notSaved} onPublish={(link) => setDevice({ link })} onCurrentSender={setCardSender} onClose={closeResolve} /> : null}
      {resolving && !together && wallet ? <ResolvePanel wallet={wallet} others={others} failed={failed} onRetry={retry} method={method} book={book} firstAsset={resolving.asset} onChange={change} onUndo={undo} canUndo={canUndo} notSaved={notSaved} onPublish={(link) => setDevice({ link })} onCurrentSender={setCardSender} onClose={closeResolve} /> : null}
      {buying ? (
        <Suspense fallback={null}>
          <BuyPanel
            currency={chosenCurrency}
            onBegin={beginPurchase}
            onView={(next) => {
              setBuying(false)
              if (next !== wallet?.address.toLowerCase()) go(next)
            }}
            onClose={() => setBuying(false)}
          />
        </Suspense>
      ) : null}
      {device ? (
        <Suspense fallback={null}>
          <DevicePanel
            link={device.link}
            book={book}
            currency={chosenCurrency}
            allYours={isAll}
            onLink={linkAccounts}
            notSaved={notSaved}
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
      {taxOpen && (isAll || single) ? <TaxPanel
          // All of them is the first with the rest alongside, since a device account isn't always in the answers.
          address={isAll ? (yours[0] as string) : (single as string)}
          alongside={isAll ? yours : NONE}
          currency={chosenCurrency}
          book={book}
          year={taxYear}
          onYear={setTaxYear}
          overviewMethod={method}
          questionsIn={questionsIn}
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

/** Questions that remain when the numbers above leave nothing out. Nothing's wrong, so there's no warning, but they can still be answered. */
function PastCostsLine({ note, questionCount, onResolve }: { note: string; questionCount: number; onResolve: () => void }) {
  return (
    <section className="attention">
      <p className="attention-text muted">{note}</p>
      <button type="button" className="quiet-button" onClick={onResolve}>
        {answerQuestionsLabel(questionCount)}
      </button>
    </section>
  )
}

/** This wallet next to simply holding ETH, in a line. Calm on purpose: no colors for ahead or behind, and it asks nothing of anyone. Clicking it shows the numbers and how they're worked out. */
function HoldLine({ comparison, combined, currency, onOpen }: { comparison: HoldComparison; combined: boolean; currency: CurrencyCode; onOpen: () => void }) {
  // The fine print, a hover or a click away.
  const fine = [holdCaveatSentence(comparison, currency, { combined }), comparison.status === "unavailable" ? null : HOLD_PAST].filter((part) => part !== null).join(" ")
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

function LiveBadge({ wallet, stale, updating }: { wallet: Pick<WalletResponse, "mode" | "coverage" | "latest">; stale: boolean; updating: boolean }) {
  if (wallet.mode === "demo") return <span className="badge">Demo data</span>
  const detail = feedDetail(wallet.mode, wallet.coverage.toBlock)
  // The notice under it says what's wrong.
  if (stale) return <span className="badge" title={detail}>Not updating</span>
  if (updating) return <span className="badge updating" title={detail}>Updating</span>
  if (isBehind(wallet)) return <span className="badge" title={detail}>Catching up</span>
  return <span className="badge live" title={detail}>Live</span>
}
