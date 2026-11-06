import { shortHash, type CurrencyCode } from "@pricetag/sdk/core"
import { isFinished, isUpToThem, isWarning, phaseOf, purchaseStatus, purchaseTitle, type TrackedPurchase } from "../core/purchases.ts"
import type { PurchaseState } from "../core/resolve.ts"

type Props = {
  purchases: readonly TrackedPurchase[]
  problem: string | null
  /** What became of each purchase in the book, among the wallets on screen. */
  matches: readonly PurchaseState[]
  currency: CurrencyCode
  showing: string | null
  onView: (address: string) => void
  onDismiss: (ref: string) => void
}

/** Purchases and where they've got to, newest first. Its cost only lights up once the chain shows what arrived. */
export function PurchaseList({ purchases, problem, matches, currency, showing, onView, onDismiss }: Props) {
  if (purchases.length === 0) return null
  return (
    <section className="card purchases" aria-label="Purchases">
      <h2>Purchases</h2>
      {problem ? <p className="warn-text small" role="alert">⚠ {problem} It'll try again, and nothing's lost.</p> : null}
      <ul>
        {[...purchases].reverse().map((purchase) => {
          const { order } = purchase
          const match = order ? (matches.find(({ order: id }) => id === order.id)?.state ?? null) : null
          const phase = phaseOf(purchase, match, Date.now())
          return (
            <li className="purchase" key={purchase.ref}>
              <div>
                <p>
                  <strong>{purchaseTitle(purchase, currency)}</strong> <span className="muted small">to {shortHash(purchase.wallet)}</span>
                </p>
                <p className={`small ${isWarning(phase) ? "warn-text" : "muted"}`}>
                  {isWarning(phase) ? "⚠ " : ""}
                  {purchaseStatus(phase, currency)}
                </p>
              </div>
              <div className="purchase-actions small">
                {purchase.wallet !== showing?.toLowerCase() ? (
                  <button type="button" className="link" onClick={() => onView(purchase.wallet)}>
                    Show this wallet
                  </button>
                ) : null}
                {order?.txHash ? (
                  <a href={`https://basescan.org/tx/${order.txHash}`} target="_blank" rel="noreferrer noopener">
                    Basescan ↗
                  </a>
                ) : null}
                {isUpToThem(phase) || isFinished(phase) ? (
                  <button type="button" className="link" onClick={() => onDismiss(purchase.ref)}>
                    {isUpToThem(phase) ? "I didn't buy it" : "Dismiss"}
                  </button>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
