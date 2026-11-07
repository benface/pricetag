import Foundation
@testable import KeyVault
import Testing
@testable import HotWalletKit

/// Answers like a node, one scripted reply at a time, and remembers what it was asked.
private final class StubNode: URLProtocol, @unchecked Sendable {
    struct Reply {
        let status: Int
        let body: Data
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var answer: ([[String: Any]], Int) -> Reply = { _, _ in Reply(status: 500, body: Data()) }
    nonisolated(unsafe) private static var requests: [[[String: Any]]] = []

    static func script(_ answer: @escaping ([[String: Any]], Int) -> Reply) {
        lock.withLock {
            self.answer = answer
            requests = []
        }
    }

    static var asked: [[[String: Any]]] { lock.withLock { requests } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        var body = Data()
        if let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 65536)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                guard count > 0 else { break }
                body.append(buffer, count: count)
            }
            stream.close()
        }
        let parsed = try? JSONSerialization.jsonObject(with: body)
        let calls = parsed as? [[String: Any]] ?? (parsed as? [String: Any]).map { [$0] } ?? []
        let reply = Self.lock.withLock {
            Self.requests.append(calls)
            return Self.answer(calls, Self.requests.count)
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.body)
        client?.urlProtocolDidFinishLoading(self)
    }
}

private let wallet = EthereumAddress("0x1111111111111111111111111111111111111111")!
private var limit: [String: Any] { ["code": -32007, "message": "25/second request limit reached"] }

private func json(_ value: Any, status: Int = 200) -> StubNode.Reply {
    StubNode.Reply(status: status, body: try! JSONSerialization.data(withJSONObject: value))
}

/// What a node would say to any of this, good enough to read as a wallet with nothing in it.
private func result(of call: [String: Any]) -> [String: Any] {
    let answer: Any = switch call["method"] as? String {
    case "eth_getBlockByNumber": ["number": "0x64", "timestamp": "0x64", "baseFeePerGas": "0x5"] as [String: Any]
    case "eth_chainId": "0x2105"
    default: "0x0"
    }
    return ["jsonrpc": "2.0", "id": call["id"] ?? 0, "result": answer]
}

private func client(retries: [Duration] = [.zero, .zero, .zero], pacer: NodePacer? = nil) -> RPCChainClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubNode.self]
    return RPCChainClient(url: URL(string: "https://node.test")!, session: URLSession(configuration: configuration), pacer: pacer, retryDelays: retries)
}

/// The real transport for the broadcast and nothing else, since that's what's being tested.
private struct BroadcastsForReal: ChainClient {
    let fake: FakeChain
    let node: RPCChainClient

    func snapshot(of address: EthereumAddress) async throws -> ChainSnapshot { try await fake.snapshot(of: address) }
    func estimateGas(from: EthereumAddress, to: EthereumAddress, value: UInt128, data: [UInt8]) async throws -> UInt64 {
        try await fake.estimateGas(from: from, to: to, value: value, data: data)
    }
    func send(_ transaction: SignedTransaction) async throws { try await node.send(transaction) }
    func receipt(of hash: String) async throws -> Receipt? { try await fake.receipt(of: hash) }
    func read(_ method: String, _ parameters: JSONValue) async throws -> RPCAnswer { await fake.read(method, parameters) }
    func l1Fee(ofPayload payload: [UInt8]) async throws -> UInt128 { await fake.l1Fee(ofPayload: payload) }
}

/// The public node's own habits, as seen on Base: part of a batch refused inside an HTTP 200, or a 429 for the whole thing.
@Suite(.serialized) struct NodeTests {
    @Test func callsRefusedInsideA200AreAskedAgainAndOnlyThose() async throws {
        StubNode.script { calls, count in
            if count == 2 {
                // The first read is the block, and this is the batch. Half of it gets refused.
                return json(calls.enumerated().map { index, call in
                    index.isMultiple(of: 2) ? result(of: call) : ["jsonrpc": "2.0", "id": call["id"] ?? 0, "error": limit]
                })
            }
            return json(calls.map(result))
        }
        let snapshot = try await client().snapshot(of: wallet)
        #expect(snapshot.chainID == Base.chainID)
        let asked = StubNode.asked
        #expect(asked.count == 3)
        #expect(asked[2].count == asked[1].count / 2)
        #expect(Set(asked[2].compactMap { $0["id"] as? Int }) == Set(stride(from: 1, to: asked[1].count, by: 2)))
    }

