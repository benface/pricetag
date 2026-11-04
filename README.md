# pricetag
Every transfer gets a price. A Base wallet with real cost and PnL, built on Amp.

This first version is watch-only: paste any Base address to see its holdings, cost and PnL, and click any number to see the legs behind it. There are no keys in it, and it doesn't sign anything.

## Run it

```sh
pnpm install
cp .env.example .env.local   # fill in AMP_QUERY_URL and AMP_QUERY_TOKEN, or leave them empty for the demo wallet
pnpm dev                     # http://localhost:5173
```

`pnpm check` runs the type check, the tests and the build. `pnpm build && pnpm start` serves the built app on http://localhost:8787.

## The Mac app

Patina is a native menu bar app: live total PnL in the bar, holdings, cost and PnL in its popover, and a window where any number clicks through to its legs, price source and transaction. The wallet it shows is only read. The one key it holds is this Mac's spending money, below.

```sh
pnpm mac         # builds the app, opens it, and runs the server until you press Ctrl-C
pnpm mac:build   # only builds it, to macos/build/
pnpm check:mac   # the Swift tests, the app's build, and the shared packages' builds for iOS
pnpm check:keychain  # the real Secure Enclave and Keychain, with a throwaway key, from a signed debug build
pnpm check:anvil     # real signing and sweeps against a local fork of Base, with no real funds. It needs Foundry
```

It reads from the server on http://127.0.0.1:8787, set in Settings, so it runs on whatever the server runs on: with no `.env.local`, that's the demo wallet. It remembers the wallet and method across restarts.

If the menu bar is full, macOS hides new items. Look under the menu bar's "show hidden items" control, or in System Settings > Menu Bar, and drag it out. The window opens at launch either way.

The app never does PnL math and never holds an Amp token. `GET /api/portfolio/<address>?method=average|fifo` returns the portfolio the fold computed, and `GET /api/portfolio/<address>/explain?metric=…&asset=…` or `?tx=…` returns what's behind one number. `test/portfolio.test.ts` writes what they send to files the Swift tests read, so the two can't drift apart without a failure: when a change is on purpose, run it with `UPDATE_FIXTURES=1`.

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

**Use a dedicated RPC for a demo.** `BASE_RPC_URL` in `.env.local` defaults to the public `https://mainnet.base.org`, which allows 25 requests a second per IP and is shared with anything else on your network. A failed `eth_call` stops the whole dataset until its retry succeeds. To avoid that, `amp:start` runs a small relay (`scripts/rpc-throttle.ts`) that holds requests to `BASE_RPC_RATE_LIMIT` a second, 20 by default, and retries 429s. Raise it to whatever a dedicated RPC allows. The relay is the only process that gets `BASE_RPC_URL`, and it never logs it. Never commit a key.

On the public RPC, a fresh start takes about 9 minutes for the default hour of blocks. For a quicker one, use `PRICETAG_HISTORY_BLOCKS=300 pnpm amp:start`, which takes about 2 minutes.

## How it's put together

- `src/core/fold.ts`: `applyLeg(state, leg)`, average cost and FIFO. Pure, BigInt, JSON-safe state and no imports, so it can move into a stateful table.
- `src/core/legs.ts`: nets each transaction per asset and labels each leg's price and cost.
- `src/core/portfolio.ts`: runs the fold and adds up what's known, in the browser for the web app and on the server for the Mac app.
- `src/core/explain.ts`: says how each number is worked out, for both.
- `server/`: the Amp client, the two data sources and the small HTTP server.
- `macos/`: the Mac app.
- `dataset/`: the manifest. `pricetag.json` is generated by `build.ts`, so change the SQL there.

## Rules the numbers follow

- Price and cost are separate. A price is a shared fact labeled `oracle` or `swap`. A cost is this wallet's, labeled `paid` or `unknown`. A swap's cost and proceeds are what actually changed hands, valued on the side with an oracle, preferring USDC. They aren't the oracle price of what was bought or sold.
- `unknown` is never $0. A position with an unknown cost shows "PnL unavailable", totals say what they leave out, and a total with nothing known shows as unavailable.
- Coverage only moves up to the block every table has processed, so a lagging dataset can't skip blocks, and the UI says when it's behind.
- ETH and WETH are one position, so wrapping is never a sale.
- A swap is one token out and one in, with nothing else moving. Anything else keeps its cost and proceeds unknown.
- A swap whose implied price is outside a token's plausible range, or far from its oracle, is rejected. It has no value on either side.

## Known gaps

- Amounts are what moved since the first block read, not full balances. Reconciling against onchain balances is next.
- Only the allowlist in `src/core/tokens.ts` gets a position and a price. A transaction that also moves another token is never valued as a swap, because its payment can't be split: what arrived has an unknown cost, and what left has unknown proceeds. Internal ETH isn't seen without traces, so it can't trigger this.
- Only ETH and USDC have a current price, so other tokens show their cost but no value or unrealized PnL yet.
- A split route has no swap price, because the dataset only prices an account's single pair. If it nets to one token out and one in, what was paid is still known, but the token has no price at that block. Anything messier leaves its legs `unknown`.
- There are no traces: a WETH `Withdrawal` counts as ETH paid to the transaction's sender, and other internal ETH transfers aren't seen. Smart wallets, whose transactions are sent by a bundler, won't get that ETH.
- Gas is L2 gas only, because Amp's data has no L1 data fee.
