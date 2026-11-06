// Writes dataset/pricetag.json: the tables' SQL, the UDFs, and the schemas Amp infers for them.
//
//   AMP_ADMIN_URL=http://127.0.0.1:1610 node dataset/build.ts [start block]
//
// Writes dataset/cautious-eth.json with --fork: the fork, with one pricing rule changed. FORK_OF names what it forks, which has
// to be registered where AMP_ADMIN_URL points.
//
//   FORK_OF=benface/pricetag@0.1.0 AMP_ADMIN_URL=... node dataset/build.ts --fork [start block]
//
// Writes dataset/rates.json with --rates: exchange rates, as their own small dataset, so adding a currency doesn't replace the one
// the app's prices come from. The start block is the Pricetag dataset's, and it reaches back from there.
//
//   AMP_ADMIN_URL=... node dataset/build.ts --rates [start block]
//
// Writes dataset/feeds.json with --feeds: the updates of the feeds in TOKEN_FEEDS, as their own small dataset, for the same reason.
//
//   AMP_ADMIN_URL=... node dataset/build.ts --feeds [start block]
//
// Writes dataset/tokens.json with --tokens: what any token traded for in a pool, as its own dataset, so adding it doesn't replace
// the one the app's prices come from. FORK_OF names the Pricetag version it reads.
//
//   FORK_OF=benface/pricetag@0.3.0 AMP_ADMIN_URL=... node dataset/build.ts --tokens [start block]
//
// It needs an Amp with edgeandnode/base_mainnet@0.0.2 registered, and only reads from it. What a table can look like
// comes from WORK-319: every table needs its own top-level `block_num()` filter, at most one join, explicit columns,
// and UDFs that never return null or throw, because one bad row stops the whole dataset.

import { readFileSync, writeFileSync } from "node:fs"
import { APPROVAL_LOGS, CURRENCIES, ERC20_ADDRESSES, ETH_ADDRESS, MAX_ROUND_AGE_SECONDS, PRICE_FEEDS, SEED_TX, TOKENS, TOKEN_FEED_AGGREGATORS, TOKEN_FEED_WINDOW_SECONDS, USDC_ADDRESS, WETH_ADDRESS, blockBefore, type PriceFeed } from "@pricetag/sdk/core"

const MANIFEST = new URL("./pricetag.json", import.meta.url)
const CAUTIOUS_MANIFEST = new URL("./cautious-eth.json", import.meta.url)
const RATES_MANIFEST = new URL("./rates.json", import.meta.url)
const FEEDS_MANIFEST = new URL("./feeds.json", import.meta.url)
const TOKENS_MANIFEST = new URL("./tokens.json", import.meta.url)

const hex = (address: string) => address.replace(/^0x/, "")

const TRANSFER = "Transfer(address indexed from, address indexed to, uint256 value)"
const NFT_TRANSFER = "Transfer(address indexed from, address indexed to, uint256 indexed id)"
const TRANSFER_SINGLE = "TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)"
const TRANSFER_BATCH = "TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)"
const DEPOSIT = "Deposit(address indexed dst, uint256 wad)"
const WITHDRAWAL = "Withdrawal(address indexed src, uint256 wad)"
const ANSWER_UPDATED = "AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)"
const OP_DEPOSIT_TX_TYPE = 126

const allowlist = ERC20_ADDRESSES.map((a) => `X'${hex(a)}'`).join(", ")
const ethToken = `arrow_cast(X'${hex(ETH_ADDRESS)}', 'FixedSizeBinary(20)')`
const logColumns = "block_num, timestamp, tx_hash, tx_index, log_index, address AS token"
const legColumns = "block_num, timestamp, tx_hash, tx_index, log_index, token, account, side, amount, kind"
// Who was on the other side, for what names one: an ERC-20 transfer or a transaction's own ETH. A wallet's read used to look this up in the raw tables.
const legsWithCounterparty = `${legColumns}, counterparty`
const noCounterparty = "arrow_cast(NULL, 'FixedSizeBinary(20)') AS counterparty"

function decoded(signature: string, where: string) {
  return `SELECT ${logColumns}, evm_decode_log(topic1, topic2, topic3, data, '${signature}') AS t
    FROM base.logs WHERE topic0 = evm_topic('${signature}') AND ${where}`
}

const addressList = (addresses: readonly string[]) => addresses.map((a) => `X'${hex(a)}'`).join(", ")

const [ETH_FEED, USDC_FEED] = PRICE_FEEDS

const feedCase = (value: (feed: PriceFeed) => string) => `CASE WHEN address IN (${addressList(ETH_FEED.aggregators)}) THEN ${value(ETH_FEED)} ELSE ${value(USDC_FEED)} END`

/** The newest update of one feed in a block's group of `carried` rows. */
const latest = (column: string, feed: PriceFeed) => `last_value(${column} ORDER BY update_block, log_index) FILTER (WHERE feed = '${feed.name}')`

/** A feed's price read from its contract, for when the dataset can't reach back to its last update. */
export type FeedSeed = { feed: PriceFeed; answer: string; roundId: string; updatedAt: number }

const UPDATE_COLUMNS = "block_num, timestamp, tx_hash, log_index, feed, valid_until, answer, round_id, updated_at"

