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
    func portfolio(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book, timeout: Duration) async throws -> Portfolio
    func explanation(of target: ExplainTarget, address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book) async throws -> Explanation
    /// What each set of answers would do to the headline, in the same order.
    func previews(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], candidates: [Book]) async throws -> [BookPreview]
    func exportCSV(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book) async throws -> String
    func importCoinbase(csv: String) async throws -> ExchangeImport
    func verifyLink(owner: String, address: String, signature: String) async throws -> Bool
    /// Empty when the server has only one, so there's nothing to choose.
    func rules() async throws -> [PricingRule]
    func comparison(address: String, method: CostMethod, currency: CurrencyCode, linked: [String], book: Book) async throws -> RuleComparison
    func taxReport(_ request: TaxReportRequest) async throws -> TaxReport
    func proof(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Proof
    func verification(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Verification
}

/// Nothing here needs to be there for a source that only reads, like one in a test.
extension PortfolioSource {
    public func previews(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], candidates: [Book]) async throws -> [BookPreview] { throw FetchError.unreachable }
    public func exportCSV(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book) async throws -> String { throw FetchError.unreachable }
    public func importCoinbase(csv: String) async throws -> ExchangeImport { throw FetchError.unreachable }
    public func verifyLink(owner: String, address: String, signature: String) async throws -> Bool { throw FetchError.unreachable }
    public func taxReport(_ request: TaxReportRequest) async throws -> TaxReport { throw FetchError.unreachable }
    public func proof(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Proof { throw FetchError.unreachable }
    public func verification(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Verification { throw FetchError.unreachable }
    public func rules() async throws -> [PricingRule] { [] }
    public func comparison(address: String, method: CostMethod, currency: CurrencyCode, linked: [String], book: Book) async throws -> RuleComparison { throw FetchError.rejected("There's only one pricing rule here.") }
}

public struct PricetagClient: PortfolioSource {
    public let serverURL: URL
    private let session: URLSession

    public init(serverURL: URL) {
        self.serverURL = serverURL
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: configuration)
    }

    public func portfolio(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book, timeout: Duration) async throws -> Portfolio {
        try await decoded(post("/api/portfolio/\(address)", body: FoldBody(method: method, currency: currency, rule: rule, linked: linked, book: book), timeout: timeout))
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
        try await get("/api/tax-report/\(request.address)", query: request.queryItems, timeout: .seconds(180))
    }

    public func previews(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], candidates: [Book]) async throws -> [BookPreview] {
        let answer: PreviewAnswer = try await decoded(post("/api/portfolio/\(address)/preview", body: PreviewBody(method: method, currency: currency, rule: rule, linked: linked, candidates: candidates), timeout: .seconds(30)))
        return answer.previews
    }

    public func exportCSV(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book) async throws -> String {
        let data = try await post("/api/portfolio/\(address)/export", body: FoldBody(method: method, currency: currency, rule: rule, linked: linked, book: book), timeout: .seconds(30))
        guard let text = String(data: data, encoding: .utf8) else { throw FetchError.rejected("The server sent something this version can't read.") }
        return text
    }

    public func importCoinbase(csv: String) async throws -> ExchangeImport {
        try await decoded(post("/api/import/coinbase", body: ["csv": csv], timeout: .seconds(30)))
    }

    public func verifyLink(owner: String, address: String, signature: String) async throws -> Bool {
        let answer: VerifyAnswer = try await decoded(post("/api/links/verify", body: ["owner": owner, "address": address, "signature": signature], timeout: .seconds(15)))
        return answer.verified
    }

    public func rules() async throws -> [PricingRule] {
        let body: RulesBody = try await get("/api/rules", query: [], timeout: .seconds(15))
        return body.rules
    }

    public func comparison(address: String, method: CostMethod, currency: CurrencyCode, linked: [String], book: Book) async throws -> RuleComparison {
        // It reads the wallet by both rules, and a first read can take a minute each.
        try await decoded(post("/api/portfolio/\(address)/compare", body: FoldBody(method: method, currency: currency, rule: nil, linked: linked, book: book), timeout: .seconds(180)))
    }

    private func decoded<Body: Decodable>(_ data: Data) throws -> Body {
        do {
            return try JSONDecoder().decode(Body.self, from: data)
        } catch {
            throw FetchError.rejected("The server sent something this version can't read.")
        }
    }

    private func url(_ path: String, query: [URLQueryItem]) throws -> URL {
        var components = URLComponents(url: serverURL.appending(path: path), resolvingAgainstBaseURL: false)
        if !query.isEmpty { components?.queryItems = query }
        guard let url = components?.url else { throw FetchError.rejected("That server address isn't a valid URL.") }
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
        } catch {
            throw FetchError.unreachable
        }
        guard let status = (response as? HTTPURLResponse)?.statusCode else { throw FetchError.unreachable }
        if status == 200 { return data }
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
