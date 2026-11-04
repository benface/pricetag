import { useEffect, useState } from "react"
import type { Method } from "@pricetag/sdk/core"
import type { Book } from "../core/book.ts"
import type { CurrencyCode } from "../core/currency.ts"
import { formatMoney, formatPrice, formatSignedMoney, formatTime } from "../core/format.ts"
import type { PricingRule, RuleComparison, RuleRow } from "../core/rules.ts"
import { RULES_HELP, RULES_TITLE, shortManifestHash } from "../core/wording.ts"

function show(micros: string | null, format: RuleRow["format"], currency: CurrencyCode): string {
  if (micros === null) return "Unavailable"
  if (format === "usdPrice") return formatPrice(micros, "USD")
  return format === "money" ? formatMoney(micros, currency) : formatSignedMoney(micros, currency)
}

/** A difference is always signed, so which way it went can be read at a glance. A price's is small, so it keeps its digits. */
function showDifference(micros: string | null, format: RuleRow["format"], currency: CurrencyCode): string {
  if (micros === null) return "—"
  if (BigInt(micros) === 0n) return "Same"
  if (format !== "usdPrice") return formatSignedMoney(micros, currency)
  const size = micros.startsWith("-") ? micros.slice(1) : micros
  return `${micros.startsWith("-") ? "-" : "+"}${formatPrice(size, "USD")}`
}

function Comparison({ address, method, currency, book }: { address: string; method: Method; currency: CurrencyCode; book: Book }) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{ comparison: RuleComparison | null; error: string | null; loading: boolean }>({ comparison: null, error: null, loading: true })

  useEffect(() => {
    const abort = new AbortController()
    setState((s) => ({ ...s, error: null, loading: true }))
    fetch(`/api/portfolio/${address}/compare`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, currency, book }), signal: abort.signal })
      .then(async (response) => {
        const body = (await response.json()) as RuleComparison | { error: string }
        if ("error" in body) throw new Error(body.error)
        setState({ comparison: body, error: null, loading: false })
      })
      .catch((error: Error) => {
        // Numbers for another moment or setting aren't kept next to a failure.
        if (!abort.signal.aborted) setState({ comparison: null, error: error instanceof TypeError ? "Can't reach the server." : error.message, loading: false })
      })
    return () => abort.abort()
  }, [address, method, currency, book, attempt])

  const { comparison, error, loading } = state
  const again = (
    <button type="button" className="link" disabled={loading} onClick={() => setAttempt((n) => n + 1)}>
      {loading ? "Reading both…" : "Compare again"}
    </button>
  )
  if (error) return <p className="notice warn">⚠ {error} {again}</p>
  if (!comparison) return <p className="muted small">Reading this wallet by both rules. The first read of each can take a minute.</p>
  const shownIn = comparison.currency as CurrencyCode
  return (
    <div className="comparison">
      <p>{comparison.why}</p>
      {comparison.warnings.map((warning) => (
        <p key={warning} className="notice warn">⚠ {warning}</p>
      ))}
      <table className="rule-table">
        <thead>
          <tr>
            <th scope="col">At block {comparison.blockNum.toLocaleString("en-US")}</th>
            <th scope="col">{comparison.a.name}</th>
            <th scope="col">{comparison.b.name}</th>
            <th scope="col">Difference</th>
          </tr>
        </thead>
        <tbody>
          {comparison.rows.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              <td>{show(row.a, row.format, shownIn)}{row.aPartial ? <span className="partial">⚠ partial</span> : null}</td>
              <td>{show(row.b, row.format, shownIn)}{row.bPartial ? <span className="partial">⚠ partial</span> : null}</td>
              <td>{showDifference(row.difference, row.format, shownIn)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {comparison.transactions.length > 0 ? (
        <>
          <h3>Transactions that came out differently</h3>
          <table className="rule-table">
            <tbody>
              {comparison.transactions.map((tx) => (
                <tr key={`${tx.txHash}:${tx.asset}:${tx.label}`}>
                  <th scope="row">
                    {tx.asset} {tx.label.toLowerCase()} <span className="muted small">{formatTime(tx.timestamp)}</span>
                  </th>
                  <td>{show(tx.a, "money", shownIn)}</td>
                  <td>{show(tx.b, "money", shownIn)}</td>
                  <td>{showDifference(tx.difference, "signed", shownIn)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {comparison.changedTxs > comparison.transactions.length ? <p className="muted small">The newest {comparison.transactions.length} of the amounts that changed, across {comparison.changedTxs.toLocaleString("en-US")} transactions.</p> : null}
        </>
      ) : null}
      {again}
    </div>
  )
}

/** The switch. `current` is what the numbers on screen were read through, which for a moment after a click isn't what was chosen. */
export function RulesPanel({ rules, chosen, choose, current, address, method, currency, book }: { rules: PricingRule[]; chosen: string | null; choose: (id: string) => void; current: string | null; address: string | null; method: Method; currency: CurrencyCode; book: Book }) {
  const [comparing, setComparing] = useState(false)
  const selected = chosen ?? rules[0]?.id
  const canCompare = address !== null && address !== "demo"
  return (
    <section className="card rules">
      <div className="card-head">
        <h2>{RULES_TITLE}</h2>
        {canCompare ? (
          <button type="button" className="link" onClick={() => setComparing((open) => !open)}>
            {comparing ? "Hide comparison" : "Compare side by side"}
          </button>
        ) : null}
      </div>
      <p className="muted small">{RULES_HELP}</p>
      <div className="rule-choices" role="radiogroup" aria-label={RULES_TITLE}>
        {rules.map((rule) => (
          <button key={rule.id} type="button" role="radio" aria-checked={rule.id === selected} className={`rule-choice ${rule.id === selected ? "on" : ""}`} onClick={() => choose(rule.id)}>
            <strong>{rule.name}</strong>
            <span className="small">{rule.summary}</span>
            <code className="small">{rule.dataset}</code>
            <code className="small" title={rule.hash}>{shortManifestHash(rule.hash)}</code>
          </button>
        ))}
      </div>
      {current !== null && current !== selected ? <p className="muted small">Reading this wallet by the new rule. The numbers below are still from the last one.</p> : null}
      {comparing && canCompare ? <Comparison key={address} address={address} method={method} currency={currency} book={book} /> : null}
    </section>
  )
}