/**
 * Every Chainlink update. It normally starts one window before the dataset, so even the feed that updates least has a
 * price at its first block. The address filter is required: 201 contracts emitted this event in a day.
 *
 * `seeds` is for an Amp with no blocks before `start`, like a local one. Each stands in for a feed's last update at the
 * first block, and lasts as long as that update would have.
 */
function priceUpdatesSql(start: number, seeds: readonly FeedSeed[] | null) {
  const logs = `SELECT block_num, timestamp, tx_hash, log_index, ${feedCase((feed) => `'${feed.name}'`)} AS feed,
  ${feedCase((feed) => `timestamp + INTERVAL '${feed.validSeconds} seconds'`)} AS valid_until,
  get_field(t, 'current') AS answer, get_field(t, 'roundId') AS round_id, get_field(t, 'updatedAt') AS updated_at
FROM (SELECT block_num, timestamp, tx_hash, log_index, address, evm_decode_log(topic1, topic2, topic3, data, '${ANSWER_UPDATED}') AS t
  FROM base.logs WHERE topic0 = evm_topic('${ANSWER_UPDATED}') AND address IN (${addressList(PRICE_FEEDS.flatMap((feed) => feed.aggregators))}))`
  if (!seeds) return `${logs}\nWHERE block_num() >= ${Math.min(...PRICE_FEEDS.map((feed) => blockBefore(start, feed.validSeconds * 1000)))}`
  const rows = seeds.map(
    ({ feed, answer, roundId, updatedAt }) =>
      `SELECT block_num, timestamp, arrow_cast(X'${hex(SEED_TX)}', 'FixedSizeBinary(32)') AS tx_hash, arrow_cast(0, 'UInt32') AS log_index, '${feed.name}' AS feed,
  arrow_cast(to_timestamp_seconds(${updatedAt + feed.validSeconds}), 'Timestamp(Nanosecond, Some("+00:00"))') AS valid_until,
  '${answer}' AS answer, '${roundId}' AS round_id, '${updatedAt}' AS updated_at
FROM base.blocks WHERE block_num = ${start}`,
  )
  return `SELECT ${UPDATE_COLUMNS} FROM (
${[logs, ...rows].join("\nUNION ALL\n")}
) WHERE block_num() >= ${start}`
}

/**
 * Every update of an exchange rate, with the currency it's for. It has no table carrying each one forward to every block, because
 * nothing here joins on it: a reader takes the latest at or before the block it wants. It starts as far back as a rate at the
 * Pricetag dataset's first block could have been set, so that block has one.
 */
export function rateUpdatesSql(start: number) {
  const feeds = Object.values(CURRENCIES).flatMap(({ code, feed }) => (feed ? feed.aggregators.map((address) => ({ name: code, address })) : []))
  return updatesSql("currency", feeds, blockBefore(start, MAX_ROUND_AGE_SECONDS * 1000))
}

/**
 * Every update of a token's feed in `TOKEN_FEEDS`, with its asset. Like `rateUpdatesSql`, nothing joins on it, so it has no table
 * carrying each one forward: over 8 feeds that would add about 164 rows to every block, around 16 times what `carried` holds.
 */
export function feedUpdatesSql(start: number) {
  const feeds = Object.entries(TOKEN_FEED_AGGREGATORS).flatMap(([name, aggregators]) => (aggregators ?? []).map((address) => ({ name, address })))
  return updatesSql("asset", feeds, blockBefore(start, TOKEN_FEED_WINDOW_SECONDS * 1000))
}

function updatesSql(column: string, feeds: readonly { name: string; address: string }[], from: number) {
  return `SELECT block_num, timestamp, tx_hash, log_index, CASE ${feeds.map(({ name, address }) => `WHEN address = X'${hex(address)}' THEN '${name}'`).join(" ")} END AS ${column},
  get_field(t, 'current') AS answer, get_field(t, 'roundId') AS round_id, get_field(t, 'updatedAt') AS updated_at
FROM (SELECT block_num, timestamp, tx_hash, log_index, address, evm_decode_log(topic1, topic2, topic3, data, '${ANSWER_UPDATED}') AS t
  FROM base.logs WHERE topic0 = evm_topic('${ANSWER_UPDATED}') AND address IN (${addressList(feeds.map(({ address }) => address))}))
WHERE block_num() >= ${from}`
}

function unlistedSelect(account: string, side: string, amount: string, kind: string, from: string) {
  return `SELECT block_num, timestamp, tx_hash, tx_index, log_index, token, ${account} AS account, '${side}' AS side, ${amount} AS amount, '${kind}' AS kind FROM (${from})`
}

