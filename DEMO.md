# Demo plan, Friday November 6

All times are Montréal. Numbers marked *measured* come from the real server against staging, overnight on November 4 to 5, before Base's block switch. Button names come from the code on `main` at `fe822c4`. Nobody has clicked through this in the real window yet, so the rehearsal is the test.

## The story

**The line:** every transfer gets a price, and your wallet finally knows what you paid.

**The problem.** A chain records what moved, not what it was worth. So wallets show a balance, and nobody can say what you paid or whether you're up.

**What we built.** Pricetag is one Amp derived dataset on Base, with no fork, validators or contracts. It reads Chainlink's own logs and each swap's implied rate, then puts a USD price on transfers of ETH and 9 other listed tokens. A token off the list shows up with no price, and it's never guessed. Patina is a self-custody Mac wallet built on those prices.

**Why it needs Amp.** Three things are hard anywhere else:
1. **The dataset is SQL over Base's raw data,** so there's no indexer of ours to run. It's 15 tables, about 1 GB, at most 6 s behind the chain (*measured*).
2. **Verify proves a price.** It recomputes the block's hashes from what Amp returned, and checks Chainlink's log behind the price.
3. **A pricing rule is a dataset version.** Switching rules re-reads the wallet through another version, with no app code for any rule. Each one is pinned to its fingerprint.

**What's new.** The price is a shared fact in the dataset, and what you paid is personal, so your own app works it out. What it can't work out says "unknown". It's never guessed and never counted as $0.

**It's not a trading app.** Patina helps you invest, and sometimes trade when the timing is right. Nothing in it rewards trading more.

**Don't claim:**
- "Every token." It's 10 assets. The rest are listed with no price.
- "Verify proves the SQL or the chain." It doesn't show that the header is on Base's real chain, that the SQL ran correctly, or that Chainlink's number is right. Say so, because it's more convincing.
- "Audited." The hot wallet is an unreviewed build, for small funds only.
- "Tested on a real Ledger or Keystone," until the rehearsal has done it.

## Click by click

About 5 minutes. **Before you start:**
- The server has been running for at least 5 minutes, with the wallet already read once under each rule, so nothing's a cold read.
- USD, Average cost, and the Market price rule.
- The Coinbase question is **unanswered**, and what you paid is on a sticky note.
- The main window and Settings are arranged side by side.

| # | Do | Say | Should appear |
|---|---|---|---|
| 1 | Click the menu bar item | "This is my real wallet, with real money. A small amount, on purpose." | Value, PnL and holdings. PnL is marked partial |
| 2 | Open the main window | "It only has what I've done since Wednesday at 14:24, when the dataset starts. Every position is checked against the chain to the smallest unit." | Holdings with check marks, and a warning that ETH's cost is unknown |
| 3 | Click cbBTC's number in the holdings | "Any number opens what's behind it: what moved, at what price, and where that price came from." | Details on the right, with each row's price source and cost |
| 4 | On a swap's row, click **Proof**, then **Verify block …** | "This recomputes the block's hashes from what Amp returned. It doesn't prove my SQL or Chainlink's number, and it says so." | About 11 s (*measured* on the $1 swap), then "The data Amp stored for this block matches its header, and so does Chainlink's update behind this price" and 5 passed checks |
| 5 | Click **Resolve** in the toolbar | "My ETH came from Coinbase inside a batched payout. No transaction points at my wallet, and this data has no traces. We found it from the balance. So it asks, instead of guessing." | "Who's this?" with "From a Coinbase address" |
| 6 | **My exchange account**, type what you paid, **Save**, **Done** | "That stays on this Mac. Now everything adds up." | PnL is no longer partial, and ETH has PnL. "Compared with holding ETH" and a full chart appear |
| 7 | In Settings, pick **Cautious ETH** | "Same transactions, different recipe. It counts ETH 1% lower. That's a second dataset version, two tables, with no app code for it. Here's its fingerprint." | The numbers change on their own |
| 8 | **Compare Side by Side…** | "Same block, same facts. The only difference is the rule." | ETH price differs by 1% and Value by 1% of the ETH held. About 11 s (*measured*) |
| 9 | Switch back to **Market price**. *Optional:* **Spending Money**, **Send**, $1 to your savings, Touch ID | "It sends too. Savings stay on a hardware wallet, and Spending Money has a cap." | "On its way", then "Done", and the numbers update by themselves. Cut this step if it takes over 15 s in rehearsal |
| 10 | Close | "One dataset, with no fork and no contracts. Price is a fact, and what you paid is yours." | |

