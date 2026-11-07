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
    /// The wallet has more history than the server can hold. Trying again won't change that.
    case tooBig(String)
    /// The server only answers people it invited, and this request had no invite it takes.
    case needsInvite(String)
    /// The server is holding this client back, and says how many seconds until there's room. It clears by itself.
    case rateLimited(String, retryAfter: Int)
    /// The server's price or update isn't the one a proof is about.
    case priceChanged(String)
    /// What this needs hasn't caught up yet, like a wallet in All Yours' numbers that an answer would otherwise leave out. It clears by itself.
    case notCaughtUp(String)
}

/// What to tell someone when a request failed. Anything that isn't one of these came from outside the server, so it's said the same as not reaching it.
public func failureMessage(for error: any Error) -> String {
    switch error as? FetchError {
    case .ampUnavailable(let message), .noAmpConfigured(let message), .rejected(let message), .tooBig(let message), .needsInvite(let message), .priceChanged(let message), .notCaughtUp(let message), .rateLimited(let message, _): message
    case .timedOut: Wording.serverTooSlow
    case .unreachable, nil: Wording.cantReachServer
    }
}

/// One way of reading one wallet: everything its numbers depend on, apart from which server is asked.
public struct ReadContext: Hashable, Sendable {
    public let address: String
    public let method: CostMethod
    public let currency: CurrencyCode
    /// What to read through, or nil for the server's default.
    public let rule: String?
    /// The user's other wallets, which transfers between carry their cost.
    public let linked: [String]
    public let book: Book

    public init(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book) {
        self.address = address
        self.method = method
        self.currency = currency
        self.rule = rule
        self.linked = linked
        self.book = book
    }
}

