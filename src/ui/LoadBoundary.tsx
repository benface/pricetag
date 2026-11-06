import { Component, Suspense, useLayoutEffect, useRef, type ReactNode } from "react"
import { LOADING, LOAD_FAILED } from "../core/wording.ts"

function LoadFailed() {
  return (
    <p className="notice warn" role="alert">
      ⚠ {LOAD_FAILED}{" "}
      <button type="button" className="link" onClick={() => window.location.reload()}>
        Reload
      </button>
    </p>
  )
}

/** So a chunk that won't load, or a crash, says so instead of leaving a white page. A failed `lazy` stays failed, so only reloading can bring it back. */
export class LoadBoundary extends Component<{ children: ReactNode; failed?: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override render() {
    if (!this.state.failed) return this.props.children
    return this.props.failed ?? <LoadFailed />
  }
}

/** Stands in for a panel, the same shape and with the same way out. It's a dialog because a panel can open over another one, which leaves only the newest reachable. */
function PanelStandIn({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const element = dialog.current
    if (!element) return
    if (!element.open) element.showModal()
    closeButton.current?.focus()
    return () => {
      element.close()
      opener?.focus()
    }
  }, [])

  return (
    <dialog ref={dialog} className="panel" aria-label={label} onCancel={(e) => (e.preventDefault(), onClose())}>
      <div className="panel-body device">
        <header className="panel-head">
          <h2>{label}</h2>
          <button ref={closeButton} type="button" className="link" onClick={onClose}>
            Close
          </button>
        </header>
        {children}
      </div>
    </dialog>
  )
}

/** A panel that loads when it's asked for, saying so while it does and if it can't. */
export function LazyPanel({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const standIn = (content: ReactNode) => (
    <PanelStandIn label={label} onClose={onClose}>
      {content}
    </PanelStandIn>
  )
  return (
    <LoadBoundary failed={standIn(<LoadFailed />)}>
      <Suspense fallback={standIn(<p className="notice" role="status">{LOADING}</p>)}>{children}</Suspense>
    </LoadBoundary>
  )
}
