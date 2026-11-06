import { useId, useState, type ReactNode } from "react"
import { formatAmount, formatMoney, formatPrice, formatReturn, formatSignedMoney, returnBps, shortHash, type CurrencyCode, type Method, type OtherToken, type Position } from "@pricetag/sdk/core"
import type { CombinedPosition, PositionPart } from "../core/combined.ts"
import { firstSort, formatHoldingsSort, parseHoldingsSort, sortHoldings, type HoldingsColumn, type HoldingsSort } from "../core/holdings.ts"
import { allBalancesMatch, balanceFlag } from "../core/attention.ts"
import type { ExplainTarget, Metric } from "../core/explain.ts"
import { ABOUT_THIS_DATA, AVERAGE_PAID, ETH_NOTE, METHOD_HELP, METHOD_LABELS, METHOD_NAME, NO_PRICE, OTHER_TOKENS_NOTE, OTHER_TOKENS_TITLE, POSSIBLE_SPAM_RULE, POSSIBLE_SPAM_TITLE, REALIZED_HELP, RETURN_HELP, UNKNOWN, UNREALIZED_HELP, answerQuestionsLabel, inWallets, otherTokenAmount, otherTokenName, otherTokensLeftOutSentence, unknownCostIn, est } from "../core/wording.ts"
import type { Question } from "../core/resolve.ts"
import { Num, toneOf } from "./Num.tsx"

const HOLDINGS_SORT_KEY = "pricetag.holdingsSort"

/** A row of the holdings table, of one wallet or, with `wallets`, several. */
export type Holding = Pick<Position, "asset" | "decimals" | "price" | "values" | "reconciliation" | "noMarket" | "estimates"> & { state: Pick<Position["state"], "shortfallQty">; wallets?: PositionPart[] }

export const holdingOf = (position: CombinedPosition): Holding => ({ ...position, state: { shortfallQty: position.shortfallQty } })

/** The wallets a holding's parts qualify for. */
const partsWhere = ({ wallets }: Holding, has: (part: PositionPart) => boolean) => (wallets ?? []).filter(has).map(({ wallet }) => wallet)

