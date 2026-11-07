import { useEffect, useId, useMemo, useRef, useState } from "react"
import { formatSignedMoney, shortHash, type CurrencyCode, type Method } from "@pricetag/sdk/core"
import type { TaxReportResponse } from "../core/api.ts"
import { failureOf, jsonPost, readResponse, type ReadFailure } from "../core/read-failure.ts"
import type { Book } from "../core/book.ts"
import { SCOPE_LABELS, TAX_COUNTRIES, TAX_COUNTRY_CODES, isTaxCountryCode, isTaxMethod, readOtherWallets, savedOtherWallets, type TaxCountryCode, type TaxScope, type TaxYear } from "../core/tax.ts"
import { METHOD_LABELS, METHOD_NAME, answerQuestionsLabel, est, panelProblem } from "../core/wording.ts"
import { ProblemNotice } from "./ProblemNotice.tsx"
import { downloadCsv } from "./download.ts"
import { useModal } from "./useModal.ts"

const COUNTRY_KEY = "pricetag.taxCountry"
const METHOD_KEY = "pricetag.taxMethod"
const SCOPE_KEY = "pricetag.taxScope"
const OTHERS_KEY = "pricetag.taxOtherWallets"

/** Remembered in this browser. Until it's chosen, the main currency is the best guess. */
function readCountry(currency: CurrencyCode): TaxCountryCode {
  const value = localStorage.getItem(COUNTRY_KEY)
  if (isTaxCountryCode(value)) return value
  return TAX_COUNTRY_CODES.find((code) => TAX_COUNTRIES[code].currency === currency) ?? "US"
}

const readMethod = (): string | null => localStorage.getItem(METHOD_KEY)

const readScope = (): TaxScope | null => {
  const value = localStorage.getItem(SCOPE_KEY)
  return value === "pooled" || value === "per-wallet" ? value : null
}

function remember(key: string, value: string | null) {
  if (value === null) localStorage.removeItem(key)
  else localStorage.setItem(key, value)
}

const readOthers = () => localStorage.getItem(OTHERS_KEY) ?? ""

/** A post, because answers don't belong in a URL, where they'd end up in logs. */
async function fetchReport(address: string, request: object, signal: AbortSignal): Promise<TaxReportResponse> {
  return readResponse<TaxReportResponse>(await fetch(`/api/tax-report/${address}`, jsonPost(request, signal)))
}

const RULES: Record<TaxCountryCode, string> = { CA: "Canada's rules", GB: "UK rules", US: "US rules" }

/** Overview's numbers and this report's can differ through the method, or the UK's matching, so it says so and why. */
function methodNote(method: Method, overview: Method, country: TaxCountryCode): string | null {
  const matching = method === "average" && TAX_COUNTRIES[country].matchesAcquisitions
  const matchingNote = `${RULES[country]} match each sale to what was bought the same day or in the 30 days after before averaging the rest, so its gains can differ from Overview's.`
  if (method === overview) return matching ? matchingNote : null
  if (method === TAX_COUNTRIES[country].method) return `Overview uses ${METHOD_LABELS[overview]}, but ${RULES[country]} call for ${METHOD_LABELS[method]}, so this report uses that. ${matching ? matchingNote : "Its gains can differ from Overview's."}`
  return `Overview uses ${METHOD_LABELS[overview]}, and you chose ${METHOD_LABELS[method]} here, so its gains can differ from Overview's.`
}

/** Counts sales, fees and sends once each, like the numbers above it, rather than the file's rows. */
function unknownSentence({ unknownCount: count, soldCount, feeCount, sentCount }: TaxReportResponse): string {
  const n = (value: number) => value.toLocaleString("en-US")
  const total = soldCount + feeCount + sentCount
  if (count === total) return count === 1 ? "Its gain is unknown, in whole or in part." : `All ${n(count)} have an unknown gain, in whole or in part.`
  return `${n(count)} of these ${n(total)} ${count === 1 ? "has" : "have"} an unknown gain, in whole or in part. What's unknown is left out of the total.`
}

