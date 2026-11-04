import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react"
import { isAddress, type WalletResponse } from "../core/api.ts"
import type { Method } from "../core/fold.ts"
import { foldPositions, hasAnswer, pnlOverTime, sumTotals, type Coverage, type Exclusion, type PnlPoint, type Position } from "../core/portfolio.ts"
import { ExplainPanel } from "./ExplainPanel.tsx"
import { explainMetric, explainTotal, type Explanation, type Metric, type TotalMetric } from "./explain.ts"
import { formatAmount, formatDuration, formatPrice, formatSignedUsd, formatUsd, shortHash } from "./format.ts"
import { PnlChart } from "./PnlChart.tsx"
import { useWallet } from "./useWallet.ts"

function readAddress(): string | null {
  const value = new URLSearchParams(window.location.search).get("address")
  return value && (value === "demo" || isAddress(value)) ? value : null
}

function Num({ onClick, label, children, tone }: { onClick: () => void; label: string; children: ReactNode; tone?: "gain" | "loss" | "warn" | null }) {
  return (
    <button type="button" className={`num-button ${tone ?? ""}`} onClick={onClick} aria-label={label}>
      {children}
    </button>
  )
}

const toneOf = (micros: string | null) => (micros === null ? "warn" : BigInt(micros) > 0n ? "gain" : BigInt(micros) < 0n ? "loss" : null)

function describeExcluded(excluded: readonly Exclusion[]): string {
  const byReason = new Map<string, string[]>()
  for (const { asset, reason } of excluded) byReason.set(reason, [...(byReason.get(reason) ?? []), asset])
  return [...byReason.entries()].map(([reason, assets]) => `${assets.join(", ")} (${reason})`).join("; ")
}

