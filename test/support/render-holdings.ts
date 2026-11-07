// The real holdings table as markup, with no browser, for what a test needs to see it say.

import { createElement, type ComponentProps } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createServer, type ViteDevServer } from "vite"
import type { Holdings as HoldingsTable, holdingOf as combinedHolding, walletHoldingOf as walletHolding } from "../../src/ui/Holdings.tsx"

type Module = { Holdings: typeof HoldingsTable; holdingOf: typeof combinedHolding; walletHoldingOf: typeof walletHolding }
type Props = Pick<ComponentProps<typeof HoldingsTable>, "positions" | "questions" | "method">

export type HoldingsRenderer = { render: (props: Props) => string; holdingOf: typeof combinedHolding; walletHoldingOf: typeof walletHolding; close: () => Promise<void> }

export async function holdingsRenderer(): Promise<HoldingsRenderer> {
  // The table remembers its sort here, and all it needs is to find nothing.
  const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {} } })
  const server: ViteDevServer = await createServer({ root: process.cwd(), configFile: false, logLevel: "error", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } })
  const { Holdings, holdingOf, walletHoldingOf } = (await server.ssrLoadModule("/src/ui/Holdings.tsx")) as Module
  return {
    render: (props) => renderToStaticMarkup(createElement(Holdings, { ...props, unread: [], about: [], currency: "USD", onMethod: () => {}, explain: () => {}, onResolve: () => {} })),
    holdingOf,
    walletHoldingOf,
    close: async () => {
      await server.close()
      if (storage) Object.defineProperty(globalThis, "localStorage", storage)
      else Reflect.deleteProperty(globalThis, "localStorage")
    },
  }
}
