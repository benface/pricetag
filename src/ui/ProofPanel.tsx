import { useEffect, useState } from "react"
import type { CurrencyCode } from "@pricetag/sdk/core"
import type { CheckStatus, ProofResponse, VerificationResponse } from "../core/api.ts"
import { ReadError, failureOf, readResponse, type ReadFailure } from "../core/read-failure.ts"
import { panelProblem } from "../core/wording.ts"
import { ProblemNotice } from "./ProblemNotice.tsx"

const MARKS: Record<CheckStatus, string> = { passed: "✓", failed: "✕", unchecked: "?" }
const STATUS_LABELS: Record<CheckStatus, string> = { passed: "Passed", failed: "Failed", unchecked: "Not checked" }

/** The server's price or update isn't the one this panel is about. */
class PriceChanged extends ReadError {}

async function read<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal })
  try {
    return await readResponse<T>(response)
  } catch (error) {
    throw response.status === 412 && error instanceof ReadError ? new PriceChanged(error.failure) : error
  }
}

/** Where a row's or a current price comes from, the datasets behind it, and a check of its block that says plainly what it doesn't cover. */
export function ProofPanel({ address, target, currency, rule, costNote = null }: { address: string; target: { leg: string } | { asset: string; price: string }; currency: CurrencyCode; rule: string | null; costNote?: string | null }) {
  const subject = "leg" in target ? `leg=${encodeURIComponent(target.leg)}` : `asset=${encodeURIComponent(target.asset)}`
  const query = `${subject}&currency=${currency}${rule ? `&rule=${encodeURIComponent(rule)}` : ""}`
  const price = "price" in target ? `&price=${encodeURIComponent(target.price)}` : ""
  const [proof, setProof] = useState<ProofResponse | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [failure, setFailure] = useState<ReadFailure | null>(null)
  const [verification, setVerification] = useState<VerificationResponse | null>(null)
  const [verifyFailure, setVerifyFailure] = useState<ReadFailure | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [reads, setReads] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setFailure(null)
    read<ProofResponse>(`/api/portfolio/${address}/proof?${query}${price}`, controller.signal)
      .then(setProof)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setFailure(failureOf(error))
      })
    return () => controller.abort()
  }, [address, query, price, reads, attempt])

  async function verify() {
    setVerifying(true)
    try {
      const revision = proof?.revision ? `&revision=${encodeURIComponent(proof.revision)}` : ""
      setVerification(await read<VerificationResponse>(`/api/portfolio/${address}/verify?${query}${revision}`))
      setVerifyFailure(null)
    } catch (error) {
      setVerification(null)
      setVerifyFailure(failureOf(error))
      if (error instanceof PriceChanged) {
        setProof(null)
        setReads((count) => count + 1)
      }
    } finally {
      setVerifying(false)
    }
  }

  if (failure) {
    const again = (
      <button type="button" className="link" onClick={() => setAttempt((n) => n + 1)}>
        Try again
      </button>
    )
    return (
      <div className="proof small">
        <ProblemNotice problem={panelProblem(failure, location.origin)} action={again} className="warn-text" />
      </div>
    )
  }
  if (!proof) return <div className="proof small muted" role="status">Reading…</div>
  return (
    <div className="proof small">
      <div>
        <h4>Where this price comes from</h4>
        {proof.source.map((line) => (
          <p key={line}>{line}</p>
        ))}
        {proof.movements.map((line) => (
          <p key={line} className="muted">
            {line}
          </p>
        ))}
        {proof.links.map((link) => (
          <p key={link.url}>
            <a href={link.url} target="_blank" rel="noreferrer noopener">
              {link.title} ↗
            </a>
          </p>
        ))}
      </div>
      {costNote ? (
        <div>
          <h4>Where its cost comes from</h4>
          <p>{costNote}</p>
        </div>
      ) : null}
      {proof.datasets.length > 0 ? (
        <div>
          <h4>The recipe</h4>
          <ul>
            {proof.datasets.map((dataset) => (
              <li key={dataset.name}>
                {dataset.title}: {dataset.name}
                {dataset.hash ? (
                  <div className="hash muted" title="Its fingerprint">
                    {dataset.hash}
                  </div>
                ) : (
                  <div className="warn-text">⚠ Its fingerprint couldn't be read.</div>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {proof.unavailable ? (
        <p className="muted">{proof.unavailable}</p>
      ) : (
        <>
          <button type="button" className="verify" disabled={verifying} onClick={() => void verify()}>
            {verifying ? "Checking this block…" : verification ? "Verify again" : `Verify block ${proof.blockNum.toLocaleString("en-US")}`}
          </button>
          {verifyFailure ? <ProblemNotice problem={panelProblem(verifyFailure, location.origin)} className="warn-text" /> : null}
          {verification ? (
            <div>
              <p className={`proof-result ${verification.status}`} role="status">{verification.summary}</p>
              <ul>
                {verification.checks.map((check) => (
                  <li key={check.title} className={`check ${check.status}`}>
                    <span className="check-mark" role="img" aria-label={STATUS_LABELS[check.status]}>
                      {MARKS[check.status]}
                    </span>
                    <span>
                      <strong>{check.title}.</strong> {check.detail}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
      {proof.scope.map((line) => (
        <p key={line} className="muted">
          {line}
        </p>
      ))}
    </div>
  )
}
