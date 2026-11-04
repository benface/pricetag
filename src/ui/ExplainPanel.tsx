import { useEffect, useRef } from "react"
import type { LegEffect } from "../core/portfolio.ts"
import { formatAmount, formatPrice, formatSignedAmount, formatTime, shortHash } from "./format.ts"
import { describeEffect, type Explanation } from "./explain.ts"
import { tokenByAddress } from "../core/tokens.ts"

const SOURCE_LABEL = { oracle: "oracle", swap: "swap", market: "market" } as const

function LegRow({ effect }: { effect: LegEffect }) {
  const { leg } = effect
  const incoming = BigInt(leg.delta) > 0n
  const nets = leg.parts.length > 1
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
            {formatPrice(leg.priceUsdMicros)} · {SOURCE_LABEL[leg.priceSource]}
          </span>
        ) : (
          <span className="tag warn">⚠ no price</span>
        )}
        {incoming ? <span className={leg.costLabel === "unknown" ? "tag warn" : "tag"}>{leg.costLabel === "unknown" ? "⚠ cost unknown" : `cost: ${leg.costLabel}`}</span> : null}
      </div>
      <p className="small">{describeEffect(effect)}.</p>
      {leg.priceNote ? <p className="small muted">{leg.priceNote}</p> : null}
      {nets ? (
        <p className="small muted">
          Nets {leg.parts.length} rows:{" "}
          {leg.parts
            .map((p) => {
              const token = tokenByAddress(p.token)
              return `${p.side === "credit" ? "+" : "−"}${formatAmount(p.amount, token?.decimals ?? 18)} ${token?.symbol ?? p.token}`
            })
            .join(", ")}
        </p>
      ) : null}
      <a className="small" href={`https://basescan.org/tx/${leg.txHash}`} target="_blank" rel="noreferrer noopener">
        {shortHash(leg.txHash)} on Basescan ↗
      </a>
    </li>
  )
}

export function ExplainPanel({ explanation, onClose }: { explanation: Explanation; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    close.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])
  return (
    <div className="scrim" onClick={onClose}>
      <aside className="panel" role="dialog" aria-modal="true" aria-label={explanation.title} onClick={(e) => e.stopPropagation()}>
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
        <h3>{explanation.effects.length === 1 ? "1 leg" : `${explanation.effects.length} legs`}</h3>
        <ul className="legs">
          {explanation.effects.map((effect) => (
            <LegRow key={effect.leg.id} effect={effect} />
          ))}
        </ul>
      </aside>
    </div>
  )
}
