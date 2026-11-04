// Turns a wallet's rows in the dataset's shapes into the priced legs the fold reads.
// Pure, so it can run on fixtures, on the raw dataset's rows and on the Pricetag dataset's rows alike.

import { worth, type CostLabel, type FoldLeg } from "./fold.ts"
import { ETH_ADDRESS, normalizeAddress, tokenByAddress, TOKENS, type Token } from "./tokens.ts"

export type PriceSource = "oracle" | "swap" | "market"

/** Why a leg has no usable price. Apps show these as they are, so they stay in plain language. */
export const PRICE_NOTES = {
  feedFailed: "The market price feed didn't answer at this block.",
  rejected: "Ignored the price this exchange implied, because it's far from any plausible value.",
  unlisted: "This transaction also moved a token we can't price yet, so what was paid or received can't be split between them.",
  unusable: "This exchange didn't give a usable price for this token.",
  noExchange: "Nothing was exchanged in this transaction, and this token has no market price feed.",
  notSimple: "This transaction isn't a simple exchange of one token for another.",
  unsettled: "A contract turned wrapped ETH into ETH in this transaction, and we couldn't confirm how much of it reached this wallet, so what was paid or received isn't known.",
}
/**
 * Transfers of tokens off the allowlist. They have no position or price, but they say money went elsewhere.
 * `unlisted`: `amount` is a quantity, or empty when it can't be read, as with ERC-1155.
 * `unlisted_nft`: `amount` is an ERC-721 token ID, which identifies one asset and is not a quantity.
 */
export type LegKind = "erc20" | "eth" | "gas" | "l1_fee" | "wrap" | "unwrap" | "unlisted" | "unlisted_nft"

/** What a transaction cost to send. L2 gas comes from Amp's data, and the L1 data fee from its receipt. */
const isFeeRow = (row: LegRow) => row.kind === "gas" || row.kind === "l1_fee"

/**
 * A row of `legs`, named like the table's columns, as `PricedRow` is. These are what the pricing code takes. Anything a
 * read returns to a caller is camelCase. `token` and `account` are 0x-prefixed lowercase hex, `amount` a decimal string.
 */
export type LegRow = {
  block_num: number
  timestamp: string
  tx_hash: string
  tx_index: number
  log_index: number
  token: string
  account: string
  side: "debit" | "credit"
  amount: string
  kind: LegKind
  /** The other side of this movement, when it's known: who sent a credit, or who a debit went to. */
  counterparty?: string | null
  /** On an unwrap credit: `settleUnwraps` confirmed this amount against the chain. Without it, the amount is only a claim. */
  settled?: boolean
}

/**
 * Without traces, a WETH `Withdrawal` in a transaction counts as ETH paid to its sender. That's only a claim: a contract
 * can unwrap and send the ETH elsewhere, or keep a cut. So it counts as ETH until the balance says otherwise, but no
 * trade can be valued from it.
 */
export const isUnwrapClaim = (row: LegRow) => row.kind === "unwrap" && row.side === "credit" && !row.settled

/** A transaction whose gas couldn't be worked out, and the block it's in. It can have no rows at all. */
export type GasUnknownTx = Pick<LegRow, "tx_hash" | "block_num">

/** One block's oracle reads, from `reference_prices`, with Chainlink answers in 1e8 USD. Empty when a read failed. */
export type Reference = { blockNum: number; ethUsd: string; usdcUsd: string }

/** The result of `pt_price`, in the shape `priced_legs` stores it. */
export type PtPrice = { token: string; usd_micros: string; source: "swap" | "unknown" }

/**
 * The result of `pt_net`. No side means it nets to zero, or an amount couldn't be read. No amount means most of it
 * cancelled out, as with what a router or pool kept: something moved, but it isn't a trade that can be priced.
 */
export type PtNet = { amount: string; side: "debit" | "credit" | "" }

/** A row of `priced_legs`. */
export type PricedRow = {
  block_num: number
  tx_hash: string
  account: string
  sold_token: string
  sold_amount: string
  bought_token: string
  bought_amount: string
  priced: PtPrice
}

/** One of the rows a leg nets together. */
export type LegPart = Pick<LegRow, "token" | "account" | "side" | "amount" | "kind" | "counterparty"> & { logIndex: number }

const partOf = ({ token, account, side, amount, kind, log_index, counterparty }: LegRow): LegPart => ({ token, account, side, amount, kind, logIndex: log_index, ...(counterparty ? { counterparty } : {}) })

