// The live feed: polls the server, remembers the wallet, and knows whether what it holds is still true.

import Foundation
import Observation

public enum FeedState: Equatable, Sendable {
    case noWallet
    /// Waiting on the first answer for this wallet, which can take a minute.
    case reading
    case live
    /// The server and Amp both answer, but Amp's newest block is old.
    case behind(seconds: Int)
    /// The chain is current, but the dataset hasn't processed up to it yet.
    case catchingUp
    case serverUnreachable
    case ampUnavailable(String)
    case noAmpConfigured(String)
    case rejected(String)

    /// Only this state may show a number as current.
    public var isLive: Bool { self == .live }

    /// The last read failed or is old, so whatever's on screen has stopped moving.
    public var isStale: Bool {
        switch self {
        case .noWallet, .reading, .live, .catchingUp: false
        case .behind, .serverUnreachable, .ampUnavailable, .noAmpConfigured, .rejected: true
        }
    }
}

/// One number's explanation, in full context, because the same number means something else on another wallet, method or server.
public struct ExplanationRequest: Hashable, Sendable {
    public let target: ExplainTarget
    public let address: String
    public let method: CostMethod
    public let currency: CurrencyCode
    public let rule: String?
    public let linked: [String]
    public let serverURL: URL
    public let book: Book
}

@MainActor
@Observable
public final class PortfolioStore {
    public static let defaultServerURL = URL(string: "http://127.0.0.1:8787")!
    /// Past this, the newest block is too old to call live.
    static let behindAfterSeconds = 120

    /// What the store holds, which may not be current: read `feed` before calling it live. While a new method's, currency's
    /// or rule's numbers are on their way, the feed is `.reading` and this still holds the old ones, so the screen doesn't jump.
    public private(set) var portfolio: Portfolio?
    public private(set) var feed: FeedState
    public private(set) var updatedAt: Date?
    public private(set) var address: String?
    public private(set) var method: CostMethod
    public private(set) var currency: CurrencyCode
    public private(set) var serverURL: URL
    /// What the user has said about where things came from. It stays on this device.
    private var answers: Book
    /// What each answer replaced, newest last, so Undo is always there. Accounts aren't in here, so it can't bring back one that's gone.
    public private(set) var undoStack: [Book] = []
    /// The server's pricing rules. Empty when it has only one, so there's nothing to choose.
    public private(set) var rules: [PricingRule] = []
    /// What to ask the server for, or nil for its default.
    public private(set) var selectedRule: String?
    /// The user's own wallets. Transfers between them carry their cost, and aren't new purchases.
    public private(set) var linkedWallets: [String] = []

    @ObservationIgnored private var source: any PortfolioSource
    @ObservationIgnored private let makeSource: @Sendable (URL) -> any PortfolioSource
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let reachableDelay: Duration
    @ObservationIgnored private let unreachableDelay: Duration
    @ObservationIgnored private var pollTask: Task<Void, Never>?

    public init(
        defaults: UserDefaults = .standard,
        makeSource: @escaping @Sendable (URL) -> any PortfolioSource = { PricetagClient(serverURL: $0) },
        now: @escaping @Sendable () -> Date = { Date() },
        reachableDelay: Duration = .seconds(2),
        unreachableDelay: Duration = .seconds(5)
    ) {
        self.defaults = defaults
        self.makeSource = makeSource
        self.now = now
        self.reachableDelay = reachableDelay
        self.unreachableDelay = unreachableDelay
        let address = defaults.string(forKey: Keys.wallet)
        let serverURL = defaults.string(forKey: Keys.server).flatMap(URL.init(string:)) ?? Self.defaultServerURL
        self.address = address
        self.method = defaults.string(forKey: Keys.method).flatMap(CostMethod.init(rawValue:)) ?? .average
        self.currency = defaults.string(forKey: Keys.currency).flatMap(CurrencyCode.init(rawValue:)) ?? .USD
        self.serverURL = serverURL
        self.answers = defaults.data(forKey: Keys.book).flatMap { try? JSONDecoder().decode(Book.self, from: $0) } ?? Book()
        self.selectedRule = defaults.string(forKey: Keys.rule)
        self.feed = address == nil ? .noWallet : .reading
        self.source = makeSource(serverURL)
    }

