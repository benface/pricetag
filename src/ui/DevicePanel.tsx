import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from "react"
import { ETH_ADDRESS, TOKENS, encodeNote, formatAmount, formatExactUsd, formatMoney, formatPaid, formatUsdIn, isAddress, labelUsd, normalizeAddress, shortHash, type CurrencyCode, type Token } from "@pricetag/sdk/core"
import type { Hex, PublicClient } from "viem"
import { linkedWallets, type Book, type UnitChoice } from "../core/book.ts"
import { readColdRequest, transferRequest, type ColdAccount, type ColdRequest, type ColdSigner, type DevicePrompt } from "../core/cold.ts"
import { accountsToLink, isFresh, readCheckedAccounts, rememberCheckedAccount, selectedAccount, type AccountActivity, type CheckedAccount, type SeenAccount } from "../core/device-accounts.ts"
import { addToMacLink, unitChoiceLink, usdMicrosOf, type DeviceLink } from "../core/device-link.ts"
import { amountForUsd, checkSend, parseAmount, readActivity, readEthPriceMicros, type SendCheck } from "../core/device-read.ts"
import { choiceOf, picksProblem, type Held } from "../core/held-units.ts"
import { NOT_SAVED } from "../core/wording.ts"
import { ALL_YOURS_DEVICE, CHECK_ADDRESS_WARNING, KEYSTONE_CONNECT, KEYSTONE_LOOK, LEDGER_HANDED_OFF, LEDGER_HAND_OFF, LEDGER_NEEDS_CHROMIUM, LEDGER_READY, LEDGER_VERIFY, LOOK_HANDED_OFF, NEVER_ASKED, PROMPTS, PUBLISH_DETAIL, PUBLISH_DEVICE_NOTE, PUBLISH_WARNING, WRONG_PUBLISHER, groupAddress } from "../core/device-wording.ts"
import type { BrowserWallet } from "./devices/browser.ts"
import { realConnectors, type Connectors } from "./devices/connectors.ts"
import type { ScannedCode } from "./devices/keystone.ts"
import { readCountry } from "./taxCountry.ts"
import { useCurrentRate } from "./useCurrentRate.ts"
import { useModal } from "./useModal.ts"

const CodeScanner = lazy(() => import("./devices/KeystoneCodes.tsx").then((m) => ({ default: m.CodeScanner })))
const CodeToSign = lazy(() => import("./devices/KeystoneCodes.tsx").then((m) => ({ default: m.CodeToSign })))

const PAGE = 5
const CONNECT_TYPES = ["crypto-hdkey", "crypto-multi-accounts"]
const ETH = TOKENS.find((token) => token.address === ETH_ADDRESS) as Token

const messageOf = (error: unknown) => (error instanceof Error && error.message ? error.message : "Something went wrong, and nothing was sent.")

const activityWords = (activity: AccountActivity) => {
  if (activity === null) return "⚠ Couldn't read this one"
  if (isFresh(activity)) return "Nothing's happened here yet"
  const eth = `${formatAmount(activity.ethUnits, 18)} ETH`
  return activity.tokenCount > 0 ? `${eth} and ${activity.tokenCount === 1 ? "1 token" : `${activity.tokenCount} tokens`}` : eth
}

/** Waits on the person: what's being shown, and what's expected back. */
type Exchange = { code: ScannedCode; expected: string; resolve: (code: ScannedCode) => void; reject: (reason: Error) => void }

/** Which units a send takes, by when each was bought. */
type Named = { asset: string; picks: ReadonlyMap<string, bigint> }

type Step = "route" | "ledger" | "keystone" | "accounts" | "check" | "ready" | "send" | "publish" | "sent"

type Props = {
  link: DeviceLink | null
  book: Book
  /** What amounts read in. A note's still published in USD. */
  currency?: CurrencyCode
  /** All the user's wallets are showing, so nothing here says which one this acts on until an account's chosen. */
  allYours?: boolean
  /** Accounts from a device are the user's, with no question. */
  onLink: (addresses: readonly string[]) => void
  /** The last link couldn't be saved. */
  notSaved?: boolean
  /** Opens a wallet in the main view. The page the Mac app serves has none. */
  onView?: (address: string) => void
  onClose: () => void
  connectors?: Connectors
  /**
   * What a wallet holds of an asset, by purchase, so a send can name which units it takes. Only where there's a server to read
   * wallets from and a book to keep the record in, which the page the Mac app serves has neither of.
   */
  heldOf?: (address: string, asset: string) => Promise<Held>
  /** Keeps a record of which units a send took, made before it was signed. */
  onNamed?: (choice: UnitChoice) => void
  /** A test page starts partway through. */
  start?: { signer: ColdSigner; accounts: SeenAccount[]; chosen: string; step: Step; lookOnDevice?: boolean; handingOff?: boolean }
}

