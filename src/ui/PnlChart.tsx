import { useEffect, useMemo, useRef, useState } from "react"
import type { PnlPoint } from "../core/portfolio.ts"
import { formatSignedUsd, formatTime } from "./format.ts"

const HEIGHT = 220
const MARGIN = { top: 16, right: 84, bottom: 26, left: 64 }

function niceTicks(min: number, max: number, count = 4): number[] {
  const span = max - min || 1
  const raw = span / count
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw
  const ticks: number[] = []
  for (let v = Math.floor(min / step) * step; v <= Math.ceil(max / step) * step + step / 2; v += step) ticks.push(Number(v.toFixed(8)))
  return ticks
}

const compactUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 })

type Props = { points: PnlPoint[]; onSelect: (point: PnlPoint) => void }

export function PnlChart({ points, onSelect }: Props) {
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
    const values = points.map((p) => Number(p.pnlUsdMicros) / 1e6)
    const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values))
    const low = ticks[0] ?? 0
    const high = ticks[ticks.length - 1] ?? 1
    const start = times[0] ?? 0
    const end = times[times.length - 1] ?? 1
    const plotWidth = Math.max(40, width - MARGIN.left - MARGIN.right)
    const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom
    const x = (t: number) => MARGIN.left + (end === start ? plotWidth : ((t - start) / (end - start)) * plotWidth)
    const y = (v: number) => MARGIN.top + (1 - (v - low) / (high - low || 1)) * plotHeight
    // PnL holds still between transactions in this series, so it's drawn as steps.
    const path = points
      .map((_, i) => {
        const px = x(times[i] as number)
        const py = y(values[i] as number)
        return i === 0 ? `M${px},${py}` : `H${px}V${py}`
      })
      .join("")
    return { times, values, ticks, x, y, path, plotWidth }
  }, [points, width])

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
  const xLabels = points.length > 1 ? [0, points.length - 1] : [0]
  const showMarkers = points.length <= 60

  return (
    <section className="card">
      <div className="card-head">
        <h2>PnL over time</h2>
        <button type="button" className="link" onClick={() => setAsTable((v) => !v)}>
          {asTable ? "Show chart" : "Show table"}
        </button>
      </div>
      <p className="muted small">After each transaction: realized PnL, plus unrealized PnL where there's a price at that moment, less gas. Unknown costs add nothing.</p>
      {asTable ? (
        <table className="table compact">
          <thead>
            <tr>
              <th>Time</th>
              <th>Block</th>
              <th className="num">PnL</th>
              <th className="num">Excludes</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={`${p.blockNum}-${p.txHash ?? "latest"}`}>
                <td>{formatTime(p.timestamp)}</td>
                <td>{p.blockNum.toLocaleString("en-US")}</td>
                <td className="num">{formatSignedUsd(p.pnlUsdMicros)}</td>
                <td className="num">{p.excludedCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <div
        ref={box}
        className="chart"
        hidden={asTable}
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
            <g key={tick}>
              <line x1={MARGIN.left} x2={MARGIN.left + chart.plotWidth} y1={chart.y(tick)} y2={chart.y(tick)} className={tick === 0 ? "axis-zero" : "grid"} />
              <text x={MARGIN.left - 8} y={chart.y(tick)} dy="0.32em" textAnchor="end" className="tick">
                {compactUsd.format(tick)}
              </text>
            </g>
          ))}
          {xLabels.map((i) => (
            <text key={i} x={chart.x(chart.times[i] as number)} y={HEIGHT - 6} textAnchor={i === 0 ? "start" : "end"} className="tick">
              {formatTime((points[i] as PnlPoint).timestamp)}
            </text>
          ))}
          <path d={chart.path} className="line" />
          {showMarkers
            ? points.map((p, i) => <circle key={`${p.blockNum}-${i}`} cx={chart.x(chart.times[i] as number)} cy={chart.y(chart.values[i] as number)} r={4} className="dot" />)
            : null}
          {points.length > 0 ? (
            <text x={chart.x(chart.times[points.length - 1] as number) + 10} y={chart.y(chart.values[points.length - 1] as number)} dy="0.32em" className="end-label">
              {compactUsd.format(chart.values[points.length - 1] as number)}
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
            <strong>{formatSignedUsd(point.pnlUsdMicros)}</strong>
            <span>{formatTime(point.timestamp)}</span>
            <span>Block {point.blockNum.toLocaleString("en-US")}</span>
            {point.excludedCount > 0 ? <span>⚠ Excludes {point.excludedCount} unknown {point.excludedCount === 1 ? "item" : "items"}</span> : null}
            {point.txHash ? <span className="muted">Click to see this transaction</span> : <span className="muted">Now, at current prices</span>}
          </div>
        ) : null}
      </div>
    </section>
  )
}
