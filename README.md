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
pnpm check:extension # the browser extension on a real site, through to a local fork, with no real funds. It needs Foundry and a Chromium that can load extensions
```

It reads from the server on http://127.0.0.1:8787, set in Settings, so it runs on whatever the server runs on: with no `.env.local`, that's the demo wallet. It remembers the wallet, method and currency across restarts.

If the menu bar is full, macOS hides new items. Look under the menu bar's "show hidden items" control, or in System Settings > Menu Bar, and drag it out. The window opens at launch either way.

The app never does PnL math and never holds an Amp token. `GET /api/portfolio/<address>?method=average|fifo&currency=USD|CAD` returns the portfolio the fold computed, and `GET /api/portfolio/<address>/explain?metric=…&asset=…` or `?tx=…` returns what's behind one number. `test/portfolio.test.ts` writes what they send to files the Swift tests read, so the two can't drift apart without a failure: when a change is on purpose, run it with `UPDATE_FIXTURES=1`.

- `macos/PricetagKit/`: everything that isn't Mac-specific, like the API models, the live feed, formatting and shared views. It also builds for iOS.
- `macos/HotWalletKit/`: the hot wallet, which also builds for iOS. `KeyVault` is the only code that touches a key, and `HotWalletKit` decides what to do and can only ask it to sign.
- `macos/App/`: the menu bar item, popover, window and settings.
- `macos/Config/App.xcconfig`: the app's name, in one place.

### Spending money and savings

The Mac app has a capped hot wallet, this Mac's "spending money", for everyday use with no recovery phrase. Anything above the cap goes to a hardware wallet, your "savings", by itself while the app runs. Open it from the popover or with ⇧⌘M. It's an unreviewed hackathon build, for small funds only. **[HOT-WALLET-SECURITY.md](macos/HOT-WALLET-SECURITY.md)** says what it protects against and what it doesn't.

- **The key** comes from `SecRandomCopyBytes`, is wrapped by the Secure Enclave, and stays in a device-only Keychain item. It can't be restored or exported: lose the Mac and you lose what's on it, up to the cap.
- **The cap** is yours to set, $50 by default and $100 at most, or $25 at most until you add a savings wallet. A plain address can't enforce a cap, so it's what triggers a sweep and not a hard limit.
- **Sweeps** send whatever is above the cap, and realized gains unless you turn that off, to your chosen savings wallet. They only move tokens with a trusted price, they keep enough ETH for gas, and they skip dust. Costs carry over as `inherited`, because the app tells the server which wallets are yours: `GET /api/portfolio/<address>?linked=<addresses>`.
- **The alarm** compares what Amp and the chain say this wallet did with what the app signed. If they differ, it alerts loudly, stops top-ups, and offers to sweep what's left and replace the key.

Holding a key needs a provisioned build, which `pnpm mac` makes when the team pinned in `macos/run.sh` is signed in to Xcode. Without that, the app says it can't hold a key, and everything else works. It reads balances from `https://mainnet.base.org` directly, set in Settings, so sweeps don't depend on the server. Debug builds have their own wallet.

### Using it on websites

`extension/` is a Chromium extension that lets websites use this Mac's spending money, like any browser wallet. The key stays in the app, and every approval happens in the app's own window, showing the site and what's being signed. Sites can only connect to spending money, on Base. Savings can't be reached from here at all.

