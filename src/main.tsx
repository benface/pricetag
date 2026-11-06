import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./ui/App.tsx"
import { LoadBoundary } from "./ui/LoadBoundary.tsx"
import "./ui/styles.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LoadBoundary>
      <App />
    </LoadBoundary>
  </StrictMode>,
)
