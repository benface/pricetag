import Foundation
@testable import KeyVault
import PricetagKit
@testable import HotWalletKit

let hotAddress = EthereumAddress("0x1111111111111111111111111111111111111111")!
let nextAddress = EthereumAddress("0x2222222222222222222222222222222222222222")!
let coldAddress = EthereumAddress("0x1234567890123456789012345678901234567890")!

func token(_ symbol: String) -> Token {
    Base.tokens.first { $0.symbol == symbol }!
}

let usdc = token("USDC")
let dai = token("DAI")
let weth = token("WETH")

let ethPrice: UInt128 = 3000 * Money.dollar
let oneEth: UInt128 = 1_000_000_000_000_000_000

/// 0.01 gwei gas, and an L1 fee of a tenth of a cent or so. Like Base on an ordinary day.
let cheapFees = FeeQuote(maxFeePerGas: 10_000_000, maxPriorityFeePerGas: 1_000_000, l1FeeWei: 300_000_000_000)

func usdcUnits(_ dollars: UInt128) -> UInt128 { dollars * 1_000_000 }

func snapshot(eth: UInt128 = oneEth / 100, tokens: [Token: UInt128] = [:], nonce: UInt64 = 0, chainID: UInt64 = Base.chainID, ethUsd: UInt128? = ethPrice, prices: [String: UInt128] = [:], fees: FeeQuote = cheapFees) -> ChainSnapshot {
    var balances: [Token: UInt128] = [Base.eth: eth]
    for (token, balance) in tokens { balances[token] = balance }
    return ChainSnapshot(chainID: chainID, blockNumber: 1000, nonce: nonce, balances: balances, ethUsdMicros: ethUsd, usdcUsdMicros: Money.dollar, otherUsdMicros: prices, fees: fees)
}

