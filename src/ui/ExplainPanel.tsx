import { useLayoutEffect, useRef } from "react"
import type { LegEffect } from "@pricetag/sdk/core"
import { formatPrice, formatSignedAmount, formatTime, shortHash } from "../core/format.ts"
import { describeEffect, describeNetting, type Explanation } from "../core/explain.ts"

/** A busy wallet has thousands of legs, and the newest are the ones anyone reads. */
const MAX_LEGS_SHOWN = 200

function LegRow({ effect }: { effect: LegEffect }) {
  const { leg } = effect
  const incoming = BigInt(leg.delta) > 0n
  const netting = describeNetting(leg)
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
        <span className="tag">{leg.kind}</span>
        {leg.priceUsdMicros !== null && leg.priceSource ? (
          <span className="tag">
            {formatPrice(leg.priceUsdMicros)} · {leg.priceSource}
          </span>
        ) : (
          <span className="tag warn">⚠ no price</span>
        )}
        {incoming ? <span className={leg.costLabel === "unknown" ? "tag warn" : "tag"}>{leg.costLabel === "unknown" ? "⚠ cost unknown" : `cost: ${leg.costLabel}`}</span> : null}
      </div>
      <p className="small">{describeEffect(effect)}.</p>
      {leg.priceNote ? <p className="small muted">{leg.priceNote}</p> : null}
      {netting ? <p className="small muted">{netting}</p> : null}
      <a className="small" href={`https://basescan.org/tx/${leg.txHash}`} target="_blank" rel="noreferrer noopener">
        {shortHash(leg.txHash)} on Basescan ↗
      </a>
    </li>
  )
}

export function ExplainPanel({ explanation, onClose }: { explanation: Explanation; onClose: () => void }) {
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
          <h2>{explanation.title}</h2>
          <button ref={close} type="button" className="link" onClick={onClose}>
            Close
          </button>
        </header>
        <p className="panel-value">{explanation.value ?? <span className="unavailable">⚠ Unavailable</span>}</p>
        {explanation.lines.map((line) => (
          <p key={line} className="small">
            {line}
          </p>
        ))}
        <h3>
          {explanation.effects.length === 1 ? "1 leg" : `${explanation.effects.length.toLocaleString("en-US")} legs`}
          {explanation.effects.length > MAX_LEGS_SHOWN ? `, newest ${MAX_LEGS_SHOWN} shown` : ""}
        </h3>
        <ul className="legs">
          {explanation.effects.slice(0, MAX_LEGS_SHOWN).map((effect) => (
            <LegRow key={effect.leg.id} effect={effect} />
          ))}
        </ul>
      </div>
    </dialog>
  )
}
