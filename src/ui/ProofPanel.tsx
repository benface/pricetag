import { useEffect, useState } from "react"
import type { CurrencyCode } from "@pricetag/sdk/core"
import type { CheckStatus, ProofResponse, VerificationResponse } from "../core/api.ts"

const MARKS: Record<CheckStatus, string> = { passed: "✓", failed: "✕", unchecked: "?" }
const STATUS_LABELS: Record<CheckStatus, string> = { passed: "Passed", failed: "Failed", unchecked: "Not checked" }

/** The server's price or update isn't the one this panel is about. */
class PriceChanged extends Error {}

async function read<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal })
  if (response.ok) return (await response.json()) as T
  const body = (await response.json().catch(() => null)) as { error?: string } | null
  const message = body?.error ?? "Couldn't reach the server."
  throw response.status === 412 ? new PriceChanged(message) : new Error(message)
}

/** Where a row's or a current price comes from, the datasets behind it, and a check of its block that says plainly what it doesn't cover. */
export function ProofPanel({ address, target, currency, rule }: { address: string; target: { leg: string } | { asset: string; price: string }; currency: CurrencyCode; rule: string | null }) {
  const subject = "leg" in target ? `leg=${encodeURIComponent(target.leg)}` : `asset=${encodeURIComponent(target.asset)}`
  const query = `${subject}&currency=${currency}${rule ? `&rule=${encodeURIComponent(rule)}` : ""}`
  const price = "price" in target ? `&price=${encodeURIComponent(target.price)}` : ""
  const [proof, setProof] = useState<ProofResponse | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [verification, setVerification] = useState<VerificationResponse | null>(null)
  const [verifyFailure, setVerifyFailure] = useState<string | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [reads, setReads] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    read<ProofResponse>(`/api/portfolio/${address}/proof?${query}${price}`, controller.signal)
      .then(setProof)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : "Couldn't reach the server.")
      })
    return () => controller.abort()
  }, [address, query, price, reads])

  async function verify() {
    setVerifying(true)
    try {
      const revision = proof?.revision ? `&revision=${encodeURIComponent(proof.revision)}` : ""
      setVerification(await read<VerificationResponse>(`/api/portfolio/${address}/verify?${query}${revision}`))
      setVerifyFailure(null)
    } catch (error) {
      setVerification(null)
      setVerifyFailure(error instanceof Error ? error.message : "Couldn't reach the server.")
      if (error instanceof PriceChanged) {
        setProof(null)
        setReads((count) => count + 1)
      }
    } finally {
      setVerifying(false)
    }
  }

  if (failure) return <div className="proof small warn-text">⚠ {failure}</div>
  if (!proof) return <div className="proof small muted">Reading…</div>
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
      {proof.datasets.length > 0 ? (
        <div>
          <h4>The recipe</h4>
          <ul>
            {proof.datasets.map((dataset) => (
              <li key={dataset.name}>
                {dataset.title}: {dataset.name}
                {dataset.hash ? (
                  <div className="hash muted" title="This dataset's fingerprint">
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
          {verifyFailure ? <p className="warn-text">⚠ {verifyFailure}</p> : null}
          {verification ? (
            <div>
              <p className={`proof-result ${verification.status}`}>{verification.summary}</p>
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
