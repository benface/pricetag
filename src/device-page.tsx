// The hardware wallet flow on its own, which the Mac app carries and serves itself when it reads a hosted server. It has no server's API
// behind it, so there's no wallet to look at here and nothing to read but Base. What's linked on this page goes when the page does.

import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { emptyBook, linkDeviceAccounts } from "./core/book.ts"
import { parseDeviceLink } from "./core/device-link.ts"
import { DevicePanel } from "./ui/DevicePanel.tsx"
import "./ui/styles.css"

const link = parseDeviceLink(window.location.search, window.location.hash)

function DevicePage() {
  const [book, setBook] = useState(emptyBook)
  const [open, setOpen] = useState(link !== null)

  // The Mac app stops serving this once nothing's holding this request. There's no answer to wait for.
  useEffect(() => {
    if (!open) return
    const closing = new AbortController()
    fetch("/alive", { signal: closing.signal }).catch(() => {})
    return () => closing.abort()
  }, [open])

  if (open) return <DevicePanel link={link} book={book} onLink={(addresses) => setBook((latest) => linkDeviceAccounts(latest, addresses))} onClose={() => setOpen(false)} />
  return (
    <div className="page">
      <p className="muted">{link ? "You can close this tab and go back to the Mac app." : "This link doesn't ask for anything. Go back to the Mac app and try again."}</p>
    </div>
  )
}

createRoot(document.getElementById("root") as HTMLElement).render(<DevicePage />)
