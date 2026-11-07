// Turns a wallet's rows in the dataset's shapes into the priced legs the fold reads.
// Pure, so it can run on fixtures, on the raw dataset's rows and on the Pricetag dataset's rows alike.

import type { CurrencyCode } from "./currency.ts"
import { worth, type CostLabel, type FoldLeg } from "./fold.ts"
import { ETH_ADDRESS, normalizeAddress, tokenByAddress, TOKENS, type Token } from "./tokens.ts"

export type PriceSource = "oracle" | "swap" | "market"

/** Why a leg has no usable price. Apps show these as they are, so they stay in plain language. */
export const PRICE_NOTES = {
  feedFailed: "The market price feed has no price for this block.",
  rejected: "Ignored the price this exchange implied, because it's far from any plausible value.",
  unlisted: "This transaction also moved a token we can't price yet, so what was paid or received can't be split between them.",
  unusable: "This exchange didn't give a usable price for this token.",
  noExchange: "Nothing was exchanged in this transaction, and this token has no market price feed.",
  notSimple: "This transaction isn't a simple exchange of one token for another.",
  unsettled: "A contract turned wrapped ETH into ETH in this transaction, and we couldn't confirm how much of it reached this wallet, so what was paid or received isn't known.",
  unseenEth: "This wallet's ETH rose in this block by more than its transactions explain, so this may have been sold for that ETH, and what it brought in isn't known.",
}
/**
 * Transfers of tokens off the allowlist. They have no position or price, but they say money went elsewhere.
 * `unlisted`: `amount` is a quantity, or empty when it can't be read, as with ERC-1155.
 * `unlisted_nft`: `amount` is an ERC-721 token ID, which identifies one asset and is not a quantity.
 * `unseen_eth`: ETH the wallet's balance says arrived in a block with no row to show for it. See `creditUnseenEth`.
 * Only `getPortfolio`, and `getLegs` with an `rpcUrl`, add these. Their leg's `id` is `unseen:<block>:ETH`, and its `txHash` is
 * the likeliest transaction, or empty when there's no telling. Other movements of ETH in that block say `orderUnknown`.
 */
export type LegKind = "erc20" | "eth" | "gas" | "l1_fee" | "wrap" | "unwrap" | "unlisted" | "unlisted_nft" | "unseen_eth"

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
  /** On a transaction's rows: `settleUnwraps` found ETH in its block that nothing explains. See `UnseenEth`. */
  unseenEth?: boolean
  /** On a transaction's rows: what `settleUnwraps` found of its claims. See `SettledCredit`. */
  settledCredit?: SettledCredit
}

/**
 * Two different facts about a transaction whose claims were settled. Its `Withdrawal` logs say how much WETH became ETH,
 * and they stay as recorded. What reached the wallet is what its balance says, which can be less or nothing, and no log says that.
 */
export type SettledCredit = {
  received: string
  withdrawals: { logIndex: number; amount: string }[]
}

/**
 * Without traces, a WETH `Withdrawal` in a transaction counts as ETH paid to its sender. That's only a claim: a contract
 * can unwrap and send the ETH elsewhere, or keep a cut. So it counts as ETH until the balance says otherwise, but no
 * trade can be valued from it.
 */
export const isUnwrapClaim = (row: LegRow) => row.kind === "unwrap" && row.side === "credit" && !row.settled

/**
 * ETH that reached a wallet in a block with no row to show for it, and the transactions that took a token from the wallet
 * there. A swap someone else sends for a wallet looks like this, and so does a pool that pays out ETH directly. So does a
 * stranger's payment landing in the same block, which is why this never counts as what the token was sold for.
 */
export type UnseenEth = { blockNum: number; amount: string; txHashes: string[] }

/**
 * A transaction in a block where ETH arrived with no row: a successful one that names the wallet in its calldata, or any
 * the wallet sent. `failed` can't be behind the ETH, though its sender still paid its fee. `deposit` is an OP Stack deposit, which pays no fee here.
 */
