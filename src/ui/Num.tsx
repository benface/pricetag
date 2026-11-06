import type { ReactNode } from "react"

export function Num({ onClick, label, children, tone }: { onClick: () => void; label: string; children: ReactNode; tone?: "gain" | "loss" | "quiet" | null }) {
  // In the text rather than an `aria-label`, which would take the place of the number.
  return (
    <button type="button" className={`num-button ${tone ?? ""}`} onClick={onClick}>
      <span className="visually-hidden">{label}: </span>
      {children}
    </button>
  )
}

// What's unknown says so in gray, and the warning under the headline says it once.
export const toneOf = (micros: string | null) => (micros === null ? "quiet" : BigInt(micros) > 0n ? "gain" : BigInt(micros) < 0n ? "loss" : null)
