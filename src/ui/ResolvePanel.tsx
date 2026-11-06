import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { formatAmount, formatMoney, formatSignedMoney, shortHash, type CurrencyCode, type Method } from "@pricetag/sdk/core"
import type { BookPreview, WalletResponse } from "../core/api.ts"
import { combinedPortfolioOf, previewCombined, type Unread } from "../core/combined.ts"
import { answerSender, enterExchangeCosts, walletsBehind, type Book, type BookChange, type Money, type SenderAnswer } from "../core/book.ts"
import { readCheckedAccounts } from "../core/device-accounts.ts"
import { noteLinkFor, type DeviceLink } from "../core/device-link.ts"
import { importStart, keepingImport, parseCoinbaseCsv, startsAfterImported, type ExchangeImport } from "../core/exchange-import.ts"
import { answersOffered, foldBook, isBalanced, microsOf, previewBook, type Question } from "../core/resolve.ts"
import { ALL_ANSWERED, ANSWERS_STAY, ANSWER_QUESTIONS, COST_QUESTION, COST_WHY, EXCHANGE_COST_WHY, NOT_SAVED, NOTHING_LEFT, SENDER_QUESTION, SENDER_WHY, finishNote, IMPORT_NOT_WHOLE, IMPORT_QUESTION, IMPORT_STARTS_LATE, importedSentence, importWhySentence, linkedFailedSentence } from "../core/wording.ts"
import { linkByProof, type Ethereum } from "./link-proof.ts"

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
  /** Set when these wallets are being answered for together, as All Yours: which others aren't read yet. Each question is then about the wallet it arrived in. */
  all?: Unread
  method: Method
  book: Book
  /** Which holding Resolve was clicked on, so its questions come first. */
  firstAsset: string | null
  /** `onSaved` hears what the change was made to, since that can be more than what's on screen. */
  onChange: (change: BookChange, onSaved?: (before: Book) => void) => void
  onUndo: () => void
  canUndo: boolean
  /** The last answer or undo couldn't be saved. */
  notSaved: boolean
  /** Publishing a cost takes a device, which has its own panel. */
  onPublish: (link: DeviceLink) => void
  /** The sender on the card, whose wallet has to be read to say what "My wallet" would do. */
  onCurrentSender: (sender: string | null) => void
  onClose: () => void
}