/** What a leg converted out of USD was before that, and the rate that took it there. */
export type LegConversion = {
  priceUsdMicros: string | null
  costUsdMicros: string | null
  proceedsUsdMicros: string | null
  /** What one USD bought at this leg's block, or null when there's no rate for it. */
  rateMicros: string | null
}

/** Fresh from `buildPricedLegs`, its money is in USD. An app showing another currency converts it before folding. */
export type PricedLeg = FoldLeg & {
  asset: string
  blockNum: number
  timestamp: string
  txHash: string
  txIndex: number
  priceSource: PriceSource | null
  /** Why this leg has no usable price. */
  priceNote: string | null
  /** The rows this leg nets together, so a click can show them. */
  parts: LegPart[]
  /** Only on a leg converted out of USD. */
  conversion?: LegConversion
  /** What the wallet already held before the first block read. It isn't a transaction, so `txHash` is empty. */
  opening?: boolean
  /** This transaction claims ETH reached the wallet, and the chain hasn't confirmed how much. See `isUnwrapClaim`. */
  unsettledCredit?: boolean
}

/** The same calculation as the dataset's `pt_price` UDF. A test runs both on the same inputs. */
export function ptPrice(
  soldToken: string,
  soldAmount: string,
  boughtToken: string,
  boughtAmount: string,
  ethUsd: string,
  usdcUsd: string,
): PtPrice {
  const none: PtPrice = { token: "", usd_micros: "", source: "unknown" }
  const sold = tokenByAddress(soldToken)
  const bought = tokenByAddress(boughtToken)
  if (!sold || !bought || !ethUsd || !usdcUsd || !soldAmount || !boughtAmount) return none
  if (BigInt(soldAmount) === 0n || BigInt(boughtAmount) === 0n) return none
  if (sold.asset === bought.asset) return none
  const answer = (t: Token) => (t.oracle === "eth" ? ethUsd : t.oracle === "usdc" ? usdcUsd : null)
  const usdPerToken = (pricedAmount: string, pricedDecimals: number, refAmount: string, refDecimals: number, refAnswer: string) =>
    (
      (BigInt(refAmount) * BigInt(refAnswer) * 10n ** BigInt(pricedDecimals)) /
      (BigInt(pricedAmount) * 10n ** BigInt(refDecimals) * 100n)
    ).toString()
  const soldAnswer = answer(sold)
  if (soldAnswer) {
    return { token: bought.symbol, usd_micros: usdPerToken(boughtAmount, bought.decimals, soldAmount, sold.decimals, soldAnswer), source: "swap" }
  }
  const boughtAnswer = answer(bought)
  if (boughtAnswer) {
    return { token: sold.symbol, usd_micros: usdPerToken(soldAmount, sold.decimals, boughtAmount, bought.decimals, boughtAnswer), source: "swap" }
  }
  return none
}

/** The same calculation as the dataset's `pt_net` UDF, on comma-separated signed amounts. A test runs both. */
export function ptNet(amounts: string): PtNet {
  const none: PtNet = { amount: "", side: "" }
  if (!amounts) return none
  let net = 0n
  let gross = 0n
  for (const part of amounts.split(",")) {
    if (!/^-?\d+$/.test(part)) return none
    const amount = BigInt(part)
    net += amount
    gross += amount < 0n ? -amount : amount
  }
  if (net === 0n) return none
  const size = net < 0n ? -net : net
  return { amount: size * 2n < gross ? "" : size.toString(), side: net > 0n ? "credit" : "debit" }
}

const isPlainAmount = (amount: string) => /^\d+$/.test(amount)

/**
 * What one account's rows of tokens off the allowlist amount to in one transaction, like the dataset's `unlisted_moves`.
 * `moves` has each asset's net movement that isn't zero, and `unreadable` says an amount couldn't be read.
 */
function netUnlisted(rows: readonly LegRow[]): { moves: bigint[]; unreadable: boolean } {
  const nets = new Map<string, bigint>()
  let unreadable = false
  for (const row of rows) {
    if (!isPlainAmount(row.amount)) {
      unreadable = true
      continue
    }
    // Fungible tokens net by contract. An NFT nets by contract and ID, each one counting once: IDs aren't amounts.
    const isNft = row.kind === "unlisted_nft"
    const asset = isNft ? `${row.token}#${row.amount}` : row.token
    const size = isNft ? 1n : BigInt(row.amount)
    nets.set(asset, (nets.get(asset) ?? 0n) + (row.side === "credit" ? size : -size))
  }
  return { moves: [...nets.values()].filter((delta) => delta !== 0n), unreadable }
}

