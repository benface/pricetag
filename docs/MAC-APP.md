# The Mac app in detail

What the [README](../README.md) summarizes, for whoever changes the Mac app or the browser extension.

## Reading

It reads from the server on http://127.0.0.1:8787, set in Settings, so it runs on whatever the server runs on: with no `.env.local`, that's the demo wallet.
A build can read a [hosted one](OPERATIONS.md#hosting) instead.
It remembers the wallet, method and currency across restarts.

If the menu bar is full, macOS hides new items.
Look under the menu bar's "show hidden items" control, or in System Settings > Menu Bar, and drag it out.
The window opens at launch either way.

With two or more wallets of yours, **All Yours** at the top of the wallet button adds them up: value, PnL, holdings, the chart and transactions, saying which wallet each transaction and each unknown is in.
Moves between your wallets aren't gains, losses or money put in, and their costs carry over as `inherited`, while their network fees still count.
Watched wallets are never in it.
A wallet that's slow to read, or whose read fails, doesn't hold up the rest, and its last balance isn't counted, since it could be from before a move: it's listed as still reading or failed, with the numbers marked as updating, until it's in.
Every wallet is read at the same block, so a move is never counted in both.

The app never does PnL math and never holds an Amp token.
`GET /api/portfolio/<address>?method=average|fifo&currency=USD|CAD|…` returns the portfolio the fold computed, `GET /api/portfolio/<address>/explain?metric=…&asset=…` or `?tx=…` returns what's behind one number (`metric=hold` for the comparison with holding ETH), `POST /api/portfolio/all` with `linked` set to every wallet of yours returns them as one (its `/explain`, `/preview`, `/export` and `/last` work the same way), and `GET /api/portfolio/<address>/proof?leg=…` and `/verify?leg=…` return what's behind one price and the check of its block.
With a [forked pricing rule](OPERATIONS.md#forking-a-pricing-rule), `GET /api/rules` lists the rules, `&rule=<id>` picks one, and `GET /api/portfolio/<address>/compare` returns a wallet by both.
`test/portfolio.test.ts` writes what they send to files the Swift tests read, so the two can't drift apart without a failure: when a change is on purpose, run it with `UPDATE_FIXTURES=1`.

The numbers move on their own: `GET /api/events` says when there's a new block, and the app and the web page read again when it does.
It comes from Amp's stream, so a reorg is seen when it happens, and the server polls Amp when the stream isn't working.
The Mac app also polls every 2 s when it can't reach the events, and every 15 s even when it can, in case they've quietly stopped.

## Spending money and savings

The Mac app has a capped hot wallet, this Mac's "spending money", for everyday use with no recovery phrase.
Anything above the cap goes to a hardware wallet, your "savings", by itself while the app runs.
It's a wallet like any other: choose it in the wallet button, open it from the popover or with ⌘4, or create it from the first screen, which then shows it.
If it's showing, the window moves to the new address when its key is replaced, and to your next wallet when it's deleted, or the first screen if there's no other.
It's an unreviewed build, for small funds only.
**[HOT-WALLET-SECURITY.md](../macos/HOT-WALLET-SECURITY.md)** says what it protects against and what it doesn't.

- **The key** comes from `SecRandomCopyBytes`, is wrapped by the Secure Enclave, and stays in a device-only Keychain item.
  It can't be restored or exported: lose the Mac and you lose what's on it, up to the cap.
- **Adding a savings wallet** is guided, with steps for a Ledger or a Keystone, and pasting for anything else.
  A Ledger goes through your browser and a Keystone through the Mac's camera.
  See [the hardware wallet notes](../HARDWARE-WALLETS.md).
- **The cap** is yours to set, $50 by default and $100 at most, or $25 at most until you add a savings wallet.
  A plain address can't enforce a cap, so it's what triggers a sweep and not a hard limit.
  It's kept in USD whatever the main currency is, so what's swept and signed never depends on a rate, and Spending Money's page shows and rounds it in the main currency.
- **Sweeps** send whatever is above the cap, and realized gains unless you turn that off, to your chosen savings wallet.
  They only move tokens with a trusted price, they keep enough ETH for gas, and they skip dust.
  Costs carry over as `inherited`, because the app tells the server which wallets are yours: `GET /api/portfolio/<address>?linked=<addresses>`.
- **Topping up** comes from a savings wallet, through the [hardware wallet flow](../HARDWARE-WALLETS.md) in your browser, which this opens with the amount and address filled in.
  The steps to do it by hand on the device are still there.
- **Buying** starts from Buy, in the toolbar, the Wallet menu or the menu bar, and opens the provider's page, Coinbase for now, for this wallet's own address.
  Everything lands here, and what's above the cap sweeps to your savings, so the amount can be anything the provider allows.
  The sheet says how much ends up where.
  It asks for a savings wallet first, because the provider's page can raise the amount, so nothing here could keep a purchase under the cap.
  It won't buy a token it couldn't sweep for lack of ETH, and the page can only sell the token chosen here.
  The order is followed from there, across restarts: however long it's been, whatever's unresolved is read again when the app starts or comes back, so a purchase paid for while it was closed still gets its cost.
  When it's delivered, what you paid, fees included, becomes the cost of what arrived, as "Bought on Coinbase", with nothing asked, and it follows the sweep.
  That takes a purchase made with money, so an order paid from crypto you already held has no cost here, and an exact match of transaction, token and amount.
  Anything else stays unknown and asks as usual.
  ETH in a batched payout has no row to match, so it's found by the block its transaction landed in.
  You type the amount in the main currency, and the page starts from that number when Coinbase can (`presetFiatAmount`, which its docs limit to USD, CAD, GBP and EUR).
  In any other currency, it starts from about that much of the token, and the sheet says so.
  Coinbase's own price and its fees decide what's charged, and that's what's recorded, in what it was charged in.
  Without a current rate, you type in US dollars, as the sheet says, and the page starts from a token amount.
  It needs a key in the server's environment (`.env.example`), which never leaves the server, and nothing here signs.
  Only `server/coinbase.ts` knows the provider's API, behind the interface in `server/onramp.ts`.
- **Buying on the web** starts from Buy, in the header, and only ever lands in a wallet connected in this browser: its address comes from the wallet's answer, nothing typed or looked up can take its place, and it's asked again just before the page opens.
  Hardware wallets never connect to a site, so this isn't for them.
  Purchases are kept in this browser and followed across reloads, the way the Mac follows them, and what an order says goes in the book here.
  Its cost then reads the same in the explanations, the CSV and the proof, which says where it came from.
  The book isn't sent with a wallet's read, so the currencies it holds go along as `paid=`, which is how a purchase paid in EUR reads in CAD.
- **Sending** goes to any address, with Touch ID asking as soon as you press Send, for ETH and the tokens the app tracks.
  A new address asks "Is this yours?", and the answer stays on this Mac with the rest.
  The hot wallet and your savings wallets never ask: they're always linked, for any wallet that's yours, whatever you've answered.
  A wallet you're only watching doesn't take costs from them, or from a wallet you've answered is yours.
- **Publishing a cost** writes what you paid onchain, as a zero-value send to itself that the server reads as `self-reported`.
  Answering a question offers it when the answer covers everything of one token that arrived in one transaction in this wallet, and warns first, because it publicly ties the amount to the wallet for good.
  It's always in USD.
  For a savings wallet, it opens the [hardware wallet flow](../HARDWARE-WALLETS.md) in your browser, because that takes its device.
- **The alarm** compares what Amp and the chain say this wallet did with what the app signed.
  If they differ, it alerts loudly, stops top-ups, and offers to sweep what's left and replace the key.

Holding a key needs a provisioned build, which `pnpm mac` makes when the team pinned in `macos/run.sh` is signed in to Xcode.
Without that, the app says it can't hold a key, and everything else works.
It reads balances from `https://mainnet.base.org` directly, set at the bottom of Spending Money's page, so sweeps don't depend on the server.
Debug builds have their own wallet.

## Using it on websites

`extension/` is a Chromium extension that lets websites use this Mac's spending money, like any browser wallet.
The key stays in the app, and every approval happens in the app's own window, showing the site and what's being signed.
Sites can only connect to spending money, on Base.
Savings can't be reached from here at all.

1. Run `pnpm mac` once, which tells your browsers (Chrome, Brave, Edge, Arc, Dia) where the app is.
2. In `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and pick the `extension/` folder. It runs exactly as it is, with no build step.
3. Pick **Patina** on the site. The app has to be open.

The extension's button shows what's there, with the address to copy, and has a **Top Up…** button, which opens the app's top-up sheet, and from there the [hardware wallet flow](../HARDWARE-WALLETS.md).
It opens without waiting for the app, and fills in when the app answers.
**[HOT-WALLET-SECURITY.md](../macos/HOT-WALLET-SECURITY.md)** says what this protects against and what it doesn't.
Pages talk to the extension, which talks to a small host program inside the app bundle (`macos/BridgeHost`), which relays to a socket in the app (`macos/HotWalletKit/Sources/HotWalletKit/Sites`).

## The Security page

The Mac app's Security page (⌘5) has a short checklist, each item checked where the app can know it, and every token approval the wallet showing has given, with a way to revoke them.

- **Finding them.** `GET /api/approvals/<address>` reads every approval event the wallet gave: ERC-20 `Approval`, NFT `ApprovalForAll`, and Permit2's `Approval` and `Permit`.
  They come from the dataset's `approvals` table, which holds all of them from its start block, so one wallet's are one quick read.
  A dataset version without that table, or no dataset at all, reads the same logs from the raw Base dataset, which took about 25 s for a day of blocks on staging, and what's been read is kept so the next read only reads new blocks.
- **What each still allows** is read from its contract at the head through Amp's `eth_call`, because spending and revoking change it.
  Tracked tokens and Permit2 share one `aggregate3`.
  Any other contract gets an `eth_call` of its own, because Multicall3 runs each call with CALL, so a hostile one in the batch could change what a later one answers.
  One that doesn't answer is counted, and "no unlimited approvals" stays unchecked until there are none, as it does when a refresh fails and an older list is showing.
  Only what still allows something is listed.
  Every tracked token is also checked with well-known apps (Uniswap's routers and Permit2, Aerodrome, 0x, 1inch, Odos, CoW Swap), so an approval to one of them shows however old it is.
  An approval to another app from before the history starts isn't found, and the page says so.
- **Signed here, not used yet.** Before a site gets a permit from Spending Money, the app writes down what it read from it (site, token, spender, amount, deadline, nonce), never the signature.
  The page lists each until it expires or the chain proves it can't be used: EIP-2612's `nonces`, Permit2's `allowance` nonce, or its `nonceBitmap`, read from the node.
  Nothing is marked used from anything else, and a token off the allowlist is never asked, so it stays listed until it expires.
  Each says what limits it: revoking Permit2's approval for a token, only while it stays revoked, or for EIP-2612, only moving the token, which protects what's moved but doesn't cancel the signature, because it doesn't depend on the balance, so tokens that come back to that wallet can still be taken.
  A signature that looks like a permit but can't be read stays as a line saying so, without an end date to go by.
- **What can't be listed.** A permit signed anywhere else, or here before the app kept track, isn't onchain until it's used.
  The page says that, and how to limit it: revoking Permit2's approval for a token only stops its signatures while it stays revoked, and moving the token is the only sure way to protect it, though that doesn't cancel the signature, so tokens that come back to that wallet can still be taken.
- **Revoking** is only for Spending Money, through the same review and Touch ID as any send, with its fee read first.
  Each token is one transaction (`approve(spender, 0)`), and everything Permit2 holds is one `lockdown`, up to 20 at once.
  Only a tracked token or Permit2 is ever called, so an untracked token's or an NFT collection's approval is listed with a pointer to revoke it elsewhere.
  A savings wallet's approvals are from before Patina, because its flow only signs plain transfers, so the page points to revoking them with the device in a browser wallet.
  A watched wallet's are only shown.
- **This Mac.** A login password is what `LAContext` says, and FileVault is what `fdesetup isactive` says.
  When it can't run, which the sandbox may prevent, it says it couldn't check, never that it's on.