/** The one place the web app reaches a hardware wallet. Keys stay on the device: this only ever sees addresses and signatures. */
export function DevicePanel({ link, book, currency = "USD", allYours = false, onLink, notSaved = false, onView, onClose, connectors = realConnectors, heldOf, onNamed, start }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const [step, setStep] = useState<Step>(start?.step ?? (link?.kind === "add-savings" && link.device === "ledger" && connectors.canUseUsb() ? "ledger" : "route"))
  const [signer, setSigner] = useState<ColdSigner | null>(start?.signer ?? null)
  const [wallets, setWallets] = useState<BrowserWallet[]>([])
  const [accounts, setAccounts] = useState<SeenAccount[]>(start?.accounts ?? [])
  // A browser wallet can run out of accounts, and a device can't.
  const [more, setMore] = useState(true)
  const [chosen, setChosen] = useState<string | null>(start?.chosen ?? null)
  const [prompt, setPrompt] = useState<DevicePrompt | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [lookOnDevice, setLookOnDevice] = useState(start?.lookOnDevice ?? false)
  const [matches, setMatches] = useState(false)
  // Sending an address to the Mac app, which is where it gets checked against what the device shows now.
  const [handingOff, setHandingOff] = useState(start?.handingOff ?? false)
  const [checked, setChecked] = useState<CheckedAccount[]>(readCheckedAccounts)
  const [exchange, setExchange] = useState<Exchange | null>(null)
  const [sent, setSent] = useState<{ hash: string; status: "pending" | "done" | "failed"; what: string } | null>(null)

  const purpose = link && link.kind !== "add-savings" ? "send" : "receive"
  // A note counts for whoever sends it, so it can only ever come from the wallet it's about.
  const required = link?.kind === "publish" ? link.wallet : null
  const account = accounts.find((a) => a.address === chosen && (required === null || a.address === required)) ?? null
  // The scanner keeps reading a code for as long as it's held up.
  const scanned = useRef(false)
  const client = useRef<PublicClient | null>(null)
  const clientOf = async () => (client.current ??= await connectors.client())

  useModal(dialog, closeButton)

  useEffect(() => {
    if (connectors.canUseUsb()) connectors.preloadLedger()
    connectors.findWallets().then(setWallets, () => setWallets([]))
  }, [connectors])

  // A device stays connected for as long as this is open, and no longer.
  const open = useRef(signer)
  open.current = signer
  useEffect(() => () => void open.current?.close(), [])

  const attempt = async (work: () => Promise<void>) => {
    setBusy(true)
    setProblem(null)
    try {
      await work()
    } catch (error) {
      setProblem(messageOf(error))
    } finally {
      setBusy(false)
      setPrompt(null)
    }
  }

  const showAccounts = async (next: ColdSigner, from: number) => {
    const listed = await next.listAccounts(from, PAGE, setPrompt)
    setPrompt("working")
    const reader = await clientOf()
    const read = await Promise.all(listed.map(async (one: ColdAccount): Promise<SeenAccount> => ({ ...one, activity: await readActivity(reader, one.address) })))
    const all = from === 0 ? read : [...accounts, ...read]
    setAccounts(all)
    setMore(listed.length === PAGE)
    setChosen(selectedAccount(all, { required, current: chosen, purpose }))
    // Everything in use on this device is the user's. Whichever they pick gets added when they pick it.
    onLink(accountsToLink(all, null))
    setStep("accounts")
  }

  const connect = (open: () => Promise<ColdSigner>) =>
    attempt(async () => {
      const next = await open()
      setSigner(next)
      await showAccounts(next, 0)
    })

  const pickAccount = () => {
    if (!account) return
    onLink([account.address])
    if (link?.kind === "publish") setStep("publish")
    else if (link?.kind === "top-up") setStep("send")
    else if (checked.some((c) => c.address === account.address)) setStep("ready")
    else checkOnDevice()
  }

  const checkOnDevice = () => {
    if (!signer || !account) return
    setMatches(false)
    setStep("check")
    void attempt(async () => {
      const how = await signer.showAddress(account, setPrompt)
      setLookOnDevice(how === "look-on-device")
    })
  }

  /** Goes with the link to the Mac app, so that a Ledger is showing the address while the Mac app asks about it. */
  const handOff = () => {
    if (!account) return
    onLink([account.address])
    setHandingOff(true)
    checkOnDevice()
  }

  /** A device only shows it once, so opening the Mac app again means asking again. Unless it's still showing, since it does one thing at a time. */
  const handOffAgain = () => {
    if (!busy) checkOnDevice()
  }

  const confirmChecked = () => {
    if (!signer || !account) return
    setChecked(rememberCheckedAccount({ address: account.address, path: account.path, ...(account.deviceId ? { deviceId: account.deviceId } : {}), deviceName: signer.name, kind: signer.kind }))
    setStep("ready")
  }

  const exchangeCodes = (code: ScannedCode, expected: string) => new Promise<ScannedCode>((resolve, reject) => setExchange({ code, expected, resolve, reject }))

  const useAnotherDevice = () => {
    void signer?.close()
    setSigner(null)
    setAccounts([])
    setChosen(null)
    setProblem(null)
    setStep("route")
  }

  // A top-up the Mac app opened says what its savings hold, folded with its answers, and only under US rules. What's chosen goes back
  // to it, since its book is the one that counts. Anywhere else, it's this app's own reading and book, and only under US rules here.
  const fromMac = link?.kind === "top-up" ? link.naming : null
  const heldFor = useMemo(
    () =>
      fromMac
        ? (address: string, asset: string) => {
            const held = fromMac.held.get(normalizeAddress(address))?.get(asset)
            return held ? Promise.resolve(held) : Promise.reject(new Error("The Mac app didn't say what this one holds."))
          }
        : heldOf,
    [fromMac, heldOf],
  )
  const canName = fromMac !== null || (heldOf !== undefined && onNamed !== undefined && readCountry(currency) === "US")
  const [handBack, setHandBack] = useState<{ choice: UnitChoice; flow: string } | null>(null)

  const send = (request: ColdRequest, what: string, own: ReadonlySet<string>, named?: Named) => {
    if (!signer || !account) return
    if (required !== null && account.address !== required) return setProblem(WRONG_PUBLISHER)
    // Made now, before it's signed, so the record was there before the transaction was.
    const recordedAt = new Date().toISOString()
    void attempt(async () => {
      const hash = await connectors.send({ signer, account, request, own, onPrompt: setPrompt })
      const choice = named ? choiceOf(account.address, hash, named.asset, recordedAt, named.picks) : null
      if (choice && fromMac) setHandBack({ choice, flow: fromMac.flow })
      else if (choice) onNamed?.(choice)
      setExchange(null)
      setSent({ hash, status: "pending", what })
      setStep("sent")
      const receipt = await (await clientOf()).waitForTransactionReceipt({ hash }).catch(() => null)
      setSent({ hash, what, status: receipt === null ? "pending" : receipt.status === "success" ? "done" : "failed" })
    })
  }

  const others = accounts.filter((a) => a.address !== chosen)
  const name = signer?.name ?? "device"
  const toMac = account ? addToMacLink(account.address, name, accountsToLink(others, null)) : ""

  return (
    <dialog ref={dialog} className="panel" aria-label="Hardware wallet" onCancel={(e) => (e.preventDefault(), onClose())}>
      <div className="panel-body device">
        <header className="panel-head">
          <h2>{link?.kind === "add-savings" ? "Add a savings wallet" : link?.kind === "top-up" ? "Top up from savings" : link?.kind === "publish" ? "Publish this cost" : "Hardware wallet"}</h2>
          <button ref={closeButton} type="button" className="link" onClick={onClose}>
            Close
          </button>
        </header>

        {step === "route" ? (
          <>
            <p className="muted small">Your device holds the keys and signs everything. {NEVER_ASKED}</p>
            {allYours && !link ? <p className="small">{ALL_YOURS_DEVICE}</p> : null}
            <button type="button" className="route" disabled={busy || !connectors.canUseUsb()} onClick={() => setStep("ledger")}>
              <strong>Ledger</strong>
              <span className="muted small">{connectors.canUseUsb() ? "With its USB cable" : LEDGER_NEEDS_CHROMIUM}</span>
            </button>
            <button type="button" className="route" disabled={busy} onClick={() => {
              scanned.current = false
              setStep("keystone")
            }}>
              <strong>Keystone</strong>
              <span className="muted small">With QR codes and your webcam, so it never connects to this computer</span>
            </button>
            {wallets.map((wallet) => (
              <button key={wallet.rdns} type="button" className="route" disabled={busy} onClick={() => void connect(() => connectors.wallet(wallet))}>
                <strong>{wallet.name}</strong>
                <span className="muted small">Your browser wallet, with your device behind it</span>
              </button>
            ))}
          </>
        ) : null}

        {step === "ledger" ? (
          <>
            <ol className="small device-steps">
              {LEDGER_READY.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ol>
            <button type="button" className="primary" disabled={busy} onClick={() => void connect(() => connectors.ledger())}>
              Connect my Ledger
            </button>
            <button type="button" className="link" disabled={busy} onClick={() => (setProblem(null), setStep("route"))}>
              Back
            </button>
          </>
        ) : null}

        {step === "keystone" ? (
          <>
            <p className="small">{KEYSTONE_CONNECT}</p>
            <Suspense fallback={<p className="muted small">Starting the camera…</p>}>
              <CodeScanner types={CONNECT_TYPES} onProblem={setProblem} onScan={(code) => {
                if (scanned.current) return
                scanned.current = true
                void connect(() => connectors.keystone(code, exchangeCodes)).then(() => {
                  scanned.current = false
                })
              }} />
            </Suspense>
            <button type="button" className="link" onClick={() => setStep("route")}>
              Back
            </button>
          </>
        ) : null}

        {step === "accounts" ? (
          <>
            {link?.kind === "publish" && !account ? <p className="notice warn">⚠ Only the wallet this arrived in, {shortHash(link.wallet)}, can publish its cost, and it isn't among these. Show more, or connect the device that holds it.</p> : null}
            <p className="small">{purpose === "receive" ? "Starting on one nothing's happened to keeps this money apart from anything else on the device." : "Choose the account to send from."}</p>
            <fieldset className="accounts">
              <legend className="muted small">Accounts on your {name}</legend>
              {accounts.map((one) => {
                const wrongOne = link?.kind === "publish" && one.address !== link.wallet
                return (
                  <label key={one.address} className={wrongOne ? "account muted" : "account"}>
                    <input type="radio" name="account" disabled={wrongOne} checked={one.address === chosen} onChange={() => setChosen(one.address)} />
                    <span className="mono">{shortHash(one.address)}</span>
                    <span className="muted small">{activityWords(one.activity)}</span>
                  </label>
                )
              })}
            </fieldset>
            {purpose === "receive" ? <p className="muted small">These aren't checked yet, so don't send anything to one until the next step.</p> : null}
            <div className="device-actions">
              {more ? (
                <button type="button" disabled={busy} onClick={() => signer && void attempt(() => showAccounts(signer, accounts.length))}>
                  Show more
                </button>
              ) : null}
              {required !== null && !account ? (
                <button type="button" disabled={busy} onClick={useAnotherDevice}>
                  Use another device
                </button>
              ) : null}
              {link?.kind === "add-savings" && account && !busy ? (
                <a className="button-link primary" href={toMac} onClick={handOff}>
                  Add to the Mac app
                </a>
              ) : (
                <button type="button" className="primary" disabled={busy || !account} onClick={pickAccount}>
                  {link?.kind === "publish" || link?.kind === "top-up" ? "Continue" : "Check it on the device"}
                </button>
              )}
            </div>
          </>
        ) : null}

        {step === "check" && account ? (
          <>
            <h3>{handingOff ? "Finish in the Mac app" : "Does your device show this?"}</h3>
            <p className="address-big mono">{groupAddress(account.address)}</p>
            {busy && prompt ? <p className="notice" role="status">{PROMPTS[prompt]}</p> : null}
            {signer?.kind === "ledger" && !lookOnDevice && busy ? <p className="small">{handingOff ? LEDGER_HAND_OFF : LEDGER_VERIFY}</p> : null}
            {lookOnDevice ? <p className="small">{signer?.kind === "keystone" ? KEYSTONE_LOOK : `This page can't reach your device through ${name}. Have ${name} show this address on your device, or look it up on the device's receive screen.`}</p> : null}
            {handingOff ? (
              <>
                {lookOnDevice ? <p className="small">{LOOK_HANDED_OFF}</p> : !busy && !problem ? <p className="notice">{LEDGER_HANDED_OFF}</p> : null}
                <p className="muted small">If nothing opened, your browser may have asked first. {signer?.kind === "ledger" ? "Opening it again shows the address on your Ledger again too." : ""}</p>
              </>
            ) : (
              <>
                <label className="check-row">
                  <input type="checkbox" checked={matches} disabled={busy} onChange={(e) => setMatches(e.target.checked)} />
                  <span>Every character matches what my device's screen shows</span>
                </label>
                <p className="muted small">{CHECK_ADDRESS_WARNING}</p>
              </>
            )}
            <div className="device-actions">
              <button type="button" disabled={busy} onClick={() => (setHandingOff(false), setStep("accounts"))}>
                Back
              </button>
              {handingOff ? (
                <a className="button-link" href={toMac} onClick={handOffAgain}>
                  Open the Mac app again
                </a>
              ) : (
                <button type="button" className="primary" disabled={busy || !matches || problem !== null} onClick={confirmChecked}>
                  It matches
                </button>
              )}
            </div>
          </>
        ) : null}

        {step === "ready" && account ? (
          <>
            <p className="notice">✓ You checked this address on your device.</p>
            <p className="address-big mono">{groupAddress(account.address)}</p>
            <div className="device-actions">
              <CopyAddress address={account.address} />
              <button type="button" onClick={() => setStep("send")}>
                Send to another of my wallets
              </button>
              <a className="button-link" href={toMac} onClick={handOff}>
                Add to the Mac app as savings
              </a>
              {onView ? (
                <button type="button" onClick={() => onView(account.address)}>
                  See this wallet
                </button>
              ) : null}
            </div>
            <p className="muted small">{activityWords(account.activity)}. Its account on your device is linked here, so costs follow what moves between your wallets.</p>
          </>
        ) : null}

        {step === "send" && account && signer ? <SendForm link={link?.kind === "top-up" ? link : null} currency={currency} heldCurrency={fromMac?.currency ?? currency} from={account} book={book} heldOf={canName ? heldFor : undefined} checked={checked} accounts={accounts} clientOf={clientOf} busy={busy} onBack={() => setStep(link?.kind === "top-up" ? "accounts" : "ready")} onLink={onLink} onSend={send} /> : null}

        {step === "publish" && account && signer && link?.kind === "publish" ? <PublishForm link={link} currency={currency} busy={busy} onBack={() => setStep("accounts")} onSend={send} /> : null}

        {step === "sent" && sent ? (
          <>
            <p className={sent.status === "failed" ? "notice warn" : "notice"} role="status">{sent.status === "pending" ? "On its way…" : sent.status === "done" ? "✓ Done" : "⚠ It reached the network but failed. Your funds didn't move, apart from the network fee."}</p>
            <p className="small">{sent.what}</p>
            <p className="small">
              <a href={`https://basescan.org/tx/${sent.hash}`} target="_blank" rel="noreferrer noopener">
                See it on Basescan
              </a>
            </p>
            {handBack ? (
              <>
                <p className="small">The Mac app sees the send on its own, but not which units it took. Until you save your choice there, it goes by the ones you've held longest.</p>
                <p className="device-actions">
                  <a className="button-link primary" href={unitChoiceLink(handBack.choice, handBack.flow)}>
                    Save your choice in the Mac app
                  </a>
                </p>
              </>
            ) : null}
            {link && !handBack ? <p className="muted small">The Mac app picks this up on its own.</p> : null}
          </>
        ) : null}

        {exchange ? (
          <div className="exchange">
            <p className="small"><strong>1.</strong> Scan this with your Keystone, then check it there and approve it.</p>
            <Suspense fallback={null}>
              <CodeToSign code={exchange.code} />
            </Suspense>
            <p className="small"><strong>2.</strong> Hold the code your Keystone shows up to your webcam.</p>
            <Suspense fallback={null}>
              <CodeScanner types={[exchange.expected]} onProblem={setProblem} onScan={(code) => (setExchange(null), exchange.resolve(code))} />
            </Suspense>
            <button type="button" className="link" onClick={() => (setExchange(null), exchange.reject(new Error("Cancelled, so nothing was sent.")))}>
              Cancel
            </button>
          </div>
        ) : null}

        {busy && prompt && !exchange && step !== "check" ? <p className="notice" role="status">{PROMPTS[prompt]}</p> : null}
        {busy && !prompt && !exchange && step === "route" ? <p className="notice" role="status">Connecting…</p> : null}
        {busy && !prompt && !exchange && step === "ledger" ? <p className="notice" role="status">Choose your Ledger in your browser's list.</p> : null}
        {problem ? <p className="notice warn" role="alert">⚠ {problem}</p> : null}
        {notSaved ? <p className="notice warn" role="alert">⚠ {NOT_SAVED}</p> : null}
        {problem && step === "check" ? (
          <button type="button" onClick={checkOnDevice}>
            Try again
          </button>
        ) : null}
      </div>
    </dialog>
  )
}

/** Says what happened, because a copy that failed looks just like one that worked. */
function CopyAddress({ address }: { address: string }) {
  const [said, setSaid] = useState("")
  const copy = () => navigator.clipboard.writeText(address).then(() => setSaid("Copied."), () => setSaid("Couldn't copy it, so select it above instead."))
  return (
    <>
      <button type="button" onClick={() => void copy()}>
        Copy address
      </button>
      <span className="small muted" role="status">{said}</span>
    </>
  )
}

function SendForm({ link, currency, heldCurrency, from, book, heldOf, checked, accounts, clientOf, busy, onBack, onLink, onSend }: {
  /** What the costs of what's held are in. The Mac app reads them in its own currency, which can be other than this page's. */
  heldCurrency: CurrencyCode
  link: Extract<DeviceLink, { kind: "top-up" }> | null
  currency: CurrencyCode
  from: SeenAccount
  book: Book
  heldOf: ((address: string, asset: string) => Promise<Held>) | undefined
  checked: readonly CheckedAccount[]
  accounts: readonly SeenAccount[]
  clientOf: () => Promise<PublicClient>
  busy: boolean
  onBack: () => void
  onLink: (addresses: readonly string[]) => void
  onSend: (request: ColdRequest, what: string, own: ReadonlySet<string>, named?: Named) => void
}) {
  const [typed, setTyped] = useState(link?.to ?? "")
  const [isMine, setIsMine] = useState(false)
  const [token, setToken] = useState<Token>(ETH)
  const [amount, setAmount] = useState("")
  const [touched, setTouched] = useState(false)
  const [ethPrice, setEthPrice] = useState<bigint | null>(null)
  const [check, setCheck] = useState<SendCheck | null>(null)
  const rateMicros = useCurrentRate(currency)
  const amountError = useId()

  const knownOwn = useMemo(() => new Set([...linkedWallets(book), ...checked.map((c) => c.address), ...accounts.filter((a) => a.activity !== null && !isFresh(a.activity)).map((a) => a.address)]), [book, checked, accounts])
  const to = isAddress(typed.trim()) ? normalizeAddress(typed.trim()) : null
  const needsAnswer = to !== null && !knownOwn.has(to)
  const own = useMemo(() => (to && isMine ? new Set([...knownOwn, to]) : knownOwn), [knownOwn, to, isMine])
  const units = parseAmount(amount, token.decimals)
  const request = to && units ? transferRequest(token, to, units) : null
  const read = request ? readColdRequest(request, from.address, own) : null
  const refused = read && "refused" in read ? read.refused : null
  const usdMicros = token.address === ETH_ADDRESS && units && ethPrice ? (units * ethPrice) / 10n ** 18n : token.symbol === "USDC" && units ? units : null
  const key = request ? `${request.to}:${request.value}:${request.data ?? ""}` : ""

  useEffect(() => {
    let current = true
    clientOf().then(readEthPriceMicros).then((price) => current && setEthPrice(price), () => {})
    return () => {
      current = false
    }
  }, [])

  // Fills in from the link's dollars until someone types their own.
  useEffect(() => {
    if (touched || !link?.usdMicros) return
    setAmount(amountForUsd(link.usdMicros, token, ethPrice) ?? "")
  }, [link, token, ethPrice, touched])

  useEffect(() => {
    setCheck(null)
    if (!request || refused || !units) return
    let current = true
    const timer = setTimeout(() => {
      clientOf().then((client) => checkSend(client, from.address, request, { token, units })).then((next) => current && setCheck(next), () => {})
    }, 250)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [key, refused])

  // Only US rules let a send name its units, and only before it happens. The panel says when that applies.
  const canName = heldOf !== undefined
  const [naming, setNaming] = useState(false)
  // What was last read, for which wallet and asset. A new read, after a new block or a change to the book, keeps the last one on
  // screen with what's typed into it, and the send waits until it's back.
  const holding = `${from.address}:${token.asset}`
  const [lastRead, setLastRead] = useState<{ holding: string; held: Held | "failed" } | null>(null)
  const [reading, setReading] = useState(false)
  const [picked, setPicked] = useState<Record<string, string>>({})
  // Other purchases, so what was typed for these doesn't carry over.
  useEffect(() => setPicked({}), [holding])
  useEffect(() => {
    if (!naming || !heldOf) return
    let current = true
    setReading(true)
    heldOf(from.address, token.asset).then(
      (next) => current && (setLastRead({ holding, held: next }), setReading(false)),
      () => current && (setLastRead({ holding, held: "failed" }), setReading(false)),
    )
    return () => {
      current = false
    }
  }, [naming, heldOf, holding])
  const held: Held | "reading" | "failed" = lastRead?.holding === holding ? lastRead.held : "reading"
  // A purchase that's gone from a new read can't be chosen anymore, and with no box left to change it in, it would hold the send for
  // good. So it goes, and the panel says so.
  const [dropped, setDropped] = useState(0)
  useEffect(() => setDropped(0), [holding])
  useEffect(() => {
    if (typeof held !== "object") return
    const there = new Set(held.purchases.map((p) => p.boughtAt))
    const gone = Object.entries(picked).filter(([at]) => !there.has(at))
    if (gone.length === 0) return
    setPicked((latest) => Object.fromEntries(Object.entries(latest).filter(([at]) => there.has(at))))
    // A box left empty or at zero chose nothing, so losing it isn't worth saying.
    const lost = gone.filter(([, text]) => pickOf(text, token.decimals) !== 0n).length
    if (lost > 0) setDropped((count) => count + lost)
  }, [held])
  const picks = useMemo(() => new Map(Object.entries(picked).map(([at, text]) => [at, pickOf(text, token.decimals) ?? -1n] as const)), [picked, token.decimals])
  const format = (n: bigint) => `${formatAmount(n, token.decimals)} ${token.symbol}`
  const badPick = [...picks.values()].some((n) => n < 0n)
  const nothingPicked = [...picks.values()].every((n) => n === 0n)
  const pickProblem = !naming || typeof held !== "object" ? null : badPick ? `One of those isn't an amount of ${token.symbol}.` : units && !nothingPicked ? picksProblem(held, picks, units, format) : null
  // Once this is open, the send goes with what's chosen here, or nothing goes until "Don't choose" closes it. It never goes
  // without a choice someone thinks it has.
  const namingBlocks = naming && (typeof held !== "object" || reading || nothingPicked || pickProblem !== null)
  const named: Named | undefined = naming && !namingBlocks ? { asset: token.asset, picks } : undefined

  const what = units && to ? `${amount.trim()} ${token.symbol} from ${shortHash(from.address)} to ${shortHash(to)}` : ""
  const go = () => {
    if (!request || !to) return
    if (isMine) onLink([to])
    onSend(request, what, own, named)
  }

  return (
    <>
      <p className="small">
        <span className="muted">From </span>
        <span className="mono">{shortHash(from.address)}</span>
        <span className="muted"> · {activityWords(from.activity)}</span>
      </p>
      <label className="field">
        <span className="small muted">To one of your wallets</span>
        {link ? <p className="address-big mono">{groupAddress(link.to)}</p> : <input className="mono" spellCheck={false} autoComplete="off" placeholder="0x…" value={typed} onChange={(e) => (setTyped(e.target.value), setIsMine(false))} />}
      </label>
      {needsAnswer ? (
        <label className="check-row">
          <input type="checkbox" checked={isMine} onChange={(e) => setIsMine(e.target.checked)} />
          <span>{link ? "This is my wallet. Every character matches the address in my Mac app" : "This is my wallet"}</span>
        </label>
      ) : null}
      {link && needsAnswer ? <p className="muted small">A link filled this in, and anyone can make a link. A hardware wallet only sends to your own wallets here, so this is your check.</p> : null}
      <div className="send-row">
        <label className="field">
          <span className="small muted">Amount</span>
          <input inputMode="decimal" placeholder="0.00" value={amount} aria-invalid={amount !== "" && !units} aria-describedby={amount && !units ? amountError : undefined} onChange={(e) => (setAmount(e.target.value), setTouched(true))} />
        </label>
        <label className="field">
          <span className="small muted">Token</span>
          <select value={token.address} onChange={(e) => setToken(TOKENS.find((t) => t.address === e.target.value) ?? ETH)}>
            {TOKENS.map((t) => (
              <option key={t.address} value={t.address}>
                {t.symbol}
              </option>
            ))}
          </select>
        </label>
      </div>
      {usdMicros ? <p className="muted small">About {formatUsdIn(usdMicros.toString(), currency, rateMicros)}</p> : null}
      {amount && !units ? <p id={amountError} className="small warn-text">⚠ That isn't an amount of {token.symbol}.</p> : null}
      {refused && !needsAnswer ? <p className="small warn-text" role="alert">⚠ {refused}</p> : null}
      {check?.feeUnits ? <p className="muted small">Network fee: about {formatAmount(check.feeUnits, 18)} ETH</p> : null}
      {check?.problem ? <p className="small warn-text" role="alert">⚠ {check.problem}</p> : null}
      {canName ? <NameUnits naming={naming} onNaming={(next) => (setNaming(next), next ? null : (setPicked({}), setDropped(0)))} held={held} dropped={dropped} checking={reading && typeof held === "object"} nothingPicked={nothingPicked} picked={picked} onPick={(at, text) => setPicked((latest) => ({ ...latest, [at]: text }))} format={format} currency={heldCurrency} labelled={heldCurrency !== currency} problem={units ? pickProblem : null} /> : null}
      <p className="muted small">Your device shows the same address and amount. Trust what it shows.</p>
      <div className="device-actions">
        <button type="button" disabled={busy} onClick={onBack}>
          Back
        </button>
        <button type="button" className="primary" disabled={busy || !request || refused !== null || (needsAnswer && !isMine) || check?.blocks === true || namingBlocks} onClick={go}>
          Send from your device
        </button>
      </div>
    </>
  )
}

/** What's typed for one purchase, in the token's smallest units: empty or zero is none of it. Null when it isn't an amount. */
function pickOf(text: string, decimals: number): bigint | null {
  return /^\s*(0*\.?0*)?\s*$/.test(text) ? 0n : parseAmount(text, decimals)
}

/** An optional step: which purchases this send takes from. Left closed, the oldest go first. */
function NameUnits({ naming, onNaming, held, dropped, checking, nothingPicked, picked, onPick, format, currency, labelled, problem }: {
  naming: boolean
  onNaming: (naming: boolean) => void
  held: Held | "reading" | "failed"
  /** How many purchases that had an amount typed in a new read no longer has, so they were cleared. */
  dropped: number
  /** Reading it again, with the last read still shown. */
  checking: boolean
  nothingPicked: boolean
  picked: Readonly<Record<string, string>>
  onPick: (at: string, text: string) => void
  format: (units: bigint) => string
  /** What the costs are in. */
  currency: CurrencyCode
  /** The costs are in another currency than the rest of the page, so a bare "$" wouldn't say which. */
  labelled: boolean
  problem: string | null
}) {
  if (!naming) {
    return (
      <p className="small">
        <button type="button" className="link" onClick={() => onNaming(true)}>
          Which units?
        </button>
        <span className="muted"> Optional. Otherwise, the ones you've held longest go first.</span>
      </p>
    )
  }
  return (
    <fieldset className="name-units">
      <legend className="small">Which units does this send take?</legend>
      <p className="muted small">US tax rules let you choose which purchases a sale or send comes from, if you choose before it happens. This is saved with the send, so your tax report can use it.</p>
      {held === "reading" ? <p className="muted small" role="status">Reading what this wallet holds…</p> : null}
      {held === "failed" ? <p className="small warn-text" role="alert">⚠ Couldn't read what this wallet holds, so this send can't name its units. To send without choosing, pick "Don't choose".</p> : null}
      {typeof held === "object" && held.purchases.length === 0 ? <p className="muted small">Nothing this wallet holds says when it was bought, so there's nothing to choose from. Pick "Don't choose" to send.</p> : null}
      {typeof held === "object"
        ? held.purchases.map((purchase) => (
            <label key={purchase.boughtAt} className="name-unit">
              <span className="small">
                Bought {new Date(purchase.boughtAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                <span className="muted">
                  {" "}· {format(purchase.units)} left · {purchase.costMicros === null ? "⚠ cost unknown" : `cost ${labelled ? formatPaid(purchase.costMicros.toString(), currency) : formatMoney(purchase.costMicros, currency)}`}
                  {purchase.allOnly ? " · all or none" : ""}
                </span>
              </span>
              <input inputMode="decimal" placeholder="0" value={picked[purchase.boughtAt] ?? ""} onChange={(e) => onPick(purchase.boughtAt, e.target.value)} />
            </label>
          ))
        : null}
      {typeof held === "object" && held.unnamed > 0n ? <p className="muted small">{format(held.unnamed)} more can't be chosen, because nothing says exactly when it was bought.</p> : null}
      {dropped > 0 ? <p className="small warn-text" role="alert">⚠ {dropped === 1 ? "One purchase you chose from isn't held anymore, so it was cleared." : `${dropped} purchases you chose from aren't held anymore, so they were cleared.`} Check what's left adds up.</p> : null}
      {checking ? <p className="muted small" role="status">Checking what this wallet holds…</p> : null}
      {typeof held === "object" && nothingPicked && held.purchases.length > 0 ? <p className="muted small">Type how much comes from each purchase, or pick "Don't choose".</p> : null}
      {problem ? <p className="small warn-text" role="alert">⚠ {problem}</p> : null}
      <button type="button" className="link" onClick={() => onNaming(false)}>
        Don't choose
      </button>
    </fieldset>
  )
}

function PublishForm({ link, currency, busy, onBack, onSend }: { link: Extract<DeviceLink, { kind: "publish" }>; currency: CurrencyCode; busy: boolean; onBack: () => void; onSend: (request: ColdRequest, what: string, own: ReadonlySet<string>) => void }) {
  const [usd, setUsd] = useState(() => (link.usdMicros ? (Number(link.usdMicros) / 1_000_000).toString() : ""))
  const micros = usdMicrosOf(usd)
  const amount = link.amount ? `${formatAmount(link.amount.units, link.amount.decimals)} ${link.asset}` : link.asset
  const go = () => {
    if (!micros) return
    // To the wallet the link names, so from any other this isn't a send to itself, and the rule refuses it.
    onSend({ to: link.wallet, value: 0n, data: encodeNote(link.txHash, link.asset, micros) as Hex }, `This wallet published that it paid ${labelUsd(formatExactUsd(micros), currency)} for ${amount} in transaction ${shortHash(link.txHash)}.`, new Set())
  }
  return (
    <>
      <p className="notice warn">⚠ {PUBLISH_WARNING}</p>
      <label className="field">
        <span className="small muted">Paid for {amount}, in USD</span>
        <input inputMode="decimal" placeholder="$0.00" value={usd} onChange={(e) => setUsd(e.target.value)} />
      </label>
      {micros ? <p className="muted small">This wallet would publish that it paid {labelUsd(formatExactUsd(micros), currency)} in transaction {shortHash(link.txHash)}.</p> : null}
      <p className="muted small">{PUBLISH_DETAIL}</p>
      <p className="muted small">{PUBLISH_DEVICE_NOTE}</p>
      <div className="device-actions">
        <button type="button" disabled={busy} onClick={onBack}>
          Back
        </button>
        <button type="button" className="primary" disabled={busy || !micros} onClick={go}>
          Publish for everyone
        </button>
      </div>
    </>
  )
}