/**
 * What the dataset's `net_legs`, `pairs`, `unlisted_moves`, `pair_counts`, `single_pairs` and `priced_legs` tables
 * compute, for one wallet's rows. Used when reading the raw dataset, and for fixtures, so both go through the same path
 * as the real table.
 */
export function derivePricedRows(rows: readonly LegRow[], references: readonly Reference[]): PricedRow[] {
  const refs = new Map(references.map((r) => [r.blockNum, r]))
  const byTx = new Map<string, { first: LegRow; amounts: Map<string, string[]>; unlisted: LegRow[] }>()
  for (const row of rows) {
    // Like the dataset's `legs`, which pairs are made from: gas isn't traded.
    if (isFeeRow(row)) continue
    const key = `${row.account}:${row.tx_hash}`
    const tx = byTx.get(key) ?? { first: row, amounts: new Map<string, string[]>(), unlisted: [] }
    // Unlisted tokens have no decimals, so they make no pair, but they do stop the pair's price.
    if (row.kind === "unlisted" || row.kind === "unlisted_nft") tx.unlisted.push(row)
    else tx.amounts.set(row.token, [...(tx.amounts.get(row.token) ?? []), row.side === "credit" ? row.amount : `-${row.amount}`])
    byTx.set(key, tx)
  }
  const result: PricedRow[] = []
  for (const { first, amounts, unlisted } of byTx.values()) {
    const nets = [...amounts].map(([token, signed]) => ({ token, ...ptNet(signed.join(",")) }))
    const sold = nets.filter((n) => n.side === "debit")
    const bought = nets.filter((n) => n.side === "credit")
    if (sold.length !== 1 || bought.length !== 1) continue
    const { moves, unreadable } = netUnlisted(unlisted)
    if (unreadable || moves.length > 0) continue
    const ref = refs.get(first.block_num)
    if (!ref) continue
    const [out, into] = [sold[0]!, bought[0]!]
    result.push({
      block_num: first.block_num,
      tx_hash: first.tx_hash,
      account: first.account,
      sold_token: out.token,
      sold_amount: out.amount,
      bought_token: into.token,
      bought_amount: into.amount,
      priced: ptPrice(out.token, out.amount, into.token, into.amount, ref.ethUsd, ref.usdcUsd),
    })
  }
  return result
}

/** The blocks whose balances `settleUnwraps` needs, each with the one before it. */
export function unwrapBalanceBlocks(rows: readonly LegRow[]): number[] {
  return [...new Set(rows.filter(isUnwrapClaim).flatMap((row) => [row.block_num - 1, row.block_num]))]
}

type SettleInput = {
  /** One wallet's rows, with its gas and L1 fees. */
  rows: readonly LegRow[]
  priced: readonly PricedRow[]
  references: readonly Reference[]
  /** The wallet's plain ETH at the end of each block, not counting WETH. A block whose read failed isn't in it. */
  ethBalances: ReadonlyMap<number, string>
  /** Transactions whose gas or L1 fee isn't known, so their block's balance change can't be explained yet. */
  feeUnknownTxs: readonly string[]
  /** Blocks with such a transaction, because one with unknown gas can have no rows at all. */
  gasUnknownBlocks: readonly number[]
}

/**
 * Checks each unwrap credit against what the wallet's ETH really did across its block. What's left of the change, after
 * everything we can see, is what really arrived.
 *
 * A balance is read per block, so it can only speak for a transaction when that's the wallet's only one in the block,
 * whichever tokens the others moved: one sent by someone else can pay this wallet ETH and show only a token leaving. Then
 * its credit is what arrived, up to what it claims, because anything more isn't what the receipt explains. With several,
 * the total can match while one was short and the other was refunded, so only nothing arriving settles them, since none
 * of them can have received less than that.
 *
 * A credit that can't be settled keeps its `isUnwrapClaim` amount, and `buildPricedLegs` values nothing from it.
 * A credit that changed also changes what the transaction traded, so its priced rows are worked out again.
 */
