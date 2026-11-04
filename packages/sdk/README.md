# Build on Pricetag

Pricetag is an Amp dataset that puts a USD price on token transfers on Base. This package reads it from TypeScript and derives a wallet's cost and PnL. It's also what the app in this repo runs on. If you don't use TypeScript, [plain SQL](#plain-sql) gets you the same legs and prices.

The package is local for now. It isn't on npm, so use it from inside this repo.

## Quickstart

Start the dataset, then print any Base wallet's positions and PnL:

```sh
pnpm install
PRICETAG_HISTORY_BLOCKS=300 pnpm amp:start   # a local Amp at chain head, in about 2 minutes. See the main README.
pnpm example 0xb4cb800910b228ed3d0834cf79d697127bbb00e5
pnpm amp:stop                                # stops it and deletes its data
```

Which prints something like this:

```
Blocks 53515266 to 53515680: 1356 legs
ETH: 1.209804786286906 | cost $2,931.29 | value $2,932.02 (oracle) | realized unknown | unrealized $0.73
USDC: 3159.098126 | cost $3,158.55 | value $3,158.55 (oracle) | realized unknown | unrealized $0.00
PnL: $0.73 (partial), gas $0.00, leaving out: ETH, USDC
Latest: USDC in 0x34355602d8da6870b10a3fab054e756d7c243c1f1fd6fb5e8c7cfcbcdb3e0410, price $1.00 (oracle), cost paid
```

The whole script is [`examples/portfolio.ts`](examples/portfolio.ts). The part that matters:

```ts
import { buildPortfolio, createPricetag, pnlStatus } from "@pricetag/sdk"

const pricetag = createPricetag({ url: "http://127.0.0.1:1602", dataset: "benface/pricetag@0.0.1" })

const { legs, blocks, gasUnknownTxs } = await pricetag.getLegs(address, { from: startBlock })
if (blocks.toBlock < blocks.fromBlock) throw new Error("Nothing in this range has been processed yet")

const { positions, totals } = buildPortfolio(legs, "average", await pricetag.getLatestPrices())
const status = pnlStatus(totals, gasUnknownTxs) // "complete", "partial" or "unavailable"
```

`pnpm amp:start` writes `AMP_QUERY_URL`, `PRICETAG_DATASET` and `PRICETAG_START_BLOCK` to `.env.local`, and the example reads them from there. A dataset only has data from its start block on, so that's the earliest `from` that returns anything.

## API

Amounts are in a token's smallest unit, and USD values are in micros (millionths of a dollar). Both are decimal strings, so no precision is lost. `null` always means unknown, and never $0.

| Call | What it returns |
| --- | --- |
| `createPricetag({ url, token?, dataset, baseDataset? })` | A client. A local Amp doesn't need a `token`, but a hosted one does. |
| `getLegs(address, { from, to? })` | `{ legs, blocks, references, gasUnknownTxs }`: a wallet's legs, priced and labeled, in the order the fold reads them. |
| `getPrices(token, { from, to? })` | `{ token, prices, blocks }`: a token's prices, by symbol or address. It throws on a token off the allowlist, which has no prices to give. |
| `getLatestPrices()` | The current prices to value positions at. Only ETH and USDC have one, and only with a recent oracle read. |
| `buildPortfolio(legs, method, prices?)` | `{ method, positions, totals }`, where `method` is `"average"` or `"fifo"`. It's pure, so it needs no Amp. Without `prices`, values and unrealized PnL stay unknown. |
| `pnlStatus(totals, gasUnknownTxs?)` | Whether `totals.pnlUsdMicros` can be read as the wallet's PnL: `complete`, `partial` or `unavailable`. |

Browser code should import `@pricetag/sdk/core`. It has `buildPortfolio` and the rest of the pure code, without the Amp client.

Things to check on every result:

- **`blocks`:** what was actually read. `toBlock` can stop short of what you asked for while a table catches up, and it's below `fromBlock` when nothing in the range has been processed yet. So no rows doesn't always mean nothing happened: check this before folding, because a portfolio of no legs adds up to $0. Each call only waits for the tables it reads, so `getPrices` for ETH, WETH or USDC only needs `reference_prices`, and other tokens need `legs`, `unlisted_legs` and `priced_legs`.
- **Gas:** `gasUnknownTxs` lists transactions whose gas couldn't be worked out. The fold never sees that gas, so `totals` can't say it's missing, and ETH is overstated by that much. Show the list, and pass it to `pnlStatus`. `totals.unpricedGas` means some gas had no price at its block, so it isn't in `totals.gasUsdMicros`.
- **Price:** a leg's `priceSource` is `oracle`, `swap` or null. When it's null, `priceNote` says why. In `getPrices`, an unknown price stays in the list with `source: "unknown"` and a `note`.
- **Transaction:** a leg has its `txHash` and the rows it nets together in `parts`. A swap price has its `txHash` and `account`. An oracle price is read at a block, so its `txHash` is null. A position's legs are in `effects`.

