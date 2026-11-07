import Foundation
import Testing
@testable import PricetagKit

/// Answers with the next reply it's been given, after noting what it was sent.
final class ScriptedProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var replies: [Data] = []
    nonisolated(unsafe) static var sent: [[String: Any]] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        // A session hands a body over as a stream.
        var body = Data()
        if let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 65_536)
            while case let count = stream.read(&buffer, maxLength: buffer.count), count > 0 { body.append(contentsOf: buffer[0..<count]) }
            stream.close()
        }
        Self.sent.append((try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:])
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.replies.removeFirst())
        client?.urlProtocolDidFinishLoading(self)
    }
}

@Suite(.serialized) struct LongListsTests {
    private func client() -> PricetagClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ScriptedProtocol.self]
        ScriptedProtocol.replies = []
        ScriptedProtocol.sent = []
        return PricetagClient(serverURL: URL(string: "http://127.0.0.1:1")!, configuration: configuration)
    }

    private func read(_ client: PricetagClient, method: CostMethod = .average) async throws -> Portfolio {
        try await client.portfolio(ReadContext(address: "0xa", method: method, currency: .USD, rule: nil, linked: [], book: Book()), timeout: .seconds(5))
    }

    private func point(_ n: Int) throws -> [String: Any] {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(demoPortfolio().points.first!)) as! [String: Any]
        object["blockNum"] = n
        return object
    }

    private func reply(points: Range<Int>, txs: Range<Int>, marks: [String: String]? = nil, kept: [String: Int]? = nil) throws -> Data {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(demoPortfolio())) as! [String: Any]
        object["points"] = try points.map(point)
        object["outgoingTxs"] = txs.map { "0x\($0)" }
        object["marks"] = marks
        object["kept"] = kept
        return try JSONSerialization.data(withJSONObject: object)
    }

    private func expected(points: Range<Int>, txs: Range<Int>, marks: [String: String]?) throws -> Portfolio {
        try JSONDecoder().decode(Portfolio.self, from: reply(points: points, txs: txs, marks: marks))
    }

    @Test func putsBackWhatTheServerLeftOutSoItsTheSameAsAWholeReply() async throws {
        let client = client()
        ScriptedProtocol.replies = try [
            reply(points: 0..<10, txs: 0..<5, marks: ["points": "8:p1", "outgoingTxs": "3:t1"]),
            reply(points: 8..<12, txs: 3..<6, marks: ["points": "10:p2", "outgoingTxs": "4:t2"], kept: ["points": 8, "outgoingTxs": 3]),
        ]
        _ = try await read(client)
        let second = try await read(client)
        #expect(second == (try expected(points: 0..<12, txs: 0..<6, marks: ["points": "10:p2", "outgoingTxs": "4:t2"])))
        #expect(second.kept == nil)
        #expect(ScriptedProtocol.sent[0]["since"] as? [String: String] == [:], "It asks from the start")
        #expect(ScriptedProtocol.sent[1]["since"] as? [String: String] == ["points": "8:p1", "outgoingTxs": "3:t1"])
    }

    @Test func goesByTheNewestReplyEachTime() async throws {
        let client = client()
        ScriptedProtocol.replies = try [
            reply(points: 0..<10, txs: 0..<5, marks: ["points": "8:p1"]),
            reply(points: 8..<12, txs: 0..<5, marks: ["points": "10:p2"], kept: ["points": 8]),
            reply(points: 10..<13, txs: 0..<6, marks: ["points": "11:p3"], kept: ["points": 10]),
        ]
        _ = try await read(client)
        _ = try await read(client)
        let third = try await read(client)
        #expect(third == (try expected(points: 0..<13, txs: 0..<6, marks: ["points": "11:p3"])))
        #expect(ScriptedProtocol.sent[2]["since"] as? [String: String] == ["points": "10:p2"])
    }

    @Test func aWholeReplyReplacesWhatItHad() async throws {
        let client = client()
        ScriptedProtocol.replies = try [
            reply(points: 0..<10, txs: 0..<5, marks: ["points": "8:p1"]),
            reply(points: 100..<105, txs: 0..<2, marks: ["points": "3:p2"]),
        ]
        _ = try await read(client)
        let second = try await read(client)
        #expect(second == (try expected(points: 100..<105, txs: 0..<2, marks: ["points": "3:p2"])))
    }

    @Test func aShortWalletSendsNothingBack() async throws {
        let client = client()
        ScriptedProtocol.replies = try [reply(points: 0..<3, txs: 0..<1), reply(points: 0..<4, txs: 0..<1)]
        _ = try await read(client)
        let second = try await read(client)
        #expect(second == (try expected(points: 0..<4, txs: 0..<1, marks: nil)))
        #expect(ScriptedProtocol.sent[1]["since"] as? [String: String] == [:])
    }

    @Test func asksForAllOfItWhenItCantPutItBack() async throws {
        let client = client()
        ScriptedProtocol.replies = try [
            reply(points: 0..<10, txs: 0..<5, marks: ["points": "8:p1"]),
            // Says it kept more than this sent it.
            reply(points: 9..<11, txs: 0..<5, marks: ["points": "9:p2"], kept: ["points": 9]),
            reply(points: 0..<11, txs: 0..<5, marks: ["points": "9:p3"]),
        ]
        _ = try await read(client)
        let second = try await read(client)
        #expect(second == (try expected(points: 0..<11, txs: 0..<5, marks: ["points": "9:p3"])))
        #expect(ScriptedProtocol.sent[2]["since"] as? [String: String] == [:])
    }

    @Test func aReadBySomeOtherMethodDoesntGoByThisOne() async throws {
        let client = client()
        ScriptedProtocol.replies = try [reply(points: 0..<10, txs: 0..<5, marks: ["points": "8:p1"]), reply(points: 0..<10, txs: 0..<5, marks: ["points": "8:p9"])]
        _ = try await read(client, method: .average)
        _ = try await read(client, method: .fifo)
        #expect(ScriptedProtocol.sent[1]["since"] as? [String: String] == [:])
    }

    @Test func theLastReadGoesTheSameWay() async throws {
        let client = client()
        ScriptedProtocol.replies = try [
            reply(points: 0..<10, txs: 0..<5, marks: ["points": "8:p1"]),
            reply(points: 8..<11, txs: 0..<5, marks: ["points": "9:p2"], kept: ["points": 8]),
            Data(),
        ]
        _ = try await read(client)
        let last = try await client.lastRead(ReadContext(address: "0xa", method: .average, currency: .USD, rule: nil, linked: [], book: Book()))
        #expect(last == (try expected(points: 0..<11, txs: 0..<5, marks: ["points": "9:p2"])))
        #expect(try await client.lastRead(ReadContext(address: "0xa", method: .average, currency: .USD, rule: nil, linked: [], book: Book())) == nil, "The server hasn't read it")
    }
}