**Compare's amounts are small on a $45 wallet,** about $0.20. If that falls flat, show the screenshot from the [recording list](#backup-recording): a busy public wallet came out at $548,006 vs $544,586 (*measured*). Don't paste that wallet live. Its first read took 142 s and its Compare 57 s (*measured*, see WORK-410).

### What changes when the open work merges

WORK-452 rewrites the steps for whatever has merged by Thursday at 13:45.

| Issue | State at writing | Change to the steps |
|---|---|---|
| WORK-429 | Merged | Nothing: Send asks for Touch ID in the same window |
| WORK-426 | Reviewed, PR #65 | Sidebar with Overview, Transactions, Spending Money (⌘3) and Tax Report. **Resolve** becomes **Fill In** on the holding, or Answer Questions… (⇧⌘R). The rule is in Settings > General, and the RPC and sweep settings are in Settings > Spending Money. The chart gets ranges, and waits for 3 known transactions over 5 minutes. A change only shows when nothing's left out at either end. **The Mac app no longer has a demo wallet in Release builds** |
| WORK-431 | In review, needs 426 | Wallet button in the toolbar instead of Change Wallet. ⌘L still works |
| WORK-432 | In review, needs 426 | New popover, with Send and Top Up in it. Step 9 can start there |
| WORK-442 | Handed off, not merged | Guided Add a Savings Wallet for Ledger and Keystone. Only affects setup, and the optional device moment |

## Wallet setup

**Use the hot wallet you already have,** `0x3762…5D89`. It holds $5 today (*measured*): a Coinbase payout, one $1 swap to USDC, and one open question. Always copy its address from Patina's Spending Money, not from this file or any message. Only you do these steps. No agent touches keys or funds.

| When | You do | Why |
|---|---|---|
| **Before funding** | Add your savings wallet if you can, then check the cap | Cap is $50 by default with savings, and at most $25 without. Without savings, cut every amount below to about half |
| **Thu by 9:30** | Withdraw **$40 of ETH from Coinbase** on Base. Write down the total you paid for both withdrawals, this one and Wednesday's | This is what makes WORK-424 visible, see below. Earlier is better: the chart's one-day change needs a known point from before the range starts, so this has to be at least 24 h before the demo |
| **Once it shows in the app** | With the extension on `app.uniswap.org`, swap **$12 of ETH to cbBTC**, then **$12 of ETH to AERO**. Don't answer the Coinbase question | Costs that are really paid, and prices that move. Waiting avoids landing in the payout's block, which would leave costs unknown. Each row should show a dollar cost. If one says unknown, see below |
| **Thu after 14:00** | In Settings, turn off **Sweep realized gains to savings**. Then swap **half the AERO to USDC** | Gives Realized a number, adds a transaction after the block switch, and won't sweep on stage. Sell into USDC rather than ETH, because ETH paid out through a contract is the hardest case |
| **Fri morning** | **Undo Last Answer** if Coinbase was the last thing you answered. Otherwise Settings > **Forget All My Answers**, then re-enter any other answers | Puts steps 5 and 6 back on stage |

**If a swap's cost says unknown, don't buy again.** A later purchase doesn't repair the earlier one, and answering Coinbase doesn't either. Click the row and read its reason, then:
- **It says a contract's ETH couldn't be confirmed:** wait a few minutes, because this can clear by itself.
- **It asks "What did this cost?":** answer it. That fixes the token's cost, and selling it later gets a Realized number.
- **It says another token moved in that transaction:** the ETH you paid stays "sold or spent at an unknown price", and no answer clears that (*reproduced*). So PnL stays partial on this wallet for good, and a recording would show the same. Put the transaction's hash on WORK-448. Then change step 6 to "what it can't price stays flagged", and don't promise a complete number.

**Cost:** $40 of new money, which stays yours and moves with the market. Fees should be under $0.50 in total. The $1 swap's network fee was $0.0023 (*measured*), and Coinbase's withdrawal fee and Uniswap's fees are on top. Keep the wallet under the cap, or a sweep can start by itself.

