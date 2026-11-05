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

    /// It used to read a limit's body as a successful answer of nothing, which a site would take at its word.
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

    @Test func aRateLimitIsRecognized() {
        #expect(RPCChainClient.isRateLimit(code: -32007, message: nil))
        #expect(RPCChainClient.isRateLimit(code: nil, message: "25/second request limit reached"))
        #expect(RPCChainClient.isRateLimit(code: -32000, message: "Too Many Requests"))
        #expect(!RPCChainClient.isRateLimit(code: 3, message: "execution reverted"))
        #expect(!RPCChainClient.isRateLimit(code: -32000, message: "nonce too low"))
    }
}
