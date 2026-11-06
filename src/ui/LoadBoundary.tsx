import { Component, type ReactNode } from "react"
import { LOAD_FAILED } from "../core/wording.ts"

/** So a chunk that won't load, or a crash, says so instead of leaving a white page. A failed `lazy` stays failed, so only reloading can bring it back. */
export class LoadBoundary extends Component<{ children: ReactNode; onClose?: () => void }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override render() {
    if (!this.state.failed) return this.props.children
    return (
      <p className="notice warn" role="alert">
        ⚠ {LOAD_FAILED}{" "}
        <button type="button" className="link" onClick={() => window.location.reload()}>
          Reload
        </button>
        {this.props.onClose ? (
          <>
            {" "}
            <button type="button" className="link" onClick={this.props.onClose}>
              Dismiss
            </button>
          </>
        ) : null}
      </p>
    )
  }
}
