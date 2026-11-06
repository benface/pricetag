import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { ETH_ADDRESS, TOKENS, isAddress, normalizeAddress, type CurrencyCode, type Token } from "@pricetag/sdk/core"
import type { PublicClient } from "viem"
import type { Money } from "../core/book.ts"
import { publicClient } from "../core/cold.ts"
import { amountForUsd, readEthPriceMicros } from "../core/device-read.ts"
import { groupAddress } from "../core/device-wording.ts"
import { PROVIDER, checkoutNote, microsOf, typedAmount, type CheckoutRequest } from "../core/purchases.ts"
import { findAllWallets, type BrowserWallet } from "./devices/browser.ts"
import { useCurrentRate } from "./useCurrentRate.ts"

/** What's on sale: the server's `ONRAMP_ASSETS`. */
const FOR_SALE = TOKENS.filter(({ symbol }) => symbol === "ETH" || symbol === "USDC")

const accountsIn = (answer: unknown) => (Array.isArray(answer) ? answer.filter((address) => typeof address === "string" && isAddress(address)).map((address: string) => normalizeAddress(address)) : [])

type Props = {
  currency: CurrencyCode
  onBegin: (request: CheckoutRequest, typed: Money) => Promise<string>
  /** Opens a wallet in the main view, once there's a purchase to follow on it. */
  onView: (address: string) => void
  onClose: () => void
}

/**
 * Buying for a wallet in this browser. The only place an address can come from is that wallet answering, so nothing typed or
 * looked up here can ever be where a purchase lands. Nothing here signs, and the page takes the payment.
 */
