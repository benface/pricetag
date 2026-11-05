import Foundation
import KeyVault
import PricetagKit
import Testing
@testable import HotWalletKit

private let rpc = ProcessInfo.processInfo.environment["ANVIL_RPC_URL"].flatMap(URL.init(string:))
private let liveRPC = ProcessInfo.processInfo.environment["BASE_READ_RPC_URL"].flatMap(URL.init(string:))

/// Holds what the Secure Enclave wrapped, in place of the Keychain, which `swift test` can't reach. See `pnpm check:keychain`.
private final class MemoryKeys: SealedKeyStore, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [EthereumAddress: SealedKey] = [:]

    func save(_ sealed: SealedKey, for address: EthereumAddress) throws { lock.withLock { items[address] = sealed } }
    func load(_ address: EthereumAddress) throws -> SealedKey? { lock.withLock { items[address] } }
    func delete(_ address: EthereumAddress) throws { lock.withLock { _ = items.removeValue(forKey: address) } }
    func addresses() throws -> [EthereumAddress] { lock.withLock { Array(items.keys) } }
}

private func anvil(_ method: String, _ parameters: [Any]) async throws -> Any? {
    var request = URLRequest(url: rpc!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = try JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": 1, "method": method, "params": parameters] as [String: Any])
    let (data, _) = try await URLSession.shared.data(for: request)
    let answer = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    if let error = answer["error"] { Issue.record("\(method) failed: \(error)") }
    return answer["result"]
}

private func hex(_ value: UInt128) -> String { "0x" + String(value, radix: 16) }

/// The public node allows 25 requests a second per IP, shared with anything else on this network.
private func readingPastTheRateLimit() async throws -> ChainSnapshot {
    let client = RPCChainClient(url: liveRPC!)
    let address = EthereumAddress("0x4200000000000000000000000000000000000006")!
    for _ in 0..<5 {
        if let snapshot = try? await client.snapshot(of: address) { return snapshot }
        try await Task.sleep(for: .seconds(3))
    }
    return try await client.snapshot(of: address)
}

/// Only reads. A node's batch limits and its fee answers are the sort of thing a fork doesn't show.
@Suite(.enabled(if: liveRPC != nil))
struct LiveBaseTests {
    @Test func aRealSnapshotReads() async throws {
        let snapshot = try await readingPastTheRateLimit()
        #expect(snapshot.chainID == Base.chainID)
        #expect(snapshot.ethUsdMicros != nil)
        #expect(snapshot.usdcUsdMicros != nil)
        #expect(snapshot.fees.l1FeeWei > 0)
        let reserve = SweepPlanner.gasReserve(snapshot.fees)
        print("Live Base: maxFee \(snapshot.fees.maxFeePerGas) wei, tip \(snapshot.fees.maxPriorityFeePerGas) wei, L1 fee \(snapshot.fees.l1FeeWei) wei, reserve \(reserve) wei, ETH \(snapshot.ethUsdMicros ?? 0), USDC \(snapshot.usdcUsdMicros ?? 0)")
        #expect(reserve == SweepPlanner.minimumGasReserveWei, "fees on Base should be nowhere near the minimum reserve")
    }

    @Test func aRealL1FeeGoesBySize() async throws {
        let client = RPCChainClient(url: liveRPC!)
        // Hashes, since the chain compresses this before pricing it, and a repeating pattern would hardly cost more.
        let payload = { (count: Int) in
            var bytes: [UInt8] = []
            var block = keccak256([1])
            while bytes.count < count {
                bytes += block
                block = keccak256(block)
            }
            return Array(bytes.prefix(count))
        }
        var small: UInt128?
        var big: UInt128?
        // Past the public node's rate limit, like the snapshot above.
        for _ in 0..<5 where small == nil || big == nil {
            small = try? await client.l1Fee(ofPayload: payload(180))
            big = try? await client.l1Fee(ofPayload: payload(9000))
            if small == nil || big == nil { try await Task.sleep(for: .seconds(3)) }
        }
        #expect(try #require(small) > 0)
        #expect(try #require(big) > 10 * (try #require(small)))
    }
}

/// Everything real but the Keychain: a fresh key from the vault, wrapped by the Secure Enclave, signing for a local fork of Base,
/// whose node checks the signatures. No key here is ever written down, and none holds anything outside this fork.
/// `pnpm check:anvil` starts the fork and runs this.
@MainActor
@Suite(.enabled(if: rpc != nil), .serialized)
struct AnvilTests {
    @Test func theWholeLifeOfAHotWallet() async throws {
        let vault = KeyVault(store: MemoryKeys())
        let hot = try await vault.createKey()
        let cold = try await vault.createKey()
        let client = RPCChainClient(url: rpc!)

        let stateStore = MemoryStateStore()
        let settingsStore = MemorySettingsStore()
        let unreachable = ScriptedPortfolios(.failure(.unreachable))
        var state = DeviceWalletState()
        state.active = hot
        try stateStore.save(state)
        let running = HotWallet(signer: vault, settingsStore: settingsStore, stateStore: stateStore, presence: FakePresence(allows: true), portfolioSource: { unreachable }, makeChain: { _ in client })
        try running.addColdWallet(address: cold.lowercased, name: "Fork")
        running.setCap(dollars: 50)

        // An exchange withdrawal lands: $500 of USDC, on top of a little ETH. Far over the cap, for a moment.
        _ = try await anvil("anvil_setBalance", [hot.lowercased, hex(oneEth / 1000)])
        _ = try await anvil("anvil_dealERC20", [hot.lowercased, usdc.contract!.lowercased, hex(usdcUnits(500))])

        await running.tick()
        #expect(running.chainProblem == nil)
        #expect(running.sweepProblem == nil)
        let before = try #require(running.snapshot)
        #expect(before.chainID == Base.chainID)
        #expect(before.ethUsdMicros != nil, "the fork's Chainlink feed reads")
        #expect(before.usdcUsdMicros != nil)
        #expect(before.fees.l1FeeWei > 0, "the fork's gas price oracle reads")
        #expect(running.records.count == 1)
        #expect(running.records.first?.symbol == "USDC")

        // The node recovers the sender from the signature, so a balance moving here proves the signature's real.
        await running.tick()
        #expect(running.records.first?.status == .confirmed)
        let coldAfter = try await client.snapshot(of: cold)
        let hotAfter = try await client.snapshot(of: hot)
        #expect((coldAfter.balances[usdc] ?? 0) > usdcUnits(400))
        #expect(hotAfter.nonce == 1)
        // Anvil mines just after a send returns, so that tick's balances can be from before the receipt it found. It signs nothing
        // from those, which `hotAfter.nonce` just showed, and this tick's are from after it.
        await running.tick()
        #expect(running.snapshot?.nonce == 1)
        let left = try #require(running.plan)
        #expect(left.valueUsdMicros <= 51 * Money.dollar, "about the cap is left")
        #expect(left.valueUsdMicros >= 49 * Money.dollar)
        #expect((hotAfter.balances[Base.eth] ?? 0) >= SweepPlanner.gasReserve(hotAfter.fees) / 2, "gas stays")
        #expect(running.alarm == nil)

        // Someone else signs with this key. Anvil lets this test pretend to be them, without any key at all.
        _ = try await anvil("anvil_impersonateAccount", [hot.lowercased])
        _ = try await anvil("eth_sendTransaction", [["from": hot.lowercased, "to": cold.lowercased, "value": "0x1"]])
        _ = try await anvil("anvil_stopImpersonatingAccount", [hot.lowercased])
        for _ in 0..<HotWallet.readsBeforeAlarm { await running.tick() }
        #expect(running.alarm?.findings == [.nonceAhead(signed: 1, onchain: 2)])
        #expect(!running.canTopUp)

        // What's left goes to savings, and the key is replaced.
        await running.replaceKey()
        let rotation = try #require(running.rotation)
        #expect(rotation.destination == cold)
        // With Amp down it can't rule out other tokens, so the old key stays until there's an answer.
        await running.readHistory()
        for _ in 0..<6 where running.rotationHold == nil { await running.tick() }
        #expect(running.rotationHold == .cantCheckOtherTokens)
        #expect(try await vault.hasKey(hot))
        let head = try await client.snapshot(of: hot).blockNumber
        await unreachable.set(.success(portfolio(address: hot, toBlock: head + 1000)))
        await running.readHistory()
        for _ in 0..<6 where running.rotation != nil { await running.tick() }
        #expect(running.rotation == nil)
        #expect(running.address == rotation.to)
        #expect(running.alarm == nil)
        #expect(try await vault.hasKey(hot) == false)
        let emptied = try await client.snapshot(of: hot)
        #expect(emptied.balances[usdc] == 0)
        #expect((try await client.snapshot(of: cold)).balances[usdc] == usdcUnits(500))
    }

    @Test func sendsAndPublishesACostForReal() async throws {
        let vault = KeyVault(store: MemoryKeys())
        let hot = try await vault.createKey()
        let friend = try await vault.createKey()
        let client = RPCChainClient(url: rpc!)
        let stateStore = MemoryStateStore()
        var state = DeviceWalletState()
        state.active = hot
        try stateStore.save(state)
        let unreachable = ScriptedPortfolios(.failure(.unreachable))
        let wallet = HotWallet(signer: vault, settingsStore: MemorySettingsStore(), stateStore: stateStore, presence: FakePresence(allows: true), portfolioSource: { unreachable }, makeChain: { _ in client })

        _ = try await anvil("anvil_setBalance", [hot.lowercased, hex(oneEth / 100)])
        _ = try await anvil("anvil_dealERC20", [hot.lowercased, usdc.contract!.lowercased, hex(usdcUnits(10))])

        #expect(await wallet.send(SendRequest(token: usdc, amount: usdcUnits(4), to: friend)))
        #expect(wallet.sweepProblem == nil)
        await wallet.tick()
        #expect(wallet.records.first?.status == .confirmed)
        #expect((try await client.snapshot(of: friend)).balances[usdc] == usdcUnits(4))

        // Anvil mines just after a send returns, so give the read a block past the receipt it found.
        await wallet.tick()
        #expect(await wallet.send(SendRequest(token: Base.eth, amount: oneEth / 10000, to: friend)))
        #expect(wallet.sweepProblem == nil)
        await wallet.tick()
        #expect((try await client.snapshot(of: friend)).balances[Base.eth] == oneEth / 10000)

        await wallet.tick()
        let calldata = try #require(CostNote.calldata(txHash: "0x" + String(repeating: "ab", count: 32), asset: "USDC", usdMicros: "250000000"))
        #expect(await wallet.writeNote(calldata, asset: "USDC", from: hot.lowercased))
        #expect(wallet.sweepProblem == nil)
        let note = try #require(wallet.records.first)
        let onchain = try #require(try await anvil("eth_getTransactionByHash", [note.hash]) as? [String: Any])
        #expect((onchain["from"] as? String)?.lowercased() == hot.lowercased)
        #expect((onchain["to"] as? String)?.lowercased() == hot.lowercased)
        #expect(onchain["value"] as? String == "0x0")
        #expect(onchain["input"] as? String == "0x" + Hex.encode(calldata), "this is exactly what the server's parseNote reads")
        await wallet.tick()
        #expect(wallet.records.first?.status == .confirmed)
        #expect(wallet.alarm == nil, "nothing it sent looks stolen")
        #expect((try await client.snapshot(of: hot)).nonce == 3)
    }

    /// Compiled-in addresses are the whole of the trust here, so each one is asked what it is, on the real chain's code and state.
    @Test func everyFeedIsWhatItSays() async throws {
        let feeds = Array(Oracle.others.values) + [.eth, .usdc]
        for feed in feeds {
            let description = try #require(try await anvil("eth_call", [["to": feed.address.lowercased, "data": "0x7284e416"], "latest"]) as? String)
            let decimals = try #require(try await anvil("eth_call", [["to": feed.address.lowercased, "data": "0x313ce567"], "latest"]) as? String)
            let bytes = try #require(Hex.decode(description))
            try #require(bytes.count >= 64)
            let length = Int(bytes[63])
            #expect(String(decoding: bytes[64..<(64 + length)], as: UTF8.self) == feed.description)
            #expect(try RPCChainClient.quantity(decimals) == UInt128(feed.decimals), "\(feed.description)")
        }
    }

    /// $500 of each token lands at once, with real feeds pricing it. The app holds on to the cap's worth, and the rest goes to savings.
    @Test func everyAllowlistedTokenCountsAndSweeps() async throws {
        let vault = KeyVault(store: MemoryKeys())
        let hot = try await vault.createKey()
        let cold = try await vault.createKey()
        let client = RPCChainClient(url: rpc!)
        let stateStore = MemoryStateStore()
        var state = DeviceWalletState()
        state.active = hot
        try stateStore.save(state)
        let unreachable = ScriptedPortfolios(.failure(.unreachable))
        let wallet = HotWallet(signer: vault, settingsStore: MemorySettingsStore(), stateStore: stateStore, presence: FakePresence(allows: true), portfolioSource: { unreachable }, makeChain: { _ in client })
        try wallet.addColdWallet(address: cold.lowercased, name: "Fork")
        wallet.setCap(dollars: 50)

        _ = try await anvil("anvil_setBalance", [hot.lowercased, hex(oneEth / 100)])
        // Nothing else is held yet, so no other feed gets read.
        #expect(try await client.snapshot(of: hot).otherUsdMicros.isEmpty)
        let others = Base.tokens.filter { Oracle.others[$0.asset] != nil }
        for token in others {
            _ = try await anvil("anvil_dealERC20", [hot.lowercased, token.contract!.lowercased, hex(1)])
        }
        let read = try await client.snapshot(of: hot)
        #expect(Set(read.otherUsdMicros.keys) == Set(others.map(\.asset)), "every feed reads, ages and bounds included")
        print("Live feeds: \(read.otherUsdMicros.sorted { $0.key < $1.key })")

        for token in others {
            let price = try #require(read.otherUsdMicros[token.asset])
            let amount = Money.amount(ofUsdMicros: 500 * Money.dollar, priceMicros: price, decimals: token.decimals)
            _ = try await anvil("anvil_dealERC20", [hot.lowercased, token.contract!.lowercased, hex(amount)])
        }
        for _ in 0..<(others.count + 2) { await wallet.tick() }
        #expect(wallet.chainProblem == nil)
        #expect(wallet.sweepProblem == nil)
        #expect(wallet.unpricedSymbols.isEmpty)
        #expect((wallet.plan?.valueUsdMicros ?? .max) <= 51 * Money.dollar, "about the cap is left")
        let saved = try await client.snapshot(of: cold)
        #expect(others.filter { (saved.balances[$0] ?? 0) > 0 }.count >= others.count - 1, "all but what's left under the cap")
    }

    @Test func aRunningWalletShowsASendLandingWithoutWaitingForATick() async throws {
        let vault = KeyVault(store: MemoryKeys())
        let hot = try await vault.createKey()
        let cold = try await vault.createKey()
        let client = RPCChainClient(url: rpc!)
        let stateStore = MemoryStateStore()
        var state = DeviceWalletState()
        state.active = hot
        try stateStore.save(state)
        let unreachable = ScriptedPortfolios(.failure(.unreachable))
        let wallet = HotWallet(signer: vault, settingsStore: MemorySettingsStore(), stateStore: stateStore, presence: FakePresence(allows: true), portfolioSource: { unreachable }, makeChain: { _ in client }, tickDelay: .seconds(3600))
        try wallet.addColdWallet(address: cold.lowercased, name: "Fork")
        wallet.setCap(dollars: 50)
        _ = try await anvil("anvil_setBalance", [hot.lowercased, hex(oneEth / 1000)])
        _ = try await anvil("anvil_dealERC20", [hot.lowercased, usdc.contract!.lowercased, hex(usdcUnits(500))])

        wallet.start()
        defer { wallet.stop() }
        let clock = ContinuousClock()
        let started = clock.now
        for _ in 0..<300 where wallet.snapshot?.nonce != 1 { try await Task.sleep(for: .milliseconds(100)) }
        let waited = clock.now - started
        #expect(wallet.records.first?.status == .confirmed)
        #expect(wallet.snapshot?.nonce == 1)
        #expect((wallet.snapshot?.balances[usdc] ?? 0) < usdcUnits(100))
        #expect(waited < .seconds(15), "the one tick here sent it, and the next is an hour away")
    }

    @Test func sweepsEverythingIncludingEth() async throws {
        let vault = KeyVault(store: MemoryKeys())
        let hot = try await vault.createKey()
        let cold = try await vault.createKey()
        let client = RPCChainClient(url: rpc!)
        let stateStore = MemoryStateStore()
        var state = DeviceWalletState()
        state.active = hot
        try stateStore.save(state)
        let unreachable = ScriptedPortfolios(.failure(.unreachable))
        let wallet = HotWallet(signer: vault, settingsStore: MemorySettingsStore(), stateStore: stateStore, presence: FakePresence(allows: true), portfolioSource: { unreachable }, makeChain: { _ in client })
        try wallet.addColdWallet(address: cold.lowercased, name: "Fork")

        _ = try await anvil("anvil_setBalance", [hot.lowercased, hex(oneEth)])
        _ = try await anvil("anvil_dealERC20", [hot.lowercased, usdc.contract!.lowercased, hex(usdcUnits(5))])
        await wallet.sweepEverything()
        #expect(wallet.sweepProblem == nil)
        #expect(wallet.records.map(\.symbol).sorted() == ["ETH", "USDC"])
        await wallet.tick()
        #expect(wallet.records.allSatisfy { $0.status == .confirmed })
        let after = try await client.snapshot(of: cold)
        #expect(after.balances[usdc] == usdcUnits(5))
        #expect((after.balances[Base.eth] ?? 0) > oneEth * 99 / 100)
    }
}