actor FakeChain: ChainClient {
    var current: ChainSnapshot
    var receipts: [String: Receipt] = [:]
    var estimate: UInt64 = 60000
    var sendFailure: ChainError?
    var estimateFailure: ChainError?
    /// How many sends get through before those two start failing.
    private var sendFailureAfter = 0
    private var estimateFailureAfter = 0
    var readFailure: ChainError?
    /// What a node says to `eth_simulateV1`, and to reading a price feed.
    var simulation: RPCAnswer = .failure(SiteError(code: -32601, message: "the method eth_simulateV1 does not exist/is not available"))
    var feedRound: RPCAnswer = .failure(SiteError(code: 3, message: "execution reverted"))
    /// What a node says to reading a contract, by its address and calldata, and which chain it's on.
    var callAnswers: [String: RPCAnswer] = [:]
    var chainIDAnswer: RPCAnswer?
    private(set) var simulationParameters: JSONValue?
    private(set) var sent: [SignedTransaction] = []
    private(set) var reads: [String] = []
    private(set) var l1FeePayloads: [[UInt8]] = []
    /// How many calls `hold` is keeping waiting, like a slow node.
    private(set) var heldCalls = 0
    private var snapshotFailures: [ChainError] = []
    private var holdsEstimates = false
    private var holdsSnapshots = false
    private var held: [CheckedContinuation<Void, Never>] = []
    private(set) var snapshotReads = 0
    private(set) var receiptReads = 0
    /// Set after each send, to read what was on disk at that moment.
    var onSend: (@Sendable (SignedTransaction) -> Void)?

    init(_ snapshot: ChainSnapshot) {
        current = snapshot
    }

    /// A new read always comes from after any receipt so far, unless a test says otherwise by not calling this.
    func set(_ snapshot: ChainSnapshot) {
        current = snapshot
        current.blockNumber = max(snapshot.blockNumber, receipts.values.map(\.blockNumber).max() ?? 0, current.blockNumber)
    }

    /// Receipts land in the block after the current read, like a node that's moved on since then.
    func setReceipt(_ hash: String, succeeded: Bool) { receipts[hash] = Receipt(succeeded: succeeded, blockNumber: current.blockNumber + 1) }
    func confirmAll() { for transaction in sent { setReceipt(transaction.hash, succeeded: true) } }
    func setSendFailure(_ failure: ChainError?, afterSends: Int = 0) {
        sendFailure = failure
        sendFailureAfter = afterSends
    }
    func setEstimateFailure(_ failure: ChainError?, afterSends: Int = 0) {
        estimateFailure = failure
        estimateFailureAfter = afterSends
    }
    func setReadFailure(_ failure: ChainError?) { readFailure = failure }
    func setSimulation(_ answer: RPCAnswer) { simulation = answer }
    func setFeedRound(_ answer: RPCAnswer) { feedRound = answer }
    func setChainID(_ answer: RPCAnswer) { chainIDAnswer = answer }
    func answerCall(_ call: String, _ answer: RPCAnswer) { callAnswers[call] = answer }
    func failSnapshots(_ times: Int, with failure: ChainError) { snapshotFailures = Array(repeating: failure, count: times) }
    func setOnSend(_ body: @escaping @Sendable (SignedTransaction) -> Void) { onSend = body }

    func hold(estimates: Bool = false, snapshots: Bool = false) {
        holdsEstimates = estimates
        holdsSnapshots = snapshots
    }

    func release() {
        holdsEstimates = false
        holdsSnapshots = false
        for call in held { call.resume() }
        held = []
        heldCalls = 0
    }

    private func wait() async {
        heldCalls += 1
        await withCheckedContinuation { held.append($0) }
    }

    func snapshot(of address: EthereumAddress) async throws -> ChainSnapshot {
        snapshotReads += 1
        if holdsSnapshots { await wait() }
        if !snapshotFailures.isEmpty { throw snapshotFailures.removeFirst() }
        if let readFailure { throw readFailure }
        return current
    }

    func estimateGas(from: EthereumAddress, to: EthereumAddress, value: UInt128, data: [UInt8]) async throws -> UInt64 {
        if holdsEstimates { await wait() }
        if let estimateFailure, sent.count >= estimateFailureAfter { throw estimateFailure }
        return data.isEmpty ? 21000 : estimate
    }

    func send(_ transaction: SignedTransaction) throws {
        if let sendFailure, sent.count >= sendFailureAfter { throw sendFailure }
        sent.append(transaction)
        onSend?(transaction)
    }

    func receipt(of hash: String) throws -> Receipt? {
        receiptReads += 1
        if let readFailure { throw readFailure }
        return receipts[hash]
    }

    func read(_ method: String, _ parameters: JSONValue) -> RPCAnswer {
        reads.append(method)
        if method == "eth_chainId", let chainIDAnswer { return chainIDAnswer }
        if method == "eth_call", case .string(let to)? = parameters[0]?["to"], case .string(let data)? = parameters[0]?["data"], let answer = callAnswers[to + data] { return answer }
        if method == "eth_simulateV1" {
            simulationParameters = parameters
            return simulation
        }
        if method == "eth_call", case .string(let to)? = parameters[0]?["to"], Oracle.others.values.contains(where: { $0.address.lowercased == to }) { return feedRound }
        return .success(.string("0xread"))
    }

    /// By size, like the real one, so a bigger transaction costs more.
    func l1Fee(ofPayload payload: [UInt8]) -> UInt128 {
        l1FeePayloads.append(payload)
        return UInt128(payload.count) * 1_000_000_000
    }
}

/// Remembers what it was asked to sign. It holds no key at all: the real vault has its own tests.
actor FakeSigner: Signer {
    private(set) var signed: [UnsignedTransaction] = []
    private(set) var signedMessages: [SignableMessage] = []
    private var signFailure: (any Error)?
    private var deleteFailure: (any Error)?
    private var keys: [EthereumAddress]
    private var unused: [EthereumAddress]

    init(keys: [EthereumAddress] = [], next: [EthereumAddress] = [hotAddress, nextAddress]) {
        self.keys = keys
        unused = next
    }

    func createKey() -> EthereumAddress {
        let key = unused.removeFirst()
        keys.append(key)
        return key
    }

    func setSignFailure(_ failure: (any Error)?) { signFailure = failure }

    func sign(_ transaction: UnsignedTransaction, from address: EthereumAddress) throws -> SignedTransaction {
        guard keys.contains(address) else { throw KeyVault.Failure.noSuchKey }
        if let signFailure { throw signFailure }
        signed.append(transaction)
        // Unique bytes for a unique hash. A node would reject this: the anvil test covers real signatures.
        return SignedTransaction(raw: transaction.signingPayload)
    }

    func sign(_ message: SignableMessage, from address: EthereumAddress) throws -> MessageSignature {
        guard keys.contains(address) else { throw KeyVault.Failure.noSuchKey }
        if let signFailure { throw signFailure }
        signedMessages.append(message)
        return MessageSignature(r: [UInt8](repeating: 1, count: 32), s: [UInt8](repeating: 2, count: 32), v: 27)
    }

    func hasKey(_ address: EthereumAddress) -> Bool { keys.contains(address) }
    func setDeleteFailure(_ failure: (any Error)?) { deleteFailure = failure }
    func deleteKey(_ address: EthereumAddress) throws {
        if let deleteFailure { throw deleteFailure }
        keys.removeAll { $0 == address }
    }
    func addresses() -> [EthereumAddress] { keys }
}