export function tablesSql(start: number, seeds: readonly FeedSeed[] | null = null): Record<string, string> {
  const since = `block_num() >= ${start}`
  const transfer = decoded(TRANSFER, `topic3 IS NULL AND address IN (${allowlist})`)
  const unlistedTransfer = decoded(TRANSFER, `topic3 IS NULL AND address NOT IN (${allowlist})`)
  const unlistedNft = decoded(NFT_TRANSFER, `topic3 IS NOT NULL AND address NOT IN (${allowlist})`)
  // ERC-1155 batches hold many IDs and amounts, so an empty amount just says something moved.
  const transferSingle = decoded(TRANSFER_SINGLE, "TRUE")
  const transferBatch = decoded(TRANSFER_BATCH, "TRUE")
  const weth = `address = X'${hex(WETH_ADDRESS)}'`
  return {
    // WETH emits Deposit and Withdrawal instead of Transfer when it's wrapped and unwrapped, so those count too.
    base_legs: `SELECT ${legsWithCounterparty} FROM (
  SELECT block_num, timestamp, tx_hash, tx_index, log_index, token, t.from AS account, 'debit' AS side, t.value AS amount, 'erc20' AS kind, t.to AS counterparty FROM (${transfer})
  UNION ALL
  SELECT block_num, timestamp, tx_hash, tx_index, log_index, token, t.to AS account, 'credit' AS side, t.value AS amount, 'erc20' AS kind, t.from AS counterparty FROM (${transfer})
  UNION ALL
  SELECT block_num, timestamp, tx_hash, tx_index, log_index, token, t.dst AS account, 'credit' AS side, t.wad AS amount, 'wrap' AS kind, ${noCounterparty} FROM (${decoded(DEPOSIT, weth)})
  UNION ALL
  SELECT block_num, timestamp, tx_hash, tx_index, log_index, token, t.src AS account, 'debit' AS side, t.wad AS amount, 'unwrap' AS kind, ${noCounterparty} FROM (${decoded(WITHDRAWAL, weth)})
  UNION ALL
  SELECT block_num, timestamp, tx_hash, tx_index, arrow_cast(0, 'UInt32') AS log_index, ${ethToken} AS token, "from" AS account, 'debit' AS side, value AS amount, 'eth' AS kind, "to" AS counterparty FROM base.transactions WHERE status AND value <> '0'
  UNION ALL
  SELECT block_num, timestamp, tx_hash, tx_index, arrow_cast(0, 'UInt32') AS log_index, ${ethToken} AS token, "to" AS account, 'credit' AS side, value AS amount, 'eth' AS kind, "from" AS counterparty FROM base.transactions WHERE status AND value <> '0' AND "to" IS NOT NULL
) WHERE ${since}`,

    // Tokens off the allowlist have no decimals, so they get no leg or price. This table is only evidence that money
    // went somewhere else in a transaction, without which a payment would look like it was all for the listed token.
    unlisted_legs: `SELECT ${legColumns} FROM (
  ${unlistedSelect("t.from", "debit", "t.value", "unlisted", unlistedTransfer)}
  UNION ALL
  ${unlistedSelect("t.to", "credit", "t.value", "unlisted", unlistedTransfer)}
  UNION ALL
  ${unlistedSelect("t.from", "debit", "t.id", "unlisted_nft", unlistedNft)}
  UNION ALL
  ${unlistedSelect("t.to", "credit", "t.id", "unlisted_nft", unlistedNft)}
  UNION ALL
  ${unlistedSelect("t.from", "debit", "''", "unlisted", transferSingle)}
  UNION ALL
  ${unlistedSelect("t.to", "credit", "''", "unlisted", transferSingle)}
  UNION ALL
  ${unlistedSelect("t.from", "debit", "''", "unlisted", transferBatch)}
  UNION ALL
  ${unlistedSelect("t.to", "credit", "''", "unlisted", transferBatch)}
) WHERE ${since}`,

    // transactions.gas_used is cumulative within a block, so a transaction's gas needs the one before it.
    // Index 0 is always the L1 attributes deposit on Base, so the inner join loses nothing.
    tx_gas: `SELECT a.block_num, a.timestamp, a.tx_hash, a.tx_index, a."from" AS account,
  CAST(a.gas_used AS VARCHAR) AS cumulative, CAST(p.gas_used AS VARCHAR) AS previous,
  CAST(a.gas_price AS VARCHAR) AS gas_price, CAST(a.max_fee_per_gas AS VARCHAR) AS max_fee, CAST(a.max_priority_fee_per_gas AS VARCHAR) AS max_priority
FROM base.transactions a
JOIN base.transactions p ON a._block_num = p._block_num AND a.tx_index = p.tx_index + 1
WHERE a.type <> ${OP_DEPOSIT_TX_TYPE} AND ${since}`,

    // An empty amount means the gas couldn't be worked out. The app reports those.
    gas_legs: `SELECT g.block_num, g.timestamp, g.tx_hash, g.tx_index, arrow_cast(0, 'UInt32') AS log_index, ${ethToken} AS token, g.account AS account, 'debit' AS side,
  self.pt_gas(g.cumulative, g.previous, g.gas_price, g.max_fee, g.max_priority, CAST(b.base_fee_per_gas AS VARCHAR)) AS amount, 'gas' AS kind, ${noCounterparty}
FROM self.tx_gas g
JOIN base.blocks b ON g._block_num = b._block_num
WHERE ${since}`,

    // Without traces, a WETH Withdrawal in a transaction counts as ETH paid to its sender. That's only a claim, because a
    // contract can send the ETH elsewhere, and this table can't read balances to check. So its rows keep their own kind,
    // and clients settle them against the chain. See `settleUnwraps` in the SDK.
    unwrap_legs: `SELECT l.block_num, l.timestamp, l.tx_hash, l.tx_index, l.log_index, ${ethToken} AS token, x."from" AS account, 'credit' AS side,
  get_field(evm_decode_log(l.topic1, l.topic2, l.topic3, l.data, '${WITHDRAWAL}'), 'wad') AS amount, 'unwrap' AS kind, ${noCounterparty}
FROM base.logs l
JOIN base.transactions x ON l._block_num = x._block_num AND l.tx_hash = x.tx_hash
WHERE l.address = X'${hex(WETH_ADDRESS)}' AND l.topic0 = evm_topic('${WITHDRAWAL}') AND ${since}`,

    legs: `SELECT ${legsWithCounterparty} FROM (
  SELECT ${legsWithCounterparty} FROM self.base_legs
  UNION ALL
  SELECT ${legsWithCounterparty} FROM self.gas_legs
  UNION ALL
  SELECT ${legsWithCounterparty} FROM self.unwrap_legs
) WHERE ${since}`,

    price_updates: priceUpdatesSql(start, seeds),

    // Every update that could still be the latest at each block. A join that isn't on the watermark reads history, which is
    // how a table carries a value forward. It starts on the block number because several blocks can share a second. The filter on b._block_num has to stay: without it, each batch can rescan all of
    // Base's blocks. These stages can't merge either: an aggregate over this join, or a projecting subquery on the blocks
    // side, registers fine and then fails in the job.
    carried: `SELECT b.block_num AS at_block, b.timestamp, u.feed, u.block_num AS update_block, u.log_index, u.tx_hash, u.answer
FROM base.blocks b
JOIN self.price_updates u ON b.block_num >= u.block_num AND b.timestamp < u.valid_until
WHERE b._block_num >= ${start} AND ${since}`,

    // The latest update per block, one row per block. A feed with no update in its window has an empty price, which is unknown.
    reference_prices: `SELECT block_num, timestamp, eth_answer, usdc_answer, eth_tx, usdc_tx FROM (
  SELECT at_block AS block_num, timestamp,
    ${latest("answer", ETH_FEED)} AS eth_answer,
    ${latest("answer", USDC_FEED)} AS usdc_answer,
    ${latest("tx_hash", ETH_FEED)} AS eth_tx,
    ${latest("tx_hash", USDC_FEED)} AS usdc_tx
  FROM self.carried GROUP BY block_num(), at_block, timestamp
) WHERE ${since}`,

    // What each account gained or lost per token in a transaction, so a split route is one movement. Amounts can reach
    // 2^256, so pt_net sums them with BigInt. What nets to zero goes, and pt_net leaves the amount empty for what mostly
    // cancels out. That's what a router or pool kept, not a trade, so its pair still counts but has no price.
    net_legs: `SELECT block_num, timestamp, tx_hash, account, token, get_field(net, 'side') AS side, get_field(net, 'amount') AS amount FROM (
  SELECT block_num, timestamp, tx_hash, account, token, self.pt_net(string_agg(CASE WHEN side = 'credit' THEN amount ELSE concat('-', amount) END, ',')) AS net
  FROM self.legs WHERE kind <> 'gas'
  GROUP BY block_num(), block_num, timestamp, tx_hash, account, token
) WHERE get_field(net, 'side') <> '' AND ${since}`,

    pairs: `SELECT a.block_num, a.timestamp, a.tx_hash, a.account,
  a.token AS sold_token, a.amount AS sold_amount,
  b.token AS bought_token, b.amount AS bought_amount
FROM self.net_legs a
JOIN self.net_legs b ON a._block_num = b._block_num AND a.tx_hash = b.tx_hash AND a.account = b.account
WHERE a.side = 'debit' AND b.side = 'credit' AND ${since}`,

    // What each account really moved per token off the allowlist in a transaction. What nets to zero moved nothing.
    // NFTs net by ID, each counting once, because an ID isn't a quantity. An amount that can't be read, as with ERC-1155,
    // still says something moved.
    unlisted_moves: `SELECT block_num, tx_hash, account, token FROM (
  SELECT block_num, tx_hash, account, token,
    self.pt_net(string_agg(CASE WHEN kind = 'unlisted_nft' THEN CASE WHEN side = 'credit' THEN '1' ELSE '-1' END WHEN side = 'credit' THEN amount ELSE concat('-', amount) END, ',')) AS net,
    bool_or(COALESCE(amount, '') = '') AS unreadable
  FROM self.unlisted_legs
  GROUP BY block_num(), block_num, tx_hash, account, token, CASE WHEN kind = 'unlisted_nft' THEN amount ELSE '' END
) WHERE (get_field(net, 'side') <> '' OR unreadable) AND ${since}`,

    // Counts an account's pairs and its unlisted moves in a transaction, since a payment could be for either. Amp can't
    // run NOT EXISTS or LEFT JOIN, so counting them together is how a pair with an unlisted move gets left out.
    // The filter has to sit above the GROUP BY, because Amp can't see a start block through an aggregate.
    pair_counts: `SELECT bn, tx_hash, account, pair_count FROM (
  SELECT block_num() AS bn, tx_hash, account, COUNT(*) AS pair_count FROM (
    SELECT block_num, tx_hash, account FROM self.pairs
    UNION ALL
    SELECT block_num, tx_hash, account FROM self.unlisted_moves
  ) GROUP BY block_num(), tx_hash, account
) WHERE ${since}`,

    // Transactions moving several tokens pair unrelated amounts, so only an account's single pair gets a price, and
    // only if nothing off the allowlist moved with it.
    single_pairs: `SELECT p.block_num, p.timestamp, p.tx_hash, p.account, p.sold_token, p.sold_amount, p.bought_token, p.bought_amount
FROM self.pairs p
JOIN self.pair_counts c ON p._block_num = c._block_num AND p.tx_hash = c.tx_hash AND p.account = c.account
WHERE c.pair_count = 1 AND ${since}`,

    priced_legs: pricedLegsSql("self.single_pairs", since),

    // Every approval event, as the logs have it, so a wallet's are one read by owner. What each still allows is read
    // from its contract when it's asked for, because spending and revoking change it.
    approvals: `SELECT block_num, timestamp, tx_hash, log_index, address, topic0, topic1, topic2, topic3 FROM base.logs
WHERE ${APPROVAL_LOGS} AND ${since}`,
  }
}

