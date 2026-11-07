# How the numbers work

Where prices, rates and costs come from, the rules they follow, and what the apps can't work out.
For running the dataset or the shared server, see [OPERATIONS.md](OPERATIONS.md).
This is the behavior and its limits. The mechanics live in the code's comments, and the names below point at them.

## Where the data comes from

The server is the only thing that talks to Amp, so the token never reaches the browser or the Mac app. It reads from either:

- **The Pricetag dataset**, when `PRICETAG_DATASET` and `PRICETAG_START_BLOCK` are set.
  This is the design: the dataset carries the price, as [below](#where-prices-come-from).
- **The raw Base dataset**, otherwise.
  It derives the same rows at query time from the wallet's transactions and logs, and the oracle with `eth_call`.
  A wallet's first read takes about 15 s for an hour of blocks, and it only looks back an hour, or `PRICETAG_HISTORY_BLOCKS`.

Both gave identical legs on the wallet they were compared on.

## Where prices come from

The dataset reads Chainlink's prices from the `AnswerUpdated` logs its aggregators emit, not from `eth_call`.
So it makes no RPC calls, replaying the logs gives the same table, and Verify can check the log behind a price.

| Table | What it does |
| --- | --- |
| `price_updates` | Every update from the aggregators in `PRICE_FEEDS` (`packages/sdk/src/tokens.ts`). It starts one window before the dataset, so USDC/USD, which updates about daily, has a price at the first block. |
| `carried` | For each block, every update that could still be the latest: a join of `blocks` to `price_updates` over the update's window. Its `b._block_num` filter has to stay, or each batch can rescan all of Base. |
| `reference_prices` | The latest update per feed, one row per block, with each answer (1e8 USD) and the transaction it came from. `priced_legs` joins it on the block. |

- **An update only counts for so long.** ETH/USD's lasts 2,600 s (longest gap seen in a day: 1,236 s), and USDC/USD's 25 hours (longest gap in 76 rounds: 86,490 s).
  After that the price is `unknown`, never stale, and so are exchanges, because `pt_price` needs both feeds.
  If both lapsed together, a block would have no row, and the app would show as behind.
- **A new aggregator needs a new dataset version.** Proxies emit no log when Chainlink switches, so the old address just goes quiet.
  The server checks each proxy's `aggregator()` when it starts and warns if it isn't listed.
- **ETH/USD leads what its proxy returns** by 15 or 16 blocks (once in a while, 1). Compared block by block with `eth_call`, that's the only difference, and the newer published value is the one used.

Raw mode and balances still use `eth_call`.

**The other 8 tokens' feeds** (`TOKEN_FEEDS`, like AERO/USD) have their own dataset, `dataset/feeds.json`, set with `PRICETAG_FEEDS_DATASET`.
Its one table, `feed_updates`, holds about 330 updates a day and starts 26 hours before the Pricetag dataset.
They aren't in `price_updates` because `carried` would copy them to every block: about 164 more rows per block, 70.8M a day on 200 ms blocks, against 4.6M today.

- **A chart's older points** take an asset's latest update at or before the block.
  That matched `eth_call` in 240 of 240 comparisons (8 feeds at 30 blocks, including each side of real updates).
  It isn't faster (0.7 s a read against 0.6 s). It saves RPC calls.
- **What's held now** reads each contract with `eth_call` past the table's newest row, and everything if the table fails, since an update could still be on its way.
- **Each current price has a proof and a Verify**, from "Proof of this price" under the number.
  The update has to work out to the price shown, and wstETH's, priced in ETH, has two.
  Without `PRICETAG_FEEDS_DATASET`, those 8 prices say plainly that no log backs them.

To add a feed, add its aggregator to `TOKEN_FEED_AGGREGATORS` in `packages/sdk/src/tokens.ts`, then deploy a new tag with `node dataset/build.ts --feeds <the Pricetag dataset's start block>`.
Replacing `benface/pricetag` doesn't touch this dataset.

## Main currency

Both apps show every value in the chosen currency and remember it: the Mac app in Settings, and the web app in its header.
The dataset stays in USD, and `packages/sdk/src/currency.ts` is the one place that converts.

- **Each amount converts at the rate when it happened**, and a current value at the current rate.
  Conversion runs before the fold, so a gain in CAD includes what the exchange rate did in between.
- **The currencies are USD, CAD, EUR, GBP, CHF, AUD, NZD, SGD, MXN, BRL, TRY and ZAR:** every one with a Chainlink feed on Base, at 8 decimals, kept to its heartbeat.
  Base has no feed for JPY, SEK, NOK, DKK, PLN, CZK or HUF.
  A dollar that isn't the main currency says which: US$, CA$, A$, NZ$, S$ or MX$.
- **Rates come from the feeds' `AnswerUpdated` logs**, in the rates dataset (`dataset/rates.json`, set with `PRICETAG_RATES_DATASET`), about 200 updates a day, starting 3 days before the Pricetag dataset.
  Recent blocks fall back to the contract (`updateRounds` in `packages/sdk/src/rates.ts`), and without a rates dataset, as on a local Amp, every rate does.
  Clicking a number names the source, the rate, and the amount in USD.
- **Spending Money reads the current rate** from `GET /api/rate?currency=CAD` every 5 minutes, and keeps the last one for an hour at most.
  After that, or on a server whose rates are only demo ones, its amounts go back to `US$`.
  It's only for display: the cap, sweeps and what's signed work in USD.
- **What stays in USD says so**: the ETH price in the rule comparison, a published cost note, and what Coinbase charged in USD.
- **A cost entered for what a wallet already held** converts at the rate where its history starts, since when it was paid isn't known, and shows as an estimate. In its own currency it's exact.
- **A missing rate is never filled in.** That amount is unavailable, and no other day's rate stands in.
  A feed that hasn't updated in 3 days counts as missing, since forex markets close for only about 2.
- **A purchase keeps what was really paid,** converted at its arrival block's rate for that currency.
  Coinbase's USD total only stands in when that feed has no answer.
  A purchase in a currency with no feed, like SEK, stays unknown and is asked about, since that total hasn't been checked against a real order.

To add a currency, add it to `CURRENCIES` in `packages/sdk/src/currency.ts` and `macos/PricetagKit/Sources/PricetagKit/Currency.swift`, check its feed against Chainlink's list and its `description()`, `decimals()` and `aggregator()` onchain, then deploy a new rates dataset with `node dataset/build.ts --rates <the Pricetag dataset's start block>`.
A moved aggregator gets the same startup warning as prices, and that rate is unknown within 3 days.
Verify doesn't cover rates yet, though it would be the same check as `feedBehind` in `server/proof.ts`.

## Rules the numbers follow

- Price and cost are separate.
  A price is a shared fact labeled `oracle`, `swap` or `market`.
  A cost is this wallet's, labeled `paid`, `inherited`, `self-reported`, `received at market` or `unknown`.
  A swap's cost and proceeds are what actually changed hands, valued on the side with an oracle, preferring USDC.
- `unknown` is never $0.
  A position with an unknown cost shows "PnL unavailable", totals say what they leave out, and a total with nothing known is unavailable.
- Coverage only moves up to the block every table has processed, and the UI says when it's behind.
- ETH and WETH are one position, so wrapping is never a sale.
- A swap is one token out and one in, with nothing else moving. Anything else keeps its cost and proceeds unknown.
- A swap whose implied price is implausible, or far from its oracle, is rejected.

## Reconciling against the chain

Each position's legs are compared with its onchain balance at the last block they cover, to the smallest unit, with ETH against ETH plus WETH.
There's no tolerance anywhere.

- **Reconciled** gets a check mark: the balance is right.
  ETH that arrived with no transaction is counted from the balance, and the check says how much.
  A block where the wallet sent a transaction with no fee on record isn't counted, so the fee shows as a difference (`sentWithNoFee`).
  A recorded fee with the wrong amount would still be absorbed: nothing compares recorded fees with receipts.
- **Doesn't match** shows both balances and the difference. Its amount and value come from the chain, and its PnL is unavailable.
  Without traces, this is what catches rebasing tokens and internal ETH.
- **Not checked** means a read failed or an L1 fee isn't in yet, and it clears on its own.
  Its PnL is unavailable until then, so a failed read can't bring back a number already known to be wrong.

A failed read never makes a holding disappear, and an asset with no balance and no other evidence is listed as missing from the totals and the chart, never counted as zero.

What a wallet held before the first block read becomes an opening leg with an unknown cost, read with `eth_call` at the block before.
So amounts are full balances and an old wallet can reconcile, but its PnL is unavailable until that cost is known.

Each L1 data fee comes from the RPC receipt, because Amp's data doesn't have it, and is added to the gas leg in the server, so the dataset's `legs` stays L2 only.
It's read again once its block is past the reorg window, because a reorg can change it without moving the transaction.

## Resolving what we can't work out

The dataset carries a price. What something cost is personal, so each client works it out, in this order:

1. **Paid:** the wallet paid for it in the same transaction.
2. **Inherited:** it came from one of the user's linked wallets, through any chain of them, and carries what was paid and when.
   It stays unresolved when it's unresolved upstream, or when the sender's legs don't add up to its balance or it has no balance read yet.
   The last good read still vouches for what left up to its block, so a failed read can't flip a cost unknown and back.
   A mismatch is asked about, since it may never clear by itself, and an answer stands until every sender's history can be confirmed.
3. **Self-reported:** a cost entered in the app, from an exchange history, or in an onchain note, which only counts from the wallet's own zero-value transaction to itself.
4. **Received at market:** the price when it arrived, once it's known to be someone else's or came from a bridge. It's always an estimate.
5. **Unknown:** anything else. An unanswered sender stays here, even one that looks like a stranger, because it could be the user's own wallet.

Wallets are only folded together when read the same way, with the same pricing rule and currency. Otherwise the other wallet counts as not read yet, so its costs stay unresolved rather than becoming a gain nobody made.

A WETH unwrap the chain hasn't confirmed stays unknown and isn't asked about, since what it says arrived is only a claim.

**A token's price** goes oracle, swap, then `market`: the median of recent trades from `priced_legs`.
It needs 3 transactions of at least $100, $1,000 in all, within 30 minutes, each plausible at its own block, which stands in for liquidity, since `priced_legs` doesn't say how deep a pool is.
A dataset without the `unlisted_moves` table still has rows later versions removed, so it's never read for this.
Native ETH bought in a swap can be an unwrap the account never received, so those rows never set a market price.
The chart's reads come after the wallet's and share their limit, so a busy wallet's chart fills in over a few refreshes, newest first.

What's held now is valued at its Chainlink feed first, then at `market`.
The SDK reads the 8 other feeds (`TOKEN_FEEDS`) directly, only for current prices and the chart's 5-minute marks, never for a past transaction.
A feed's answer that's too old or out of bounds is no price, but not "no market".

**Other tokens** are any off the allowlist that moved through a wallet since the dataset's start and that it still holds.
They have no price, so they're in no total and in a list of their own: the fold, the cap and sweeps never see them, and the hot wallet never sends them.
A token that was already there and hasn't moved can't be found.
Their contracts can say anything, so names are cleaned up, always shown with the address, and never used to identify a token.

- **Possible spam** is tucked away one click from the rest, and never called worthless (`tuckedReason`).
- **Read time.** A wallet read never waits for these, so a token says "Reading…" until the next read after its answer.
  A wallet lists at most 300, its own moves and the newest first, and says how many it left out.
  The limits on reads and retries are in `packages/sdk/src/other-tokens.ts`.

**Answers stay on the device.** The Mac app and the browser send them with each request (`POST /api/portfolio/<address>`, with `/explain`, `/preview`, `/export`, `/compare` and `/last`, which folds what was last read without a new read).
The server folds with them and keeps nothing.
Costs are kept in the currency they were entered in, and converted at the rate when they arrived, or stay unknown without it.

A transfer's cost goes to the wallets it actually went to, whichever wallet is open.
An exchange cost covers only what had arrived when it was answered, and one withdrawal explains one arrival, so when more than one fits, none is resolved.
Oldest first can't split what was bought in one second at different prices, or a file whose crowded seconds would take too long, or a withdrawal imported before that was worked out, until it's imported again. Those stay unknown.

Answer Questions asks once per address, most useful first, and says why.
Each answer previews what it would do, Undo is always there, skipping leaves it flagged, and on the Mac, Settings > Answers can change or remove any of them.
Being paid by one of your wallets isn't enough to carry its cost: My wallet says this one's yours too, and Someone else values what arrived at the price then.
An exchange's or a contract's address is nobody's wallet, so it doesn't offer My wallet.
A token with no price anywhere isn't asked about.
Totals say how much is unresolved and estimated right next to the number, and exports mark every row `exact`, `estimated`, `unknown` or `no market`.

## Proving a price

Click a price, or Proof, on any row of an explanation.
It shows where that price came from, the logs behind it, and each dataset's manifest hash (the "fingerprint").
**Verify** then recomputes that block's commitments in the server from what Amp returns, using [Amp's documented method](https://github.com/edgeandnode/amp/blob/main/docs/feat/verification.md):

- **Block fingerprint:** the header's fields hash to the block's hash.
- **Transactions:** every transaction rebuilds `transactions_root` and hashes to its stored `tx_hash`.
- **Results and logs:** every receipt and log rebuilds `receipts_root`.
- **Base's node:** `BASE_RPC_URL` reports the same hash at that number. A different hash fails, and no answer says it's not checked.
- **Who sent it:** the row's transaction's signature recovers to its stored `from`. A deposit isn't signed, and its hash covers its sender.
- **This activity:** the row's transaction is in that data, and its logs, ETH value or gas match its amounts, including the other side of a swap.
- **Chainlink's update:** the block behind the price passes the same checks, its log is the feed's `AnswerUpdated` in the transaction `reference_prices` names, and its answer works out to the row's price. It doesn't appear when reading the raw dataset.

It's done here and not with `ampctl verify` because that can't check Base: every Base block starts with an OP Stack deposit (type `0x7e`), which it doesn't support.
It fails v0.0.42 and nightly `47b6fa2` alike, and the source still rejected the type on November 6.
Amp doesn't store a deposit's `sourceHash`, `mint` or `isSystemTx`, so those come from `BASE_RPC_URL`, and a wrong answer fails because the result has to hash to the block's commitment.

What a pass doesn't show, which the interface also says:

- That the header is on Base's real chain. A fake block would also need the node to agree, but that's one node's word, and a local Amp reads its blocks through the same `BASE_RPC_URL`.
- That the derived SQL ran correctly, including that the update was still the latest at the row's block.
- That Chainlink's number is right, only that Chainlink published it.
- Anything read with `eth_call`: an `oracle` price on the raw dataset or a local Amp before its first real update, exchange rates, and L1 fees.
- How much ETH reached a wallet from unwrapping. A `Withdrawal` log only records what was unwrapped, so what arrived is listed apart, from the balance when `settleUnwraps` could, and a swap price that uses it rests on the balance too.
- That the other transactions' `from` is right. Only the row's own is recovered.

`server/verify.ts` is the pure part, tested on real and tampered rows. `server/block.ts` reads a block, and `server/proof.ts` puts it into words.
It's valid for blocks since Canyon (January 2024), because older deposits' receipts are encoded differently.

## Pricing any token

`PRICETAG_TOKENS_DATASET` turns this on.
`dataset/tokens.json` is its own dataset, which reads `pricetag`'s tables and adds `token_trades`: every trade of any token against ETH, WETH or USDC, as the pool saw it.
Amounts stay in the smallest unit, so a token can't change what it's worth by lying about its decimals, and the USD comes from the ETH or USDC side.

`tokenMarketPrice` in `packages/sdk/src/token-market.ts` decides when those trades are a market: over 24 hours, at least 10 senders buying and 10 selling, $2,000 on each side, no sender above half, both sides trading in 6 separate hours.
The price is the middle of the last hour's trades, from at least 3 senders, within 25% of each other. Trades under $10 don't count.
Otherwise there's no price, for a stated reason, never $0.

| Attack | What stops it |
|---|---|
| Two wallets paying each other any rate | Only a contract that emits a swap event can be a row's pool |
| One bot washing its own pool | Counting senders, and the limit on any one sender's share |
| Many wallets faking volume with dust | Trades under $10 don't count, and $2,000 on each side |
| A token that can be bought but not sold | Sellers count separately from buyers |
| A token made an hour ago | 6 separate hours of trading on both sides |
| A pool so thin that each trade moves the price | The 25% limit on the last hour's trades, which stands in for depth |
| One odd trade | The middle of the trades, ignoring the highest and lowest tenth |

**None of this can make faking impossible.** Wallets are free to make, and a pool's fees come back to its owner, so someone determined could pass these for a few dollars of gas a day.
That's why **a price only ever says a swap happened.** When one unlisted token and one listed token swapped, with nothing else moving, and the market says they were within 25% of each other, what arrived costs what the listed side was worth at its own feed, as an estimate.
A fake market can't raise that number. It can only stop a question being asked about a real payment.

A price only counts what `token_trades` has processed, in the same 5-minute buckets, so a token whose dataset is behind or replaying a reorg has no price yet, and no result depends on which wallet was read first.
These tokens still get no position or value, and nothing here changes what's swept, the cap, what's signed or what's sent.

## Tax report

Both apps export the same files, because the server writes them (`POST /api/tax-report/<address>` with the country and the answers, in `src/core/tax.ts`; a `GET` with `?country=CA|US` has no answers).
This isn't tax advice, and the report says so first.

There are two buttons, and both give a CSV to check, not a finished return:

- **Download CSV** (**Export CSV…** on the Mac) is the full report, every row below.
- **Download as Form 8949** for the US, or **Download as Schedule 3** for Canada (**Export as …** on the Mac), lays the same rows out like that form's lines, for whoever copies them over (`src/core/tax-forms.ts`).
  Every amount comes from the full report's rows, so the two always agree. Things sent away aren't sales, so they're only in the full report.

- **One row per thing that may be taxable:** a sale, a network fee (paying in ETH sells that ETH) or something sent, with its proceeds, cost, gain, method, price source and transaction link, in the main currency.
  A position with nothing unresolved adds up to the Realized the apps show. With something unresolved, the apps leave the position out and this keeps each row it knows, and says so.
- **Gaps say so.** What can't be worked out says `unknown`, its row is `UNKNOWN GAIN` with a reason, and it's left out of the total, never 0.
  A sale that's part known becomes two rows. Costs from an estimate are `ESTIMATED`, and entered or imported ones `SELF-REPORTED`, even at $0.
- **It uses the same answers and resolver as the screen.**
- **A market price for what came from someone else reads differently by country.** In Canada it's generally the real cost of what you're paid or given ([ITA s. 69(1)(c)](https://laws-lois.justice.gc.ca/eng/acts/I-3.3/section-69.html), [s. 52(1)](https://laws-lois.justice.gc.ca/eng/acts/I-3.3/section-52.html)), so the row is `OK`.
  In the US it's the cost of pay (Q59) but not of a gift (Q76, [IRS digital asset FAQs](https://www.irs.gov/individuals/international-taxpayers/frequently-asked-questions-on-digital-asset-transactions)), and we can't tell which, so it's `ESTIMATED`.
  What arrives from a bridge or a mint could be the user's own money, so it's `ESTIMATED` in both.
- **Notes are rows too**, right under the header, so the file still parses and the warnings come first.
- **The country picks the defaults, and both can be overridden**, with a warning when that may not be accepted:

| Country | Method | Wallets | Official sources |
| --- | --- | --- | --- |
| Canada | Average | All together | [Income Tax Act s. 47](https://laws-lois.justice.gc.ca/eng/acts/I-3.3/section-47.html), [CRA guide T4037](https://www.canada.ca/en/revenue-agency/services/forms-publications/publications/t4037/capital-gains.html), [CRA crypto guide](https://www.canada.ca/en/revenue-agency/programs/about-canada-revenue-agency-cra/compliance/cryptocurrency-guide/income-crypto-transactions.html) |
| United States | Oldest first | Each on its own | [Treas. Reg. 1.1012-1(j)](https://www.ecfr.gov/current/title-26/section-1.1012-1), [Rev. Proc. 2024-28](https://www.irs.gov/pub/irs-drop/rp-24-28.pdf), [IRS digital asset FAQs](https://www.irs.gov/individuals/international-taxpayers/frequently-asked-questions-on-digital-asset-transactions) |

Canada's "all together" is our reading: s. 47 averages what a taxpayer owns and says nothing about where it's held, and CRA's crypto guide doesn't address wallets.

Wallets are the address on screen, any typed into the report, and the ones the answers or the app say are theirs.
A transfer between them isn't a sale: all together its cost stays in the pool, and each on its own it carries to the wallet it arrived in.
A wallet nobody's said is theirs takes no costs from the others.
The demo wallet can't be combined with anything.
All together needs one consistent history, so the report stops at the last block every wallet has reached and says what that leaves out. If their histories start at different blocks, which only happens on the raw dataset, every cost is `unknown`.

### Units your records named (US)

[Treas. Reg. 1.1012-1(j)(2)](https://www.ecfr.gov/current/title-26/section-1.1012-1) lets you identify which units a sale took from your own wallet, but only if your books and records named them no later than the date and time of the sale. A report choosing them afterwards wouldn't count, so the report only uses a choice that was recorded in time.

- **Where they live:** `Book.unitChoices`, beside the answers, so the server gets them like the rest and stores nothing. Each names a wallet, a transaction and an asset, when it was recorded, and each purchase it took from by its date (a UTC day, which means every purchase that day, or a moment) and how many units.
- **Where they come from:** for now, a CSV the user already kept, imported in the web app's tax report (`src/core/unit-choices.ts`): one row per purchase, with the columns `Recorded at, Wallet, Transaction, Asset, Bought on, Amount`. A record whose rows don't all read, including a date the calendar doesn't have, like February 30, is left out whole. The book refuses one too.
- **What the fold does** (`FoldLeg.takes` in `packages/sdk/src/fold.ts`): a sale or send with a choice takes exactly those units instead of the method's order, and what's left stays oldest first. It's refused, never stretched, and the method's order applies, when the units don't add up to what left, or name something that isn't held, more than is left of it, part of a day's purchases that cost different amounts, or something that could have been bought at any time before. Average mixes everything bought, so it never uses them. Network fees aren't named.
- **What the report says:** a row that used them says so, and its Method column says `Units you named`. A choice recorded after its sale, a refused one, one under Average, and one about a transaction that isn't in the wallet's history, or isn't only one sale or send of that asset, each get a warning, and those rows use the report's method. That counts every sale or send whose choice decides what the report's units cost, listed or not: a send between the report's wallets, any sale or send from a wallet it only takes costs from, and one from an earlier year than the report's. One after the report's year can't change it, so it's left out. A purchase a choice names none of keeps its cost, even one only known for all of it. Canada's report ignores them, since its rules average.
- The chain can't confirm when a record was made, so the records are the user's to keep.

### Form 8949 (US)

Lines follow the IRS instructions for Form 8949, in box I (short-term, Part I) or box L (long-term, Part II), which are for digital assets no Form 1099-DA or 1099-B reported. If a broker sent one, the user should use the box it names, and the file says so.

- **Short-term or long-term** comes from when each sold unit was acquired: it's long-term from the day after its first anniversary (`termOf`).
  A sale of units held for different lengths becomes a short-term and a long-term line, with the proceeds shared by units.
  Several purchase dates on one line say `VARIOUS`, and dates are in UTC.
- **When a date isn't known, it stays unknown.** A unit keeps its date through moves between linked wallets, and something received from someone else is dated the day it arrived.
  An opening balance has none, and neither does anything that arrived with no history behind it, like a bridge deposit or an amount with only a cost someone entered, unless an exchange file has its purchase date.
  Those lines go in their own group, "How long it was held isn't known", with no box and no total, since they can't be added to either part.
- **Only Oldest first keeps purchase dates.** Average mixes every purchase together, so with it every line lands in that unknown group.
- **Each part's total** only adds lines whose amounts are all known, and says how many it leaves out. With none known there's no total, never $0.

### Schedule 3 (Canada)

Lines follow Part 3 of Schedule 3, as CRA's guide T4037 describes: crypto-assets go on line 7, with the total proceeds for line 15200 and the total gain or loss for line 15301.
Each line has the year it was acquired, `Various` when there were several, and `unknown` when nothing says. Network fees are their own lines, so outlays and expenses stay empty.
The total leaves out unknown amounts the same way.

### Superficial losses (Canada)

A loss can't be deducted when the same asset is acquired within 30 days before or after the sale and is still held 30 days after (`flagSuperficialLosses`).
The report checks this across the wallets in it, and **only warns**: it marks the row, adds a warning, and counts the flagged losses next to the Schedule 3 total, but doesn't change any amount or add the loss to the new cost.
When the 30 days after haven't all been read yet, it says the loss may turn out to be superficial.
It can't see a spouse's or a company's wallets, which the rule counts too, and doesn't count something that arrived with no history behind it, like a bridge deposit, as a new purchase, unless an exchange file says when it was bought.

### Received (possibly income)

What arrived from other addresses is listed after the sales as **Received**, with the status `POSSIBLY INCOME` and its worth when it arrived in a **Value when received** column, which is `unknown`, never 0, when there's no price or exchange rate. Pay is income at fair market value in both countries ([ITA s. 52(1)](https://laws-lois.justice.gc.ca/eng/acts/I-3.3/section-52.html), [IRS FAQ Q59](https://www.irs.gov/individuals/international-taxpayers/frequently-asked-questions-on-digital-asset-transactions)), but a gift generally isn't, so a row is never called certain income, and its note names the sender.
Moves between the report's wallets, what's answered as "mine" or "my exchange", purchases, matched exchange withdrawals, bridges and mints aren't listed. An entered cost or a note doesn't take a row off, since what it cost doesn't say whether it was pay, but the note says that if it was bought, it isn't income.
A sender's whole credit is listed, even when as much or more of that token left in the same transaction. When it nets to nothing, it comes from the wallet's `netted`, which nothing folds, and its block's exchange rate is read like a leg's.
Received rows follow the year asked for, but aren't sales, so they're left out of `rowCount`, Form 8949 and Schedule 3, which say they're only in the full report.

### What it still doesn't do

- It doesn't adjust a superficial loss, or check the US wash sale rule, which the report says to ask an accountant about.
- The Mac app can't import units your records named yet, and neither app records them when you send.
- It only knows what reached these wallets. Something that arrived with no history behind it has no date unless an exchange file gives one, and its original cost stays unknown unless an exchange file or an answer gives it. A bridge deposit or a mint is the exception: without either, it's still valued at the market price when it arrived, as an estimate, not what was first paid for it.
- An unknown amount stays `unknown` in every file and every total, never $0.

On an older wallet, most rows start with an unknown gain, until the user answers for what it held before the first block read.
In a currency neither country reports in, like EUR, it warns first that those rules may not apply.

To add a country, add it to `TAX_COUNTRIES` in `src/core/tax.ts` and `macos/PricetagKit/Sources/PricetagKit/TaxReport.swift`.

## Known gaps

- Sending only covers ETH and the tracked tokens.
- A device's accounts are listed 5 at a time, and an account further down stays unlinked until you list it, since the app never sees a recovery phrase.
- The hardware wallet flows haven't run against a real device yet. See [the checklist](../HARDWARE-WALLETS.md#checklist-for-a-real-device).
- Exchange names are only as good as the list in `src/core/senders.ts`, from Basescan name tags and confirmed withdrawals. A withdrawal from an address not on it, including some of Coinbase's, won't say where it came from, though an imported history still matches it.
- A cost entered in CAD shows as unresolved for a wallet read in USD, never as the wrong number, because that read has no rates.
- Only the allowlist in `packages/sdk/src/tokens.ts` gets a position and a price.
  A transaction that also moves another token can't be split, so what arrived has an unknown cost and what left unknown proceeds, except for [a priced swap](#pricing-any-token).
- Reading the raw dataset, a past transfer of a token with no oracle has no price.
- The dataset nets per token, then only prices an account's single pair.
  A token that mostly cancels out (under half of what moved is left) is what a router kept, so it gets no price.
  Paying with ETH and WETH together makes two pairs, so the other token has no price, though the app still knows what was paid.
- Without traces, a WETH `Withdrawal` is only a claim that ETH reached the sender. `settleUnwraps` checks it against the balance, and when that can't say how much arrived, the swap's cost and proceeds stay unknown.
- Internal ETH isn't seen directly: batched payouts, a smart wallet's ETH from a swap, pools that pay out ETH, and bridge deposits' minted ETH (`transactions` has no `mint` column).
  When ETH doesn't add up, the server finds each block where the balance moved by more than its transactions explain (`unseenEthSearchBlocks`, about 40 reads for one such block in a few days), and credits exactly that rise with an unknown cost (`creditUnseenEth`).
  It asks about it under the likeliest transaction (`payerOf`), or with none to link to.
- Nothing says where in its block that ETH arrived, or why. So whatever else moved ETH in that block keeps its price but not its cost, and isn't asked about (`markUnknownOrder`, `FoldLeg.orderUnknown`), and a trade beside it gets no value.
  When something left, that covers all the ETH still held, until it's gone.
  A note can't cover a transaction where it could be either, so none is offered.
- ETH that leaves unseen, as from a smart wallet, and rebasing tokens are only flagged, and a flagged position's PnL stays unavailable.
  ETH arriving and leaving unseen by the same amount isn't found at all, since the balance adds up.
