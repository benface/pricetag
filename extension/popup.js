// @ts-check
// Shows what the app says about the wallet, and opens its top-up flow. The amount and the address are all handled in the app.
// The page is complete before anything answers, and nothing here holds it up: the browser shows it, then this fills it in.

/** @param {string} id */
const element = (id) => /** @type {HTMLElement} */ (document.getElementById(id))
const value = element("value")
const cap = element("cap")
const fill = element("fill")
const status = element("status")
const address = element("address")
const copy = /** @type {HTMLButtonElement} */ (element("copy"))
const copyIcon = element("copy-icon")
const copiedIcon = element("copied-icon")
const topUp = /** @type {HTMLButtonElement} */ (element("top-up"))

const port = chrome.runtime.connect({ name: "popup" })
/** @type {Map<number, (message: any) => void>} */
const waiting = new Map()
let nextId = 1

port.onMessage.addListener((/** @type {any} */ message) => {
  if (message.event === "last") {
    show(message.result)
    return
  }
  waiting.get(message.id)?.(message)
  waiting.delete(message.id)
})

/**
 * @param {string} method
 * @param {(message: any) => void} done
 */
function ask(method, done) {
  const id = nextId++
  waiting.set(id, done)
  port.postMessage({ id, method })
}

/** @param {{ value?: string, cap?: string, share?: number, over?: boolean, address?: string, canTopUp?: boolean, problem?: string, sites?: number }} result */
function show(result) {
  value.textContent = result.value ?? "—"
  value.classList.toggle("unknown", !result.value)
  cap.textContent = result.cap ? `of ${result.cap}` : ""
  fill.style.width = `${(result.share ?? 0) * 100}%`
  fill.classList.toggle("over", !!result.over)
  // The short form, the same as the app's. Copying and the tooltip use all of it.
  address.textContent = result.address ? `${result.address.slice(0, 6)}…${result.address.slice(-4)}` : ""
  address.title = result.address ?? ""
  copy.hidden = !result.address
  topUp.disabled = !result.canTopUp
  status.textContent = result.problem ?? (result.sites === undefined ? "" : sitesConnected(result.sites))
}

/** @param {number} sites */
function sitesConnected(sites) {
  if (sites === 0) return "No sites connected"
  return sites === 1 ? "1 site connected" : `${sites} sites connected`
}

// The app nearly always answers before this could show, so there's no "loading" to flash.
const slow = setTimeout(() => {
  status.textContent = "Waiting for Patina. This updates when it answers."
}, 1000)

ask("status", ({ result, error }) => {
  clearTimeout(slow)
  if (error) {
    show({})
    status.textContent = error.message
    return
  }
  show(result)
})

copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(address.title)
  } catch {
    status.textContent = "Couldn't copy the address."
    return
  }
  copyIcon.hidden = true
  copiedIcon.hidden = false
  copy.title = "Copied"
  copy.setAttribute("aria-label", "Copied")
  setTimeout(() => {
    copyIcon.hidden = false
    copiedIcon.hidden = true
    copy.title = "Copy address"
    copy.setAttribute("aria-label", "Copy address")
  }, 1500)
})

topUp.addEventListener("click", () => {
  ask("topUp", ({ error }) => {
    if (error) status.textContent = error.message
    else window.close()
  })
})
