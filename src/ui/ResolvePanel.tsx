import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import type { BookPreview, WalletResponse } from "../core/api.ts"
import { answerSender, linkMessage, type Book, type SenderAnswer } from "../core/book.ts"
import { parseCoinbaseCsv } from "../core/exchange-import.ts"
import type { Method } from "../core/fold.ts"
import { formatAmount, formatSignedUsd, formatUsd, shortHash } from "../core/format.ts"
import { foldBook, previewBook } from "../core/portfolio.ts"
import type { Question } from "../core/resolve.ts"

type Ownership = "mine" | "my-exchange" | "someone-else"

const OWNERSHIP: readonly { kind: Ownership; title: string; swipe: string }[] = [
  { kind: "mine", title: "My wallet", swipe: "→" },
  { kind: "my-exchange", title: "My exchange account", swipe: "↑" },
  { kind: "someone-else", title: "Someone else", swipe: "←" },
]

const SWIPE_PX = 110

/** Dollars as typed, as micro-USD. Null when it isn't an amount. */
function microsOf(text: string): string | null {
  const clean = text.replace(/[$,\s]/g, "")
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(clean)) return null
  const [whole = "", fraction = ""] = clean.split(".")
  return BigInt(`${whole || "0"}${fraction.slice(0, 6).padEnd(6, "0")}`).toString()
}

export const pnlWords = (pnl: string | null, estimated: string, unresolved: string) => {
  if (pnl === null) return "PnL unavailable"
  const number = `${BigInt(estimated) > 0n ? "≈" : ""}${formatSignedUsd(pnl)}`
  return BigInt(unresolved) > 0n ? `${number} · ${formatUsd(unresolved)} unresolved` : number
}

const consequence = (preview: BookPreview) => (preview.pending ? "Reading that wallet…" : preview.pnlUsdMicros === null ? "PnL still unavailable" : pnlWords(preview.pnlUsdMicros, preview.estimatedUsdMicros, preview.unresolvedUsdMicros))

type Props = {
  wallet: WalletResponse
  others: readonly WalletResponse[]
  method: Method
  book: Book
  /** Which holding Resolve was clicked on, so its questions come first. */
  firstAsset: string | null
  onChange: (book: Book) => void
  onUndo: () => void
  canUndo: boolean
  /** The sender on the card, whose wallet has to be read to say what "My wallet" would do. */
  onCurrentSender: (sender: string | null) => void
  onClose: () => void
}