function pricedLegsSql(singlePairs: string, since: string) {
  return `SELECT p.block_num, p.timestamp, p.tx_hash, p.account,
  p.sold_token, p.sold_amount, p.bought_token, p.bought_amount,
  r.eth_answer AS eth_usd, r.usdc_answer AS usdc_usd, r.eth_tx, r.usdc_tx,
  self.pt_price(evm_decode_hex(p.sold_token), p.sold_amount, evm_decode_hex(p.bought_token), p.bought_amount, r.eth_answer, r.usdc_answer) AS priced
FROM ${singlePairs} p
JOIN self.reference_prices r ON p._block_num = r._block_num
WHERE ${since}`
}

/**
 * The fork: one rule changed, and only the tables that rule reaches. It reads everything else from the dataset it
 * forks, and the only thing that can differ between the two is the rule.
 */
export function cautiousEthTablesSql(start: number): Record<string, string> {
  const since = `block_num() >= ${start}`
  return {
    // The one rule: ETH counts at 1% below the feed, closer to what selling it would really bring in.
    reference_prices: `SELECT block_num, timestamp, self.pt_cautious(eth_answer) AS eth_answer, usdc_answer, eth_tx, usdc_tx
FROM pricetag.reference_prices WHERE ${since}`,
    priced_legs: pricedLegsSql("pricetag.single_pairs", since),
  }
}