**Why Coinbase and not a plain send:**

| Funding | What the app does | Result |
|---|---|---|
| **Coinbase withdrawal** | Finds ETH with no transaction to the wallet, and asks "Who's this?" with "From a Coinbase address". **My exchange account** then takes what you paid | **Exact PnL** (*measured:* typing $5.10 gave a complete PnL of −$0.10), and the best moment in the demo |
| Plain send from your own wallet, answered **My wallet** | Its cost comes from that wallet, so anything it held before Wednesday 14:24 stays unknown | **PnL stays unavailable** |
| Plain send, answered **Someone else** | Uses the price when it arrived | Complete, but marked as an estimate (*measured*). This is the fallback if Coinbase is slow |

If this withdrawal pays from a different contract, the app can't name it (WORK-444), so you may get a second card without "Coinbase". It still works, but change what you say in step 5.

### Buying on stage (WORK-462)

**Optional, and only after a real purchase has worked in rehearsal.** Press **Buy** in the toolbar, enter $3 of ETH, **Continue on Coinbase**, and pay by card. It opens Spending Money, where the purchase says "On its way", then "Delivered", then "Cost $X, fees included". Say: "No question this time. Coinbase's order says what I paid, and it matches what arrived exactly." The row in Transactions says "Cost: Bought on Coinbase".

**To show a larger amount:** type more than the room left, and the sheet says how much stays and that the rest goes to your savings, but stop there, because the trial limit won't let it through. If you do buy more than the room left: what lands above the cap sweeps by itself, with Patina open, and that needs a savings wallet you've checked on a device. Coinbase's page lets you change the amount but not the token. Its row in the savings wallet says the same cost and source.

