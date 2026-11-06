import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { formatAmount, formatMoney, formatSignedMoney, shortHash, type CurrencyCode, type Method } from "@pricetag/sdk/core"
import type { BookPreview, WalletResponse } from "../core/api.ts"
import { answerSender, enterExchangeCosts, linkMessage, proofOwner, walletsBehind, type Book, type Money, type SenderAnswer } from "../core/book.ts"
import { readCheckedAccounts } from "../core/device-accounts.ts"
import { noteLinkFor, type DeviceLink } from "../core/device-link.ts"
import { parseCoinbaseCsv } from "../core/exchange-import.ts"
import { foldBook, isBalanced, microsOf, previewBook, type Question } from "../core/resolve.ts"
import { ALL_ANSWERED, ANSWER_QUESTIONS, COST_QUESTION, COST_WHY, EXCHANGE_COST_WHY, NOTHING_LEFT, SENDER_QUESTION, SENDER_WHY, finishNote, linkedFailedSentence } from "../core/wording.ts"

type Ownership = "mine" | "my-exchange" | "someone-else"

const OWNERSHIP: readonly { kind: Ownership; title: string; swipe: string }[] = [
  { kind: "mine", title: "My wallet", swipe: "→" },
  { kind: "my-exchange", title: "My exchange account", swipe: "↑" },
  { kind: "someone-else", title: "Someone else", swipe: "←" },
]

const SWIPE_PX = 110

const pnlWords = (pnl: string | null, estimated: string, unresolved: string, currency: CurrencyCode) => {
  if (pnl === null) return "PnL unavailable"
  const number = `${BigInt(estimated) > 0n ? "≈" : ""}${formatSignedMoney(pnl, currency)}`
  return BigInt(unresolved) > 0n ? `${number} · ${formatMoney(unresolved, currency)} cost unknown` : number
}

const consequence = (preview: BookPreview, currency: CurrencyCode) => (preview.failed ? "Couldn't read that wallet" : preview.pending ? "Reading that wallet…" : preview.pnlMicros === null ? "PnL still unavailable" : pnlWords(preview.pnlMicros, preview.estimatedMicros, preview.unresolvedMicros, currency))

/** A typed cost next to what it was worth, to catch a slip. It's only ever a warning: what someone paid is theirs to say. */
function looksOff(entered: string | null, value: string | null): boolean {
  if (entered === null || value === null || BigInt(value) === 0n) return false
  const ratio = (BigInt(entered) * 100n) / BigInt(value)
  return ratio > 500n || ratio < 20n
}

type Props = {
  /** Wallets whose last read failed. */
  failed: readonly string[]
  onRetry: () => void
  wallet: WalletResponse
  others: readonly WalletResponse[]
  method: Method
  book: Book
  /** Which holding Resolve was clicked on, so its questions come first. */
  firstAsset: string | null
  onChange: (book: Book) => void
  onUndo: () => void
  canUndo: boolean
  /** Publishing a cost takes a device, which has its own panel. */
  onPublish: (link: DeviceLink) => void
  /** The sender on the card, whose wallet has to be read to say what "My wallet" would do. */
  onCurrentSender: (sender: string | null) => void
  onClose: () => void
}