const SWAP_V2 = "Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)"
const SWAP_SOLIDLY = "Swap(address indexed sender, address indexed to, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out)"
const SWAP_V3 = "Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
const SWAP_V4 = "Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)"
/** Uniswap v4 keeps every pool in this one contract. */
const POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b"

/**
 * What every token traded for against ETH or USDC, as a pool saw it. Only a contract that emits a swap event can be a row's pool, so
 * two wallets paying each other any rate they like never set a price, and a pool's own movement is one row per trade however
 * many routers it went through. A pool that moved anything else in the transaction is out, since its payment could be for that.
 *
 * No decimals and no allowlist: the amounts stay in a token's smallest unit, and what they're worth comes from the ETH or USDC
 * side. What makes a token's trading real is decided when it's read, because that's a window over many blocks. See
 * packages/sdk/src/token-market.ts.
 */
export function tokensTablesSql(start: number): Record<string, string> {
  const since = `block_num() >= ${start}`
  const quotes = addressList([ETH_ADDRESS, WETH_ADDRESS, USDC_ADDRESS])
  const moveColumns = "block_num, timestamp, tx_hash, account, token, side, amount"
  const sameMove = (a: string, b: string) => `${a}._block_num = ${b}._block_num AND ${a}.tx_hash = ${b}.tx_hash AND ${a}.account = ${b}.account`
  const inSwapLog = (legs: string) => `${legs} l JOIN self.swap_logs s ON l._block_num = s._block_num AND l.tx_hash = s.tx_hash AND l.account = s.pool`
  return {
    swap_logs: `SELECT block_num, tx_hash, pool, swaps FROM (
  SELECT block_num, tx_hash, address AS pool, COUNT(*) AS swaps FROM base.logs
  WHERE topic0 IN (${[SWAP_V2, SWAP_SOLIDLY, SWAP_V3, SWAP_V4].map((signature) => `evm_topic('${signature}')`).join(", ")})
  GROUP BY block_num(), block_num, tx_hash, address
) WHERE ${since}`,

    // An amount that can't be read, as with ERC-1155, isn't something a pool's price can come from.
    pool_unlisted: `SELECT l.block_num, l.timestamp, l.tx_hash, l.account, l.token, l.side, l.amount FROM ${inSwapLog("pricetag.unlisted_legs")}
WHERE l.kind = 'unlisted' AND l.amount <> '' AND ${since}`,

    pool_unlisted_net: `SELECT block_num, timestamp, tx_hash, account, token, get_field(net, 'side') AS side, get_field(net, 'amount') AS amount FROM (
  SELECT block_num, timestamp, tx_hash, account, token, self.pt_net(string_agg(CASE WHEN side = 'credit' THEN amount ELSE concat('-', amount) END, ',')) AS net
  FROM self.pool_unlisted
  GROUP BY block_num(), block_num, timestamp, tx_hash, account, token
) WHERE get_field(net, 'side') <> '' AND ${since}`,

    pool_listed: `SELECT l.block_num, l.timestamp, l.tx_hash, l.account, l.token, l.side, l.amount FROM ${inSwapLog("pricetag.net_legs")}
WHERE ${since}`,

    pool_moves: `SELECT ${moveColumns} FROM (
  SELECT ${moveColumns} FROM self.pool_unlisted_net
  UNION ALL
  SELECT ${moveColumns} FROM self.pool_listed
) WHERE ${since}`,

    move_counts: `SELECT bn, tx_hash, account, moves FROM (
  SELECT block_num() AS bn, tx_hash, account, COUNT(*) AS moves FROM self.pool_moves GROUP BY block_num(), tx_hash, account
) WHERE ${since}`,

    single_moves: `SELECT m.block_num, m.timestamp, m.tx_hash, m.account, m.token, m.side, m.amount
FROM self.pool_moves m
JOIN self.move_counts c ON ${sameMove("m", "c")}
WHERE c.moves = 2 AND m.amount <> '' AND ${since}`,

    // One side has to be what we have a Chainlink price for, and only one, or there's no token to price.
    trade_pairs: `SELECT a.block_num, a.timestamp, a.tx_hash, a.account AS pool, a.token AS gave_token, a.amount AS gave_amount, b.token AS got_token, b.amount AS got_amount
FROM self.single_moves a
JOIN self.single_moves b ON ${sameMove("a", "b")}
WHERE a.side = 'debit' AND b.side = 'credit' AND (a.token IN (${quotes})) <> (b.token IN (${quotes})) AND ${since}`,

    // A v4 pool paying in ETH moves it inside the pool manager, with no log and no transfer. So the manager shows one token moving,
    // and its Swap log says what ETH moved. Several swaps can't be told apart, so only a transaction with one counts.
    v4_swaps: `SELECT block_num, tx_hash, swaps, amount0, amount1 FROM (
  SELECT block_num, tx_hash, COUNT(*) AS swaps, min(amount0) AS amount0, min(amount1) AS amount1 FROM (
    SELECT block_num, tx_hash, arrow_cast(get_field(t, 'amount0'), 'Utf8') AS amount0, arrow_cast(get_field(t, 'amount1'), 'Utf8') AS amount1 FROM (
      SELECT block_num, tx_hash, evm_decode_log(topic1, topic2, topic3, data, '${SWAP_V4}') AS t FROM base.logs
      WHERE address = X'${hex(POOL_MANAGER)}' AND topic0 = evm_topic('${SWAP_V4}')
    )
  ) GROUP BY block_num(), block_num, tx_hash
) WHERE swaps = 1 AND ${since}`,

    v4_single_moves: `SELECT m.block_num, m.timestamp, m.tx_hash, m.account, m.token, m.side, m.amount
FROM self.pool_moves m
JOIN self.move_counts c ON ${sameMove("m", "c")}
WHERE c.moves = 1 AND m.account = X'${hex(POOL_MANAGER)}' AND m.amount <> '' AND m.token NOT IN (${quotes}) AND ${since}`,

    // Its empty amounts are filtered by what reads it. A filter on a JS function's result over a join fails in the job.
    v4_native_trades: `SELECT m.block_num, m.timestamp, m.tx_hash, m.account AS pool, m.token AS token, m.amount AS token_amount, CASE WHEN m.side = 'debit' THEN 'buy' ELSE 'sell' END AS side,
  self.pt_native(m.side, m.amount, s.amount0, s.amount1) AS quote_amount
FROM self.v4_single_moves m
JOIN self.v4_swaps s ON m._block_num = s._block_num AND m.tx_hash = s.tx_hash
WHERE ${since}`,

    pool_trades: `SELECT block_num, timestamp, tx_hash, pool, token, token_amount, side, quote_token, quote_amount FROM (
  SELECT block_num, timestamp, tx_hash, pool,
    CASE WHEN got_token IN (${quotes}) THEN gave_token ELSE got_token END AS token,
    CASE WHEN got_token IN (${quotes}) THEN gave_amount ELSE got_amount END AS token_amount,
    CASE WHEN got_token IN (${quotes}) THEN 'buy' ELSE 'sell' END AS side,
    CASE WHEN got_token IN (${quotes}) THEN got_token ELSE gave_token END AS quote_token,
    CASE WHEN got_token IN (${quotes}) THEN got_amount ELSE gave_amount END AS quote_amount
  FROM self.trade_pairs
  UNION ALL
  SELECT block_num, timestamp, tx_hash, pool, token, token_amount, side, ${ethToken} AS quote_token, quote_amount FROM self.v4_native_trades WHERE quote_amount <> ''
) WHERE ${since}`,

    priced_trades: `SELECT t.block_num, t.timestamp, t.tx_hash, t.pool, t.token, t.token_amount, t.side, t.quote_token, t.quote_amount,
  self.pt_trade(evm_decode_hex(t.quote_token), t.quote_amount, r.eth_answer, r.usdc_answer) AS usd_micros
FROM self.pool_trades t
JOIN pricetag.reference_prices r ON t._block_num = r._block_num
WHERE ${since}`,

    // Who sent it, because a thousand trades from one sender aren't a market.
    token_trades: `SELECT t.block_num, t.timestamp, t.tx_hash, x."from" AS sender, t.pool, t.token, t.token_amount, t.side, t.quote_token, t.quote_amount, t.usd_micros
FROM self.priced_trades t
JOIN base.transactions x ON t._block_num = x._block_num AND t.tx_hash = x.tx_hash
WHERE t.usd_micros <> '' AND ${since}`,
  }
}

