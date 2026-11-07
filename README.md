# pricetag
Every transfer gets a price. A Base wallet with real cost and PnL, built on Amp.

Paste any Base address to see its holdings, cost and PnL, and click any number to see the activity behind it.
The price of every transfer comes from one Amp derived dataset on Base, with no fork, validators or contracts.
What something cost is personal, so each app works it out from those prices.
There are no keys in the web app.
A hardware wallet can connect to it to send, and signs everything on its own screen: see **[HARDWARE-WALLETS.md](HARDWARE-WALLETS.md)**.

| Doc | For |
| --- | --- |
| [docs/NUMBERS.md](docs/NUMBERS.md) | How prices, rates, costs, proofs and tax reports are worked out, and the known gaps |
| [docs/MAC-APP.md](docs/MAC-APP.md) | The Mac app in detail: its API, spending money, buying, sending, the browser extension and the Security page |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Running the dataset locally, forking a pricing rule, and hosting the shared server |
| [HARDWARE-WALLETS.md](HARDWARE-WALLETS.md) | What a device signs, and the checklist for a real one |
| [macos/HOT-WALLET-SECURITY.md](macos/HOT-WALLET-SECURITY.md) | What the hot wallet protects against, and what it doesn't |
| [macos/TESTING.md](macos/TESTING.md) | Testing and screenshotting the Mac app without interrupting whoever's using the Mac |
| [packages/sdk/README.md](packages/sdk/README.md) | Building on the dataset with `@pricetag/sdk` or plain SQL |
| [AMP-ASSESSMENT.md](AMP-ASSESSMENT.md) | How Amp held up, a snapshot from November 6, 2026 |

## Run it

```sh
pnpm install
cp .env.example .env.local   # fill in AMP_QUERY_URL and AMP_QUERY_TOKEN, or leave them empty for the demo wallet
pnpm dev                     # http://localhost:5173
```