/** Answering questions: one card at a time, with swipes, keys or taps. Each answer shows what it does before you pick it. */
export function ResolvePanel({ wallet, others, failed, onRetry, method, book, firstAsset, onChange, onUndo, canUndo, onPublish, onCurrentSender, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set())
  const [asking, setAsking] = useState(false)
  const [costs, setCosts] = useState<Record<string, string>>({})
  const [message, setMessage] = useState<string | null>(null)
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)

  useLayoutEffect(() => {
    const element = dialog.current
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (element && !element.open) element.showModal()
    return () => {
      element?.close()
      opener?.focus()
    }
  }, [])

  const fold = useMemo(() => foldBook(wallet, others as WalletResponse[], method, book), [wallet, others, method, book])
  const { currency } = fold.view
  const questions = useMemo(() => {
    const open = fold.questions.filter((q) => !skipped.has(q.id))
    if (!firstAsset) return open
    const has = (q: Question) => q.arrivals.some((a) => a.asset === firstAsset)
    return [...open.filter(has), ...open.filter((q) => !has(q))]
  }, [fold, skipped, firstAsset])
  const current = questions[0] ?? null
  const sender = current?.sender ?? null
  const takingCost = current !== null && (current.kind === "cost" || asking || current.needsCost)
  // Only for an account someone checked on a device from this browser, because that's who can sign it.
  const publishable = current && readCheckedAccounts().some((account) => account.address === current.wallet) ? noteLinkFor(current, costs[current.arrivals[0]?.asset ?? ""] ?? null, currency) : null
  const linkedFailed = failed.filter((address) => walletsBehind(book, wallet).includes(address))
  const balanced = isBalanced(fold.meter) && linkedFailed.length === 0 && fold.withheld.length === 0
  const progress = fold.meter.open + fold.meter.answered === 0 ? 1 : fold.meter.answered / (fold.meter.open + fold.meter.answered)

  useEffect(() => onCurrentSender(sender), [sender, onCurrentSender])
  useEffect(() => {
    setCosts({})
    setMessage(null)
  }, [current?.id])

  // What's already said to be a wallet can't also be an exchange account, and what's asked here is about the wallet it reached.
  const options = sender && book.senders[sender]?.kind === "mine" ? OWNERSHIP.filter(({ kind }) => kind !== "my-exchange") : OWNERSHIP
  const answer = (next: SenderAnswer) => sender && onChange(answerSender(book, wallet.address, sender, next))
  const choose = (kind: Ownership) => {
    if (!options.some((option) => option.kind === kind)) return
    // What was entered for this sender before stays, because it covers what had arrived by then.
    const earlier = sender ? book.senders[sender] : undefined
    answer(kind === "my-exchange" && earlier?.kind === "my-exchange" ? earlier : { kind })
    setAsking(kind === "my-exchange")
  }
  const skip = () => {
    if (!current) return
    setSkipped(new Set([...skipped, current.id]))
    setAsking(false)
  }
  const previews = useMemo(() => {
    if (!sender || takingCost) return null
    const preview = (kind: "mine" | "someone-else") => previewBook(wallet, others as WalletResponse[], method, answerSender(book, wallet.address, sender, { kind }), failed)
    return { mine: preview("mine"), "someone-else": preview("someone-else") }
  }, [sender, takingCost, wallet, others, method, book, failed])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault()
        onUndo()
        return
      }
      if (e.target instanceof HTMLInputElement || !current) return
      if (e.key === "ArrowDown") return skip()
      if (takingCost) return
      const kind = options[Number(e.key) - 1]?.kind ?? ({ ArrowRight: "mine", ArrowUp: "my-exchange", ArrowLeft: "someone-else" } as Record<string, Ownership>)[e.key]
      if (kind) choose(kind)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  /** The book a typed cost leads to, or null until every amount reads as one. */
  const costBook = useMemo(() => {
    if (!current) return null
    const entered = Object.fromEntries(current.arrivals.map((a) => [a.asset, microsOf(costs[a.asset] ?? "", currency)]))
    if (Object.values(entered).includes(null)) return null
    const money = (micros: string | null): Money => ({ micros: micros as string, currency })
    if (current.sender) return enterExchangeCosts(book, wallet.address, current.sender, current.receipts, Object.fromEntries(Object.entries(entered).map(([asset, micros]) => [asset, money(micros)])))
    return current.costKey ? { ...book, costs: { ...book.costs, [current.costKey]: money(Object.values(entered)[0] as string) } } : null
  }, [current, costs, book, wallet.address, currency])
  const saveCost = () => {
    if (!costBook) return setMessage("That isn't an amount.")
    onChange(costBook)
    setAsking(false)
  }
  const importFile = async (file: File | undefined) => {
    if (!file) return
    const imported = parseCoinbaseCsv(await file.text())
    if (!imported) return setMessage("That doesn't look like a Coinbase transaction history.")
    onChange({ ...book, withdrawals: imported.withdrawals })
    setMessage(`Found ${imported.withdrawals.length} withdrawals.${imported.skipped > 0 ? ` ${imported.skipped} had no usable cost.` : ""}`)
    setAsking(false)
  }

  const onPointerUp = (e: ReactPointerEvent) => {
    const from = start.current
    start.current = null
    setDrag(null)
    if (!from) return
    const [x, y] = [e.clientX - from.x, e.clientY - from.y]
    if (x > SWIPE_PX) choose("mine")
    else if (x < -SWIPE_PX) choose("someone-else")
    else if (y < -SWIPE_PX) choose("my-exchange")
    else if (y > SWIPE_PX) skip()
  }

  return (
    <dialog ref={dialog} className="resolve" aria-label={ANSWER_QUESTIONS} onCancel={(e) => (e.preventDefault(), onClose())}>
      <header className="panel-head">
        <h2>{current ? (takingCost ? COST_QUESTION : SENDER_QUESTION) : balanced ? ALL_ANSWERED : NOTHING_LEFT}</h2>
        {fold.meter.open > 0 ? <span className="muted small">{fold.meter.open} left</span> : null}
      </header>
      {current ? <p className="small muted">{!takingCost ? SENDER_WHY : current.sender ? EXCHANGE_COST_WHY : COST_WHY}</p> : null}
      <div className="meter" role="progressbar" aria-label="Questions left" aria-valuenow={Math.round(progress * 100)}>
        <div className={balanced ? "meter-fill done" : "meter-fill"} style={{ width: `${progress * 100}%` }} />
      </div>
      <p className="small">
        <span className="muted">Now </span>
        {pnlWords(fold.totals.pnlMicros, fold.totals.estimatedMicros, fold.totals.unresolvedMicros, currency)}
        {BigInt(fold.totals.estimatedMicros) > 0n ? ` · ${formatMoney(fold.totals.estimatedMicros, currency)} estimated` : ""}
      </p>

      {current ? (
        <div
          className="who-card"
          style={drag ? { transform: `translate(${drag.x}px, ${drag.y}px) rotate(${drag.x / 40}deg)` } : undefined}
          onPointerDown={(e) => {
            // A press on something that does its own thing is its own, or the card would take its click away.
            if (takingCost || (e.target instanceof Element && e.target.closest("button, input, label, a"))) return
            start.current = { x: e.clientX, y: e.clientY }
            e.currentTarget.setPointerCapture(e.pointerId)
          }}
          onPointerMove={(e) => start.current && setDrag({ x: e.clientX - start.current.x, y: e.clientY - start.current.y })}
          onPointerUp={onPointerUp}
        >
          {current.arrivals.map((arrival) => (
            <strong key={arrival.asset} className="arrived">
              {formatAmount(arrival.units, arrival.decimals)} {arrival.asset}
            </strong>
          ))}
          {current.sender ? (
            <p className="small muted">
              From {shortHash(current.sender)} · {current.transfers === 1 ? "1 transfer" : `${current.transfers} transfers`}
              {current.wallet !== wallet.address.toLowerCase() ? ` · arrived in your other wallet ${shortHash(current.wallet)}` : ""}
            </p>
          ) : current.wallet !== wallet.address.toLowerCase() ? (
            <p className="small muted">Arrived in your other wallet {shortHash(current.wallet)}</p>
          ) : null}
          {current.evidence.map((fact) => (
            <p key={fact} className="small muted">
              💡 {fact}
            </p>
          ))}
          {takingCost ? (
            <div className="cost-form">
              {current.arrivals.map((arrival) => (
                <label key={arrival.asset} className="small">
                  Paid for {formatAmount(arrival.units, arrival.decimals)} {arrival.asset}
                  <input autoFocus inputMode="decimal" placeholder={formatMoney("0", currency)} value={costs[arrival.asset] ?? ""} onChange={(e) => setCosts({ ...costs, [arrival.asset]: e.target.value })} />
                </label>
              ))}
              {costBook ? <p className="small">That would make it {consequence(previewBook(wallet, others as WalletResponse[], method, costBook, failed), currency)}</p> : null}
              {current.arrivals.length === 1 && looksOff(microsOf(costs[(current.arrivals[0] as { asset: string }).asset] ?? "", currency), current.valueMicros) ? <p className="small warn-text">⚠ That's far from what it was worth when it arrived, about {formatMoney(current.valueMicros as string, currency)}. Double-check it.</p> : null}
              <div className="cost-actions">
                <button type="button" onClick={saveCost}>
                  Save
                </button>
                {current.sender ? (
                  <>
                    <label className="file-button">
                      Import Coinbase history
                      <input type="file" accept=".csv,text/csv" hidden onChange={(e) => void importFile(e.target.files?.[0])} />
                    </label>
                    <button type="button" title="An estimate, and it's always shown as one" onClick={() => choose("someone-else")}>
                      Use the price when it arrived
                    </button>
                  </>
                ) : null}
                {publishable ? (
                  <button type="button" title="Writes what you paid on Base, where anyone can read it" onClick={() => onPublish(publishable)}>
                    Publish from your device…
                  </button>
                ) : null}
              </div>
              <p className="small muted">This stays in this browser. Publishing a cost onchain would tie your wallets together in public, so that's never done without asking.</p>
            </div>
          ) : (
            <div className="answers">
              {options.map(({ kind, title, swipe }, i) => (
                <button key={kind} type="button" onClick={() => choose(kind)}>
                  <span className="answer-title">{title}</span>
                  <span className="muted small">{kind === "my-exchange" ? "Then asks what you paid" : previews ? consequence(previews[kind], currency) : "…"}</span>
                  <span className="muted small key">
                    {i + 1} {swipe}
                  </span>
                </button>
              ))}
            </div>
          )}
          {message ? <p className="small warn-text">{message}</p> : null}
        </div>
      ) : (
        <div className="finish">
          <div className={balanced ? "seal done" : "seal"}>{balanced ? "✓" : "…"}</div>
          {linkedFailed.length > 0 ? (
            <>
              <p className="small warn-text">⚠ {linkedFailedSentence(linkedFailed.length)}</p>
              <button type="button" onClick={onRetry}>
                Try again
              </button>
            </>
          ) : null}
          {fold.meter.waiting > linkedFailed.length ? <p className="small muted">Still reading your other {fold.meter.waiting === 1 ? "wallet" : "wallets"}. What came from {fold.meter.waiting === 1 ? "it" : "them"} has an unknown cost until that's done.</p> : null}
          {fold.totals.excluded.length > 0 ? <p className="small muted">{finishNote(fold.meter)}</p> : null}
          {skipped.size > 0 ? (
            <>
              <p className="small warn-text">{skipped.size} skipped, and still flagged.</p>
              <button type="button" onClick={() => setSkipped(new Set())}>
                Go back to them
              </button>
            </>
          ) : null}
        </div>
      )}

      <LinkByProof current={wallet.address} book={book} onChange={onChange} />

      <footer className="resolve-foot">
        <button type="button" disabled={!canUndo} onClick={onUndo}>
          Undo
        </button>
        <span className="spacer" />
        {current ? (
          <button type="button" title="Stays flagged. You can come back to it." onClick={skip}>
            Skip
          </button>
        ) : null}
        <button type="button" onClick={onClose}>
          Done
        </button>
      </footer>
    </dialog>
  )
}

type Ethereum = { request(args: { method: string; params?: unknown[] }): Promise<unknown> }

/** Signing with a browser wallet proves it's yours, so it links without a question, and only that wallet. Hot wallets only: cold ones never connect to a site. */
function LinkByProof({ current, book, onChange }: { current: string; book: Book; onChange: (book: Book) => void }) {
  const [status, setStatus] = useState<string | null>(null)
  const ethereum = (window as unknown as { ethereum?: Ethereum }).ethereum
  if (!ethereum) return null
  const prove = async () => {
    try {
      const [address] = (await ethereum.request({ method: "eth_requestAccounts" })) as string[]
      if (!address) return
      const owner = proofOwner(book, address, current)
      const message = linkMessage(owner, address)
      const signature = await ethereum.request({ method: "personal_sign", params: [message, address] })
      const response = await fetch("/api/links/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner, address, signature }) })
      const { verified } = (await response.json()) as { verified?: boolean }
      if (!verified) return setStatus("That signature isn't from this wallet.")
      onChange(answerSender(book, null, address, { kind: "mine" }))
      setStatus(`Linked ${shortHash(address)}.`)
    } catch {
      setStatus("Didn't link it. Nothing changed.")
    }
  }
  return (
    <p className="small muted">
      <button type="button" className="link" onClick={() => void prove()}>
        Link this browser's wallet by signing
      </button>{" "}
      It can't move funds, and it's for hot wallets only. {status}
    </p>
  )
}
