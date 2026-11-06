# Hot wallet security checklist

The Mac app's hot wallet ("this device's spending money") is an unreviewed hackathon build. It's meant for small funds only, and it assumes it will get hacked: the cap is what makes the risk acceptable. This lists what it does, what's been checked and how, and what it doesn't protect against.

To check it yourself: `pnpm check:mac` for the logic, `pnpm check:keychain` for the real Secure Enclave and Keychain, `pnpm check:anvil` for real signing against a local fork of Base, and `pnpm check:extension` for the browser extension on a real site, through to that fork.

## The key

- [x] Generated only with `SecRandomCopyBytes` (`SecureRandom` in `KeyVault/Secp256k1.swift`). There's no parameter for a seed, and no way to import a key.
- [x] Signed only with Bitcoin Core's libsecp256k1, called directly through its C API. Nonces are RFC 6979 and S is low, both from the library.
- [x] Wrapped with HPKE (RFC 9180, from CryptoKit) to a Secure Enclave P-256 key, so there's no cryptography of our own. The wallet's address is authenticated, so a blob can't be swapped for another wallet's.
- [x] Stored in a device-only Keychain item: `AfterFirstUnlockThisDeviceOnly`, never synchronizable, in the data protection Keychain. `pnpm check:keychain` reads these attributes back from a real item.
- [x] The key is only in memory to sign, in `SecretBytes`: locked out of swap and wiped when it goes out of scope. CryptoKit's copy of the decrypted bytes is wiped too.
- [x] No API returns a key. `Signer` can only create, sign, check for and delete one. Nothing logs or transmits it.
- [x] Every signature is recovered and compared to the wallet's address before anything is broadcast.
- [x] No debugger: release builds leave out `get-task-allow` (`macos/run.sh`).
- [ ] **Swift's own copies aren't provable.** CryptoKit's internals may hold copies we can't reach. Wiping is best effort.
- [ ] **The enclave doesn't sign.** It can't use Ethereum's curve, so the key is decrypted in memory to sign. Malware running as this user could ask for it, or read it from memory. That's why there's a cap.

## Touch ID

Manual sends (Send, Publish a Cost, Sweep Everything, Replace Key, Delete) and anything a site asks to send or sign ask for Touch ID, or the login password where there's none. Automatic sweeps don't, because they have to run with nobody there.

Send, Sweep Everything and site requests ask with no click, as soon as what's being approved is on screen, inside the same window (`LAAuthenticationView`), so nothing covers it. Where that isn't possible, like with no sensor in reach or after too many tries, macOS's own dialog asks, and its text names the site and what leaves. What keeps a touch from approving something unseen (`ApprovalPrompt`):

- [x] Nothing asks until its window is visible, key, and in the active app, and an inline prompt stops if that changes. The approval window floats, so another window can't cover it.
- [x] Nothing asks until a strong warning has been acknowledged. Acknowledging is a click that waits a second after the window opens.
- [x] The next prompt waits 2 seconds after any answer, yes or no, so a second touch can't approve what comes next. This holds across windows, and for a request that arrives after the last one has gone.
- [x] Each ask has its own `LAContext`, with no reuse window, so no touch counts twice.
- [x] A cancelled prompt leaves the request waiting, and only a click asks again. Rejecting is one click, and Escape does the same.
- [x] Backing out works up to the touch. It calls off the prompt the moment it's accepted, before anything changes on screen, so a touch landing just after can't send what's been left. Past the touch, nothing offers to back out, because what's been approved is on its way.
- [x] An interrupted prompt doesn't ask again until the view on screen is paired with its new context, or it would be a dialog over the details. `macos/shot.sh site-refocused` fails if that doesn't happen.

- [ ] **It isn't enforced by the enclave.** The same wrapping key has to open with no prompt for sweeps, so the prompt lives in the app. It stops someone at an unlocked Mac, not malware running as this user.

## Where money can go