final class MemoryStateStore: DeviceStateStore, @unchecked Sendable {
    private let lock = NSLock()
    private var state = DeviceWalletState()
    private var saveFailure: (any Error)?

    var saved: DeviceWalletState { lock.withLock { state } }

    func failSaves(with failure: (any Error)?) { lock.withLock { saveFailure = failure } }

    func load() throws -> DeviceWalletState { saved }
    func save(_ state: DeviceWalletState) throws {
        try lock.withLock {
            if let saveFailure { throw saveFailure }
            self.state = state
        }
    }
}

final class MemorySettingsStore: WalletSettingsStore, @unchecked Sendable {
    private let lock = NSLock()
    private var settings = WalletSettings()

    func load() -> WalletSettings { lock.withLock { settings } }
    func save(_ settings: WalletSettings) { lock.withLock { self.settings = settings } }
}

struct FakePresence: UserPresence {
    let allows: Bool

    struct Refused: Error {}

    func confirm(reason: String) throws {
        if !allows { throw Refused() }
    }
}

/// Says yes, after doing something once while the prompt's open, like another window using the wallet.
final class OpenPrompt: UserPresence, @unchecked Sendable {
    var whileOpen: (@MainActor () async -> Void)?

    func confirm(reason: String) async {
        let body = whileOpen
        whileOpen = nil
        await body?()
    }
}

actor ScriptedPortfolios: PortfolioSource {
    private var next: Result<Portfolio, FetchError>
    private(set) var linked: [[String]] = []

    init(_ next: Result<Portfolio, FetchError>) {
        self.next = next
    }

    func set(_ next: Result<Portfolio, FetchError>) { self.next = next }

    /// Each read's pricing rule. Money only ever moves by the default.
    private(set) var rules: [String?] = []

    func portfolio(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book, timeout: Duration) throws -> Portfolio {
        self.linked.append(linked)
        rules.append(rule)
        return try next.get()
    }

    func proof(leg: String, address: String, currency: CurrencyCode, rule: String?) throws -> Proof {
        throw FetchError.unreachable
    }

    func verification(leg: String, address: String, currency: CurrencyCode, rule: String?) throws -> Verification {
        throw FetchError.unreachable
    }

    func explanation(of target: ExplainTarget, address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book) throws -> Explanation {
        throw FetchError.unreachable
    }

    func taxReport(_ request: TaxReportRequest) throws -> TaxReport {
        throw FetchError.unreachable
    }
}

