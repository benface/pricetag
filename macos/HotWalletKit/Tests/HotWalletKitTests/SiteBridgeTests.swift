import Foundation
@testable import KeyVault
import PricetagKit
import Testing
@testable import HotWalletKit

private let site = "https://app.example.com"
private let hot = hotAddress.lowercased
private let recipient = "0x3333333333333333333333333333333333333333"

/// A presence that's asked, and can say no or leave a prompt open, so a test can see what happens around it.
private final class CountingPresence: UserPresence, @unchecked Sendable {
    private let lock = NSLock()
    private var answers: [Bool]
    private(set) var reasons: [String] = []

    init(answers: [Bool] = []) {
        self.answers = answers
    }

    func confirm(reason: String) throws {
        let allowed = lock.withLock {
            reasons.append(reason)
            return answers.isEmpty ? true : answers.removeFirst()
        }
        if !allowed { throw FakePresence.Refused() }
    }
}

@MainActor
private struct SiteRig {
    let wallet: HotWallet
    let chain: FakeChain
    let signer: FakeSigner
    let stateStore: MemoryStateStore
    let presence: CountingPresence
    let portfolios: ScriptedPortfolios
    let bridge: SiteBridge
    let connection = UUID()

    init(_ start: ChainSnapshot = snapshot(), presence: CountingPresence = CountingPresence(), now: @escaping @Sendable () -> Date = { Date() }) {
        let chain = FakeChain(start)
        let signer = FakeSigner(keys: [hotAddress], next: [nextAddress])
        let stateStore = MemoryStateStore()
        var state = DeviceWalletState()
        state.active = hotAddress
        try! stateStore.save(state)
        let settingsStore = MemorySettingsStore()
        var settings = WalletSettings()
        settings.add(ColdWallet(address: coldAddress, name: "Ledger", confirmedOnDeviceAt: Date()))
        settingsStore.save(settings)
        let portfolios = ScriptedPortfolios(.failure(.unreachable))
        self.chain = chain
        self.signer = signer
        self.stateStore = stateStore
        self.presence = presence
        self.portfolios = portfolios
        wallet = HotWallet(signer: signer, settingsStore: settingsStore, stateStore: stateStore, presence: presence, portfolioSource: { portfolios }, makeChain: { _ in chain }, now: now)
        bridge = SiteBridge(wallet: wallet, now: now)
    }

    func request(_ method: String, _ parameters: JSONValue? = nil, origin: String = site, id: String = "1") -> SiteRequest {
        SiteRequest(connection: connection, id: id, origin: origin, method: method, parameters: parameters)
    }

    func ask(_ method: String, _ parameters: JSONValue? = nil, origin: String = site) async -> RPCAnswer {
        await bridge.handle(request(method, parameters, origin: origin))
    }

    /// Starts a request that will wait for the window, and returns once it's there to be answered.
    func start(_ method: String, _ parameters: JSONValue? = nil, origin: String = site, id: String = "1") async -> (Task<RPCAnswer, Never>, SiteApproval) {
        let before = Set(bridge.pending.map(\.id))
        let bridge = bridge
        let request = request(method, parameters, origin: origin, id: id)
        let task = Task { await bridge.handle(request) }
        // It goes to the node first, which takes real time when every other test is running too.
        for _ in 0..<10_000 {
            if let approval = bridge.pending.first(where: { !before.contains($0.id) }) { return (task, approval) }
            try? await Task.sleep(for: .milliseconds(1))
        }
        Issue.record("\(method) never asked for approval: \(await task.value)")
        fatalError("no approval")
    }

    func connect(origin: String = site) async {
        let (task, approval) = await start("eth_requestAccounts", origin: origin)
        await bridge.approve(approval.id)
        _ = await task.value
    }

    func sendParameters(to: String = recipient, value: String = "0x10", data: String? = nil, from: String = hot, extra: [String: JSONValue] = [:]) -> JSONValue {
        var transaction: [String: JSONValue] = ["from": .string(from), "to": .string(to), "value": .string(value)]
        if let data { transaction["data"] = .string(data) }
        transaction.merge(extra) { $1 }
        return .array([.object(transaction)])
    }
}

private func code(_ answer: RPCAnswer) -> Int? {
    if case .failure(let error) = answer { error.code } else { nil }
}

private func word(_ hex: String) -> String {
    String(repeating: "0", count: 64 - hex.count) + hex
}

private let usdcText = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
private let spenderWord = word("4444444444444444444444444444444444444444")
private let maxWord = String(repeating: "f", count: 64)

