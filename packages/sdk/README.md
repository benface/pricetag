# Build on Pricetag

Pricetag is an Amp dataset that puts a USD price on token transfers on Base. This package reads it from TypeScript and derives a wallet's cost and PnL, the same way the app in this repo does, because the app runs on it. If you don't use TypeScript, [plain SQL](#plain-sql) gets you the same legs and prices.

The package is local for now. It isn't on npm, so use it from inside this repo.

## Quickstart

Start the dataset, then print any Base wallet's positions and PnL:

```sh
pnpm install
PRICETAG_HISTORY_BLOCKS=300 pnpm amp:start   # a local Amp at chain head, in about 2 minutes. See the main README.
pnpm example 0xb4cb800910b228ed3d0834cf79d697127bbb00e5
pnpm amp:stop                                # stops it and deletes its data
```

Which prints something like this. This wallet held most of this before the first block read, so its amounts are right and match the chain, but what it paid is unknown, and so is its PnL:

```
Blocks 53517359 to 53518014
ETH: 143.6716 | cost unknown | value $346,994.90 (oracle) | realized unknown | unrealized unknown | reconciled
USDC: 200,253.2 | cost unknown | value $200,218.56 (oracle) | realized unknown | unrealized unknown | reconciled
PnL: unknown (unavailable), gas $0.00, leaving out: ETH (sold at an unknown cost, unknown cost), USDC (sold at an unknown cost, unknown cost)
Latest: ETH in 0x3920fc301a4d45b33d11fd22218e79f1b3e1233c82d8dc0e9450e7ac3f4a74c1, price $2,415.19 (oracle), cost paid
```

The whole script is [`examples/portfolio.ts`](examples/portfolio.ts). The part that matters:

```ts
import { createPricetag, formatSignedMoney } from "@pricetag/sdk"

const pricetag = createPricetag({
  url: "http://127.0.0.1:1602",
  dataset: "benface/pricetag@0.0.1",
  startBlock,
  rpcUrl: "https://mainnet.base.org",
})

const { started, positions, totals, pnlStatus, missing } = await pricetag.getPortfolio(address)
if (!started) throw new Error("Nothing has been processed yet")

console.log(formatSignedMoney(totals.pnlMicros), pnlStatus, missing) // "complete", "partial" or "unavailable", and what's left out
```

`pnpm amp:start` writes `AMP_QUERY_URL`, `PRICETAG_DATASET` and `PRICETAG_START_BLOCK` to `.env.local`, and the example reads them from there, along with `BASE_RPC_URL` if you've set one. A dataset only has data from its start block on, so that's the earliest block that returns anything.

## API

Amounts are in a token's smallest unit, and USD values are in micros (millionths of a dollar). Both are decimal strings, so no precision is lost. `null` always means unknown, and never $0.

| Call | What it returns |
| --- | --- |
| `createPricetag(config)` | A client. See [the config](#the-config). |
| `getPortfolio(address, { method?, from?, to? })` | A wallet's holdings, cost and PnL, matching the app. `method` is `"average"`, the default, or `"fifo"`. With a `to`, it's the wallet as of that block, at that block's prices. See [what it returns](#what-getportfolio-returns). |
| `getLegs(address, { from?, to? })` | `{ legs, blocks, references, gasUnknownTxs }`: what moved in the range, priced and labeled, in the order the fold reads them. It doesn't include opening balances or L1 fees. |
| `getPrices(token, { from?, to? })` | `{ token, prices, blocks }`: a token's prices, by symbol or address. It throws on a token off the allowlist, which has no prices to give. |
| `getLatestPrices()` | The current prices to value positions at. Only ETH and USDC have one, and only with a recent oracle read. |
| `buildPortfolio(legs, method, prices?)` | `{ method, positions, totals }` from `getLegs`' legs. It's pure, so it needs no Amp. Nothing in it is checked against the chain, so prefer `getPortfolio`. |
| `pnlStatus(totals, gasUnknownTxs?)` | Whether `totals.pnlMicros` can be read as the wallet's PnL: `complete`, `partial` or `unavailable`. `getPortfolio` already includes it. |
| `pnlOverTime(legs, method, prices, markPrice, latest, unconfirmed?)` | PnL after each transaction, where `referenceMarks(references)` gives `markPrice`. `getPortfolio` already includes it, as `points`. |
| `formatMoney`, `formatSignedMoney`, `formatPrice` | A value in micros, as text, in USD unless you pass another currency. `null` prints as `unknown`, never as $0. |
| `formatAmount`, `formatSignedAmount` | An amount in whole tokens, from its smallest units and decimals, cut to a readable length. They cut instead of rounding, so they never show more than there is. |
| `shortHash` | A transaction hash or address, shortened. |
| `describeError(error)` | The most useful message in an error from Amp's client. The SDK's own errors already have it as their `message`, with Amp's error as their `cause`. |
| `TOKENS`, `ASSETS`, `isAddress` | The allowlist, its positions, and whether a string is a Base address. |

Everything callers see is camelCase. The one exception is in `@pricetag/sdk/core`: `LegRow` and `PricedRow` are rows of the dataset's tables, so they keep its column names.

There are three entry points:

- `@pricetag/sdk` is the list above, for Node.
- `@pricetag/sdk/core` is for browser code. It has the fold, the pricing, the allowlist and the formatters, without the Amp client.
- `@pricetag/sdk/internal` is for this repo's server and tests. It can change at any time, so don't build on it.

### The config

| Option | What it does |
| --- | --- |
| `url` | Amp's query URL. |
| `token` | A local Amp doesn't need one, but a hosted one does. |
| `dataset` | The Pricetag dataset, like `benface/pricetag@0.0.1`. |
| `startBlock` | The dataset's first block. Reads start here unless they pass a `from`. With neither, they throw. |
| `rpcUrl` | Where `getPortfolio` reads L1 fees from. See below. |
| `baseDataset` | The raw dataset the chain's head is read from. It defaults to `edgeandnode/base_mainnet@0.0.2`. |
| `network` | Amp's name for the chain, used to read onchain balances. It defaults to `base_mainnet`. |
| `timeoutMs` | How long one query can take. It defaults to 60 s. |
| `logger` | Gets slow queries, and reads that failed and will be retried, through its `warn(message)`. It defaults to `console`. Pass `{ warn() {} }` to silence it. |

Queries always run one at a time, because a hosted Amp is shared.

L1 fees only exist on RPC receipts. Without an `rpcUrl`, a wallet that sent anything can't have its ETH checked against the chain, so ETH is `unchecked`, `l1Fees` is `"no rpc url"`, and `missing` says so. The public RPC is `https://mainnet.base.org`, and it rate-limits.

### What `getPortfolio` returns

| Field | What it is |
| --- | --- |
| `started` | False until the dataset has processed the first block. Until then, every total is `null` and `pnlStatus` is `unavailable`. No rows doesn't mean nothing happened. |
| `blocks` | `{ fromBlock, toBlock }`, what was actually read. `toBlock` can stop short of the head while a table catches up. |
| `positions` | One per asset, with `values`, `price`, `state`, `reconciliation` and the legs behind it in `effects`. |
| `totals` | Sums of only what's known, each `null` when nothing is, with what's left out in `excluded`. |
| `pnlStatus` | `complete`, `partial` or `unavailable`. |
| `missing` | What the numbers leave out, in words. It's empty when nothing is. Show it next to any total. |
| `legs` | Every leg in fold order, starting with what the wallet already held as opening legs (`opening: true`, with an unknown cost). |
| `points` | PnL after each transaction, for a chart. |
| `gasUnknownTxs` | Transactions whose gas couldn't be worked out, so ETH is overstated by that much. |
| `l1Fees`, `l1FeeUnknownTxs` | `read`, `pending` (some couldn't be read yet, and the next call tries again) or `no rpc url`, and the transactions affected. |
| `openingUnread`, `unreadAssets` | Assets whose balance before the first block couldn't be read, and assets with no position because nothing could be read about them, which isn't the same as holding none. |

A position's `reconciliation.status` is `reconciled` when its legs add up to its onchain balance to the smallest unit, `incomplete` when they don't, and `unchecked` when a read is missing. Only a reconciled position shows PnL. Otherwise its amount and value come from the chain, and its cost and PnL are `null`.

A client keeps each wallet's rows in memory, so another call on the same client only reads new blocks. A read with a `to` is re-read on each new block until `to` is 30 blocks behind the chain's head, because a reorg can still change it. After that, it's fixed. It also reads at most 200 L1 fees per call, so a busy wallet's ETH stays `unchecked` for its first few calls while they catch up.

### Other things to check

- **Lower-level `blocks`:** each call only waits for the tables it reads, so `getPrices` for ETH, WETH or USDC only needs `reference_prices`, and other tokens need `legs`, `unlisted_legs` and `priced_legs`. Check `blocks` before folding `getLegs`' legs, because a portfolio of no legs adds up to $0.
- **Price:** a leg's `priceSource` is `oracle`, `swap` or null. When it's null, `priceNote` says why. In `getPrices`, an unknown price stays in the list with `source: "unknown"` and a `note`.
- **Transaction:** a leg has its `txHash` and the rows it nets together in `parts`. A swap price has its `txHash` and `account`. An oracle price is read at a block, so its `txHash` is null. An opening leg isn't a transaction, so its `txHash` is empty.

`totals` adds up only what's known. Don't read a total without `pnlStatus` and `missing`: a `partial` total of $0.00 is what's known so far, not a wallet that broke even.

## What the tables mean

The dataset reference is `benface/pricetag@0.0.1`, and it reads `edgeandnode/base_mainnet@0.0.2`.

| Table | One row is | Columns worth knowing |
| --- | --- | --- |
| `legs` | One account's signed movement of an allowlisted token, ETH, or gas | `account`, `token`, `side` (`debit` or `credit`), `amount`, `kind` (`erc20`, `eth`, `gas`, `wrap` or `unwrap`), `tx_hash` |
| `unlisted_legs` | The same for a token off the allowlist. It has no price, but it shows money went somewhere else | Same as `legs`, with `kind` `unlisted` or `unlisted_nft`. An NFT's `amount` is its ID |
| `reference_prices` | One block's latest Chainlink ETH/USD and USDC/USD updates | `eth_answer` and `usdc_answer`, in 1e8 USD, null when a feed has no recent update. `eth_tx` and `usdc_tx` are the transactions they came from |
| `price_updates` | One Chainlink update, from its `AnswerUpdated` log. It starts 45,000 blocks before the dataset | `feed` (`eth` or `usdc`), `answer`, `tx_hash`, `log_index`, `round_id`, `updated_at`, `valid_blocks` |
| `priced_legs` | An account's only pair in a transaction, after netting each token: what it sold and what it bought | `sold_token`, `sold_amount`, `bought_token`, `bought_amount`, `priced` (`source`, `token`, `usd_micros`), and the prices it used: `eth_usd`, `usdc_usd`, `eth_tx`, `usdc_tx` |

The other tables are steps on the way to these: `base_legs`, `gas_legs`, `tx_gas`, `unwrap_legs`, `net_legs`, `unlisted_moves`, `pairs`, `pair_counts`, `single_pairs` and `carried`.

A price and a cost are separate. The dataset carries the price, a shared fact about a transaction. Cost is personal, so each client works it out: `cost = fold(pricedLegs, method)`. That's why the dataset has no cost column.

### Pinning a manifest

`0.0.1` is a local tag, not a fixed version. Every `pnpm amp:start` writes its own start block into the SQL, so each start has a new manifest hash. To print the current one:

```sh
AMP_ADMIN_URL=http://127.0.0.1:1610 ~/.amp/bin/ampctl dataset inspect benface/pricetag@0.0.1
```

To be sure of what you're reading, use the hash as the dataset reference, both in SQL and in `createPricetag`. For example: `benface/pricetag@f3bf823bc72c6bacec945d880d43a85b7eb8a5e2f95c03c6ce022e22cd3ffd69`, which only exists on the Amp that made it.

## Plain SQL

Any Amp client works, including `~/.amp/bin/ampsql --flight-url http://127.0.0.1:1602 "<query>"`. Always bound `block_num`. Addresses are binary, written `X'…'` in lowercase hex with no `0x`. The block numbers below are from one local run, so use your own.

**A wallet's legs:**

```sql
SELECT block_num, tx_hash, token, side, amount, kind
FROM "benface/pricetag@0.0.1".legs
WHERE block_num BETWEEN 53515266 AND 53515658
  AND account = X'51c72848c68a965f66fa7a88855f9f7784502a7f'
ORDER BY block_num, tx_index, log_index
```

An empty `amount` on a gas row means its gas couldn't be worked out.

**What a wallet's balances moved by:** ETH and WETH are one position.

```sql
SELECT
  CASE WHEN token IN (X'0000000000000000000000000000000000000000', X'4200000000000000000000000000000000000006') THEN 'ETH' ELSE encode(token, 'hex') END AS asset,
  SUM(CASE WHEN side = 'credit' THEN CAST(amount AS DECIMAL(76, 0)) ELSE -CAST(amount AS DECIMAL(76, 0)) END) AS net
FROM "benface/pricetag@0.0.1".legs
WHERE block_num BETWEEN 53515266 AND 53515658
  AND account = X'51c72848c68a965f66fa7a88855f9f7784502a7f' AND amount <> ''
GROUP BY 1
```

A negative `net` means the wallet held more than the range shows. In `buildPortfolio`, that's `values.qty` minus `state.shortfallQty`.

**Oracle prices:** divide by 100 for micros.

```sql
SELECT block_num, timestamp, eth_answer AS eth_usd, usdc_answer AS usdc_usd
FROM "benface/pricetag@0.0.1".reference_prices
WHERE block_num BETWEEN 53515266 AND 53515658
ORDER BY block_num
```

**Swap prices for a token without an oracle:** `priced_legs` already leaves out a pair when a token off the allowlist moved with it.

```sql
SELECT block_num, tx_hash, account, get_field(priced, 'usd_micros') AS usd_micros
FROM "benface/pricetag@0.0.1".priced_legs
WHERE block_num BETWEEN 53515266 AND 53515658
  AND get_field(priced, 'token') = 'AERO'
ORDER BY block_num
```

Run on one wallet and range, the balance query matches the SDK on every asset, and the oracle query returns a price for each block. The swap query can return a few prices `getPrices` doesn't, because the SDK also rejects implausible prices and only prices a simple swap. Over one range, AERO and USDT matched at 701 and 857, and cbBTC gave 2,780 against the SDK's 2,779.

SQL stops at cost, because a cost depends on every earlier leg. To get cost and PnL without the SDK, go through a wallet's legs in order, keeping lots per asset:

1. Net each transaction per asset, and handle gas separately.
2. A credit in a swap adds a lot at what was paid. Any other credit adds a lot with an unknown cost.
3. A debit takes from the oldest lots (FIFO) or from all of them in proportion (average). A swap's debit realizes its proceeds minus the known cost, and a plain transfer's debit realizes nothing.
4. Anything depending on an unknown cost is unknown. Never count it as $0.

[`src/fold.ts`](src/fold.ts) and [`src/legs.ts`](src/legs.ts) are the exact rules, and neither depends on Amp.

## Limits

- `getPortfolio` is in USD. The app can also show CAD, converting at each transaction's rate, and the SDK doesn't read those rates yet.
- An old wallet's cost is unknown for whatever it held before the first block read, so its PnL stays unavailable, and that's the common case on a short range. Its amounts and value are still right, because they come from the chain.
- `getLegs` and `getPrices` leave a sender's swap paid out in unwrapped ETH unknown, with a note saying why. An `unwrap` credit in `legs` only says a contract turned WETH into ETH in that transaction, not that the ETH reached the sender, and its amount can be wrong. Confirming it takes balances and L1 fees, so only `getPortfolio` does, like the app. `priced_legs` still has a row for them, so if you query it directly, don't take a `bought_token` of ETH on trust.
- Only tokens on the allowlist in [`src/tokens.ts`](src/tokens.ts) get a position or a price.
- Only ETH and USDC have a current price, so other tokens show a cost but no value yet.
- `getLegs` with `buildPortfolio` is only what moved in the range, so its numbers won't match `getPortfolio`'s. Read them as what those legs add up to, not as the wallet's PnL.

The app's other limits are in the [main README](../../README.md#known-gaps).