/// A portfolio as the server would send it, from JSON, so the test uses the same decoding as the app.
func portfolio(address: EthereumAddress = hotAddress, toBlock: UInt64 = 1000, outgoing: [String] = [], realized: String? = "0", realizedMissing: Int = 0, estimatedRealized: Bool = false, linkedFailed: [String] = [], positions: [String] = [], otherTokens: [String] = [], unlisted: [String] = [], started: Bool = true) -> Portfolio {
    let realizedText = realized.map { "\"\($0)\"" } ?? "null"
    let json = """
    {
      "address": "\(address.lowercased)", "mode": "raw", "method": "average", "currency": "USD", "exchange": null,
      "coverage": { "fromBlock": 1, "toBlock": \(toBlock) }, "trackedTokens": 10,
      "latest": { "blockNum": 1000, "timestamp": "2026-11-04T00:00:00.000Z" },
      "progress": { "started": \(started), "behindBlocks": 0 },
      "gasUnknownTxs": [], "l1FeeUnknownTxs": [], "openingUnread": [], "unreadAssets": [], "outgoingTxs": [\(outgoing.map { "\"\($0)\"" }.joined(separator: ","))],
      "unlisted": [\(unlisted.map { "{ \"token\": \"\($0)\", \"transfers\": 1 }" }.joined(separator: ","))],
      "otherTokens": [\(otherTokens.joined(separator: ","))],
      "positions": [\(positions.joined(separator: ","))],
      "totals": {
        "valueMicros": null, "realizedMicros": \(realizedText), "unrealizedMicros": null, "gasMicros": null, "pnlMicros": null,
        "excluded": [], "unpricedGas": false,
        "coverage": {
          "value": { "known": 0, "missing": 0 }, "realized": { "known": 1, "missing": \(realizedMissing) },
          "unrealized": { "known": 0, "missing": 0 }, "pnl": { "known": 0, "missing": 0 }
        },
        "unresolvedMicros": "0", "estimatedMicros": "0", "estimated": { "value": false, "realized": \(estimatedRealized), "unrealized": false }, "noMarket": []
      },
      "pnlStatus": "complete", "points": [],
      "holdComparison": { "status": "unavailable", "unavailable": "nothing known put in", "walletMicros": null, "walletLeavesOut": false, "walletEstimated": false, "holdMicros": null, "differenceMicros": null, "putInMicros": "0", "unknownAmounts": 0, "estimated": false },
      "questions": [], "meter": { "open": 0, "answered": 0, "waiting": 0 }, "linkedReading": [], "linkedFailed": [\(linkedFailed.map { "\"\($0)\"" }.joined(separator: ","))], "withheld": [], "marketChecked": true
    }
    """
    return try! JSONDecoder().decode(Portfolio.self, from: Data(json.utf8))
}

func position(_ asset: String, decimals: Int, priceMicros: String) -> String {
    """
    { "asset": "\(asset)", "decimals": \(decimals), "note": null,
      "price": { "micros": "\(priceMicros)", "source": "market", "blockNum": 1 },
      "values": { "qty": "0", "unknownCostQty": "0", "costMicros": null, "averageCostMicros": null, "valueMicros": null, "realizedMicros": null, "unrealizedMicros": null, "estimatedCostMicros": "0", "estimatedRealizedMicros": "0" },
      "pnlMicros": null, "shortfallQty": "0", "legCount": 1, "reconciliation": null, "noMarket": false, "resolvable": false,
      "estimates": { "cost": false, "value": false, "realized": false, "unrealized": false } }
    """
}

@MainActor
struct Rig {
    let wallet: HotWallet
    let chain: FakeChain
    let signer: FakeSigner
    let stateStore: MemoryStateStore
    let portfolios: ScriptedPortfolios

    /// A wallet that exists already, with a cold wallet to sweep to unless told otherwise.
    init(_ snapshot: ChainSnapshot = HotWalletKitTests.snapshot(), withCold: Bool = true, presence: Bool = true, userPresence: (any UserPresence)? = nil, portfolio read: Result<Portfolio, FetchError> = .success(portfolio()), moneyDisplay: @escaping @MainActor () -> MoneyDisplay = { MoneyDisplay(main: .USD) }, now: @escaping @Sendable () -> Date = { Date() }, tickDelay: Duration = .seconds(15), receiptDelay: Duration = .seconds(1)) async {
        let chain = FakeChain(snapshot)
        let signer = FakeSigner(keys: [hotAddress], next: [nextAddress])
        let stateStore = MemoryStateStore()
        var state = DeviceWalletState()
        state.active = hotAddress
        try! stateStore.save(state)
        let settingsStore = MemorySettingsStore()
        var settings = WalletSettings()
        if withCold { settings.add(ColdWallet(address: coldAddress, name: "Ledger", confirmedOnDeviceAt: Date())) }
        settingsStore.save(settings)
        let portfolios = ScriptedPortfolios(read)
        self.chain = chain
        self.signer = signer
        self.stateStore = stateStore
        self.portfolios = portfolios
        wallet = HotWallet(signer: signer, settingsStore: settingsStore, stateStore: stateStore, presence: userPresence ?? FakePresence(allows: presence), portfolioSource: { portfolios }, moneyDisplay: moneyDisplay, makeChain: { _ in chain }, now: now, tickDelay: tickDelay, receiptDelay: receiptDelay)
    }
}

/// Says what it's told, and remembers what it was asked.
final class RecordingPresence: UserPresence, @unchecked Sendable {
    private(set) var reasons: [String] = []
    var refusal: (any Error)?

    func confirm(reason: String) throws {
        reasons.append(reason)
        if let refusal { throw refusal }
    }
}