    /// Starts polling, or starts over, say after a change or when asked to refresh.
    public func start() {
        pollTask?.cancel()
        Task { await refreshRules() }
        guard address != nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let delay = await self?.poll() else { return }
                try? await Task.sleep(for: delay)
            }
        }
    }

    public func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    /// `address` is 0x… or `WalletAddress.demo`, or nil to forget the wallet.
    public func setWallet(_ address: String?) {
        let next = address?.lowercased()
        guard next != self.address else { return }
        self.address = next
        defaults.set(next, forKey: Keys.wallet)
        portfolio = nil
        updatedAt = nil
        feed = next == nil ? .noWallet : .reading
        start()
    }

    public func setMethod(_ method: CostMethod) {
        guard method != self.method else { return }
        self.method = method
        defaults.set(method.rawValue, forKey: Keys.method)
        if address != nil { feed = .reading }
        start()
    }

    public func setLinkedWallets(_ wallets: [String]) {
        let next = wallets.map { $0.lowercased() }
        guard next != linkedWallets else { return }
        linkedWallets = next
        if address != nil, pollTask != nil { start() }
    }

    /// The answers, with the accounts in this wallet as `mine`. Nobody's asked about those, so there's nothing to undo or save, and
    /// one that's removed is simply gone, or a mistyped savings wallet would stay linked.
    public var book: Book {
        answers.linking(linkedWallets)
    }

    /// Whether there's anything of the user's own to forget.
    public var hasAnswers: Bool {
        !answers.isEmpty
    }

    public func setCurrency(_ currency: CurrencyCode) {
        guard currency != self.currency else { return }
        self.currency = currency
        defaults.set(currency.rawValue, forKey: Keys.currency)
        if address != nil { feed = .reading }
        start()
    }

    public func setRule(_ id: String) {
        guard id != (selectedRule ?? rules.first?.id) else { return }
        selectedRule = id
        defaults.set(id, forKey: Keys.rule)
        if address != nil { feed = .reading }
        start()
    }

    /// The rule the numbers on screen were read through, when it isn't the server's default, so they can say so.
    public var activeRuleName: String? {
        guard let id = portfolio?.rule, id != rules.first?.id else { return nil }
        return rules.first { $0.id == id }?.name
    }

    /// Asks the server what rules it has. A rule it doesn't have would fail every read, so that choice goes.
    public func refreshRules() async {
        let asked = serverURL
        guard let next = try? await source.rules(), asked == serverURL else { return }
        rules = next
        if let chosen = selectedRule, !next.contains(where: { $0.id == chosen }) {
            selectedRule = nil
            defaults.removeObject(forKey: Keys.rule)
            if address != nil { feed = .reading }
            start()
        }
    }

    public func comparison() async throws -> RuleComparison {
        guard let address else { throw CancellationError() }
        return try await source.comparison(address: address, method: method, currency: currency, linked: linked(for: address), book: bookToSend(book, for: address))
    }

    public func setServerURL(_ url: URL) {
        guard url != serverURL else { return }
        serverURL = url
        defaults.set(url.absoluteString, forKey: Keys.server)
        source = makeSource(url)
        rules = []
        // Another server's numbers can be different facts, so these aren't kept even for a moment.
        portfolio = nil
        updatedAt = nil
        if address != nil { feed = .reading }
        start()
    }

    /// Takes effect right away, and the numbers follow as soon as the server has folded them. Undo goes back to what this replaced.
    public func setBook(_ next: Book) {
        let nextAnswers = answers(in: next)
        guard nextAnswers != answers else { return }
        undoStack.append(answers)
        store(nextAnswers)
    }

    public func undo() {
        guard let previous = undoStack.popLast() else { return }
        store(previous)
    }

    private func store(_ next: Book) {
        answers = next
        defaults.set(try? JSONEncoder().encode(next), forKey: Keys.book)
        start()
    }

    /// A book built on `book` has the accounts in it, and they aren't answers. What was said about one before it was an account stays.
    private func answers(in next: Book) -> Book {
        var kept = next.unlinking(linkedWallets)
        for account in linkedWallets where next.senders[account]?.kind == .mine { kept.senders[account] = answers.senders[account] }
        return kept
    }

    /// What goes along with a read. A wallet being watched could be anyone's, and it didn't get its costs from this user's accounts
    /// just because they sent it something, so it only gets what's actually been answered.
    private func bookToSend(_ book: Book, for address: String) -> Book {
        book.linkedWallets.contains(address) ? book : book.unlinking(linkedWallets)
    }

    /// What these answers would do to the headline. Nothing's kept, so asking changes nothing.
    public func previews(of candidates: [Book]) async throws -> [BookPreview] {
        guard let address else { throw FetchError.unreachable }
        return try await source.previews(address: address, method: method, currency: currency, rule: selectedRule, linked: linked(for: address), candidates: candidates.map { bookToSend($0, for: address) })
    }

    /// Every movement as a spreadsheet, marked so an estimate or an unknown can't pass for an exact number.
    public func exportCSV() async throws -> String {
        guard let address else { throw FetchError.unreachable }
        return try await source.exportCSV(address: address, method: method, currency: currency, rule: selectedRule, linked: linked(for: address), book: bookToSend(book, for: address))
    }

    /// Reads an exchange's history, and keeps what it found on this device. Says how many withdrawals had no usable cost.
    public func importCoinbase(csv: String) async throws -> ExchangeImport {
        let imported = try await source.importCoinbase(csv: csv)
        var next = book
        next.withdrawals = imported.withdrawals
        setBook(next)
        return imported
    }

    /// Links a wallet that proved it's this user's by signing. Says whether the signature holds up.
    public func linkProved(_ wallet: String, signature: String) async throws -> Bool {
        guard let address, WalletAddress.isValid(address) else { return false }
        guard try await source.verifyLink(owner: address, address: wallet, signature: signature) else { return false }
        setBook(book.answering(wallet, .mine, focus: address))
        return true
    }

    /// nil with no wallet, when there's nothing to explain.
    public func explanationRequest(for target: ExplainTarget) -> ExplanationRequest? {
        address.map { ExplanationRequest(target: target, address: $0, method: method, currency: currency, rule: selectedRule, linked: linked(for: $0), serverURL: serverURL, book: bookToSend(book, for: $0)) }
    }

    public func explanation(for request: ExplanationRequest) async throws -> Explanation {
        // A request from before a change has nothing to say about what's on screen now.
        guard request == explanationRequest(for: request.target) else { throw CancellationError() }
        return try await source.explanation(of: request.target, address: request.address, method: request.method, currency: request.currency, rule: request.rule, linked: request.linked, book: request.book)
    }

    public func proof(leg: String, address: String) async throws -> Proof {
        guard address == self.address else { throw CancellationError() }
        return try await source.proof(leg: leg, address: address, currency: currency, rule: selectedRule)
    }

    public func verification(leg: String, address: String) async throws -> Verification {
        guard address == self.address else { throw CancellationError() }
        return try await source.verification(leg: leg, address: address, currency: currency, rule: selectedRule)
    }

    public func taxReport(_ request: TaxReportRequest) async throws -> TaxReport {
        // A request from before a change of server has nothing to say about what's on screen now.
        guard request.serverURL == serverURL else { throw CancellationError() }
        return try await source.taxReport(request)
    }

    public func linked(for address: String) -> [String] {
        // Costs only carry over onto a wallet that's the user's own. A wallet being watched could be anyone's.
        linkedWallets.contains(address) ? linkedWallets.filter { $0 != address } : []
    }

    /// Where this store reads from, for anything else that needs the same server.
    public var currentSource: any PortfolioSource { source }

    /// One read. Returns how long to wait before the next one.
    func poll() async -> Duration {
        guard let address else { return unreachableDelay }
        let method = self.method
        let currency = self.currency
        let rule = selectedRule
        let serverURL = self.serverURL
        let book = self.book
        let linked = linked(for: address)
        // An answer that arrives after a change is about something else, whatever it says.
        let isCurrent = { [self] in !Task.isCancelled && address == self.address && method == self.method && currency == self.currency && rule == self.selectedRule && serverURL == self.serverURL && book == self.book && linked == self.linked(for: address) }
        let isOtherRule = rule != nil && portfolio?.rule != rule
        // The first read in a currency also reads its rate at each of this wallet's transactions, and the first by a rule
        // reads the wallet again, so they get as long as a first read.
        let timeout: Duration = portfolio?.currency == currency && !isOtherRule ? .seconds(15) : .seconds(180)
        do {
            let next = try await source.portfolio(address: address, method: method, currency: currency, rule: rule, linked: linked, book: bookToSend(book, for: address), timeout: timeout)
            guard isCurrent() else { return .zero }
            portfolio = next
            updatedAt = now()
            feed = state(of: next)
            return reachableDelay
        } catch {
            guard isCurrent(), !(error is CancellationError) else { return .zero }
            // Numbers by another method or rule, or in another currency, are wrong now, not just old, and there's no way to get the right ones.
            if portfolio?.method != method || portfolio?.currency != currency || isOtherRule { portfolio = nil }
            feed = state(of: error)
            return feed == .serverUnreachable ? unreachableDelay : reachableDelay
        }
    }

    private func state(of portfolio: Portfolio) -> FeedState {
        guard portfolio.mode != .demo, let newest = portfolio.latest.date else { return .live }
        let age = Int(now().timeIntervalSince(newest))
        if age > Self.behindAfterSeconds { return .behind(seconds: age) }
        return portfolio.progress.started && portfolio.progress.behindBlocks == 0 ? .live : .catchingUp
    }

    private func state(of error: any Error) -> FeedState {
        switch error as? FetchError {
        case .ampUnavailable(let message): .ampUnavailable(message)
        case .noAmpConfigured(let message): .noAmpConfigured(message)
        case .rejected(let message): .rejected(message)
        case .unreachable, nil: .serverUnreachable
        }
    }

    private enum Keys {
        static let wallet = "wallet"
        static let method = "method"
        static let currency = "currency"
        static let server = "serverURL"
        static let book = "answers"
        static let rule = "pricingRule"
    }
}