export function settleUnwraps({ rows, priced, references, ethBalances, feeUnknownTxs, gasUnknownBlocks }: SettleInput): { rows: LegRow[]; priced: PricedRow[] } {
  const claimBlocks = new Set(rows.filter(isUnwrapClaim).map((row) => row.block_num))
  if (claimBlocks.size === 0) return { rows: [...rows], priced: [...priced] }
  const feeUnknown = new Set(feeUnknownTxs)
  const gasUnknown = new Set(gasUnknownBlocks)
  const byBlock = new Map<number, LegRow[]>()
  for (const row of rows) {
    if (!claimBlocks.has(row.block_num)) continue
    const blockRows = byBlock.get(row.block_num)
    if (blockRows) blockRows.push(row)
    else byBlock.set(row.block_num, [row])
  }

  /** What really arrived in each transaction with a claim, in the blocks that can be settled. */
  const credits = new Map<string, bigint>()
  for (const [block, blockRows] of byBlock) {
    const before = ethBalances.get(block - 1)
    const after = ethBalances.get(block)
    const txs = new Set(blockRows.map((row) => row.tx_hash))
    if (before === undefined || after === undefined || gasUnknown.has(block) || [...txs].some((tx) => feeUnknown.has(tx))) continue
    const claims = new Map<string, bigint>()
    let arrived = BigInt(after) - BigInt(before)
    for (const row of blockRows) {
      if (row.token !== ETH_ADDRESS) continue
      if (isUnwrapClaim(row)) claims.set(row.tx_hash, (claims.get(row.tx_hash) ?? 0n) + BigInt(row.amount))
      else arrived -= row.side === "credit" ? BigInt(row.amount) : -BigInt(row.amount)
    }
    const claimedInBlock = [...claims.values()].reduce((sum, amount) => sum + amount, 0n)
    // Less than nothing means ETH left in a way we can't see, and more than it claims came from something we can't see.
    if (arrived < 0n || arrived > claimedInBlock || (txs.size > 1 && arrived !== 0n)) continue
    for (const tx of claims.keys()) credits.set(tx, arrived)
  }

  const claimed = new Map<string, bigint>()
  for (const row of rows) if (isUnwrapClaim(row)) claimed.set(row.tx_hash, (claimed.get(row.tx_hash) ?? 0n) + BigInt(row.amount))
  const changed = new Set([...credits].filter(([tx, credit]) => credit !== claimed.get(tx)).map(([tx]) => tx))
  const settled: LegRow[] = []
  const written = new Set<string>()
  for (const row of rows) {
    const credit = isUnwrapClaim(row) ? credits.get(row.tx_hash) : undefined
    if (credit === undefined) settled.push(row)
    else if (!changed.has(row.tx_hash)) settled.push({ ...row, settled: true })
    // Several withdrawals in one transaction become one credit, and a false one becomes none.
    else if (credit > 0n && !written.has(row.tx_hash)) {
      settled.push({ ...row, amount: credit.toString(), settled: true })
      written.add(row.tx_hash)
    }
  }
  return {
    rows: settled,
    priced: [...priced.filter((p) => !changed.has(p.tx_hash)), ...derivePricedRows(settled.filter((row) => changed.has(row.tx_hash)), references)],
  }
}

export const answerToMicros = (answer: string | undefined): string | null =>
  answer && BigInt(answer) > 0n ? (BigInt(answer) / 100n).toString() : null

/** True when a swap price is plausible next to the reference prices at that block. */
export function isSanePrice(token: Token, usdMicros: string, ethUsdMicros: string | null): boolean {
  const usd = Number(usdMicros) / 1e6
  if (!(usd > 0) || !token.sanity) return false
  if ("usd" in token.sanity) return usd >= token.sanity.usd[0] && usd <= token.sanity.usd[1]
  if (ethUsdMicros === null) return false
  const ratio = usd / (Number(ethUsdMicros) / 1e6)
  return ratio >= token.sanity.eth[0] && ratio <= token.sanity.eth[1]
}

/** How far a swap's implied price can be from the oracle of a token that has one. Wide enough for real slippage. */
const ORACLE_BAND: [min: number, max: number] = [0.8, 1.25]

function isSaneAgainstOracle(impliedUsdMicros: bigint, oracleUsdMicros: string): boolean {
  const ratio = Number(impliedUsdMicros) / Number(oracleUsdMicros)
  return ratio >= ORACLE_BAND[0] && ratio <= ORACLE_BAND[1]
}

