#if DEBUG
import Foundation
import HotWalletKit
import KeyVault
import PricetagKit

/// A hot wallet in one state, from fixtures. It reads the chain and its history once, through the real code, and nothing else happens:
/// it's never started, has no key, and reaching for one ends the scene instead of drawing whatever comes of it.
struct HotWalletFixture {
    enum KeyAnswer { case hasIt, isMissing, notProvisioned }

    private static let spending = TestMode.live.flatMap { EthereumAddress($0.wallet) } ?? EthereumAddress("0x00000000000000000000000000000000000de301")!
    private static let replacement = EthereumAddress("0x00000000000000000000000000000000000de303")!
    private static let block: UInt64 = 53_505_400
    /// Fixed, so a scene looks the same whenever it's taken.
    private nonisolated static let today = Date(timeIntervalSince1970: 1_793_750_400)
    static let savings = EthereumAddress("0x00000000000000000000000000000000000de302")!
    static let site = "https://app.example.com"

    private var hasWallet = true
    private var hasSavings = true
    private var balances: [String: UInt128] = ["ETH": 5_000_000_000_000_000, "USDC": 20_000_000]
    private var keys = KeyAnswer.hasIt
    private var unexplainedTransactions = 0
    private var hasRecords = false
    private var rotation: Rotation?
    private var canActOnChain = false
    private var recordsAreUnreadable = false
    private var isConnectedToSite = false

    /// No wallet yet, which is also what every scene that isn't about one gets.
    static let none = HotWalletFixture(hasWallet: false, hasSavings: false, balances: [:])
    static let notProvisioned = HotWalletFixture(hasWallet: false, hasSavings: false, balances: [:], keys: .notProvisioned)
    static let unreadableRecords = HotWalletFixture(hasWallet: false, hasSavings: false, balances: [:], recordsAreUnreadable: true)
    static let funded = HotWalletFixture(hasRecords: true)
    static let connectedToSite = HotWalletFixture(isConnectedToSite: true)
    static let noSavings = HotWalletFixture(hasSavings: false, balances: ["ETH": 1_000_000_000_000_000, "USDC": 10_000_000])
    static let noPrice = HotWalletFixture(balances: ["ETH": 5_000_000_000_000_000, "USDC": 20_000_000, "AERO": 12_000_000_000_000_000_000])
    static let nearCap = HotWalletFixture(balances: ["ETH": 5_000_000_000_000_000, "USDC": 36_000_000])
    static let overCap = HotWalletFixture(balances: ["ETH": 10_000_000_000_000_000, "USDC": 80_000_000])
    static let overCapNoSavings = HotWalletFixture(hasSavings: false, balances: ["ETH": 10_000_000_000_000_000, "USDC": 80_000_000])
    static let keyMissing = HotWalletFixture(keys: .isMissing)
    static let alarm = HotWalletFixture(unexplainedTransactions: 1)
    static let replacingKey = HotWalletFixture(rotation: Rotation(from: spending, to: replacement, destination: replacement))
    /// Tokens and no ETH, so the old key can't be emptied, and there's nothing it could sign.
    static let replacingKeyStuck = HotWalletFixture(balances: ["USDC": 20_000_000], rotation: Rotation(from: spending, to: replacement, destination: replacement), canActOnChain: true)
    static let replacingKeyMissing = HotWalletFixture(keys: .isMissing, rotation: Rotation(from: spending, to: replacement, destination: replacement))

    func make(source: any PortfolioSource, costMethod: @escaping @MainActor () -> CostMethod, mainCurrency: @escaping @MainActor () -> CurrencyCode) -> HotWallet {
        HotWallet(
            signer: NoKeys(answer: keys),
            settingsStore: FixedSettings(settings: settings),
            stateStore: FixedState(state: recordsAreUnreadable ? nil : state),
            presence: NoOneThere(),
            portfolioSource: { source },
            costMethod: costMethod,
            mainCurrency: mainCurrency,
            makeChain: { [snapshot, isConnectedToSite] url -> any ChainClient in
                if TestMode.live != nil { return ReadOnlyChain(node: RPCChainClient(url: url)) }
                return FixtureChain(snapshot: snapshot, canQuote: isConnectedToSite)
            },
            now: { TestMode.live == nil ? Self.today : .now }
        )
    }

