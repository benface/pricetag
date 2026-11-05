import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { formatSignedMoney, shortHash, type CurrencyCode, type Method } from "@pricetag/sdk/core"
import type { TaxReportResponse } from "../core/api.ts"
import type { Book } from "../core/book.ts"
import { SCOPE_LABELS, TAX_COUNTRIES, TAX_COUNTRY_CODES, isTaxCountryCode, readOtherWallets, type TaxCountryCode, type TaxScope, type TaxYear } from "../core/tax.ts"
import { METHOD_LABELS, METHOD_NAME } from "../core/wording.ts"

const COUNTRY_KEY = "pricetag.taxCountry"
const METHOD_KEY = "pricetag.taxMethod"
const SCOPE_KEY = "pricetag.taxScope"
const OTHERS_KEY = "pricetag.taxOtherWallets"

/** Remembered in this browser. Until it's chosen, the main currency is the best guess. */
function readCountry(currency: CurrencyCode): TaxCountryCode {
  const value = localStorage.getItem(COUNTRY_KEY)
  if (isTaxCountryCode(value)) return value
  return currency === "CAD" ? "CA" : "US"
}

const readMethod = (): Method | null => {
  const value = localStorage.getItem(METHOD_KEY)
  return value === "average" || value === "fifo" ? value : null
}

const readScope = (): TaxScope | null => {
  const value = localStorage.getItem(SCOPE_KEY)
  return value === "pooled" || value === "per-wallet" ? value : null
}

function remember(key: string, value: string | null) {
  if (value === null) localStorage.removeItem(key)
  else localStorage.setItem(key, value)
}

/** A post, because answers don't belong in a URL, where they'd end up in logs. */
async function fetchReport(address: string, request: object, signal: AbortSignal): Promise<TaxReportResponse> {
  const response = await fetch(`/api/tax-report/${address}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal })
  const body = (await response.json().catch(() => ({}))) as TaxReportResponse & { error?: string }
  if (!response.ok) throw new Error(body.error ?? "Couldn't build the report.")
  return body
}

function download({ csv, filename }: TaxReportResponse) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }))
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

const RULES: Record<TaxCountryCode, string> = { CA: "Canada's rules", US: "US rules" }

/** Overview's numbers and this report's can differ only through the method, so it says so and why. */
function methodNote(method: Method, overview: Method, country: TaxCountryCode): string | null {
  if (method === overview) return null
  if (method === TAX_COUNTRIES[country].method) return `Overview uses ${METHOD_LABELS[overview]}, but ${RULES[country]} call for ${METHOD_LABELS[method]}, so this report uses that. Its gains can differ from Overview's.`
  return `Overview uses ${METHOD_LABELS[overview]}, and you chose ${METHOD_LABELS[method]} here, so its gains can differ from Overview's.`
}

/** Counts sales, fees and sends once each, like the numbers above it, rather than the file's rows. */
function unknownSentence({ unknownCount: count, soldCount, feeCount, sentCount }: TaxReportResponse): string {
  const n = (value: number) => value.toLocaleString("en-US")
  const total = soldCount + feeCount + sentCount
  if (count === total) return count === 1 ? "Its gain is unknown, in whole or in part." : `All ${n(count)} have an unknown gain, in whole or in part.`
  return `${n(count)} of these ${n(total)} ${count === 1 ? "has" : "have"} an unknown gain, in whole or in part. What's unknown is left out of the total.`
}

export function TaxPanel({ address, currency, book, overviewMethod, questionCount, onResolve, onClose }: {
  address: string
  currency: CurrencyCode
  book: Book
  overviewMethod: Method
  /** The questions about the wallet showing. */
  questionCount: number
  /** Opens a wallet's questions, which can be one added here rather than the one showing. */
  onResolve: (wallet: string) => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const [country, setCountry] = useState(() => readCountry(currency))
  // Nothing chosen means whatever the country calls for. Choosing another country goes back to that.
  const [chosenMethod, setChosenMethod] = useState<Method | null>(readMethod)
  const [chosenScope, setChosenScope] = useState<TaxScope | null>(readScope)
  // Not remembered: opening the report again starts on the newest year.
  const [year, setYear] = useState<TaxYear>("latest")
  const [years, setYears] = useState<number[]>([])
  const [othersText, setOthersText] = useState(() => localStorage.getItem(OTHERS_KEY) ?? "")
  const [report, setReport] = useState<TaxReportResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const rules = TAX_COUNTRIES[country]
  const method = chosenMethod ?? rules.method
  const scope = chosenScope ?? rules.scope
  const { others, bad: badOther } = useMemo(() => readOtherWallets(othersText, address), [othersText, address])
  const isDemo = address === "demo"

  // As in `ExplainPanel`: a native modal keeps focus inside, and closing by unmounting doesn't restore it.
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const element = dialog.current
    if (!element) return
    if (!element.open) element.showModal()
    close.current?.focus()
    return () => {
      element.close()
      opener?.focus()
    }
  }, [])

  useEffect(() => {
    if (badOther) return
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    fetchReport(address, { country, method, scope, year, currency, also: others, book }, controller.signal)
      .then((next) => {
        setYears(next.years)
        setReport(next)
        setLoading(false)
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return
        // What's on screen would be about other choices, so it can't stay.
        setReport(null)
        setError(reason instanceof Error ? reason.message : "Couldn't build the report.")
        setLoading(false)
      })
    return () => controller.abort()
  }, [address, country, method, scope, year, currency, others, badOther, book])

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
  const shownYear = year === "latest" && years[0] !== undefined ? years[0] : year
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
              if (next !== shownYear) setYear(next)
            }}>
            {years.length === 0 ? <option value="latest">Newest</option> : null}
            {years.map((option) => (
              <option key={option} value={option}>
                {option}
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
            {(["average", "fifo"] as const).map((m) => (
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
              onChange={(e) => {
                localStorage.setItem(OTHERS_KEY, e.target.value)
                setOthersText(e.target.value)
              }}
            />
          </label>
        )}
        {badOther ? <p className="notice warn">⚠ {badOther} isn't a Base address.</p> : null}
        {error ? <p className="notice warn">⚠ {error}</p> : null}

        {report && !badOther ? (
          <>
            <h3 className="tax-year">{report.year === null ? "In all years" : `In ${report.year}`}</h3>
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
              <div>
                <dt className="small muted">Total gain · {report.currency}</dt>
                <dd>{report.gainMicros === null ? <span className="warn-text">⚠ Unknown</span> : formatSignedMoney(report.gainMicros, report.currency)}</dd>
              </div>
            </dl>
            {report.unresolvedCount > 0 ? (
              <p className="notice warn tax-unknown">
                <span>⚠ {unknownSentence(report)}</span>
                {report.unknownWallets.map((wallet) =>
                  wallet !== address.toLowerCase() ? (
                    <button key={wallet} type="button" className="resolve-button" onClick={() => onResolve(wallet)}>
                      Answer for {shortHash(wallet)}
                    </button>
                  ) : questionCount > 0 ? (
                    <button key={wallet} type="button" className="resolve-button" onClick={() => onResolve(wallet)}>
                      Resolve {questionCount}
                    </button>
                  ) : null,
                )}
              </p>
            ) : null}
            {report.warnings.map((warning) => (
              <p key={warning} className="notice warn">
                ⚠ {warning}
              </p>
            ))}
          </>
        ) : null}

        <button type="button" className="primary" disabled={!ready} onClick={() => report && download(report)}>
          {loading && !badOther ? "Working it out…" : "Download CSV"}
        </button>

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