public protocol PortfolioSource: Sendable {
    /// `linked` is the user's other wallets, which transfers between carry their cost.
    func portfolio(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book, timeout: Duration) async throws -> Portfolio
    /// The same, from what the server last read, without waiting on a new read. It may be behind, so it's never live. Nil if the server hasn't read this wallet.
    func lastRead(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book) async throws -> Portfolio?
    func explanation(of target: ExplainTarget, address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], shown: [String]?, book: Book) async throws -> Explanation
    /// What each set of answers would do to the headline, in the same order.
    func previews(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], candidates: [Book]) async throws -> [BookPreview]
    func exportCSV(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], shown: [String]?, book: Book) async throws -> String
    func importCoinbase(csv: String) async throws -> ExchangeImport
    /// Empty when the server has only one, so there's nothing to choose.
    func rules() async throws -> [PricingRule]
    /// How far a wallet's first read has got. Nil when this source can't tell, like a server from before it could.
    func readProgress(address: String) async throws -> FirstReadProgress?
    func comparison(address: String, method: CostMethod, currency: CurrencyCode, linked: [String], book: Book) async throws -> RuleComparison
    func taxReport(_ request: TaxReportRequest) async throws -> TaxReport
    func proof(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Proof
    func verification(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Verification
    func priceProof(asset: String, price: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Proof
    func priceVerification(asset: String, revision: String?, address: String, currency: CurrencyCode, rule: String?) async throws -> Verification
    /// What a wallet lets others spend, checked onchain just now.
    func approvals(address: String) async throws -> WalletApprovals
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
    public func exportCSV(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], shown: [String]?, book: Book) async throws -> String { throw FetchError.unreachable }
    public func importCoinbase(csv: String) async throws -> ExchangeImport { throw FetchError.unreachable }
    /// Reads every wallet in it, so it gets as long as a first read.
    public func taxReport(_ request: TaxReportRequest) async throws -> TaxReport { throw FetchError.unreachable }
    public func proof(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Proof { throw FetchError.unreachable }
    public func verification(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Verification { throw FetchError.unreachable }
    public func priceProof(asset: String, price: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Proof { throw FetchError.unreachable }
    public func priceVerification(asset: String, revision: String?, address: String, currency: CurrencyCode, rule: String?) async throws -> Verification { throw FetchError.unreachable }
    public func approvals(address: String) async throws -> WalletApprovals { throw FetchError.unreachable }
    public func rules() async throws -> [PricingRule] { [] }
    public func readProgress(address: String) async throws -> FirstReadProgress? { nil }
    public func comparison(address: String, method: CostMethod, currency: CurrencyCode, linked: [String], book: Book) async throws -> RuleComparison { throw FetchError.rejected("There's only one pricing rule here.") }
    public func onrampCheckout(address: String, asset: String, cryptoAmount: String, fiat: Money?) async throws -> OnrampCheckout { throw FetchError.unreachable }
    public func currentRate(currency: CurrencyCode) async throws -> String? { throw FetchError.unreachable }
    public func onrampOrders(ref: String) async throws -> [OnrampOrder] { throw FetchError.unreachable }
}

/// The last reply for each way of reading a wallet, so the next can leave out what it says. They're the same lists the store holds, not copies.
private actor ReplyMemory {
    /// One wallet by a few settings, or a few wallets being looked between. The newest is last.
    private static let kept = 4
    private var replies: [(key: String, portfolio: Portfolio)] = []

    static func key(_ address: String, _ method: CostMethod, _ currency: CurrencyCode, _ rule: String?) -> String {
        "\(address)|\(method.rawValue)|\(currency.rawValue)|\(rule ?? "")"
    }

    func last(_ key: String) -> Portfolio? { replies.last { $0.key == key }?.portfolio }

    func remember(_ portfolio: Portfolio, _ key: String) {
        replies.removeAll { $0.key == key }
        // Nothing to send next time, so it's not worth holding on to.
        guard portfolio.marks != nil else { return }
        replies.append((key, portfolio))
        replies.removeFirst(max(0, replies.count - Self.kept))
    }
}

extension Portfolio {
    /// This reply with what it left out put back from what the server compared it to, or nil if that isn't there to put back.
    func restoring(from base: Portfolio?) -> Portfolio? {
        guard let kept else { return self }
        var whole = self
        whole.kept = nil
        if let count = kept.points {
            guard let base, count == base.marks?.points?.markedCount, count <= base.points.count else { return nil }
            whole.points = Array(base.points.prefix(count)) + points
        }
        if let count = kept.outgoingTxs {
            guard let base, count == base.marks?.outgoingTxs?.markedCount, count <= base.outgoingTxs.count else { return nil }
            whole.outgoingTxs = Array(base.outgoingTxs.prefix(count)) + outgoingTxs
        }
        return whole
    }
}

private extension String {
    /// How many entries a mark vouches for, which it starts with.
    var markedCount: Int? { split(separator: ":").first.flatMap { Int($0) } }
}

public struct PricetagClient: PortfolioSource {
    public let serverURL: URL
    /// What a shared server knows this person by. It only goes over HTTPS, so a server on this Mac, or any other plain address, never gets it.
    let invite: String?
    private let session: URLSession
    private let memory = ReplyMemory()

    /// A block every 2 s means the events are never quiet for this long, unless something's wrong.
    private static let eventsIdleTimeout: TimeInterval = 30

    public init(serverURL: URL, invite: String? = nil) {
        self.init(serverURL: serverURL, invite: invite, configuration: .ephemeral)
    }

    init(serverURL: URL, invite: String? = nil, configuration: URLSessionConfiguration) {
        self.serverURL = serverURL
        self.invite = serverURL.scheme == "https" ? invite.flatMap { $0.isEmpty ? nil : $0 } : nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: configuration)
    }

    public func headEvents() -> AsyncThrowingStream<Void, any Error>? {
        let request = authorized(URLRequest(url: serverURL.appending(path: "/api/events"), timeoutInterval: Self.eventsIdleTimeout))
        let session = session
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await session.bytes(for: request)
                    let answer = response as? HTTPURLResponse
                    if answer?.statusCode == 429 { throw FetchError.rateLimited("Too many requests.", retryAfter: Self.retryAfter(answer)) }
                    guard answer?.statusCode == 200 else { throw FetchError.unreachable }
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
        let key = ReplyMemory.key(address, method, currency, rule)
        let portfolio = try await whole(key: key) { since in
            try await post("/api/portfolio/\(address)", body: FoldBody(method: method, currency: currency, rule: rule, linked: linked, book: book, since: since), timeout: timeout)
        }
        guard let portfolio else { throw FetchError.rejected("The price service sent something this version can't read.") }
        return portfolio
    }

    public func lastRead(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book) async throws -> Portfolio? {
        let key = ReplyMemory.key(address, method, currency, rule)
        return try await whole(key: key) { since in
            // Past this, a real read is as quick, say when a currency's rates have to be read first.
            try await post("/api/portfolio/\(address)/last", body: FoldBody(method: method, currency: currency, rule: rule, linked: linked, book: book, since: since), timeout: .seconds(5))
        }
    }

    public func explanation(of target: ExplainTarget, address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], shown: [String]?, book: Book) async throws -> Explanation {
        try await decoded(post("/api/portfolio/\(address)/explain", query: target.queryItems, body: FoldBody(method: method, currency: currency, rule: rule, linked: linked, book: book, shown: shown), timeout: .seconds(30)))
    }

    public func proof(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Proof {
        try await get("/api/portfolio/\(address)/proof", query: legQuery(leg, currency, rule), timeout: .seconds(30))
    }

    /// A block's rows can take a while on a busy server, and the read is one query at a time.
    public func verification(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Verification {
        try await get("/api/portfolio/\(address)/verify", query: legQuery(leg, currency, rule), timeout: .seconds(120))
    }

    public func priceProof(asset: String, price: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Proof {
        try await get("/api/portfolio/\(address)/proof", query: proofQuery("asset", asset, currency, rule) + [URLQueryItem(name: "price", value: price)], timeout: .seconds(30))
    }

    public func priceVerification(asset: String, revision: String?, address: String, currency: CurrencyCode, rule: String?) async throws -> Verification {
        try await get("/api/portfolio/\(address)/verify", query: proofQuery("asset", asset, currency, rule) + [URLQueryItem(name: "revision", value: revision)], timeout: .seconds(120))
    }

    private func legQuery(_ leg: String, _ currency: CurrencyCode, _ rule: String?) -> [URLQueryItem] {
        proofQuery("leg", leg, currency, rule)
    }

    private func proofQuery(_ name: String, _ value: String, _ currency: CurrencyCode, _ rule: String?) -> [URLQueryItem] {
        var items = [URLQueryItem(name: name, value: value), URLQueryItem(name: "currency", value: currency.rawValue)]
        if let rule { items.append(URLQueryItem(name: "rule", value: rule)) }
        return items
    }

    /// The first read of a wallet's history can take a while, until the dataset has its own table of approvals.
    public func approvals(address: String) async throws -> WalletApprovals {
        try await get("/api/approvals/\(address)", query: [], timeout: .seconds(180))
    }

    public func taxReport(_ request: TaxReportRequest) async throws -> TaxReport {
        try await decoded(post("/api/tax-report/\(request.address)", body: request.body, timeout: .seconds(180)))
    }

    public func previews(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], candidates: [Book]) async throws -> [BookPreview] {
        let answer: PreviewAnswer = try await decoded(post("/api/portfolio/\(address)/preview", body: PreviewBody(method: method, currency: currency, rule: rule, linked: linked, candidates: candidates), timeout: .seconds(30)))
        return answer.previews
    }

    public func exportCSV(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], shown: [String]?, book: Book) async throws -> String {
        let data = try await post("/api/portfolio/\(address)/export", body: FoldBody(method: method, currency: currency, rule: rule, linked: linked, book: book, shown: shown), timeout: .seconds(30))
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

    public func readProgress(address: String) async throws -> FirstReadProgress? {
        try await get("/api/wallet/\(address)/progress", query: [], timeout: .seconds(8))
    }

    public func comparison(address: String, method: CostMethod, currency: CurrencyCode, linked: [String], book: Book) async throws -> RuleComparison {
        // It reads the wallet by both rules, and a first read can take a minute each.
        try await decoded(post("/api/portfolio/\(address)/compare", body: FoldBody(method: method, currency: currency, rule: nil, linked: linked, book: book), timeout: .seconds(180)))
    }

    public func onrampCheckout(address: String, asset: String, cryptoAmount: String, fiat: Money?) async throws -> OnrampCheckout {
        try await decoded(post("/api/onramp/checkout", body: CheckoutBody(address: address, asset: asset, cryptoAmount: cryptoAmount, fiat: fiat.flatMap { money in Format.plainMoney(money.micros).map { .init(amount: $0, currency: money.currency) } }), timeout: .seconds(30)))
    }

    public func currentRate(currency: CurrencyCode) async throws -> String? {
        let body: RateBody = try await get("/api/rate", query: [URLQueryItem(name: "currency", value: currency.rawValue)], timeout: .seconds(15))
        return body.rateMicros
    }

    public func onrampOrders(ref: String) async throws -> [OnrampOrder] {
        let body: OrdersBody = try await get("/api/onramp/orders/\(ref)", query: [], timeout: .seconds(30))
        return body.orders
    }

    /// A reply with its lists whole, whatever the server left out. Nil if it has nothing to say. A reply that leaves out what this doesn't have can't be used, so it asks again for all of it.
    private func whole(key: String, read: (LongLists<String>) async throws -> Data) async throws -> Portfolio? {
        // What was asked with, not whatever's newest by the time the answer gets here: it's what the server compared.
        let base = await memory.last(key)
        let data = try await read(base?.marks ?? LongLists())
        if data.isEmpty { return nil }
        let reply: Portfolio = try decoded(data)
        var portfolio = reply.restoring(from: base)
        if portfolio == nil {
            let again = try await read(LongLists())
            if again.isEmpty { return nil }
            portfolio = try (decoded(again) as Portfolio).restoring(from: nil)
        }
        guard let portfolio else { throw FetchError.rejected("The price service sent something this version can't read.") }
        await memory.remember(portfolio, key)
        return portfolio
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

    private func authorized(_ request: URLRequest) -> URLRequest {
        guard let invite else { return request }
        var request = request
        request.setValue("Bearer \(invite)", forHTTPHeaderField: "Authorization")
        return request
    }

    private func send(_ request: URLRequest) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: authorized(request))
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
        case 413: throw FetchError.tooBig(message)
        case 401: throw FetchError.needsInvite(message)
        case 429: throw FetchError.rateLimited(message, retryAfter: Self.retryAfter(response as? HTTPURLResponse))
        case 412: throw FetchError.priceChanged(message)
        case 409: throw FetchError.notCaughtUp(message)
        default: throw FetchError.rejected(message)
        }
    }

    /// In seconds, as this server sends it. Anything else waits a minute, which is as long as its shortest limit lasts.
    private static func retryAfter(_ response: HTTPURLResponse?) -> Int {
        response?.value(forHTTPHeaderField: "Retry-After").flatMap(Int.init).flatMap { $0 > 0 ? $0 : nil } ?? 60
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
        var since: LongLists<String>? = nil
        /// All Yours' wallets in the numbers on screen, which an answer can't leave out.
        var shown: [String]? = nil
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
}
