# Operations

Running the dataset yourself, forking a pricing rule, and hosting the shared server.
For what the numbers mean, see [NUMBERS.md](NUMBERS.md).

## Run the dataset locally

This runs the whole dataset on your Mac, with no token. It needs Docker running and Amp installed with `ampup`.

```sh
pnpm amp:start   # a fresh Amp from a recent Base block, and waits for chain head
pnpm dev
pnpm amp:stop    # stops it and deletes its data
```

`amp:start` runs `ampd solo` on localhost with a throwaway Docker Postgres, then deploys a raw Base dataset and the Pricetag dataset (`dataset/pricetag.json`) from `PRICETAG_HISTORY_BLOCKS` before the head, 1,800 blocks by default.
That's 6 minutes of Base's 200 ms blocks, because each block costs the same requests however long it took.
Every start computes a new start block and begins empty, because `amp:stop` deletes everything.
Only one local Amp can run at a time, because its ports are fixed.

It adds a marked block to the end of `.env.local` that points the app at the local Amp and sets `PRICETAG_START_BLOCK`.
That block overrides your own values while Amp runs, and `amp:stop` removes it, so nothing else changes.
To read from a hosted Amp instead, don't start the local one, and set `AMP_QUERY_URL`, `AMP_QUERY_TOKEN`, `PRICETAG_DATASET` and `PRICETAG_START_BLOCK` yourself.

**Use a dedicated RPC for anything that matters.** `BASE_RPC_URL` in `.env.local` defaults to the public `https://mainnet.base.org`, which allows 25 requests a second per IP and is shared with anything else on your network.
A failed call stops the raw dataset, and everything built on it, until its retry succeeds.
To avoid that, `amp:start` runs a small relay (`scripts/rpc-throttle.ts`) that holds requests to 60% of `BASE_RPC_RATE_LIMIT` a second, and retries 429s.
That setting is what the RPC allows in total, 25 by default, so raise it to whatever a dedicated RPC allows.
Of Amp's processes, only the relay gets `BASE_RPC_URL`.
The app's server also uses it, for L1 fees, with a little under the other 40%: about 9 a second by default, shared by every wallet being read, which a wallet sending that many transactions a second never catches up with, so its ETH stays not checked.
Neither ever logs it.
Never commit a key.

**On Base's 200 ms blocks, following the head takes about 10 requests a second,** all for the raw dataset, because prices come from logs.
Measured with this script on Base Sepolia, which already has those blocks, with the relay at 20 requests a second to `sepolia.base.org`:

| Start | Time to chain head | After that |
| --- | --- | --- |
| Default, 1,800 blocks | About 7 minutes for the raw dataset, `legs` and `reference_prices` | 3–11 blocks behind (about 2 s at most) for 6 minutes, with no job errors |
| `PRICETAG_HISTORY_BLOCKS=300` | About 2 minutes | 5 blocks behind |

Mainnet's RPC and blocks may differ.

The relay gets 15 a second by default, so L1 fees fit under the public RPC's limit.
That leaves about 5 for catching up instead of 10, so expect a default start to take up to about twice as long.
That's from the arithmetic, and it hasn't been measured.

**A local Amp's first prices come from `eth_call`.** It only has logs from its start block, and USDC/USD's last update can be up to a day older.
So `amp:start` reads each feed's latest round from its contract at the start block (`dataset/local.ts`), and those stand in as updates, with an all-zero transaction, for as long as the real ones would have lasted.
If that read fails, `amp:start` stops before the backfill.
Proof says a price came from the contract, and Verify doesn't claim to cover it.
It covers the price from the first real log onward.

**To test reorgs,** `scripts/reorg-local.sh [depth...]` runs Amp on an Anvil fork of Base instead, with a block every 200 ms.
For each depth, it puts a transfer to a watched wallet on the chain, then replaces at least that many blocks with a longer chain that has another transfer.
It times how long Amp's tables, its stream and two SDK wallets, one streaming and one polling, take to match the new chain, and logs one JSON line per event.
Anvil signs with its own accounts, so no key is involved.
It uses its own ports and a temporary folder, and removes everything when it exits, so it can run beside `amp:start`.
Results from November 5 are in [AMP-ASSESSMENT.md](../AMP-ASSESSMENT.md).

## Forking a pricing rule

A pricing rule is a dataset version, and the server picks one per request with Amp's `amp-alias` header.
The SQL never changes, and the app has no code for any rule.
Set these and both apps show a switch, in the Mac app's Settings and above the web app's numbers, with each rule's dataset and manifest hash, and a side-by-side comparison of a wallet.
The comparison uses one set of facts at one block for both rules: the same transactions, balances, fees and exchange rates, with only prices from each.
If it can't establish that, it says so and shows no numbers.
Each rule's market prices are read at that block, and a token only one rule has a market price for is left out on both sides, so the two totals still add up the same things.