private func permitJSON(chain: String = "8453", domainExtra: String = "") -> JSONValue {
    .string(#"{"domain":{"name":"USD Coin","version":"2","chainId":\#(chain)\#(domainExtra)},"types":{"Permit":[{"name":"owner","type":"address"},{"name":"spender","type":"address"},{"name":"value","type":"uint256"}]},"primaryType":"Permit","message":{"owner":"\#(hot)","spender":"0x4444444444444444444444444444444444444444","value":"1"}}"#)
}

@MainActor
@Suite struct SiteBridgeTests {
    // MARK: Refused without asking

    @Test func ethSignIsRefusedOutrightWithoutEvenAsking() async {
        let rig = SiteRig()
        await rig.connect()
        let answer = await rig.ask("eth_sign", .array([.string(hot), .string("0x" + String(repeating: "11", count: 32))]))
        #expect(code(answer) == 4200)
        #expect(rig.bridge.pending.isEmpty)
        #expect(await rig.signer.signedMessages.isEmpty)
        #expect(rig.presence.reasons.isEmpty)
    }

    @Test func methodsItDoesntKnowAreRefusedAndNeverReachTheNode() async {
        let rig = SiteRig()
        await rig.connect()
        for method in ["eth_signTransaction", "eth_signTypedData", "eth_signTypedData_v3", "eth_sendRawTransaction", "wallet_sendCalls", "wallet_signAuthorization", "eth_newFilter", "debug_traceCall", "personal_ecRecover", "anvil_setBalance", "patina_approve"] {
            #expect(code(await rig.ask(method, .array([]))) == 4200, "\(method)")
        }
        #expect(await rig.chain.reads.isEmpty)
    }

    @Test func otherChainsAreRefused() async {
        let rig = SiteRig()
        await rig.connect()
        #expect(code(await rig.ask("wallet_switchEthereumChain", .array([.object(["chainId": .string("0x1")])]))) == 4902)
        #expect(code(await rig.ask("wallet_addEthereumChain", .array([.object(["chainId": .string("0xa")])]))) == 4902)
        #expect(code(await rig.ask("eth_sendTransaction", rig.sendParameters(extra: ["chainId": .string("0x1")]))) == 4901)
        #expect(code(await rig.ask("eth_signTypedData_v4", .array([.string(hot), permitJSON(chain: "1")]))) == 4901)
        #expect(await rig.ask("eth_chainId") == .success(.string("0x2105")))
        #expect(await rig.ask("wallet_switchEthereumChain", .array([.object(["chainId": .string("0x2105")])])) == .success(.null))
        #expect(rig.bridge.pending.isEmpty)
    }

    @Test func aSiteThatHasntConnectedGetsNothing() async {
        let rig = SiteRig()
        #expect(await rig.ask("eth_accounts") == .success(.array([])))
        #expect(await rig.ask("wallet_getPermissions") == .success(.array([])))
        #expect(code(await rig.ask("eth_sendTransaction", rig.sendParameters())) == 4100)
        #expect(code(await rig.ask("personal_sign", .array([.string("0x00"), .string(hot)]))) == 4100)
        #expect(code(await rig.ask("eth_signTypedData_v4", .array([.string(hot), permitJSON()]))) == 4100)
        #expect(rig.bridge.pending.isEmpty)
    }

    @Test func connectingOneSiteDoesntConnectAnother() async {
        let rig = SiteRig()
        await rig.connect()
        #expect(await rig.ask("eth_accounts", origin: "https://evil.example.com") == .success(.array([])))
        #expect(code(await rig.ask("eth_sendTransaction", rig.sendParameters(), origin: "https://evil.example.com")) == 4100)
    }

    @Test func onlyHttpsOrThisMacCanAsk() async {
        let rig = SiteRig()
        for origin in ["http://app.example.com", "ftp://example.com", "chrome-extension://abc", "file://", "null", "", "https://", "https://a.com/path", "https://user@a.com", "http://localhost.evil.com"] {
            #expect(code(await rig.ask("eth_requestAccounts", origin: origin)) == 4100, "\(origin)")
        }
        #expect(rig.bridge.pending.isEmpty)
        #expect(SiteBridge.isAllowed(origin: "http://localhost:5173"))
        #expect(SiteBridge.isAllowed(origin: "http://127.0.0.1:3000"))
        #expect(SiteBridge.isAllowed(origin: "https://app.uniswap.org"))
    }

    @Test func aTransactionFromAnyOtherAddressIsRefused() async {
        let rig = SiteRig()
        await rig.connect()
        // Savings above all: a site can't sign as a cold wallet, even by naming one.
        for from in [coldAddress.lowercased, recipient, "not an address"] {
            #expect(code(await rig.ask("eth_sendTransaction", rig.sendParameters(from: from))) == 4100, "\(from)")
        }
        #expect(code(await rig.ask("personal_sign", .array([.string("0x00"), .string(coldAddress.lowercased)]))) == 4100)
        #expect(code(await rig.ask("eth_signTypedData_v4", .array([.string(coldAddress.lowercased), permitJSON()]))) == 4100)
        #expect(rig.bridge.pending.isEmpty)
    }

    @Test func transactionsItCantShowAreRefused() async {
        let rig = SiteRig()
        await rig.connect()
        // Making a contract.
        #expect(code(await rig.ask("eth_sendTransaction", .array([.object(["from": .string(hot), "data": .string("0x00")])]))) == 4200)
        // EIP-7702, which hands the account to a contract.
        #expect(code(await rig.ask("eth_sendTransaction", rig.sendParameters(extra: ["authorizationList": .array([])]))) == 4200)
        #expect(code(await rig.ask("eth_sendTransaction", rig.sendParameters(to: "0x1234"))) == -32602)
        #expect(code(await rig.ask("eth_sendTransaction", rig.sendParameters(value: "lots"))) == -32602)
        #expect(code(await rig.ask("eth_sendTransaction", rig.sendParameters(data: "nothex"))) == -32602)
        #expect(code(await rig.ask("eth_sendTransaction", rig.sendParameters(data: "0x01", extra: ["input": .string("0x02")]))) == -32602)
        #expect(rig.bridge.pending.isEmpty)
    }

    @Test func aTransactionTheNodeSaysWillFailIsntOffered() async {
        let rig = SiteRig()
        await rig.connect()
        await rig.chain.setEstimateFailure(.rejected("execution reverted"))
        let answer = await rig.ask("eth_sendTransaction", rig.sendParameters())
        #expect(code(answer) == -32000)
        #expect(rig.bridge.pending.isEmpty)
    }

    @Test func aStoppedWalletRefusesSites() async throws {
        let rig = SiteRig()
        await rig.connect()
        var state = rig.stateStore.saved
        state.alarm = StolenKeyAlarm(address: hotAddress, findings: [.unknownTransaction(hash: "0xabc")], raisedAt: Date())
        try rig.stateStore.save(state)
        let settings = MemorySettingsStore()
        settings.save(rig.wallet.settings)
        let alarmed = HotWallet(signer: rig.signer, settingsStore: settings, stateStore: rig.stateStore, presence: rig.presence, portfolioSource: { ScriptedPortfolios(.failure(.unreachable)) }, makeChain: { _ in rig.chain })
        let bridge = SiteBridge(wallet: alarmed)
        let answer = await bridge.handle(rig.request("eth_sendTransaction", rig.sendParameters()))
        #expect(code(answer) == 4100)
        #expect(code(await bridge.handle(rig.request("personal_sign", .array([.string("0x00"), .string(hot)])))) == 4100)
        #expect(code(await bridge.handle(rig.request("eth_requestAccounts", origin: "https://other.example.com"))) == 4100)
        #expect(await rig.signer.signed.isEmpty)
    }

    @Test func aRotatingWalletRefusesSitesAndTheNewKeyStartsDisconnected() async {
        let rig = SiteRig()
        await rig.connect()
        var events: [(String, [String])] = []
        rig.bridge.onAccountsChanged = { events.append(($0, $1)) }
        rig.wallet.onLinkedWalletsChange = { [bridge = rig.bridge] _ in bridge.walletChanged() }

        await rig.wallet.replaceKey()
        #expect(rig.wallet.rotation != nil)
        #expect(code(await rig.ask("eth_sendTransaction", rig.sendParameters())) == 4100)

        await rig.wallet.finishRotationLeavingFundsBehind()
        #expect(rig.wallet.address == nextAddress)
        #expect(await rig.ask("eth_accounts") == .success(.array([])))
        #expect(events.last?.0 == site)
        #expect(events.last?.1 == [])
    }

    // MARK: Answers from the window

    @Test func rejectingAConnectionLeavesTheSiteOut() async {
        let rig = SiteRig()
        let (task, approval) = await rig.start("eth_requestAccounts")
        #expect(approval.action == .connect)
        #expect(approval.origin == site)
        rig.bridge.reject(approval.id)
        #expect(code(await task.value) == 4001)
        #expect(await rig.ask("eth_accounts") == .success(.array([])))
        #expect(rig.stateStore.saved.connectedSites == nil)
    }

    @Test func approvingAConnectionOnlyEverShowsTheHotWallet() async throws {
        let rig = SiteRig()
        var events: [(String, [String])] = []
        rig.bridge.onAccountsChanged = { events.append(($0, $1)) }
        let (task, approval) = await rig.start("eth_requestAccounts")
        await rig.bridge.approve(approval.id)
        #expect(await task.value == .success(.array([.string(hot)])))
        #expect(await rig.ask("eth_accounts") == .success(.array([.string(hot)])))
        #expect(events.count == 1 && events[0].1 == [hot])
        // Connecting only shows an address, so it doesn't need Touch ID.
        #expect(rig.presence.reasons.isEmpty)
        // It stays across a restart, and asking again doesn't prompt.
        #expect(rig.stateStore.saved.connectedSites == [site])
        #expect(await rig.ask("eth_requestAccounts") == .success(.array([.string(hot)])))

        for answer in [await rig.ask("eth_accounts"), await rig.ask("wallet_getPermissions")] {
            let text = String(decoding: try JSONEncoder().encode(try answer.get()), as: UTF8.self)
            #expect(!text.contains(coldAddress.lowercased))
        }
        let status = String(decoding: try JSONEncoder().encode(rig.bridge.popupStatus()), as: UTF8.self)
        #expect(!status.lowercased().contains(coldAddress.lowercased))
    }

    @Test func aSiteOrTheUserCanDisconnect() async {
        let rig = SiteRig()
        await rig.connect()
        var events: [[String]] = []
        rig.bridge.onAccountsChanged = { events.append($1) }
        rig.bridge.disconnect(site)
        #expect(events == [[]])
        #expect(await rig.ask("eth_accounts") == .success(.array([])))

        await rig.connect()
        #expect(await rig.ask("wallet_revokePermissions", .array([])) == .success(.null))
        #expect(await rig.ask("eth_accounts") == .success(.array([])))
    }

    @Test func rejectingATransactionSignsNothing() async {
        let rig = SiteRig()
        await rig.connect()
        let (task, approval) = await rig.start("eth_sendTransaction", rig.sendParameters())
        rig.bridge.reject(approval.id)
        #expect(code(await task.value) == 4001)
        #expect(await rig.signer.signed.isEmpty)
        #expect(await rig.chain.sent.isEmpty)
        #expect(rig.wallet.records.isEmpty)
    }

    @Test func approvingATransactionSendsExactlyWhatWasShown() async throws {
        let rig = SiteRig()
        await rig.connect()
        let (task, approval) = await rig.start("eth_sendTransaction", rig.sendParameters(value: "0x10", data: "0xabcdef", extra: ["gas": .string("0x1"), "maxFeePerGas": .string("0xffffffffffff"), "nonce": .string("0x63")]))
        guard case .transaction(let review) = approval.action else { Issue.record("Not a transaction"); return }
        #expect(review.value == 16)
        #expect(review.data == [0xAB, 0xCD, 0xEF])
        await rig.bridge.approve(approval.id)
        let hash = try await task.value.get()

        let signed = try #require(await rig.signer.signed.first)
        #expect(signed.to == EthereumAddress(recipient))
        #expect(signed.value == 16)
        #expect(signed.data == [0xAB, 0xCD, 0xEF])
        #expect(signed.chainID == Base.chainID)
        // The site doesn't choose the fee, the gas or the nonce.
        #expect(signed.maxFeePerGas == cheapFees.maxFeePerGas)
        #expect(signed.gasLimit == 75000)
        #expect(signed.nonce == 0)
        #expect(rig.presence.reasons == ["send a transaction for \(site)"])

        // Written down before it left, so the alarm doesn't take it for a thief's.
        let record = try #require(rig.wallet.records.first)
        #expect(hash == .string(record.hash))
        #expect(record.reason == .site)
        #expect(record.site == site)
        #expect(AlarmCheck.findings(outgoingTxs: [record.hash], records: rig.wallet.records).isEmpty)
        #expect(await rig.chain.sent.count == 1)
    }

    @Test func aRefusedTouchIdLeavesItWaitingAndSignsNothing() async throws {
        let rig = SiteRig(presence: CountingPresence(answers: [false, true]))
        await rig.connect()
        let (task, approval) = await rig.start("eth_sendTransaction", rig.sendParameters())
        await rig.bridge.approve(approval.id)
        #expect(rig.bridge.current?.id == approval.id)
        #expect(await rig.signer.signed.isEmpty)
        await rig.bridge.approve(approval.id)
        #expect(rig.bridge.pending.isEmpty)
        _ = try await task.value.get()
        #expect(await rig.signer.signed.count == 1)
    }

    @Test func aFailedBroadcastIsNotReportedAsSent() async {
        let rig = SiteRig()
        await rig.connect()
        let (task, approval) = await rig.start("eth_sendTransaction", rig.sendParameters())
        await rig.chain.setSendFailure(.rejected("nonce too low"))
        await rig.bridge.approve(approval.id)
        #expect(code(await task.value) == -32000)
        #expect(rig.wallet.records.first?.status == .dropped)
    }

    @Test func aBroadcastThatMayHaveGotThroughStillGivesItsHash() async throws {
        let rig = SiteRig()
        await rig.connect()
        let (task, approval) = await rig.start("eth_sendTransaction", rig.sendParameters())
        await rig.chain.setSendFailure(.unreachable)
        await rig.bridge.approve(approval.id)
        #expect(try await task.value.get() == .string(rig.wallet.records.first!.hash))
        #expect(rig.wallet.records.first?.status == .pending)
    }

    @Test func feesThatJumpAfterApprovalStopIt() async {
        let rig = SiteRig()
        await rig.connect()
        let (task, approval) = await rig.start("eth_sendTransaction", rig.sendParameters())
        await rig.chain.set(snapshot(fees: FeeQuote(maxFeePerGas: cheapFees.maxFeePerGas * 3, maxPriorityFeePerGas: 1, l1FeeWei: 1)))
        await rig.bridge.approve(approval.id)
        #expect(code(await task.value) == -32000)
        #expect(await rig.signer.signed.isEmpty)
    }

    @Test func aSmallFeeRiseDoesntGoPastWhatWasApproved() async throws {
        let rig = SiteRig()
        await rig.connect()
        let (task, approval) = await rig.start("eth_sendTransaction", rig.sendParameters())
        guard case .transaction(let review) = approval.action else { Issue.record("Not a transaction"); return }
        let quoted = cheapFees.maxFeePerGas
        await rig.chain.set(snapshot(fees: FeeQuote(maxFeePerGas: quoted * 3 / 2, maxPriorityFeePerGas: quoted * 3 / 2, l1FeeWei: 1)))
        await rig.bridge.approve(approval.id)
        _ = try await task.value.get()

        let signed = try #require(await rig.signer.signed.first)
        #expect(signed.maxFeePerGas == quoted)
        #expect(signed.maxPriorityFeePerGas == quoted)
        #expect(UInt128(signed.gasLimit) * signed.maxFeePerGas <= review.feeWei)
    }

    @Test func aFeeThatFallsIsntPaidAtTheOldPrice() async throws {
        let rig = SiteRig()
        await rig.connect()
        let (task, approval) = await rig.start("eth_sendTransaction", rig.sendParameters())
        await rig.chain.set(snapshot(fees: FeeQuote(maxFeePerGas: cheapFees.maxFeePerGas / 2, maxPriorityFeePerGas: 1, l1FeeWei: 1)))
        await rig.bridge.approve(approval.id)
        _ = try await task.value.get()
        #expect(await rig.signer.signed.first?.maxFeePerGas == cheapFees.maxFeePerGas / 2)
    }

    /// A site's data can be far bigger than a sweep, and the chain charges for L1 data by size.
    @Test func theFeeShownGoesByTheTransactionsRealSize() async throws {
        let rig = SiteRig()
        await rig.connect()
        let review = { (data: String) async throws -> TransactionReview in
            let (task, approval) = await rig.start("eth_sendTransaction", rig.sendParameters(data: data))
            rig.bridge.cancelAll(connection: rig.connection)
            _ = await task.value
            guard case .transaction(let review) = approval.action else { throw ChainError.unreadable }
            return review
        }
        let small = try await review("0x12345678")
        let big = try await review("0x12345678" + String(repeating: "ab", count: 5000))
        let payload = try #require(await rig.chain.l1FeePayloads.last)
        #expect(payload.count > 5000)
        #expect(big.feeWei >= small.feeWei + 2 * 5000 * 1_000_000_000)
    }

    @Test func noL1FeeMeansNoOffer() async {
        final class NoFee: ChainClient {
            func snapshot(of address: EthereumAddress) -> ChainSnapshot { HotWalletKitTests.snapshot() }
            func estimateGas(from: EthereumAddress, to: EthereumAddress, value: UInt128, data: [UInt8]) -> UInt64 { 21000 }
            func send(_ transaction: SignedTransaction) {}
            func receipt(of hash: String) -> Receipt? { nil }
            func read(_ method: String, _ parameters: JSONValue) -> RPCAnswer { .success(.null) }
            func l1Fee(ofPayload payload: [UInt8]) throws -> UInt128 { throw ChainError.unreachable }
        }
        var state = DeviceWalletState()
        state.active = hotAddress
        state.connectedSites = [site]
        let stateStore = MemoryStateStore()
        try! stateStore.save(state)
        let wallet = HotWallet(signer: FakeSigner(keys: [hotAddress]), settingsStore: MemorySettingsStore(), stateStore: stateStore, presence: FakePresence(allows: true), portfolioSource: { ScriptedPortfolios(.failure(.unreachable)) }, makeChain: { _ in NoFee() })
        let bridge = SiteBridge(wallet: wallet)
        let answer = await bridge.handle(SiteRequest(connection: UUID(), id: "1", origin: site, method: "eth_sendTransaction", parameters: .array([.object(["from": .string(hot), "to": .string(recipient)])])))
        #expect(code(answer) == 4900)
        #expect(bridge.pending.isEmpty)
    }

    private func waitForHeldCall(_ rig: SiteRig) async {
        for _ in 0..<2000 {
            if await rig.chain.heldCalls > 0 { return }
            try? await Task.sleep(for: .milliseconds(1))
        }
        Issue.record("Nothing reached the node")
    }

    /// The request is working out its fee, so there's no approval yet for the closed tab to take away. None must appear afterward.
    @Test func aTabClosedWhileTheNodeIsWorkingNeverGetsAnApproval() async {
        for closing in [{ (rig: SiteRig) in rig.bridge.cancel(connection: rig.connection, id: "1") }, { (rig: SiteRig) in rig.bridge.cancelAll(connection: rig.connection) }] {
            let rig = SiteRig()
            await rig.connect()
            await rig.chain.hold(estimates: true)
            let answer = rig.bridge.begin(rig.request("eth_sendTransaction", rig.sendParameters()))
            await waitForHeldCall(rig)
            closing(rig)
            await rig.chain.release()

            #expect(code(await answer.value) == 4001)
            #expect(rig.bridge.pending.isEmpty)
            #expect(await rig.signer.signed.isEmpty)
            #expect(await rig.chain.sent.isEmpty)
        }
    }

    @Test func aTabClosedBeforeItsRequestStartsIsNeverAsked() async {
        let rig = SiteRig()
        await rig.connect()
        let answer = rig.bridge.begin(rig.request("eth_sendTransaction", rig.sendParameters()))
        rig.bridge.cancel(connection: rig.connection, id: "1")
        #expect(code(await answer.value) == 4001)
        #expect(rig.bridge.pending.isEmpty)
        #expect(await rig.chain.reads.isEmpty)
    }

    @Test func anotherRequestDoesntGoWithIt() async throws {
        let rig = SiteRig()
        await rig.connect()
        await rig.chain.hold(estimates: true)
        let leaving = rig.bridge.begin(rig.request("eth_sendTransaction", rig.sendParameters(), id: "leaving"))
        let staying = rig.bridge.begin(rig.request("eth_sendTransaction", rig.sendParameters(), id: "staying"))
        await waitForHeldCall(rig)
        rig.bridge.cancel(connection: rig.connection, id: "leaving")
        await rig.chain.release()
        #expect(code(await leaving.value) == 4001)
        for _ in 0..<5000 where rig.bridge.pending.isEmpty { try await Task.sleep(for: .milliseconds(1)) }
        let approval = try #require(rig.bridge.current)
        await rig.bridge.approve(approval.id)
        _ = try await staying.value.get()
        #expect(await rig.signer.signed.count == 1)
    }

    /// It was approved, and it's waiting its turn or for the node. The site's gone, so nothing's sent for it.
    @Test func aTabClosedAfterApprovingButBeforeSigningSignsNothing() async {
        for closing in [{ (rig: SiteRig) in rig.bridge.cancel(connection: rig.connection, id: "1") }, { (rig: SiteRig) in rig.bridge.cancelAll(connection: rig.connection) }] {
            let rig = SiteRig()
            await rig.connect()
            let (task, approval) = await rig.start("eth_sendTransaction", rig.sendParameters())
            await rig.chain.hold(snapshots: true)
            await rig.bridge.approve(approval.id)
            await waitForHeldCall(rig)
            closing(rig)
            await rig.chain.release()

            #expect(code(await task.value) == 4001)
            #expect(await rig.signer.signed.isEmpty)
            #expect(await rig.chain.sent.isEmpty)
            #expect(rig.wallet.records.isEmpty)
        }
    }

    @Test func aWalletStoppedWhileWaitingDoesntSign() async {
        let rig = SiteRig()
        await rig.connect()
        let (task, approval) = await rig.start("eth_sendTransaction", rig.sendParameters())
        await rig.wallet.replaceKey()
        await rig.bridge.approve(approval.id)
        #expect(code(await task.value) == 4100)
        // Replacing the key signs its own moves, as it runs. None of them are this.
        #expect(await rig.signer.signed.allSatisfy { $0.to != EthereumAddress(recipient) })
        #expect(rig.wallet.records.allSatisfy { $0.reason != .site })
    }

    /// History is read outside the line, so an alarm can arrive while an approved transaction is waiting on the node.
    @Test func anAlarmWhileItsWaitingOnTheNodeStopsIt() async {
        let rig = SiteRig()
        await rig.connect()
        let (task, approval) = await rig.start("eth_sendTransaction", rig.sendParameters())
        await rig.chain.hold(snapshots: true)
        await rig.bridge.approve(approval.id)
        await waitForHeldCall(rig)
        await rig.portfolios.set(.success(portfolio(outgoing: ["0xabc"])))
        await rig.wallet.readHistory()
        #expect(rig.wallet.alarm != nil)
        await rig.chain.release()

        #expect(code(await task.value) == -32000)
        #expect(await rig.signer.signed.isEmpty)
        #expect(rig.wallet.records.isEmpty)
    }

    @Test func sitesFailingOnchainDontHoldUpSweeps() async throws {
        let rig = SiteRig()
        await rig.connect()
        let (task, approval) = await rig.start("eth_sendTransaction", rig.sendParameters())
        await rig.bridge.approve(approval.id)
        let hash = try #require(try await task.value.get().string)
        await rig.chain.setReceipt(hash, succeeded: false)
        await rig.wallet.tick()
        #expect(rig.wallet.records.first?.status == .failed)
        #expect(rig.wallet.sweepProblem?.contains(site) == true)

        await rig.chain.set(snapshot(eth: oneEth, nonce: 1))
        await rig.wallet.tick()
        #expect(await rig.chain.sent.count == 2, "the excess still sweeps")
    }

    @Test func aClosedTabTakesItsApprovalWithIt() async {
        let rig = SiteRig()
        let (first, _) = await rig.start("eth_requestAccounts", id: "a")
        rig.bridge.cancel(connection: rig.connection, id: "a")
        #expect(rig.bridge.pending.isEmpty)
        #expect(code(await first.value) == 4001)

        let (second, _) = await rig.start("eth_requestAccounts", id: "b")
        rig.bridge.cancelAll(connection: rig.connection)
        #expect(rig.bridge.pending.isEmpty)
        #expect(code(await second.value) == 4001)
    }

    @Test func aSiteCantFloodTheWindow() async {
        let rig = SiteRig()
        await rig.connect()
        var tasks: [Task<RPCAnswer, Never>] = []
        for index in 0..<SiteBridge.maxPendingPerOrigin {
            let (task, _) = await rig.start("eth_sendTransaction", rig.sendParameters(), id: "\(index)")
            tasks.append(task)
        }
        #expect(code(await rig.ask("eth_sendTransaction", rig.sendParameters())) == -32002)
        #expect(rig.bridge.pending.count == SiteBridge.maxPendingPerOrigin)
        rig.bridge.cancelAll(connection: rig.connection)
        for task in tasks { _ = await task.value }

        let (connecting, _) = await rig.start("eth_requestAccounts", origin: "https://other.example.com")
        #expect(code(await rig.ask("eth_requestAccounts", origin: "https://other.example.com")) == -32002)
        rig.bridge.cancelAll(connection: rig.connection)
        _ = await connecting.value
    }

    @Test func aSiteCantWearSomeoneDown() async {
        final class Clock: @unchecked Sendable { var now = Date() }
        let clock = Clock()
        let rig = SiteRig(now: { clock.now })
        for _ in 0..<SiteBridge.rejectionsBeforeCooldown {
            let (task, approval) = await rig.start("eth_requestAccounts")
            rig.bridge.reject(approval.id)
            _ = await task.value
        }
        // Answered with no window at all.
        #expect(code(await rig.ask("eth_requestAccounts")) == 4001)
        #expect(rig.bridge.pending.isEmpty)
        // Only for that site.
        let (other, approval) = await rig.start("eth_requestAccounts", origin: "https://other.example.com")
        rig.bridge.reject(approval.id)
        _ = await other.value
        // And only for a while.
        clock.now = clock.now.addingTimeInterval(SiteBridge.rejectionWindow + 1)
        let (again, nextApproval) = await rig.start("eth_requestAccounts")
        rig.bridge.reject(nextApproval.id)
        _ = await again.value
    }

    // MARK: Strong warnings

    @Test func anUnlimitedApprovalTakesAcknowledgingAndAStrongWarning() async throws {
        let rig = SiteRig()
        await rig.connect()
        let data = "0x095ea7b3" + spenderWord + maxWord
        let (task, approval) = await rig.start("eth_sendTransaction", rig.sendParameters(to: usdcText, value: "0x0", data: data))
        #expect(approval.needsAcknowledgment)
        guard case .transaction(let review) = approval.action else { Issue.record("Not a transaction"); return }
        #expect(review.headline.contains("all of your USDC"))
        #expect(review.toName == "USDC")

        await rig.bridge.approve(approval.id)
        #expect(rig.bridge.current?.id == approval.id, "pressing approve without acknowledging does nothing")
        #expect(rig.presence.reasons.isEmpty)
        #expect(await rig.signer.signed.isEmpty)

        await rig.bridge.approve(approval.id, acknowledged: true)
        _ = try await task.value.get()
        #expect(await rig.signer.signed.count == 1)
    }

    @Test func approvalsAreToldApartByWhatTheyAllow() async {
        let rig = SiteRig()
        await rig.connect()
        let limited = word(String(5_000_000, radix: 16))
        let cases: [(String, Bool, String)] = [
            ("0x095ea7b3" + spenderWord + limited, false, "up to 5 USDC"),
            ("0x095ea7b3" + spenderWord + word("0"), false, "Stop"),
            ("0x095ea7b3" + spenderWord + word("1" + String(repeating: "0", count: 24)), true, "all of your"),
            ("0x39509351" + spenderWord + maxWord, true, "all of your"),
            // Adding to an allowance doesn't set it, so it can't say "up to", and adding nothing doesn't stop anything.
            ("0x39509351" + spenderWord + limited, false, "spend 5 USDC more"),
            ("0x39509351" + spenderWord + word("0"), false, "Add nothing"),
            ("0xa22cb465" + spenderWord + word("1"), true, "every item"),
            ("0xa22cb465" + spenderWord + word("0"), false, "Stop"),
            ("0xa9059cbb" + spenderWord + limited, false, "Send 5 USDC"),
            ("0x87517c45" + word(String(usdcText.dropFirst(2))) + spenderWord + word("ffffffffffffffffffffffffffffffffffffffff") + word("1"), true, "all of your USDC"),
            ("0xd505accf" + word(String(hot.dropFirst(2))) + spenderWord + maxWord + maxWord + word("1b") + word("1") + word("2"), true, "spend your USDC"),
            ("0x12345678", false, "contract call"),
        ]
        for (data, isStrong, headline) in cases {
            let (task, approval) = await rig.start("eth_sendTransaction", rig.sendParameters(to: usdcText, value: "0x0", data: data))
            guard case .transaction(let review) = approval.action else { Issue.record("Not a transaction"); return }
            #expect(approval.needsAcknowledgment == isStrong, "\(data)")
            #expect(review.headline.contains(headline), "\(review.headline) for \(data)")
            rig.bridge.cancelAll(connection: rig.connection)
            _ = await task.value
        }
    }

    @Test func aTypedPermitTakesAcknowledgingAndAStrongWarning() async throws {
        let rig = SiteRig()
        await rig.connect()
        let (task, approval) = await rig.start("eth_signTypedData_v4", .array([.string(hot), permitJSON(domainExtra: #","verifyingContract":"\#(usdcText)""#)]))
        #expect(approval.needsAcknowledgment)
        guard case .message(let review) = approval.action else { Issue.record("Not a message"); return }
        #expect(review.contract == EthereumAddress(usdcText))
        #expect(review.body.contains("spender: 0x4444"))
        #expect(approval.warnings.first?.text.contains("0x4444") == true)

        await rig.bridge.approve(approval.id)
        #expect(await rig.signer.signedMessages.isEmpty)
        await rig.bridge.approve(approval.id, acknowledged: true)
        let signature = try #require(try await task.value.get().string)
        #expect(signature.count == 132)
        #expect(rig.presence.reasons == ["sign a message for \(site)"])
        guard case .typedData = await rig.signer.signedMessages.first else { Issue.record("Not typed data"); return }
    }

    @Test func typedDataWithNoChainIsWarnedAbout() async {
        let rig = SiteRig()
        await rig.connect()
        let json = JSONValue.string(#"{"domain":{"name":"x"},"types":{"Note":[{"name":"text","type":"string"}]},"primaryType":"Note","message":{"text":"hi"}}"#)
        let (task, approval) = await rig.start("eth_signTypedData_v4", .array([.string(hot), json]))
        #expect(approval.needsAcknowledgment)
        rig.bridge.reject(approval.id)
        _ = await task.value
    }

    @Test func plainTypedDataOnBaseIsntSomethingToBeAlarmedAbout() async {
        let rig = SiteRig()
        await rig.connect()
        let json = JSONValue.string(#"{"domain":{"name":"x","chainId":8453},"types":{"Note":[{"name":"text","type":"string"}]},"primaryType":"Note","message":{"text":"hi"}}"#)
        let (task, approval) = await rig.start("eth_signTypedData_v4", .array([.string(hot), json]))
        #expect(!approval.needsAcknowledgment)
        rig.bridge.reject(approval.id)
        _ = await task.value
    }

    /// A chain and contract on screen that the signature doesn't cover. Changing the chain here wouldn't change a single signed byte.
    @Test func aClaimedChainThatIsntSignedIsRefusedWithoutAsking() async {
        let rig = SiteRig()
        await rig.connect()
        let json = JSONValue.string(#"{"domain":{"chainId":8453,"verifyingContract":"\#(usdcText)"},"types":{"EIP712Domain":[],"Note":[{"name":"text","type":"string"}]},"primaryType":"Note","message":{"text":"hi"}}"#)
        #expect(code(await rig.ask("eth_signTypedData_v4", .array([.string(hot), json]))) == -32602)
        let extra = JSONValue.string(#"{"domain":{"chainId":8453},"types":{"Note":[{"name":"text","type":"string"}]},"primaryType":"Note","message":{"text":"hi","spender":"0x4444444444444444444444444444444444444444"}}"#)
        #expect(code(await rig.ask("eth_signTypedData_v4", .array([.string(hot), extra]))) == -32602)
        #expect(rig.bridge.pending.isEmpty)
        #expect(await rig.signer.signedMessages.isEmpty)
    }

    @Test func malformedTypedDataIsRefusedWithoutAsking() async {
        let rig = SiteRig()
        await rig.connect()
        #expect(code(await rig.ask("eth_signTypedData_v4", .array([.string(hot), .string("{}")]))) == -32602)
        #expect(code(await rig.ask("eth_signTypedData_v4", .array([.string(hot)]))) == -32602)
        #expect(rig.bridge.pending.isEmpty)
    }

    @Test func aMessageIsShownAsTextOnlyWhenThatsAllItIs() async throws {
        let rig = SiteRig()
        await rig.connect()
        let hex = { (text: String) in JSONValue.string("0x" + Hex.encode(Array(text.utf8))) }
        let cases: [(JSONValue, Bool)] = [
            (hex("Hello\nthere"), false),
            (.string("plain text"), false),
            (.string("0x" + String(repeating: "ab", count: 32)), true),
            (hex("Looks fine\u{202E}but isn't"), true),
            (hex("zero\u{200B}width"), true),
            (hex("\(URL(string: site)!.host()!) wants you to sign in with your Ethereum account:\n\(hot)"), false),
            (hex("other.example.com wants you to sign in with your Ethereum account:\n\(hot)"), true),
        ]
        for (message, isStrong) in cases {
            let (task, approval) = await rig.start("personal_sign", .array([message, .string(hot)]))
            #expect(approval.needsAcknowledgment == isStrong, "\(message)")
            rig.bridge.cancelAll(connection: rig.connection)
            _ = await task.value
        }

        let (task, approval) = await rig.start("personal_sign", .array([hex("Hello"), .string(hot)]))
        guard case .message(let review) = approval.action else { Issue.record("Not a message"); return }
        #expect(review.body == "Hello")
        await rig.bridge.approve(approval.id)
        _ = try await task.value.get()
        #expect(await rig.signer.signedMessages == [.personal(Array("Hello".utf8))])
    }

    @Test func sendingToNothingGetsAStrongWarning() async {
        let rig = SiteRig()
        await rig.connect()
        let (task, approval) = await rig.start("eth_sendTransaction", rig.sendParameters(to: EthereumAddress.zero.lowercased))
        #expect(approval.needsAcknowledgment)
        rig.bridge.cancelAll(connection: rig.connection)
        _ = await task.value
    }

    @Test func notEnoughEthIsSaidUpFront() async {
        let rig = SiteRig(snapshot(eth: 1))
        await rig.connect()
        let (task, approval) = await rig.start("eth_sendTransaction", rig.sendParameters())
        #expect(approval.warnings.contains { $0.text == SiteWording.notEnoughEth })
        rig.bridge.cancelAll(connection: rig.connection)
        _ = await task.value
    }

    // MARK: Reads

    @Test func readsReachTheNodeWithoutConnecting() async {
        let rig = SiteRig()
        #expect(await rig.ask("eth_call", .array([])) == .success(.string("0xread")))
        #expect(await rig.chain.reads == ["eth_call"])
    }

    @Test func readsCantUseUpTheWalletsShareOfTheNode() async {
        final class Clock: @unchecked Sendable { var now = Date(timeIntervalSince1970: 1000) }
        let clock = Clock()
        let rig = SiteRig(now: { clock.now })
        for _ in 0..<SiteBridge.readsPerSecond {
            #expect(await rig.ask("eth_blockNumber") == .success(.string("0xread")))
        }
        #expect(code(await rig.ask("eth_blockNumber")) == -32005)
        clock.now = clock.now.addingTimeInterval(1)
        #expect(await rig.ask("eth_blockNumber") == .success(.string("0xread")))
    }

    // MARK: Records from before this

    @Test func recordsFromBeforeSitesExistedStillLoad() throws {
        let json = #"{"retired":[],"records":[],"sweptGains":[],"acknowledged":[]}"#
        let state = try JSONDecoder().decode(DeviceWalletState.self, from: Data(json.utf8))
        #expect(state.connectedSites == nil)
        let record = #"{"hash":"0x1","nonce":0,"to":"\#(hot)","symbol":"ETH","decimals":18,"amount":"1","gainUsdMicros":"0","reason":"manual","createdAt":0,"status":"confirmed"}"#
        #expect(try JSONDecoder().decode(SignedRecord.self, from: Data(record.utf8)).site == nil)
    }
}

#if os(macOS)
/// The real socket and framing, with what the extension's host would send.
@MainActor
@Suite(.serialized) struct BridgeServerTests {
    private func path() -> String {
        "/tmp/pb\(UUID().uuidString.prefix(8)).sock"
    }

    private func connect(_ path: String) throws -> Int32 {
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: path.utf8) }
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        try #require(result == 0)
        var timeout = timeval(tv_sec: 5, tv_usec: 0)
        setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        return descriptor
    }

    private func send(_ json: String, to descriptor: Int32) {
        let body = Data(json.utf8)
        var length = UInt32(body.count)
        let frame = withUnsafeBytes(of: &length) { Data($0) } + body
        _ = frame.withUnsafeBytes { write(descriptor, $0.baseAddress!, frame.count) }
    }

    /// Off the main actor, since the server needs it to answer.
    private nonisolated func receive(from descriptor: Int32) async -> JSONValue? {
        await Task.detached {
            func readExactly(_ count: Int) -> Data? {
                var data = Data(count: count)
                var offset = 0
                while offset < count {
                    let got = data.withUnsafeMutableBytes { read(descriptor, $0.baseAddress! + offset, count - offset) }
                    guard got > 0 else { return nil }
                    offset += got
                }
                return data
            }
            guard let header = readExactly(4) else { return nil }
            let length = header.withUnsafeBytes { Int($0.loadUnaligned(as: UInt32.self)) }
            guard let body = readExactly(length) else { return nil }
            return try? JSONDecoder().decode(JSONValue.self, from: body)
        }.value
    }

    private func waitForPending(_ bridge: SiteBridge, count: Int = 1) async throws {
        for _ in 0..<500 where bridge.pending.count != count {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(bridge.pending.count == count)
    }

    @Test func aRequestAndItsAnswer() async throws {
        let rig = SiteRig()
        let path = path()
        let server = BridgeServer(bridge: rig.bridge, path: path)
        try server.start()
        defer { server.stop() }
        var mode = stat()
        #expect(stat(path, &mode) == 0)
        #expect(mode.st_mode & 0o077 == 0, "only this user can open it")

        let client = try connect(path)
        defer { close(client) }
        send(#"{"kind":"site","id":"7","origin":"https://a.example.com","method":"eth_chainId"}"#, to: client)
        let answer = await receive(from: client)
        #expect(answer?["id"] == .string("7"))
        #expect(answer?["result"] == .string("0x2105"))

        send(#"{"kind":"site","id":"8","origin":"https://a.example.com","method":"eth_sign","params":[]}"#, to: client)
        let refused = await receive(from: client)
        #expect(refused?["id"] == .string("8"))
        #expect(refused?["error"]?["code"]?.integer == 4200)
    }

    @Test func nothingOnTheWireCanAnswerAnApproval() async throws {
        let rig = SiteRig()
        let path = path()
        let server = BridgeServer(bridge: rig.bridge, path: path)
        try server.start()
        defer { server.stop() }
        let client = try connect(path)
        defer { close(client) }

        send(#"{"kind":"site","id":"1","origin":"https://a.example.com","method":"eth_requestAccounts"}"#, to: client)
        try await waitForPending(rig.bridge)
        let id = try #require(rig.bridge.current?.id)
        for attempt in [
            #"{"kind":"approve","id":"\#(id)"}"#,
            #"{"kind":"approval","id":"1","approved":true}"#,
            #"{"kind":"popup","id":"2","method":"approve","params":["\#(id)"]}"#,
            #"{"kind":"site","id":"3","origin":"https://a.example.com","method":"patina_approve","params":["\#(id)"]}"#,
            "not json",
        ] {
            send(attempt, to: client)
        }
        try await Task.sleep(for: .milliseconds(200))
        #expect(rig.bridge.current?.id == id)
        #expect(rig.stateStore.saved.connectedSites == nil)
    }

    @Test func goingAwayCancelsWhatsWaiting() async throws {
        let rig = SiteRig()
        let path = path()
        let server = BridgeServer(bridge: rig.bridge, path: path)
        try server.start()
        defer { server.stop() }
        let client = try connect(path)
        send(#"{"kind":"site","id":"1","origin":"https://a.example.com","method":"eth_requestAccounts"}"#, to: client)
        try await waitForPending(rig.bridge)
        send(#"{"kind":"cancel","id":"1"}"#, to: client)
        try await waitForPending(rig.bridge, count: 0)

        send(#"{"kind":"site","id":"2","origin":"https://b.example.com","method":"eth_requestAccounts"}"#, to: client)
        try await waitForPending(rig.bridge)
        close(client)
        try await waitForPending(rig.bridge, count: 0)
    }

    /// The host's frames come as fast as they come, so a cancel can follow its request straight away, and either can beat the node.
    @Test func goingAwayWhileTheNodeIsWorkingLeavesNothingToApprove() async throws {
        for closes in [false, true] {
            let rig = SiteRig()
            await rig.connect()
            await rig.chain.hold(estimates: true)
            let path = path()
            let server = BridgeServer(bridge: rig.bridge, path: path)
            try server.start()
            defer { server.stop() }
            let client = try connect(path)
            let site = #"{"kind":"site","id":"1","origin":"\#(site)","method":"eth_sendTransaction","params":[{"from":"\#(hot)","to":"\#(recipient)"}]}"#
            send(site, to: client)
            if closes {
                for _ in 0..<500 {
                    if await rig.chain.heldCalls > 0 { break }
                    try await Task.sleep(for: .milliseconds(10))
                }
                #expect(await rig.chain.heldCalls == 1)
                close(client)
                // Gives the server time to hear it's gone.
                try await Task.sleep(for: .milliseconds(200))
            } else {
                send(#"{"kind":"cancel","id":"1"}"#, to: client)
                try await Task.sleep(for: .milliseconds(200))
            }
            await rig.chain.release()
            try await Task.sleep(for: .milliseconds(200))
            #expect(rig.bridge.pending.isEmpty, "closes: \(closes)")
            #expect(await rig.signer.signed.isEmpty)
            if !closes { close(client) }
        }
    }

    @Test func tooBigAFrameEndsTheConnection() async throws {
        let rig = SiteRig()
        let path = path()
        let server = BridgeServer(bridge: rig.bridge, path: path)
        try server.start()
        defer { server.stop() }
        let client = try connect(path)
        defer { close(client) }
        var length = UInt32(BridgeServer.maxFrame + 1)
        _ = withUnsafeBytes(of: &length) { write(client, $0.baseAddress!, 4) }
        #expect(await receive(from: client) == nil)
    }

    @Test func accountsChangesReachEveryConnection() async throws {
        let rig = SiteRig()
        let path = path()
        let server = BridgeServer(bridge: rig.bridge, path: path)
        try server.start()
        defer { server.stop() }
        let client = try connect(path)
        defer { close(client) }
        // Once it's answered this, the server has the connection.
        send(#"{"kind":"popup","id":"1","method":"status"}"#, to: client)
        let status = await receive(from: client)
        #expect(status?["result"]?["address"]?.string == hotAddress.checksummed)

        rig.bridge.disconnect("https://a.example.com")
        let event = await receive(from: client)
        #expect(event?["event"] == .string("accountsChanged"))
        #expect(event?["origin"] == .string("https://a.example.com"))
        #expect(event?["data"] == .array([]))
    }

    @Test func thePopupCanOpenTopUp() async throws {
        let rig = SiteRig()
        var asked = 0
        rig.bridge.onTopUp = { asked += 1 }
        let path = path()
        let server = BridgeServer(bridge: rig.bridge, path: path)
        try server.start()
        defer { server.stop() }
        let client = try connect(path)
        defer { close(client) }
        send(#"{"kind":"popup","id":"1","method":"topUp"}"#, to: client)
        _ = await receive(from: client)
        #expect(asked == 1)
    }

    @Test func anAnswerTooBigToPassAlongOnlyFailsItself() async throws {
        let rig = SiteRig()
        let reply = BridgeServer.reply(id: "9", .success(.string(String(repeating: "x", count: BridgeServer.maxFrame + 1))))
        var descriptors: [Int32] = [0, 0]
        #expect(socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0)
        let connection = BridgeConnection(descriptor: descriptors[0])
        connection.send(reply)
        let answer = await receive(from: descriptors[1])
        #expect(answer?["id"] == .string("9"))
        #expect(answer?["error"]?["code"]?.integer == -32603)
        close(descriptors[1])
        _ = rig
    }

    @Test func aSocketPathThatFits() throws {
        let path = try #require(BridgeEndpoint.socketPath(bundleIdentifier: "com.benface.pricetag.macos.wallet"))
        #expect(path.hasSuffix("/Library/Group Containers/\(BridgeEndpoint.group)/wallet.sock"))
    }
}
#endif
