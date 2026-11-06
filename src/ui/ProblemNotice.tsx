import type { ReactNode } from "react"
import type { Problem } from "../core/wording.ts"

/** What went wrong, with the technical side folded away for whoever wants it. */
export function ProblemNotice({ problem, action, className = "notice warn" }: { problem: Problem; action?: ReactNode; className?: string }) {
  return (
    <div className={className}>
      ⚠ {problem.message} {action}
      {problem.detail ? (
        <details className="problem-details small">
          <summary>Details</summary>
          {problem.detail}
        </details>
      ) : null}
    </div>
  )
}