- [x] Automatic sweeps only go to the chosen cold wallet, and only ever call a contract on the compiled-in allowlist. A test checks both the allowlist and the feeds against `src/core/tokens.ts`.
- [x] A send goes wherever the user says, after Touch ID, but only ever moves ETH or calls a token on the allowlist. It refuses zero, this wallet, retired keys and token contracts, and an address with a wrong EIP-55 checksum. It's checked again against a fresh read before signing, and it stops during an alarm or a rotation.
- [x] A send of ETH leaves the gas reserve, so it can't strand the tokens that are left.
- [x] Publishing a cost signs a zero-value transaction from this wallet to itself, with data that says only the transaction, token and amount, and warns first that it's public for good. It can only come from this app's Resolve screen.
- [x] Revoking an approval, from the Security page, only ever sets one to nothing: `approve(spender, 0)` on a token on the allowlist, or Permit2's `lockdown`, after the same review and Touch ID as a send. Approvals on any other token or collection are only listed, because calling one would break the rule below.
- [x] Sends, notes and revocations are written to disk before they're broadcast, like sweeps, so they can't raise the alarm.
- [ ] **A send's address is only as good as this screen.** Malware running as this user could change what's pasted, or what's shown. That's why there's a cap, and why Touch ID's prompt repeats the amount and the address.
- [x] Unknown tokens are never called, not even to read their balance. They're listed separately, from Amp's data.
- [x] Every signature includes chain ID 8453, so nothing signed can be replayed on another chain. Nothing is signed if the node says it's on another chain.
- [x] Sweeps move tokens as they are, with no selling.
- [x] A cold wallet's address must be confirmed by the user against the device's screen. The app has no device code, so it can't check that itself. It does check the EIP-55 checksum, and refuses this wallet's own address, retired keys and zero. A `patina://add-savings` link from the web app's device flow can fill in that sheet, and so can the camera reading a Keystone's receive screen, but anyone can make a link and a compromised Mac could change what's read, so it still adds nothing until the user says the address matches. A new link takes that answer back. Any other accounts a link names are listed, and only link costs if the user ticks them. Nothing's ever swept to them.
- [x] The camera entitlement is only for that read. It starts on that step and stops when it's left. Frames stay in memory while they're read and are never saved, and only a plain address counts: any other code's contents are dropped without being shown.
- [ ] **Savings wallets aren't locked down.** Malware running as this user could edit the settings to add its own address, then wait for a sweep. Protecting that needs a contract account (WORK-332).
- [ ] **Sweeps need the app running.** Nothing runs while it's closed. A plain address can't enforce a cap onchain: it's a trigger for sweeping, not a limit.

## Sites

A browser extension lets websites use this wallet. A site can do real damage with one bad approval, up to what's on this wallet. That's what the cap is for, and it's why this assumes the page and the extension can't be trusted.