function Holdings({ positions, onExplain }: { positions: Position[]; onExplain: (e: Explanation) => void }) {
  const open = (position: Position, metric: Metric) => () => onExplain(explainMetric(position, metric))
  return (
    <section className="card">
      <h2>Holdings</h2>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Asset</th>
              <th className="num">Amount</th>
              <th className="num">Avg cost</th>
              <th className="num">Value</th>
              <th className="num">Realized</th>
              <th className="num">Unrealized</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((position) => {
              const { asset, decimals, values, state } = position
              const held = BigInt(values.qty) > 0n
              const unknown = BigInt(values.unknownCostQty) > 0n
              return (
                <tr key={asset} className={held ? "" : "closed"}>
                  <td>
                    <strong>{asset}</strong>
                    {asset === "ETH" ? <span className="muted small"> incl. WETH</span> : null}
                  </td>
                  <td className="num">
                    <Num label={`${asset} amount`} onClick={open(position, "amount")} tone={BigInt(state.shortfallQty) > 0n ? "warn" : null}>
                      {BigInt(state.shortfallQty) > 0n ? "⚠ " : ""}
                      {formatAmount(values.qty, decimals)}
                    </Num>
                  </td>
                  <td className="num">
                    {held ? (
                      <Num label={`${asset} average cost`} onClick={open(position, "average")} tone={unknown ? "warn" : null}>
                        {values.averageCostUsdMicros ? formatPrice(values.averageCostUsdMicros) : "⚠ Unknown"}
                      </Num>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="num">
                    {held ? (
                      <Num label={`${asset} value`} onClick={open(position, "value")} tone={values.valueUsdMicros === null ? "warn" : null}>
                        {values.valueUsdMicros ? formatUsd(values.valueUsdMicros) : "⚠ No price"}
                      </Num>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="num">
                    <Num label={`${asset} realized PnL`} onClick={open(position, "realized")} tone={toneOf(values.realizedUsdMicros)}>
                      {values.realizedUsdMicros === null ? "⚠ PnL unavailable" : formatSignedUsd(values.realizedUsdMicros)}
                    </Num>
                  </td>
                  <td className="num">
                    {held ? (
                      <Num label={`${asset} unrealized PnL`} onClick={open(position, "unrealized")} tone={toneOf(values.unrealizedUsdMicros)}>
                        {values.unrealizedUsdMicros === null ? "⚠ PnL unavailable" : formatSignedUsd(values.unrealizedUsdMicros)}
                      </Num>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export function App() {
  const [address, setAddress] = useState(readAddress)
  const [input, setInput] = useState(() => (readAddress() === "demo" ? "" : (readAddress() ?? "")))
  const [inputError, setInputError] = useState<string | null>(null)
  const [method, setMethod] = useState<Method>("average")
  const [explanation, setExplanation] = useState<Explanation | null>(null)
  const { wallet, loading, error } = useWallet(address)

  useEffect(() => {
    const onPop = () => setAddress(readAddress())
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  const go = (next: string) => {
    window.history.pushState(null, "", `?address=${next}`)
    setAddress(next)
    setExplanation(null)
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const value = input.trim()
    if (!isAddress(value)) {
      setInputError("That isn't a Base address. It should be 0x followed by 40 hex characters.")
      return
    }
    setInputError(null)
    go(value.toLowerCase())
  }

  const positions = useMemo(() => (wallet ? foldPositions(wallet.legs, method, wallet.prices) : []), [wallet, method])
  const totals = useMemo(() => sumTotals(positions), [positions])
  const points = useMemo(() => (wallet ? pnlOverTime(wallet.legs, method, wallet.prices, wallet.references, wallet.latest) : []), [wallet, method])
  const close = useCallback(() => setExplanation(null), [])
  const openTotal = (metric: TotalMetric) => setExplanation(explainTotal(positions, totals, metric))
  const openPoint = (point: PnlPoint) => {
    const effects = positions.flatMap((p) => p.effects).filter((e) => e.leg.txHash === point.txHash)
    setExplanation({
      title: `Transaction ${shortHash(point.txHash as string)}`,
      value: point.pnlUsdMicros && formatSignedUsd(point.pnlUsdMicros),
      lines: [`Total PnL after this transaction.${point.excludedCount > 0 ? ` Leaves out ${point.excludedCount} unknown ${point.excludedCount === 1 ? "amount" : "amounts"}.` : ""}`],
      effects,
    })
  }

  return (
    <div className="page">
      <header className="top">
        <a className="brand" href="/">
          Pricetag
        </a>
        <form className="address" onSubmit={submit}>
          <input
            aria-label="Base address"
            placeholder="Paste any Base address, 0x…"
            value={input}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setInput(e.target.value)}
          />
          <button type="submit">Look up</button>
        </form>
        {wallet ? <LiveBadge wallet={wallet} stale={error !== null} /> : null}
      </header>
      {inputError ? <p className="notice warn">⚠ {inputError}</p> : null}

      {!address ? (
        <section className="empty">
          <h1>Every transfer gets a price.</h1>
          <p>Paste a Base address to see its holdings, cost and PnL, with every number explained. This is watch-only: there are no keys here, and nothing is signed.</p>
          <button type="button" onClick={() => go("demo")}>
            Try the demo wallet
          </button>
        </section>
      ) : null}

      {loading ? (
        <section className="empty">
          <p>Reading this wallet's history from Amp. The first read can take a minute, then only new blocks are read.</p>
        </section>
      ) : null}

      {!wallet && error ? <p className="notice warn">⚠ {error}</p> : null}

      {wallet ? (
        <main>
          {error ? <p className="notice warn">⚠ {error} These numbers are through block {wallet.coverage.toBlock.toLocaleString("en-US")} and aren't updating.</p> : null}
          {isBehind(wallet) ? (
            <p className="notice warn">
              ⚠{" "}
              {hasStarted(wallet)
                ? `The Pricetag dataset has only processed up to block ${wallet.coverage.toBlock.toLocaleString("en-US")}, ${(wallet.latest.blockNum - wallet.coverage.toBlock).toLocaleString("en-US")} blocks behind the chain. Anything after that isn't in these numbers yet.`
                : `The Pricetag dataset hasn't reached block ${wallet.coverage.fromBlock.toLocaleString("en-US")} yet, so there's nothing to show for this wallet so far.`}
            </p>
          ) : null}
          {wallet.mode === "demo" ? <p className="notice">Demo data, not a real wallet. Every case the app has to get right is in here.</p> : null}
          {hasStarted(wallet) ? (
            <p className="notice">
              Covers blocks {wallet.coverage.fromBlock.toLocaleString("en-US")} to {wallet.coverage.toBlock.toLocaleString("en-US")} (about {formatDuration(wallet.coverage.toBlock - wallet.coverage.fromBlock)}) and 10 tokens plus ETH. Anything earlier or
              off the list isn't counted, so amounts are what moved in this window, not full balances.
            </p>
          ) : null}
          {wallet.gasUnknownTxs.length > 0 ? <p className="notice warn">⚠ Gas couldn't be worked out for {wallet.gasUnknownTxs.length} transactions, so ETH is overstated by that much.</p> : null}

          {wallet.legs.length === 0 && !hasStarted(wallet) ? null : wallet.legs.length === 0 ? (
            <section className="empty">
              <p>
                No movements for <code>{wallet.address}</code> in these blocks.
              </p>
            </section>
          ) : (
            <>
              <section className="summary">
                <div className="headline">
                  <span className="muted small">Total PnL</span>
                  <Num label="Total PnL" onClick={() => openTotal("pnl")} tone={toneOf(totals.pnlUsdMicros)}>
                    <span className="big">{totals.pnlUsdMicros === null ? "⚠ Unavailable" : formatSignedUsd(totals.pnlUsdMicros)}</span>
                  </Num>
                  {totals.excluded.length > 0 ? (
                    <p className="excluded">⚠ Excludes {describeExcluded(totals.excluded)}.</p>
                  ) : (
                    <p className="muted small">Nothing excluded.</p>
                  )}
                  {totals.unpricedGas ? <p className="excluded">⚠ Some gas had no price at its block, and isn't in this total.</p> : null}
                </div>
                <dl className="stats">
                  <Stat label="Value" onClick={() => openTotal("value")} coverage={totals.coverage.value} value={totals.valueUsdMicros && formatUsd(totals.valueUsdMicros)} />
                  <Stat label="Realized" onClick={() => openTotal("realized")} coverage={totals.coverage.realized} value={totals.realizedUsdMicros && formatSignedUsd(totals.realizedUsdMicros)} />
                  <Stat label="Unrealized" onClick={() => openTotal("unrealized")} coverage={totals.coverage.unrealized} value={totals.unrealizedUsdMicros && formatSignedUsd(totals.unrealizedUsdMicros)} />
                  <Stat label="Gas paid" onClick={() => openTotal("gas")} coverage={{ known: 1, missing: totals.unpricedGas ? 1 : 0 }} value={totals.gasUsdMicros && formatUsd(totals.gasUsdMicros)} />
                </dl>
                <div className="method" role="group" aria-label="Cost method">
                  {(["average", "fifo"] as const).map((m) => (
                    <button key={m} type="button" className={method === m ? "on" : ""} aria-pressed={method === m} onClick={() => setMethod(m)}>
                      {m === "average" ? "Average cost" : "FIFO"}
                    </button>
                  ))}
                </div>
              </section>
              <PnlChart points={points} onSelect={openPoint} />
              <Holdings positions={positions} onExplain={setExplanation} />
            </>
          )}
        </main>
      ) : null}

      {explanation ? <ExplainPanel explanation={explanation} onClose={close} /> : null}
    </div>
  )
}

function Stat({ label, onClick, coverage, value }: { label: string; onClick: () => void; coverage: Coverage; value: string | null }) {
  return (
    <div>
      <dt className="muted small">{label}</dt>
      <dd>
        <Num label={label} onClick={onClick} tone={value === null ? "warn" : null}>
          {value ?? "⚠ Unavailable"}
        </Num>
        {value !== null && hasAnswer(coverage) && coverage.missing > 0 ? <span className="partial">⚠ partial</span> : null}
      </dd>
    </div>
  )
}

/** A derived table is normally a block or two behind the chain. More than this is worth saying out loud. */
const BEHIND_BLOCKS = 5

const hasStarted = (wallet: WalletResponse) => wallet.coverage.toBlock >= wallet.coverage.fromBlock
const isBehind = (wallet: WalletResponse) => wallet.latest.blockNum - wallet.coverage.toBlock > BEHIND_BLOCKS

function LiveBadge({ wallet, stale }: { wallet: WalletResponse; stale: boolean }) {
  if (wallet.mode === "demo") return <span className="badge">Demo data</span>
  const source = wallet.mode === "dataset" ? "Pricetag dataset" : "raw dataset"
  const block = wallet.coverage.toBlock.toLocaleString("en-US")
  if (stale) return <span className="badge warn">⚠ Not updating · block {block} · {source}</span>
  if (isBehind(wallet)) return <span className="badge warn">⚠ Catching up · block {block} · {source}</span>
  return <span className="badge live">Live · block {block} · {source}</span>
}
