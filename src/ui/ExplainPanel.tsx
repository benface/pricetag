import { useLayoutEffect, useRef, useState } from "react"
import { formatPrice, formatSignedAmount, formatTime, shortHash, type CurrencyCode, type LegEffect } from "@pricetag/sdk/core"
import { describeConversion, describeEffect, describeNetting, type Explanation } from "../core/explain.ts"
import { STARTING_BALANCE, actionLabel, activityTitle, costTag, pnlHelp, priceSourceLabel } from "../core/wording.ts"
import { ProofPanel } from "./ProofPanel.tsx"

/** A busy wallet has thousands of legs, and the newest are the ones anyone reads. */
const MAX_LEGS_SHOWN = 200

function LegRow({ effect, currency, address }: { effect: LegEffect; currency: CurrencyCode; address: string }) {
  const { leg } = effect
  const [showsProof, setShowsProof] = useState(false)
  const toggleProof = () => setShowsProof((shown) => !shown)
  const incoming = BigInt(leg.delta) > 0n
  const netting = describeNetting(leg)
  const conversion = describeConversion(leg, currency)
  return (
    <li className="leg">
      <div className="leg-main">
        <strong>
          {formatSignedAmount(leg.delta, leg.decimals)} {leg.asset}
        </strong>
        <span className="muted small">
          {formatTime(leg.timestamp)} · block {leg.blockNum.toLocaleString("en-US")}
        </span>
      </div>
      <div className="leg-tags">
        <span className="tag">{leg.opening ? STARTING_BALANCE : actionLabel(leg.kind, incoming)}</span>
        {leg.opening ? null : leg.priceMicros !== null && leg.priceSource ? (
          <button type="button" className="tag tag-button" title="See where this price comes from" aria-expanded={showsProof} onClick={toggleProof}>
            {formatPrice(leg.priceMicros, currency)} · {priceSourceLabel(leg.priceSource)}
          </button>
        ) : (
          <span className="tag warn">⚠ No price</span>
        )}
        {incoming ? <span className={leg.costLabel === "unknown" ? "tag warn" : "tag"}>{leg.costLabel === "unknown" ? `⚠ ${costTag(leg.costLabel)}` : costTag(leg.costLabel)}</span> : null}
        {incoming && leg.costLabel !== "unknown" && leg.costMicros === null ? <span className="tag warn">⚠ Partly unknown</span> : null}
        {leg.estimated ? <span className="tag">≈ Estimate</span> : null}
      </div>
      <p className="small" title={pnlHelp(describeEffect(effect, currency))}>
        {describeEffect(effect, currency)}.
      </p>
      {leg.priceNote ? <p className="small muted">{leg.priceNote}</p> : null}
      {netting ? <p className="small muted">{netting}</p> : null}
      {conversion ? <p className="small muted">{conversion}</p> : null}
      {leg.opening ? null : (
        <div className="leg-links small">
          <a href={`https://basescan.org/tx/${leg.txHash}`} target="_blank" rel="noreferrer noopener">
            {shortHash(leg.txHash)} on Basescan ↗
          </a>
          <button type="button" className="link small" aria-expanded={showsProof} onClick={toggleProof}>
            Proof {showsProof ? "▾" : "▸"}
          </button>
        </div>
      )}
      {showsProof && !leg.opening ? <ProofPanel key={`${address}:${currency}`} address={address} legId={leg.id} currency={currency} /> : null}
    </li>
  )
}

export function ExplainPanel({ explanation, address, onClose }: { explanation: Explanation; address: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const close = useRef<HTMLButtonElement>(null)

  // A native modal keeps focus inside and makes the page behind it inert. Closing by unmounting doesn't restore focus.
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

  return (
    <dialog
      ref={dialog}
      className="panel"
      aria-label={explanation.title}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        // A click on the dialog itself can only be on its backdrop, because the body fills it.
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="panel-body">
        <header className="panel-head">
          <h2 title={pnlHelp(explanation.title)}>{explanation.title}</h2>
          <button ref={close} type="button" className="link" onClick={onClose}>
            Close
          </button>
        </header>
        <p className="panel-value">{explanation.value ?? <span className="unavailable">⚠ Unavailable</span>}</p>
        {explanation.sourceValue ? <p className="small muted">{explanation.sourceValue}</p> : null}
        {explanation.lines.map((line) => (
          <p key={line} className="small" title={pnlHelp(line)}>
            {line}
          </p>
        ))}
        <h3>{activityTitle(explanation.effects.length, Math.min(explanation.effects.length, MAX_LEGS_SHOWN))}</h3>
        <ul className="legs">
          {explanation.effects.slice(0, MAX_LEGS_SHOWN).map((effect) => (
            <LegRow key={effect.leg.id} effect={effect} currency={explanation.currency} address={address} />
          ))}
        </ul>
      </div>
    </dialog>
  )
}
