// The only network code in the apps. It only ever talks to our server, and never holds an Amp token.

import Foundation

public enum FetchError: Error, Equatable, Sendable {
    /// Nothing answered at the server's address.
    case unreachable
    /// The server answered, and it can't read from Amp right now.
    case ampUnavailable(String)
    /// The server has no Amp connection set up, so it only has the demo wallet.
    case noAmpConfigured(String)
    /// The server refused the request, or sent something this version can't read.
    case rejected(String)
}

public protocol PortfolioSource: Sendable {
    /// `linked` is the user's other wallets, which transfers between carry their cost.
    func portfolio(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], timeout: Duration) async throws -> Portfolio
    func explanation(of target: ExplainTarget, address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String]) async throws -> Explanation
    /// Empty when the server has only one, so there's nothing to choose.
    func rules() async throws -> [PricingRule]
    func comparison(address: String, method: CostMethod, currency: CurrencyCode, linked: [String]) async throws -> RuleComparison
    func taxReport(_ request: TaxReportRequest) async throws -> TaxReport
    func proof(leg: String, address: String, currency: CurrencyCode) async throws -> Proof
    func verification(leg: String, address: String, currency: CurrencyCode) async throws -> Verification
    /// One element each time the server says there's a new block, until the connection goes. Nil when this source can't say.
    func headEvents() -> AsyncThrowingStream<Void, any Error>?
}

extension PortfolioSource {
    public func headEvents() -> AsyncThrowingStream<Void, any Error>? { nil }
    public func rules() async throws -> [PricingRule] { [] }
    public func comparison(address: String, method: CostMethod, currency: CurrencyCode, linked: [String]) async throws -> RuleComparison { throw FetchError.rejected("There's only one pricing rule here.") }
}

public struct PricetagClient: PortfolioSource {
    public let serverURL: URL
    private let session: URLSession

    /// A block every 2 s means the events are never quiet for this long, unless something's wrong.
    private static let eventsIdleTimeout: TimeInterval = 30

    public init(serverURL: URL) {
        self.init(serverURL: serverURL, configuration: .ephemeral)
    }

    init(serverURL: URL, configuration: URLSessionConfiguration) {
        self.serverURL = serverURL
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: configuration)
    }

    public func headEvents() -> AsyncThrowingStream<Void, any Error>? {
        let request = URLRequest(url: serverURL.appending(path: "/api/events"), timeoutInterval: Self.eventsIdleTimeout)
        let session = session
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await session.bytes(for: request)
                    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw FetchError.unreachable }
                    for try await line in bytes.lines where line == "event: head" {
                        continuation.yield()
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public func portfolio(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], timeout: Duration) async throws -> Portfolio {
        try await get("/api/portfolio/\(address)", query: settings(method, currency, rule, linked), timeout: timeout)
    }

    public func explanation(of target: ExplainTarget, address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String]) async throws -> Explanation {
        try await get("/api/portfolio/\(address)/explain", query: settings(method, currency, rule, linked) + target.queryItems, timeout: .seconds(30))
    }

    public func proof(leg: String, address: String, currency: CurrencyCode) async throws -> Proof {
        try await get("/api/portfolio/\(address)/proof", query: legQuery(leg, currency), timeout: .seconds(30))
    }

    /// A block's rows can take a while on a busy server, and the read is one query at a time.
    public func verification(leg: String, address: String, currency: CurrencyCode) async throws -> Verification {
        try await get("/api/portfolio/\(address)/verify", query: legQuery(leg, currency), timeout: .seconds(120))
    }

    private func legQuery(_ leg: String, _ currency: CurrencyCode) -> [URLQueryItem] {
        [URLQueryItem(name: "leg", value: leg), URLQueryItem(name: "currency", value: currency.rawValue)]
    }

    /// Reads every wallet in it, so it gets as long as a first read.
    public func taxReport(_ request: TaxReportRequest) async throws -> TaxReport {
        try await get("/api/tax-report/\(request.address)", query: request.queryItems, timeout: .seconds(180))
    }

    public func rules() async throws -> [PricingRule] {
        let body: RulesBody = try await get("/api/rules", query: [], timeout: .seconds(15))
        return body.rules
    }

    public func comparison(address: String, method: CostMethod, currency: CurrencyCode, linked: [String]) async throws -> RuleComparison {
        // It reads the wallet by both rules, and a first read can take a minute each.
        try await get("/api/portfolio/\(address)/compare", query: settings(method, currency, nil, linked), timeout: .seconds(180))
    }

    private func settings(_ method: CostMethod, _ currency: CurrencyCode, _ rule: String?, _ linked: [String]) -> [URLQueryItem] {
        var items = [URLQueryItem(name: "method", value: method.rawValue), URLQueryItem(name: "currency", value: currency.rawValue)]
        if let rule { items.append(URLQueryItem(name: "rule", value: rule)) }
        if !linked.isEmpty { items.append(URLQueryItem(name: "linked", value: linked.joined(separator: ","))) }
        return items
    }

    private func get<Body: Decodable>(_ path: String, query: [URLQueryItem], timeout: Duration) async throws -> Body {
        var components = URLComponents(url: serverURL.appending(path: path), resolvingAgainstBaseURL: false)
        components?.queryItems = query
        guard let url = components?.url else { throw FetchError.rejected("That server address isn't a valid URL.") }
        var request = URLRequest(url: url)
        request.timeoutInterval = Double(timeout.components.seconds)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw FetchError.unreachable
        }
        guard let status = (response as? HTTPURLResponse)?.statusCode else { throw FetchError.unreachable }
        if status == 200 {
            do {
                return try JSONDecoder().decode(Body.self, from: data)
            } catch {
                throw FetchError.rejected("The server sent something this version can't read.")
            }
        }
        let message = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error ?? "The server answered with an error (\(status))."
        switch status {
        case 502: throw FetchError.ampUnavailable(message)
        case 503: throw FetchError.noAmpConfigured(message)
        default: throw FetchError.rejected(message)
        }
    }

    private struct RulesBody: Decodable {
        let rules: [PricingRule]
    }

    private struct ErrorBody: Decodable {
        let error: String
    }
}