/** "Who's this?": one card at a time, with swipes, keys or taps. Each answer shows what it does before you pick it. */
export function ResolvePanel({ wallet, others, method, book, firstAsset, onChange, onUndo, canUndo, onCurrentSender, onClose }: Props) {
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
  const questions = useMemo(() => {
    const open = fold.questions.filter((q) => !skipped.has(q.id))
    if (!firstAsset) return open
    const has = (q: Question) => q.arrivals.some((a) => a.asset === firstAsset)
    return [...open.filter(has), ...open.filter((q) => !has(q))]
  }, [fold, skipped, firstAsset])
  const current = questions[0] ?? null
  const sender = current?.sender ?? null
  const takingCost = current !== null && (current.kind === "cost" || asking || current.needsCost)
  const balanced = fold.meter.open === 0 && fold.meter.answered > 0
  const progress = fold.meter.open + fold.meter.answered === 0 ? 1 : fold.meter.answered / (fold.meter.open + fold.meter.answered)

  useEffect(() => onCurrentSender(sender), [sender, onCurrentSender])
  useEffect(() => {
    setCosts({})
    setMessage(null)
  }, [current?.id])

  const answer = (next: SenderAnswer) => sender && onChange(answerSender(book, wallet.address, sender, next))
  const choose = (kind: Ownership) => {
    if (kind === "my-exchange") {
      answer({ kind })
      setAsking(true)
    } else {
      answer({ kind })
      setAsking(false)
    }
  }
  const skip = () => {
    if (!current) return
    setSkipped(new Set([...skipped, current.id]))
    setAsking(false)
  }
  const previews = useMemo(() => {
    if (!sender || takingCost) return null
    const preview = (kind: "mine" | "someone-else") => previewBook(wallet, others as WalletResponse[], method, answerSender(book, wallet.address, sender, { kind }))
    return { mine: preview("mine"), "someone-else": preview("someone-else") }
  }, [sender, takingCost, wallet, others, method, book])

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
      const kind = ({ "1": "mine", "2": "my-exchange", "3": "someone-else", ArrowRight: "mine", ArrowUp: "my-exchange", ArrowLeft: "someone-else" } as Record<string, Ownership>)[e.key]
      if (kind) choose(kind)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  /** The book a typed cost leads to, or null until every amount reads as one. */
  const costBook = useMemo(() => {
    if (!current) return null
    const entered = Object.fromEntries(current.arrivals.map((a) => [a.asset, microsOf(costs[a.asset] ?? "")]))
    if (Object.values(entered).includes(null)) return null
    if (current.sender) return answerSender(book, wallet.address, current.sender, { kind: "my-exchange", costs: entered as Record<string, string> })
    return current.costKey ? { ...book, costs: { ...book.costs, [current.costKey]: Object.values(entered)[0] as string } } : null
  }, [current, costs, book, wallet.address])
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
    setMessage(`Found ${imported.withdrawals.length} withdrawals.${imported.skipped > 0 ? ` ${imported.skipped} had no usable cost, like one bought in another currency.` : ""}`)
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
    <dialog ref={dialog} className="resolve" aria-label="Who's this?" onCancel={(e) => (e.preventDefault(), onClose())}>
      <header className="panel-head">
        <h2>{current ? (takingCost ? "What did this cost?" : "Who's this?") : balanced ? "Books balanced" : "That's all for now"}</h2>
        {fold.meter.open > 0 ? <span className="muted small">{fold.meter.open} left</span> : null}
      </header>
      <div className="meter" role="progressbar" aria-label="Unresolved" aria-valuenow={Math.round(progress * 100)}>
        <div className={balanced ? "meter-fill done" : "meter-fill"} style={{ width: `${progress * 100}%` }} />
      </div>
      <p className="small">
        <span className="muted">Now </span>
        {pnlWords(fold.totals.pnlUsdMicros, fold.totals.estimatedUsdMicros, fold.totals.unresolvedUsdMicros)}
      </p>

      {current ? (
        <div
          className="who-card"
          style={drag ? { transform: `translate(${drag.x}px, ${drag.y}px) rotate(${drag.x / 40}deg)` } : undefined}
          onPointerDown={(e) => {
            if (takingCost || e.target instanceof HTMLButtonElement || e.target instanceof HTMLInputElement) return
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
          <p className="small muted">
            {current.sender ? `From ${shortHash(current.sender)} · ${current.transfers === 1 ? "1 transfer" : `${current.transfers} transfers`}` : "We can't tell what you paid for this"}
            {current.wallet !== wallet.address.toLowerCase() ? ` · arrived in your other wallet ${shortHash(current.wallet)}` : ""}
          </p>
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
                  <input autoFocus inputMode="decimal" placeholder="$0.00" value={costs[arrival.asset] ?? ""} onChange={(e) => setCosts({ ...costs, [arrival.asset]: e.target.value })} />
                </label>
              ))}
              {costBook ? <p className="small">That would make it {consequence(previewBook(wallet, others as WalletResponse[], method, costBook))}</p> : null}
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
              </div>
              <p className="small muted">This stays in this browser. Publishing a cost onchain would tie your wallets together in public, so that's never done without asking.</p>
            </div>
          ) : (
            <div className="answers">
              {OWNERSHIP.map(({ kind, title, swipe }, i) => (
                <button key={kind} type="button" onClick={() => choose(kind)}>
                  <span className="answer-title">{title}</span>
                  <span className="muted small">{kind === "my-exchange" ? "Then asks what you paid" : previews ? consequence(previews[kind]) : "…"}</span>
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
          {fold.totals.excluded.length > 0 ? <p className="small muted">Every question's answered. What's left isn't a question, like a balance that doesn't match the chain.</p> : null}
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

      <LinkByProof owner={wallet.address} book={book} onChange={onChange} />

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

/** Signing with a browser wallet proves it's yours, so it links without a question. Hot wallets only: cold ones never connect to a site. */
function LinkByProof({ owner, book, onChange }: { owner: string; book: Book; onChange: (book: Book) => void }) {
  const [status, setStatus] = useState<string | null>(null)
  const ethereum = (window as unknown as { ethereum?: Ethereum }).ethereum
  if (!ethereum) return null
  const prove = async () => {
    try {
      const [address] = (await ethereum.request({ method: "eth_requestAccounts" })) as string[]
      if (!address) return
      const message = linkMessage(owner, address)
      const signature = await ethereum.request({ method: "personal_sign", params: [message, address] })
      const response = await fetch("/api/links/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner, address, signature }) })
      const { verified } = (await response.json()) as { verified?: boolean }
      if (!verified) return setStatus("That signature isn't from this wallet.")
      onChange(answerSender(book, owner, address, { kind: "mine" }))
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
