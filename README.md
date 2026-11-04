# pricetag
Every transfer gets a price. A Base wallet with real cost and PnL, built on Amp.

This first version is watch-only: paste any Base address to see its holdings, cost and PnL, and click any number to see the activity behind it. There are no keys in it, and it doesn't sign anything.

## Run it

```sh
pnpm install
cp .env.example .env.local   # fill in AMP_QUERY_URL and AMP_QUERY_TOKEN, or leave them empty for the demo wallet
pnpm dev                     # http://localhost:5173
```

`pnpm check` runs the type check, the tests and the build. `pnpm build && pnpm start` serves the built app on http://localhost:8787.

## The Mac app

Patina is a native menu bar app: live total PnL in the bar, holdings, cost and PnL in its popover, and a window where any number clicks through to its activity, price source and transaction. The wallet it shows is only read. The one key it holds is this Mac's spending money, below.

```sh
pnpm mac         # builds the app, opens it, and runs the server until you press Ctrl-C
pnpm mac:build   # only builds it, to macos/build/
pnpm check:mac   # the Swift tests, the app's build, and the shared packages' builds for iOS
pnpm check:keychain  # the real Secure Enclave and Keychain, with a throwaway key, from a signed debug build
pnpm check:anvil     # real signing and sweeps against a local fork of Base, with no real funds. It needs Foundry
pnpm mac:shot    # screenshots from fixtures that never open a window you'd see or take focus. See macos/TESTING.md
```

It reads from the server on http://127.0.0.1:8787, set in Settings, so it runs on whatever the server runs on: with no `.env.local`, that's the demo wallet. It remembers the wallet, method and currency across restarts.

If the menu bar is full, macOS hides new items. Look under the menu bar's "show hidden items" control, or in System Settings > Menu Bar, and drag it out. The window opens at launch either way.

