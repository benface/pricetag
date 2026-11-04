import { useCallback, useEffect, useState } from "react"
import type { PricingRule } from "../core/rules.ts"

const RULE_KEY = "pricetag.rule"

export type RulesState = {
  /** Empty when the server has only one rule, so there's nothing to choose. */
  rules: PricingRule[]
  /** What to ask the server for, or null for its default. */
  chosen: string | null
  choose: (id: string) => void
}

/** The server's pricing rules, and which one is chosen. Remembered in this browser, like the main currency. */
export function useRules(): RulesState {
  const [rules, setRules] = useState<PricingRule[]>([])
  const [chosen, setChosen] = useState<string | null>(() => localStorage.getItem(RULE_KEY))

  useEffect(() => {
    const abort = new AbortController()
    fetch("/api/rules", { signal: abort.signal })
      .then((response) => response.json() as Promise<{ rules: PricingRule[] }>)
      .then((body) => {
        setRules(body.rules)
        // A rule this server doesn't have would fail every read.
        setChosen((id) => (id !== null && body.rules.some((rule) => rule.id === id) ? id : null))
      })
      .catch(() => {})
    return () => abort.abort()
  }, [])

  const choose = useCallback((id: string) => {
    localStorage.setItem(RULE_KEY, id)
    setChosen(id)
  }, [])

  return { rules, chosen, choose }
}