`pnpm check` runs the type check, the tests and the build.
`pnpm build && pnpm start` serves the built app on http://localhost:8787.
To run the whole dataset on your Mac with no token, see [Run the dataset locally](docs/OPERATIONS.md#run-the-dataset-locally).

## The Mac app

Patina is a native menu bar app.

- **The menu bar** shows live total PnL, and its popover the holdings, cost and PnL.
- **The window** clicks through from any number to its activity, price source and transaction.
- **Wallets:** the name in the toolbar switches between your wallets and the ones you watch (⌘L, then paste an address to add one). A watched wallet is only read.
- **All Yours** adds up every wallet of yours, and moves between them aren't gains, losses or money put in.
- **No PnL math in the app:** it reads what the server folded, from http://127.0.0.1:8787 or a hosted server, and never holds an Amp token.
- **Live:** the numbers move with each new block, and a reorg is seen when it happens.
- **Spending money** is a capped hot wallet on this Mac, with no recovery phrase, $50 by default and $100 at most. It's an unreviewed build, for small funds only.
- **The key** comes from `SecRandomCopyBytes`, is wrapped by the Secure Enclave, and stays in a device-only Keychain item. It can't be restored or exported.
- **Savings** are hardware wallets. Anything above the cap sweeps to one by itself while the app runs.
- **Topping up** from savings goes through the hardware wallet flow in your browser.
- **Buying** opens Coinbase's page for this wallet's own address, and what you paid becomes the cost of what arrived.
- **Sending** goes to any address, after Touch ID, for ETH and the tokens the app tracks.
- **Publishing a cost** writes what you paid onchain, as a zero-value send to yourself, after warning that it's public for good.
- **Websites** can use spending money through the browser extension in `extension/`, with every approval in the app's own window. Savings can't be reached from there.
- **The alarm** goes off if Amp and the chain say this wallet did something the app didn't sign. It stops top-ups and offers to sweep what's left and replace the key.

```sh
pnpm mac              # builds the app, opens it, and runs the server until you press Ctrl-C
pnpm mac:build        # only builds it, to macos/build/
pnpm check:mac        # the Swift queue's tests, the Swift tests, the app's build, and the shared packages' builds for iOS
pnpm check:mac:quick  # only the Swift tests, for while you're working
pnpm check:keychain   # the real Secure Enclave and Keychain, with a throwaway key, from a signed debug build
pnpm check:anvil      # real signing and sweeps against a local fork of Base, with no real funds. It needs Foundry
pnpm check:extension  # the browser extension on a real site, through to a local fork. It needs Foundry and a Chromium that loads extensions
pnpm check:tax-answer # a tax report's buttons open the right wallet's questions and come back, in a headless Chromium
pnpm mac:shot         # screenshots from fixtures, with no window you'd see
```

Holding a key needs a provisioned build, which `pnpm mac` makes when the team pinned in `macos/run.sh` is signed in to Xcode.
Without that, the app says it can't hold a key, and everything else works.
If the menu bar is full, macOS hides new items: look under its "show hidden items" control, or in System Settings > Menu Bar.
[docs/MAC-APP.md](docs/MAC-APP.md) has the rest.

## How it's put together

- `packages/sdk/`: `@pricetag/sdk`, what other apps can build on too. [Its quickstart](packages/sdk/README.md) covers the tables, the API and plain SQL.
  - `src/fold.ts`: `applyLeg(state, leg)`, average cost and FIFO. Pure, BigInt, JSON-safe state and no imports, so it can move into a stateful table.
  - `src/legs.ts`: nets each transaction per asset and labels each leg's price and cost.
  - `src/portfolio.ts`: runs the fold and adds up what's known.
  - `src/reconcile.ts`: compares what a position's legs add up to with what the chain says it holds.
  - `src/market.ts` and `src/token-market.ts`: a token's `market` price from its recent trades, for listed tokens and for any token.
  - `src/hold.ts`: what a wallet would have made by holding ETH instead.
  - `src/approvals.ts`: the approvals a wallet gave, and how to read what each still allows.
  - `src/live.ts`: follows the chain and its reorgs, from Amp's stream or by polling.
  - `src/currency.ts` and `src/rates.ts`: converts a wallet out of USD at each transaction's rate, before the fold.
  - `src/amp.ts`, `src/dataset.ts`, `src/client.ts`: the Amp client and the reads from the dataset. The browser imports `@pricetag/sdk/core`, which leaves these out.
  - `src/wallets.ts`, `src/balances.ts`, `src/receipts.ts`: what a wallet read adds to its legs: opening and closing balances and L1 fees. The app's server uses these through `@pricetag/sdk/internal`.
  - `src/format.ts`: how amounts and money print.
- `src/`: the web app. `src/core/api.ts` is what the server sends its clients, `src/core/explain.ts` says how each number is worked out, for the web and Mac apps, and `src/core/fixtures.ts` is the demo wallet.
- `server/`: the raw data source, exchange rates, the block check, and the small HTTP server.
- `macos/`: the Mac app.
  - `PricetagKit/`: everything that isn't Mac-specific, like the API models, the live feed, formatting and shared views. It also builds for iOS.
  - `HotWalletKit/`: the hot wallet, which also builds for iOS. `KeyVault` is the only code that touches a key.
  - `App/`: the menu bar item, popover, window and settings.
  - `Config/App.xcconfig`: the app's name, in one place.
- `extension/`: the Chromium extension that lets sites use spending money.
- `dataset/`: the manifests, all generated by `build.ts`, so change the SQL there.
  - `pricetag.json`: the main dataset, and `cautious-eth.json`, the fork with another pricing rule.
  - `feeds.json`, `rates.json` and `tokens.json`: the other tokens' feeds, exchange rates and any token's trades, each its own small dataset.
  - `local.ts`: a local Amp's first prices, read from the feeds' contracts at its start block.