/** What a v4 swap's ETH side moved, or empty unless its other side is exactly what the pool manager shows moving, the opposite way. A token paid in ETH is always `currency1`, since ETH's address sorts first. */
export function ptNativeSource(): string {
  return `
function pt_native(side, amount, amount0, amount1) {
  if (!/^\\d+$/.test(String(amount)) || !/^-?\\d+$/.test(String(amount0)) || !/^-?\\d+$/.test(String(amount1))) return '';
  const token = BigInt(amount1), eth = BigInt(amount0);
  const gave = side === 'debit';
  if (gave ? token <= 0n || eth >= 0n : token >= 0n || eth <= 0n) return '';
  if ((token < 0n ? -token : token) !== BigInt(amount)) return '';
  return (eth < 0n ? -eth : eth).toString();
}
`
}

/** What a trade's ETH or USDC side was worth, in USD millionths, or empty when that has no price. */
export function ptTradeSource(): string {
  return `
function pt_trade(quoteToken, quoteAmount, ethUsd, usdcUsd) {
  const token = String(quoteToken).replace(/^0x/, '').toLowerCase();
  const usdc = token === '${hex(USDC_ADDRESS)}';
  const answer = usdc ? usdcUsd : ethUsd;
  if (!/^\\d+$/.test(String(quoteAmount)) || !/^\\d+$/.test(String(answer))) return '';
  if (!usdc && token !== '${hex(WETH_ADDRESS)}' && token !== '${hex(ETH_ADDRESS)}') return '';
  return (BigInt(quoteAmount) * BigInt(answer) / (10n ** BigInt(usdc ? 8 : 20))).toString();
}
`
}

