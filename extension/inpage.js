// @ts-check
// Runs in the page, so the page can see and change anything here. Nothing in this file is trusted: it only asks. Every decision
// is made in the Mac app, and the origin the app sees comes from the browser, not from here.
;(() => {
  const CHANNEL = "patina-provider"
  const CHAIN_ID = "0x2105"
  const ICON =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23267f73'/%3E%3Cpath d='M15 7H8a1 1 0 0 0-1 1v7l10 10 8-8z' fill='none' stroke='white' stroke-width='2.2' stroke-linejoin='round'/%3E%3Ccircle cx='11.5' cy='11.5' r='1.6' fill='white'/%3E%3C/svg%3E"

  /** @type {Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>} */
  const waiting = new Map()
  /** @type {Map<string, Set<(...args: unknown[]) => void>>} */
  const listeners = new Map()
  let nextId = 1
  let connected = false
  /** @type {string[]} */
  let accounts = []

  /**
   * @param {string} event
   * @param {unknown} value
   */
  function emit(event, value) {
    for (const listener of [...(listeners.get(event) ?? [])]) {
      try {
        listener(value)
      } catch (error) {
        setTimeout(() => {
          throw error
        })
      }
    }
  }

  /** @param {string[]} next */
  function setAccounts(next) {
    if (next.join() === accounts.join()) return
    accounts = next
    emit("accountsChanged", next)
  }

  function setConnected() {
    if (connected) return
    connected = true
    emit("connect", { chainId: CHAIN_ID })
  }

  /**
   * @param {number} code
   * @param {string} message
   * @param {unknown} [data]
   */
  function providerError(code, message, data) {
    return Object.assign(new Error(message), data === undefined ? { code } : { code, data })
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.channel !== CHANNEL || event.data.direction !== "from-wallet") return
    const message = event.data
    if (message.event === "accountsChanged") {
      setAccounts(message.data)
    } else if (message.event === "disconnect") {
      connected = false
      emit("disconnect", providerError(4900, message.message))
    } else if (typeof message.id === "number") {
      const entry = waiting.get(message.id)
      if (!entry) return
      waiting.delete(message.id)
      if (message.error) {
        entry.reject(providerError(message.error.code, message.error.message, message.error.data))
      } else {
        setConnected()
        entry.resolve(message.result)
      }
    }
  })

  /**
   * EIP-1193.
   * @param {{ method: string, params?: unknown }} request
   * @returns {Promise<any>}
   */
  async function request(request) {
    if (typeof request?.method !== "string") throw providerError(-32602, "A request needs a method.")
    let params
    try {
      params = request.params === undefined ? undefined : JSON.parse(JSON.stringify(request.params))
    } catch {
      throw providerError(-32602, "Those parameters can't be sent as JSON.")
    }
    const result = await new Promise((resolve, reject) => {
      const id = nextId++
      waiting.set(id, { resolve, reject })
      window.postMessage({ channel: CHANNEL, direction: "to-wallet", id, method: request.method, params }, window.location.origin)
    })
    if (request.method === "eth_requestAccounts" || request.method === "eth_accounts") setAccounts(result)
    return result
  }

  // Not frozen, however tempting. Uniswap sets a property on the provider as it starts, and a frozen one crashes the whole site.
  const provider = {
    isPatina: true,
    request,
    isConnected: () => connected,
    /**
     * @param {string} event
     * @param {(...args: any[]) => void} listener
     */
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)?.add(listener)
      return provider
    },
    /**
     * @param {string} event
     * @param {(...args: any[]) => void} listener
     */
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener)
      return provider
    },
  }

  // EIP-6963, which lets a site list this next to any other wallet.
  const info = Object.freeze({ uuid: crypto.randomUUID(), name: "Patina", icon: ICON, rdns: "com.benface.patina" })
  const announce = () => {
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }))
  }
  window.addEventListener("eip6963:requestProvider", announce)
  announce()

  // For sites that only look here. It never takes the place of a wallet that's already there.
  const page = /** @type {Window & { ethereum?: unknown }} */ (window)
  if (page.ethereum === undefined) page.ethereum = provider
})()
