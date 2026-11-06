#if DEBUG
import Foundation
import HotWalletKit
import KeyVault
import PricetagKit

/// A hot wallet in one state, from fixtures. It reads the chain and its history once, through the real code, and nothing else happens:
/// it's never started, has no key, and reaching for one ends the scene instead of drawing whatever comes of it.
struct HotWalletFixture {
    enum KeyAnswer { case hasIt, isMissing, notProvisioned }

    static let spending = TestMode.live.flatMap { EthereumAddress($0.wallet) } ?? EthereumAddress("0x00000000000000000000000000000000000de301")!
    private static let replacement = EthereumAddress("0x00000000000000000000000000000000000de303")!
    private static let block: UInt64 = 53_505_400
    /// Fixed, so a scene looks the same whenever it's taken.
    private nonisolated static let today = Date(timeIntervalSince1970: 1_793_750_400)
    static let savings = EthereumAddress("0x00000000000000000000000000000000000de302")!
    private static let secondSavings = EthereumAddress("0x00000000000000000000000000000000000de308")!
    static let site = "https://app.example.com"
    /// What a simulation says these do, in `FixtureChain`.
    static let swapRouter = "0x2626664c2603336e57b271c5c0b26f421741e481"
    static let unknownRouter = "0x00000000000000000000000000000000000de305"
    static let longRouter = "0x00000000000000000000000000000000000de307"

    private var hasWallet = true
    private var wasDeleted = false
    private var hasSavings = true
    private var hasSecondSavings = false
    private var balances: [String: UInt128] = ["ETH": 5_000_000_000_000_000, "USDC": 20_000_000]
    private var keys = KeyAnswer.hasIt
    private var unexplainedTransactions = 0
    private var hasRecords = false
    private var rotation: Rotation?
    private var canActOnChain = false
    private var recordsAreUnreadable = false
    private var isConnectedToSite = false
    private var hasSiteActivity = false
    private var isReplaced = false

    /// No wallet yet, which is also what every scene that isn't about one gets.
    static let none = HotWalletFixture(hasWallet: false, hasSavings: false, balances: [:])
    static let notProvisioned = HotWalletFixture(hasWallet: false, hasSavings: false, balances: [:], keys: .notProvisioned)
    static let unreadableRecords = HotWalletFixture(hasWallet: false, hasSavings: false, balances: [:], recordsAreUnreadable: true)
    static let funded = HotWalletFixture(hasRecords: true)
    static let twoSavings = HotWalletFixture(hasSecondSavings: true)
    static let connectedToSite = HotWalletFixture(isConnectedToSite: true)
    /// Connected to a site and to one on this Mac, with the first's transactions: one that went through, and one that fails once it's read.
    static let usedBySites = HotWalletFixture(hasSiteActivity: true)
    static let noSavings = HotWalletFixture(hasSavings: false, balances: ["ETH": 1_000_000_000_000_000, "USDC": 10_000_000])
    static let noPrice = HotWalletFixture(balances: ["ETH": 5_000_000_000_000_000, "USDC": 20_000_000, "AERO": 12_000_000_000_000_000_000])
    static let nearCap = HotWalletFixture(balances: ["ETH": 5_000_000_000_000_000, "USDC": 36_000_000])
    static let overCap = HotWalletFixture(balances: ["ETH": 10_000_000_000_000_000, "USDC": 80_000_000])
    static let overCapNoSavings = HotWalletFixture(hasSavings: false, balances: ["ETH": 10_000_000_000_000_000, "USDC": 80_000_000])
    static let noGas = HotWalletFixture(balances: ["USDC": 20_000_000])
    static let keyMissing = HotWalletFixture(keys: .isMissing)
    /// Spending money was deleted, which leaves its old address behind and no other.
    static let deleted = HotWalletFixture(hasWallet: false, wasDeleted: true, hasSavings: false, balances: [:])
    static let alarm = HotWalletFixture(unexplainedTransactions: 1)
    static let replacingKey = HotWalletFixture(rotation: Rotation(from: spending, to: replacement, destination: replacement))
    /// Tokens and no ETH, so the old key can't be emptied, and there's nothing it could sign.
    static let replacingKeyStuck = HotWalletFixture(balances: ["USDC": 20_000_000], rotation: Rotation(from: spending, to: replacement, destination: replacement), canActOnChain: true)
    /// The key's been replaced, so its activity, and what was bought for it, belong to a key that's gone.
    static let replaced = HotWalletFixture(hasRecords: true, isReplaced: true)
    static let replacingKeyMissing = HotWalletFixture(keys: .isMissing, rotation: Rotation(from: spending, to: replacement, destination: replacement))