The app never does PnL math and never holds an Amp token. `GET /api/portfolio/<address>?method=average|fifo&currency=USD|CAD` returns the portfolio the fold computed, `GET /api/portfolio/<address>/explain?metric=…&asset=…` or `?tx=…` returns what's behind one number, and `GET /api/portfolio/<address>/proof?leg=…` and `/verify?leg=…` return what's behind one price and the check of its block. With a [forked pricing rule](#forking-a-pricing-rule), `GET /api/rules` lists the rules, `&rule=<id>` picks one, and `GET /api/portfolio/<address>/compare` returns a wallet by both. `test/portfolio.test.ts` writes what they send to files the Swift tests read, so the two can't drift apart without a failure: when a change is on purpose, run it with `UPDATE_FIXTURES=1`.

- `macos/PricetagKit/`: everything that isn't Mac-specific, like the API models, the live feed, formatting and shared views. It also builds for iOS.
- `macos/HotWalletKit/`: the hot wallet, which also builds for iOS. `KeyVault` is the only code that touches a key, and `HotWalletKit` decides what to do and can only ask it to sign.
- `macos/App/`: the menu bar item, popover, window and settings.
- `macos/Config/App.xcconfig`: the app's name, in one place.
- `macos/TESTING.md`: how to test and screenshot the app without interrupting whoever's using this Mac.

### Spending money and savings

The Mac app has a capped hot wallet, this Mac's "spending money", for everyday use with no recovery phrase. Anything above the cap goes to a hardware wallet, your "savings", by itself while the app runs. Open it from the popover or with ⇧⌘M. It's an unreviewed hackathon build, for small funds only. **[HOT-WALLET-SECURITY.md](macos/HOT-WALLET-SECURITY.md)** says what it protects against and what it doesn't.

- **The key** comes from `SecRandomCopyBytes`, is wrapped by the Secure Enclave, and stays in a device-only Keychain item. It can't be restored or exported: lose the Mac and you lose what's on it, up to the cap.
- **The cap** is yours to set, $50 by default and $100 at most, or $25 at most until you add a savings wallet. A plain address can't enforce a cap, so it's what triggers a sweep and not a hard limit.
- **Sweeps** send whatever is above the cap, and realized gains unless you turn that off, to your chosen savings wallet. They only move tokens with a trusted price, they keep enough ETH for gas, and they skip dust. Costs carry over as `inherited`, because the app tells the server which wallets are yours: `GET /api/portfolio/<address>?linked=<addresses>`.
- **The alarm** compares what Amp and the chain say this wallet did with what the app signed. If they differ, it alerts loudly, stops top-ups, and offers to sweep what's left and replace the key.

Holding a key needs a provisioned build, which `pnpm mac` makes when the team pinned in `macos/run.sh` is signed in to Xcode. Without that, the app says it can't hold a key, and everything else works. It reads balances from `https://mainnet.base.org` directly, set in Settings, so sweeps don't depend on the server. Debug builds have their own wallet.

## Where the data comes from

The server is the only thing that talks to Amp, so the token never reaches the browser or the Mac app. It can read from either:

- **The Pricetag dataset**, when `PRICETAG_DATASET` and `PRICETAG_START_BLOCK` are set. This is the design: the dataset carries the price.
- **The raw Base dataset**, otherwise. It reads the wallet's transactions and logs, and the oracle with `eth_call`, then derives the same rows at query time. A wallet's first read takes about 15 s for an hour of blocks (longer for a busy wallet), and it only looks back `PRICETAG_HISTORY_BLOCKS`.

Both go through the same path after that, and they gave identical legs on the wallet they were compared on.

## Run the dataset locally

This runs the whole dataset on your Mac, with no token. It needs Docker running and Amp installed with `ampup`.

```sh
pnpm amp:start   # a fresh Amp from a recent Base block, and waits for chain head
pnpm dev
pnpm amp:stop    # stops it and deletes its data
```

`amp:start` runs `ampd solo` on localhost with a throwaway Docker Postgres, then deploys a raw Base dataset and the Pricetag dataset (`dataset/pricetag.json`) from `PRICETAG_HISTORY_BLOCKS` before the head, 1,800 blocks (an hour) by default. Every start computes a new start block and begins empty, because `amp:stop` deletes everything. Only one local Amp can run at a time, because its ports are fixed.

It adds a marked block to the end of `.env.local` that points the app at the local Amp and sets `PRICETAG_START_BLOCK`. That block overrides your own values while Amp runs, and `amp:stop` removes it, so nothing else changes. To read from a hosted Amp instead, don't start the local one, and set `AMP_QUERY_URL`, `AMP_QUERY_TOKEN`, `PRICETAG_DATASET` and `PRICETAG_START_BLOCK` yourself.

**Use a dedicated RPC for a demo.** `BASE_RPC_URL` in `.env.local` defaults to the public `https://mainnet.base.org`, which allows 25 requests a second per IP and is shared with anything else on your network. A failed `eth_call` stops the whole dataset until its retry succeeds. To avoid that, `amp:start` runs a small relay (`scripts/rpc-throttle.ts`) that holds requests to `BASE_RPC_RATE_LIMIT` a second, 20 by default, and retries 429s. Raise it to whatever a dedicated RPC allows. Of Amp's processes, only the relay gets `BASE_RPC_URL`. The app's server also uses it, for L1 fees. Neither ever logs it. Never commit a key.

On the public RPC, a fresh start takes about 9 minutes for the default hour of blocks. For a quicker one, use `PRICETAG_HISTORY_BLOCKS=300 pnpm amp:start`, which takes about 2 minutes.

## Forking a pricing rule

A pricing rule is a dataset version, and the server picks one per request with Amp's `amp-alias` header. The SQL never changes, and the app has no code for any rule. Set these and both apps show a switch, in the Mac app's Settings and above the web app's numbers, with each rule's dataset and manifest hash, and a side-by-side comparison of a wallet. The comparison uses one set of facts at one block for both rules: the same transactions, balances, fees and exchange rates, with only prices from each. If it can't establish that, it says so and shows no numbers.

```sh
PRICETAG_DATASET=benface/pricetag@0.0.1
PRICETAG_DATASET_HASH=a0a138cdffaa5a4053b1d0744bd2da7c64d368c951e69236142c19ce16f0553d
PRICETAG_FORK_DATASET=benface/pricetag_cautious@0.0.3
PRICETAG_FORK_HASH=592d6fa440eacb0977e8a988b8ba638fc33fbdafea415ab45c96f70f3e174a44
```

Queries are pinned to those hashes, so a hash on screen is what was read, and a wrong one fails instead of showing other numbers. With no fork set, nothing changes: there's no switch and no header.

The fork here is `dataset/cautious-eth.json`, from `cautiousEthTablesSql` in `dataset/build.ts`. Its one rule is that ETH counts at 1% below the Chainlink feed. It only materializes the tables a rule decides, `reference_prices` and `priced_legs`, and reads everything else from the dataset it forks. So it makes no `eth_call`s, starts from the same block, and can only differ by the rule. The transactions always come from the first dataset.

To change the rule, edit that function, then build, register and deploy it under a new tag, and update the hash:

```sh
FORK_OF=benface/pricetag@0.0.1 AMP_ADMIN_URL=… AMP_ADMIN_TOKEN=… node dataset/build.ts --fork 53515446
ampctl dataset register benface/pricetag_cautious dataset/cautious-eth.json --tag 0.0.4
```

Deploy with `POST /controller/materialized-datasets/benface/pricetag_cautious/versions/0.0.4` and `{}`, because `ampctl dataset deploy` from v0.0.42 fails on staging. List the versions first and use a free tag, because registering a tag that exists moves it without saying so.

**Replacing the dataset it forks means replacing the fork too.** The fork reads the job of the version it names, so stopping that job stops the fork. Deploy a fork of the new version before stopping the old one, then change all four lines together.

**A new dataset name needs a new manifest hash.** Amp finds a dataset's active tables by hash and table name, not by dataset name, so one manifest under two names can read and write the same tables. That's why `benface/pricetag@0.0.1` is `dataset/pricetag.json` at this start block plus a one-line SQL comment. A manifest with new SQL already has its own hash.

`pnpm amp:start` turns the fork off while it runs, because it isn't registered on a local Amp. Hot wallet decisions and tax reports always read by the default rule, whatever the switch says.

## How it's put together

- `packages/sdk/`: `@pricetag/sdk`, what other apps can build on too. [Its quickstart](packages/sdk/README.md) covers the tables, the API and plain SQL.
  - `src/fold.ts`: `applyLeg(state, leg)`, average cost and FIFO. Pure, BigInt, JSON-safe state and no imports, so it can move into a stateful table.
  - `src/legs.ts`: nets each transaction per asset and labels each leg's price and cost.
  - `src/portfolio.ts`: runs the fold and adds up what's known, in the browser for the web app and on the server for the Mac app and the SDK.
  - `src/reconcile.ts`: compares what a position's legs add up to with what the chain says it holds.
  - `src/format.ts`: how amounts and money print.
  - `src/amp.ts`, `src/dataset.ts`, `src/client.ts`: the Amp client and the reads from the dataset. The browser imports `@pricetag/sdk/core`, which leaves these out.
  - `src/wallets.ts`, `src/balances.ts`, `src/receipts.ts`: what a wallet read adds to its legs: opening and closing balances and L1 fees, kept in memory between reads. The app's server and `getPortfolio` both use these, through `@pricetag/sdk/internal`.
  - `src/currency.ts`: converts a wallet out of USD at each transaction's rate, before the fold.
- `src/`: the web app. `src/core/api.ts` is what the server sends its clients, `src/core/explain.ts` says how each number is worked out, for the web and Mac apps, and `src/core/fixtures.ts` is the demo wallet.
- `server/`: the raw data source, exchange rates, the block check, and the small HTTP server.
- `macos/`: the Mac app.
- `dataset/`: the manifests. `pricetag.json` and the fork `cautious-eth.json` are generated by `build.ts`, so change the SQL there.

## Main currency

Both apps show every value in the chosen currency, USD or CAD, and remember the choice: the Mac app in Settings, and the web app in its header. The dataset's base stays USD. `packages/sdk/src/currency.ts` is the one place that converts, and both apps go through it.

- **Each amount converts at the rate when it happened.** A cost or sale uses the rate at its transaction's block, and a current value uses the current rate. Conversion runs before the fold, so a gain in CAD is proceeds in CAD minus cost in CAD, and it includes what the exchange rate did in between.
- **Rates come from Chainlink's feed on Base**, read at the block with `eth_call`, so a transaction minutes old already has its rate. Clicking through a number names the source, the rate, and the amount in USD.
- **A missing rate is never filled in.** That amount is unavailable, whatever depends on it says so, and no other day's rate stands in. A feed that hasn't updated in 3 days counts as missing, since forex markets close for only about 2.

To add a currency, add its Chainlink feed to `CURRENCIES` in `packages/sdk/src/currency.ts` and a case to `macos/PricetagKit/Sources/PricetagKit/Currency.swift`. Base has feeds for EUR, GBP, AUD, CHF, SGD and others.

## Tax report

Both apps export the same CSV, because the server writes it (`GET /api/tax-report/<address>?country=CA|US`, and `src/core/tax.ts` does the work). This isn't tax advice, and the report says so first.

- **One row per thing that may be taxable:** a sale, a network fee (paying one in ETH counts as selling that ETH) or something sent. Each has its date, asset, amount, proceeds, cost, gain, method, price source and transaction link, in the main currency. The gains come from what the fold did, so a position with nothing unresolved adds up to the Realized the apps show. With something unresolved, the apps leave out the whole position and this keeps each row it knows, so the report's total can differ, and it says so.
- **Gaps say so.** A cost, proceeds or gain that can't be worked out says `unknown`, its row is `UNRESOLVED` with a reason, and it isn't in the gain total. It's never 0. A sale that's part known and part unknown becomes two rows. A cost from an estimate is `ESTIMATED`.
- **Notes are rows too**, right under the header, so the file still parses and the warnings are the first thing anyone sees.
- **The country picks the defaults, and both can be overridden**, with a warning when that may not be accepted:

| Country | Method | Wallets | Official sources |
| --- | --- | --- | --- |
| Canada | Average | All together | [Income Tax Act s. 47](https://laws-lois.justice.gc.ca/eng/acts/I-3.3/section-47.html), [CRA guide T4037](https://www.canada.ca/en/revenue-agency/services/forms-publications/publications/t4037/capital-gains.html), [CRA crypto guide](https://www.canada.ca/en/revenue-agency/programs/about-canada-revenue-agency-cra/compliance/cryptocurrency-guide/income-crypto-transactions.html) |
| United States | Oldest first | Each on its own | [Treas. Reg. 1.1012-1(j)](https://www.ecfr.gov/current/title-26/section-1.1012-1), [Rev. Proc. 2024-28](https://www.irs.gov/pub/irs-drop/rp-24-28.pdf), [IRS digital asset FAQs](https://www.irs.gov/individuals/international-taxpayers/frequently-asked-questions-on-digital-asset-transactions) |

Canada's "all together" is our reading: s. 47 averages what a taxpayer owns and says nothing about where it's held, but CRA's crypto guide doesn't address wallets directly.

Wallets are the address on screen plus any others typed into the report. A transfer between them, netting to zero, isn't a sale. All together, its cost stays in the pool. Each on its own, what arrives has an unknown cost in the report, until WORK-371 uses the costs the apps now carry between linked wallets.

All together needs one consistent history, because a cost worked out from part of it would look known and be wrong. So the report stops at the last block every wallet has reached and says what that leaves out. If their histories start at different blocks, which can only happen reading the raw dataset, every cost and gain says `unknown`. The demo wallet can't be combined with anything.

The report doesn't check Canada's superficial loss rule, split US short-term from long-term gains, or list what was received, and it says so. Anything before the first block read has an unknown cost, so most rows on an older wallet are unresolved for now.

To add a country, add it to `TAX_COUNTRIES` in `src/core/tax.ts` and a case to `macos/PricetagKit/Sources/PricetagKit/TaxReport.swift`.

## Rules the numbers follow

- Price and cost are separate. A price is a shared fact labeled `oracle`, `swap` or `market`. A cost is this wallet's, labeled `paid`, `inherited`, `self-reported`, `received at market` or `unknown`. A swap's cost and proceeds are what actually changed hands, valued on the side with an oracle, preferring USDC. They aren't the oracle price of what was bought or sold.
- `unknown` is never $0. A position with an unknown cost shows "PnL unavailable", totals say what they leave out, and a total with nothing known shows as unavailable.
- Coverage only moves up to the block every table has processed, so a lagging dataset can't skip blocks, and the UI says when it's behind.
- ETH and WETH are one position, so wrapping is never a sale.
- A swap is one token out and one in, with nothing else moving. Anything else keeps its cost and proceeds unknown.
- A swap whose implied price is outside a token's plausible range, or far from its oracle, is rejected. It has no value on either side.

## Reconciling against the chain

Each position's legs are compared with its onchain balance at the last block they cover, to the smallest unit. ETH is compared with ETH plus WETH.

- **Reconciled** gets a check mark.
- **Incomplete** shows the computed balance, the actual balance and the difference. Its amount and value come from the chain, because those are facts, and its PnL shows as unavailable. Without traces, this is what catches internal ETH transfers and rebasing tokens.
- **Not checked** means a read failed or an L1 fee isn't in yet. It clears on its own. Its PnL shows as unavailable until then, so PnL only ever shows for a position that matches. Otherwise a failed read would bring back a number already known to be wrong. Its amount comes from the chain if that read worked, and otherwise from the last read plus what's moved since.

Whether something is held is a separate question from whether it can be checked. A failed read never makes a holding disappear, and an asset with no balance read and no other evidence is listed as missing from the totals and the chart. It's never counted as zero.

What a wallet held before the first block read is read from the chain too (`eth_call` at the block before), and becomes an opening leg with an unknown cost. So amounts are full balances, and an old wallet can still reconcile, but its PnL stays unavailable until that cost is known.

Each transaction's L1 data fee comes from its RPC receipt, because Amp's data doesn't have it. It's added to the gas leg in the server for both data sources, so the dataset's own `legs` table stays L2 only. A fee is read when it's first seen, and again once its block is past the part of the chain re-read for reorgs, because a reorg can change it without moving the transaction. There's no tolerance anywhere: a wrong fee shows up as a mismatch.

## Resolving what we can't work out

The dataset carries a price. What something cost is personal, so each client works it out, in this order:

1. **Paid:** the wallet paid for it in the same transaction.
2. **Inherited:** it came from one of the user's linked wallets, so it carries over what that wallet paid and when, through any chain of wallets. What's unresolved upstream stays unresolved here.
3. **Self-reported:** a cost entered in the app, an exchange history's, or an onchain note. A note only counts from the wallet's own zero-value transaction to itself.
4. **Received at market:** the price when it arrived, once it's known to be someone else's or came from a bridge. It's always shown as an estimate.
5. **Unknown:** anything else. An unanswered sender stays here, even when it looks like a stranger, because it could be the user's own wallet.

Wallets are only folded together when they were read the same way, by the same pricing rule and in the same currency. A wallet read another way counts as not read yet, so what came from it stays unresolved rather than becoming a gain nobody made. A comparison marks whatever rests on an estimate the same way the main screen does.

A transaction with a WETH unwrap the chain hasn't confirmed yet stays unknown, and nothing asks about it: what it says arrived is only a claim, so no answer can rest on it. Once it settles, it's treated like anything else.

A token's price goes oracle, swap, then `market`: the median of its last few trades at or before that block, from `priced_legs`. It needs 3 transactions of at least $100, $1,000 in all, within 30 minutes, each one plausible at its own block. `priced_legs` doesn't say how deep a pool is, so that's the stand-in for liquidity. A dataset without the `unlisted_moves` table has the wrong rows WORK-346 removed, so it's never read for this.

**Answers stay on the device.** The Mac app and the browser keep them, and send them with each request (`POST /api/portfolio/<address>`, with `/explain`, `/preview`, `/export` and `/compare`, and the pricing rule when one is chosen). The server folds with them and keeps nothing. Costs are kept in the currency they were entered in, and converted at the rate when they arrived. Without that rate, they stay unknown.

A transfer's cost goes to the wallets it actually went to, whichever wallet is open: oldest lots first for the first transfer, or the same mix for each by average cost. An entered exchange cost covers only what had arrived when it was answered, so anything later is asked about in turn. One withdrawal in an exchange history explains one arrival, and when more than one fits, none of them is resolved from it. Native ETH bought in a swap can be an unwrap the account never received, so those `priced_legs` rows never set a market price.

"Who's this?" asks once per address, most useful first. Each answer shows what it would do before it's picked, Undo is always there, and skipping leaves it flagged. A token with no price anywhere isn't asked about: it's listed apart and can't affect PnL. Totals say how much is unresolved and estimated right next to the number, and exports mark every row `exact`, `estimated`, `unresolved` or `no market`.

## Proving a price

Click a price, or Proof, on any row of an explanation. It shows where that price came from, the logs behind it, and each dataset's manifest hash (the "fingerprint"), which identifies the recipe. **Verify** then recomputes that block's commitments in the server from what Amp returns, using [Amp's documented method](https://github.com/edgeandnode/amp/blob/main/docs/feat/verification.md):

- **Block fingerprint:** the header's fields hash to the block's hash.
- **Transactions:** every transaction rebuilds the header's `transactions_root`, and each one hashes to its stored `tx_hash`.
- **Results and logs:** every receipt and log rebuilds the header's `receipts_root`.
- **This activity:** the row's transaction is in that data, and its Transfer logs or ETH value match its amounts. A network fee's L2 part is worked out again from its gas, the block's base fee, and only the fee fields its transaction type hashes. For a swap price, that includes the other side of the exchange.

It's done here and not with `ampctl verify` because that can't check Base: every Base block starts with an OP Stack deposit (type `0x7e`), which it doesn't support. It fails v0.0.42 and nightly `47b6fa2` alike, and today's source still rejects the type. Amp doesn't store what a deposit's hash also covers (`sourceHash`, `mint`, `isSystemTx`), so those three come from `BASE_RPC_URL`. A wrong answer fails the check, because the result has to hash to the block's commitment. Every log and transaction it counts has to be in what's hashed, at the number it's stored with, or the check fails. If the RPC doesn't answer, Transactions says it's not checked. The fingerprints come from Amp's admin API at `AMP_ADMIN_URL`, with the server's token.

What a pass doesn't show, which the interface also says:

- That the header is on Base's real chain. A consistent fake block would pass.
- That the derived SQL ran correctly. Only the raw dataset's rows are checked, plus the row's amounts against them.
- An `oracle` price, or the oracle side of a `swap` price, because `eth_call` results aren't in a block's commitments. The same goes for exchange rates and L1 fees, which aren't in the commitments either, so an L1 fee's amount is never compared.
- That a transaction's `from` is right. Signatures are in the commitment, but aren't recovered to compare them with the stored sender, so a row that takes its account from the sender (fees, ETH sent, unwrapped ETH received) says so.

`server/verify.ts` is the pure part, tested on real rows and on tampered ones. Keccak comes from `@noble/hashes`, since whether Node has it depends on its build. `server/block.ts` reads a block and `server/proof.ts` puts it into words. It's valid for blocks since Canyon (January 2024), because older deposits' receipts are encoded differently.

## Known gaps

- Sending isn't in the app yet, so "Is this yours?" at send time and linking every account from one device or recovery phrase wait for that. Neither can the app write a note yet, only read one.
- Exchange names are only as good as the list in `src/core/senders.ts`. Each is checked on Basescan, but Coinbase withdrawals on Base mostly come from addresses without a public name, so most won't say "From a Coinbase address". An imported history still matches them.
- A cost entered in CAD can't be shown in USD for a wallet read in USD, because that read has no rates. It shows as unresolved there, and never as the wrong number.
- Only the allowlist in `packages/sdk/src/tokens.ts` gets a position and a price. A transaction that also moves another token is never valued as a swap, because its payment can't be split: what arrived has an unknown cost, and what left has unknown proceeds. Internal ETH isn't seen without traces, so it can't trigger this.
- Market prices need the Pricetag dataset, so reading the raw dataset, only ETH and USDC have a current price, and other tokens show their cost but no value yet.
- The dataset nets per token, then only prices an account's single pair. A split route that nets to one token out and one in gets a price. A token that mostly cancels out (under half of what moved is left) is what a router or pool kept, so it gets no price. Paying with ETH and WETH together makes two pairs, so the other token has no price, though the app still knows what was paid. A pair gets no price either when something off the allowlist moved with it, unless that token netted to zero.
- There are no traces: a WETH `Withdrawal` is only a claim that ETH reached the transaction's sender, because a contract can send it elsewhere or keep a cut. The server settles each claim against the wallet's ETH balance before and after its block (`settleUnwraps`). When that can't say how much arrived, the swap's cost and proceeds stay unknown, even if its other token's balance matches.
- Other internal ETH transfers aren't seen: a smart wallet's ETH from a swap, because a bundler sends its transactions, a swap through a pool that pays out ETH directly, and a bridge deposit's minted ETH (type 126), because `transactions` has no `mint` column. All of these show up as `incomplete`.
- When ETH is `incomplete`, the server reads its balance around each transaction that took a token and gave nothing back. If ETH rose in that block by more than its transactions explain, that transaction's proceeds become unknown, and ETH's check names it. It isn't valued from that ETH, because a stranger's payment in the same block looks the same. That also means a real send landing beside such a payment shows as unknown. A wallet whose ETH matches costs no extra reads.
- Rebasing tokens and internal ETH transfers aren't resolved, only flagged. A flagged position's PnL stays unavailable until they are.