/** The guarded price of an asset's recent trades at or before a block. See `market.ts`. */
export type MarketLookup = (asset: string, blockNum: number) => string | null

type Input = {
  account: string
  rows: readonly LegRow[]
  references: readonly Reference[]
  priced: readonly PricedRow[]
  market?: MarketLookup
}

/**
 * Nets each transaction per asset, so a wrap (ETH out, WETH in) or a split route is a single movement,
 * then labels each leg's price and cost. Gas stays its own leg. Ordered for the fold: by block, then transaction,
 * with gas first because it's paid before the transaction runs.
 */
export function buildPricedLegs({ account, rows, references, priced, market }: Input): PricedLeg[] {
  const me = normalizeAddress(account)
  const refs = new Map(references.map((r) => [r.blockNum, r]))
  const txs = new Map<string, LegRow[]>()
  for (const row of rows) {
    if (row.account !== me) continue
    const txRows = txs.get(row.tx_hash)
    if (txRows) txRows.push(row)
    else txs.set(row.tx_hash, [row])
  }
  const ordered = [...txs.values()].sort((a, b) => a[0]!.block_num - b[0]!.block_num || a[0]!.tx_index - b[0]!.tx_index)

  const legs: PricedLeg[] = []
  for (const txRows of ordered) {
    const first = txRows[0]!
    const ref = refs.get(first.block_num)
    const ethMicros = answerToMicros(ref?.ethUsd)
    const usdcMicros = answerToMicros(ref?.usdcUsd)
    const oracle = (t: Token) => (t.oracle === "eth" ? ethMicros : t.oracle === "usdc" ? usdcMicros : null)
    const base = { blockNum: first.block_num, timestamp: first.timestamp, txHash: first.tx_hash, txIndex: first.tx_index }

    // The other token's balance can match while the amount it was traded for is wrong, so nothing here gets a value.
    const unsettledCredit = txRows.some(isUnwrapClaim)
    const unsettled = unsettledCredit ? { unsettledCredit } : {}
    const feeRows = txRows.filter(isFeeRow)
    if (feeRows.length > 0) {
      legs.push({
        ...base,
        id: `${first.tx_hash}:gas`,
        asset: "ETH",
        delta: `-${feeRows.reduce((sum, row) => sum + BigInt(row.amount), 0n)}`,
        decimals: 18,
        kind: "gas",
        priceMicros: ethMicros,
        priceSource: ethMicros === null ? null : "oracle",
        priceNote: ethMicros === null ? PRICE_NOTES.feedFailed : null,
        costMicros: null,
        proceedsMicros: null,
        costLabel: "unknown",
        parts: feeRows.map(partOf),
        ...unsettled,
      })
    }

    const nets = new Map<string, { token: Token; delta: bigint; parts: LegRow[] }>()
    const unlisted: LegRow[] = []
    for (const row of txRows) {
      if (isFeeRow(row)) continue
      const token = tokenByAddress(row.token)
      if (!token) {
        unlisted.push(row)
        continue
      }
      const net = nets.get(token.asset) ?? { token: TOKENS.find((t) => t.symbol === token.asset)!, delta: 0n, parts: [] }
      net.delta += row.side === "credit" ? BigInt(row.amount) : -BigInt(row.amount)
      net.parts.push(row)
      nets.set(token.asset, net)
    }
    const moved = [...nets.values()].filter((n) => n.delta !== 0n)
    // One token out and one in is only a swap if nothing else moved. Otherwise the payment could be for both.
    const { moves: unlistedMoves, unreadable: unlistedUnreadable } = netUnlisted(unlisted)
    const hasUnlisted = unlistedUnreadable || unlistedMoves.length > 0
    const isSwap = !hasUnlisted && !unsettledCredit && moved.length === 2 && moved.some((n) => n.delta > 0n) && moved.some((n) => n.delta < 0n)
    // Something left and something arrived, but it can't be valued as a swap. It's still not a plain transfer: a debit
    // here was traded for something, so it has unknown proceeds, rather than no gain or loss at all.
    const anyOut = moved.some((n) => n.delta < 0n) || unlistedMoves.some((delta) => delta < 0n)
    const anyIn = moved.some((n) => n.delta > 0n) || unlistedMoves.some((delta) => delta > 0n)
    // A claim can cancel out what left, so whether anything arrived can't decide this while it stands.
    const isExchange = isSwap || unlistedUnreadable || unsettledCredit || (anyOut && anyIn)
    const pricedRow = priced.find((p) => p.tx_hash === first.tx_hash && p.account === me)

    const resolved = moved.map((net) => {
      let price = oracle(net.token)
      let priceSource: PriceSource | null = price === null ? null : "oracle"
      let priceNote: string | null = null
      let rejected = false
      if (net.token.oracle && price === null) priceNote = PRICE_NOTES.feedFailed
      if (hasUnlisted) priceNote = PRICE_NOTES.unlisted
      else if (unsettledCredit) priceNote = PRICE_NOTES.unsettled
      else if (!net.token.oracle) {
        const swap = pricedRow?.priced.source === "swap" && pricedRow.priced.token === net.token.symbol ? pricedRow.priced.usd_micros : null
        if (swap === null) priceNote = isSwap ? PRICE_NOTES.unusable : PRICE_NOTES.noExchange
        else if (!isSwap) priceNote = PRICE_NOTES.notSimple
        else if (!isSanePrice(net.token, swap, ethMicros)) {
          priceNote = PRICE_NOTES.rejected
          rejected = true
        } else {
          price = swap
          priceSource = "swap"
        }
      }
      // A price is a fact about the token at this block, so a trade we couldn't value doesn't stop it having one.
      const marketPrice = price === null && !net.token.oracle ? (market?.(net.token.asset, first.block_num) ?? null) : null
      if (marketPrice !== null) {
        price = marketPrice
        priceSource = "market"
        if (!rejected && !hasUnlisted && !unsettledCredit) priceNote = null
      }
      return { net, price, priceSource, priceNote, rejected }
    })

    // The oracle price is the shared fact, but a swap's cost and proceeds are what actually changed hands. So both
    // sides share one USD value: the amount on the side an oracle can value, preferring USDC, whose oracle is closest
    // to what was really paid. Otherwise buying above the oracle and selling below it would show up as a profit.
    const usdcSide = resolved.find((r) => r.net.token.oracle === "usdc" && r.price !== null)
    const oracleSide = isSwap ? (usdcSide ?? resolved.find((r) => r.net.token.oracle === "eth" && r.price !== null)) : undefined
    // With no feed on either side, what left is worth about its market price. That's an estimate, and it's labeled as one.
    const marketSide = isSwap && !oracleSide && !resolved.some((r) => r.rejected) ? (resolved.find((r) => r.net.delta < 0n && r.priceSource === "market") ?? resolved.find((r) => r.priceSource === "market")) : undefined
    const anchor = oracleSide ?? marketSide
    const abs = (delta: bigint) => (delta < 0n ? -delta : delta)
    let tradeUsd = anchor ? worth(abs(anchor.net.delta), BigInt(anchor.price as string), anchor.net.token.decimals) : null
    const other = anchor && resolved.find((r) => r !== anchor)
    if (anchor && other && tradeUsd !== null) {
      const implied = (tradeUsd * 10n ** BigInt(other.net.token.decimals)) / abs(other.net.delta)
      // Check against the token's oracle when it has a reading, and otherwise against its plausible range.
      const sane = other.price !== null && other.priceSource !== "swap" ? isSaneAgainstOracle(implied, other.price) : isSanePrice(other.net.token, implied.toString(), ethMicros)
      if (other.rejected || !sane) {
        // A wrong trade value must never reach a total, so neither side gets one.
        tradeUsd = null
        anchor.priceNote = PRICE_NOTES.rejected
        other.priceNote = PRICE_NOTES.rejected
      }
    }

    for (const { net, price, priceSource, priceNote } of resolved) {
      // What was paid is known even when the token's price isn't: price and cost are separate facts.
      const value = tradeUsd === null ? null : tradeUsd.toString()
      const paid = net.delta > 0n && value !== null
      const costLabel: CostLabel = paid ? "paid" : "unknown"
      legs.push({
        ...base,
        id: `${first.tx_hash}:${net.token.asset}`,
        asset: net.token.asset,
        delta: net.delta.toString(),
        decimals: net.token.decimals,
        kind: isExchange ? "swap" : "transfer",
        priceMicros: price,
        priceSource,
        priceNote,
        costMicros: paid ? value : null,
        proceedsMicros: net.delta < 0n ? value : null,
        costLabel,
        ...(marketSide && value !== null ? { estimated: true } : {}),
        parts: net.parts.map(partOf),
        ...unsettled,
      })
    }
  }
  return legs
}