**Coinbase's trial limit is CA$6.99 a transaction (*measured*).** It refused $5 of ETH, which is about that before fees. $3 should fit, but that's not tried yet. Larger purchases need full access (https://support.cdp.coinbase.com/onramp-onboarding), so don't plan on one on stage. A refusal shows on Coinbase's page, or in the sheet as Coinbase said it. Use the fallbacks below.

A real card purchase on stage can fail, and a real delivery can take minutes, so don't let the demo depend on one:
- **Best:** do a real purchase before you go on, and show its finished row and its cost in Transactions. Open with "I bought this an hour ago".
- **Recording:** add a clip of a real purchase to the backup recording.
- **Mocked:** set `COINBASE_ONRAMP_MOCK` to `1` in `.env.local`, restart the server, and turn on Coinbase's mocked mode on its page: click "Secured" 10 times, open **Actions**, and toggle **Enable Mocked Buy and Send**. Nothing's charged and nothing arrives, so the row stays at "Waiting for you on Coinbase", and it doesn't record a cost. It only shows the page. Use **I Didn't Buy It** to clear it.

## What could go wrong

| Problem | How you'd know | Do this |
|---|---|---|
| **Public RPC rate limit** (WORK-336's failed swap) | A send or site approval fails, or a balance says not checked. Verify's Transactions says not checked. Shared wifi makes it worse | Set `BASE_RPC_URL=https://base-rpc.publicnode.com` in `.env.local`, restart the server, and paste the URL into the **Network** field in Settings. WORK-396 may change this choice Thursday at 13:30 |
| **Base's block switch**, Thu 13:00 | WORK-406 reports at 13:25 and WORK-396 at 13:30 | Rehearse only after both. If Base delays it, they say so. If `edgeandnode/base_mainnet` stalls, that isn't ours to fix: ask in `#amp-hackathon` and use the recording |
| **Staging dataset behind** | The app says "Catching up", and the 8:00 health checks report it | A few seconds is fine: keep going, it's the honest behavior. If it's stuck, use the recording. Don't run `pnpm amp:start`: it starts with empty history, so this wallet would have none |
| **Only the fork fails** | The rule switch or Compare errors | Stay on Market price and skip steps 7 and 8 |
| **Admin token** expires Fri 12:46 | Only a write fails | Reads don't use it. The read token lasts until April 2027 (*checked*, not printed). So no `dataset/` merges after Thursday 18:00. A replacement or stopping the jobs after 12:46 needs a new token |
| **Slow reads** | A cold read took 19–22 s, warm 3–4 s (*measured*). They may grow by Friday, and the app's query timeout is 60 s | Don't restart the server on stage, since a restart means a cold read. Read the wallet before you go on. The health checks measure this |
| **Wifi** | Everything real stops, with "Couldn't read this wallet's data" | Phone hotspot, tested in rehearsal. If that fails, the demo wallet or the recording |
| **Server on 8787 not running** | The app says the server's gone | In the repo: `pnpm start`, then wait for the first read. Keep it in its own terminal, not the one you'd close |
| **Ledger or Keystone misbehaves** | Anything off in [the checklist](HARDWARE-WALLETS.md#checklist-for-a-real-device) | Nothing in the main flow needs one. Fallback is a browser wallet like Rabby. Ledger needs Chrome, the Ethereum app open and Ledger Wallet closed. Leave devices off stage unless they pass twice |
| **Everything's down** | | Open `http://localhost:8787/?address=demo`. The server still sent the page and its data with Amp unreachable (*measured*): 8 holdings and 13 chart points. Check it in a browser during rehearsal. Say it's demo data. It has no Verify or Compare. After WORK-426 it's web only |

**Stage basics:** turn on Do Not Disturb, plug in power, run `caffeinate -d`, and check the menu bar item isn't hidden on the projector's resolution. Don't connect to a live site or show Uniswap on stage: it's a failure path, and it's the wrong message for this app.

### Backup recording

**Thursday, right after the first clean rehearsal.** Redo it Friday morning if the app has changed.
- **Screen:** all 10 steps with no voice, about 4 minutes, saved locally and on your phone.
- **Stills:** Verify's passed checks, the chart once answered, Compare on this wallet, and Compare on a busy public wallet. Read that wallet ahead of time.

## Rehearsal checklist, Thursday November 5

**Morning**
- [ ] Read the 8:00 health check on this issue.
- [ ] Fund and buy, as above.
- [ ] Right after the buys, answer the Coinbase card. There should be no other question and PnL shouldn't say partial. If it does, read what it leaves out, and see above. Then **Undo Last Answer**.
- [ ] Review WORK-426, then 431 and 432. Merging 426 starts WORK-449's test on real data, so read its results if they're in by 14:00.
- [ ] Say on WORK-448 what time the demo is.
- [ ] Make one small real purchase with **Buy…** (steps on WORK-462), and check its cost shows with no question.

**Fix before rehearsing**
- [ ] WORK-426, 431 and 432 merged, or decided against. WORK-452 then updates the steps.
- [ ] Decide about the demo wallet in Release (WORK-426's question 2). I'd leave it out and use the web page as the fallback.
- [ ] Run `pnpm mac` last from your own folder, on `main`. Each run points the extension at that build, so a run from `pricetag-test` leaves it on the wrong one.

**From 14:00, after WORK-406 and WORK-396 report**
- [ ] Sell half the AERO.
- [ ] Run the 10 steps twice with a timer, on the projector's resolution if you can. It should take under 5 minutes.
- [ ] Note what really appears at each step, and say on WORK-448 what differs.
- [ ] Check the Send step's real time, then keep it or cut it.
- [ ] Stop the server and bring it back. Switch to the hotspot. Try the PublicNode fallback.
- [ ] Go through the device checklist once, with a few dollars. Decide whether a device goes on stage.
- [ ] Record the backup.
- [ ] Check again that PnL isn't partial with Coinbase answered, now that the sale's in. Then undo that answer, and freeze `main`. After that, merge only what the demo needs, then run the steps again.

**Skip until after the demo**
- Everything Low in Backlog, and WORK-439, WORK-446 and WORK-447.
- The tax report and CAD on stage. They work, but they don't serve this story. Mention them in a sentence if asked.
- Replacing the dataset, unless it's broken.
- `pnpm amp:start`, on demo day.

## After the demo

Say on WORK-448 that it's over. If you agree, the run there stops the staging jobs (`benface/pricetag@0.1.0`, `benface/pricetag_cautious@0.1.0`, and any older ones still running). After Friday 12:46 that needs a new admin token. Then turn **Sweep realized gains to savings** back on, and move what you want off the hot wallet.