`totals` adds up only what's known, and `totals.excluded` says what it leaves out. Don't read a total without `pnlStatus` and `totals.excluded`: a `partial` total of $0.00 is what's known so far, not a wallet that broke even.

## What the tables mean

The dataset reference is `benface/pricetag@0.0.1`, and it reads `edgeandnode/base_mainnet@0.0.2`.

| Table | One row is | Columns worth knowing |
| --- | --- | --- |
| `legs` | One account's signed movement of an allowlisted token, ETH, or gas | `account`, `token`, `side` (`debit` or `credit`), `amount`, `kind` (`erc20`, `eth`, `gas`, `wrap` or `unwrap`), `tx_hash` |
| `unlisted_legs` | The same for a token off the allowlist. It has no price, but it shows money went somewhere else | Same as `legs`, with `kind` `unlisted` or `unlisted_nft`. An NFT's `amount` is its ID |
| `reference_prices` | One block's Chainlink ETH/USD and USDC/USD reads | `eth_round` and `usdc_round`. Field `c1` is the answer, in 1e8 USD |
| `priced_legs` | An account's only pair in a transaction, after netting each token: what it sold and what it bought | `sold_token`, `sold_amount`, `bought_token`, `bought_amount`, and `priced` (`source`, `token`, `usd_micros`) |

The other tables are steps on the way to these: `base_legs`, `gas_legs`, `tx_gas`, `unwrap_legs`, `net_legs`, `pairs`, `pair_counts` and `single_pairs`.

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

A negative `net` means the wallet held more than the range shows. In the SDK, that's `values.qty` minus `state.shortfallQty`.

**Oracle prices:** divide by 100 for micros.

```sql
SELECT block_num, timestamp, get_field(eth_round, 'c1') AS eth_usd, get_field(usdc_round, 'c1') AS usdc_usd
FROM "benface/pricetag@0.0.1".reference_prices
WHERE block_num BETWEEN 53515266 AND 53515658
ORDER BY block_num
```

**Swap prices for a token without an oracle:** skip any transaction that also moved a token off the allowlist, or the price may include what was paid for that token too.

```sql
SELECT p.block_num, p.tx_hash, p.account, get_field(p.priced, 'usd_micros') AS usd_micros
FROM "benface/pricetag@0.0.1".priced_legs p
LEFT JOIN (
  SELECT tx_hash, account, COUNT(*) AS n
  FROM "benface/pricetag@0.0.1".unlisted_legs
  WHERE block_num BETWEEN 53515266 AND 53515658
  GROUP BY tx_hash, account
) u ON p.tx_hash = u.tx_hash AND p.account = u.account
WHERE p.block_num BETWEEN 53515266 AND 53515658
  AND get_field(p.priced, 'token') = 'AERO' AND u.n IS NULL
ORDER BY p.block_num
```

Run on one wallet and range, the legs, balances and oracle queries match the SDK exactly. The swap query can differ from `getPrices` by a little, either way. It skips a transaction whenever an unlisted token moved, while the SDK only skips one where it moved on net. The SDK also rejects implausible prices, and only prices a simple swap. Over one range, AERO matched at 813, USDT gave 1,315 against the SDK's 1,313, and cbBTC gave 4,144 against 4,159.

SQL stops at cost, because a cost depends on every earlier leg. To get cost and PnL without the SDK, go through a wallet's legs in order, keeping lots per asset:

1. Net each transaction per asset, and handle gas separately.
2. A credit in a swap adds a lot at what was paid. Any other credit adds a lot with an unknown cost.
3. A debit takes from the oldest lots (FIFO) or from all of them in proportion (average). A swap's debit realizes its proceeds minus the known cost, and a plain transfer's debit realizes nothing.
4. Anything depending on an unknown cost is unknown. Never count it as $0.

[`src/fold.ts`](src/fold.ts) and [`src/legs.ts`](src/legs.ts) are the exact rules, and neither depends on Amp.

## Limits

These are the same as the app's, listed in the [main README](../../README.md#known-gaps). The ones you're most likely to hit:

- Amounts are what moved since the range's first block, not full balances. A short range shows a lot of `unknown`, because most tokens were bought before it.
- Only tokens on the allowlist in [`src/tokens.ts`](src/tokens.ts) get a position or a price.
- Only ETH and USDC have a current price, so other tokens show a cost but no value yet.
