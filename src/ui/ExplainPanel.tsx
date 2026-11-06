import { useRef, useState } from "react"
import { formatPrice, formatSignedAmount, formatTime, shortHash, type CurrencyCode, type LegEffect } from "@pricetag/sdk/core"
import type { CombinedExplanation } from "../core/combined.ts"
import { describeConversion, describeEffect, describeNetting, priceProofKey, type Explanation } from "../core/explain.ts"
import { IN_EACH_WALLET, STARTING_BALANCE, actionLabel, activityTitle, costProof, costTag, pnlHelp, priceSourceLabel } from "../core/wording.ts"
import { MAX_LEGS } from "../core/portfolio.ts"
import { ProofPanel } from "./ProofPanel.tsx"
import { useModal } from "./useModal.ts"

/** `wallet` is which of several wallets this is in, when there are several. */
function LegRow({ effect, currency, address, wallet, rule }: { effect: LegEffect; currency: CurrencyCode; address: string; wallet: string | null; rule: string | null }) {
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
        {wallet ? <span className="tag mono">In {shortHash(wallet)}</span> : null}
        <span className="tag">{leg.opening ? STARTING_BALANCE : actionLabel(leg.kind, incoming)}</span>
        {leg.opening ? null : leg.priceMicros !== null && leg.priceSource ? (
          leg.txHash ? (
            <button type="button" className="tag tag-button" title="See where this price comes from" aria-expanded={showsProof} onClick={toggleProof}>
              {formatPrice(leg.priceMicros, currency)} · {priceSourceLabel(leg.priceSource)}
            </button>
          ) : (
            <span className="tag">
              {formatPrice(leg.priceMicros, currency)} · {priceSourceLabel(leg.priceSource)}
            </span>
          )
        ) : (
          <span className="tag warn">⚠ No price</span>
        )}
        {incoming ? <span className={leg.costLabel === "unknown" ? "tag warn" : "tag"}>{leg.costLabel === "unknown" ? `⚠ ${costTag(leg.costLabel)}` : costTag(leg.costLabel, leg.purchaseSource ?? null)}</span> : null}
        {incoming && leg.costLabel !== "unknown" && leg.costMicros === null ? <span className="tag warn">⚠ Partly unknown</span> : null}
        {leg.estimated ? <span className="tag">≈ Estimate</span> : null}
      </div>
      <p className="small" title={pnlHelp(describeEffect(effect, currency))}>
        {describeEffect(effect, currency)}.
      </p>
      {leg.priceNote ? <p className="small muted">{leg.priceNote}</p> : null}
      {netting ? <p className="small muted">{netting}</p> : null}
      {conversion ? <p className="small muted">{conversion}</p> : null}
      {leg.opening || !leg.txHash ? null : (
        <div className="leg-links small">
          <a href={`https://basescan.org/tx/${leg.txHash}`} target="_blank" rel="noreferrer noopener">
            {shortHash(leg.txHash)} on Basescan ↗
          </a>
          <button type="button" className="link small" aria-expanded={showsProof} onClick={toggleProof}>
            Proof {showsProof ? "▾" : "▸"}
          </button>
        </div>
      )}
      {showsProof && !leg.opening && leg.txHash ? <ProofPanel key={`${wallet ?? address}:${currency}:${rule}`} address={wallet ?? address} target={{ leg: leg.id }} currency={currency} rule={rule} costNote={leg.purchaseSource ? costProof(leg.purchaseSource, leg.costLabel) : null} /> : null}
    </li>
  )
}

export function ExplainPanel({ explanation, address, rule, onClose }: { explanation: Explanation | CombinedExplanation; address: string; rule: string | null; onClose: () => void }) {
  const across = "parts" in explanation ? explanation : null
  const dialog = useRef<HTMLDialogElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const [showsPriceProof, setShowsPriceProof] = useState(false)

  useModal(dialog, close)

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
        {explanation.priceProof ? (
          <>
            <div className="leg-links small">
              <button type="button" className="link small" aria-expanded={showsPriceProof} onClick={() => setShowsPriceProof((shown) => !shown)}>
                Proof of this price {showsPriceProof ? "▾" : "▸"}
              </button>
            </div>
            {showsPriceProof ? <ProofPanel key={priceProofKey(across?.priceProof?.wallet ?? address, explanation, rule)} address={across?.priceProof?.wallet ?? address} target={explanation.priceProof} currency={explanation.currency} rule={rule} /> : null}
          </>
        ) : null}
        {across && across.parts.length > 0 ? (
          <>
            <h3>{IN_EACH_WALLET}</h3>
            <ul className="wallet-parts">
              {across.parts.map(({ wallet, value, lines }) => (
                <li key={wallet}>
                  <div className="leg-main">
                    <strong className="mono">{shortHash(wallet)}</strong>
                    <span>{value ?? <span className="warn-text">⚠ Unavailable</span>}</span>
                  </div>
                  {lines.map((line) => (
                    <p key={line} className="small muted" title={pnlHelp(line)}>
                      {line}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <h3>{activityTitle(explanation.effects.length, Math.min(explanation.effects.length, MAX_LEGS))}</h3>
        <ul className="legs">
          {explanation.effects.slice(0, MAX_LEGS).map((effect) => {
            // A move between two of the wallets is the same leg in both.
            const wallet = across?.walletOf(effect.leg) || null
            return <LegRow key={`${wallet}:${effect.leg.id}`} effect={effect} currency={explanation.currency} address={address} wallet={wallet} rule={rule} />
          })}
        </ul>
      </div>
    </dialog>
  )
}