1. Run `pnpm mac` once, which tells your browsers (Chrome, Brave, Edge, Arc, Dia) where the app is.
2. In `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and pick the `extension/` folder. It runs exactly as it is, with no build step.
3. Pick **Patina** on the site. The app has to be open.

The extension's button shows what's there and has a **Top up** button, which opens the app's top-up flow. **[HOT-WALLET-SECURITY.md](macos/HOT-WALLET-SECURITY.md)** says what this protects against and what it doesn't. Pages talk to the extension, which talks to a small host program inside the app bundle (`macos/BridgeHost`), which relays to a socket in the app (`macos/HotWalletKit/Sources/HotWalletKit/Sites`).

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

## How it's put together

- `packages/sdk/`: `@pricetag/sdk`, what other apps can build on too. [Its quickstart](packages/sdk/README.md) covers the tables, the API and plain SQL.
  - `src/fold.ts`: `applyLeg(state, leg)`, average cost and FIFO. Pure, BigInt, JSON-safe state and no imports, so it can move into a stateful table.
  - `src/legs.ts`: nets each transaction per asset and labels each leg's price and cost.
  - `src/portfolio.ts`: runs the fold and adds up what's known, in the browser for the web app and on the server for the Mac app.
  - `src/reconcile.ts`: compares what a position's legs add up to with what the chain says it holds.
  - `src/amp.ts`, `src/dataset.ts`, `src/client.ts`: the Amp client and the reads from the dataset. The browser imports `@pricetag/sdk/core`, which leaves these out.
- `src/`: the web app. `src/core/api.ts` is what the server sends its clients, `src/core/currency.ts` converts a wallet out of USD at each transaction's rate, `src/core/explain.ts` says how each number is worked out, for the web and Mac apps, and `src/core/fixtures.ts` is the demo wallet.
- `server/`: the raw data source, the balance and receipt readers, and the small HTTP server.
- `macos/`: the Mac app.
- `dataset/`: the manifest. `pricetag.json` is generated by `build.ts`, so change the SQL there.

## Main currency

Both apps show every value in the chosen currency, USD or CAD, and remember the choice: the Mac app in Settings, and the web app in its header. The dataset's base stays USD. `src/core/currency.ts` is the one place that converts, and both apps go through it.

- **Each amount converts at the rate when it happened.** A cost or sale uses the rate at its transaction's block, and a current value uses the current rate. Conversion runs before the fold, so a gain in CAD is proceeds in CAD minus cost in CAD, and it includes what the exchange rate did in between.
- **Rates come from Chainlink's feed on Base**, read at the block with `eth_call`, so a transaction minutes old already has its rate. Clicking through a number names the source, the rate, and the amount in USD.
- **A missing rate is never filled in.** That amount is unavailable, whatever depends on it says so, and no other day's rate stands in. A feed that hasn't updated in 3 days counts as missing, since forex markets close for only about 2.

To add a currency, add its Chainlink feed to `CURRENCIES` in `src/core/currency.ts` and a case to `macos/PricetagKit/Sources/PricetagKit/Currency.swift`. Base has feeds for EUR, GBP, AUD, CHF, SGD and others.

## Rules the numbers follow

- Price and cost are separate. A price is a shared fact labeled `oracle` or `swap`. A cost is this wallet's, labeled `paid` or `unknown`. A swap's cost and proceeds are what actually changed hands, valued on the side with an oracle, preferring USDC. They aren't the oracle price of what was bought or sold.
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

## Known gaps

- Only the allowlist in `packages/sdk/src/tokens.ts` gets a position and a price. A transaction that also moves another token is never valued as a swap, because its payment can't be split: what arrived has an unknown cost, and what left has unknown proceeds. Internal ETH isn't seen without traces, so it can't trigger this.
- Only ETH and USDC have a current price, so other tokens show their cost but no value or unrealized PnL yet.
- The dataset nets per token, then only prices an account's single pair. A split route that nets to one token out and one in gets a price. A token that mostly cancels out (under half of what moved is left) is what a router or pool kept, so it gets no price. Paying with ETH and WETH together makes two pairs, so the other token has no price, though the app still knows what was paid. A pair gets no price either when something off the allowlist moved with it, unless that token netted to zero.
- There are no traces: a WETH `Withdrawal` counts as ETH paid to the transaction's sender, and other internal ETH transfers aren't seen. Smart wallets, whose transactions are sent by a bundler, won't get that ETH.
- Rebasing tokens and internal ETH transfers aren't resolved, only flagged. A flagged position's PnL stays unavailable until they are.