    func make(source: any PortfolioSource, costMethod: @escaping @MainActor () -> CostMethod, moneyDisplay: @escaping @MainActor () -> MoneyDisplay) -> HotWallet {
        HotWallet(
            signer: NoKeys(answer: keys),
            settingsStore: FixedSettings(settings: settings),
            stateStore: FixedState(state: recordsAreUnreadable ? nil : state),
            presence: NoOneThere(),
            portfolioSource: { source },
            costMethod: costMethod,
            moneyDisplay: moneyDisplay,
            makeChain: { [snapshot, isConnectedToSite, failing] url -> any ChainClient in
                if TestMode.live != nil { return ReadOnlyChain(node: RPCChainClient(url: url)) }
                return FixtureChain(snapshot: snapshot, canQuote: isConnectedToSite, failing: failing)
            },
            now: { TestMode.live == nil ? Self.today : .now }
        )
    }

    private var settings: WalletSettings {
        var settings = WalletSettings()
        if hasSavings { settings.add(ColdWallet(address: Self.savings, name: "Ledger", confirmedOnDeviceAt: Self.today)) }
        if hasSecondSavings { settings.add(ColdWallet(address: Self.secondSavings, name: "Trezor", confirmedOnDeviceAt: Self.today)) }
        return settings
    }

    private var state: DeviceWalletState {
        var state = DeviceWalletState()
        if wasDeleted { state.retired = [Self.spending] }
        guard hasWallet else { return state }
        state.active = isReplaced ? Self.replacement : Self.spending
        if isReplaced { state.retired = [Self.spending] }
        state.rotation = rotation
        if isConnectedToSite { state.connectedSites = [Self.site] }
        if hasRecords, TestMode.live == nil { state.records[Self.spending] = records }
        if hasSiteActivity, TestMode.live == nil {
            state.connectedSites = [Self.site, "http://localhost:5173"]
            state.records[Self.spending] = siteRecords
        }
        // The demo portfolio is another wallet's history, so what it spent is news to this one unless it's been looked at.
        let history: Portfolio? = TestMode.live == nil ? try? FixtureSource.decode("demo-portfolio") : Self.liveHistory
        state.acknowledged = (history?.outgoingTxs ?? []).dropFirst(unexplainedTransactions).map { .unknownTransaction(hash: $0) }
        // Reads as older than its last sweep, which is what makes a wallet wait instead of signing. A plan to sweep still shows.
        if !canActOnChain { state.settledThroughBlock = TestMode.live == nil ? Self.block + 1 : .max }
        return state
    }

    private var snapshot: ChainSnapshot {
        ChainSnapshot(
            chainID: Base.chainID,
            blockNumber: Self.block,
            nonce: hasRecords ? 3 : hasSiteActivity ? 2 : 0,
            balances: Dictionary(uniqueKeysWithValues: Base.tokens.compactMap { token in balances[token.symbol].map { (token, $0) } }),
            ethUsdMicros: 2_640_000_000,
            usdcUsdMicros: 999_800,
            fees: FeeQuote(maxFeePerGas: 10_000_000, maxPriorityFeePerGas: 1_000_000, l1FeeWei: 100_000_000_000)
        )
    }

    /// What the wallet has spent, which this has no records of, so it isn't taken for a stolen key. Blocks until it's read, because a scene needs it before it starts.
    private static var liveHistory: Portfolio? {
        guard let live = TestMode.live else { return nil }
        // A first read can outlast one request, and the server keeps going, so another picks it up. Without this, everything it ever spent would raise the alarm.
        for _ in 0..<4 {
            if let data = try? Data(contentsOf: live.server.appending(path: "/api/portfolio/\(live.wallet)")), let history = try? JSONDecoder().decode(Portfolio.self, from: data) { return history }
        }
        TestMode.fail("Couldn't read this wallet's history from the server.")
    }