/** The dataset's copy of `ptPrice` in packages/sdk/src/legs.ts. test/dataset.test.ts runs both on the same inputs. */
export function ptPriceSource(): string {
  const tokens = TOKENS.map((t) => `  '${hex(t.address)}': { symbol: '${t.symbol}', decimals: ${t.decimals}, asset: '${t.asset}', oracle: ${t.oracle ? `'${t.oracle}'` : "null"} }`).join(",\n")
  return `
const TOKENS = {
${tokens}
};
function norm(a) { return String(a).replace(/^0x/, '').toLowerCase(); }
function usdPerToken(pricedAmt, pricedDec, refAmt, refDec, refAnswer) {
  return (BigInt(refAmt) * BigInt(refAnswer) * (10n ** BigInt(pricedDec)) / (BigInt(pricedAmt) * (10n ** BigInt(refDec)) * 100n)).toString();
}
function pt_price(soldToken, soldAmount, boughtToken, boughtAmount, ethUsd, usdcUsd) {
  const none = { source: 'unknown', token: '', usd_micros: '' };
  const s = TOKENS[norm(soldToken)], b = TOKENS[norm(boughtToken)];
  if (!s || !b || !ethUsd || !usdcUsd || !soldAmount || !boughtAmount) return none;
  if (BigInt(soldAmount) === 0n || BigInt(boughtAmount) === 0n) return none;
  if (s.asset === b.asset) return none;
  const answer = { eth: ethUsd, usdc: usdcUsd };
  if (s.oracle) return { source: 'swap', token: b.symbol, usd_micros: usdPerToken(boughtAmount, b.decimals, soldAmount, s.decimals, answer[s.oracle]) };
  if (b.oracle) return { source: 'swap', token: s.symbol, usd_micros: usdPerToken(soldAmount, s.decimals, boughtAmount, b.decimals, answer[b.oracle]) };
  return none;
}
`
}

/** The dataset's copy of `ptNet` in packages/sdk/src/legs.ts. test/dataset.test.ts runs both on the same inputs. */
export function ptNetSource(): string {
  return `
function pt_net(amounts) {
  const none = { amount: '', side: '' };
  if (!amounts) return none;
  let net = 0n, gross = 0n;
  for (const part of String(amounts).split(',')) {
    if (!/^-?\\d+$/.test(part)) return none;
    const amount = BigInt(part);
    net += amount;
    gross += amount < 0n ? -amount : amount;
  }
  if (net === 0n) return none;
  const size = net < 0n ? -net : net;
  return { amount: size * 2n < gross ? '' : size.toString(), side: net > 0n ? 'credit' : 'debit' };
}
`
}

export function ptGasSource(): string {
  return `
function pt_gas(cumulative, previous, gasPrice, maxFee, maxPriority, baseFee) {
  if (!cumulative || !previous) return '';
  let price;
  if (gasPrice) price = BigInt(gasPrice);
  else if (maxFee && maxPriority && baseFee) {
    const tipped = BigInt(baseFee) + BigInt(maxPriority);
    const cap = BigInt(maxFee);
    price = tipped < cap ? tipped : cap;
  } else return '';
  return ((BigInt(cumulative) - BigInt(previous)) * price).toString();
}
`
}

/** Leaves an empty answer empty, as a failed read is everywhere else, and it can't return null or throw. */
export function ptCautiousSource(): string {
  return `
function pt_cautious(answer) {
  if (!/^\\d+$/.test(String(answer))) return '';
  return (BigInt(answer) * 99n / 100n).toString();
}
`
}

const utf8Field = (name: string) => ({ name, data_type: "Utf8", nullable: true, dict_id: 0, dict_is_ordered: false, metadata: {} })

function functions() {
  return {
    pt_price: {
      inputTypes: ["Utf8", "Utf8", "Utf8", "Utf8", "Utf8", "Utf8"],
      // Struct fields have to be declared in alphabetical order.
      outputType: { Struct: [utf8Field("source"), utf8Field("token"), utf8Field("usd_micros")] },
      source: { source: ptPriceSource(), filename: "pt_price.js" },
    },
    pt_net: {
      inputTypes: ["Utf8"],
      outputType: { Struct: [utf8Field("amount"), utf8Field("side")] },
      source: { source: ptNetSource(), filename: "pt_net.js" },
    },
    pt_gas: {
      inputTypes: ["Utf8", "Utf8", "Utf8", "Utf8", "Utf8", "Utf8"],
      outputType: "Utf8",
      source: { source: ptGasSource(), filename: "pt_gas.js" },
    },
  }
}

