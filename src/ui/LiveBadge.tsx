import { useEffect, useState } from "react"
import type { WalletResponse } from "../core/api.ts"
import { feedBadge, type CombinedPortfolioResponse } from "../core/combined.ts"
import { feedDetail, walletCount } from "../core/wording.ts"
import { ProblemNotice } from "./ProblemNotice.tsx"
import type { Problem } from "../core/wording.ts"

/** Whether something's gone on this long, so a blip doesn't say more than it has to. */
function useHasLasted(isOn: boolean, ms: number) {
  const [lasted, setLasted] = useState(false)
  useEffect(() => {
    setLasted(false)
    if (!isOn) return
    const timer = setTimeout(() => setLasted(true), ms)
    return () => clearTimeout(timer)
  }, [isOn, ms])
  return lasted
}

const LONG_PROBLEM_MS = 60_000

/** Whether the numbers are current, with what's wrong a click away. It sits in the corner, over the page, so nothing there moves when it changes, however long it gets. */
export function LiveBadge({ wallet, problem, lastUpdate, all, lines, failedWallets, retry }: { wallet: Pick<WalletResponse, "mode" | "coverage" | "latest">; problem: Problem | null; lastUpdate: string | null; all: CombinedPortfolioResponse | null; lines: readonly string[]; failedWallets: number; retry: () => void }) {
  const isLong = useHasLasted(problem !== null, LONG_PROBLEM_MS)
  const detail = feedDetail(wallet.mode, wallet.coverage.toBlock)
  // Numbers missing a wallet aren't live, whatever else is going on.
  const failedLabel = failedWallets > 0 ? `Couldn't read ${walletCount(failedWallets)}` : null
  const says = feedBadge(wallet, problem !== null, all)
  const [kind, label] = says === "Demo data" ? ["", says] : problem ? ["warn", ["Not updating", isLong && lastUpdate ? `last update ${lastUpdate}` : null, failedLabel?.toLowerCase()].filter(Boolean).join(" · ")] : failedLabel ? ["warn", failedLabel] : says === "Not updating" ? ["warn", says] : says === "Updating" ? ["updating", says] : says === "Catching up" ? ["", says] : ["live", says]
  return (
    <div className="status-corner">
      {!problem && lines.length === 0 ? (
        <span className={`badge ${kind}`} title={wallet.mode === "demo" ? undefined : detail}>{label}</span>
      ) : (
        <details className="status">
          <summary className={`badge ${kind}`} title={detail}>{label}</summary>
          <div className="status-details">
            {problem ? <ProblemNotice problem={problem} className="" /> : null}
            {lines.map((line) => <p key={line}>{line}</p>)}
            {problem || failedWallets > 0 || (all?.linkedOutdated.length ?? 0) > 0 ? (
              <button type="button" className="link" onClick={retry}>
                Try again
              </button>
            ) : null}
          </div>
        </details>
      )}
    </div>
  )
}