```sh
PRICETAG_DATASET=benface/pricetag@0.3.0
PRICETAG_DATASET_HASH=72a4cadfeaf0631b368a5b686c1b4883a71a0a40297a43675dfb81bd2863f30f
PRICETAG_FORK_DATASET=benface/pricetag_cautious@0.3.0
PRICETAG_FORK_HASH=639edea8dbc2b9a51f633af97a408c25f51a87a4e0a124065fcb46a56441d763
```

Queries are pinned to those hashes, Proof's included, so a hash on screen is what was read, and a wrong one fails instead of showing other numbers.
With no fork set, nothing changes: there's no switch and no header, and `PRICETAG_DATASET_HASH` isn't used.

The fork here is `dataset/cautious-eth.json`, from `cautiousEthTablesSql` in `dataset/build.ts`.
Its one rule is that ETH counts at 1% below the Chainlink feed, so a token priced against ETH follows it, by its trades or by a feed in ETH like wstETH's.
It only materializes the tables a rule decides, `reference_prices` and `priced_legs`, and reads everything else from the dataset it forks.
So it starts from the same block, and can only differ by the rule.
The transactions always come from the first dataset.

To change the rule, edit that function, then build, register and deploy it under a new tag, and update the hash:

```sh
FORK_OF=benface/pricetag@0.3.0 AMP_ADMIN_URL=… AMP_ADMIN_TOKEN=… node dataset/build.ts --fork 53515446
ampctl dataset register benface/pricetag_cautious dataset/cautious-eth.json --tag 0.3.1
```

Deploy with `POST /controller/materialized-datasets/benface/pricetag_cautious/versions/0.3.1` and `{}`, because `ampctl dataset deploy` from v0.0.42 fails on staging.
List the versions first and use a free tag, because registering a tag that exists moves it without saying so.

**Replacing the dataset it forks means replacing the fork too.** The fork reads the job of the version it names, so stopping that job stops the fork.
Deploy a fork of the new version before stopping the old one, then change all four lines together.

**Check the serving jobs right after stopping one.** Stopping a job with JS on a worker can panic the other jobs there and leave them `FATAL` (WORK-574), so a replacement can kill what's still serving.
`scripts/job-watch.ts` restarts the versions `.env.local` names within about 15 s, but not a new version until it's named there.

**The server needs a `legs` with `counterparty`,** which `benface/pricetag@0.3.0` is the first to have.
An older version fails every wallet read.

**A new dataset name needs a new manifest hash.** Amp finds a dataset's active tables by hash and table name, not by dataset name, so one manifest under two names can read and write the same tables.
So the same manifest under a new name needs a change, even a one-line SQL comment.
A manifest with new SQL already has its own hash.

`pnpm amp:start` turns the fork off while it runs, because it isn't registered on a local Amp.
Hot wallet decisions and tax reports always read by the default rule, whatever the switch says.

## Hosting

The Mac app reads from a server because the server holds what the app can't ship: the Amp token and the Coinbase key.
Locally that's `pnpm mac`'s.
A shared one is the same server with `PRICETAG_HOSTED=1`, which turns on everything it needs at once:

- **Invites.** Every `/api/` request needs `Authorization: Bearer <invite>`.
  `pnpm invite <name>` makes one and prints the line for `PRICETAG_INVITES`, which holds only its SHA-256.
  Remove that line to take it back.
  It won't start without one, and neither will any server with a `HOST` other machines can reach.
- **Limits.** Per invite: requests a minute, live streams at once, and Coinbase checkouts an hour.
  And checkouts a day for everyone together, so one invite can't use up the account.
  Past one, it answers 429 with `Retry-After`, and the apps wait that long, say so and carry on by themselves.
  A checkout only counts once it's valid and about to reach Coinbase.
  An ordinary session is one read a block, so about 30 requests a minute at most.
  One request can name at most 20 other wallets, counting its linked wallets, its answers and every preview, and it's refused before anything is read.
- **Amp queries take turns.** Each invite's run one at a time, `PRICETAG_AMP_LANES` of them at once, 3 by default, and the head's don't wait for them.
  So someone's very busy wallet only slows them down.
  A local server runs 3 queries at once, whoever they're for.
  `pnpm load:hosted` shows how this holds up with several Macs and one very busy wallet, with Amp replaced by recorded timings.