    private var settings: WalletSettings {
        var settings = WalletSettings()
        if hasSavings { settings.add(ColdWallet(address: Self.savings, name: "Ledger", confirmedOnDeviceAt: Self.today)) }
        return settings
    }

    private var state: DeviceWalletState {
        var state = DeviceWalletState()
        guard hasWallet else { return state }
        state.active = Self.spending
        state.rotation = rotation
        if isConnectedToSite { state.connectedSites = [Self.site] }
        if hasRecords, TestMode.live == nil { state.records[Self.spending] = records }
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
            nonce: hasRecords ? 3 : 0,
            balances: Dictionary(uniqueKeysWithValues: Base.tokens.compactMap { token in balances[token.symbol].map { (token, $0) } }),
            ethUsdMicros: 2_640_000_000,
            usdcUsdMicros: 999_800,
            fees: FeeQuote(maxFeePerGas: 10_000_000, maxPriorityFeePerGas: 1_000_000, l1FeeWei: 100_000_000_000)
        )
    }

    /// What the wallet has spent, which this has no records of, so it isn't taken for a stolen key. Blocks until it's read, because a scene needs it before it starts.
    private static var liveHistory: Portfolio? {
        guard let live = TestMode.live, let data = try? Data(contentsOf: live.server.appending(path: "/api/portfolio/\(live.wallet)")) else { return nil }
        return try? JSONDecoder().decode(Portfolio.self, from: data)
    }

    /// One of each way a transaction can end up, and each reason to send one.
    private var records: [SignedRecord] {
        func record(_ nonce: UInt64, _ symbol: String, _ decimals: Int, _ amount: String, gain: String = "0", _ reason: SignedRecord.Reason, _ status: SignedRecord.Status) -> SignedRecord {
            SignedRecord(
                hash: "0xde4" + String(repeating: "0", count: 59) + String(nonce) + (status == .dropped ? "d" : "0"),
                nonce: nonce, to: Self.savings, symbol: symbol, decimals: decimals, amount: amount, usdMicros: nil, gainUsdMicros: gain,
                reason: reason, createdAt: Self.today.addingTimeInterval(TimeInterval(3 - nonce) * -86400), status: status
            )
        }
        return [
            record(0, "USDC", 6, "12000000", .aboveCap, .confirmed),
            record(1, "ETH", 18, "4000000000000000", gain: "3000000", .aboveCap, .failed),
            record(2, "USDC", 6, "30000000", .manual, .confirmed),
            record(3, "ETH", 18, "1000000000000000", .aboveCap, .dropped),
            record(3, "USDC", 6, "5000000", .aboveCap, .pending),
        ]
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

    func snapshot(of address: EthereumAddress) async throws -> ChainSnapshot { snapshot }

    func estimateGas(from: EthereumAddress, to: EthereumAddress, value: UInt128, data: [UInt8]) async throws -> UInt64 {
        guard canQuote else { TestMode.fail("A scene tried to send a transaction.") }
        return 120_000
    }

    func send(_ transaction: SignedTransaction) async throws { TestMode.fail("A scene tried to send a transaction.") }
    func receipt(of hash: String) async throws -> Receipt? { nil }
    func read(_ method: String, _ parameters: JSONValue) async throws -> RPCAnswer { TestMode.fail("A scene tried to read for a site.") }

    func l1Fee(ofPayload payload: [UInt8]) async throws -> UInt128 {
        guard canQuote else { TestMode.fail("A scene tried to price a transaction.") }
        return snapshot.fees.l1FeeWei
    }
}
#endif