function OtherTokenRows({ tokens }: { tokens: readonly OtherToken[] }) {
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th>Token</th>
            <th className="num">Amount</th>
            <th className="num">Price</th>
          </tr>
        </thead>
        <tbody>
          {tokens.map((token) => (
            <tr key={token.token}>
              <td>
                <strong>{otherTokenName(token)}</strong>
                {token.symbol && token.name ? <span className="muted small"> {token.symbol}</span> : null}
                <span className="muted small holding-wallets mono" title={token.token}>{shortHash(token.token)}</span>
                {token.tucked ? <span className="muted small holding-wallets">{token.tucked}</span> : null}
                {token.note ? <span className="muted small holding-wallets">{token.note}</span> : null}
              </td>
              <td className="num">{otherTokenAmount(token)}</td>
              <td className="num muted">{NO_PRICE}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Holdings with no price. They stay out of the table above, because nothing about them adds up to anything. */
export function OtherTokens({ tokens, leftOut }: { tokens: readonly OtherToken[]; leftOut: number }) {
  if (tokens.length === 0 && leftOut === 0) return null
  const shown = tokens.filter((token) => token.tucked === null)
  const tucked = tokens.filter((token) => token.tucked !== null)
  const more = otherTokensLeftOutSentence(leftOut)
  return (
    <section className="card">
      <h2>{OTHER_TOKENS_TITLE}</h2>
      <p className="muted small">{OTHER_TOKENS_NOTE}</p>
      {shown.length > 0 ? <OtherTokenRows tokens={shown} /> : null}
      {tucked.length > 0 ? (
        <details className="other-tokens-spam">
          <summary>{POSSIBLE_SPAM_TITLE} ({tucked.length})</summary>
          <p className="muted small">{POSSIBLE_SPAM_RULE}</p>
          <OtherTokenRows tokens={tucked} />
        </details>
      ) : null}
      {more ? <p className="muted small">{more}</p> : null}
    </section>
  )
}

/** A header that sorts by its column. Clicking it again turns the order around. */
function SortHeader({ column, sort, onSort, numeric = true, title, children }: { column: HoldingsColumn; sort: HoldingsSort; onSort: (column: HoldingsColumn) => void; numeric?: boolean; title?: string; children: ReactNode }) {
  const active = sort.column === column
  return (
    <th className={numeric ? "num" : ""} title={title} aria-sort={active ? (sort.descending ? "descending" : "ascending") : "none"}>
      <button type="button" className="sort-button" onClick={() => onSort(column)}>
        {children}
        <span className="sort-mark" aria-hidden="true">
          {active ? (sort.descending ? " ↓" : " ↑") : ""}
        </span>
      </button>
    </th>
  )
}

/** Unknown whenever its cost is, never 0%. With a known cost of nothing, there's no share to show. */
function ReturnCell({ position, onClick }: { position: Holding; onClick: () => void }) {
  const { asset, values, estimates } = position
  const bps = returnBps(values)
  const text = bps !== null ? est(formatReturn(bps), estimates.unrealized) : values.costMicros === null ? UNKNOWN : values.valueMicros === null ? NO_PRICE : "—"
  return (
    <Num label={`${asset} return`} onClick={onClick} tone={bps === null ? "quiet" : BigInt(bps) > 0n ? "gain" : BigInt(bps) < 0n ? "loss" : null}>
      {text}
    </Num>
  )
}

/** What this covers, for whoever wants to know, one click away from the numbers. */
function AboutData({ lines }: { lines: string[] }) {
  const id = useId()
  return (
    <>
      <button type="button" className="about-button" popoverTarget={id} aria-label={ABOUT_THIS_DATA} title={ABOUT_THIS_DATA}>
        ⓘ
      </button>
      <div id={id} popover="auto" className="about-text small">
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
    </>
  )
}

export function Holdings({ positions, unread, about, currency, questions, method, onMethod, explain, onResolve }: { positions: Holding[]; unread: readonly string[]; about: string[]; currency: CurrencyCode; questions: readonly Question[]; method: Method; onMethod: (method: Method) => void; explain: (target: ExplainTarget) => void; onResolve: (asset: string) => void }) {
  const open = ({ asset }: Holding, metric: Metric) => () => explain({ kind: "asset", asset, metric })
  const money = (micros: string) => formatMoney(micros, currency)
  const signed = (micros: string) => formatSignedMoney(micros, currency)
  const [sort, setSort] = useState<HoldingsSort>(() => parseHoldingsSort(localStorage.getItem(HOLDINGS_SORT_KEY)))
  const changeSort = (column: HoldingsColumn) => {
    const next = sort.column === column ? { column, descending: !sort.descending } : firstSort(column)
    localStorage.setItem(HOLDINGS_SORT_KEY, formatHoldingsSort(next))
    setSort(next)
  }
  const matches = allBalancesMatch(positions, unread)
  const questionsAbout = (asset: string) => questions.filter((q) => q.arrivals.some((a) => a.asset === asset))
  return (
    <section className="card">
      <div className="holdings-head">
        <h2>Holdings</h2>
        {matches ? <span className="matches small" title={matches}>✓ <span className="muted">{matches}</span></span> : null}
        <span className="spacer" />
        <label className="cost-method small" title={METHOD_HELP}>
          <span className="muted">Cost:</span>
          <select aria-label={METHOD_NAME} value={method} onChange={(e) => onMethod(e.target.value as Method)}>
            {(["average", "fifo"] as const).map((m) => (
              <option key={m} value={m}>
                {METHOD_LABELS[m]}
              </option>
            ))}
          </select>
        </label>
        {about.length > 0 ? <AboutData lines={about} /> : null}
      </div>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <SortHeader column="asset" sort={sort} onSort={changeSort} numeric={false}>
                Asset
              </SortHeader>
              <SortHeader column="amount" sort={sort} onSort={changeSort}>
                Amount
              </SortHeader>
              <SortHeader column="price" sort={sort} onSort={changeSort}>
                Price
              </SortHeader>
              <SortHeader column="average" sort={sort} onSort={changeSort}>
                {AVERAGE_PAID}
              </SortHeader>
              <SortHeader column="value" sort={sort} onSort={changeSort}>
                Value
              </SortHeader>
              <SortHeader column="realized" sort={sort} onSort={changeSort} title={REALIZED_HELP}>
                Realized
              </SortHeader>
              <SortHeader column="unrealized" sort={sort} onSort={changeSort} title={UNREALIZED_HELP}>
                Unrealized
              </SortHeader>
              <SortHeader column="return" sort={sort} onSort={changeSort} title={RETURN_HELP}>
                Return
              </SortHeader>
            </tr>
          </thead>
          <tbody>
            {sortHoldings(positions, sort).map((position) => {
              const { asset, decimals, values } = position
              const held = BigInt(values.qty) > 0n
              const unknown = BigInt(values.unknownCostQty) > 0n
              const flag = balanceFlag(position, { combined: position.wallets !== undefined })
              const askable = held && unknown ? questionsAbout(asset).length : 0
              const heldIn = partsWhere(position, ({ qty }) => BigInt(qty) > 0n)
              const unknownIn = partsWhere(position, ({ unknownCostQty }) => BigInt(unknownCostQty) > 0n)
              const mismatchedIn = partsWhere(position, ({ reconciliation }) => reconciliation === "incomplete")
              const askedIn = position.wallets ? [...new Set(questionsAbout(asset).map(({ wallet }) => wallet))] : []
              return (
                <tr key={asset} className={held ? "" : "closed"}>
                  <td>
                    <strong>{asset}</strong>
                    {asset === "ETH" ? <span className="muted small"> {ETH_NOTE}</span> : null}
                    {/* Once per row, however many of its numbers it affects. */}
                    {flag ? (
                      <button type="button" className="row-flag" title={mismatchedIn.length > 0 ? `${inWallets(mismatchedIn)}. ${flag.help}` : flag.help} aria-label={`${asset}: ${flag.label}`} onClick={open(position, flag.metric)}>
                        ⚠
                      </button>
                    ) : null}
                    {heldIn.length > 0 ? <span className="muted small holding-wallets" title={position.wallets?.map(({ wallet, qty }) => `${shortHash(wallet)}: ${formatAmount(qty, decimals)} ${asset}`).join("\n")}>{inWallets(heldIn)}</span> : null}
                    {unknownIn.length > 0 ? <span className="muted small holding-wallets">{unknownCostIn(unknownIn)}</span> : null}
                  </td>
                  <td className="num">
                    <Num label={`${asset} amount`} onClick={open(position, "amount")}>
                      {formatAmount(values.qty, decimals)}
                    </Num>
                  </td>
                  <td className="num">
                    {position.price ? (
                      <Num label={`${asset} price`} onClick={open(position, "price")}>
                        {est(formatPrice(position.price.micros, currency), position.estimates.value)}
                      </Num>
                    ) : (
                      <span className="muted">{NO_PRICE}</span>
                    )}
                  </td>
                  <td className="num">
                    {held ? (
                      <Num label={`${asset} ${AVERAGE_PAID.toLowerCase()}`} onClick={open(position, "average")} tone={unknown ? "quiet" : null}>
                        {values.averageCostMicros ? est(formatPrice(values.averageCostMicros, currency), position.estimates.cost) : UNKNOWN}
                      </Num>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="num">
                    {held ? (
                      <Num label={`${asset} value`} onClick={open(position, "value")} tone={values.valueMicros === null ? "quiet" : null}>
                        {values.valueMicros ? est(money(values.valueMicros), position.estimates.value) : NO_PRICE}
                      </Num>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="num" title={REALIZED_HELP}>
                    <Num label={`${asset} realized PnL`} onClick={open(position, "realized")} tone={toneOf(values.realizedMicros)}>
                      {values.realizedMicros === null ? UNKNOWN : est(signed(values.realizedMicros), position.estimates.realized)}
                    </Num>
                  </td>
                  <td className="num" title={UNREALIZED_HELP}>
                    {held ? (
                      <>
                        {askable > 0 ? (
                          <button type="button" className="row-action" title={`${answerQuestionsLabel(askable)} about ${asset}, so what you paid is known${askedIn.length > 0 ? `. ${inWallets(askedIn)}` : ""}`} aria-label={`${answerQuestionsLabel(askable)} about ${asset}${askedIn.length > 0 ? `, ${inWallets(askedIn).toLowerCase()}` : ""}`} onClick={() => onResolve(asset)}>
                            ?
                          </button>
                        ) : null}
                        <Num label={`${asset} unrealized PnL`} onClick={open(position, "unrealized")} tone={toneOf(values.unrealizedMicros)}>
                          {values.unrealizedMicros === null ? UNKNOWN : est(signed(values.unrealizedMicros), position.estimates.unrealized)}
                        </Num>
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="num" title={RETURN_HELP}>
                    {held ? <ReturnCell position={position} onClick={open(position, "return")} /> : <span className="muted">—</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
