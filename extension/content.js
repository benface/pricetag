// @ts-check
// Passes messages between the page and the extension. The page can send anything it likes here, and all it gets is what any page
// gets: the extension's background script adds the origin itself, from what the browser says.
;(() => {
  const CHANNEL = "patina-provider"

  /** @type {chrome.runtime.Port | null} */
  let port = null
  /** @type {Set<number>} */
  const waiting = new Set()

  /** @param {Record<string, unknown>} message */
  function toPage(message) {
    window.postMessage({ channel: CHANNEL, direction: "from-wallet", ...message }, window.location.origin)
  }

  function connect() {
    const opened = chrome.runtime.connect({ name: "site" })
    opened.onMessage.addListener((/** @type {any} */ message) => {
      if (typeof message.id === "number") waiting.delete(message.id)
      toPage(message)
    })
    opened.onDisconnect.addListener(() => {
      port = null
      // The browser put the extension's background script to sleep, or it was updated. The next request starts it again.
      for (const id of waiting) toPage({ id, error: { code: 4900, message: "Lost touch with the extension. Try again." } })
      waiting.clear()
    })
    return opened
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return
    const message = event.data
    if (message?.channel !== CHANNEL || message.direction !== "to-wallet") return
    if (typeof message.id !== "number" || typeof message.method !== "string") return
    port ??= connect()
    waiting.add(message.id)
    port.postMessage({ id: message.id, method: message.method, params: message.params })
  })
})()