export function TaxPanel({ address, alongside, currency, book, year, onYear, overviewMethod, questionsIn, onResolve, onClose }: {
  address: string
  /** Wallets the report always covers with this one, on top of any listed here. */
  alongside: readonly string[]
  currency: CurrencyCode
  book: Book
  /** Held by the page, so it stays the same while the report closes to answer another wallet's questions. */
  year: TaxYear
  onYear: (year: TaxYear) => void
  overviewMethod: Method
  /** How many questions each wallet showing has. A wallet that isn't here could have some, which opening it finds out. */
  questionsIn: ReadonlyMap<string, number>
  /** Opens a wallet's questions, which can be one added here rather than the one showing. */
  onResolve: (wallet: string) => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const othersError = useId()
  const close = useRef<HTMLButtonElement>(null)
  const [country, setCountry] = useState(() => readCountry(currency))
  // Nothing chosen means whatever the country calls for. Choosing another country goes back to that.
  const [chosenMethod, setChosenMethod] = useState<string | null>(readMethod)
  const [chosenScope, setChosenScope] = useState<TaxScope | null>(readScope)
  const [years, setYears] = useState<{ year: number; label: string }[]>([])
  const [othersText, setOthersText] = useState(readOthers)
  const [report, setReport] = useState<TaxReportResponse | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState<ReadFailure | null>(null)
  const [loading, setLoading] = useState(true)

  const rules = TAX_COUNTRIES[country]
  // One the country doesn't allow, like one remembered from another, goes back to what it calls for.
  const method = isTaxMethod(country, chosenMethod) ? chosenMethod : rules.method
  const scope = chosenScope ?? rules.scope
  const { others, bad: badOther } = useMemo(() => readOtherWallets(othersText, address), [othersText, address])
  const isDemo = address === "demo"

  useModal(dialog, close)

  useEffect(() => {
    if (badOther) return
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    fetchReport(address, { country, method, scope, year, currency, also: [...new Set([...others, ...alongside])].filter((other) => other !== address.toLowerCase()), book }, controller.signal)
      .then((next) => {
        setYears(next.years.map((option, i) => ({ year: option, label: next.yearLabels[i] ?? String(option) })))
        setReport(next)
        setLoading(false)
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return
        // What's on screen would be about other choices, so it can't stay.
        setReport(null)
        setError(failureOf(reason))
        setLoading(false)
      })
    return () => controller.abort()
  }, [address, alongside, country, method, scope, year, currency, others, badOther, book, attempt])

  const chooseMethod = (next: Method | null) => {
    remember(METHOD_KEY, next)
    setChosenMethod(next)
  }
  const chooseScope = (next: TaxScope | null) => {
    remember(SCOPE_KEY, next)
    setChosenScope(next)
  }
  const chooseCountry = (next: TaxCountryCode) => {
    remember(COUNTRY_KEY, next)
    setCountry(next)
    chooseMethod(null)
    chooseScope(null)
  }
  // The newest year shows as itself once a report has said which that is.
  const shownYear = year === "latest" && years[0] !== undefined ? years[0].year : year
  const note = methodNote(method, overviewMethod, country)
  const defaultTag = (isDefault: boolean) => (isDefault ? " (default)" : "")
  const ready = report !== null && !loading && badOther === null

  return (
    <dialog
      ref={dialog}
      className="panel"
      aria-label="Tax report"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="panel-body tax">
        <header className="panel-head">
          <h2>Tax report</h2>
          <button ref={close} type="button" className="link" onClick={onClose}>
            Close
          </button>
        </header>
        <p className="notice warn tax-advice">⚠ {report?.disclaimer ?? "Not tax advice. Check this with an accountant before relying on it."}</p>

        <label className="field">
          <span className="small muted">Year</span>
          <select value={String(shownYear)} onChange={(e) => {
              const next = e.target.value === "all" ? "all" : Number(e.target.value)
              if (next !== shownYear) onYear(next)
            }}>
            {years.length === 0 && year === "latest" ? <option value="latest">Newest</option> : null}
            {/* Until the report says which years there are, the one chosen is still one of them. */}
            {(typeof year === "number" && !years.some((option) => option.year === year) ? [{ year, label: String(year) }, ...years] : years).map((option) => (
              <option key={option.year} value={option.year}>
                {option.label}
              </option>
            ))}
            <option value="all">All years</option>
          </select>
        </label>
        <label className="field">
          <span className="small muted">Country</span>
          <select value={country} onChange={(e) => chooseCountry(e.target.value as TaxCountryCode)}>
            {TAX_COUNTRY_CODES.map((code) => (
              <option key={code} value={code}>
                {TAX_COUNTRIES[code].name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="small muted">{METHOD_NAME}</span>
          <select value={method} onChange={(e) => {
              // What's remembered has to say which country this override is for.
              remember(COUNTRY_KEY, country)
              chooseMethod(e.target.value === rules.method ? null : (e.target.value as Method))
            }}>
            {rules.methods.map((m) => (
              <option key={m} value={m}>
                {METHOD_LABELS[m]}
                {defaultTag(m === rules.method)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="small muted">Wallets</span>
          <select value={scope} onChange={(e) => {
              remember(COUNTRY_KEY, country)
              chooseScope(e.target.value === rules.scope ? null : (e.target.value as TaxScope))
            }}>
            {(["pooled", "per-wallet"] as const).map((s) => (
              <option key={s} value={s}>
                {SCOPE_LABELS[s]}
                {defaultTag(s === rules.scope)}
              </option>
            ))}
          </select>
        </label>
        {note ? <p className="small muted">{note}</p> : null}
        {isDemo ? null : (
          <label className="field">
            <span className="small muted">Your other wallets, one per line</span>
            <textarea
              rows={3}
              spellCheck={false}
              autoComplete="off"
              placeholder="0x…"
              value={othersText}
              aria-invalid={badOther !== null}
              aria-describedby={badOther ? othersError : undefined}
              onChange={(e) => {
                remember(OTHERS_KEY, savedOtherWallets(e.target.value) || null)
                setOthersText(e.target.value)
              }}
            />
          </label>
        )}
        {badOther ? <p id={othersError} className="notice warn" role="alert">⚠ {badOther} isn't a Base address.</p> : null}
        {error ? (
          <ProblemNotice
            problem={panelProblem(error, location.origin)}
            action={
              <button type="button" className="link" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </button>
            }
          />
        ) : null}

        {report && !badOther ? (
          <>
            <h3 className="tax-year">{report.yearLabel === null ? "In all years" : `In ${report.yearLabel}`}</h3>
            <dl className="tax-counts">
              <div>
                <dt className="small muted">Sales</dt>
                <dd>{report.soldCount.toLocaleString("en-US")}</dd>
              </div>
              <div>
                <dt className="small muted">Network fees</dt>
                <dd>{report.feeCount.toLocaleString("en-US")}</dd>
              </div>
              {report.sentCount > 0 ? (
                <div>
                  <dt className="small muted">Sent to other addresses</dt>
                  <dd>{report.sentCount.toLocaleString("en-US")}</dd>
                </div>
              ) : null}
              {report.receivedCount > 0 ? (
                <div>
                  <dt className="small muted">Received, may be income</dt>
                  <dd>{report.receivedCount.toLocaleString("en-US")}</dd>
                </div>
              ) : null}
              <div>
                <dt className="small muted">Total gain · {report.currency}</dt>
                <dd>{report.gainMicros === null ? <span className="warn-text">⚠ Unknown</span> : est(formatSignedMoney(report.gainMicros, report.currency), report.estimatedCount > 0)}</dd>
              </div>
            </dl>
            {report.unresolvedCount > 0 ? (
              <p className="notice warn tax-unknown">
                <span>⚠ {unknownSentence(report)}</span>
                {report.unknownWallets.map((wallet) => {
                  const count = questionsIn.get(wallet)
                  if (count === 0) return null
                  return (
                    <button key={wallet} type="button" className="resolve-button" onClick={() => onResolve(wallet)}>
                      {count === undefined || alongside.length > 0 ? `Answer for ${shortHash(wallet)}` : answerQuestionsLabel(count)}
                    </button>
                  )
                })}
              </p>
            ) : null}
            {report.warnings.map((warning) => (
              <p key={warning} className="notice warn">
                ⚠ {warning}
              </p>
            ))}
          </>
        ) : null}

        <p className="visually-hidden" role="status">{loading && !badOther ? "Working it out…" : ready ? "The report is ready." : ""}</p>
        <button type="button" className="primary" disabled={!ready} onClick={() => report && downloadCsv(report.csv, report.filename)}>
          {loading && !badOther ? "Working it out…" : "Download CSV"}
        </button>
        {report?.form ? (
          <button type="button" disabled={!ready} onClick={() => report.form && downloadCsv(report.form.csv, report.form.filename)}>
            Download as {report.form.name}
          </button>
        ) : null}

        {report && !badOther ? (
          <details className="small tax-notes">
            <summary>What this report covers and leaves out</summary>
            {report.notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </details>
        ) : null}
      </div>
    </dialog>
  )
}
