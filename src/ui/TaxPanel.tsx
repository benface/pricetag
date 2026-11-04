import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { isAddress, type Method } from "@pricetag/sdk/core"
import type { TaxReportResponse } from "../core/api.ts"
import type { CurrencyCode } from "../core/currency.ts"
import { formatSignedMoney } from "../core/format.ts"
import { METHOD_LABELS, SCOPE_LABELS, TAX_COUNTRIES, TAX_COUNTRY_CODES, isTaxCountryCode, type TaxCountryCode, type TaxScope } from "../core/tax.ts"

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

async function fetchReport(address: string, query: URLSearchParams, signal: AbortSignal): Promise<TaxReportResponse> {
  const response = await fetch(`/api/tax-report/${address}?${query}`, { signal })
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

export function TaxPanel({ address, currency, onClose }: { address: string; currency: CurrencyCode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const [country, setCountry] = useState(() => readCountry(currency))
  // Nothing chosen means whatever the country calls for. Choosing another country goes back to that.
  const [chosenMethod, setChosenMethod] = useState<Method | null>(readMethod)
  const [chosenScope, setChosenScope] = useState<TaxScope | null>(readScope)
  const [othersText, setOthersText] = useState(() => localStorage.getItem(OTHERS_KEY) ?? "")
  const [report, setReport] = useState<TaxReportResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const rules = TAX_COUNTRIES[country]
  const method = chosenMethod ?? rules.method
  const scope = chosenScope ?? rules.scope
  const others = useMemo(() => othersText.split(/[\s,]+/).filter(Boolean), [othersText])
  const badOther = others.find((other) => !isAddress(other)) ?? null
  const isDemo = address === "demo"
  const also = badOther || isDemo ? "" : others.map((other) => other.toLowerCase()).join(",")

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
    const query = new URLSearchParams({ country, method, scope, currency })
    if (also) query.set("also", also)
    fetchReport(address, query, controller.signal)
      .then((next) => {
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
  }, [address, country, method, scope, currency, also, badOther])

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
          <span className="small muted">How cost is worked out</span>
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
            <dl className="tax-counts">
              <div>
                <dt className="small muted">Rows</dt>
                <dd>{report.rowCount.toLocaleString("en-US")}</dd>
              </div>
              <div>
                <dt className="small muted">Unresolved</dt>
                <dd className={report.unresolvedCount > 0 ? "warn-text" : ""}>
                  {report.unresolvedCount > 0 ? "⚠ " : ""}
                  {report.unresolvedCount.toLocaleString("en-US")}
                </dd>
              </div>
              <div>
                <dt className="small muted">Gain on known rows · {report.currency}</dt>
                <dd>{report.gainMicros === null ? <span className="warn-text">⚠ Unknown</span> : formatSignedMoney(report.gainMicros, report.currency)}</dd>
              </div>
            </dl>
            {report.warnings.map((warning) => (
              <p key={warning} className="notice warn">
                ⚠ {warning}
              </p>
            ))}
          </>
        ) : null}

        <button type="button" className="primary" disabled={!ready} onClick={() => report && download(report)}>
          {loading ? "Working it out…" : "Download CSV"}
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
