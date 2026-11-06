import { formatMoney, formatSignedMoney, type CurrencyCode, type HoldComparison, type PnlStatus, type Totals } from "@pricetag/sdk/core"
import { isValuePartial, valueGaps, type Attention } from "../core/attention.ts"
import type { TotalMetric } from "../core/explain.ts"
import { HOLD_PAST, HOLD_TITLE, NETWORK_FEES, PNL_HELP, REALIZED_HELP, SHOW_MISSING, UNAVAILABLE, UNREALIZED_HELP, answerQuestionsLabel, holdCaveatSentence, holdSummarySentence, pnlHelp, valueGapsSentence, est } from "../core/wording.ts"
import type { Holding } from "./Holdings.tsx"
import { Num, toneOf } from "./Num.tsx"

/** The headline numbers. Each one opens how it's worked out. */
export function Summary({ totals, positions, unread, pnlStatus, currency, openTotal }: { totals: Totals; positions: readonly Holding[]; unread: readonly string[]; pnlStatus: PnlStatus | null; currency: CurrencyCode; openTotal: (metric: TotalMetric) => void }) {
  return (
    <section className="summary">
      <div className="lead">
        <div title={isValuePartial(totals) ? valueGapsSentence(valueGaps(positions, unread)) : undefined}>
          <span className="muted small">Value · {currency}</span>
          <Num label={`Value${isValuePartial(totals) ? ", partial" : ""}`} onClick={() => openTotal("value")} tone={totals.valueMicros === null ? "quiet" : null}>
            <span className="big">{totals.valueMicros === null ? UNAVAILABLE : est(formatMoney(totals.valueMicros, currency), totals.estimated.value)}</span>
          </Num>
        </div>
        <div>
          <span className="muted small" title={PNL_HELP}>
            Total PnL
          </span>
          <Num label={`Total PnL${pnlStatus === "partial" ? ", partial" : ""}`} onClick={() => openTotal("pnl")} tone={toneOf(totals.pnlMicros)}>
            <span className="second">{totals.pnlMicros === null ? UNAVAILABLE : est(formatSignedMoney(totals.pnlMicros, currency), BigInt(totals.estimatedMicros) > 0n)}</span>
          </Num>
        </div>
      </div>
      <dl className="stats">
        <Stat label="Realized" help={REALIZED_HELP} partial={totals.coverage.realized.missing > 0} onClick={() => openTotal("realized")} value={totals.realizedMicros && est(formatSignedMoney(totals.realizedMicros, currency), totals.estimated.realized)} />
        <Stat label="Unrealized" help={UNREALIZED_HELP} partial={totals.coverage.unrealized.missing > 0} onClick={() => openTotal("unrealized")} value={totals.unrealizedMicros && est(formatSignedMoney(totals.unrealizedMicros, currency), totals.estimated.unrealized)} />
        <Stat label={NETWORK_FEES} partial={totals.unpricedGas} onClick={() => openTotal("gas")} value={totals.gasMicros && formatMoney(totals.gasMicros, currency)} />
      </dl>
    </section>
  )
}

/** One of the sums beside the headline. What it leaves out is said once, under the headline. */
function Stat({ label, help, partial, onClick, value }: { label: string; help?: string; partial: boolean; onClick: () => void; value: string | null }) {
  return (
    <div>
      <dt className="muted small" title={help}>
        {label}
      </dt>
      <dd>
        <Num label={`${label}${value !== null && partial ? ", partial" : ""}`} onClick={onClick} tone={value === null ? "quiet" : null}>
          {value ?? UNAVAILABLE}
        </Num>
      </dd>
    </div>
  )
}

/** What the numbers above leave out, once, in a sentence, with what to do about it. The full list is a hover or a click away. */
export function AttentionBox({ attention, questionCount, onResolve, onShow }: { attention: Attention; questionCount: number; onResolve: () => void; onShow: () => void }) {
  return (
    <section className="attention" title={attention.fullList ?? undefined}>
      <span className="attention-mark" role="img" aria-label="Warning">⚠</span>
      <div className="attention-text">
        <p title={pnlHelp(attention.title)}>{attention.title}</p>
        {attention.details.map((line) => (
          <p key={line} className="muted small" title={pnlHelp(line)}>
            {line}
          </p>
        ))}
      </div>
      {questionCount > 0 ? (
        <button type="button" className="quiet-button" onClick={onResolve}>
          {answerQuestionsLabel(questionCount)}
        </button>
      ) : (
        <button type="button" className="quiet-button" onClick={onShow}>
          {SHOW_MISSING}
        </button>
      )}
    </section>
  )
}

/** Questions that remain when the numbers above leave nothing out. Nothing's wrong, so there's no warning, but they can still be answered. */
export function PastCostsLine({ note, questionCount, onResolve }: { note: string; questionCount: number; onResolve: () => void }) {
  return (
    <section className="attention">
      <p className="attention-text muted">{note}</p>
      <button type="button" className="quiet-button" onClick={onResolve}>
        {answerQuestionsLabel(questionCount)}
      </button>
    </section>
  )
}

/** This wallet next to simply holding ETH, in a line. Calm on purpose: no colors for ahead or behind, and it asks nothing of anyone. Clicking it shows the numbers and how they're worked out. */
export function HoldLine({ comparison, combined, currency, onOpen }: { comparison: HoldComparison; combined: boolean; currency: CurrencyCode; onOpen: () => void }) {
  // The fine print, a hover or a click away.
  const fine = [holdCaveatSentence(comparison, currency, { combined }), comparison.status === "unavailable" ? null : HOLD_PAST].filter((part) => part !== null).join(" ")
  return (
    <button type="button" className="hold-line" title={fine} aria-label={`${HOLD_TITLE}. ${holdSummarySentence(comparison, currency)} Shows how this is worked out`} onClick={onOpen}>
      <span>{HOLD_TITLE}</span>
      <span className="muted">{holdSummarySentence(comparison, currency)}</span>
      <span className="muted" aria-hidden="true">›</span>
    </button>
  )
}
