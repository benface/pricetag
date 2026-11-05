// The only network code in the apps. It only ever talks to our server, and never holds an Amp token.

import Foundation

public enum FetchError: Error, Equatable, Sendable {
    /// Nothing answered at the server's address.
    case unreachable
    /// Nothing came back in time, from a server that's gone or one still busy with a slow read.
    case timedOut
    /// The server answered, and it can't read from Amp right now.
    case ampUnavailable(String)
    /// The server has no Amp connection set up, so it only has the demo wallet.
    case noAmpConfigured(String)
    /// The server refused the request, or sent something this version can't read.
    case rejected(String)
}

public protocol PortfolioSource: Sendable {
    /// `linked` is the user's other wallets, which transfers between carry their cost.
    func portfolio(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book, timeout: Duration) async throws -> Portfolio
    /// The same, from what the server last read, without waiting on a new read. It may be behind, so it's never live. Nil if the server hasn't read this wallet.
    func lastRead(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book) async throws -> Portfolio?
    func explanation(of target: ExplainTarget, address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book) async throws -> Explanation
    /// What each set of answers would do to the headline, in the same order.
    func previews(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], candidates: [Book]) async throws -> [BookPreview]
    func exportCSV(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book) async throws -> String
    func importCoinbase(csv: String) async throws -> ExchangeImport
    /// Empty when the server has only one, so there's nothing to choose.
    func rules() async throws -> [PricingRule]
    func comparison(address: String, method: CostMethod, currency: CurrencyCode, linked: [String], book: Book) async throws -> RuleComparison
    func taxReport(_ request: TaxReportRequest) async throws -> TaxReport
    func proof(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Proof
    func verification(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Verification
    /// One element each time the server says there's a new block, until the connection goes. Nil when this source can't say.
    func headEvents() -> AsyncThrowingStream<Void, any Error>?
    /// A provider's page for buying `asset` for this address, and what to ask about its order by. It starts at `fiat`, what was typed, when the provider can start from that currency, and otherwise at `cryptoAmount`.
    func onrampCheckout(address: String, asset: String, cryptoAmount: String, fiat: Money?) async throws -> OnrampCheckout
    func onrampOrders(ref: String) async throws -> [OnrampOrder]
    /// What one USD buys right now, in millionths, without reading any wallet. Nil when there's no current rate.
    func currentRate(currency: CurrencyCode) async throws -> String?
}

/// Nothing here needs to be there for a source that only reads, like one in a test.
extension PortfolioSource {
    public func headEvents() -> AsyncThrowingStream<Void, any Error>? { nil }
    public func lastRead(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book) async throws -> Portfolio? { nil }
    public func previews(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], candidates: [Book]) async throws -> [BookPreview] { throw FetchError.unreachable }
    public func exportCSV(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book) async throws -> String { throw FetchError.unreachable }
    public func importCoinbase(csv: String) async throws -> ExchangeImport { throw FetchError.unreachable }
    public func taxReport(_ request: TaxReportRequest) async throws -> TaxReport { throw FetchError.unreachable }
    public func proof(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Proof { throw FetchError.unreachable }
    public func verification(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Verification { throw FetchError.unreachable }
    public func rules() async throws -> [PricingRule] { [] }
    public func comparison(address: String, method: CostMethod, currency: CurrencyCode, linked: [String], book: Book) async throws -> RuleComparison { throw FetchError.rejected("There's only one pricing rule here.") }
    public func onrampCheckout(address: String, asset: String, cryptoAmount: String, fiat: Money?) async throws -> OnrampCheckout { throw FetchError.unreachable }
    public func currentRate(currency: CurrencyCode) async throws -> String? { throw FetchError.unreachable }
    public func onrampOrders(ref: String) async throws -> [OnrampOrder] { throw FetchError.unreachable }
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

    public func portfolio(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book, timeout: Duration) async throws -> Portfolio {
        try await decoded(post("/api/portfolio/\(address)", body: FoldBody(method: method, currency: currency, rule: rule, linked: linked, book: book), timeout: timeout))
    }

    public func lastRead(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book) async throws -> Portfolio? {
        // Past this, a real read is as quick, say when a currency's rates have to be read first.
        let data = try await post("/api/portfolio/\(address)/last", body: FoldBody(method: method, currency: currency, rule: rule, linked: linked, book: book), timeout: .seconds(5))
        return data.isEmpty ? nil : try decoded(data) as Portfolio
    }

    public func explanation(of target: ExplainTarget, address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book) async throws -> Explanation {
        try await decoded(post("/api/portfolio/\(address)/explain", query: target.queryItems, body: FoldBody(method: method, currency: currency, rule: rule, linked: linked, book: book), timeout: .seconds(30)))
    }

    public func proof(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Proof {
        try await get("/api/portfolio/\(address)/proof", query: legQuery(leg, currency, rule), timeout: .seconds(30))
    }

    /// A block's rows can take a while on a busy server, and the read is one query at a time.
    public func verification(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Verification {
        try await get("/api/portfolio/\(address)/verify", query: legQuery(leg, currency, rule), timeout: .seconds(120))
    }

    private func legQuery(_ leg: String, _ currency: CurrencyCode, _ rule: String?) -> [URLQueryItem] {
        var items = [URLQueryItem(name: "leg", value: leg), URLQueryItem(name: "currency", value: currency.rawValue)]
        if let rule { items.append(URLQueryItem(name: "rule", value: rule)) }
        return items
    }

    /// Reads every wallet in it, so it gets as long as a first read.
    public func taxReport(_ request: TaxReportRequest) async throws -> TaxReport {
        try await decoded(post("/api/tax-report/\(request.address)", body: request.body, timeout: .seconds(180)))
    }

    public func previews(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], candidates: [Book]) async throws -> [BookPreview] {
        let answer: PreviewAnswer = try await decoded(post("/api/portfolio/\(address)/preview", body: PreviewBody(method: method, currency: currency, rule: rule, linked: linked, candidates: candidates), timeout: .seconds(30)))
        return answer.previews
    }

    public func exportCSV(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book) async throws -> String {
        let data = try await post("/api/portfolio/\(address)/export", body: FoldBody(method: method, currency: currency, rule: rule, linked: linked, book: book), timeout: .seconds(30))
        guard let text = String(data: data, encoding: .utf8) else { throw FetchError.rejected("The price service sent something this version can't read.") }
        return text
    }

    public func importCoinbase(csv: String) async throws -> ExchangeImport {
        try await decoded(post("/api/import/coinbase", body: ["csv": csv], timeout: .seconds(30)))
    }

    public func rules() async throws -> [PricingRule] {
        let body: RulesBody = try await get("/api/rules", query: [], timeout: .seconds(15))
        return body.rules
    }

    public func comparison(address: String, method: CostMethod, currency: CurrencyCode, linked: [String], book: Book) async throws -> RuleComparison {
        // It reads the wallet by both rules, and a first read can take a minute each.
        try await decoded(post("/api/portfolio/\(address)/compare", body: FoldBody(method: method, currency: currency, rule: nil, linked: linked, book: book), timeout: .seconds(180)))
    }

    public func onrampCheckout(address: String, asset: String, cryptoAmount: String, fiat: Money?) async throws -> OnrampCheckout {
        try await decoded(post("/api/onramp/checkout", body: CheckoutBody(address: address, asset: asset, cryptoAmount: cryptoAmount, fiat: fiat.map { .init(amount: Format.plainAmount($0.micros), currency: $0.currency) }), timeout: .seconds(30)))
    }

    public func currentRate(currency: CurrencyCode) async throws -> String? {
        let body: RateBody = try await get("/api/rate", query: [URLQueryItem(name: "currency", value: currency.rawValue)], timeout: .seconds(15))
        return body.rateMicros
    }

    public func onrampOrders(ref: String) async throws -> [OnrampOrder] {
        let body: OrdersBody = try await get("/api/onramp/orders/\(ref)", query: [], timeout: .seconds(30))
        return body.orders
    }

    private func decoded<Body: Decodable>(_ data: Data) throws -> Body {
        do {
            return try JSONDecoder().decode(Body.self, from: data)
        } catch {
            throw FetchError.rejected("The price service sent something this version can't read.")
        }
    }

    private func url(_ path: String, query: [URLQueryItem]) throws -> URL {
        var components = URLComponents(url: serverURL.appending(path: path), resolvingAgainstBaseURL: false)
        if !query.isEmpty { components?.queryItems = query }
        guard let url = components?.url else { throw FetchError.rejected("The price service's address isn't a valid URL.") }
        return url
    }

    private func get<Body: Decodable>(_ path: String, query: [URLQueryItem], timeout: Duration) async throws -> Body {
        var request = URLRequest(url: try url(path, query: query))
        request.timeoutInterval = Double(timeout.components.seconds)
        return try await decoded(send(request))
    }

    /// A post, because answers don't belong in a URL, where they'd end up in logs.
    private func post<Body: Encodable>(_ path: String, query: [URLQueryItem] = [], body: Body, timeout: Duration) async throws -> Data {
        var request = URLRequest(url: try url(path, query: query))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        request.timeoutInterval = Double(timeout.components.seconds)
        return try await send(request)
    }

    private func send(_ request: URLRequest) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch let error as URLError where error.code == .timedOut {
            throw FetchError.timedOut
        } catch {
            throw FetchError.unreachable
        }
        guard let status = (response as? HTTPURLResponse)?.statusCode else { throw FetchError.unreachable }
        if status == 200 || status == 204 { return data }
        let message = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error ?? "The price service answered with an error (\(status))."
        switch status {
        case 502: throw FetchError.ampUnavailable(message)
        case 503: throw FetchError.noAmpConfigured(message)
        default: throw FetchError.rejected(message)
        }
    }

    private struct CheckoutBody: Encodable {
        struct Fiat: Encodable {
            let amount: String
            let currency: CurrencyCode
        }

        let address: String
        let asset: String
        let cryptoAmount: String
        let fiat: Fiat?
    }

    private struct RateBody: Decodable {
        let rateMicros: String?
    }

    private struct OrdersBody: Decodable {
        let orders: [OnrampOrder]
    }

    private struct RulesBody: Decodable {
        let rules: [PricingRule]
    }

    private struct ErrorBody: Decodable {
        let error: String
    }

    private struct FoldBody: Encodable {
        let method: CostMethod
        let currency: CurrencyCode
        let rule: String?
        let linked: [String]
        let book: Book
    }

    private struct PreviewBody: Encodable {
        let method: CostMethod
        let currency: CurrencyCode
        let rule: String?
        let linked: [String]
        let candidates: [Book]
    }

    private struct PreviewAnswer: Decodable {
        let previews: [BookPreview]
    }

    private struct VerifyAnswer: Decodable {
        let verified: Bool
    }
}