- **Logs** are one JSON object a line, with addresses and transaction hashes (as `0x…`, as SQL's `X'…'`, or as any long run of hex), URLs, bearer tokens and the env's secrets taken out.
  It replaces `console` itself, so the SDK's lines go through it too.
  It logs no requests.
- **`GET /healthz`** answers without an invite, with whether Amp and buying are set up and nothing else.
  It says 503 once a shutdown starts.
- **SIGTERM** stops taking requests, ends the live streams so clients reconnect, and waits up to `PRICETAG_DRAIN_MS` for the rest.
- **Wallets that fit.** A wallet with more history than fits in the heap gets a 413 saying so, after loading no more than the limit, and never partial numbers: about 10 KB a row, so about 44,000 rows on the hosted 512 MB heap, and about 420,000 on a Mac.
  That budget is shared, so kept wallets give way, first reads wait for room before loading anything, and a read that still doesn't fit gets a 429.
  Oldest first can stop much sooner, at about 6,100 legs hosted when nothing ever leaves, because every lot it holds is held again at every step.
  Wallets added up together share a limit too, tighter the more of them there are: about 39,000 legs for 2 wallets and 14,000 for 21, hosted.
  `PRICETAG_MAX_WALLET_ROWS` overrides the row limit.
- **The client's address** goes to Coinbase only from the header in `PRICETAG_CLIENT_IP_HEADER`, which has to be one the host overwrites, like `fly-client-ip`.
  It won't start without one, because Coinbase would otherwise be told the host's proxy's address.
  `x-forwarded-for` and the like stop the server from starting, because a client can write them.
  A private address, or a list, sends nothing, which beats a wrong address.
- **API only.** It doesn't serve the web app, so Top Up and Publish from a device still need one on the Mac.
  `PRICETAG_SERVE_APP=1` serves it anyway.

`Dockerfile` builds it, and `fly.toml` runs it on Fly.io, on **one machine**: the wallet reads, the limits and the day's checkouts are counted in its memory, so a second one would split them.
Fly starts two on a first deploy unless told otherwise, so deploy with `fly deploy --ha=false`, then check that `fly machine list` shows one.
It's live at `patina-server.fly.dev`, with the secrets in `fly secrets`.
The app reads it when its build names it: `PATINA_SERVER_HOST` in `macos/Config/App.xcconfig`, which is empty, so `pnpm mac` reads the Mac's own server.
The tester build sets it to `PATINA_HOSTED_SERVER_HOST`, next to it.
Its invite goes in Settings.
It's saved for that server alone, so it never goes to another one, and it's only sent over HTTPS.
See `.env.example` for the rest.

The invites live in `~/.config/pricetag/invites.txt`, mode 600, outside any repo, one a line: the name, the invite, and its `name:sha256`.
The host only has the hashes, and `fly secrets` can't be read back, so that file is the list:

- **To add one,** run `pnpm invite <name>`, add its line to the file, and push the list.
- **To revoke one,** delete its line, and push the list.
- **To push the list,** which replaces the whole of it, so it never drops the others:

  ```sh
  printf 'PRICETAG_INVITES=%s\n' "$(awk '!/^#/ && NF {print $3}' ~/.config/pricetag/invites.txt | paste -sd, -)" | fly secrets import -a patina-server
  ```

That restarts the machine, so wallet reads start over, the limits reset and the apps reconnect.
Nothing else is lost, because it keeps nothing else.
The dataset settings are secrets too, so when `.env.local` moves to a new version, set the same ones with `fly secrets import`, and only after that version reaches head.
Code changes reach it with `fly deploy --ha=false`.

### The hosted build

`pnpm mac:hosted` builds the whole app for colleagues to install: Spending Money, Send, Buy, sites and hardware wallets, reading `PATINA_HOSTED_SERVER_HOST`.
It's the normal app with `macos/Config/Hosted.xcconfig`, under its own bundle ID, sandbox and Keychain group, so it can't see the wallet of a normal build on the same Mac.
It needs this Mac signed in to Xcode with an admin of team `R7TNNTC382`, and nothing else: Xcode makes the App ID and a Developer ID profile, which isn't tied to registered Macs, and notarizes through the same account, with no `notarytool` credential.
`macos/build/Patina-<version>-hosted.dmg` holds the app, the browser extension to load unpacked, and `macos/INSTALLING.md` as its Read Me First.

An installed copy tells each Chromium browser where the extension's host is when it opens (`BrowserHosts`).
Its sandbox allows that one file and nothing else in a browser's folders, and it never replaces a manifest it didn't write, so on a Mac with `pnpm mac`, the extension stays with that build.

`pnpm check:hosted [--no-launch] [dmg]` tests a built one with no real funds, and `macos/TESTING.md` says how to run it without interrupting anyone.

### The watch-only build

`pnpm mac:watch-only` builds the copy colleagues can install: a Developer ID `.dmg` with no key code in it and its own bundle ID, which reads `PATINA_HOSTED_SERVER_HOST` in `macos/Config/App.xcconfig`, notarized and stapled.
It tells you what to do if this Mac has no notarytool profile yet.
`pnpm check:watch-only` checks a built one, and `macos/WATCH-ONLY.md` is what to send people.
`pnpm mac` never uses any of this.