    /// One of each way a transaction can end up, and each reason to send one.
    private var records: [SignedRecord] {
        [
            record(0, "USDC", 6, "12000000", .aboveCap, .confirmed),
            record(1, "ETH", 18, "4000000000000000", gain: "3000000", .aboveCap, .failed),
            record(2, "USDC", 6, "30000000", .manual, .confirmed),
            record(3, "ETH", 18, "1000000000000000", .aboveCap, .dropped),
            record(3, "USDC", 6, "5000000", .aboveCap, .pending),
        ]
    }

    private var siteRecords: [SignedRecord] {
        [
            record(0, "USDC", 6, "12000000", .site, .confirmed, site: Self.site),
            record(1, "ETH", 18, "1000000000000000", .site, .pending, site: Self.site),
        ]
    }

    /// The one transaction a scene's node says failed, which is what makes the wallet warn about it.
    private var failing: String? {
        guard hasSiteActivity else { return nil }
        return siteRecords.first { $0.status == .pending }?.hash
    }

    private func record(_ nonce: UInt64, _ symbol: String, _ decimals: Int, _ amount: String, gain: String = "0", _ reason: SignedRecord.Reason, _ status: SignedRecord.Status, site: String? = nil) -> SignedRecord {
        SignedRecord(
            hash: "0xde4" + String(repeating: "0", count: 59) + String(nonce) + (status == .dropped ? "d" : "0"),
            nonce: nonce, to: Self.savings, symbol: symbol, decimals: decimals, amount: amount, usdMicros: nil, gainUsdMicros: gain,
            reason: reason, createdAt: Self.today.addingTimeInterval(TimeInterval(3 - nonce) * -86400), status: status, site: site
        )
    }
}

/// The test mode never makes, loads or signs with a key, and this is what makes sure of it.
private nonisolated struct NoKeys: Signer {
    let answer: HotWalletFixture.KeyAnswer

    func createKey() async throws -> EthereumAddress { TestMode.fail("A scene tried to make a key.") }
    func sign(_ transaction: UnsignedTransaction, from address: EthereumAddress) async throws -> SignedTransaction { TestMode.fail("A scene tried to sign.") }
    func sign(_ message: SignableMessage, from address: EthereumAddress) async throws -> MessageSignature { TestMode.fail("A scene tried to sign a message.") }
    func hasKey(_ address: EthereumAddress) async throws -> Bool { answer == .hasIt }
    func deleteKey(_ address: EthereumAddress) async throws { TestMode.fail("A scene tried to delete a key.") }

    func addresses() async throws -> [EthereumAddress] {
        if answer == .notProvisioned { throw KeychainSealedKeyStore.Failure.notProvisioned }
        return []
    }
}

/// Keeps nothing, so what a scene does stays in memory.
private nonisolated struct FixedSettings: WalletSettingsStore {
    let settings: WalletSettings

    func load() -> WalletSettings { settings }
    func save(_ settings: WalletSettings) {}
}

private nonisolated struct FixedState: DeviceStateStore {
    /// nil can't be read.
    let state: DeviceWalletState?

    func load() throws -> DeviceWalletState {
        guard let state else { throw CocoaError(.fileReadCorruptFile) }
        return state
    }

    func save(_ state: DeviceWalletState) throws {}
}

private nonisolated struct NoOneThere: UserPresence {
    func confirm(reason: String) async throws { TestMode.fail("A scene asked for Touch ID: \(reason).") }
}

/// The real node, for `shot.sh --live`, with everything that isn't a read taken away.
private nonisolated struct ReadOnlyChain: ChainClient {
    let node: RPCChainClient

    func snapshot(of address: EthereumAddress) async throws -> ChainSnapshot { try await node.snapshot(of: address) }
    func estimateGas(from: EthereumAddress, to: EthereumAddress, value: UInt128, data: [UInt8]) async throws -> UInt64 { try await node.estimateGas(from: from, to: to, value: value, data: data) }
    func send(_ transaction: SignedTransaction) async throws { TestMode.fail("A scene tried to send a transaction.") }
    func receipt(of hash: String) async throws -> Receipt? { try await node.receipt(of: hash) }
    func read(_ method: String, _ parameters: JSONValue) async throws -> RPCAnswer { TestMode.fail("A scene tried to read for a site.") }
    func l1Fee(ofPayload payload: [UInt8]) async throws -> UInt128 { try await node.l1Fee(ofPayload: payload) }
}