    @Test func a429IsAskedAgain() async throws {
        StubNode.script { calls, count in
            count == 1 ? json(limit, status: 429) : json(calls.map(result))
        }
        _ = try await client().snapshot(of: wallet)
        #expect(StubNode.asked.count == 3)
    }

    @Test func aRefusalInABodyWithNoListIsAskedAgain() async throws {
        StubNode.script { calls, count in
            count == 1 ? json(limit) : json(calls.map(result))
        }
        _ = try await client().snapshot(of: wallet)
    }

    @Test func aNodeThatKeepsRefusingSaysSo() async {
        StubNode.script { calls, _ in
            json(calls.map { ["jsonrpc": "2.0", "id": $0["id"] ?? 0, "error": limit] })
        }
        await #expect(throws: ChainError.rateLimited) { _ = try await client().snapshot(of: wallet) }
        #expect(StubNode.asked.count == 4, "it gives up in the end")
    }

    @Test func aRealRefusalIsntAskedAgain() async {
        StubNode.script { calls, _ in
            json(calls.map { ["jsonrpc": "2.0", "id": $0["id"] ?? 0, "error": ["code": 3, "message": "execution reverted"]] })
        }
        await #expect(throws: ChainError.rejected("execution reverted")) {
            _ = try await client().estimateGas(from: wallet, to: wallet, value: 0, data: [])
        }
        #expect(StubNode.asked.count == 1)
    }

    @Test func nonsenseIsntAskedAgain() async {
        StubNode.script { _, _ in StubNode.Reply(status: 200, body: Data("<html>".utf8)) }
        await #expect(throws: ChainError.unreachable) { _ = try await client().snapshot(of: wallet) }
        #expect(StubNode.asked.count == 1)
    }

    /// The node didn't look at it, and sending the same signed bytes again is the same transaction anyway.
    @Test func aRefusedSendGoesAgain() async throws {
        StubNode.script { calls, count in
            count == 1 ? json(limit, status: 429) : json(calls.map(result))
        }
        try await client().send(SignedTransaction(raw: [1, 2, 3]))
        #expect(StubNode.asked.count == 2)
        #expect(StubNode.asked[0][0]["params"] as? [String] == StubNode.asked[1][0]["params"] as? [String])
    }

    /// The node answered, but not about this transaction, so it may well have taken it.
    @Test func aBroadcastWithNoAnswerForItIsUncertain() async {
        let answers: [Any] = [[Any](), [["jsonrpc": "2.0", "id": 99, "result": "0xabc"]]]
        for answer in answers {
            StubNode.script { _, _ in json(answer) }
            await #expect(throws: ChainError.unreachable) { try await client().send(SignedTransaction(raw: [1, 2, 3])) }
            #expect(StubNode.asked.count == 1, "not sent again")
        }
        StubNode.script { _, _ in StubNode.Reply(status: 200, body: Data("<html>".utf8)) }
        await #expect(throws: ChainError.unreachable) { try await client().send(SignedTransaction(raw: [1, 2, 3])) }
    }

    /// A refusal is only about the attempt it answered. The next one may have been taken, so its silence can't count as another refusal.
    @Test func noAnswerAfterARefusalIsStillUncertain() async {
        let refusals: [([[String: Any]]) -> StubNode.Reply] = [
            { _ in json(limit, status: 429) },
            { _ in json(limit) },
            { calls in json(calls.map { ["jsonrpc": "2.0", "id": $0["id"] ?? 0, "error": limit] }) },
        ]
        let silences: [StubNode.Reply] = [
            json([Any]()),
            json([["jsonrpc": "2.0", "id": 99, "result": "0xabc"]]),
            StubNode.Reply(status: 200, body: Data("<html>".utf8)),
        ]
        for refusal in refusals {
            for silence in silences {
                StubNode.script { calls, count in count == 1 ? refusal(calls) : silence }
                await #expect(throws: ChainError.unreachable) { try await client().send(SignedTransaction(raw: [1, 2, 3])) }
                #expect(StubNode.asked.count == 2)
            }
        }
    }

    @Test func aReadThatGoesMissingAfterARefusalIsntCalledARefusal() async {
        StubNode.script { calls, count in
            count == 1 ? json(calls.map { ["jsonrpc": "2.0", "id": $0["id"] ?? 0, "error": limit] }) : json([Any]())
        }
        await #expect(throws: ChainError.unreadable) {
            _ = try await client().estimateGas(from: wallet, to: wallet, value: 0, data: [])
        }
    }

    /// The whole way through: one signature, two broadcasts, and the money may have gone, so it mustn't say it didn't.
    @MainActor @Test func aWalletKeepsWaitingOnASendThatWentMissingAfterARefusal() async throws {
        let (hotWallet, bridge, signer) = try await sitePath { _, count in count == 1 ? json(limit, status: 429) : json([Any]()) }
        let record = try #require(hotWallet.records.first)
        #expect(StubNode.asked.count == 2)
        #expect(await signer.signed.count == 1)
        #expect(record.status == .pending)
        #expect(bridge.failure == nil)
    }

    /// Every attempt refused means the node never looked at it, so this one really is certain.
    @MainActor @Test func aWalletDropsASendThatWasRefusedEveryTime() async throws {
        let (hotWallet, bridge, _) = try await sitePath { _, _ in json(limit, status: 429) }
        #expect(hotWallet.records.first?.status == .dropped)
        #expect(bridge.failure?.reason == HotWalletWording.networkBusy)
    }

    @MainActor private func sitePath(_ answer: @escaping ([[String: Any]], Int) -> StubNode.Reply) async throws -> (HotWallet, SiteBridge, FakeSigner) {
        StubNode.script(answer)
        let chain = BroadcastsForReal(fake: FakeChain(snapshot()), node: client())
        let signer = FakeSigner(keys: [hotAddress])
        let stateStore = MemoryStateStore()
        var state = DeviceWalletState()
        state.active = hotAddress
        state.connectedSites = ["https://a.example.com"]
        try stateStore.save(state)
        let portfolios = ScriptedPortfolios(.failure(.unreachable))
        let hotWallet = HotWallet(signer: signer, settingsStore: MemorySettingsStore(), stateStore: stateStore, presence: FakePresence(allows: true), portfolioSource: { portfolios }, makeChain: { _ in chain }, readRetryDelay: .zero)
        let bridge = SiteBridge(wallet: hotWallet)
        let parameters: JSONValue = .array([.object(["from": .string(hotAddress.lowercased), "to": .string(coldAddress.lowercased), "value": .string("0x10")])])
        let task = bridge.begin(SiteRequest(connection: UUID(), id: "1", origin: "https://a.example.com", method: "eth_sendTransaction", parameters: parameters))
        for _ in 0..<5000 where bridge.current == nil { try await Task.sleep(for: .milliseconds(1)) }
        await bridge.approve(try #require(bridge.current).id)
        _ = await task.value
        return (hotWallet, bridge, signer)
    }

    @Test func aSiteReadIsAskedAgainAndKeepsTheNodesOwnAnswers() async throws {
        StubNode.script { _, count in
            switch count {
            case 1: json(limit, status: 429)
            case 2: json(limit)
            case 3: json(["jsonrpc": "2.0", "id": 1, "error": limit])
            default: json(["jsonrpc": "2.0", "id": 1, "result": "0xabc"])
            }
        }
        #expect(try await client().read("eth_call", .array([])) == .success(.string("0xabc")))

        StubNode.script { _, _ in json(["jsonrpc": "2.0", "id": 1, "error": ["code": 3, "message": "execution reverted", "data": "0x08c379a0"]]) }
        #expect(try await client().read("eth_call", .array([])) == .failure(SiteError(code: 3, message: "execution reverted", data: .string("0x08c379a0"))))
        #expect(StubNode.asked.count == 1)
    }

    /// A limit's body isn't a successful answer of nothing, which a site would take at its word.
    @Test func aSiteReadThatKeepsGettingRefusedSaysSo() async {
        StubNode.script { _, _ in json(limit, status: 429) }
        await #expect(throws: ChainError.rateLimited) { _ = try await client().read("eth_call", .array([])) }
        StubNode.script { _, _ in json(["jsonrpc": "2.0", "id": 1]) }
        await #expect(throws: ChainError.unreachable) { _ = try await client().read("eth_call", .array([])) }
    }

    @Test func thePacerSpacesCallsOut() async throws {
        let pacer = NodePacer(callsPerSecond: 100, burst: 5)
        let clock = ContinuousClock()
        let burst = try await clock.measure { try await pacer.wait(forCalls: 5) }
        #expect(burst < .milliseconds(40), "what's saved up goes straight away")
        let rest = try await clock.measure { try await pacer.wait(forCalls: 20) }
        #expect(rest >= .milliseconds(150), "20 more at 100 a second take about a fifth of a second")
    }

    /// The node counts each call in a batch, so one big batch can use up a whole second's worth at once.
    @Test func aBatchGoesInPiecesToAPacedNode() async throws {
        StubNode.script { calls, _ in json(calls.map(result)) }
        _ = try await client(pacer: NodePacer(callsPerSecond: 1000, burst: 5)).snapshot(of: wallet)
        let asked = StubNode.asked
        #expect(asked.count > 3)
        #expect(asked.allSatisfy { $0.count <= 5 })
    }

    /// A node that says this one thing and is otherwise fine. `method` is the call, or `balance` and `l1Fee` for those reads.
    private func lyingNode(_ what: String, _ value: Any) {
        StubNode.script { calls, _ in
            json(calls.map { call in
                var answer = result(of: call)
                let to = ((call["params"] as? [Any])?.first as? [String: Any])?["to"] as? String
                let isL1Fee = to == Base.gasPriceOracle.lowercased
                let isBalance = call["method"] as? String == "eth_getBalance" || (call["method"] as? String == "eth_call" && Base.tokens.contains { $0.contract?.lowercased == to })
                if call["method"] as? String == what || (what == "balance" && isBalance) || (what == "l1Fee" && isL1Fee) { answer["result"] = value }
                return answer
            })
        }
    }

    private func isUnreadable(_ body: () async throws -> Void) async -> Bool {
        do {
            try await body()
            return false
        } catch {
            return error as? ChainError == .unreadable
        }
    }

    @Test func absurdNumbersFromANodeAreUnreadableRatherThanACrash() async throws {
        let tooBigForAUInt64 = "0x10000000000000000"
        let mostAUInt128Holds = "0x" + String(repeating: "f", count: 32)
        let cases: [(String, Any)] = [
            ("eth_chainId", tooBigForAUInt64),
            ("eth_chainId", "0xffffffffffffffff"),
            ("eth_getTransactionCount", tooBigForAUInt64),
            ("eth_getTransactionCount", "0xffffffffffffffff"),
            ("eth_maxPriorityFeePerGas", mostAUInt128Holds),
            ("eth_getBlockByNumber", ["number": "0x64", "timestamp": "0x64", "baseFeePerGas": mostAUInt128Holds] as [String: Any]),
            // Doubling this one is what would overflow.
            ("eth_getBlockByNumber", ["number": "0x64", "timestamp": "0x64", "baseFeePerGas": "0x80000000000000000000000000000000"] as [String: Any]),
            ("eth_getBlockByNumber", ["number": tooBigForAUInt64, "timestamp": "0x64", "baseFeePerGas": "0x5"] as [String: Any]),
            ("eth_getBlockByNumber", ["number": "0xffffffffffffffff", "timestamp": "0x64", "baseFeePerGas": "0x5"] as [String: Any]),
            ("balance", mostAUInt128Holds),
            ("l1Fee", mostAUInt128Holds),
        ]
        for (what, value) in cases {
            lyingNode(what, value)
            let unreadable = await isUnreadable { _ = try await client().snapshot(of: wallet) }
            #expect(unreadable, "\(what): \(value)")
        }

        for gas in [tooBigForAUInt64, "0xffffffffffffffff", mostAUInt128Holds] {
            lyingNode("eth_estimateGas", gas)
            let unreadable = await isUnreadable { _ = try await client().estimateGas(from: wallet, to: wallet, value: 0, data: []) }
            #expect(unreadable, "gas \(gas)")
        }

        lyingNode("l1Fee", mostAUInt128Holds)
        let unreadableFee = await isUnreadable { _ = try await client().l1Fee(ofPayload: [1]) }
        #expect(unreadableFee)

        for block in [tooBigForAUInt64, "0xffffffffffffffff"] {
            lyingNode("eth_getTransactionReceipt", ["status": "0x1", "blockNumber": block])
            let unreadable = await isUnreadable { _ = try await client().receipt(of: "0x1") }
            #expect(unreadable, "block \(block)")
        }
    }

    @Test func bigButRealNumbersStillRead() async throws {
        // More than DEGEN's whole supply, which is the most of anything on the allowlist.
        let balance: UInt128 = 100_000_000_000 * 1_000_000_000_000_000_000
        lyingNode("balance", "0x" + String(balance, radix: 16))
        let snapshot = try await client().snapshot(of: wallet)
        #expect(snapshot.balances[Base.eth] == balance)
    }

    /// The worst a node can get past the checks above, through everything that does math with it.
    @Test func theLargestReadableNumbersDontOverflowFurtherOn() {
        let highest = RPCChainClient.highestReadableAmount
        let fees = FeeQuote(maxFeePerGas: 2 * RPCChainClient.highestReadableFeePerGas + RPCChainClient.highestReadableFeePerGas, maxPriorityFeePerGas: RPCChainClient.highestReadableFeePerGas, l1FeeWei: highest)
        #expect(!fees.isPlausible)
        let holdings = Base.tokens.map { Holding(token: $0, balance: highest, priceUsdMicros: 100_000 * Money.dollar) }
        _ = SweepPlanner.automatic(holdings: holdings, capUsdMicros: 0, fees: fees, destination: wallet, pendingGainUsdMicros: 0)
        _ = SweepPlanner.automatic(holdings: holdings, capUsdMicros: 0, fees: FeeQuote(maxFeePerGas: 1, maxPriorityFeePerGas: 1, l1FeeWei: 0), destination: wallet, pendingGainUsdMicros: UInt128(1) << 110)
        _ = SweepPlanner.everything(holdings: holdings, fees: fees, destination: wallet)
        _ = fees.costWei(gas: UInt128(FeeQuote.gasLimit(estimate: UInt64(RPCChainClient.highestReadableCount), isPlainSend: false)))
    }

    @Test func gasRoomStopsAtWhatAUInt64Holds() {
        #expect(FeeQuote.gasLimit(estimate: .max, isPlainSend: false) == .max)
        #expect(FeeQuote.gasLimit(estimate: 21000, isPlainSend: true) == 21000)
        #expect(FeeQuote.gasLimit(estimate: 21000, isPlainSend: false) == 26250)
        #expect(FeeQuote.gasLimit(estimate: 40000, isPlainSend: true) == 50000)
    }

    @Test func anAbsurdL1FeeIsNotPlausible() {
        #expect(cheapFees.isPlausible)
        #expect(!FeeQuote(maxFeePerGas: 1, maxPriorityFeePerGas: 1, l1FeeWei: FeeQuote.highestPlausibleL1FeeWei + 1).isPlausible)
        #expect(FeeQuote(maxFeePerGas: 1, maxPriorityFeePerGas: 1, l1FeeWei: FeeQuote.highestPlausibleL1FeeWei).isPlausible)
    }

    @Test func aRateLimitIsRecognized() {
        #expect(RPCChainClient.isRateLimit(code: -32007, message: nil))
        #expect(RPCChainClient.isRateLimit(code: nil, message: "25/second request limit reached"))
        #expect(RPCChainClient.isRateLimit(code: -32000, message: "Too Many Requests"))
        #expect(!RPCChainClient.isRateLimit(code: 3, message: "execution reverted"))
        #expect(!RPCChainClient.isRateLimit(code: -32000, message: "nonce too low"))
    }
}
