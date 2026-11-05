// @ts-check
// Shows what the app says about the wallet, and opens its top-up flow. The amount and the address are all handled in the app.

const value = /** @type {HTMLElement} */ (document.getElementById("value"))
const status = /** @type {HTMLElement} */ (document.getElementById("status"))
const address = /** @type {HTMLElement} */ (document.getElementById("address"))
const topUp = /** @type {HTMLButtonElement} */ (document.getElementById("top-up"))

const port = chrome.runtime.connect({ name: "popup" })
/** @type {Map<number, (message: any) => void>} */
const waiting = new Map()
let nextId = 1

port.onMessage.addListener((/** @type {any} */ message) => {
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

ask("status", ({ result, error }) => {
  if (error) {
    status.textContent = error.message
    return
  }
  value.textContent = result.value ? `${result.value} of ${result.cap}` : "—"
  status.textContent = result.problem ?? (result.sites === 1 ? "1 site connected" : `${result.sites} sites connected`)
  address.textContent = result.address ?? ""
  topUp.disabled = !result.canTopUp
})

topUp.addEventListener("click", () => {
  ask("topUp", ({ error }) => {
    if (error) status.textContent = error.message
    else window.close()
  })
})