- [x] The extension never sees a key, and doesn't log or store anything. It runs as it's committed, with no build step and no dependencies, and asks only for `nativeMessaging`.
- [x] Approvals only appear in the app's own window, showing the site and what's being signed. The wire protocol has no message for answering one, and a test sends the attempts anyone would try.
- [x] Rejecting is one click, and Esc and closing the window do the same. Nothing approves with a key: Return only asks Touch ID again after a cancelled prompt. Connect and acknowledging a strong warning can't be pressed for the first second, so a window opening under the pointer can't catch a click. Everything else takes a touch, and Touch ID asks about 400 ms after the window's in front.
- [x] Sending and signing also ask for Touch ID, right away, with the site and what's being signed on screen. A refused prompt leaves the request waiting, and signs nothing.
- [x] The origin comes from the browser (`sender.origin`), not the page, and is checked again in the app. Only top-level pages on HTTPS or this Mac can ask: no iframes, and no plain HTTP that anyone on the network could change.
- [x] Only the hot wallet is ever exposed. Nothing in the bridge can read a cold wallet, and a request naming any other address is refused.
- [x] Only Base. Other chains are refused for switching, sending and typed data, and what's signed always carries chain ID 8453. A signature with no chain in its data gets a strong warning.
- [x] `eth_sign` is refused outright, and the vault has no way to sign a bare hash: every message's digest starts with 0x19, which can't begin a transaction. So is anything else not on a short list, including EIP-7702 authorizations and contract creation.
- [x] Unlimited token approvals, approve-for-all, typed-data permits and orders, unreadable messages, and sign-ins for a different site all get a strong warning, and approving takes saying you trust the site, before Touch ID asks. It looks for what these have in common, so a contract call it can't read isn't flagged for being unreadable.
- [x] For a contract call it can't read, the app asks the node set in Settings to run the exact transaction against the latest block (`eth_simulateV1`, which sites can't call), and shows what would leave and arrive as an estimate. That node already sees what's about to be sent, from `eth_estimateGas`. A node that fails or doesn't answer clearly leaves the old wording. Only a log's real emitter says what it's about, so tokens off the allowlist stay unknown, with no name, amount or price. An unlimited allowance it finds gets the same strong warning, and a preview never removes one. What Touch ID asks about and what's recorded never use it. A site can make a preview as long as it likes, so its rows scroll with a cue that there's more, while warnings and the way out stay on screen, and any number of unlimited allowances is one strong warning.
- [ ] **A preview can be wrong.** A contract can behave differently when it really runs: it can check the block, or who's calling, or a token can move balances without saying so in a log. A dishonest node can say anything. That's why it's labeled as an estimate and approving still takes the same steps.
- [x] The site doesn't choose the fee, gas or nonce. What's signed keeps to the gas and fee per gas that were approved. If fees rise, it keeps that limit, and if the base fee passes it, the transaction couldn't land, so nothing's signed.
- [x] The amount being sent is shown to the last digit, so a margin a site adds can't be rounded out of sight.
- [x] If something approved doesn't happen, the app's window says why, since a site's own message about it can say anything. It only says nothing was sent when that's certain. If a broadcast gets no clear answer, the transaction stays on its way and the receipt check settles it. Each failure stays up until it's been seen, even with other approvals going on.
- [x] The log says which site, which step and what kind of failure, with no calldata, message or key, and none of a node's own words, which can repeat what it was sent: `log show --predicate 'subsystem == "com.benface.pricetag" AND category == "sites"' --info`.
- [x] Typed data only shows what's signed. A domain or message field that its type doesn't list is refused, and so is a domain whose chain or contract isn't signed or isn't the standard type. Otherwise a site could show Base and a trusted contract with neither one in the signature.
- [x] A site that goes away takes its request with it, at any point before signing: while the node's working out the fee, while it's waiting for approval, or after approval while it's waiting its turn. Once it's been sent, it's been sent.
- [x] Each transaction is on disk before it's broadcast, so the stolen key alarm knows it. While an alarm is up or a key is being replaced, sites can't sign or connect.
- [x] A connection belongs to one key, and goes away when the key does. They're listed in the wallet's window, and can be disconnected there.
- [x] A site can only have 3 things waiting, and 3 rejections in a minute stops it asking for a while, so it can't wear someone down. Its reads are limited too, so it can't use up the wallet's share of the node.
- [x] Only this extension's ID can start the host (`allowed_origins`). The host is a separate program that only relays bytes, with no Keychain access and no key code in it. The ID comes from a public key in `extension/manifest.json`. Its private half was thrown away, since a local unpacked extension doesn't need one.
- [ ] **Malware running as this user can fake a site.** It can start the host itself and claim any origin, so the window would show the wrong one. It would still need someone to approve it, and it could reach the key anyway. See the enclave's limits above.
- [ ] **Someone can load another extension with this ID,** because the manifest's public key is what sets it. That takes Developer mode on this Mac, and it gets what this one gets: it can ask, not approve.
- [ ] **The fee shown is an estimate.** The chain charges for L1 data on top of gas, at whatever L1 costs when the transaction lands, and no signature can limit that. It's worked out from the transaction's real size and allows for twice the current price.
- [ ] **A contract call can do anything.** A swap's calldata isn't decoded, so nothing here tells a good router from a drainer. The warnings only cover what can be recognized. Simulating is left for WORK-337.
- [ ] **What's in a token approval can outlast it.** Disconnecting a site doesn't undo approvals it was given. Replacing the key does.
- [ ] **An approved site can still ask to be trusted.** The origin says who's asking. It can't say a site hasn't been hacked.

## The node

The RPC is configurable and untrusted.

- [x] It can't change where money goes, since destinations are local and go into what's signed.
- [x] Calls to the public node are held to 20 a second, under its limit of 25, and what it refuses for going over is asked again. It says that inside an HTTP 200 for part of a batch, or with a 429. It's never taken as an answer.
- [x] It can't get an absurd fee signed: quotes above 100 gwei are refused.
- [x] A failed read fails the whole tick, so it can't look like an empty wallet.
- [x] Every read in a tick is pinned to one block, and nothing is signed from a read older than the last receipt, so a slow node can't cause the same excess to be swept twice.
- [x] Deleting a key during a rotation takes three reads in a row saying it's empty, plus an answer from Amp that it holds no tokens off the allowlist. That answer has to reach the block where the key first read as empty, and be within a minute of now. Without that, the old key stays until the user chooses to leave what's on it.
- [x] The wallet can't be deleted during a rotation, because the new key may already hold what was moved, and would take over anyway. That's checked again after the prompt, in case a rotation started or finished while it was open. A rotation that's stuck can end by leaving what's on the old key, which includes when this device no longer has that key.
- [x] The block of the last receipt is on disk, so the wait for newer balances survives a restart.
- [x] While a transaction is on its way, its receipt is checked about once a second. That check only settles receipts and updates what's shown. Signing, giving up on a transaction, and the reads behind alarms and deleting a key stay on the 15 s tick, so checking faster doesn't make them any quicker to trigger.
- [ ] **A lying node can still cost something.** It can claim false balances, which wastes gas on sweeps that fail. It can raise a false alarm, or hide activity from the nonce check, though not from the comparison with Amp. If it and the server both say the old key is empty during a rotation, the key is deleted and whatever's still there is lost.
- [ ] **A lying server can misstate what amounts read as in another main currency.** Current rates come from our server (`GET /api/rate`), because they're only for reading: the cap, sweeps and what's signed work in USD from prices read off the chain. A wrong rate can make an approval's worth read wrong in CAD, but the token amount beside it is the real one.

