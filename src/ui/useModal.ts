import { useLayoutEffect, type RefObject } from "react"

/**
 * Shows `dialog` as a native modal for as long as it's mounted, which keeps focus inside and makes the page behind it inert.
 * Closing by unmounting doesn't restore focus, so this gives it back to whatever had it. `focus` is what takes it on opening.
 */
export function useModal(dialog: RefObject<HTMLDialogElement | null>, focus?: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const element = dialog.current
    if (!element) return
    if (!element.open) element.showModal()
    focus?.current?.focus()
    return () => {
      element.close()
      opener?.focus()
    }
  }, [])
}
