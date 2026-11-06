# How Amp held up

An honest account of building Pricetag on Amp, November 4 to 6, 2026. Private to this repo.

**How to read it.** Every claim says where it comes from: **measured** (we ran it, on the date of its issue), **code** (read from source), or **docs** (read from docs, not tested). An estimate says so. `WORK-n` links to an issue in this project's Multica workspace, which needs access to it, and `#n` links to `edgeandnode/amp`.

**What was tested.** Mostly `ampd` v0.0.42 locally, and staging's hosted Amp: workers at `584222f` on November 4 (measured, [WORK-321]), with `edgeandnode/base_mainnet@0.0.2`. Docs and code were read at `e0d7a394c`, and the points in [section 4](#4-where-it-falls-short) marked "Current" were rechecked on `5c966c6f3`, the latest `main` when we looked on November 5, and still the latest on November 6. Numbers dated Nov 6 are read-only reads of staging from 12:00 to 12:25 UTC, on `main` at `a25c96a9`, against `benface/pricetag@0.3.0`. Staging is a shared test environment, so its numbers say little about a production service, good or bad.

## 1. Verdict

**Amp delivered what this project depended on.** One SQL dataset put a USD price on Base transfers with no fork, no contracts and no indexer of ours. A six-table version reached chain head 29 minutes after the work started, and a full replacement takes about 4 minutes (measured).

**It falls short in five places:**
- **Data it doesn't carry:** traces, L1 fees and deposit fields. This cost us the most.
- **Wallet reads:** still no index on an account. Bloom filters now find one wallet's rows quickly, but a cold read still takes 13 to 33 s, mostly in other queries, and a very busy wallet still takes 46 s.
- **A job that dies:** stopping one job can panic another on its worker, and it stays down with no read error, so the numbers just freeze. We now run a small watcher for this.
- **The newest tagged release:** it can't deploy to staging, and getting write access took 2 hours.
- **Two claims that don't hold here:** "under a second behind the chain head" is close for raw data but not for the derived tables apps read, and Amp's own verification can't check a Base block.

**Would something else have been better?** For the whole idea, no: of what we read, only Amp offers live, hosted SQL with joins (docs, not tested). For parts of it, yes. SQD and Allium document both traces and an L1 fee on Base. Substreams has internal calls and balance changes but no L1 fee field, and Goldsky has Base traces and an L1 fee column whose docs don't name Base. Goldsky Feeds already sells a price per transfer. A wallet that only needs PnL would've been much faster on an API like Zerion's, without what makes this one honest.

## 2. The promise vs. what happened

### Claims