## Cap and sweeps

- [x] The cap is at most $100, and at most $25 without a cold wallet. Tests cover both.
- [x] Gas is kept back, exempt from the cap and from sweeps. A wallet with tokens and no ETH says so.
- [x] Only tokens with a trusted price count or sweep. No price means left out, never $0. Sweep Everything still moves them.
- [x] Every allowlisted token has a Chainlink feed on Base, read straight from the chain with age and range checks, so a price never depends on our server. wstETH's is in ETH, so it's only as good as ETH's. ETH and USDC use the same feeds as the dataset, and a test reads each feed's `description()` onchain.
- [x] Dust is skipped: under $1, or when gas would be more than a tenth of the amount.
- [x] Replacing a key never deletes the old one because of what gas costs. Any token that wasn't worth moving keeps the key until gas falls or the user chooses to leave it. Only ETH under $1 doesn't, because paying for the last transfer always leaves a little.
- [x] Realized gains only sweep when the realized total is fully known, and only count as swept once the transaction lands.
- [x] Only one thing signs at a time, so two can't take the same nonce.

## Stolen key alarm

- [x] Each transaction is written to disk before it's broadcast, so nothing this app sent can look stolen, even after a crash.
- [x] It raises an alarm on: any transaction from Amp's data that took funds or paid gas and that this app didn't sign, any used nonce this app has no transaction for, and another transaction using a nonce this app signed for. The node checks must hold for three reads, since load-balanced nodes can disagree.
- [x] Dismissing an alarm only applies to that key. A new key starts with nothing dismissed.
- [x] A gap in the nonces stays a gap after this app's own later transactions and after a restart, because it's worked out from what's on disk. Sweeps continue meanwhile, since moving money to savings is what you'd want anyway.
- [x] A zero-value "address poisoning" transfer doesn't raise it, because it doesn't move anything.
- [x] It plays a sound, opens the window, changes the menu bar, and stops top-ups. It offers to sweep what's left and replace the key. It survives a restart.
- [ ] **It only tells you afterwards.** A thief with the key can drain the wallet before anything here reads the chain.
- [ ] **Rotation has limited value.** It costs gas and publicly links the old and new addresses. Its main benefit is clearing old token approvals.
- [ ] **Rotation can only see other tokens through Amp,** and only in the blocks the server reads. An old token outside that window isn't seen, and is left behind when the key is deleted. So is one that lands in the last minute or so before deleting, after the last read.

## Dependencies

- [x] Two, both pinned exactly, with `Package.resolved` committed for SwiftPM and Xcode. `macos/run.sh` builds with `-onlyUsePackageVersionsFromResolvedFile`.
- [x] [swift-secp256k1](https://github.com/21-DOT-DEV/swift-secp256k1) 0.24.0, used only for its build of the C library. Its `Sources/libsecp256k1` matches bitcoin-core/secp256k1 v0.7.1 file for file, apart from one added utility header and source file. It has no binaries, plugins or dependencies at a tag. Its Swift layer isn't used, because `signature(for:)` copies the key into an array that nothing wipes.
- [x] [CryptoSwift](https://github.com/krzyzanowskim/CryptoSwift) 1.10.0, used only for Keccak-256, which CryptoKit doesn't have (its SHA3-256 pads differently). It only ever hashes public data, and it's checked against known answers.

## Signing and identity

- [x] Only a provisioned build can reach the data protection Keychain. Without one, the app says it can't hold a key, and everything else works.
- [ ] **The Keychain ties the key to the signing team.** The team is pinned in `macos/run.sh`, and changing it makes an existing key unreadable. Sweep everything out first.
- [ ] **The team's profile lasts a year.** It's Benface Inc.'s, and `pnpm mac` renews it. A build older than that stops launching, and a wallet that isn't running isn't sweeping.

## Not tested by a machine

These need a person at the Mac:

- [ ] The Touch ID prompt itself, inline on Send, Sweep Everything and site requests, and in macOS's dialog everywhere else. The logic around it is tested with a stand-in.
- [ ] The approval window with a person at it. `pnpm check:extension` answers it through a debug build's stand-in, which a release build doesn't have.
- [ ] A site with real funds on a real browser.
- [ ] Reading an address on a real Ledger or Keystone screen.
- [ ] Anything with real funds. All sends so far have been on a local fork. Start with a dollar or two.