/** Answering questions: one card at a time, with swipes, keys or taps. Each answer shows what it does before you pick it. */
export function ResolvePanel({ wallet, others, all, failed, onRetry, method, book, firstAsset, onChange, onUndo, canUndo, notSaved, onPublish, onCurrentSender, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set())
  const [asking, setAsking] = useState(false)
  const [costs, setCosts] = useState<Record<string, string>>({})
  const [message, setMessage] = useState<string | null>(null)
  // Apart from the message, which goes with its card, because an import can answer the card it was made from.
  const [lastImport, setLastImport] = useState<ExchangeImport | null>(null)
  const [pendingImport, setPendingImport] = useState<ExchangeImport | null>(null)
  const [importRefusal, setImportRefusal] = useState<string | null>(null)
  const importAsk = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)

  // It's below the card, which can put it out of sight in a short window, and then picking a file looks like it did nothing.
  useEffect(() => {
    if (pendingImport || importRefusal) importAsk.current?.scrollIntoView({ block: "nearest" })
  }, [pendingImport, importRefusal])

  useLayoutEffect(() => {
    const element = dialog.current
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (element && !element.open) element.showModal()
    return () => {
      element?.close()
      opener?.focus()
    }
  }, [])

  const fold = useMemo(() => {
    if (!all) {
      const one = foldBook(wallet, others as WalletResponse[], method, book)
      return { ...one, currency: one.view.currency }
    }
    return combinedPortfolioOf([wallet, ...others], method, book, all)
  }, [wallet, others, all, method, book])
  const { currency } = fold
  const questions = useMemo(() => {
    const firstOf = (list: Question[], has: (q: Question) => boolean) => [...list.filter(has), ...list.filter((q) => !has(q))]
    const open = fold.questions.filter((q) => !skipped.has(q.id))
    // The wallet showing comes before the ones it's linked to, which can have questions of their own.
    const ordered = all ? open : firstOf(open, (q) => q.wallet === wallet.address.toLowerCase())
    return firstAsset ? firstOf(ordered, (q) => q.arrivals.some((a) => a.asset === firstAsset)) : ordered
  }, [fold, skipped, firstAsset, all, wallet.address])
  const current = questions[0] ?? null
  const sender = current?.sender ?? null
  // What an answer's about: the wallet showing, or with all of them showing, the one it arrived in.
  const focus = all && current ? current.wallet : wallet.address
  const takingCost = current !== null && (current.kind === "cost" || asking || current.needsCost)
  // Only for an account someone checked on a device from this browser, because that's who can sign it.
  const publishable = current && readCheckedAccounts().some((account) => account.address === current.wallet) ? noteLinkFor(current, costs[current.arrivals[0]?.asset ?? ""] ?? null, currency) : null
  const linkedFailed = all ? all.failed : failed.filter((address) => walletsBehind(book, wallet).includes(address))
  const balanced = isBalanced(fold.meter) && linkedFailed.length === 0 && fold.withheld.length === 0
  const progress = fold.meter.open + fold.meter.answered === 0 ? 1 : fold.meter.answered / (fold.meter.open + fold.meter.answered)

  const offered = current ? answersOffered(current, book) : []
  const options = OWNERSHIP.filter(({ kind }) => offered.includes(kind))
  const offersMine = offered.includes("mine")

  // With no My wallet to say anything about, there's no reason to read that address.
  useEffect(() => onCurrentSender(offersMine ? sender : null), [offersMine, sender, onCurrentSender])
  useEffect(() => {
    setCosts({})
    setMessage(null)
  }, [current?.id])

  const answer = (next: SenderAnswer) => sender && onChange(answerSender(book, focus, sender, next))
  /** What a book would make the headline say. A sender that would join All Yours hasn't been read yet, so it says that rather than leave it out. */
  const previewOf = (next: Book) => {
    if (!all) return previewBook(wallet, others as WalletResponse[], method, next, failed)
    const joining = sender && next.senders[sender]?.kind === "mine" && ![wallet, ...others].some((one) => one.address.toLowerCase() === sender) ? [sender] : []
    return previewCombined([wallet, ...others], method, [next], { reading: [...all.reading, ...joining], failed: all.failed })[0] as BookPreview
  }
  const choose = (kind: Ownership) => {
    if (!options.some((option) => option.kind === kind)) return
    // What was entered for this sender before stays, because it covers what had arrived by then.
    const earlier = sender ? book.senders[sender] : undefined
    answer(kind === "my-exchange" && earlier?.kind === "my-exchange" ? earlier : { kind })
    setAsking(kind === "my-exchange")
  }
  const undo = () => {
    setLastImport(null)
    setImportRefusal(null)
    onUndo()
  }
  const skip = () => {
    if (!current) return
    setSkipped(new Set([...skipped, current.id]))
    setAsking(false)
  }
  const previews = useMemo(() => {
    if (!sender || takingCost) return null
    const preview = (kind: "mine" | "someone-else") => previewOf(answerSender(book, focus, sender, { kind }))
    return { mine: offersMine ? preview("mine") : null, "someone-else": preview("someone-else") }
  }, [sender, focus, takingCost, offersMine, wallet, others, all, method, book, failed])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // With a dialog open over this one, like the device's, keys are its business, wherever its focus has gone.
      if (document.querySelector("dialog:modal:not(.resolve)")) return
      // Whatever's pressed in a field is the field's, including undoing what's been typed.
      if (e.target instanceof HTMLInputElement) return
      if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault()
        undo()
        return
      }
      // With a modifier it's someone else's shortcut, like Alt+Left for Back. Holding a key down is one answer, not one per card.
      if (!current || e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
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
    if (current.sender) return enterExchangeCosts(book, focus, current.sender, current.receipts, Object.fromEntries(Object.entries(entered).map(([asset, micros]) => [asset, money(micros)])))
    return current.costKey ? { ...book, costs: { ...book.costs, [current.costKey]: money(Object.values(entered)[0] as string) } } : null
  }, [current, costs, book, focus, currency])
  const saveCost = () => {
    if (!costBook) return setMessage("That isn't an amount.")
    onChange(costBook)
    setAsking(false)
  }
  const importFile = async (file: File | undefined) => {
    if (!file) return
    const imported = parseCoinbaseCsv(await file.text())
    setPendingImport(null)
    setImportRefusal(null)
    setLastImport(null)
    if (!imported) return setMessage("That doesn't look like a Coinbase transaction history.")
    setMessage(null)
    if (imported.withdrawals.length === 0) return setLastImport(imported)
    if (startsAfterImported(book.withdrawals, imported)) return setImportRefusal(IMPORT_STARTS_LATE)
    setPendingImport(imported)
  }
  const keepImport = (imported: ExchangeImport) => {
    setPendingImport(null)
    onChange(
      (latest) => keepingImport(latest, imported),
      (before) => {
        if (startsAfterImported(before.withdrawals, imported)) return setImportRefusal(IMPORT_STARTS_LATE)
        setLastImport(imported)
        setAsking(false)
      },
    )
  }
  const declineImport = () => {
    setPendingImport(null)
    setImportRefusal(IMPORT_NOT_WHOLE)
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
      <p className="small" role="status">
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
          onPointerCancel={() => {
            start.current = null
            setDrag(null)
          }}
        >
          {current.arrivals.map((arrival) => (
            <strong key={arrival.asset} className="arrived">
              {formatAmount(arrival.units, arrival.decimals)} {arrival.asset}
            </strong>
          ))}
          {current.sender ? (
            <p className="small muted">
              From {shortHash(current.sender)} · {current.transfers === 1 ? "1 transfer" : `${current.transfers} transfers`}
              {all ? ` · arrived in ${shortHash(current.wallet)}` : current.wallet !== wallet.address.toLowerCase() ? ` · arrived in your other wallet ${shortHash(current.wallet)}` : ""}
            </p>
          ) : all ? (
            <p className="small muted">Arrived in {shortHash(current.wallet)}</p>
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
              {costBook ? <p className="small">That would make it {consequence(previewOf(costBook), currency)}</p> : null}
              {current.arrivals.length === 1 && looksOff(microsOf(costs[(current.arrivals[0] as { asset: string }).asset] ?? "", currency), current.valueMicros) ? <p className="small warn-text" role="status">⚠ That's far from what it was worth when it arrived, about {formatMoney(current.valueMicros as string, currency)}. Double-check it.</p> : null}
              <div className="cost-actions">
                <button type="button" onClick={saveCost}>
                  Save
                </button>
                {current.sender ? (
                  <>
                    <label className="file-button">
                      Import Coinbase history
                      <input type="file" accept=".csv,text/csv" className="visually-hidden" onChange={(e) => { void importFile(e.target.files?.[0]); e.target.value = "" }} />
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
              <p className="small muted">{ANSWERS_STAY}</p>
            </div>
          ) : (
            <div className="answers">
              {options.map(({ kind, title, swipe }, i) => (
                <button key={kind} type="button" onClick={() => choose(kind)}>
                  <span className="answer-title">{title}</span>
                  <span className="muted small">{kind === "my-exchange" ? "Then asks what you paid" : previews?.[kind] ? consequence(previews[kind], currency) : "…"}</span>
                  <span className="muted small key">
                    {i + 1} {swipe}
                  </span>
                </button>
              ))}
            </div>
          )}
          {message ? <p className="small warn-text" role="alert">{message}</p> : null}
        </div>
      ) : (
        <div className="finish">
          <div className={balanced ? "seal done" : "seal"} aria-hidden="true">{balanced ? "✓" : "…"}</div>
          {linkedFailed.length > 0 ? (
            <>
              <p className="small warn-text" role="alert">⚠ {linkedFailedSentence(linkedFailed.length)}</p>
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

      {lastImport ? (
        <p className={lastImport.withdrawals.length > 0 && lastImport.skipped === 0 ? "small muted" : "small warn-text"} role="status">
          {importedSentence(lastImport.withdrawals.length, lastImport.skipped)}
        </p>
      ) : null}

      <div ref={importAsk}>
        {importRefusal ? <p className="small warn-text" role="status">{importRefusal}</p> : null}
        {pendingImport ? (
          <div role="group" aria-label="Importing a file">
            <p className="small"><strong>{IMPORT_QUESTION}</strong> {importWhySentence(importStart(pendingImport) as string)}</p>
            <div className="cost-actions">
              <button type="button" onClick={() => keepImport(pendingImport)}>
                Yes, use it
              </button>
              <button type="button" onClick={declineImport}>
                No, don't use it
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <LinkByProof current={wallet.address} book={book} onChange={onChange} />

      {notSaved ? <p className="notice warn" role="alert">⚠ {NOT_SAVED}</p> : null}

      <footer className="resolve-foot">
        <button type="button" disabled={!canUndo} onClick={undo}>
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

/** Signing with a browser wallet proves it's yours, so it links without a question, and only that wallet. Hot wallets only: cold ones never connect to a site. */
function LinkByProof({ current, book, onChange }: { current: string; book: Book; onChange: (change: BookChange) => void }) {
  const [status, setStatus] = useState<string | null>(null)
  const latest = useRef(book)
  latest.current = book
  const ethereum = (window as unknown as { ethereum?: Ethereum }).ethereum
  if (!ethereum) return null
  const prove = async () => {
    const said = await linkByProof(ethereum, current, () => latest.current, onChange)
    if (said) setStatus(said)
  }
  return (
    <p className="small muted">
      <button type="button" className="link" onClick={() => void prove()}>
        Link this browser's wallet by signing
      </button>{" "}
      It can't move funds, and it's for hot wallets only. <span role="status">{status}</span>
    </p>
  )
}