| Claim | Where | What we found | Basis | Result |
|---|---|---|---|---|
| "The data is tables, with no custom indexer to write" | [ampdb.com](https://ampdb.com) | True. 16 tables of SQL and 3 JS functions (`dataset/pricetag.json`). A hand-checked swap was within 0.0075% of Chainlink ([WORK-319]) | measured | **Held** |
| "A derived dataset is a SQL query Amp keeps updated block by block" | [ampdb.com](https://ampdb.com) | True, within the incremental rules in [section 4](#4-where-it-falls-short). `benface/pricetag@0.1.0` ran overnight with no failure events ([WORK-448]) | measured | **Held** |
| "Under a second behind the chain head" | [ampdb.com](https://ampdb.com), said of raw datasets | Close for raw data: a median of about 0.4–1.2 s on 200 ms blocks, and at most 4.7 s on Nov 5, and about 1 s and at most 2 s on Nov 6. But apps read derived tables, and `priced_legs` ran a median of about 4–6 s behind on Nov 5, at most about 11 s, and about 7 s on Nov 6, at most about 15 s. The line on the site's hero doesn't say it's raw only | measured | **Raw nearly, derived no** |
| "Correct through reorgs" | [ampdb.com](https://ampdb.com) | Held locally, but slowly for deep ones, and not every time. We forced 22 reorgs of 5 to 400 blocks through a local `ampd` on an Anvil fork of Base ([WORK-497]). Raw tables matched the new chain in 2–12 s, and 17 s once with the compactor off. `legs` took 3–18 s for up to 26 blocks, 22–49 s for 119–136, and 44–125 s for 277–353, because a derived job walks back to the fork one block at a time (`crates/atlatl/src/streaming_query.rs:1515` at v0.0.42). `priced_legs`, last in the chain, took longer: 18 s for 22 blocks, 58–79 s for 122–132, 72 s for 282 and 172–182 s for 339–343 (measured in 7 of the runs), and not within the 150 s we gave it at 353. Until then they return the old rows with no error, after a few seconds of failing queries. Four times in 12 reorgs over 250 blocks, Amp didn't recover while we watched: three times raw tables kept the old blocks for the whole 150 s or more, and once 4 derived tables failed every query ([WORK-519]). The app's streaming client matched the new chain every time Amp did, after a fix to where our stream resumes: in 20 s, 63 s, 73 s and 200 s in 4 of those runs, and 81 s for 132 blocks and 199 s for 339 with the final version of the fix. One that only polls used to miss a reorg older than a minute. Now it checks the last block it was told about on each poll ([WORK-520]), and in the one run since it said a 321-block reorg in 6 s and matched the new chain in 36 s. Only Anvil, so it says nothing about a real Base reorg | measured, code | **Held, slow when deep** |
| "Query as of a pinned revision and get the same answer every time" | [ampdb.com](https://ampdb.com) | Pinned hashes held: a wrong hash fails ([WORK-365]), a replay with different batches differed on 0 of 926 blocks ([WORK-330]), and two deployments matched on every row sampled ([WORK-376]). Two exceptions: a failed `eth_call` can commit a permanent NULL ([WORK-326]), and JS functions can see the clock and random numbers ([WORK-322]). Tags can move, as documented, and did so silently on us | measured | **Held, with gaps** |
| "Bad RPC data never lands": "With `--verify`, Amp recomputes header hashes and Merkle roots" | [ampdb.com](https://ampdb.com) | Can't work on Base. OP Stack deposits are unsupported, and every Base block starts with one. The feature is marked [experimental in the docs](https://github.com/edgeandnode/amp/blob/5c966c6f37203fe242175a9e407c1d7ec1fb5dec/docs/feat/verification.md), not on the site. `ampctl verify` fails every Base block with no reason given ([WORK-378], [#1819]) | measured, docs | **Not on Base** |
| "Stream results... with signals that tell your application which rows to replace" | [docs.ampdb.com](https://docs.ampdb.com) | The server does this. The TypeScript SDK's `client.stream` drops the block ranges those signals are, and dies on the 30 s keepalive, so we read Flight directly ([WORK-356], `packages/sdk/src/amp.ts:202`). Fixes are approved but unreleased: npm is still at 0.0.55, checked Nov 6 ([WORK-141], [142][WORK-142], [144][WORK-144]) | measured | **Server yes, SDK no** |
| "Any EVM chain" | [ampdb.com](https://ampdb.com) | The SQL carries over, and correct gas doesn't. On `ethereum_mainnet`, all 16 tables deployed with no SQL change, only constants, and came within 30 s of head in under 3 minutes (900 blocks, plus 7,500 back for feeds). But `tx_gas` assumes index 0 is an OP deposit, so it dropped the gas leg for 801 of 178,896 transactions, one per block. Polygon and BSC have ordinary transactions at index 0 too. Blob fees aren't in gas either, 0.8% to 24.8% of the total in 4 samples. Matched the chain: execution gas in 15 of 15 receipts, ETH and USDC prices at 2 of 2 blocks, and balances to the wei for 3 wallets, one of those only because an inferred arrival absorbed the dropped fee ([WORK-612]). Other raw datasets have Base's schema on Arbitrum, OP Mainnet and BSC, and Polygon differs. At head when checked: Ethereum, Arbitrum, Polygon, OP Mainnet, BSC. **Stale:** Avalanche (Aug 14), Linea (Aug 4), Unichain (Oct 11). Gnosis returned no watermark, and others weren't checked. `rpc.polygon_mainnet` fails, because that network's name is `matic`. No full deployment anywhere but Ethereum, and Arbitrum's gas wasn't tried. On Base itself, the shared schema still loses what OP Stack adds (L1 fee, deposit fields), and `gas_used` is cumulative ([WORK-338], [366][WORK-366], [605][WORK-605]) | measured | **SQL runs unchanged on Ethereum. Correct gas needs per-chain work, and only some raw datasets are fresh** |
| "Turns any RPC endpoint into Parquet you own" | [ampdb.com](https://ampdb.com) | True, but the public RPC stalled a local Amp for good until we added a relay of our own to pace requests ([WORK-333]). On 200 ms blocks a local Amp keeps up only once prices come from logs ([WORK-395], Base Sepolia) | measured | **Held, needs a real RPC** |
| Quickstart "takes about 10 minutes" | [docs.ampdb.com](https://docs.ampdb.com/get-started/quickstart) | Not timed as written. Its managed Postgres can't start on this Mac (`shmget` fails), so we used Docker ([WORK-319]) | measured | **Not tested** |
| Export to Snowflake or Postgres, offchain joins, Solana | [ampdb.com](https://ampdb.com) | Never tried | | **Not tested** |

### The numbers

**Time to a working dataset** (measured, by agents, so not a person's time):

| Milestone | Time from the start, 15:47 UTC on Nov 4 |
|---|---|
| Six tables at head on a local Amp, with a hand-checked price | 29 min |
| 11 tables on staging, 33 minutes at head with no job errors | 3 h 22 min, about 2 h of it waiting for a token that could write ([WORK-321]) |
| The app reading live staging data | 3 h 54 min |

**Sync speed** (measured):

| What | Result |
|---|---|
| Local raw and prices, public RPC at 20 requests/s, 1,800 blocks | 9 min 9 s ([WORK-333]). The RPC is the limit |
| Staging, all 13 tables then, about 5,350 blocks | 4 min 13 s, about 21 blocks/s ([WORK-376]) |
| Staging, a 2-table fork | 32 s ([WORK-376]) |
| A table with nothing to write, walking from genesis | About 148,000 blocks/s ([WORK-347]) |

**Query latency**, from this Mac over gRPC (measured):

| Query | Result |
|---|---|
| Raw `logs` by wallet: 5 min, 1 h, 6 h, 24 h | 1–2.5 s, 8–12 s, 21–24 s, 105 s. Time follows the range, not the wallet ([WORK-320]) |
| Dataset's three wallet queries, 33,272 blocks, quiet wallet with 4 `legs` rows | 8.3 s then 6.2 s for `legs` ([WORK-448]) |
| Same, busy wallet with 75,735 `legs` rows | 8.7 s then 4.8 s ([WORK-448]) |
| `legs` for the quiet wallet on Nov 5, 43,000 blocks, 10 rows, after the switch | 7.7 s and 10.8 s |
| `legs` for that wallet on Nov 6, with bloom filters, about 370,000 blocks, 10 rows | 1.1–1.9 s, 6 runs in a row just after other reads, so warm. It isn't a fair comparison with the row above. The fair one is three tables, 12 quiet wallets, median cold: 7.4 s without bloom filters, 3.1 s with. Warm, they were the same, 2.1 s and 2.5 s ([WORK-493]) |
| The app's full read, including balances and fees | Quiet, Nov 6, three fresh servers: 13 s, 14 s and 33 s cold, then 1.5–3.5 s for each of 9 next reads. The 33 s was the first of the three, and we don't know why. Before: 13–17 s cold with a bounded head lookup ([WORK-552]), 19–22 s before that. Very busy, one sample each and not repeated on Nov 6: 178 s cold before bloom filters and `counterparty`, 46 s after, and 36 s cold then 9 s next on the merged server ([WORK-493]). 142 s cold and 6 s per update before that, on `main` then (DEMO.md, [WORK-410]) |
| Fewer queries, each small samples | A head lookup with a lower bound: 8.0 s to 0.4 s ([WORK-552]). A read with nothing new: 2.1 s to 1.1 s, still 4 queries, now up to 3 at once ([WORK-515]). A long chart's second read: 9.5 s to 3 s, 22 queries to 5, with the same 132 RPC feed calls ([WORK-585]). Security on one wallet: about 25 s to 2.5 s, from the `approvals` table ([WORK-540]) |
| `eth_call` through Amp | About 30 ms per call on staging. It kept up with 2 s blocks, 1,030 of 1,030 in a row ([WORK-320], [321][WORK-321]) |

**Freshness** (measured, on staging):

| When | Raw `blocks` | Derived tables |
|---|---|---|
| Nov 4, by the clock, which only has whole seconds | 1–3 s | Median 2–6 s, and 10–11 s at worst, across 4 runs ([WORK-321], [365][WORK-365], [376][WORK-376]) |
| Nov 5, 13:54 UTC | | 5 s at worst, at one reading ([WORK-448]) |
| Nov 5 after the switch, 26 samples over 12.5 min, against the public RPC's head. Each is a range: blocks behind × 0.2 s, up to that plus the read's round trip | Median 0.4–1.2 s, at most 4.7 s | `reference_prices` median 1.0–2.5 s. `legs` 2.4–3.3 s. `priced_legs` 4.0–5.9 s, and at most 11.4 s |
| Nov 6, 12:02 to 12:14 UTC, 54 samples: 30 of each table's newest row, and 24 of how far its query metadata says it has reached. They agree. Same ranges as above. No read failed | Median 1.0–1.2 s, at most 2.0 s | `reference_prices` median 3.0–3.2 s, at most 8.2 s. `legs` 3.2 s, at most 6.8 s. `priced_legs` 6.6–7.2 s, at most 15.4 s. Amp's own `delay_seconds` read 6–7 s for the slowest table at the same time |

So derived tables run a little further behind than on Nov 5, with 16 tables instead of 15, two running versions of each dataset, and an Ethereum trial still running on another worker. We don't know how much each adds, if any. These are single windows on an early-morning weekday, and we didn't measure at demo time.

**Storage** (measured): 1.83 GB for the 15 tables and 0.04 GB for the fork, after about 18.5 hours of 2 s blocks ([WORK-448]). On Nov 6 at 12:09 UTC, 4.81 GB for `benface/pricetag@0.3.0`'s 16 tables and 0.12 GB for the fork, after about 41 hours, the last 18 on 200 ms blocks. `legs` is the largest at 1.08 GB. It's growing about 0.14 GB an hour (estimate from those two readings), so about 5.3 GB at the demo. The rates and feeds datasets round to 0.00 GB.

### The block switch, Nov 5

Base moved to 200 ms blocks at 18:00 UTC on Nov 5, ten times as many blocks. **It went on time and staging kept up: 5.00 blocks/s over 18:05 to 18:18 UTC, with raw and derived tables holding steady and no drift. `priced_legs` held about 25 blocks behind (measured, one 12.5-minute sample, with light load)**

Two earlier changes helped. [WORK-381] moved prices from `eth_call` to logs, so following the head needs no extra calls, and [WORK-395] turned the app's block counts into times. On Base Sepolia, the old `eth_call` table fell behind on a local Amp at every rate tried (measured). We never ran it on staging's real blocks, so we can't say it would have failed there.

Some costs do grow. `carried` writes about 10 times the rows: 10.54 a block, about 4.6M a day (measured over 3,000 blocks, [WORK-494]). A `legs` read opened 79 files on Nov 5, up from 63 two minutes earlier. On Nov 6 one opened 36, and the table's file count moved between 32 and 61 within 7 minutes, so it does settle with compaction (measured). [WORK-406] and [WORK-396] check the app and the RPC options at 18:25 and 18:30 UTC, and they're the authority on those.

### Reliability on staging

- **Jobs were solid.** No failure events across 33-minute, 16-minute and overnight runs, and one `ERROR` on the fork seconds after it deployed, with nothing since (measured, [WORK-321], [448][WORK-448]). `pricetag@0.3.0` had no failure event from 04:41 to 12:15 UTC on Nov 6. We can't see worker logs, so retries inside a worker wouldn't show.
- **Except for one panic, which stopping another job can cause.** On Nov 6 at 02:33 UTC, `pricetag@0.2.0` died with `FATAL` 4 s after we stopped two other jobs on its worker, and stayed down for 13 minutes until a `POST` restarted it, with no history lost (measured, [WORK-575]). All of a worker's jobs share one JS pool (code). A stopped job hands its JS isolate back while a call is still running on it, so the next call can panic, and panics aren't retried (code). Cancelling calls this way panicked uncancelled ones in 10 of 10 local runs on the pool at staging's commit, and never without cancelling (measured). It was 1 in 14 stops on that worker since Nov 3, so it's rare, but it can take down someone else's job. It's already filed as [#3187], from the same worker in September, and still open with no replies, checked Nov 6.
- **Then a job died with no stop nearby.** On Nov 6 at 04:39:57 UTC, about 100 s after we deployed `pricetag@0.3.0` on the same worker, `pricetag_cautious@0.2.0` went `FATAL`. `pricetag@0.3.0` logged `ERROR` in the same second, and `pricetag@0.2.0` logged `ERROR` at 04:42:32, and both retried by themselves (measured, job events). We stopped nothing around then ([WORK-493]). Before this, all 14 deploys on that worker since Nov 3 had been fine. So a deploy may be able to disturb other jobs, but this is timing only, one case, and we don't know the cause. It isn't known to be the same panic. Until someone knows, avoid both stops and deploys near a demo.
- **What the crash means.** `FATAL` isn't retried, whatever `retry_strategy: unless_stopped` suggests, and bounded reads keep answering with the same newest block and no error (measured, [WORK-574]). So an app sees frozen numbers, not a failure. A restart resumes the same job with no history lost: 13 minutes caught up in under a minute. Our answer is `scripts/job-watch.ts`, which checks every 15 s from launchd on this Mac ([WORK-577]). It handled the 04:39 death with no one watching: the job was rescheduled 8 s after it died. So "no process of ours" now has an exception, and it only works while this Mac is awake and online. It restarts through an admin token that expires at 12:46 EST on Nov 6. We don't know if a production Amp shares a JS pool across customers' jobs the same way.
- **The gateway wasn't.** Reads failed with `upstream connect error` or `Connection refused` in short bursts: three between 20:58 and 21:10 UTC on Nov 4 ([WORK-365]), and repeatedly during [WORK-364], which is why Verify's reads retry up to 4 times. On Nov 5, right after the switch, 7 of 104 of our head reads failed, in two bursts at about 18:07 and 18:09 UTC, each cleared within a minute (measured). Overnight on Nov 6, 24 of a batch of wallet reads through scratch servers failed with `Connection refused` from about 05:37 UTC, and all worked on retry. That was 88 wallets at most 4 at once, and those reads may have been the load that caused it ([WORK-626]). A separate run saw one refused connection at about 05:36 UTC ([WORK-605]). On Nov 6 from 12:02 to 12:14 UTC, none of our 216 small reads failed. We don't know the cause, and it's still the biggest risk to the demo.

## 3. Where it shines

These held up, and each would have been hard or slow without Amp.

| What | Why it matters | Evidence |
|---|---|---|
| **A derived dataset with no fork, contracts or indexer** | The whole pitch rests on this. `priced_legs` is SQL, and nobody runs a process for it, apart from the watcher in [section 2](#reliability-on-staging) | 15 tables running overnight, at most seconds behind (measured, [WORK-448]) |
| **A small dataset beside the big one** | Rates and the other 8 feeds each became their own dataset, so the main one wasn't replaced. Adding those feeds to `carried` would have cost far more | `feed_updates` adds about 330 rows a day, against an estimated 70.8M in `carried` ([WORK-494]). Both datasets round to 0.00 GB (measured) |
| **Replacing a dataset is cheap** | We registered about 14 versions on staging in about 5 hours, and each new one served alongside the old until it caught up. Pricing rules got better quickly because being wrong cost minutes | 4 min 13 s for a full replacement (measured, [WORK-376]). Version count from the issues |
| **A pricing rule is a dataset version** | A fork materializes 2 tables and reads the rest from its parent, so it can only differ by the rule. The server switches with one header, and a wrong hash fails instead of showing other numbers | About 55 MB a day against about 3.2 GB, and no app code for the rule (measured, [WORK-365]) |
| **The data can be audited** | The rows carry almost everything needed to recompute a block's hash and roots, so a client can catch a wrong answer | 45 of 45 sampled blocks passed all three checks, and changed, missing or reordered rows fail (measured, [WORK-364]). This is our code, and deposit fields come from an RPC, see [section 4](#4-where-it-falls-short) |
| **A price traced to a log** | Each price is a specific Chainlink log in a block the same check covers | 5,073 of 5,395 blocks identical to `eth_call`, and the other 322 are the expected ETH lead (measured, [WORK-381]) |
| **Progress without rows** | Any one-shot query's metadata says how far Amp had got in the tables it reads, even with nothing to return. So one empty query says how far a read can go, on a quiet chain too | 150 to 270 ms, down from 1.5 to 2.5 s for one newest-row query per table, on staging ([WORK-521]) |
| **A last-known value without state** | A bounded range join plus an aggregate stands in for an as-of join | Replay gave 0 differences over 926 blocks (measured, [WORK-330]) |
| **Historical state through SQL** | `rpc.base_mainnet.eth_call` reads any block, so we need no archive node of our own | Reads worked at blocks 22,000,000 and 37,700,000 ([WORK-320]). Balance reads for 200 blocks took under 700 ms ([WORK-348]). Both measured |
| **Asking the whole chain a question** | Questions that would each need a script against an RPC took one query. Which contracts emit `AnswerUpdated`? (201 in a day.) Who calls Coinbase's payout contract? (One sender, 1,437 ETH payouts in a day.) Do two versions agree? (`EXCEPT ALL`, inside Amp.) | Measured ([WORK-330], [424][WORK-424], [376][WORK-376]) |

## 4. Where it falls short

Ranked by what it cost us. "Current" says what was checked against `main` at `5c966c6f3` or staging on Nov 5, or the date it gives.

### 1. No traces

**Cost: the most of anything here.** ETH sent by a contract is invisible, including refunds, router payouts and Coinbase's batched withdrawals. We guessed from WETH `Withdrawal` logs, and the guess could show a false gain of $2,227 instead of $0.37 with a ✓ on the position (measured on real amounts in a synthetic wallet, [WORK-348]). Fixing it took [WORK-348], [361][WORK-361], [389][WORK-389], [405][WORK-405], [411][WORK-411] and [424][WORK-424], plus [WORK-374], [430][WORK-430] and [444][WORK-444] for naming the sender. Recovering one transfer takes about 40 balance reads, and the sender is still a best guess (measured, [WORK-424]). ETH leaving unseen is still only flagged.

**Current:** the EVM RPC dataset still has only `blocks`, `transactions` and `logs` (code). The Phaser provider has `enable_traces`, but its status is "development" and the only bridge found needs a customized Erigon ([docs](https://github.com/edgeandnode/amp/blob/5c966c6f37203fe242175a9e407c1d7ec1fb5dec/docs/feat/provider-phaser.md), [WORK-367]). Traces aren't committed to in block headers, so they couldn't be verified the same way.

### 2. Facts that stay on RPC receipts

**Cost: high, and it never goes away.** Three separate gaps:
- **No L1 fee** ([WORK-366]). Every Base transaction pays one, so computed ETH drifts without it, and a derived dataset can't add it. So the server reads receipts from an RPC (`packages/sdk/src/receipts.ts:90`). On the public one that's about 10 a second, and a wallet sending about 10 transactions a second never gets checked (measured). `BASE_RPC_RATE_LIMIT` now lets a dedicated RPC go faster ([WORK-369]), but the demo stays on the public one, and it's still an RPC.
- **`gas_used` is the block's running total** ([WORK-338]), with no note in the schema doc, and `gas_price` is NULL on type 2 transactions. Getting a fee takes the previous row plus the base fee, which is why `tx_gas` exists. It does reproduce the receipt exactly (measured).
- **No deposit fields** (`sourceHash`, `mint`, `isSystemTx`), so a deposit's hash can't be rebuilt from Amp ([WORK-378]).

**Current:** `gas_used` still comes from `receipt_cumulative_gas_used`, and there's no `l1_fee` (code, [`crates/providers-evm-rpc/src/tables/transactions.rs:303`](https://github.com/edgeandnode/amp/blob/5c966c6f37203fe242175a9e407c1d7ec1fb5dec/crates/providers-evm-rpc/src/tables/transactions.rs#L303)).

### 3. Slow wallet reads

**Cost: high, and most of it shows up as app complexity.** There's no index on an account, so before bloom filters, a wallet read cost about the same however few rows it returned. That's why the app has a per-wallet cache, reads only new blocks, and shares raw reads between rules ([WORK-407]). It's why a slow read could say "Offline" ([WORK-457]), why the demo must never restart the server on stage, and why a very busy wallet skips blocks ([WORK-410]).

**Current, better than the paragraph above, but it didn't change what a person waits for.** One `EXPLAIN ANALYZE` each of `legs` for a wallet with 10 rows (measured):

| | Nov 5, filters we never configured | Nov 6, `account` filters we set ([WORK-493]) |
|---|---|---|
| Row groups left by bloom filters | 49 of 74, in a run minutes earlier | **4 of 73** |
| Data scanned | 8.85 MB | 10.77 MB |
| Files | 79 | 36 |
| Time | 0.67 s of processing | 0.12 s of processing, and 4.07 s opening files, summed across 16 partitions |

That backs up our earlier inference that the time is file and object store work, not data volume. Three copies of the dataset put a number on it: `legs` row groups left of total were 31 of 67 serving, 17 of 53 in a control, and 3 of 60 with filters. `legs` was 844 MB on all three, so the filters' cost didn't show. They're marked experimental in the [docs](https://github.com/edgeandnode/amp/blob/5c966c6f37203fe242175a9e407c1d7ec1fb5dec/docs/feat/datasets-manifest-bloom-filters.md), only new files get them, and we had to pick the `ndv` ourselves (200,000 for `legs` and `unlisted_legs`, 20,000 for `priced_legs`).

**What the whole app gained was less.** The demo wallet's cold read went from 23 to 22 s, and a very busy wallet's from 178 to 46 s, one sample each. That replacement also added `legs.counterparty`, which removed raw `logs` and `transactions` scans from a read, so we can't say how much of the 132 s was bloom filters. Most of a cold read was never in those queries. One 18.1 s read, before these fixes, was 22 queries in a row: 6.7 s on one unbounded head lookup, 4.1 s on the three wallet queries, and most of the rest on about 20 small ones. We have no breakdown of the 13 to 14 s on Nov 6.

**A per-wallet stream works, and is off.** `legs WHERE account = ...` matched bounded reads, 174 of 174 rows over 324 blocks on the final code. It saves about 0.3 s of a 2 s update on the demo wallet, and takes a busy wallet's data reads from 8.3 s to 2.5 s, but its full update only from about 12.7 s to 10.6 s, 6 samples each ([WORK-584]). Those timings predate a merge that went from four streams to three. It hasn't been through a real reorg, and 2 gateway errors in about 25 minutes with streams on, against none in about 10 without, is too few to judge ([WORK-611]).

### 4. SQL limits in incremental datasets

**Cost: medium.** The 5 planned tables became 15. Without `LEFT JOIN` or anti joins, an unpriced row can't stay in `priced_legs`, so "unknown" has to be rebuilt in the app, and [WORK-346]'s wrong-price fix needed a new table. A wrong-shaped start filter silently walks from genesis, and being under a `GROUP BY` counts as wrong-shaped ([WORK-347]). The worst part was shapes that registered fine and only failed in the job, some retrying forever ([WORK-319]).

**Current, better than our notes say.** We ran these shapes through staging's `POST /schema` on Nov 5, which validates without writing anything (measured, schema check only, none of them materialized):

| Shape | Staging on Nov 5 | [WORK-319], v0.0.42 |
|---|---|---|
| Two joins, both keyed on `_block_num` | **Accepted** | Rejected |
| Two general joins | Rejected, with a clear message saying what to do | Rejected |
| `LEFT JOIN` | Rejected | Rejected |
| `NOT EXISTS` | **Rejected up front** | Registered, then fatal in the job |
| Window function | Rejected, with a confusing message: `ts()` is not supported | Rejected |
| `DISTINCT` with `block_num()` | **Accepted** | `DISTINCT` rejected, though possibly without `block_num()` |
| `GROUP BY` without `block_num()` | Rejected | Rejected |

So "one join per table" is out of date for joins on the block number. Outer and anti joins remain out by design (docs, [`docs/feat/sql-join-streaming.md`](https://github.com/edgeandnode/amp/blob/5c966c6f37203fe242175a9e407c1d7ec1fb5dec/docs/feat/sql-join-streaming.md)).

### 5. No state across blocks

**Cost: little time, but the biggest limit on the product.** PnL can't be a shared table, so every client replays a wallet's legs, and "top wallets by realized PnL" can't be asked ([WORK-322]). We planned for this from the start, so it didn't surprise us. [WORK-322]'s design for a keyed fold is about 2 to 4 months to a usable slice (estimate). [#479] dropped the earlier stateful attempt, and we found nothing open that replaces it (GitHub search).

### 6. Failure modes that give no error

**Cost: medium, and we walked around most of it.**
- **`eth_call` out of retries** writes a permanent NULL and reports no failure: 72 of 4,748 calls on a shared public RPC, and 19 NULL prices in one 554-block run (measured, [WORK-326]). Our workaround turns it into a job error.
- **A filter above `eth_call`** hung with no error, even for one block. It looks like one call per block on the chain (inferred from the plan), and our 7 tries may have sent tens of thousands of calls to staging's provider ([WORK-328]). The docs recommend that shape ([WORK-329]).
- **A JS function returning `null` or throwing** retries forever and stops every table in the dataset (measured, [WORK-319], [183][WORK-183]).
- **A JS BigInt of 2^255** silently becomes NULL (measured, [WORK-322]).
- **A job that goes `FATAL`** leaves bounded reads answering with the same newest block and no error (measured, [WORK-574]). See [section 2](#reliability-on-staging).

Moving prices to logs ([WORK-381]) removed the first two from the dataset's path, but current prices of the other 8 tokens, balances and approval checks still use `eth_call`, and so do exchange rates until `PRICETAG_RATES_DATASET` is set.

### 7. Tooling and access

**Cost: nearly 3 hours on day one.**
- **Write access:** two tokens failed with `Jwt issuer is not configured`, which says nothing about what to get instead. An `amp-admin` token worked, 2 hours later (measured, [WORK-321]).
- **`ampctl` v0.0.42 can't deploy to staging.** It always sends `concurrency`, which staging rejects, and `dataset status` can't parse staging's response. We deploy with a raw `POST`. It's still the newest tagged release, from September 28 (measured, GitHub on Nov 6). Nightlies carry the fix (code).
- **`ampctl verify`** prints `Verified 0/1 blocks` with no reason, at any log level (measured, [WORK-378]).
- **`ampctl --help` and `ampsql --help` print `AMP_AUTH_TOKEN`.** That put a staging token in our run logs, and `ampctl dataset deploy --help` did it again on Nov 6 with the admin token. The same run's `ampctl provider list --json` returned 42 providers, 33 of them with real-looking `auth_token` values, none masked (measured, [WORK-321], [322][WORK-322], [605][WORK-605]).
- **Registering an existing tag moves it with no warning** (measured, [WORK-376]). That's documented, but it broke another run's reads.
- **One manifest under two names shares its tables,** so a rename needs a deliberately different hash (code, [WORK-376], [276][WORK-276]).

### 8. TypeScript SDK

**Cost: low to medium.** `client.stream` can't be used (see [section 2](#claims)), `client.query` crashes on list columns, so `SELECT *` on `transactions` fails ([WORK-339]), and it can't read `Utf8View` ([WORK-142], [WORK-376]'s `tx_gas`). Fixes are approved upstream, but npm's latest is still 0.0.55 (checked Nov 6). We reach into `@edgeandnode/amp/proto` for streaming, which is fragile, and the wallet stream added a second client on those protos, `createRowStream`.

### 9. Docs

**Cost: low, except for the hang.** The `(...).data` example returns HTTP 500 ([WORK-319]). The recommended `eth_call` shape hangs ([WORK-329]). The docs say block-number joins stack, while the newest tagged release rejects them ([WORK-319]). The docs are thorough on the whole, and `docs/feat/*.md` was often the fastest way to the real rule.

### 10. History we never loaded

**Cost: unknown, and it limits the demo.** Staging's raw data goes back to genesis, but our tables start at block 53,515,446, so anything older has an unknown cost. We chose that to move fast, and never tested a longer range ([WORK-495]). At the 21 blocks/s we measured, all of Base would take about a month, though older blocks are lighter, so that's an upper-end estimate. Chainlink's two aggregators also changed twice each in the last 7 months, so an older start needs their old addresses too (measured, [WORK-330]).

## 5. What we still don't use Amp for, and why

Checked against `main` at `a25c96a9`, with a search for `eth_call`, `fetch` and JSON-RPC methods. `dataset/local.ts` and `scripts/` also make RPC calls, but they're local tools.

**Through Amp, nothing to do** (code): the chain head and new-block signal (`packages/sdk/src/dataset.ts:72`, `packages/sdk/src/amp.ts:208`), a wallet's legs and prices (`dataset.ts:170–195`), its counterparties, now a `legs` column that replaced raw `logs` and `transactions` scans ([WORK-493]), its approvals from the `approvals` table (`server/approvals.ts`), ETH and USDC prices, market prices, cost notes (`server/source.ts:78`), payouts (`dataset.ts:333`), block rows for Verify (`server/block.ts:81`), and dataset hashes. The web and Mac apps read all of these through our server. Only raw mode, the fallback with no dataset, still scans `logs` and `transactions` for a wallet (`server/source.ts:138–193`, `server/approvals.ts:207`).

**Through Amp, but an RPC call underneath:**

| Data | Where | Could it avoid the call? | Worth it? |
|---|---|---|---|
| Exchange rates | `updateRounds`, or `feedRounds` without a rates dataset, `packages/sdk/src/rates.ts:18` | **Built and running, but the demo's `.env.local` doesn't turn it on.** `benface/pricetag_rates@0.1.0` is at head, and logs matched `eth_call` on 231 of 231 and 30 of 30 ([WORK-479]). The head and recent blocks still read the contract, since the table only has rows on updates, and Verify doesn't cover rates | **Yes, after the demo.** One env line, and the job watch then covers it too. A demo in USD reads no rates, so it doesn't matter on stage |
| Current prices for the other 8 tokens | `readFeedRoundsAt`, `packages/sdk/src/dataset.ts:367`, `updateFeedRounds`, `server/source.ts:39` | **Partly done.** History and Verify's proofs read logs from `benface/pricetag_feeds@0.1.0`, and logs matched contract reads on 240 of 240 and 48 of 48. What's held now stays on `eth_call`, because a table with rows only on updates can't show it has reached the head ([WORK-494]) | **No more to do,** unless Amp says how far such a table has reached. Logs didn't make reads faster, and the gain was proofs for all 10 tokens |
| Whether an approval is still active | `server/approvals.ts:256` | No. An allowance is state, and the event only says what was granted | **No** |
| Balance checks and finding unseen ETH | `packages/sdk/src/balances.ts:81`, `dataset.ts:308` | No. Balances aren't in logs. Amp has no state table | **No.** This is Amp at its best |
| Raw mode's prices | `server/source.ts:106` | Not needed | **No.** It's the fallback |

**Around Amp:**

| Data | Where | Could Amp do it? What's missing | Worth it? |
|---|---|---|---|
| L1 fees | `packages/sdk/src/receipts.ts:90` | Yes, if `transactions` had `l1_fee` ([WORK-366]). Its provider already reads receipts (code) | **Yes.** Top ask after traces. Removes the public RPC's 10/s cap and an RPC from the read path |
| Deposit fields for Verify | `server/block.ts:147` | Yes, with 3 more columns ([WORK-378]) | **Yes,** and it's needed for OP Stack verification anyway |
| Verify's check against Base's node | `server/block.ts:168` | Not usefully. It's new since Nov 5, and it's there to compare Amp's block hash with someone other than Amp | **No,** on purpose |
| New-aggregator checks at start, now for prices, rates and token feeds | `server/feeds.ts:18` | Yes, with `rpc.eth_call` today | **No.** Saves a few calls a start |
| Block of a Coinbase delivery | `server/coinbase.ts:152` | Not as fast. Finding a hash in `transactions` is a scan, and the row arrives later | **No** |
| Spending Money's balance, nonce, gas and prices | `macos/HotWalletKit/.../Chain.swift:150`, `HotWallet.swift:214` | Mostly, through our server. It needs "latest" right now, and the wallet shouldn't depend on our server to move money | **No,** on purpose |
| A device's balance, activity and ETH price, on its pages | `src/core/device-read.ts` | Mostly, through our server, and for the same reason it shouldn't | **No,** on purpose |
| Sends, gas estimates, receipts of sends | `Chain.swift:201–216`, `src/core/cold.ts:199` | No. Amp doesn't send or estimate | **No** |
| Sites' reads through the extension | `.../Sites/SiteBridge.swift:165` | No. It's a passthrough of any RPC read | **No** |
| Simulating a call | `.../Sites/CallPreview.swift:58` | No. `eth_simulateV1` isn't an Amp function | **No** |
| Coinbase purchases | `server/coinbase.ts:172` | No. Not chain data | **No** |

**So:** still true. The app's reads could all come through Amp except for two columns' worth of data, L1 fees and deposit fields. Everything else around it is sending, a deliberate second opinion, or money-moving code that should stay independent.

## 6. How to use more of it

### What we could do now

**Done since Nov 5:**

| Did | Result | Still open |
|---|---|---|
| **Exchange rates from logs** ([WORK-479]) | Live as its own dataset, and it matched `eth_call` on 231 of 231 and 30 of 30 | Not turned on in the demo's env. Verify doesn't cover rates |
| **The other 8 feeds from logs** ([WORK-494]) | Live as its own dataset, about 330 rows a day. Every listed token's price has a proof, and all 10 passed Verify on real wallets. No number changed | Held prices still use `eth_call`, and logs aren't faster |
| **Bloom filters on `account`, and `legs.counterparty`** ([WORK-493]) | Row groups 73 to 4, and three tables on quiet wallets from 7.4 s to 3.1 s cold, nothing warm. The demo wallet's whole cold read went from 23 to 22 s, and a very busy wallet's from 178 to 46 s, one sample each | Bloom filters are experimental. We can't separate their gain from `counterparty`'s |
| **Per-wallet stream** ([WORK-584]) | Merged and off. About 0.3 s of a 2 s update on the demo wallet, and 12.7 s to 10.6 s on a busy one | No real reorg yet, and timings predate the final code ([WORK-611]) |
| **Fewer queries** ([WORK-515], [552][WORK-552], [585][WORK-585]) | A head lookup from 8.0 s to 0.4 s, a read with nothing new from 2.1 s to 1.1 s, and a chart's second read from 9.5 s to 3 s. Our own code, not Amp's | A test-only follow-up is open as PR #193 |
| **Approvals from their own table** ([WORK-540]) | Security from about 25 s to 2.5 s on one wallet | |

**What's left,** ranked by value:

| # | Do | Gain | Unknown |
|---|---|---|---|
| 1 | **Try a longer history** on a separate test dataset, say 30 days ([WORK-495]) | Fewer unknown costs, the demo's biggest limit | Time, storage and old aggregator addresses. Never measured |
| 2 | **A second chain, done properly:** fix the fee hidden by an inferred arrival, then per-chain constants and gas ([WORK-612], [613][WORK-613], [614][WORK-614]) | "Any chain" is much of the pitch, and the SQL already runs on Ethereum | 2 to 3 days for the SDK and dataset (estimate). Apps and sending are more ([WORK-615], [616][WORK-616]) |
| 3 | **Find where a cold read's 13 s goes now** | It's what a new user waits through, and it may be our queries rather than Amp | No breakdown since the fixes landed |
| 4 | **Check the wallet stream against a real reorg,** measure it again, then decide ([WORK-611]) | Helps busy wallets' updates some, and quiet wallets barely | Reorgs, gateway errors |
| 5 | **Turn on the rates dataset** | Fewer `eth_call`s for wallets not in USD. One env line | Nothing much. Add Verify for rates if anyone needs it |
| 6 | **Ask for compressed results** ([#3377] merged) for busy wallets | Smaller transfers for 75,000-row reads | Client support not checked. A busy wallet's 59 MB reply is ours to shrink first ([WORK-565]) |
| 7 | **Join on the block number directly,** now that those joins stack | Fewer stages | Only schema-checked, so low value on its own |

**Tried or read, and not worth it now:**
- **`client.stream`:** switch back once [WORK-141] and [144][WORK-144] ship, and delete `createRangeStream` and `createRowStream`.
- **`amp-react`:** version 0.0.0, not published, and streaming is still a design (`streamQuery`, docs). Our token must stay on the server anyway. Useful if we ever show SQL or dataset details in the web app.
- **`ampsync` or ADBC export to Postgres:** would give instant wallet lookups with an index. Never tried, and it brings back a database to run, which undoes the pitch. Keep it for if reads stay slow.
- **Static datasets for the allowlist:** status "development" (docs), and the app needs the list compiled in too.
- **Other chains:** now tried on Ethereum, see [section 2](#claims). It's item 2 above, after the demo.

### What needs Amp to change

| Change | What it unlocks |
|---|---|
| Traces | Complete wallet history, and most of `settleUnwraps` goes away |
| `l1_fee`, per-transaction gas, effective gas price, deposit fields | A wallet's cost with no RPC, and OP Stack verification |
| OP Stack verification | "Verified by Amp", instead of by our own server |
| Isolate the JS pool when a call is cancelled, and retry or surface a `FATAL` | Stopping one job can't freeze another, and we can drop the watcher ([#3187]) |
| Outer joins on block equality, as-of joins | `priced_legs` keeps unpriced rows, and `carried` goes away. [WORK-322] puts outer joins first, since they need no state |
| A way to look up one account quickly | First reads that don't scan the whole range |
| Keyed fold | Shared positions, PnL and cost tables |

## 7. Alternatives, compared honestly

**How far to trust this.** All of it is from each vendor's own docs, and nothing was signed up for or tested. Speed figures are their claims. We spot-checked the pages the conclusions rest on (Goldsky Feeds and Turbo, Sim, Zerion, SQD, Substreams, and each L1 fee claim). The rest were read through a tool that summarizes pages, so check before acting on them. Most vendor pages we read still describe 2 s blocks, so don't assume any has been tested on 200 ms.

| Option | Traces on Base | L1 fee | Custom logic, and who runs it | Better than Amp on | What we'd lose |
|---|---|---|---|---|---|
| **Amp** (measured) | No | No | SQL with joins plus JS, no state. Hosted or self-run | Baseline | |
| **Graph subgraphs** | Not stated for Base, and call handlers bind to named functions | No field | Stateful handlers, hosted | State across blocks, and economic security through attestations | Slower to index a whole chain, per Envio's benchmark. Solves neither gap |
| **Substreams** | **Yes,** with balance changes: The Graph lists Base as Extended blocks, though we didn't confirm the current endpoint | No field for it. Balance changes are a separate thing, and have no L1 fee reason | Rust/WASM. Stores cap at 3.5 GiB, and it needs a sink | **Exact ETH changes per account,** which fixes invisible ETH at the root. Best data model here | SQL and a query layer. Too heavy for a hackathon |
| **Envio** | Paid add-on, on request, from block 24M | `l1_fee` field exists, but the docs don't name Base | Stateful handlers, hosted | Backfill speed (claim), per-wallet history through HyperSync, and the L1 fee if Base fills it | Live SQL. Traces cost an unpublished price |
| **Goldsky Turbo** | **Yes,** `base.raw_traces` in its catalog. `native_transfers` for Base only seen in a search extract | `receipt_l1_fee` column exists, but the docs don't name Base | SQL with **no joins, aggregates or windows when streaming,** plus TS. We run the database | Internal ETH, backfill speed (claim), and the L1 fee if Base fills it | Our joins would be a real rewrite, and there's no hosted query API |
| **Goldsky Feeds** | Internal transfers not confirmed | Not listed | None, a fixed API | **Closest thing to `priced_legs`:** per-wallet transfers with `price_usd` at block time, null when untrustworthy, Base back to June 2023. No dataset to build | The rule forks, source labels and any audit. `amount_usd` "can change as pricing improves", while we treat a price as a fact. No cost or PnL |
| **SQD** | **Yes,** plus state diffs, from genesis | **Yes,** `l1Fee`, with Base named | Stateful handlers. We run them or pay for hosting | **Best raw coverage of our gaps for the money,** self-hostable (AGPL), and signed responses | "One dataset, no infra": we'd run an indexer and a database |
| **Ponder** | Through your RPC's `debug_trace*`, which docs warn is slow and costly | Not in docs | Full SQL in handlers. Self-hosted | **Live client queries** (`@ponder/react`), and developer experience | Every block costs RPC calls at 5 blocks/s, and it follows named addresses, not arbitrary wallets |
| **Dune** | **Yes** | Yes, through `gas.fees`, about 10 min behind | Batch SQL only, hosted | **Auditing our numbers** against `base.traces` | Live use: 1–15 min behind for raw data |
| **Sim (Dune)** | | | | Nothing | **Shut down on August 1, 2026** |
| **Allium** | **Yes,** `base.raw.traces` | **Yes,** `receipt_l1_fee` on its Base table | SQL endpoints, enterprise only | A ready-made PnL table, `fungible_pnl_5min` | Hackathon access. Its PnL API's Base support is unclear, it's average cost only, and we found no `unknown` state |
| **Moralis** | Yes, internal transactions | Not listed | None | Internal ETH lookups only | PnL only sees Uniswap V2 and V3 swaps, and leaves out gas |
| **GoldRush (Covalent)** | Yes, `with-internal` | Not listed, and `fees_paid` may understate | None | **Cheap per-wallet internal ETH,** about 0.05 credits an item | Doesn't replace the dataset. PnL rated "Limited" on its own comparison |
| **Zerion** | Not stated | One fee, no split | None | **A PnL number on screen in an afternoon,** on 40+ chains | Our rules: mints get zero cost, some airdrops count as purchases, and unpriced tokens are left out. Plus any explanation of a number |
| **Alchemy** (comparison only, not recommended) | Transfers API has `internal` on Base. `debug_*` on Base not confirmed | On receipts | None | Per-wallet internal ETH, about 120 compute units a call | Doesn't replace the dataset |
| **RPC plus Postgres** | Where the provider allows it | **Yes** | Anything, and all the operations are ours | Control, and everything's available | Everything Amp removes. Tracing each block at 5 blocks/s costs an estimated $400 a month at list prices for an unconfirmed Base offering, and about 3 months to backfill |

**Plainly, on each part:**
- **Internal ETH:** Amp is behind nearly everyone here. SQD, Dune, Allium and Goldsky document traces on Base, and The Graph lists Extended blocks for it on Substreams. This is a gap specific to Amp, not a hard problem everyone shares.
- **L1 fees:** the picture is more mixed. SQD and Allium name it on Base, and Dune has it about 10 minutes behind. Goldsky and Envio have the field without naming Base, and Substreams has none.
- **History from genesis, in a table:** SQD, Dune and Goldsky Feeds are ahead. Amp has the raw data, but we never measured deriving from it.
- **State across blocks:** subgraphs, Envio, SQD and Ponder all have it, and Amp doesn't.
- **A wallet's speed:** vendors claim 27–100 ms on their per-wallet paths (untested), against 1–2 s warm for one table here, and 3 s cold for three tables, with bloom filters.
- **Selling price per transfer:** Goldsky Feeds does it today. What's still ours is source labels, an open dataset you can fork, and cost worked out in the client with an honest `unknown`.
- **Where Amp still leads:** of what we read, only Amp offers live, hosted SQL with joins. The fork-a-rule story comes with it: 2 tables, 32 s, no code.
- **Verifiability:** no product here returns proofs that we could find. The Graph has attestations and SQD has signed responses, which are accountability rather than proof. But our check isn't unique to Amp either. It works on any source that returns complete block rows, including a plain RPC, and we didn't check which vendors do.

**If we started over:**
- **The same pitch:** Amp again. Nothing else we read gets a shared price table from SQL alone.
- **Traces as a hard requirement:** SQD into Postgres, or Substreams for balance changes. We'd give up "one dataset, no infra".
- **Just a wallet that shows PnL:** Zerion, in an afternoon, or Goldsky Feeds plus our own fold, which keeps `unknown` and looks like the best shortcut here. That has nothing to do with the hackathon's idea of testing Amp.
- **Patching Amp's gap now:** a per-wallet internal ETH lookup like GoldRush's would replace most of `settleUnwraps`. It adds a vendor, an API key and sharing wallet addresses, so we'd only do it if Amp won't get traces soon.

**Not tested:** all of the above. **Not found or unclear:** whether Goldsky and Envio fill their L1 fee fields on Base, `native_transfers` on Base, Substreams' current Base endpoint, Feeds' internal transfers, Allium's PnL API on Base, and The Graph Market's prices.

**Sources:** [Graph manifest](https://thegraph.com/docs/en/subgraphs/developing/creating/subgraph-manifest/), [Graph networks](https://thegraph.com/docs/en/supported-networks/), [Substreams blocks](https://docs.substreams.dev/reference-material/chains-and-endpoints), [Substreams on Base](https://www.streamingfast.io/blog/substreams-for-base-network-now-available-45ae8), [Firehose schema](https://github.com/streamingfast/firehose-ethereum/blob/develop/proto/sf/ethereum/type/v2/type.proto), [Envio networks](https://docs.envio.dev/docs/HyperIndex/supported-networks), [HyperSync fields](https://docs.envio.dev/docs/HyperSync/hypersync-query), [Goldsky Feeds](https://goldsky.com/products/feeds), [Goldsky's Base traces](https://app.goldsky.com/explore/base/raw_traces), [Turbo sources](https://docs.goldsky.com/turbo-pipelines/sources/evm), [Turbo schemas](https://docs.goldsky.com/turbo-pipelines/reference/schema/EVM-schemas), [Turbo transforms](https://docs.goldsky.com/turbo-pipelines/transforms/overview.md), [SQD on Base](https://sqd.dev/chains/base/), [SQD's L1 fields](https://docs.sqd.dev/en/sdk/squid-sdk/evm/reference/evm-stream/field-selection), [Ponder call traces](https://ponder.sh/docs/call-traces), [Ponder accounts](https://ponder.sh/docs/config/accounts), [Dune traces](https://docs.dune.com/data-catalog/evm/base/raw/traces), [Dune gas fees](https://docs.dune.com/data-catalog/curated/gas-fees/overview), [Sim's end](https://www.alchemy.com/blog/migrating-from-sim-to-alchemy-data-apis), [Allium's Base transactions](https://docs.allium.so/historical-data/supported-blockchains/evm/base/raw/transactions), [Allium PnL](https://docs.allium.so/historical-data/supported-blockchains/evm/base/assets/fungible-pnl-5min), [Moralis PnL](https://docs.moralis.com/data-api/data-features/data-enrichment/profitability-pnl), [GoldRush traces](https://goldrush.dev/docs/resources/traces-support), [Zerion PnL](https://developers.zerion.io/recipes/wallet-pnl-tracker), [Alchemy transfers](https://www.alchemy.com/docs/reference/alchemy-getassettransfers), [Base debug API](https://docs.base.org/base-chain/api-reference/debug-api/debug_traceBlockByNumber.md).

## 8. Top asks for the Amp team

Ranked by what it would change for an app like this.

| # | Ask | Evidence | Issue |
|---|---|---|---|
| 1 | **Traces in EVM data,** from a recent block if history is hard, labeled as not verifiable | False $2,227 gain, about 9 issues, 40 reads per transfer, and PnL still partial for wallets with unseen ETH leaving | [WORK-367] |
| 2 | **Complete receipts on OP Stack:** `l1_fee`, the transaction's own gas, effective gas price, deposit fields | A public RPC in every read path, and a 10 fees/s cap on the public RPC | [WORK-366], [338][WORK-338], [378][WORK-378] |
| 3 | **Quick lookups by one column,** like an account, and make bloom filters stable with a sensible `ndv` | Bloom filters took one wallet's `legs` from 73 row groups to 4 and about 1–2 s warm, which is promising, but a very busy wallet's first read still took 46 s. Most of the app's cache and read logic exists for this | None yet |
| 4 | **Don't let stopping a job panic another, and don't leave a `FATAL` job looking healthy** | 13 minutes of frozen numbers on Nov 6 with no read error, and another `FATAL` right after a deploy with cause unknown. We run a watcher on a Mac for this. It can take down someone else's job | [#3187], [WORK-575] |
| 5 | **Keep hosted and tagged releases compatible,** and release more often | v0.0.42 can't deploy to staging or read its status, and it's over 5 weeks old | Not filed, below the bar |
| 6 | **Verify OP Stack blocks, and say why a check failed** | Our server already rebuilt 45 of 45 Base blocks. The encoding is in `server/verify.ts`. Every Base block fails today, silently | [WORK-378], [#1819] |
| 7 | **Fail the batch when `eth_call` runs out of retries** | Permanent NULL prices with no job error | [WORK-326] |
| 8 | **Fix the filter pushdown above `eth_call`,** and the docs that recommend it | A silent hang, and possibly a huge number of paid calls from a one-block query (inferred from the plan) | [WORK-328], [329][WORK-329] |
| 9 | **Outer joins on block equality, then as-of joins** | Extra tables like `unlisted_moves` and `carried`, and "unknown" rebuilt in each client | [WORK-322] |
| 10 | **Ship the TypeScript SDK fixes** | We read Flight's protos directly to stream | [WORK-141], [142][WORK-142], [144][WORK-144], [339][WORK-339] |
| 11 | **Don't print tokens in `--help`, or unmasked credentials in `provider list`** | Happened to us three times, the last with an admin token, and `provider list --json` returned 33 real-looking `auth_token` values | Not filed, below the bar |
| 12 | **Make JS functions strict and failures local** | One bad row stops every table, and the sandbox has the clock and random numbers | [WORK-183], [322][WORK-322] |
| 13 | **Keyed fold** | Shared PnL. Largest, and it depends on 7 and 12 | [WORK-322] |
| 14 | **Say which layer "under a second" means, that `--verify` excludes OP Stack, and which chains' raw data is current** | See [section 2](#claims). Someone evaluating Base would hit the first two. Avalanche, Linea and Unichain's raw datasets were weeks to months stale on Nov 6, and `rpc.polygon_mainnet` isn't the name that works | None |

No new issues were filed in the `amp` project: everything that meets its bar already has one. Ask 11 is not filed, and whether the `provider list` output needs telling its owners is benface's call ([WORK-605]).

## 9. What's safe to say in the demo

**Safe, as `DEMO.md` says it:**
- One derived dataset with no fork, validators or contracts.
- "There's no indexer of ours to run." True on staging, where Edge & Node runs Amp. If asked: we also run a small script through the demo that restarts a job if it dies.
- Verify "recomputes the block's hashes from what Amp returned," and the list of what it doesn't prove.
- Prices come from Chainlink's logs and each swap's implied rate. Every position's balance is checked against the chain. That's the balance, not each fee ([WORK-612]). Nothing on Base is known to trigger that gap.
- A pricing rule is a dataset version, with no app code for the rule.
- Every listed token's current price has a proof with a log behind it. All 10 passed on real wallets, and the price itself is still read from the contract ([WORK-494]).
- "No traces, so we found it from the balance," in step 5. It's honest, and it's the right thing to tell this audience.

**Change these. [WORK-452] has been told:**

| `DEMO.md` says | Problem | Say instead |
|---|---|---|
| "Three things are hard anywhere else" | Too strong. [Section 7](#7-alternatives-compared-honestly) shows others can do parts of each | "Three things this made easy" |
| "At most 6 s behind the chain (*measured*)" | Not true now. On Nov 6, `priced_legs` was a median of about 7 s behind and at most about 15 s, over 54 samples. `legs` was about 3 s, at most about 7 s. It was measured before the switch | "Seconds behind the chain." If asked: "Transfers about 3 seconds, prices about 7" |
| "About 4 GB" (`main`), "about 2 GB" (PR #103) | It was 4.81 GB at 12:09 UTC on Nov 6, growing about 0.14 GB an hour (estimate) | "About 5 GB," or drop it |
| "Verify proves a price," under "Why it needs Amp" | Our server's check, not Amp's. `ampctl verify` fails on every Base block, and deposit fields come from an RPC | "Amp's data lets us check a price against the block." If asked: "Amp's own verifier doesn't support Base yet, so we wrote this one" |

**Don't say:**
- "Under a second" or "verified by Amp," without what's above.
- "Any EVM chain." Say: "The same SQL ran on Ethereum, but correct gas needs per-chain work, and only some chains' raw data is fresh."
- "Bloom filters made it fast." The demo wallet's cold read barely moved, 23 to 22 s, and a very busy wallet's 178 to 46 s, one sample each. A read past the first is what's quick.
- "Correct through reorgs," with nothing after it. We forced them locally on Anvil, not on Base ([WORK-497]), and deep ones took Amp up to about 3 minutes, or didn't recover. Say: "We forced reorgs through a local Amp. Up to 136 blocks, 27 seconds of Base, the app fixed itself within a minute and a half."
- "All through Amp." L1 fees and deposit fields come from an RPC, and sends always will.
- "We could add PnL leaderboards." It can't be a shared table, and it isn't this product anyway.
- "Nobody else prices transfers." Goldsky Feeds sells a price per transfer. Ours is different because it's an open dataset with source labels, a forkable rule, and an honest `unknown`.

**If someone asks what was hard:** traces, then wallet read speed, then a job dying silently on the night before. It's better to say so.

**For the morning of the demo:** cold reads were 13 s, 14 s and 33 s on Nov 6, and the next reads 1.5–3.5 s, so read the wallet before going on. Don't stop or deploy staging jobs (see [section 2](#reliability-on-staging)). Anything that says otherwise predates the 04:39 death. These numbers are one early morning's, and the gateway is still the biggest risk.

[WORK-141]: https://multica.ai/benface-work/issues/01a19dbd-28fc-7ea3-ba4b-246d0de8190f
[WORK-142]: https://multica.ai/benface-work/issues/01a19dbd-2b3e-7c8b-a8d6-9e5065528833
[WORK-144]: https://multica.ai/benface-work/issues/01a19dbd-2f9b-7eb3-b138-3010cbf0bb66
[WORK-183]: https://multica.ai/benface-work/issues/01a19e03-471b-7885-b26d-c970733ec846
[WORK-276]: https://multica.ai/benface-work/issues/01a1a1a4-f8a9-7277-85d2-7ed5a7bb7d42
[WORK-319]: https://multica.ai/benface-work/issues/01a1a73e-8bb7-79b4-bac4-5e715acaaf55
[WORK-320]: https://multica.ai/benface-work/issues/01a1a73e-8f3f-7ef4-bd01-dd862b4bc4ef
[WORK-321]: https://multica.ai/benface-work/issues/01a1a73e-9237-7e92-8c87-3488f65f7c58
[WORK-322]: https://multica.ai/benface-work/issues/01a1a73e-9539-7c8b-9126-8cfc2f93c074
[WORK-326]: https://multica.ai/benface-work/issues/01a1a750-b566-7925-a2e8-e0c2077aac9f
[WORK-328]: https://multica.ai/benface-work/issues/01a1a75d-367b-746d-838a-19005102b7ba
[WORK-329]: https://multica.ai/benface-work/issues/01a1a75d-3962-70f5-b5f6-de781dbfa649
[WORK-330]: https://multica.ai/benface-work/issues/01a1a75d-3c5d-7a48-84ee-b60e8c747c4b
[WORK-333]: https://multica.ai/benface-work/issues/01a1a76e-8001-7463-b0b5-d8fb3b07b13b
[WORK-338]: https://multica.ai/benface-work/issues/01a1a789-cdeb-7589-9e86-e1bf2586c548
[WORK-339]: https://multica.ai/benface-work/issues/01a1a789-d0a0-7e39-b13c-981f10c4732a
[WORK-346]: https://multica.ai/benface-work/issues/01a1a7d4-73cc-758c-8ecc-11d1301ec57f
[WORK-347]: https://multica.ai/benface-work/issues/01a1a7f7-355a-7a35-8cc5-ec5f64cf68ca
[WORK-348]: https://multica.ai/benface-work/issues/01a1a811-40a9-7517-8718-5eeb1f937b2e
[WORK-356]: https://multica.ai/benface-work/issues/01a1a835-291d-7c05-b6ea-1338d84caa0f
[WORK-361]: https://multica.ai/benface-work/issues/01a1a84d-da66-7d93-9734-337a26ba40db
[WORK-364]: https://multica.ai/benface-work/issues/01a1a854-ac7d-7dae-abba-1498c80382ec
[WORK-365]: https://multica.ai/benface-work/issues/01a1a854-af2c-7f35-a97a-d8402b3b9cf0
[WORK-366]: https://multica.ai/benface-work/issues/01a1a854-f48a-7733-836a-021d6f7797d4
[WORK-367]: https://multica.ai/benface-work/issues/01a1a854-f821-79c5-8f64-72f4c7cc0fd7
[WORK-369]: https://multica.ai/benface-work/issues/01a1a85f-bce1-710b-a1b5-174bc4aa09cd
[WORK-374]: https://multica.ai/benface-work/issues/01a1a864-e788-74ef-8505-737e42ed1d01
[WORK-376]: https://multica.ai/benface-work/issues/01a1a869-8634-79bf-9129-8a8424a80f6b
[WORK-378]: https://multica.ai/benface-work/issues/01a1a874-1d40-7172-9332-af9de2f9724c
[WORK-381]: https://multica.ai/benface-work/issues/01a1a87c-bb6c-7beb-a68a-c896d8275fba
[WORK-389]: https://multica.ai/benface-work/issues/01a1a8a2-3b8e-7787-8460-85232c590582
[WORK-395]: https://multica.ai/benface-work/issues/01a1a8bb-5008-732c-8327-3dc7cbd5419e
[WORK-396]: https://multica.ai/benface-work/issues/01a1a8bb-53ed-72ea-ae01-b8b794605457
[WORK-405]: https://multica.ai/benface-work/issues/01a1a8dc-ed6a-777d-ae15-0b15764f2cf9
[WORK-406]: https://multica.ai/benface-work/issues/01a1a8e0-ba35-75be-b8fa-60f04baa0fca
[WORK-407]: https://multica.ai/benface-work/issues/01a1a8e3-913f-7012-8e25-09d73f81e0f8
[WORK-410]: https://multica.ai/benface-work/issues/01a1a8fe-42b6-7bf6-9a9b-ca1274603f69
[WORK-411]: https://multica.ai/benface-work/issues/01a1a8ff-1450-71c9-94a7-89a6773ac0bb
[WORK-424]: https://multica.ai/benface-work/issues/01a1a9a7-6f9c-7562-8b91-5f0f33f334f5
[WORK-430]: https://multica.ai/benface-work/issues/01a1a9bc-2dfc-7d7a-bf43-8295ab3cdbc9
[WORK-444]: https://multica.ai/benface-work/issues/01a1aa00-7387-7901-bb6b-ea6665988c34
[WORK-448]: https://multica.ai/benface-work/issues/01a1aa10-8c0c-7208-a157-f6333c066b22
[WORK-452]: https://multica.ai/benface-work/issues/01a1aa20-3411-77d7-bf9e-807be2ae7bc0
[WORK-457]: https://multica.ai/benface-work/issues/01a1aa49-e9c6-7565-91cd-430ebc9b9c84
[WORK-479]: https://multica.ai/benface-work/issues/01a1acb9-8570-73a7-a117-ac48deb055a9
[WORK-493]: https://multica.ai/benface-work/issues/01a1acf0-ac98-7082-8ae8-02280abafc24
[WORK-494]: https://multica.ai/benface-work/issues/01a1acf0-b035-74d7-95c1-86616c797330
[WORK-495]: https://multica.ai/benface-work/issues/01a1acf0-b3b9-70df-ac74-e7f964f347b3
[WORK-497]: https://multica.ai/benface-work/issues/01a1acfb-4a15-7718-b36d-9c5c03aae7c1
[WORK-515]: https://multica.ai/benface-work/issues/01a1ad06-5ef9-763a-a537-e5d5d202ad89
[WORK-519]: https://multica.ai/benface-work/issues/01a1ad4a-d011-7430-8447-bb5443d76b0c
[WORK-520]: https://multica.ai/benface-work/issues/01a1ad4a-d2ec-7501-9a5b-1095fea392d3
[WORK-521]: https://multica.ai/benface-work/issues/01a1ad4a-d5ac-7704-9537-87f64c961ae0
[WORK-540]: https://multica.ai/benface-work/issues/01a1ae3c-5a8e-750d-a29a-d92fed08b4c8
[WORK-552]: https://multica.ai/benface-work/issues/01a1ae83-a37f-79a2-b5bb-257ab02a975c
[WORK-565]: https://multica.ai/benface-work/issues/01a1ae9e-3f52-72a1-a900-230f0e7e8ef7
[WORK-574]: https://multica.ai/benface-work/issues/01a1aecd-afbb-767c-a545-1bc402dfa931
[WORK-575]: https://multica.ai/benface-work/issues/01a1aece-4d0e-7e87-b10c-736721709d0b
[WORK-577]: https://multica.ai/benface-work/issues/01a1aee6-20bf-7c16-a462-ca3c3bc287eb
[WORK-584]: https://multica.ai/benface-work/issues/01a1af17-2b33-7b2d-999d-dbf1a2cc911c
[WORK-585]: https://multica.ai/benface-work/issues/01a1af1b-a49b-77a8-b75e-0c09a8408de4
[WORK-605]: https://multica.ai/benface-work/issues/01a1af50-3577-7963-a755-f2628df337ff
[WORK-611]: https://multica.ai/benface-work/issues/01a1af61-ce0e-73e3-9bc6-8c9c9ac08f13
[WORK-612]: https://multica.ai/benface-work/issues/01a1af67-93b6-779d-a78f-7a6ead4596e1
[WORK-613]: https://multica.ai/benface-work/issues/01a1af67-96c8-7c4b-a8b2-065f2c734292
[WORK-614]: https://multica.ai/benface-work/issues/01a1af67-99cd-7599-a1f9-41f946a8e0aa
[WORK-615]: https://multica.ai/benface-work/issues/01a1af67-9c54-7123-b555-0551b03113dc
[WORK-616]: https://multica.ai/benface-work/issues/01a1af67-9f53-788c-abbf-87b703ed88e7
[WORK-626]: https://multica.ai/benface-work/issues/01a1afd2-6013-7c23-874e-e204a734597c
[#479]: https://github.com/edgeandnode/amp/issues/479
[#1819]: https://github.com/edgeandnode/amp/issues/1819
[#3187]: https://github.com/edgeandnode/amp/issues/3187
[#3377]: https://github.com/edgeandnode/amp/issues/3377
