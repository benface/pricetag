# Hot wallet security checklist

The Mac app's hot wallet ("this device's spending money") is an unreviewed hackathon build. It's meant for small funds only, and it assumes it will get hacked: the cap is what makes the risk acceptable. This lists what it does, what's been checked and how, and what it doesn't protect against.

To check it yourself: `pnpm check:mac` for the logic, `pnpm check:keychain` for the real Secure Enclave and Keychain, and `pnpm check:anvil` for real signing against a local fork of Base.

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

Manual sends (Sweep Everything, Replace Key, Delete) ask for Touch ID, or the login password where there's none. Automatic sweeps don't, because they have to run with nobody there.

- [ ] **It isn't enforced by the enclave.** The same wrapping key has to open with no prompt for sweeps, so the prompt lives in the app. It stops someone at an unlocked Mac, not malware running as this user.

## Where money can go

- [x] Automatic sweeps only go to the chosen cold wallet, and only ever call a contract on the compiled-in allowlist. A test checks both the allowlist and the feeds against `src/core/tokens.ts`.
- [x] Unknown tokens are never called, not even to read their balance. They're listed separately, from Amp's data.
- [x] Every signature includes chain ID 8453, so nothing signed can be replayed on another chain. Nothing is signed if the node says it's on another chain.
- [x] Sweeps move tokens as they are, with no selling.
- [x] A cold wallet's address must be confirmed by the user against the device's screen. The app has no device code, so it can't check that itself. It does check the EIP-55 checksum, and refuses this wallet's own address, retired keys and zero.
- [ ] **Savings wallets aren't locked down.** Malware running as this user could edit the settings to add its own address, then wait for a sweep. Protecting that needs a contract account (WORK-332).
- [ ] **Sweeps need the app running.** Nothing runs while it's closed. A plain address can't enforce a cap onchain: it's a trigger for sweeping, not a limit.

## The node

The RPC is configurable and untrusted.

- [x] It can't change where money goes, since destinations are local and go into what's signed.
- [x] It can't get an absurd fee signed: quotes above 100 gwei are refused.
- [x] A failed read fails the whole tick, so it can't look like an empty wallet.
- [x] Every read in a tick is pinned to one block, and nothing is signed from a read older than the last receipt, so a slow node can't cause the same excess to be swept twice.
- [x] Deleting a key during a rotation takes three reads in a row saying it's empty, plus an answer from Amp that it holds no tokens off the allowlist. That answer has to reach the block where the key first read as empty, and be within a minute of now. Without that, the old key stays until the user chooses to leave what's on it.
- [x] The block of the last receipt is on disk, so the wait for newer balances survives a restart.
- [ ] **A lying node can still cost something.** It can claim false balances, which wastes gas on sweeps that fail. It can raise a false alarm, or hide activity from the nonce check, though not from the comparison with Amp. If it and the server both say the old key is empty during a rotation, the key is deleted and whatever's still there is lost.

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
- [ ] **The personal team's profile lasts 7 days.** `pnpm mac` renews it. A build older than that stops launching, and a wallet that isn't running isn't sweeping.

## Not tested by a machine

These need a person at the Mac:

- [ ] The Touch ID prompt itself, on Sweep Everything and Replace Key. The logic around it is tested with a stand-in.
- [ ] Reading an address on a real Ledger or Keystone screen.
- [ ] Anything with real funds. All sends so far have been on a local fork. Start with a dollar or two.
