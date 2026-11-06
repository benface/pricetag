import { useEffect, useState, type KeyboardEvent } from "react"
import { formatTime, type CurrencyCode, type Method } from "@pricetag/sdk/core"
import type { Book } from "../core/book.ts"
import { showRuleDifference, showRuleValue, type PricingRule, type RuleComparison } from "../core/rules.ts"
import { failureOf, jsonPost, readResponse, type ReadFailure } from "../core/read-failure.ts"
import { panelProblem, RULES_HELP, RULES_TITLE, shortManifestHash } from "../core/wording.ts"
import { ProblemNotice } from "./ProblemNotice.tsx"

function Comparison({ address, method, currency, book }: { address: string; method: Method; currency: CurrencyCode; book: Book }) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{ comparison: RuleComparison | null; error: ReadFailure | null; loading: boolean }>({ comparison: null, error: null, loading: true })

  useEffect(() => {
    const abort = new AbortController()
    setState((s) => ({ ...s, error: null, loading: true }))
    fetch(`/api/portfolio/${address}/compare`, jsonPost({ method, currency, book }, abort.signal))
      .then((response) => readResponse<RuleComparison>(response))
      .then((body) => setState({ comparison: body, error: null, loading: false }))
      .catch((error: unknown) => {
        // Numbers for another moment or setting aren't kept next to a failure.
        if (!abort.signal.aborted) setState({ comparison: null, error: failureOf(error), loading: false })
      })
    return () => abort.abort()
  }, [address, method, currency, book, attempt])

  const { comparison, error, loading } = state
  const again = (
    <button type="button" className="link" disabled={loading} onClick={() => setAttempt((n) => n + 1)}>
      {loading ? "Reading both…" : "Compare again"}
    </button>
  )
  if (error) return <ProblemNotice problem={panelProblem(error, location.origin)} action={again} />
  if (!comparison) return <p className="muted small" role="status">Reading this wallet by both rules. The first read of each can take a minute.</p>
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
              <td>{showRuleValue(row.a, row.format, shownIn, row.aEstimated)}{row.aPartial ? <span className="partial">⚠ partial</span> : null}</td>
              <td>{showRuleValue(row.b, row.format, shownIn, row.bEstimated)}{row.bPartial ? <span className="partial">⚠ partial</span> : null}</td>
              <td>{showRuleDifference(row.difference, row.format, shownIn, row.aEstimated || row.bEstimated)}</td>
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
                  <td>{showRuleValue(tx.a, "money", shownIn, tx.aEstimated)}</td>
                  <td>{showRuleValue(tx.b, "money", shownIn, tx.bEstimated)}</td>
                  <td>{showRuleDifference(tx.difference, "signed", shownIn, tx.aEstimated || tx.bEstimated)}</td>
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
  const selectedIndex = Math.max(0, rules.findIndex((rule) => rule.id === selected))
  /** As native radios do: one stop for Tab, and the arrow keys move between them and choose. */
  const onRadioKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[e.key]
    if (!step) return
    e.preventDefault()
    const next = (index + step + rules.length) % rules.length
    choose((rules[next] as PricingRule).id)
    ;(e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus()
  }
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
        {rules.map((rule, index) => (
          <button key={rule.id} type="button" role="radio" aria-checked={rule.id === selected} tabIndex={index === selectedIndex ? 0 : -1} onKeyDown={(e) => onRadioKey(e, index)} className={`rule-choice ${rule.id === selected ? "on" : ""}`} onClick={() => choose(rule.id)}>
            <strong>{rule.name}</strong>
            <span className="small">{rule.summary}</span>
            <code className="small">{rule.dataset}</code>
            <code className="small" title={rule.hash}>{shortManifestHash(rule.hash)}</code>
          </button>
        ))}
      </div>
      <p className="muted small" role="status">{current !== null && current !== selected ? "Reading this wallet by the new rule. The numbers below are still from the last one." : null}</p>
      {comparing && canCompare ? <Comparison key={address} address={address} method={method} currency={currency} book={book} /> : null}
    </section>
  )
}
