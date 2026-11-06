# Demo plan, Friday November 6

All times are Montréal. **Demo: Friday at 11:00 EST. Rehearsal: Thursday, about 16:00 to 17:00.** Numbers marked *measured* come from the real server against staging, overnight on November 4 to 5, or after Base's block switch on the 5th where it says so (WORK-406, WORK-396). Button names come from the code on `main` at `81b254a`. Nobody has clicked through this in the real window yet, so the rehearsal is the test.

## The story

**The line:** every transfer gets a price, and your wallet finally knows what you paid.

**The problem.** A chain records what moved, not what it was worth. So wallets show a balance, and nobody can say what you paid or whether you're up.

**What we built.** Pricetag is one Amp derived dataset on Base, with no fork, validators or contracts. It reads Chainlink's own logs and each swap's implied rate, then puts a USD price on transfers of ETH and 9 other listed tokens. A token off the list shows up with no price, and it's never guessed. Patina is a self-custody Mac wallet built on those prices.

**Why it needs Amp.** Three things this made easy:
1. **The dataset is SQL over Base's raw data,** so there's no indexer of ours to run. It's 16 tables, about 2 GB, a few seconds behind the chain.
2. **Amp's data lets us check a price against the block.** Our server recomputes the block's hashes from what Amp returned, and checks Chainlink's log behind the price. If asked: "Amp's own verifier doesn't support Base yet, so we wrote this one."
3. **A pricing rule is a dataset version.** Switching rules re-reads the wallet through another version, with no app code for any rule. Each one is pinned to its fingerprint.

**What's new.** The price is a shared fact in the dataset, and what you paid is personal, so your own app works it out. What it can't work out says "unknown". It's never guessed and never counted as $0.

**It's not a trading app.** Patina helps you invest, and sometimes trade when the timing is right. Nothing in it rewards trading more.

**Don't claim:**
- "Every token." It's 10 assets. The rest are listed with no price.
- "Verify proves the SQL or the chain." It doesn't show that the header is on Base's real chain, that the SQL ran correctly, or that Chainlink's number is right. Say so, because it's more convincing.
- "Audited." The hot wallet is an unreviewed build, for small funds only.
- "Tested on a real Ledger or Keystone," until the rehearsal has done it.
- "Under a second." Prices run a few seconds behind the chain.
- "Verified by Amp." It's our server's check.
- "Correct through reorgs." We haven't seen one.
- "All through Amp." Network fees paid to Ethereum and deposit details come from an RPC.
- "Nobody else prices transfers." Others do parts of this.

## Click by click

About 5 minutes. **Before you start:**
- The server has been running for at least 5 minutes, with the wallet already read once under each rule, so nothing's a cold read.
- In Settings (⌘,) > General: USD, Average cost, and the Market price rule. The menu bar shows Value, the default: right-click it to check.
- Spending Money is the wallet shown, on Overview (⌘4). Open Patina reopens whatever section and wallet you left, so step 2 presses ⌘4 again.
- The Coinbase question is **unanswered**, and what you paid is on a sticky note.
- The main window and Settings are arranged side by side. Keep the main window wide, or details open as a sheet instead of on the right.