/// Stands in for the node. It only ever answers reads, and what a transaction would cost only for a site's scenes, which need it to show one.
private nonisolated struct FixtureChain: ChainClient {
    let snapshot: ChainSnapshot
    let canQuote: Bool
    let failing: String?

    func snapshot(of address: EthereumAddress) async throws -> ChainSnapshot { snapshot }

    func estimateGas(from: EthereumAddress, to: EthereumAddress, value: UInt128, data: [UInt8]) async throws -> UInt64 {
        guard canQuote else { TestMode.fail("A scene tried to send a transaction.") }
        return 120_000
    }

    func send(_ transaction: SignedTransaction) async throws { TestMode.fail("A scene tried to send a transaction.") }
    func receipt(of hash: String) async throws -> Receipt? { hash == failing ? Receipt(succeeded: false, blockNumber: snapshot.blockNumber) : nil }

    /// Only what a preview asks. A node that can't simulate is what `site-transaction` shows.
    func read(_ method: String, _ parameters: JSONValue) async throws -> RPCAnswer {
        guard canQuote, method == "eth_simulateV1" else { TestMode.fail("A scene tried to read for a site.") }
        guard let call = parameters[0]?["blockStateCalls"]?[0]?["calls"]?[0], let wallet = call["from"]?.string, let to = call["to"]?.string else { TestMode.fail("That isn't a simulation.") }
        let usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
        let eth = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
        let unknownToken = "0x00000000000000000000000000000000000de306"
        let logs: [JSONValue]
        switch to {
        case HotWalletFixture.swapRouter:
            logs = [Self.log(usdc, .transfer, wallet, to, 200_000_000), Self.log(eth, .transfer, to, wallet, 75_700_000_000_000_000)]
        case HotWalletFixture.unknownRouter:
            logs = [
                Self.log(eth, .transfer, wallet, to, 2_000_000_000_000_000),
                Self.log(unknownToken, .transfer, to, wallet, 1_000_000_000_000_000_000),
                Self.log(usdc, .approval, wallet, to, UInt128.max),
            ]
        case HotWalletFixture.longRouter:
            let dai = "0x50c5725949a6f0c72e6c4a641f24049a917db0cb"
            let unknownTokens = (0..<12).map { index in "0x00000000000000000000000000000000000de4" + String(format: "%02x", index) }
            logs = [
                Self.log(usdc, .transfer, wallet, to, 200_000_000),
                Self.log(usdc, .approval, wallet, to, 5_000_000),
                Self.log(dai, .approval, wallet, to, 5_000_000_000_000_000_000),
                Self.log(unknownToken, .approval, wallet, to, UInt128.max),
            ] + unknownTokens.map { Self.log($0, .transfer, to, wallet, 1) }
        default:
            return .failure(SiteError(code: -32601, message: "the method eth_simulateV1 does not exist/is not available"))
        }
        return .success(.array([.object(["timestamp": .string("0x6aec0daf"), "calls": .array([.object(["status": .string("0x1"), "logs": .array(logs)])])])]))
    }

    private enum LogKind: String {
        case transfer = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
        case approval = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925"
    }

    private static func log(_ address: String, _ kind: LogKind, _ from: String, _ to: String, _ amount: UInt128) -> JSONValue {
        func topic(_ address: String) -> JSONValue { .string("0x" + String(repeating: "0", count: 24) + address.dropFirst(2)) }
        let digits = String(amount, radix: 16)
        return .object(["address": .string(address), "topics": .array([.string(kind.rawValue), topic(from), topic(to)]), "data": .string("0x" + String(repeating: "0", count: 64 - digits.count) + digits)])
    }

    func l1Fee(ofPayload payload: [UInt8]) async throws -> UInt128 {
        guard canQuote else { TestMode.fail("A scene tried to price a transaction.") }
        return snapshot.fees.l1FeeWei
    }
}
#endif
