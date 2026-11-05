import { useEffect, useMemo, useRef, useState } from "react"
import { chartMoneyTicks, formatChartSpan, formatSignedMoney, formatTime, type CurrencyCode, type PnlPoint } from "@pricetag/sdk/core"
import { NOTHING_TO_CHART, PNL_HELP } from "../core/wording.ts"

const HEIGHT = 220
const MARGIN = { top: 16, right: 84, bottom: 26, left: 64 }
/** The widest a narrow chart's time gets, like "12:57:05 PM" or "12:57 AM EST", with a gap after it. */
const TIME_LABEL_ROOM = 78

type Props = { points: PnlPoint[]; currency: CurrencyCode; onSelect: (point: PnlPoint) => void }

export function PnlChart({ points, currency, onSelect }: Props) {
  const showPnl = (point: PnlPoint) => (point.pnlMicros === null ? "⚠ Unavailable" : formatSignedMoney(point.pnlMicros, currency))
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(720)
  const [active, setActive] = useState<number | null>(null)
  const [asTable, setAsTable] = useState(false)

  useEffect(() => {
    if (!box.current) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 720))
    observer.observe(box.current)
    return () => observer.disconnect()
  }, [])

  const chart = useMemo(() => {
    const times = points.map((p) => new Date(p.timestamp).getTime())
    const values = points.map((p) => (p.pnlMicros === null ? null : Number(p.pnlMicros) / 1e6))
    const known = values.filter((v) => v !== null)
    const ticks = chartMoneyTicks(known, currency)
    const low = ticks[0]?.value ?? 0
    const high = ticks[ticks.length - 1]?.value ?? 1
    const start = times[0] ?? 0
    const end = times[times.length - 1] ?? 1
    const plotWidth = Math.max(40, width - MARGIN.left - MARGIN.right)
    const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom
    const x = (t: number) => MARGIN.left + (end === start ? plotWidth : ((t - start) / (end - start)) * plotWidth)
    const y = (v: number) => MARGIN.top + (1 - (v - low) / (high - low || 1)) * plotHeight
    // PnL holds still between transactions in this series, so it's drawn as steps. Where it's unavailable, the line
    // stops rather than passing through $0.
    let path = ""
    let drawing = false
    values.forEach((value, i) => {
      const px = x(times[i] as number)
      if (value === null) {
        if (drawing) path += `H${px}`
        drawing = false
        return
      }
      path += drawing ? `H${px}V${y(value)}` : `M${px},${y(value)}`
      drawing = true
    })
    return { times, values, ticks, x, y, path, plotWidth, hasData: known.length > 0 }
  }, [points, width, currency])

  const nearest = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect()
    if (!rect) return null
    const px = clientX - rect.left
    let best = 0
    let bestDistance = Infinity
    chart.times.forEach((t, i) => {
      const distance = Math.abs(chart.x(t) - px)
      if (distance < bestDistance) {
        best = i
        bestDistance = distance
      }
    })
    return best
  }

  const point = active === null ? null : (points[active] ?? null)
  const last = points[points.length - 1]
  const lastValue = chart.values[points.length - 1]
  const narrow = width < 520
  const [firstTime, lastTime] = formatChartSpan(points[0]?.timestamp ?? "", last?.timestamp ?? "", narrow)
  // Everything at one moment only needs saying once, and that's at the end of the axis.
  const xLabels = points.length === 0 ? [] : firstTime === lastTime ? [{ index: points.length - 1, text: lastTime }] : [{ index: 0, text: firstTime }, { index: points.length - 1, text: lastTime }]
  const showMarkers = points.length <= 60

  return (
    <section className="card">
      <div className="card-head">
        <h2 title={PNL_HELP}>PnL over time</h2>
        <button type="button" className="link" onClick={() => setAsTable((v) => !v)}>
          {asTable ? "Show chart" : "Show table"}
        </button>
      </div>
      <p className="muted small" title={PNL_HELP}>
        After each transaction: realized PnL, plus unrealized PnL where there's a price at that moment, less network fees. Unknown costs add nothing.
      </p>
      {asTable ? (
        <table className="table compact">
          <thead>
            <tr>
              <th>Time</th>
              <th className="num" title={PNL_HELP}>
                PnL
              </th>
              <th className="num">Excludes</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={`${p.blockNum}-${p.txHash ?? "latest"}`}>
                <td>
                  {p.txHash ? (
                    <button type="button" className="num-button" aria-label={`Explain the transaction at ${formatTime(p.timestamp)}`} onClick={() => onSelect(p)}>
                      {formatTime(p.timestamp)}
                    </button>
                  ) : (
                    `${formatTime(p.timestamp)} (now)`
                  )}
                </td>
                <td className="num" title={PNL_HELP}>
                  {showPnl(p)}
                </td>
                <td className="num">{p.excludedCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {!asTable && !chart.hasData ? <p className="notice warn chart-empty">⚠ {NOTHING_TO_CHART}</p> : null}
      <div
        ref={box}
        className="chart"
        hidden={asTable || !chart.hasData}
        onPointerMove={(e) => setActive(nearest(e.clientX))}
        onPointerLeave={() => setActive(null)}
        onClick={(e) => {
          const i = nearest(e.clientX)
          const selected = i === null ? null : points[i]
          if (selected?.txHash) onSelect(selected)
        }}
      >
        <svg width={width} height={HEIGHT} role="img" aria-label="Total PnL after each transaction">
          {chart.ticks.map((tick) => (
            <g key={tick.value}>
              <line x1={MARGIN.left} x2={MARGIN.left + chart.plotWidth} y1={chart.y(tick.value)} y2={chart.y(tick.value)} className={tick.value === 0 ? "axis-zero" : "grid"} />
              <text x={MARGIN.left - 8} y={chart.y(tick.value)} dy="0.32em" textAnchor="end" className="tick">
                {tick.label}
              </text>
            </g>
          ))}
          {xLabels.map(({ index, text }) => {
            const end = chart.x(chart.times[points.length - 1] as number)
            const isLast = index === points.length - 1
            // A narrow chart can't fit both times under the line, so the last one starts at its point and runs into the margin.
            return (
              <text key={index} x={isLast ? end : Math.max(0, Math.min(chart.x(chart.times[index] as number), end - TIME_LABEL_ROOM))} y={HEIGHT - 6} textAnchor={isLast && !narrow ? "end" : "start"} className="tick">
                {text}
              </text>
            )
          })}
          <path d={chart.path} className="line" />
          {showMarkers
            ? points.map((p, i) => {
                const value = chart.values[i]
                return value === null || value === undefined ? null : <circle key={`${p.blockNum}-${i}`} cx={chart.x(chart.times[i] as number)} cy={chart.y(value)} r={4} className="dot" />
              })
            : null}
          {last && lastValue !== null && lastValue !== undefined ? (
            <text x={chart.x(chart.times[points.length - 1] as number) + 10} y={chart.y(lastValue)} dy="0.32em" className="end-label">
              {showPnl(last)}
            </text>
          ) : null}
          {active !== null ? <line x1={chart.x(chart.times[active] as number)} x2={chart.x(chart.times[active] as number)} y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom} className="crosshair" /> : null}
        </svg>
        {point && active !== null ? (
          <div
            className="tooltip"
            style={{
              left: Math.min(chart.x(chart.times[active] as number) + 10, width - 210),
              top: 8,
            }}
          >
            <strong>{showPnl(point)}</strong>
            <span>{formatTime(point.timestamp)}</span>
            {point.excludedCount > 0 ? <span>⚠ Leaves out {point.excludedCount} unknown {point.excludedCount === 1 ? "amount" : "amounts"}</span> : null}
            {point.txHash ? <span className="muted">Click to see this transaction</span> : <span className="muted">Now, at current prices</span>}
          </div>
        ) : null}
      </div>
    </section>
  )
}