export type PayoutTx = { blockNum: number; txHash: string; from: string; to: string | null; input: string; failed?: boolean; deposit?: boolean }

/** Who to ask about ETH that arrived with no row. A null sender means there's nobody to name, only what it cost. */
export type EthPayer = { txHash: string; sender: string | null }

/** A transaction whose gas couldn't be worked out, and the block it's in. It can have no rows at all. */
export type GasUnknownTx = Pick<LegRow, "tx_hash" | "block_num">

/**
 * One block's Chainlink prices, from `reference_prices`, with answers in 1e8 USD. Empty when a feed has no price at this block.
 * The transactions are the updates behind those answers, which only the dataset has: the raw path reads them with `eth_call`.
 */
export type Reference = { blockNum: number; ethUsd: string; usdcUsd: string; ethTx?: string | undefined; usdcTx?: string | undefined }

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
  /** The cost as entered, on an opening leg shown in another currency. Its cost here is an estimate, at the rate when the history starts. */
  enteredAs?: { micros: string; currency: CurrencyCode }
  /** This transaction claims ETH reached the wallet, and the chain hasn't confirmed how much. See `isUnwrapClaim`. */
  unsettledCredit?: boolean
  /** On what moved in a transaction whose claims were settled. This outlives the credit's rows, which can merge or vanish. */
  settledCredit?: SettledCredit
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
function netUnlisted(rows: readonly LegRow[]): { moves: bigint[]; unreadable: boolean; nets: Map<string, bigint> } {
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
  return { moves: [...nets.values()].filter((delta) => delta !== 0n), unreadable, nets }
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

/**
 * Whether a transaction took a token from the wallet and, as far as its rows show, gave nothing back. Plain ETH leaving
 * isn't a token leaving. Neither is a claim, which says what came back, or an unreadable amount, which is never a plain send.
 */
function isOneWaySend(txRows: readonly LegRow[]): boolean {
  const moved = txRows.filter((row) => !isFeeRow(row))
  if (moved.some(isUnwrapClaim) || !moved.some((row) => row.side === "debit" && row.token !== ETH_ADDRESS)) return false
  const isUnlisted = (row: LegRow) => row.kind === "unlisted" || row.kind === "unlisted_nft"
  const { moves, unreadable } = netUnlisted(moved.filter(isUnlisted))
  if (unreadable) return false
  const nets = new Map<string, bigint>()
  for (const row of moved) {
    const asset = tokenByAddress(row.token)?.asset
    if (asset && !isUnlisted(row)) nets.set(asset, (nets.get(asset) ?? 0n) + (row.side === "credit" ? BigInt(row.amount) : -BigInt(row.amount)))
  }
  const deltas = [...nets.values(), ...moves]
  return deltas.some((delta) => delta < 0n) && !deltas.some((delta) => delta > 0n)
}

function byTx(rows: readonly LegRow[]): Map<string, LegRow[]> {
  const txs = new Map<string, LegRow[]>()
  for (const row of rows) {
    const txRows = txs.get(row.tx_hash)
    if (txRows) txRows.push(row)
    else txs.set(row.tx_hash, [row])
  }
  return txs
}

/**
 * The blocks whose balances can show ETH arriving for a token that left, each with the one before it. There can be far
 * more of these than `unwrapBalanceBlocks`, so they're only worth reading for a wallet whose ETH doesn't add up.
 */
export function oneWaySendBalanceBlocks(rows: readonly LegRow[]): number[] {
  const sends = [...byTx(rows).values()].filter(isOneWaySend)
  return [...new Set(sends.flatMap(([row]) => [row!.block_num - 1, row!.block_num]))]
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
 * A credit that changed also changes what the transaction traded, so its priced rows are worked out again. Whatever
 * happens to a settled credit's rows, its transaction's rows keep what the logs recorded, as a `SettledCredit`.
 */
function settleClaims({ rows, priced, references, ethBalances, feeUnknownTxs, gasUnknownBlocks }: SettleInput): { rows: LegRow[]; priced: PricedRow[] } {
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
  const withdrawals = new Map<string, SettledCredit["withdrawals"]>()
  for (const row of rows) {
    if (!isUnwrapClaim(row)) continue
    claimed.set(row.tx_hash, (claimed.get(row.tx_hash) ?? 0n) + BigInt(row.amount))
    withdrawals.set(row.tx_hash, [...(withdrawals.get(row.tx_hash) ?? []), { logIndex: row.log_index, amount: row.amount }])
  }
  const changed = new Set([...credits].filter(([tx, credit]) => credit !== claimed.get(tx)).map(([tx]) => tx))
  const settled: LegRow[] = []
  const written = new Set<string>()
  for (const row of rows) {
    const credit = credits.get(row.tx_hash)
    if (credit === undefined) {
      settled.push(row)
      continue
    }
    const marked = { ...row, settledCredit: { received: credit.toString(), withdrawals: withdrawals.get(row.tx_hash)! } }
    if (!isUnwrapClaim(row)) settled.push(marked)
    else if (!changed.has(row.tx_hash)) settled.push({ ...marked, settled: true })
    // Several withdrawals in one transaction become one credit, and a false one becomes none.
    else if (credit > 0n && !written.has(row.tx_hash)) {
      settled.push({ ...marked, amount: credit.toString(), settled: true })
      written.add(row.tx_hash)
    }
  }
  return {
    rows: settled,
    priced: [...priced.filter((p) => !changed.has(p.tx_hash)), ...derivePricedRows(settled.filter((row) => changed.has(row.tx_hash)), references)],
  }
}

/**
 * Finds ETH that rose in a block by more than its rows explain, where a token left the wallet with nothing back. A balance
 * can't say which transaction it came from, so each of those in the block is marked, and none is valued from it: it stays
 * unknown rather than a plain send that realizes nothing. A claim that stands is left out of what explains the rise, since
 * it's the one thing that doesn't vouch for itself. Read after `settleClaims`, whose credits count as explained.
 */
function markUnseenEth({ rows, ethBalances, feeUnknownTxs, gasUnknownBlocks }: Pick<SettleInput, "rows" | "ethBalances" | "feeUnknownTxs" | "gasUnknownBlocks">): { rows: LegRow[]; unseenEth: UnseenEth[] } {
  const sends = new Map<number, string[]>()
  for (const [tx, txRows] of byTx(rows)) {
    const block = txRows[0]!.block_num
    if (isOneWaySend(txRows)) sends.set(block, [...(sends.get(block) ?? []), tx])
  }
  const feeUnknown = new Set(feeUnknownTxs)
  const gasUnknown = new Set(gasUnknownBlocks)
  const byBlock = new Map<number, LegRow[]>()
  for (const row of rows) {
    const blockRows = byBlock.get(row.block_num)
    if (blockRows) blockRows.push(row)
    else byBlock.set(row.block_num, [row])
  }
  const unseenEth: UnseenEth[] = []
  for (const [block, txHashes] of sends) {
    const before = ethBalances.get(block - 1)
    const after = ethBalances.get(block)
    if (before === undefined || after === undefined || gasUnknown.has(block)) continue
    const blockRows = byBlock.get(block) ?? []
    if (blockRows.some((row) => feeUnknown.has(row.tx_hash))) continue
    let arrived = BigInt(after) - BigInt(before)
    for (const row of blockRows) {
      if (row.token === ETH_ADDRESS && !isUnwrapClaim(row)) arrived -= row.side === "credit" ? BigInt(row.amount) : -BigInt(row.amount)
    }
    if (arrived > 0n) unseenEth.push({ blockNum: block, amount: arrived.toString(), txHashes })
  }
  const marked = new Set(unseenEth.flatMap((unseen) => unseen.txHashes))
  return { rows: marked.size === 0 ? [...rows] : rows.map((row) => (marked.has(row.tx_hash) ? { ...row, unseenEth: true } : row)), unseenEth }
}

/** Checks a wallet's rows against what its ETH really did: first what its claims say arrived, then what nothing says did. */
export function settleUnwraps(input: SettleInput): { rows: LegRow[]; priced: PricedRow[]; unseenEth: UnseenEth[] } {
  const { rows, priced } = settleClaims(input)
  return { ...markUnseenEth({ ...input, rows }), priced }
}

/** Pieces each stretch of blocks is cut into per round, because reads in one query are far cheaper than rounds of queries. */
const SEARCH_SECTIONS = 8

/**
 * The balances still needed to find each block where ETH moved by more than the wallet's rows explain. A stretch whose
 * balance change its rows explain has nothing to find, short of ETH arriving and leaving unseen by the same amount, which
 * nothing here can see, so only the rest get cut up, until each is one block. A claim that stands doesn't count as explaining anything.
 */
export function unseenEthSearchBlocks({ rows, ethBalances, fromBlock, through }: { rows: readonly LegRow[]; ethBalances: ReadonlyMap<number, string>; fromBlock: number; through: number }): number[] {
  const start = fromBlock - 1
  const ends = [start, through].filter((block) => !ethBalances.has(block))
  if (ends.length > 0) return ends
  const moves = rows.filter((row) => row.token === ETH_ADDRESS && row.kind !== "unseen_eth" && !isUnwrapClaim(row)).sort((a, b) => a.block_num - b.block_num)
  const known = [...ethBalances.keys()].filter((block) => block >= start && block <= through).sort((a, b) => a - b)
  const wanted: number[] = []
  let next = 0
  for (let i = 1; i < known.length; i++) {
    const [from, to] = [known[i - 1]!, known[i]!]
    let unexplained = BigInt(ethBalances.get(to)!) - BigInt(ethBalances.get(from)!)
    for (; next < moves.length && moves[next]!.block_num <= to; next++) {
      const row = moves[next]!
      if (row.block_num > from) unexplained -= row.side === "credit" ? BigInt(row.amount) : -BigInt(row.amount)
    }
    if (unexplained === 0n || to - from < 2) continue
    const points = Array.from({ length: SEARCH_SECTIONS - 1 }, (_, section) => from + Math.ceil(((to - from) * (section + 1)) / SEARCH_SECTIONS))
    wanted.push(...new Set(points.filter((block) => block > from && block < to)))
  }
  return wanted
}

/** Whether what this transaction moved could be why ETH arrived with it: a token sold, or the change from paying too much. */
function couldBringEth(txRows: readonly LegRow[]): boolean {
  const moved = txRows.filter((row) => !isFeeRow(row))
  return moved.some((row) => row.side === "debit") && (moved.some((row) => row.side === "credit") || moved.some((row) => row.side === "debit" && row.token !== ETH_ADDRESS))
}

/**
 * Adds a credit for each block where the wallet's ETH rose by more than its rows explain, without traces to say why. The
 * amount is the balance's, so it can't be ETH the wallet didn't receive, and it's left out whenever something else could
 * explain the change: a claim that stands, or a fee that isn't known. Each credit is a movement of its own, because a
 * balance can't say which transaction it came from. So it never changes what a trade traded, and a trade in the same block
 * isn't valued at all, since this could be part of what it got. Nothing says where in its block it came either, and a
 * named transaction is only the likeliest, so that never places it: `markUnknownOrder` says what that leaves unknown.
 */
export function creditUnseenEth({ rows, ethBalances, feeUnknownTxs, gasUnknownBlocks, account, fromBlock, through, payers, timestampOf }: Pick<SettleInput, "rows" | "ethBalances" | "feeUnknownTxs" | "gasUnknownBlocks"> & {
  account: string
  fromBlock: number
  through: number
  /** Who was behind the block's credit, where that's been read. */
  payers: ReadonlyMap<number, EthPayer | null>
  timestampOf: (block: number) => string
}): LegRow[] {
  const feeUnknown = new Set(feeUnknownTxs)
  const gasUnknown = new Set(gasUnknownBlocks)
  const byBlock = new Map<number, LegRow[]>()
  for (const row of rows) byBlock.set(row.block_num, [...(byBlock.get(row.block_num) ?? []), row])
  const credits: LegRow[] = []
  const trades = new Set<string>()
  for (const [block, after] of ethBalances) {
    const before = ethBalances.get(block - 1)
    if (before === undefined || block < fromBlock || block > through || gasUnknown.has(block)) continue
    const blockRows = byBlock.get(block) ?? []
    if (blockRows.some((row) => isUnwrapClaim(row) || feeUnknown.has(row.tx_hash))) continue
    let arrived = BigInt(after) - BigInt(before)
    for (const row of blockRows) {
      if (row.token === ETH_ADDRESS) arrived -= row.side === "credit" ? BigInt(row.amount) : -BigInt(row.amount)
    }
    if (arrived <= 0n) continue
    const payer = payers.get(block)
    credits.push({
      block_num: block,
      timestamp: timestampOf(block),
      tx_hash: payer?.txHash ?? "",
      // Always first in its block, whichever transaction is named, so ETH spent there has something to come from.
      tx_index: -1,
      log_index: 0,
      token: ETH_ADDRESS,
      account,
      side: "credit",
      amount: arrived.toString(),
      kind: "unseen_eth",
      ...(payer?.sender ? { counterparty: payer.sender } : {}),
    })
    for (const [tx, txRows] of byTx(blockRows)) if (couldBringEth(txRows)) trades.add(tx)
  }
  return [...rows.map((row) => (trades.has(row.tx_hash) ? { ...row, unseenEth: true } : row)), ...credits]
}

/**
 * Which transaction to name for ETH that arrived with no row. The balance already says how much, so all this decides is
 * who gets asked about. The one naming the wallet and this exact amount, as a payout list does, or the only one there is.
 * Anything else names nobody, because a transaction naming the wallet can be about something else entirely.
 */
export function payerOf(candidates: readonly PayoutTx[], account: string, amount: string): EthPayer | null {
  const me = normalizeAddress(account).slice(2)
  const word = BigInt(amount).toString(16).padStart(64, "0")
  const succeeded = candidates.filter((tx) => !tx.failed)
  const exact = succeeded.filter(({ input }) => input.includes(me) && input.includes(word))
  const tx = exact.length === 1 ? exact[0] : succeeded.length === 1 ? succeeded[0] : undefined
  if (!tx) return null
  const sender = tx.to === null ? null : normalizeAddress(tx.to)
  return { txHash: tx.txHash, sender: sender === normalizeAddress(account) ? null : sender }
}

/**
 * Transactions the wallet sent with no gas row. Each paid a fee nothing here counts, and a credit for that block would
 * take it out of what arrived, so the balance would match with the fee gone. Treated like gas that couldn't be worked
 * out, which leaves the block's credit out and the difference showing.
 */
export function sentWithNoFee(txs: readonly PayoutTx[], rows: readonly LegRow[], account: string): GasUnknownTx[] {
  const me = normalizeAddress(account)
  const paid = new Set(rows.filter((row) => row.kind === "gas").map((row) => row.tx_hash))
  return txs.filter((tx) => normalizeAddress(tx.from) === me && !tx.deposit && !paid.has(tx.txHash)).map((tx) => ({ tx_hash: tx.txHash, block_num: tx.blockNum }))
}

/**
 * Sets apart ETH that arrived unseen, and whatever else moved ETH in its block, because a balance can't say which came
 * first, and what each one cost can depend on it. That includes a network fee: however small, it's a cost nobody knows.
 * It takes every wallet being folded together, so a pool has to ask again. See `FoldLeg["orderUnknown"]`.
 */
export function markUnknownOrder(legs: readonly PricedLeg[]): PricedLeg[] {
  const moved = new Map<number, PricedLeg[]>()
  for (const leg of legs) {
    if (leg.asset === "ETH" && !leg.opening) moved.set(leg.blockNum, [...(moved.get(leg.blockNum) ?? []), leg])
  }
  const orders = new Map<number, NonNullable<PricedLeg["orderUnknown"]>>()
  for (const [block, blockLegs] of moved) {
    if (blockLegs.length < 2 || !blockLegs.some((leg) => leg.parts.some((part) => part.kind === "unseen_eth"))) continue
    orders.set(block, blockLegs.some((leg) => BigInt(leg.delta) < 0n) ? "always" : "fifo")
  }
  return legs.map((leg) => {
    const order = leg.asset === "ETH" && !leg.opening && leg.orderUnknown !== "always" ? orders.get(leg.blockNum) : undefined
    return order ? { ...leg, orderUnknown: order } : leg
  })
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

/** What a token off the allowlist was worth at a block, in USD per its smallest unit, if it has a market. See `token-market.ts`. */
export type TokenPriceLookup = (token: string, blockNum: number) => number | null

type Input = {
  account: string
  rows: readonly LegRow[]
  references: readonly Reference[]
  priced: readonly PricedRow[]
  market?: MarketLookup
  tokenPrice?: TokenPriceLookup
}

/**
 * The one token off the allowlist this transaction swapped for the one that's on it, if its market says so. What left has to be
 * worth about what arrived, by that market and with nothing else moving, which an LP exit, a vault withdrawal or a claim isn't. So
 * it only ever says this was an exchange: the value still comes from the listed side, and a wrong market can't set it.
 */
function isExchangeForToken(net: { token: Token; delta: bigint }, usdMicros: string, nets: ReadonlyMap<string, bigint>, blockNum: number, tokenPrice: TokenPriceLookup): boolean {
  const moves = [...nets].filter(([, delta]) => delta !== 0n)
  if (moves.length !== 1) return false
  const [token, delta] = moves[0] as [string, bigint]
  if (delta < 0n === net.delta < 0n) return false
  const price = tokenPrice(token, blockNum)
  if (price === null) return false
  const abs = (value: bigint) => Number(value < 0n ? -value : value)
  const listedUsd = (abs(net.delta) * Number(usdMicros)) / 10 ** net.token.decimals / 1e6
  const ratio = (abs(delta) * price) / listedUsd
  return ratio >= ORACLE_BAND[0] && ratio <= ORACLE_BAND[1]
}

/**
 * Nets each transaction per asset, so a wrap (ETH out, WETH in) or a split route is a single movement,
 * then labels each leg's price and cost. Gas stays its own leg. Ordered for the fold: by block, then transaction,
 * with gas first because it's paid before the transaction runs.
 */
export function buildPricedLegs({ account, rows, references, priced, market, tokenPrice }: Input): PricedLeg[] {
  const me = normalizeAddress(account)
  const refs = new Map(references.map((r) => [r.blockNum, r]))
  const pricedByTx = new Map<string, PricedRow>()
  for (const p of priced) if (p.account === me && !pricedByTx.has(p.tx_hash)) pricedByTx.set(p.tx_hash, p)
  const own = rows.filter((row) => row.account === me)
  // ETH that arrived with no row is its own movement. It goes ahead of whatever else its block did, so what left has something to come from.
  const unseen = own.filter((row) => row.kind === "unseen_eth").map((row) => [row])
  const ordered = [...unseen, ...byTx(own.filter((row) => row.kind !== "unseen_eth")).values()].sort((a, b) => a[0]!.block_num - b[0]!.block_num || a[0]!.tx_index - b[0]!.tx_index)

  const legs: PricedLeg[] = []
  for (const txRows of ordered) {
    const first = txRows[0]!
    const ref = refs.get(first.block_num)
    const ethMicros = answerToMicros(ref?.ethUsd)
    const usdcMicros = answerToMicros(ref?.usdcUsd)
    const oracle = (t: Token) => (t.oracle === "eth" ? ethMicros : t.oracle === "usdc" ? usdcMicros : null)
    const base = { blockNum: first.block_num, timestamp: first.timestamp, txHash: first.tx_hash, txIndex: first.tx_index }

    if (first.kind === "unseen_eth") {
      legs.push({
        ...base,
        // Not its transaction's hash: which one it is can be read later, and what's been answered about it mustn't change.
        id: `unseen:${first.block_num}:ETH`,
        asset: "ETH",
        delta: first.amount,
        decimals: 18,
        kind: "transfer",
        priceMicros: ethMicros,
        priceSource: ethMicros === null ? null : "oracle",
        priceNote: ethMicros === null ? PRICE_NOTES.feedFailed : null,
        costMicros: null,
        proceedsMicros: null,
        costLabel: "unknown",
        parts: [partOf(first)],
      })
      continue
    }

    // The other token's balance can match while the amount it was traded for is wrong, so nothing here gets a value.
    const unsettledCredit = txRows.some(isUnwrapClaim)
    const unsettled = unsettledCredit ? { unsettledCredit } : {}
    const settledCredit = txRows.find((row) => row.settledCredit)?.settledCredit
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
    const { moves: unlistedMoves, unreadable: unlistedUnreadable, nets: unlistedNets } = netUnlisted(unlisted)
    const hasUnlisted = unlistedUnreadable || unlistedMoves.length > 0
    const unseenEth = txRows.some((row) => row.unseenEth)
    const isSwap = !hasUnlisted && !unsettledCredit && !unseenEth && moved.length === 2 && moved.some((n) => n.delta > 0n) && moved.some((n) => n.delta < 0n)
    // Something left and something arrived, but it can't be valued as a swap. It's still not a plain transfer: a debit
    // here was traded for something, so it has unknown proceeds, rather than no gain or loss at all.
    const anyOut = moved.some((n) => n.delta < 0n) || unlistedMoves.some((delta) => delta < 0n)
    const anyIn = moved.some((n) => n.delta > 0n) || unlistedMoves.some((delta) => delta > 0n)
    // A claim can cancel out what left, so whether anything arrived can't decide this while it stands.
    const isExchange = isSwap || unlistedUnreadable || unsettledCredit || unseenEth || (anyOut && anyIn)
    const pricedRow = pricedByTx.get(first.tx_hash)

    const resolved = moved.map((net) => {
      let price = oracle(net.token)
      let priceSource: PriceSource | null = price === null ? null : "oracle"
      let priceNote: string | null = null
      let rejected = false
      if (net.token.oracle && price === null) priceNote = PRICE_NOTES.feedFailed
      if (hasUnlisted) priceNote = PRICE_NOTES.unlisted
      else if (unsettledCredit) priceNote = PRICE_NOTES.unsettled
      else if (unseenEth) priceNote = PRICE_NOTES.unseenEth
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
        if (!rejected && !hasUnlisted && !unsettledCredit && !unseenEth) priceNote = null
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

    // One listed token for one that isn't, whose market says what left was worth about what arrived. That's an estimate of what
    // happened, so it's always labeled as one, and a sweep never acts on a gain that rests on it.
    const only = resolved.length === 1 ? resolved[0] : undefined
    const forToken =
      only && tokenPrice && only.price !== null && !unlistedUnreadable && !unsettledCredit && !unseenEth && !unlisted.some((row) => row.kind === "unlisted_nft") && isExchangeForToken(only.net, only.price, unlistedNets, first.block_num, tokenPrice)
    if (only && forToken) {
      tradeUsd = worth(abs(only.net.delta), BigInt(only.price as string), only.net.token.decimals)
      only.priceNote = null
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
        ...((marketSide || forToken) && value !== null ? { estimated: true } : {}),
        parts: net.parts.map(partOf),
        ...unsettled,
        ...(settledCredit ? { settledCredit } : {}),
      })
    }
  }
  return markUnknownOrder(legs)
}
