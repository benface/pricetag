// @ts-check
// Routes requests between open pages and the Mac app, through the native messaging host. It keeps nothing, and never sees a key.
// It's the one place an origin gets attached to a request, and it takes it from the browser, never from the page.

const HOST = "com.benface.patina"

/** @typedef {{ port: chrome.runtime.Port, origin: string, inFlight: Set<string> }} Site */

/** @type {chrome.runtime.Port | null} */
let native = null
/** @type {string | null} */
let nativeProblem = null
/** @type {Set<Site>} */
const sites = new Set()
/** @type {Map<string, (message: any) => void>} */
const routes = new Map()
let nextId = 1

/**
 * Only a top-level page, on HTTPS or this Mac. This repeats the manifest's rules, and the app checks the origin again.
 * @param {chrome.runtime.MessageSender | undefined} sender
 * @returns {string | null}
 */
export function siteOrigin(sender) {
  if (!sender || sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab || !sender.origin) return null
  const { protocol, hostname, origin } = new URL(sender.origin)
  if (origin !== sender.origin) return null
  if (protocol === "https:") return origin
  if (protocol === "http:" && (hostname === "localhost" || hostname === "127.0.0.1")) return origin
  return null
}

/**
 * The browser fills in `url`, and pages can't load this one: it isn't web accessible.
 * @param {chrome.runtime.MessageSender | undefined} sender
 */
export function isPopup(sender) {
  return !!sender && sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("popup.html")
}

function problemMessage() {
  if (nativeProblem?.includes("not found")) return "Patina's host isn't installed. Run `pnpm mac` once."
  return "Patina isn't open. Open it on this Mac and try again."
}

function connectNative() {
  const opened = chrome.runtime.connectNative(HOST)
  nativeProblem = null
  opened.onMessage.addListener((/** @type {any} */ message) => {
    if (message.event === "accountsChanged") {
      for (const site of sites) {
        if (site.origin === message.origin) site.port.postMessage({ event: "accountsChanged", data: message.data })
      }
      return
    }
    const route = routes.get(message.id)
    if (!route) return
    routes.delete(message.id)
    route(message)
  })
  opened.onDisconnect.addListener(() => {
    nativeProblem = chrome.runtime.lastError?.message ?? null
    native = null
    const message = problemMessage()
    const failed = [...routes.values()]
    routes.clear()
    for (const route of failed) route({ error: { code: 4900, message } })
    for (const site of sites) site.port.postMessage({ event: "disconnect", message })
  })
  return opened
}

/**
 * Sends one request to the app, and calls back with its answer.
 * @param {Record<string, unknown>} request
 * @param {(message: any, id: string) => void} done
 * @returns {string}
 */
function toApp(request, done) {
  const id = String(nextId++)
  routes.set(id, (message) => done(message, id))
  try {
    native ??= connectNative()
    native.postMessage({ ...request, id })
  } catch {
    routes.delete(id)
    done({ error: { code: 4900, message: problemMessage() } }, id)
  }
  return id
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "popup") {
    if (!isPopup(port.sender)) return port.disconnect()
    port.onMessage.addListener((/** @type {any} */ message) => {
      toApp({ kind: "popup", method: message.method }, ({ result, error }) => {
        port.postMessage({ id: message.id, result, error })
      })
    })
    return
  }

  const origin = port.name === "site" ? siteOrigin(port.sender) : null
  if (!origin) return port.disconnect()
  /** @type {Site} */
  const site = { port, origin, inFlight: new Set() }
  sites.add(site)
  port.onMessage.addListener((/** @type {any} */ message) => {
    if (typeof message?.id !== "number" || typeof message.method !== "string") return
    // By the ID made here, since the page chooses its own and can use one twice.
    const appId = toApp({ kind: "site", origin, method: message.method, params: message.params }, ({ result, error }, id) => {
      site.inFlight.delete(id)
      if (sites.has(site)) port.postMessage({ id: message.id, result, error })
    })
    if (routes.has(appId)) site.inFlight.add(appId)
  })
  // A closed tab takes its approvals with it.
  port.onDisconnect.addListener(() => {
    sites.delete(site)
    for (const appId of site.inFlight) {
      routes.delete(appId)
      native?.postMessage({ kind: "cancel", id: appId })
    }
  })
})
