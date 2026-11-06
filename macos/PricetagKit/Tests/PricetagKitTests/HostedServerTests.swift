import Foundation
import Testing
@testable import PricetagKit

/// Answers every request with the rules list, after noting what it was sent.
final class RecordingProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var authorizations: [String?] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        Self.authorizations.append(request.value(forHTTPHeaderField: "Authorization"))
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"rules":[]}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

@Suite(.serialized) struct HostedServerTests {
    private func rules(from server: String, invite: String?) async throws -> String? {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RecordingProtocol.self]
        RecordingProtocol.authorizations = []
        _ = try await PricetagClient(serverURL: URL(string: server)!, invite: invite, configuration: configuration).rules()
        return try #require(RecordingProtocol.authorizations.first)
    }

    @Test func sendsTheInviteOnlyOverHTTPS() async throws {
        #expect(try await rules(from: "https://patina.example", invite: "an-invite") == "Bearer an-invite")
        #expect(try await rules(from: "http://127.0.0.1:8787", invite: "an-invite") == nil, "A plain address never gets it")
        #expect(try await rules(from: "https://patina.example", invite: "") == nil)
        #expect(try await rules(from: "https://patina.example", invite: nil) == nil)
    }

    @Test func readsTheBuildsServerAsAHostOverHTTPS() {
        #expect(PortfolioStore.hostedServerURL(host: "patina.example")?.absoluteString == "https://patina.example")
        #expect(PortfolioStore.hostedServerURL(host: "") == nil)
        #expect(PortfolioStore.hostedServerURL(host: nil) == nil)
        #expect(PortfolioStore.hostedServerURL(host: "evil.example/path?x") == nil, "Only a host, so the build can't name a path or a scheme")
    }

    @Test func staysOnThisMacUntilABuildNamesAServer() {
        #expect(PortfolioStore.defaultServerURL == PortfolioStore.localServerURL)
    }

    @MainActor @Test func neverTakesAnInviteToAnotherServer() throws {
        let defaults = try #require(UserDefaults(suiteName: "HostedServerTests-\(UUID())"))
        let patina = URL(string: "https://patina.example")!
        let other = URL(string: "https://other.example")!
        let store = PortfolioStore(defaults: defaults)
        store.setServerURL(patina)
        store.setInvite("patina-invite")
        store.setServerURL(other)
        #expect(store.invite == nil)
        #expect(try authorization(of: store) == nil, "The other server never sees it")
        store.setInvite("other-invite")
        store.setServerURL(patina)
        #expect(store.invite == "patina-invite")
        #expect(try authorization(of: store) == "Bearer patina-invite")
        // Restarted on the other server, with both saved.
        store.setServerURL(other)
        let restarted = PortfolioStore(defaults: defaults)
        #expect(restarted.invite == "other-invite")
        #expect(PortfolioStore.origin(of: URL(string: "https://Patina.example/api")!) == PortfolioStore.origin(of: patina))
        #expect(PortfolioStore.origin(of: URL(string: "https://patina.example:8443")!) != PortfolioStore.origin(of: patina))
        store.stop()
        restarted.stop()
    }

    /// What the store's own client would send, by the invite it was made with. `sendsTheInviteOnlyOverHTTPS` covers the header.
    @MainActor private func authorization(of store: PortfolioStore) throws -> String? {
        try #require(store.source as? PricetagClient).invite.map { "Bearer \($0)" }
    }

    @MainActor @Test func keepsTheInviteAcrossLaunches() throws {
        let defaults = try #require(UserDefaults(suiteName: "HostedServerTests-\(UUID())"))
        let store = PortfolioStore(defaults: defaults, makeSource: { _ in FixtureFree() })
        store.setInvite("  an-invite \n")
        #expect(store.invite == "an-invite")
        #expect(PortfolioStore(defaults: defaults, makeSource: { _ in FixtureFree() }).invite == "an-invite")
        store.setInvite("")
        #expect(PortfolioStore(defaults: defaults, makeSource: { _ in FixtureFree() }).invite == nil)
    }
}