| # | Do | Say | Should appear |
|---|---|---|---|
| 1 | Click the menu bar item | "This is my real wallet, with real money. A small amount, on purpose." | Value, PnL and holdings, with a line under them saying what PnL leaves out and **Answer 1 Question** beside it. Spending Money below, with Buy, Receive, Send and Top Up |
| 2 | **Open Patina** (⌘O), then ⌘4 (Wallet > Spending Money) | "It only has what I've done since Wednesday at 14:24, when the dataset starts. Every position is checked against the chain to the smallest unit." | Spending Money's Overview: holdings, largest first, with price and return, ETH's Unrealized unknown, and a warning above them with **Answer 1 Question**. When every balance matches the chain, a check sits beside "Holdings". Only a holding that doesn't match gets a triangle |
| 3 | Click cbBTC's number in the holdings | "Any number opens what's behind it: what moved, at what price, and where that price came from." | Details on the right. Each row starts with a plain sentence, like "Sold $1.00 of ETH.", then its price source and cost |
| 4 | On a "Sold" or "Bought" row, click **Proof** under it, then **Verify block …** | "Our server recomputes the block's hashes from what Amp returned. It doesn't prove my SQL or Chainlink's number, and it says so." | 8 to 11 s (*measured* after the switch), then "The data Amp stored for this block matches its header, and so does Chainlink's update behind this price" and 5 passed checks |
| 5 | **Answer 1 Question** beside the warning (the count is whatever's open), or press ⇧⌘R | "My ETH came from Coinbase inside a batched payout. No transaction points at my wallet, and this data has no traces. We found it from the balance. So it asks, instead of guessing." | "Who sent you this?", a line saying why it asks, and "From a Coinbase address" |
| 6 | **My exchange account**, type what you paid, **Save**, **Done** | "That stays on this Mac. Now everything adds up." | The line saying what PnL leaves out is gone, and ETH has PnL and a return. "Compared with holding ETH" and a full chart appear |
| 7 | In Settings > General, under Pricing rule, pick **Cautious ETH** | "Same transactions, different recipe. It counts ETH 1% lower. That's a second dataset version, two tables, with no app code for it. Here's its fingerprint." | The numbers change on their own |
| 8 | **Compare Side by Side…**, just below | "Same block, same facts. The only difference is the rule." | ETH price differs by 1% and Value by 1% of the ETH held. About 11 s (*measured*) |
| 9 | Pick **Market price** again. *Optional:* in the menu bar item, **Send**, 1 USDC to your savings (type its name in To; ⇅ switches the amount to dollars), **Send**, Touch ID | "It sends too. Savings stay on a hardware wallet, and Spending Money has a cap." | "On its way" until the receipt, then a green check and "Sent". The row says "Done", and the numbers update by themselves. Cut this step if it takes over 15 s in rehearsal |
| 10 | Close | "One dataset, with no fork and no contracts. Price is a fact, and what you paid is yours." | |

**Compare's amounts are small on a $45 wallet,** about $0.20. If that falls flat, show the screenshot from the [recording list](#backup-recording): a busy public wallet came out at $548,006 vs $544,586 (*measured*). Don't paste that wallet live. Its first read took 142 s and its Compare 57 s (*measured*, see WORK-410).

## Wallet setup

**Use the hot wallet you already have,** `0x3762…5D89`. It holds $5 today (*measured*): a Coinbase payout, one $1 swap to USDC, and one open question. Always copy its address from Patina's Spending Money page, not from this file or any message. Only you do these steps. No agent touches keys or funds.

| When | You do | Why |
|---|---|---|
| **Before funding** | Add your savings wallet if you can, then check the cap | Cap is $50 by default with savings, and at most $25 without. Without savings, cut every amount below to about half |
| **Before the rehearsal**, if it isn't done | Withdraw **$40 of ETH from Coinbase** on Base. Write down the total you paid for both withdrawals, this one and Wednesday's | This is what makes WORK-424 visible, see below. Earlier is better: the chart's one-day change needs a known point from before the range starts, so it needs to be at least 24 h before the demo. Later still works, without that change |
| **Once it shows in the app** | With the extension on `app.uniswap.org`, swap **$12 of ETH to cbBTC**, then **$12 of ETH to AERO**. Don't answer the Coinbase question | Costs that are really paid, and prices that move. Waiting avoids landing in the payout's block, which would leave costs unknown. Each row should show a dollar cost. If one says unknown, see below |
| **Thu, before 16:00** | In Settings > Spending Money, turn off **Sweep realized gains to savings**. Then swap **half the AERO to USDC** | Gives Realized a number, adds a transaction after the block switch, and won't sweep on stage. Sell into USDC rather than ETH, because ETH paid out through a contract is the hardest case |
| **Fri morning** | In Settings > **Answers** (or File > **Your Answers…**), remove the Coinbase answer with the ⊖ beside it. Every other answer stays | Puts steps 5 and 6 back on stage |

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

**Optional, and only after a real purchase has worked in rehearsal.** Press **Buy** in the toolbar, enter $3 of ETH, **Continue on Coinbase**, and pay by card. It opens Spending Money, where the purchase says "On its way", then "Delivered", then "Cost $X, fees included". Say: "No question this time. Coinbase's order says what I paid, and it matches what arrived exactly." The row in Transactions says "Cost: Bought on Coinbase".

**To show a larger amount:** type more than the room left, and the sheet says how much stays and that the rest goes to your savings, but stop there, because the trial limit won't let it through. If you do buy more than the room left: what lands above the cap sweeps by itself, with Patina open, to a savings wallet you've checked on a device. Without one, Buy still works and starts at the room left, but anything above the cap stays in Spending Money until you add one, and the sheet says so. Coinbase's page lets you change the amount but not the token. Its row in the savings wallet says the same cost and source.

**Coinbase's trial limit is CA$6.99 a transaction (*measured*).** It refused $5 of ETH, which is about that before fees. A smaller purchase worked on Thursday, but its amount and cost aren't recorded yet (WORK-477), so the rehearsal redoes it. Larger purchases need full access (https://support.cdp.coinbase.com/onramp-onboarding), so don't plan on one on stage. A refusal shows on Coinbase's page, or in the sheet as Coinbase said it. Use the fallbacks below.

A real card purchase on stage can fail, and a real delivery can take minutes, so don't let the demo depend on one:
- **Best:** do a real purchase before you go on, and show its finished row and its cost in Transactions. Open with "I bought this an hour ago".
- **Recording:** add a clip of a real purchase to the backup recording.
- **Mocked:** set `COINBASE_ONRAMP_MOCK` to `1` in `.env.local`, restart the server, and turn on Coinbase's mocked mode on its page: click "Secured" 10 times, open **Actions**, and toggle **Enable Mocked Buy and Send**. Nothing's charged and nothing arrives, so the row stays at "Waiting for you on Coinbase", and it doesn't record a cost. It only shows the page. Use **I Didn't Buy It** to clear it.

## What could go wrong

| Problem | How you'd know | Do this |
|---|---|---|
| **Public RPC rate limit** (WORK-336's failed swap) | A send or site approval fails, or a balance says not checked. Verify's Transactions says not checked. Shared wifi makes it worse | Keep the public RPC until then: it had no failures at the app's load after the switch (*measured*, WORK-396). Fallback: set `BASE_RPC_URL=https://base-rpc.publicnode.com` in `.env.local`, restart the server, and paste the URL into **Network** in Settings > Spending Money. It had no errors either, but is about 4 times slower |
| **Staging dataset behind** | The app says "Catching up", and the 8:00 health checks report it | Prices run about 6 s behind, up to 11 s, after the switch (*measured*, WORK-406), and "Catching up" can flash for one read (WORK-514). Keep going, it's the honest behavior. If it's stuck, or `edgeandnode/base_mainnet` stalls, ask in `#amp-hackathon` and use the recording. Don't run `pnpm amp:start`: it starts with empty history, so this wallet would have none |
| **Staging's gateway hiccups** | A read fails, then works again. 7 of 104 reads failed in two bursts on Thursday, each over within a minute (*measured*, WORK-491) | The app's reads retry. Keep talking for a few seconds, and don't restart the server |
| **The new dataset version misbehaves** | Numbers look wrong, or reads fail, on 0.2.0 only | Go back to 0.1.0, [below](#dataset-versions) |
| **Only the fork fails** | The rule switch or Compare errors | Stay on Market price and skip steps 7 and 8 |
| **Admin token** expires Fri 12:46 | Only a write fails | Reads don't use it. The read token lasts until April 2027 (*checked*, not printed). Thursday night's replacement is done (WORK-540). No version switches after 10:00 on Friday unless you say so. Another replacement or stopping the jobs after 12:46 needs a new token |
| **Slow reads** | A cold read took 18–31 s, warm about 5 s (*measured* after the switch), and about 50 s cold on a wallet with 11 approvals (*measured*, WORK-540). They may grow by Friday, and the app's query timeout is 60 s. A read past 5 s shows how long it's been going | Don't restart the server on stage, since a restart means a cold read. Read the wallet before you go on. The health checks measure this. Security (⌘5) now reads approvals from the `approvals` table: 2.5 s after the main window has loaded, and 10 s if it's the server's first request (*measured* on one wallet, WORK-540) |
| **Wifi** | Everything real stops, with "Prices Aren't Available Right Now" (the web app still says "Couldn't read this wallet's data") | Phone hotspot, tested in rehearsal. If that fails, the demo page below or the recording |
| **Server on 8787 not running** | The app says "The Price Service Isn't Running" | In the repo: `pnpm start`, then wait for the first read. Keep it in its own terminal, not the one you'd close |
| **Ledger or Keystone misbehaves** | Anything off in [the checklist](HARDWARE-WALLETS.md#checklist-for-a-real-device) | Nothing in the main flow needs one. Fallback is a browser wallet like Rabby. Ledger needs Chrome, the Ethereum app open and Ledger Wallet closed. Leave devices off stage unless they pass twice |
| **Everything's down** | | Open `http://localhost:8787/?address=demo`. The server still sent the page and its data with Amp unreachable (*measured*): 8 holdings and 13 chart points. Check it in a browser during rehearsal. Say it's demo data. It has no Verify or Compare. The Mac app's Release build has no demo wallet, so it's web only |

**Stage basics:** turn on Do Not Disturb, plug in power, run `caffeinate -d`, and check the menu bar item isn't hidden on the projector's resolution. Don't connect to a live site or show Uniswap on stage: it's a failure path, and it's the wrong message for this app.

### Dataset versions

Since Thursday 20:35, the app reads `benface/pricetag@0.2.0` (`0aecd2c7…`) and `benface/pricetag_cautious@0.2.0` (`aff88c5c…`). Only the `approvals` table is new, and every other table and function matches 0.1.0 (*checked*, WORK-540), so the numbers above still apply. The server only reads its env at start, so restart `pnpm mac` if it's been running since before then.

0.1.0 of both still runs as a fallback. To go back, restore these four lines in `.env.local` and restart the server:

```sh
PRICETAG_DATASET=benface/pricetag@0.1.0
PRICETAG_DATASET_HASH=a94e5237dd3eae583eda6f5aefa74800e6778d0c9c2ed14c4d5383f6f67137b2
PRICETAG_FORK_DATASET=benface/pricetag_cautious@0.1.0
PRICETAG_FORK_HASH=c5c66a117461e8990c4a5638919ddf9ca3c9ae9333982d9583d127d93ab1705e
```

### Backup recording

**Thursday, right after the first clean rehearsal.** Redo it Friday morning if the app has changed. The recording of the real purchase, below, can go in it too.
- **Screen:** all 10 steps with no voice, about 4 minutes, saved locally and on your phone.
- **Stills:** Verify's passed checks, the chart once answered, Compare on this wallet, and Compare on a busy public wallet. Read that wallet ahead of time.

## Rehearsal checklist, Thursday November 5

**Before 16:00**
- [ ] Fund and buy if it isn't done, then turn off sweeping and sell half the AERO, as above.
- [ ] Answer the Coinbase card. There should be no other question and no line saying what PnL leaves out. If there is, read it, and see above. Then remove the Coinbase answer in Settings > **Answers**.
- [ ] Run `pnpm mac` last from your own folder, on `main`. Each run points the extension at that build, so a run from `pricetag-test` leaves it on the wrong one.

**The real purchase, step by step**
1. Start a screen recording before pressing **Buy**. It can double as the demo's backup clip of a purchase.
2. Buy the smallest amount that works. Screenshot Coinbase's final page, showing the total charged, the fees and the crypto received. Hide the card number, and anything personal.
3. Screenshot Patina's row in Spending Money when it says "Cost $X, fees included", and note how long that took.
4. Reply on WORK-477 with those. Then run the command in WORK-480's description in Terminal, and paste only its `cost` and `costUsdMicros` values on WORK-480.

**The rehearsal, from 16:00**
- [ ] Run the 10 steps twice with a timer, on the projector's resolution if you can. It should take under 5 minutes.
- [ ] Note what really appears at each step, and say on WORK-448 what differs.
- [ ] Check the Send step's real time, then keep it or cut it.
- [ ] Stop the server and bring it back. Switch to the hotspot. Try the PublicNode fallback.
- [ ] Go through the device checklist once, with a few dollars. Decide whether a device goes on stage.
- [ ] Record the backup.
- [ ] Check again that nothing says what PnL leaves out with Coinbase answered, now that the sale's in. Then remove that answer in Settings > **Answers**. If anything that changes these steps merges after this, run them again.

**Skip until after the demo**
- Everything Low in Backlog, and WORK-447.
- The tax report and CAD on stage. They work, but they don't serve this story. Mention them in a sentence if asked.
- Switching dataset versions after 10:00 on Friday, unless you say so. Thursday night's replacement went in under the rule that a change that makes the demo better goes in now.
- `pnpm amp:start`, on demo day.

## After the demo

Say on WORK-448 that it's over. If you agree, the run there stops the staging jobs (0.2.0 and 0.1.0 of both `benface/pricetag` and `benface/pricetag_cautious`, and any older ones still running). After Friday 12:46 that needs a new admin token. Then turn **Sweep realized gains to savings** back on, and move what you want off the hot wallet.