export function BuyPanel({ currency, onBegin, onView, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const [wallets, setWallets] = useState<BrowserWallet[] | null>(null)
  const [connected, setConnected] = useState<{ wallet: BrowserWallet; accounts: string[] } | null>(null)
  const [address, setAddress] = useState<string | null>(null)
  const [token, setToken] = useState<Token>(FOR_SALE[0] as Token)
  const [text, setText] = useState("")
  const [ethPrice, setEthPrice] = useState<bigint | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  // A browser that blocked the new tab: the purchase is being followed, and this is the way to its page.
  const [blockedPage, setBlockedPage] = useState<string | null>(null)
  const rateMicros = useCurrentRate(currency)
  const amountError = useId()

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

  useEffect(() => {
    let current = true
    void findAllWallets().then((found) => current && setWallets(found))
    return () => {
      current = false
    }
  }, [])

  useEffect(() => {
    if (!connected) return
    let current = true
    void readEthPriceMicros(publicClient() as unknown as PublicClient).then((price) => current && setEthPrice(price))
    return () => {
      current = false
    }
  }, [connected])

  async function connect(wallet: BrowserWallet) {
    setBusy(true)
    setFailure(null)
    try {
      const accounts = accountsIn(await wallet.provider.request({ method: "eth_requestAccounts" }))
      if (accounts.length === 0) return setFailure(`${wallet.name} didn't share an account.`)
      setConnected({ wallet, accounts })
      setAddress(accounts[0] as string)
    } catch {
      setFailure(`${wallet.name} didn't connect. Nothing changed.`)
    } finally {
      setBusy(false)
    }
  }

  // Without a current rate, it's in US dollars, and it says so.
  const typedIn: CurrencyCode = currency !== "USD" && rateMicros !== null ? currency : "USD"
  const amount = typedAmount(text)
  const usdMicros = amount === null ? null : typedIn === "USD" ? microsOf(amount) : ((BigInt(microsOf(amount)) * 1_000_000n) / BigInt(rateMicros as string)).toString()
  const cryptoAmount = usdMicros === null ? null : amountForUsd(usdMicros, token, ethPrice ?? null)
  const noPrice = token.address === ETH_ADDRESS && ethPrice === null

  function start() {
    if (!connected || !address || !amount || !cryptoAmount) return
    // Before anything's awaited, or a browser takes it for a popup nobody asked for.
    const tab = window.open("about:blank", "_blank")
    setBusy(true)
    setFailure(null)
    void (async () => {
      try {
        // It could have been switched or disconnected since, and only a wallet it's connected to now is theirs to buy for.
        if (!accountsIn(await connected.wallet.provider.request({ method: "eth_accounts" })).includes(address)) throw new Error(`${connected.wallet.name} isn't connected to this wallet anymore, so nothing was started.`)
        // What was typed goes to the page, so it starts at that number, and not at what a rate made of it.
        const fiat = typedIn === "USD" ? null : { amount, currency: typedIn }
        const page = await onBegin({ address, asset: token.symbol, cryptoAmount, fiat }, { micros: microsOf(amount), currency: typedIn })
        if (!tab) return setBlockedPage(page)
        tab.opener = null
        tab.location.href = page
        onView(address)
      } catch (error) {
        tab?.close()
        setFailure(error instanceof Error ? error.message : "Couldn't start this purchase.")
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <dialog ref={dialog} className="panel" aria-label="Buy" onCancel={(e) => (e.preventDefault(), onClose())}>
      <div className="panel-body device">
        <header className="panel-head">
          <h2>Buy</h2>
          <button ref={closeButton} type="button" className="link" onClick={onClose}>
            Close
          </button>
        </header>

        {!connected ? (
          <>
            <p className="muted small">What you buy lands in the wallet you connect here. A hardware wallet never connects to a site, so this isn't for one.</p>
            {wallets === null ? <p className="muted small" role="status">Looking for a wallet in this browser…</p> : null}
            {wallets?.length === 0 ? <p className="notice">There's no wallet in this browser, so there's nowhere for a purchase to land.</p> : null}
            {wallets?.map((wallet) => (
              <button key={wallet.rdns} type="button" className="route" disabled={busy} onClick={() => void connect(wallet)}>
                <strong>{wallet.name}</strong>
                <span className="muted small">Your browser wallet</span>
              </button>
            ))}
          </>
        ) : blockedPage ? (
          <>
            <p>Your browser blocked the new tab. This purchase is being followed already.</p>
            <div className="device-actions">
              <a className="button-link" href={blockedPage} target="_blank" rel="noreferrer noopener" onClick={() => onView(address as string)}>
                Open {PROVIDER}'s page ↗
              </a>
            </div>
          </>
        ) : (
          <form
            className="device"
            onSubmit={(e) => {
              e.preventDefault()
              start()
            }}
          >
            {connected.accounts.length > 1 ? (
              <label className="field">
                <span className="small muted">Which wallet</span>
                <select value={address ?? ""} onChange={(e) => setAddress(e.target.value)}>
                  {connected.accounts.map((account) => (
                    <option key={account} value={account}>
                      {account}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <div>
              <p className="small muted">It lands here, in {connected.wallet.name}, on Base:</p>
              <p className="mono address-big">{groupAddress(address as string)}</p>
              <p className="small muted">Check it matches what your wallet shows, and what {PROVIDER}'s page shows, before you pay.</p>
            </div>
            <div className="send-row">
              <label className="field">
                <span className="small muted">Amount in {typedIn}</span>
                <input inputMode="decimal" autoComplete="off" value={text} aria-invalid={text !== "" && amount === null} aria-describedby={text && amount === null ? amountError : undefined} onChange={(e) => setText(e.target.value)} />
              </label>
              <label className="field">
                <span className="small muted">Token</span>
                <select value={token.symbol} onChange={(e) => setToken(FOR_SALE.find(({ symbol }) => symbol === e.target.value) as Token)}>
                  {FOR_SALE.map(({ symbol }) => (
                    <option key={symbol} value={symbol}>
                      {symbol}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {text && amount === null ? <p id={amountError} className="warn-text small">⚠ That isn't an amount.</p> : null}
            {noPrice ? <p className="warn-text small" role="alert">⚠ ETH's price can't be read right now, so it can't start from this amount.</p> : null}
            <p className="muted small">
              {cryptoAmount ? `About ${cryptoAmount} ${token.symbol}. ` : ""}
              {checkoutNote(typedIn, currency)}
            </p>
            {failure ? <p className="warn-text small" role="alert">⚠ {failure}</p> : null}
            <div className="device-actions">
              <button type="submit" className="primary" disabled={busy || !cryptoAmount}>
                {busy ? "Starting…" : `Continue on ${PROVIDER}`}
              </button>
            </div>
          </form>
        )}
        {!connected && failure ? <p className="warn-text small" role="alert">⚠ {failure}</p> : null}
      </div>
    </dialog>
  )
}
