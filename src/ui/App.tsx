import { lazy, useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react"
import { CURRENCIES, MAIN_CURRENCY_CODES, TOKENS, formatTime, isAddress, isMainCurrency, msBetweenBlocks, normalizeAddress, shortHash, sumTotals, type CurrencyCode, type Method } from "@pricetag/sdk/core"
import { hasStarted, isBehind, type WalletResponse } from "../core/api.ts"
import { ALL_YOURS, combinedPortfolioOf, explainAcross, exportCombined } from "../core/combined.ts"
import { ExplainPanel } from "./ExplainPanel.tsx"
import { attentionOf, attentionTarget, pastCostsNote } from "../core/attention.ts"
import { explainTarget, type ExplainTarget, type TotalMetric } from "../core/explain.ts"
import { ALL_YOURS_TITLE, DEMO_NOTICE, NOT_AN_ADDRESS, NOT_STARTED, PNL_HELP, READING, READING_ALL, allYoursFailedSentence, allYoursOutdatedSentence, allYoursReadingSentence, allYoursUpdatingSentence, behindSentence, coverageSentence, exportLeavesOutSentence, feedProblem, linkedFailedSentence, NOT_SAVED, noMarketSentence, staleSentence, walletCount, UNREADABLE_NOT_COPIED, UNREADABLE_SAVED } from "../core/wording.ts"
import { PnlChart } from "./PnlChart.tsx"
import { ResolvePanel } from "./ResolvePanel.tsx"
import { useBook, useOtherWallets, useUnreadableSaved } from "./useBook.ts"
import { RulesPanel } from "./RulesPanel.tsx"
import { useRules } from "./useRules.ts"
import type { TaxYear } from "../core/tax.ts"
import { TaxPanel } from "./TaxPanel.tsx"
import { useAllYours, useWallet } from "./useWallet.ts"
import { LazyPanel } from "./LoadBoundary.tsx"
import { ProblemNotice } from "./ProblemNotice.tsx"
import { answerSender, currenciesIn, unlinkWallet, walletsBehind, walletsToRead, yourWallets } from "../core/book.ts"
import { readCheckedAccounts } from "../core/device-accounts.ts"
import { parseDeviceLink, type DeviceLink } from "../core/device-link.ts"
import { exportCsv } from "../core/export.ts"
import { bookContext } from "../core/portfolio.ts"
import { foldBook } from "../core/resolve.ts"
import { PurchaseList } from "./PurchaseList.tsx"
import { usePurchases } from "./usePurchases.ts"
import { downloadCsv } from "./download.ts"
import { Holdings, OtherTokens, holdingOf, walletHoldingOf, type Holding } from "./Holdings.tsx"
import { LiveBadge } from "./LiveBadge.tsx"
import { AttentionBox, HoldLine, PastCostsLine, Summary } from "./Summary.tsx"

// Only loads when someone asks for it, so looking at a wallet never pulls in any device code.
const DevicePanel = lazy(() => import("./DevicePanel.tsx").then((m) => ({ default: m.DevicePanel })))
const BuyPanel = lazy(() => import("./BuyPanel.tsx").then((m) => ({ default: m.BuyPanel })))

function readAddress(): string | null {
  const value = new URLSearchParams(window.location.search).get("address")
  return value && (value === "demo" || value === ALL_YOURS || isAddress(value)) ? value : null
}

const NONE: readonly string[] = []

const CURRENCY_KEY = "pricetag.currency"

/** Remembered in this browser, since there are no accounts. USD until it's changed. */
function readCurrency(): CurrencyCode {
  const value = localStorage.getItem(CURRENCY_KEY)
  return isMainCurrency(value) ? value : "USD"
}

export function App() {
  const [address, setAddress] = useState(readAddress)
  const [input, setInput] = useState(() => (isAddress(readAddress() ?? "") ? (readAddress() as string) : ""))
  const [inputError, setInputError] = useState<string | null>(null)
  const inputErrorId = useId()
  const exportNoteId = useId()
  const [method, setMethod] = useState<Method>("average")
  const [target, setTarget] = useState<ExplainTarget | null>(null)
  const [taxOpen, setTaxOpen] = useState(false)
  // Not remembered: opening the report starts on the newest year. Coming back from answering keeps the one it was on.
  const [taxYear, setTaxYear] = useState<TaxYear>("latest")
  const [chosenCurrency, setChosenCurrency] = useState<CurrencyCode>(readCurrency)
  const { rules, chosen: chosenRule, choose: chooseRule } = useRules()
  const { book, change, undo, canUndo, notSaved, linkAccounts, addPurchase, changeRecords } = useBook()
  const unreadableSaved = useUnreadableSaved()
  const { purchases, problem: purchasesProblem, begin: beginPurchase, dismiss: dismissPurchase } = usePurchases(addPurchase)
  const [buying, setBuying] = useState(false)
  const paidIn = currenciesIn(book).join(",")
  const [device, setDevice] = useState<{ link: DeviceLink | null } | null>(() => {
    const link = parseDeviceLink(window.location.search)
    return link ? { link } : null
  })
  // Read again whenever the device panel closes, since that's where accounts get checked.
  const checkedAccounts = useMemo(() => readCheckedAccounts().map((account) => normalizeAddress(account.address)), [device])
  const yours = useMemo(() => yourWallets(book, checkedAccounts), [book, checkedAccounts])
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

  const linkFromTax = useCallback(
    (wallets: readonly string[], focus: string, onSaved?: () => void) => change((latest) => wallets.reduce((next, wallet) => answerSender(next, focus, wallet, { kind: "mine" }), latest), onSaved),
    [change],
  )
  const unlinkFromTax = useCallback((wallet: string) => change((latest) => unlinkWallet(latest, wallet)), [change])
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
  const positions: Holding[] = useMemo(() => combined?.positions.map(holdingOf) ?? fold?.positions.map((position) => walletHoldingOf(position, fold.questions)) ?? [], [combined, fold])
  const shown = combined ?? fold
  const unread = combined?.unreadAssets ?? fold?.unread ?? []
  const totals = shown?.totals ?? sumTotals([])
  const points = shown?.points ?? []
  const questions = shown?.questions ?? []
  const pnlStatus = shown?.pnlStatus ?? null
  const holdComparison = shown?.holdComparison ?? null
  const withheld = shown?.withheld ?? []
  const missingRateTxs = combined ? (combined.exchange?.missingRateTxs ?? []) : (view?.missingRateTxs ?? [])
  const noCurrentRate = combined ? combined.exchange !== null && combined.exchange.latestRateMicros === null : currency !== "USD" && view !== null && !view.latestRate
  /** How many questions each wallet on screen has. A wallet that isn't read yet isn't here, since that isn't known. */
  const questionsIn = useMemo(() => {
    const counts = new Map<string, number>()
    // By its address, as a tax report names it, which isn't how the demo wallet is asked for.
    if (!together) return wallet ? counts.set(wallet.address.toLowerCase(), questions.length) : counts
    for (const { address: one } of together.read) counts.set(one.toLowerCase(), 0)
    for (const { wallet: where } of questions) counts.set(where, (counts.get(where) ?? 0) + 1)
    return counts
  }, [together, wallet, questions])
  const listed = positions.filter((p) => !p.noMarket)
  const attention = showing && pnlStatus ? attentionOf({ positions, unread, totals, pnlStatus, gasUnknownTxs: showing.gasUnknownTxs, l1FeeUnknownTxs: showing.l1FeeUnknownTxs, withheld, currency, missingRateTxs, hasCurrentRate: !noCurrentRate }) : null
  const pastCosts = pastCostsNote(attention, questions.length)
  const attentionBox = attention ? <AttentionBox attention={attention} questionCount={questions.length} onResolve={() => setResolving({ asset: null })} onShow={() => setTarget(attentionTarget(positions))} /> : pastCosts ? <PastCostsLine note={pastCosts} questionCount={questions.length} onResolve={() => setResolving({ asset: null })} /> : null
  const noMarket = showing ? noMarketSentence(totals.noMarket, showing.otherTokens.length + showing.otherTokensLeftOut) : null
  const about = showing ? [...(started ? [coverageSentence(showing.coverage, TOKENS.length - 1, showing.openingUnread.length > 0, { combined: isAll })] : []), ...(noMarket ? [noMarket] : [])] : []
  // With no table to sit beside, what it covers stays on the page.
  const aboutNotices = about.map((line) => <p className="notice" key={line}>{line}</p>)
  const download = () => downloadCsv(together ? exportCombined(together.read, method, book) : exportCsv(fold?.positions ?? [], currency), `patina-${together ? "all-yours" : wallet?.address}.csv`)
  // Worked out from what's on screen, so it can't go on showing numbers that have since changed, or that are in another currency.
  const explanation = useMemo(() => {
    if (!target) return null
    if (together) return explainAcross(together.read, method, target, book, together.unread)
    if (!fold || !wallet) return null
    return explainTarget(target, fold, bookContext(wallet, others, method, book, fold.view))
  }, [target, together, fold, wallet, others, method, book])
  const close = useCallback(() => setTarget(null), [])
  const statusLines = showing ? [
    ...(combined && combined.linkedReading.length > 0 ? [allYoursReadingSentence(combined.linkedReading)] : []),
    ...(combined && combined.linkedUpdating.length > 0 ? [allYoursUpdatingSentence(combined.linkedUpdating)] : []),
    ...(combined && combined.linkedFailed.length > 0 ? [allYoursFailedSentence(combined.linkedFailed)] : []),
    ...(combined && combined.linkedOutdated.length > 0 ? [allYoursOutdatedSentence(combined.linkedOutdated)] : []),
    ...(isBehind(showing) && started ? [behindSentence(msBetweenBlocks(showing.coverage.toBlock, showing.latest.blockNum))] : []),
    ...(linkedFailed.length > 0 ? [linkedFailedSentence(linkedFailed.length)] : []),
  ] : []
  const retryEverything = () => {
    if (error) retryRead()
    if (combined && combined.linkedFailed.length + combined.linkedOutdated.length > 0) allRead.retry()
    if (linkedFailed.length > 0) retry()
  }
  const tryRead = (
    <button type="button" className="link" onClick={retryRead}>
      Try again
    </button>
  )
  const openTotal = (metric: TotalMetric) => setTarget({ kind: "total", metric })
  const closeDevice = () => {
    // A link has done its job, and reloading shouldn't start it over.
    if (parseDeviceLink(window.location.search)) window.history.replaceState(null, "", window.location.pathname)
    setDevice(null)
  }
  const showingTitle = !showing ? null : isAll ? ALL_YOURS_TITLE : showing.mode === "demo" ? "Demo wallet" : `Wallet ${shortHash(showing.address)}`
  // Still or finished reading, for whoever can't see the page change. It's always here, because that's how a change in it gets read out.
  const readingStatus = loading ? (isAll ? READING_ALL : READING) : showingTitle ? `${showingTitle} is ready.` : ""
  const statusProblem = showing && error ? feedProblem(error, location.origin, started ? staleSentence(formatTime(showing.latest.timestamp)) : null) : null
  // The status stays folded, and nothing in there gets read out, so whoever can't see its badge change hears what went wrong from here.
  const statusAlert = [statusProblem?.message, combined && combined.linkedFailed.length > 0 ? allYoursFailedSentence(combined.linkedFailed) : null, linkedFailed.length > 0 ? linkedFailedSentence(linkedFailed.length) : null].filter(Boolean).join(" ")
  const leftOfExport = [...(combined?.linkedReading ?? []), ...(combined?.linkedFailed ?? [])]

  return (
    <div className="page">
      <header className="top">
        <a className="brand" href="/">
          Pricetag
        </a>
        <form className="address" onSubmit={submit}>
          <input
            aria-label="Base address"
            aria-invalid={inputError !== null}
            aria-describedby={inputError ? inputErrorId : undefined}
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
      </header>
      {showing ? <LiveBadge wallet={showing} problem={statusProblem} lastUpdate={started ? formatTime(showing.latest.timestamp) : null} all={combined} lines={statusLines} failedWallets={linkedFailed.length + (combined?.linkedFailed.length ?? 0)} retry={retryEverything} /> : null}
      {inputError ? <p id={inputErrorId} className="notice warn" role="alert">⚠ {inputError}</p> : null}
      <p className="visually-hidden" role="status">{readingStatus}</p>
      <p className="visually-hidden" role="alert">{statusAlert}</p>
      {notSaved ? <p className="notice warn" role="alert">⚠ {NOT_SAVED}</p> : null}
      {unreadableSaved.copyFailed ? (
        <p className="notice warn" role="alert">⚠ {UNREADABLE_NOT_COPIED}</p>
      ) : unreadableSaved.unreadable ? (
        <p className="notice warn" role="alert">
          ⚠ {UNREADABLE_SAVED}{" "}
          <button type="button" onClick={unreadableSaved.dismiss}>
            OK
          </button>
        </p>
      ) : null}
      {rules.length > 1 ? <RulesPanel rules={rules} chosen={chosenRule} choose={chooseRule} current={rule} address={isAll ? null : single} method={method} currency={currency} book={book} /> : null}

      <PurchaseList purchases={purchases} problem={purchasesProblem} matches={shown?.purchases ?? []} currency={chosenCurrency} showing={wallet?.address ?? null} onView={go} onDismiss={dismissPurchase} />

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
          <h1 className="visually-hidden">{showingTitle}</h1>
          {isBehind(showing) && !started ? <p className="notice warn">⚠ {NOT_STARTED}</p> : null}
          {showing.mode === "demo" ? <p className="notice">{DEMO_NOTICE}</p> : null}

          {positions.length === 0 && !started ? attentionBox : positions.length === 0 && unread.length === 0 && (showing?.otherTokens.length ?? 0) + (showing?.otherTokensLeftOut ?? 0) > 0 ? (
            <>
              {aboutNotices}
              {attentionBox}
              <OtherTokens tokens={showing?.otherTokens ?? []} leftOut={showing?.otherTokensLeftOut ?? 0} />
            </>
          ) : positions.length === 0 && unread.length === 0 ? (
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
              <Summary totals={totals} positions={positions} unread={unread} pnlStatus={pnlStatus} currency={currency} openTotal={openTotal} />
              {/* Its room stays when there's nothing to say, so it can come and go without moving the chart. */}
              <div className="attention-slot">{attentionBox}</div>
              <PnlChart points={points} currency={currency} onSelect={(point) => setTarget({ kind: "tx", txHash: point.txHash as string })} />
              {listed.length > 0 ? <Holdings positions={listed} unread={unread} about={about} currency={currency} questions={questions} method={method} onMethod={setMethod} explain={setTarget} onResolve={(asset) => setResolving({ asset })} /> : aboutNotices}
              {holdComparison ? <HoldLine comparison={holdComparison} combined={isAll} currency={currency} onOpen={() => setTarget({ kind: "hold" })} /> : null}
              {/* Last, because they're read after everything else, and can arrive without moving anything above them. */}
              <OtherTokens tokens={showing?.otherTokens ?? []} leftOut={showing?.otherTokensLeftOut ?? 0} />
              <p className="exports">
                <button type="button" className="link" aria-describedby={leftOfExport.length > 0 ? exportNoteId : undefined} onClick={download}>
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
              {leftOfExport.length > 0 ? <p id={exportNoteId} className="small warn-text exports-note">⚠ {exportLeavesOutSentence(leftOfExport)}</p> : null}
            </>
          )}
        </main>
      ) : null}

      {explanation && showing ? <ExplainPanel explanation={explanation} address={showing.address} rule={rule} onClose={close} /> : null}
      {resolving && together ? <ResolvePanel wallet={together.read[0] as WalletResponse} others={together.read.slice(1)} all={together.unread} failed={together.unread.failed} onRetry={allRead.retry} method={method} book={book} firstAsset={resolving.asset} onChange={change} onUndo={undo} canUndo={canUndo} notSaved={notSaved} onPublish={(link) => setDevice({ link })} onCurrentSender={setCardSender} onClose={closeResolve} /> : null}
      {resolving && !together && wallet ? <ResolvePanel wallet={wallet} others={others} failed={failed} onRetry={retry} method={method} book={book} firstAsset={resolving.asset} onChange={change} onUndo={undo} canUndo={canUndo} notSaved={notSaved} onPublish={(link) => setDevice({ link })} onCurrentSender={setCardSender} onClose={closeResolve} /> : null}
      {buying ? (
        <LazyPanel label="Buy" onClose={() => setBuying(false)}>
          <BuyPanel
            currency={chosenCurrency}
            onBegin={beginPurchase}
            onView={(next) => {
              setBuying(false)
              if (next !== wallet?.address.toLowerCase()) go(next)
            }}
            onClose={() => setBuying(false)}
          />
        </LazyPanel>
      ) : null}
      {device ? (
        <LazyPanel label="Hardware wallet" onClose={closeDevice}>
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
            onClose={closeDevice}
          />
        </LazyPanel>
      ) : null}
      {taxOpen && (isAll || single) ? <TaxPanel
          // All of them is the first with the rest alongside, since a device account isn't always in the answers.
          address={isAll ? (yours[0] as string) : (single as string)}
          alongside={isAll ? yours : NONE}
          currency={chosenCurrency}
          book={book}
          onRecords={changeRecords}
          year={taxYear}
          onYear={setTaxYear}
          overviewMethod={method}
          questionsIn={questionsIn}
          onResolve={resolveFromTax}
          onLink={linkFromTax}
          onUnlink={unlinkFromTax}
          fromDevice={checkedAccounts}
          onClose={() => setTaxOpen(false)}
        /> : null}
    </div>
  )
}
