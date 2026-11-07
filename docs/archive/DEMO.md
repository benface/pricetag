# Demo plan, Friday November 6

**Demo: Friday 2026-11-06 at 11:00 EST. Rehearsal: today, 9:30 to 10:30 EST, with [this checklist](#rehearsal-checklist-today-930-to-1030-est).**

All times are Montréal. Numbers marked *measured* come from the real server against staging, and say when if they're older than this morning. Button names come from the code on `main` at `a25c96a`, and from its screens rendered with fixtures. Nobody has clicked through this in the real window yet, so the rehearsal is the test.

## The talk

About 3 minutes of speaking, on top of the steps' 5, so about 8 in all. Numbers come from `AMP-ASSESSMENT.md` as of WORK-602's PR #197, and sections 9 and 7 say why it's worded this way.

**Opening, before step 1:**

"A chain records what moved, not what it was worth. So any wallet can show your balance, but what you paid and whether you're up has to be worked out. We wanted to find out how far Amp could take that. Pricetag is one Amp dataset on Base: 16 tables of SQL, with no fork, no contracts and no indexer of ours to run. It reads Chainlink's own logs and each swap's rate, and puts a dollar price on transfers of ETH and 9 other tokens, seconds behind the chain. An SDK turns those priced transfers into positions, cost and PnL for any wallet, back to Wednesday, when the dataset starts. And Patina is the wallet we built on it, to see if it holds up for real money."

**How we used Amp, added to these steps:** steps 4 and 8 have about 10 s of waiting, so talk through it.

| Step | Add |
|---|---|
| 2 | "The first version, six tables on a local Amp, reached chain head 29 minutes after we started. Agents did that work." If asked about staging: "3 hours 22, and about 2 of those were waiting for a token that could write." |
| 4 | "Amp's rows carry almost everything that takes, and the rest comes from an RPC." |
| 5 | "Finding it takes balances at past blocks. Amp's `rpc.eth_call` reads those, with no archive node of our own." |
| 6 | "Working out what Coinbase's payouts look like took one query over a day of the whole chain: one sender, 1,437 ETH payouts." |
| 7 | "A wrong fingerprint fails, instead of showing other numbers." |
| 8 | "We could try rules like this because being wrong was cheap. On the first day, replacing the whole dataset took about 4 minutes, and we registered about 14 versions in about 5 hours." |

**Close, after step 10:**

"Amp delivered what this depended on. Of the alternatives whose docs we read, it's the only live, hosted SQL with joins. Where it fell short is what we'd improve for this use case. Top of the list: traces. Without them, ETH arriving through a contract is invisible, which is why we check balances and ask you. Second, complete OP Stack receipts, like the L1 fee, so a wallet's cost needs no separate RPC. Third, quick lookups by account. Bloom filters skip most of the data for one wallet, but a quiet wallet's first read was still 13 to 33 seconds this morning. Some of that may be our own queries, and we haven't broken it down. Fourth, reliability: stopping one job can panic another, and it stays down with no read error, so numbers just freeze. It's rare, but we run a small watcher for it today. All of this was on staging, a shared test environment, so it says little about production. The same SQL also ran on Ethereum, but correct gas needs per-chain work, and only some chains' raw data is fresh. We wrote it all up in an assessment, so ask me if you want it."

**If asked:**
- **Would something else have been better?** "For the whole idea, no. Of what we read, only Amp has live, hosted SQL with joins, though we read docs and tested none of them. For parts, yes. SQD and Allium document traces and the L1 fee on Base, and Goldsky Feeds already sells a price per transfer. For just a PnL number, Zerion's API would've taken an afternoon, but with its rules, and no explanation of a number."
- **What did Amp do best?** "A small dataset beside the big one. A pricing rule is a 2-table fork, and rates and the other 8 feeds each became their own dataset, so the main one wasn't replaced. And questions about the whole chain took one query."
- **Does Verify need Amp?** "No. Amp's rows made it easy, but it works on any source that returns complete block rows, including a plain RPC."

## The story

**The line:** every transfer gets a price, and your wallet finally knows what you paid.

**The problem.** A chain records what moved, not what it was worth. So wallets can show a balance, but what you paid and whether you're up has to be worked out.

**What we built.** Pricetag is one Amp derived dataset on Base, with no fork, validators or contracts. It reads Chainlink's own logs and each swap's implied rate, then puts a USD price on transfers of ETH and 9 other listed tokens. A token off the list shows up with its balance and no price, and it's never guessed. Patina is a self-custody Mac wallet built on those prices.

**Why it needs Amp.** Three things this made easy:
1. **The dataset is SQL over Base's raw data,** so there's no indexer of ours to run. It's 16 tables, about 5 GB, seconds behind the chain. If asked: "Transfers about 3 seconds, prices about 7." And: "We also run a small script through the demo that restarts a job if it dies."
2. **Amp's data lets us check a price against the block.** Our server recomputes the block's hashes from what Amp returned, and checks Chainlink's log behind the price. If asked: "Amp's own verifier doesn't support Base yet, so we wrote this one."
3. **A pricing rule is a dataset version.** Switching rules re-reads the wallet through another version, with no app code for any rule. Each one is pinned to its fingerprint.

**What's new.** The price is a shared fact in the dataset, and what you paid is personal, so your own app works it out. What it can't work out says "unknown". It's never guessed and never counted as $0.

**It's not a trading app.** Patina helps you invest, and sometimes trade when the timing is right. Nothing in it rewards trading more.

**Don't claim:**
- "Every token is priced." It's 10 assets. Any other token that's moved since the dataset's start shows its balance with no price, and likely spam is tucked away.
- "Verify proves the SQL or the chain." It doesn't show that the header is on Base's real chain, that the SQL ran correctly, or that Chainlink's number is right. Say so, because it's more convincing.
- "Every fee is checked." The check is on balances, to the smallest unit. ETH found from a balance can't fail it, and the app says how much of that there is (WORK-612).
- "Audited." The hot wallet is an unreviewed build, for small funds only.
- "Tested on a real Ledger or Keystone," until it has been.
- "Under a second." Or "at most 6 s": prices were a median of about 7 s behind this morning, and at most about 15 s (*measured*, WORK-602).
- "Verified by Amp." It's our server's check.
- "Correct through reorgs." If asked: "We forced reorgs through a local Amp. Up to 136 blocks, 27 seconds of Base, the app fixed itself within a minute and a half."
- "All through Amp." Network fees paid to Ethereum and deposit details come from an RPC, and sends always will.
- "Nobody else prices transfers." Goldsky Feeds sells a price per transfer. Ours is an open dataset with source labels, a rule you can fork, and an honest "unknown".
- "Any EVM chain." Say: "The same SQL ran on Ethereum, but correct gas needs per-chain work, and only some chains' raw data is fresh."
- "Bloom filters made it fast." The demo wallet's cold read barely moved. A read past the first is what's quick.
- "Install our SDK." It isn't on npm, so don't tell people to install it.

## Click by click

About 5 minutes. **Before you start:**
- The server has been running for at least 5 minutes, with the wallet already read once under each rule, so nothing's a cold read.
- [The job watch](#the-job-watch) is running, and its log shows no `ALERT` you haven't dealt with.
- In Settings (⌘,) > General: USD, Cost method Average, and the Market price rule. The menu bar shows Value, the default: right-click it to check.
- The Coinbase question is **unanswered**, and what you paid is on a sticky note.
- The main window and Settings are arranged side by side. Keep the main window wide, or details open as a sheet instead of on the right.

| # | Do | Say | Should appear |
|---|---|---|---|
| 1 | Click the menu bar item | "This is my real wallet, with real money. A small amount, on purpose." | Value and PnL, a warning about what has an unknown cost or what PnL leaves out, with **Answer 1 Question** under it, then holdings. Spending Money below, with Buy, Receive, Send and Top Up |
| 2 | **Open Patina** (⌘O), then ⌘4 (Wallet > Spending Money) | "It only has what I've done since Wednesday at 14:24, when the dataset starts. Every position is checked against the chain to the smallest unit." | Spending Money's Overview, whatever you had open before: its card, Value and PnL, the warning with **Answer 1 Question**, then holdings, largest first, with ETH's PnL unavailable. When every balance matches the chain, a check sits beside "Holdings". Only a holding that doesn't match gets a triangle |
| 3 | Click cbBTC's number in the holdings | "Any number opens what's behind it: what moved, at what price, and where that price came from." | Details on the right, with what you clicked in a menu at the top. Under Activity, each row starts with a plain sentence, like "Sold $1.00 of ETH.", then its price source and cost |
| 4 | On a "Sold" or "Bought" row, click **Proof** under it, then **Verify block …** | "Our server recomputes the block's hashes from what Amp returned. It doesn't prove my SQL or Chainlink's number, and it says so." | "Checking this block…" for 8 to 11 s (*measured* on the 5th), then "The data Amp stored for this block matches its header, and so does Chainlink's update behind this price. Base's node agrees on both." and 7 passed checks. A row with no Chainlink update behind it has 6, and doesn't mention the update |
| 4b | *Optional:* click a holding's Value, then **Proof of this price**, then **Verify block …** | "Every listed token's current price has a log behind it, not just ETH's and USDC's." | 4–12 s (*measured* on all 10 listed tokens on the 5th). A price from a token's recent trades has no such proof |
| 5 | **Answer 1 Question** in the warning (the count is whatever's open), or press ⇧⌘R | "My ETH came from Coinbase inside a batched payout. No transaction points at my wallet, and this data has no traces. We found it from the balance. So it asks, instead of guessing." | "Who sent you this?", a line saying why it asks, and "From a Coinbase address". **My exchange account** and **Someone else** below |
| 6 | **My exchange account**, type what you paid, **Save**, **Done** | "That stays on this Mac. Now everything adds up." | The warning is gone, and ETH has PnL and a return. "Compared with holding ETH" and a full chart appear |
| 7 | In Settings > General, under Pricing rule, pick **Cautious ETH** | "Same transactions, different recipe. It counts ETH 1% lower. That's a second dataset version, two tables, with no app code for it. Here's its fingerprint." | The numbers change on their own. The fingerprint's under each rule's name |
| 8 | **Compare Side by Side…**, just below | "Same block, same facts. The only difference is the rule." | ETH price differs by 1% and Value by 1% of the ETH held. About 11 s (*measured* on the 5th) |
| 9 | Pick **Market price** again. *Optional:* on Spending Money's card, **Send…**, click ⇅ to type in dollars, $1, your savings' name in To, **Send**, Touch ID | "It sends too. Savings stay on a hardware wallet, and Spending Money has a cap." | "On its way" until the receipt, then a green check and "Sent". The row says "Done", and the numbers update by themselves. Cut this step if it takes over 15 s in rehearsal |
| 10 | Close | "One dataset, with no fork and no contracts. Price is a fact, and what you paid is yours." | |

**Compare's amounts are small on a $45 wallet,** about $0.20. If that falls flat, show the screenshot from the [recording list](#backup-recording): a busy public wallet came out at $548,006 vs $544,586 (*measured* on the 5th). Don't paste that wallet live. A cold read of it can take a long time (WORK-410, WORK-493).

## Wallet setup

**Use the hot wallet you already have,** `0x3762…5D89`. Always copy its address from Patina's Spending Money page, not from this file or any message. Only you do these steps. No agent touches keys or funds. This wasn't checked against what the wallet holds now, so skip whatever's already done.

| When | You do | Why |
|---|---|---|
| **Before funding** | Add your savings wallet if you can, then check the cap | Cap is $50 by default with savings, and at most $25 without. Without savings, cut every amount below to about half |
| **Before 9:30**, if it isn't done | Withdraw **$40 of ETH from Coinbase** on Base. Write down the total you paid for both withdrawals, this one and Wednesday's | This is what makes WORK-424 visible, see below. It's too late for the chart's one-day change, which needs a known point 24 h back, but the rest works |
| **Once it shows in the app** | With the extension on `app.uniswap.org`, swap **$12 of ETH to cbBTC**, then **$12 of ETH to AERO**. Don't answer the Coinbase question | Costs that are really paid, and prices that move. Waiting avoids landing in the payout's block, which would leave costs unknown. Each row should show a dollar cost. If one says unknown, see below |
| **Before 9:30** | Under Settings at the bottom of Spending Money's page, in Cap and Sweeps, turn off **Sweep realized gains to savings**. Then swap **half the AERO to USDC** | Gives Realized a number, and won't sweep on stage. Sell into USDC rather than ETH, because ETH paid out through a contract is the hardest case |
| **After the rehearsal** | In Settings > **Answers** (or File > **Your Answers…**), remove the Coinbase answer with the ⊖ beside it. Every other answer stays | Puts steps 5 and 6 back on stage. Do this after each run through the steps, too |

**If a swap's cost says unknown, don't buy again.** A later purchase doesn't repair the earlier one, and answering Coinbase doesn't either. Click the row and read its reason, then:
- **It says a contract's ETH couldn't be confirmed:** wait a few minutes, because this can clear by itself.
- **It asks "What did this cost?":** answer it. That fixes the token's cost, and selling it later gets a Realized number.
- **It says another token moved in that transaction:** the ETH you paid stays "sold or spent at an unknown price", and no answer clears that (*reproduced*). So PnL stays partial on this wallet for good, and a recording would show the same. Put the transaction's hash on WORK-448. Then change step 6 to "what it can't price stays flagged", and don't promise a complete number.

**Cost:** $40 of new money, which stays yours and moves with the market. Fees should be under $0.50 in total. The $1 swap's network fee was $0.0023 (*measured*), and Coinbase's withdrawal fee and Uniswap's fees are on top. Keep the wallet under the cap, or a sweep can start by itself.

**Why Coinbase and not a plain send:**

| Funding | What the app does | Result |
|---|---|---|
| **Coinbase withdrawal** | Finds ETH with no transaction to the wallet, and asks "Who sent you this?" with "From a Coinbase address". **My exchange account** then takes what you paid | **Exact PnL** (*measured:* typing $5.10 gave a complete PnL of −$0.10), and the best moment in the demo |
| Plain send from your own wallet, answered **My wallet** | Its cost comes from that wallet, so anything it held before Wednesday 14:24 stays unknown | **PnL stays unavailable** |
| Plain send, answered **Someone else** | Uses the price when it arrived | Complete, but marked as an estimate (*measured*). This is the fallback if Coinbase is slow |

If this withdrawal pays from a different contract, the app can't name it (WORK-444), so you may get a second card without "Coinbase". It still works, but change what you say in step 5.

### Buying on stage (WORK-462)

**Optional, and only after a real purchase has worked in rehearsal.** Press **Buy** in the toolbar, enter $3 of ETH, **Continue on Coinbase**, and pay by card. It opens Spending Money, where the purchase says "On its way", then "Delivered. Waiting to see it arrive", then "Cost $X, fees included". Say: "No question this time. Coinbase's order says what I paid, and it matches what arrived exactly." The row in Transactions says "Cost: Bought on Coinbase".

**To show a larger amount:** type more than the room left, and the sheet says how much stays and that the rest goes to your savings, but stop there, because the trial limit won't let it through. If you do buy more than the room left: what lands above the cap sweeps by itself, with Patina open, to a savings wallet you've checked on a device. Without one, Buy still works and starts at the room left, but anything above the cap stays in Spending Money until you add one, and the sheet says so. Coinbase's page lets you change the amount but not the token. Its row in the savings wallet says the same cost and source.

**Coinbase's trial limit is CA$6.99 a transaction (*measured*).** It refused $5 of ETH, which is about that before fees. A smaller purchase worked on Thursday, but its amount and cost aren't recorded yet (WORK-477), so the rehearsal redoes it. Larger purchases need full access (https://support.cdp.coinbase.com/onramp-onboarding), so don't plan on one on stage. A refusal shows on Coinbase's page, or in the sheet as Coinbase said it. Use the fallbacks below.

A real card purchase on stage can fail, and a real delivery can take minutes, so don't let the demo depend on one:
- **Best:** do a real purchase before you go on, and show its finished row and its cost in Transactions. Open with "I bought this an hour ago".
- **Recording:** add a clip of a real purchase to the backup recording.
- **Mocked:** set `COINBASE_ONRAMP_MOCK` to `1` in `.env.local`, restart the server, and turn on Coinbase's mocked mode on its page: click "Secured" 10 times, open **Actions**, and toggle **Enable Mocked Buy and Send**. Nothing's charged and nothing arrives, so the row stays at "Waiting for you on Coinbase", and it doesn't record a cost. It only shows the page. Use **I Didn't Buy It** to clear it.

## What could go wrong

| Problem | How you'd know | Do this |
|---|---|---|
| **Public RPC rate limit** (WORK-336's failed swap) | A send or site approval fails, or a balance says not checked. Verify's Transactions and Base's node say not checked. Shared wifi makes it worse | Keep the public RPC unless this happens: it had no failures at the app's load after Base's block switch (*measured*, WORK-396). Fallback: set `BASE_RPC_URL=https://base-rpc.publicnode.com` in `.env.local`, restart the server, and paste the URL into **Base network address**, under Advanced in the settings at the bottom of Spending Money's page. It had no errors either, but is about 4 times slower |
| **Staging dataset behind** | The app says "Catching up", and the 8:00 health checks report it | Prices run seconds behind (*measured* this morning: a median of about 7 s, at most about 15 s), and "Catching up" can flash for one read (WORK-514). Keep going, it's the honest behavior. If it's stuck, [restart its job](#if-the-dataset-is-stuck). If that doesn't clear it in a minute, use the recording. If `edgeandnode/base_mainnet` stalls, that isn't ours to fix: ask in `#amp-hackathon`. Don't run `pnpm amp:start`: it starts with empty history, so this wallet would have none |
| **A dataset's job dies** (WORK-574) | Like being behind, but it doesn't move: reads still answer with the same newest block, so the numbers freeze and the app says "Catching up". Amp's status says `FATAL`, and bounded reads give no error. Stopping any job with JS on the same worker can cause it, and one died about 100 s after a deploy, cause unknown (WORK-602) | The job watch restarts it, and it was back at head about 40 s after a restart (*measured*). Keep going, and check `~/Library/Logs/pricetag-job-watch.log` afterward. If the log shows no restart, [restart it by hand](#if-the-dataset-is-stuck). A restart resumes the same job, so nothing's lost |
| **Staging's gateway hiccups** | A read fails, then works again. 7 of 104 reads failed in two bursts on Thursday, each over within a minute (*measured*, WORK-491) | The app's reads retry. Keep talking for a few seconds, and don't restart the server |
| **The dataset's numbers look wrong** | Numbers look wrong, or reads fail, on 0.3.0 | There's no quick way back: [see below](#dataset-versions). Use the recording |
| **Only the fork fails** | The rule switch or Compare errors | Stay on Market price and skip steps 7 and 8 |
| **Admin token** expires Fri 12:46 | Only a write fails | Reads don't use it. The read token lasts until April 2027 (*checked*, not printed). Stopping a job, or the job watch restarting one after 12:46, needs a new token. The watch keeps checking and says so. Put the new one in `staging.jwt`, and it picks it up |
| **Slow reads** | A fresh server's first read took 13, 14 and 33 s, and the next ones 1.5–3.5 s (*measured* this morning on 0.3.0, WORK-602). The app's query timeout is 60 s. A read past 5 s shows how long it's been going | Don't restart the server on stage, since a restart means a cold read. Read the wallet before you go on. The health checks measure this. Security (⌘5) reads approvals from the `approvals` table: 2.5 s after the main window has loaded, and 10 s if it's the server's first request (*measured* on one wallet on 0.2.0, WORK-540) |
| **Wifi** | Everything real stops, with "Prices Aren't Available Right Now" (the web app still says "Couldn't read this wallet's data") | Phone hotspot, tested in rehearsal. If that fails, the demo page below or the recording |
| **Server on 8787 not running** | The app says "The Price Service Isn't Running" | `pnpm mac` runs the server in its terminal until you press Ctrl-C, so keep that terminal open. If it's gone: in the repo, `pnpm start`, then wait for the first read |
| **Ledger or Keystone misbehaves** | Anything off in [the checklist](../../HARDWARE-WALLETS.md#checklist-for-a-real-device) | Nothing in the main flow needs one. Fallback is a browser wallet like Rabby. Ledger needs Chrome, the Ethereum app open and Ledger Wallet closed. Leave devices off stage unless they pass twice |
| **Everything's down** | | Open `http://localhost:8787/?address=demo`. The server still sent the page and its data with Amp unreachable (*measured*): 8 holdings and 13 chart points. Check it in a browser during rehearsal. Say it's demo data. It has no Verify or Compare. `pnpm mac`'s Release build has no demo wallet, so it's web only |

**Stage basics:** turn on Do Not Disturb, plug in power, run `caffeinate -d`, and check the menu bar item isn't hidden on the projector's resolution. Don't connect to a live site or show Uniswap on stage: it's a failure path, and it's the wrong message for this app.

### Dataset versions

Staging's dataset was replaced twice on Thursday night. The app reads `benface/pricetag@0.3.0` (`72a4cadf…`) and `benface/pricetag_cautious@0.3.0` (`639edea8…`), with `benface/pricetag_feeds@0.1.0` for the other tokens' prices. All three are what `.env.local` names and were `RUNNING` at 7:35 this morning (*checked*).

**0.2.0 and 0.1.0 still run, but they're not a fallback.** The server needs the `counterparty` column in `legs`, which 0.3.0 is the first to have, so it fails every wallet read on an older version. Going back also means reverting WORK-493's PR, so don't try it on demo day.

**No new versions today unless you say so, and no version switches after 10:00.** A change to `dataset/` needs a new deploy, and only one that makes the demo better is worth that now (see WORK-602's job death, above). Never switch the app to a version that hasn't reached head. The server only reads its env at start.

### Backup recording

**Today, in the rehearsal, after the first clean run.** The recording of the real purchase, below, can go in it too.
- **Screen:** all 10 steps with no voice, about 4 minutes, saved locally and on your phone.
- **Stills:** Verify's passed checks, the chart once answered, Compare on this wallet, and Compare on a busy public wallet. Read that wallet ahead of time.

### If the dataset is stuck

**Don't stop or deploy any staging job from Friday 8:00 until the demo's over.** Stopping a job that runs JS functions (`pricetag`, `pricetag_cautious`, `pricetag_control`, `pricetag_bloom`) can kill another such job on the same worker, including the one the app reads. That froze the app's dataset for 13 minutes on Thursday night (WORK-575). It's rare, one in 14 stops, but the job doesn't come back by itself. And a job went `FATAL` about 100 s after a deploy at 04:38 UTC today, with no stop nearby. That's one case, by timing only, with the cause unknown (WORK-602).

[The job watch](#the-job-watch) does this by itself within about 15 s. If the numbers stop moving anyway, restart it by hand. This is safe on a healthy job, which it leaves alone. A restart keeps the history and caught up 13 minutes in under a minute (*measured*). `pricetag_cautious` is a separate job, so if the fork is stuck too, run this again with its name. It needs the admin token, so it stops working Friday at 12:46. If `PRICETAG_DATASET` has moved past `0.3.0`, change the version at the end:

```sh
curl -sS -X POST -H @<(printf 'authorization: Bearer %s' "$(cat ~/.config/pricetag/staging.jwt)") -H 'content-type: application/json' -d '{}' https://gateway.amp.staging.edgeandnode.com/controller/materialized-datasets/benface/pricetag/versions/0.3.0
```

### The job watch

A small background service checks every dataset `.env.local` names every 15 s, including the fork. When a job is `FATAL`, it restarts it and shows a notification. It restarted real dead jobs on a local Amp about 3 s after they went `FATAL` (*measured*, WORK-577). It runs on this Mac, so it only works while the Mac is awake and online. After Friday 12:46 it can still check but can't restart, and it says so.

To check it, this should print `state = running`, and the log shows each dataset's status:

```sh
launchctl print gui/$(id -u)/com.benface.pricetag-job-watch | grep -m1 'state ='
tail ~/Library/Logs/pricetag-job-watch.log
```

If it isn't running, start it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.benface.pricetag-job-watch.plist`. If that fails, run `node scripts/job-watch.ts` from the repo in its own terminal.

## Rehearsal checklist, today, 9:30 to 10:30 EST

**Before 9:30**
- [ ] Read the 8:00 health check on WORK-448.
- [ ] Do what's left of [Wallet setup](#wallet-setup): the withdrawal and swaps if they aren't done, sweeping off, and half the AERO sold. Start early, since these take time to show.

**9:30: start it (5 min)**
- [ ] In your own folder, on `main`: `git pull`, then `pnpm mac`. Run it last from there, because each run points the extension at that build, so a run from `pricetag-test` leaves it on the wrong one. If a server's already on 8787, `pnpm mac` keeps it, and one started before 0.3.0 can't read anything. So stop it first.
- [ ] [Check the job watch](#the-job-watch) is running, then read the wallet once under each rule.
- [ ] Answer the Coinbase card. There should be no other question and no warning. If there is, read it, and see [Wallet setup](#wallet-setup). Then remove the answer in Settings > **Answers**.

**9:35: the steps, twice with a timer (15 min)**
- [ ] Run the 10 steps twice, on the projector's resolution if you can. Each run should take under 5 minutes. Remove the Coinbase answer between runs.
- [ ] Note what really appears at each step, and say on WORK-448 what differs.
- [ ] Check the Send step's real time, then keep it or cut it.

**9:50: one small real purchase (15 min)**
1. Start a screen recording before pressing **Buy**. It can double as the demo's backup clip of a purchase.
2. Buy the smallest amount that works. Screenshot Coinbase's final page, showing the total charged, the fees and the crypto received. Hide the card number, and anything personal.
3. Screenshot Patina's row in Spending Money when it says "Cost $X, fees included", and note how long that took.
4. Reply on WORK-477 with those. Then run the command in WORK-480's description in Terminal, and paste only its `cost` and `costUsdMicros` values on WORK-480.

**10:05: the fallbacks that matter most (10 min)**
- [ ] Switch to the hotspot, and check the numbers still update. Then switch back.
- [ ] Open `http://localhost:8787/?address=demo` in a browser.
- [ ] Press Ctrl-C in `pnpm mac`'s terminal, check the app says "The Price Service Isn't Running", then run `pnpm mac` again and time the cold read. This is the only time to restart it.
- [ ] Have the [restart command](#if-the-dataset-is-stuck) ready in a terminal, but don't run it unless a job's stuck.

**10:15: record the backup (15 min)**
- [ ] [Record it](#backup-recording) and copy it to your phone.
- [ ] Remove the Coinbase answer in Settings > **Answers**, and leave the server running until the demo.

**If there's time.** The PublicNode fallback, then the device checklist with a few dollars. Otherwise, devices stay off stage.

**Skip until after the demo**
- Everything Low in Backlog, and WORK-447.
- The tax report and CAD on stage. They work, but they don't serve this story. Mention them in a sentence if asked.
- Merging anything after 10:00 that changes what these steps click, unless you run them again.
- `pnpm amp:start`, on demo day.

## After the demo

Say on WORK-448 that it's over. Colleagues may try a read-only tester build on the hosted server, so **leave `benface/pricetag`, its fork `benface/pricetag_cautious` and the job watch running while people are testing.** Put a new admin token in `staging.jwt` for that, because after 12:46 nothing can restart a job that dies.

Stop jobs only when testing's over, and only if you agree. Stop [the job watch](#the-job-watch) first with `launchctl bootout gui/$(id -u)/com.benface.pricetag-job-watch`, so it doesn't restart a job that stopping another one kills. The run on WORK-448 then stops the staging jobs (0.3.0, 0.2.0 and 0.1.0 of both, `pricetag_feeds`, `pricetag_rates`, and any older ones still running).

Then turn **Sweep realized gains to savings** back on, and move what you want off the hot wallet.