/// A source that has nothing, for a store that's never read.
private struct FixtureFree: PortfolioSource {
    func portfolio(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book, timeout: Duration) async throws -> Portfolio { throw FetchError.unreachable }
    func explanation(of target: ExplainTarget, address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book) async throws -> Explanation { throw FetchError.unreachable }
}

/// Hands a request for an HTTPS address to the real server on this Mac, invite and all, because that address has no certificate to test with.
private final class ForwardingProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var target = ""

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        var forwarded = request
        forwarded.url = URL(string: Self.target + (request.url?.path() ?? ""))
        URLSession(configuration: .ephemeral).dataTask(with: forwarded) { [client] data, response, error in
            if let error { return client?.urlProtocol(self, didFailWithError: error) ?? () }
            client?.urlProtocol(self, didReceive: response!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data ?? Data())
            client?.urlProtocolDidFinishLoading(self)
        }.resume()
    }
}

/// Only an answer the server really gives counts here, so `macos/watch-only-test.sh` runs these against a real one in hosted mode.
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["PATINA_TEST_SERVER"] != nil)) struct RealHostedServerTests {
    private func client(invite: String?) -> PricetagClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ForwardingProtocol.self]
        ForwardingProtocol.target = ProcessInfo.processInfo.environment["PATINA_TEST_SERVER"] ?? ""
        return PricetagClient(serverURL: URL(string: "https://patina.example")!, invite: invite, configuration: configuration)
    }

    @Test func asksForAnInviteUntilItHasOneItTakes() async throws {
        await #expect { _ = try await client(invite: nil).rules() } throws: { if case .needsInvite = $0 as? FetchError { true } else { false } }
        await #expect { _ = try await client(invite: "not-an-invite").rules() } throws: { if case .needsInvite = $0 as? FetchError { true } else { false } }
        _ = try await client(invite: ProcessInfo.processInfo.environment["PATINA_TEST_INVITE"]).rules()
    }
}

/// A source that answers like a hosted server that takes no invite it's given.
private struct InvitedSource: PortfolioSource {
    func rules() async throws -> [PricingRule] { throw FetchError.needsInvite("This server needs an invite.") }
    func portfolio(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book, timeout: Duration) async throws -> Portfolio { throw FetchError.unreachable }
    func explanation(of target: ExplainTarget, address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book) async throws -> Explanation { throw FetchError.unreachable }
}

@MainActor @Suite struct InvitePromptTests {
    private func defaults() -> UserDefaults {
        let name = "invite-\(UUID().uuidString)"
        return UserDefaults(suiteName: name)!
    }

    @Test func aRefusalAsksAndAnInviteStopsAsking() async throws {
        let defaults = defaults()
        let store = PortfolioStore(defaults: defaults, makeSource: { _ in InvitedSource() })
        #expect(!store.needsInvite)
        await store.refreshRules()
        #expect(store.needsInvite)
        store.setInvite("an-invite")
        #expect(!store.needsInvite, "The next answer says whether it took")
        await store.refreshRules()
        #expect(store.needsInvite && store.invite == "an-invite", "One it doesn't take asks again, and keeps what was typed for the prompt to say so")
        store.stop()
    }

    @Test func anOutageIsNotAReasonToAsk() async throws {
        let store = PortfolioStore(defaults: defaults(), makeSource: { _ in FixtureFree() })
        await store.refreshRules()
        #expect(!store.needsInvite)
    }

    @Test func anOutageNeverLooksLikeAnEmptyWallet() throws {
        let server = URL(string: "https://patina.example")!
        let problem = try #require(FeedState.serverUnreachable.problem(serverURL: server, portfolio: nil))
        #expect(problem.message.contains("isn't answering"))
        #expect(!problem.message.contains("$0") && !problem.message.contains("pnpm"))
        let summary = FeedSummary(feed: .serverUnreachable, portfolio: nil, shows: .value)
        #expect(summary.text == "Offline" && summary.isWarning)
    }
}