const DEPENDENCIES = { base: "edgeandnode/base_mainnet@0.0.2" }

function tokenFunctions() {
  const { pt_net } = functions()
  return {
    pt_net,
    pt_native: { inputTypes: ["Utf8", "Utf8", "Utf8", "Utf8"], outputType: "Utf8", source: { source: ptNativeSource(), filename: "pt_native.js" } },
    pt_trade: { inputTypes: ["Utf8", "Utf8", "Utf8", "Utf8"], outputType: "Utf8", source: { source: ptTradeSource(), filename: "pt_trade.js" } },
  }
}

/**
 * Bloom filters on `account`, so a wallet's read skips files it isn't in: 3 of 60 row groups left instead of 17 of 53, and a
 * cold read about twice as fast (WORK-493). An `ndv` is about how many accounts a file holds. Amp marks this as experimental.
 */
const ACCOUNT_BLOOM: Record<string, number> = { legs: 200_000, unlisted_legs: 200_000, priced_legs: 20_000 }
/** A wallet asks about a few tokens, and a file holds thousands of them. */
const TOKEN_BLOOM: Record<string, number> = { token_trades: 5_000 }

type Manifest = { dependencies: Record<string, string>; tables: Record<string, string>; functions: Record<string, unknown> }

const startOf = (manifest: URL) => JSON.parse(readFileSync(manifest, "utf8")).tables.reference_prices.input.sql.match(/block_num\(\) >= (\d+)/)[1]

async function write(admin: string, file: URL, { dependencies, tables: sql, functions }: Manifest) {
  const response = await fetch(`${admin}/schema`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(process.env.AMP_ADMIN_TOKEN ? { authorization: `Bearer ${process.env.AMP_ADMIN_TOKEN}` } : {}) },
    body: JSON.stringify({ dependencies, tables: sql, functions }),
  })
  if (!response.ok) throw new Error(`/schema: ${response.status} ${await response.text()}`)
  const { schemas } = (await response.json()) as { schemas: Record<string, unknown> }
  const tables = Object.fromEntries(
    Object.entries(sql).map(([name, query]) => {
      const inferred = schemas[name]
      if (!inferred) throw new Error(`No schema for ${name}`)
      const ndv = ACCOUNT_BLOOM[name]
      const tokenNdv = TOKEN_BLOOM[name]
      const blooms = [...(ndv ? [{ column: "account", ndv }] : []), ...(tokenNdv ? [{ column: "token", ndv: tokenNdv }] : [])]
      return [name, { input: { sql: query }, schema: inferred, network: "base-mainnet", ...(blooms.length > 0 ? { bloom_filter_columns: blooms } : {}) }]
    }),
  )
  writeFileSync(file, `${JSON.stringify({ kind: "manifest", dependencies, tables, functions }, null, 2)}\n`)
  console.log(`Wrote ${file.pathname.split("/").pop()} with ${Object.keys(tables).length} tables`)
}

async function build() {
  const admin = process.env.AMP_ADMIN_URL
  if (!admin) throw new Error("Set AMP_ADMIN_URL to a local Amp's admin API")
  const args = process.argv.slice(2)
  if (args[0] === "--fork") {
    const forkOf = process.env.FORK_OF
    if (!forkOf) throw new Error("Set FORK_OF to the dataset this forks, like benface/pricetag@0.1.0")
    const start = Number(args[1] ?? startOf(CAUTIOUS_MANIFEST))
    const { pt_price } = functions()
    const pt_cautious = { inputTypes: ["Utf8"], outputType: "Utf8", source: { source: ptCautiousSource(), filename: "pt_cautious.js" } }
    await write(admin, CAUTIOUS_MANIFEST, { dependencies: { pricetag: forkOf }, tables: cautiousEthTablesSql(start), functions: { pt_price, pt_cautious } })
    return
  }
  if (args[0] === "--tokens") {
    const forkOf = process.env.FORK_OF
    if (!forkOf) throw new Error("Set FORK_OF to the Pricetag version this reads, like benface/pricetag@0.3.0")
    await write(admin, TOKENS_MANIFEST, { dependencies: { ...DEPENDENCIES, pricetag: forkOf }, tables: tokensTablesSql(Number(args[1] ?? startOf(MANIFEST))), functions: tokenFunctions() })
    return
  }
  if (args[0] === "--rates") {
    await write(admin, RATES_MANIFEST, { dependencies: DEPENDENCIES, tables: { rate_updates: rateUpdatesSql(Number(args[1] ?? startOf(MANIFEST))) }, functions: {} })
    return
  }
  if (args[0] === "--feeds") {
    await write(admin, FEEDS_MANIFEST, { dependencies: DEPENDENCIES, tables: { feed_updates: feedUpdatesSql(Number(args[1] ?? startOf(MANIFEST))) }, functions: {} })
    return
  }
  await write(admin, MANIFEST, { dependencies: DEPENDENCIES, tables: tablesSql(Number(args[0] ?? startOf(MANIFEST))), functions: functions() })
}

if (import.meta.main) await build()
