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
    public let serverURL: URL
    public let book: Book
}

@MainActor
@Observable
public final class PortfolioStore {
    public static let defaultServerURL = URL(string: "http://127.0.0.1:8787")!
    /// Past this, the newest block is too old to call live. Base makes a block every 2 s.
    static let behindAfterSeconds = 120

    /// What the store holds, which may not be current: read `feed` before calling it live. While a new method's numbers
    /// are on their way, the feed is `.reading` and this still holds the old method's, so the screen doesn't jump.
    public private(set) var portfolio: Portfolio?
    public private(set) var feed: FeedState
    public private(set) var updatedAt: Date?
    public private(set) var address: String?
    public private(set) var method: CostMethod
    public private(set) var serverURL: URL
    /// What the user has said about where things came from. It stays on this device.
    public private(set) var book: Book
    /// What each answer replaced, newest last, so Undo is always there.
    public private(set) var undoStack: [Book] = []

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
        self.serverURL = serverURL
        self.book = defaults.data(forKey: Keys.book).flatMap { try? JSONDecoder().decode(Book.self, from: $0) } ?? Book()
        self.feed = address == nil ? .noWallet : .reading
        self.source = makeSource(serverURL)
    }

    /// Starts polling, or starts over, say after a change or when asked to refresh.
    public func start() {
        pollTask?.cancel()
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

    public func setServerURL(_ url: URL) {
        guard url != serverURL else { return }
        serverURL = url
        defaults.set(url.absoluteString, forKey: Keys.server)
        source = makeSource(url)
        // Another server's numbers can be different facts, so these aren't kept even for a moment.
        portfolio = nil
        updatedAt = nil
        if address != nil { feed = .reading }
        start()
    }

    /// Takes effect right away, and the numbers follow as soon as the server has folded them. Undo goes back to what this replaced.
    public func setBook(_ next: Book) {
        guard next != book else { return }
        undoStack.append(book)
        store(next)
    }

    public func undo() {
        guard let previous = undoStack.popLast() else { return }
        store(previous)
    }

    private func store(_ next: Book) {
        book = next
        defaults.set(try? JSONEncoder().encode(next), forKey: Keys.book)
        start()
    }

    /// What these answers would do to the headline. Nothing's kept, so asking changes nothing.
    public func previews(of candidates: [Book]) async throws -> [BookPreview] {
        guard let address else { throw FetchError.unreachable }
        return try await source.previews(address: address, method: method, candidates: candidates)
    }

    /// Every movement as a spreadsheet, marked so an estimate or an unknown can't pass for an exact number.
    public func exportCSV() async throws -> String {
        guard let address else { throw FetchError.unreachable }
        return try await source.exportCSV(address: address, method: method, book: book)
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
        address.map { ExplanationRequest(target: target, address: $0, method: method, serverURL: serverURL, book: book) }
    }

    public func explanation(for request: ExplanationRequest) async throws -> Explanation {
        // A request from before a change has nothing to say about what's on screen now.
        guard request == explanationRequest(for: request.target) else { throw CancellationError() }
        return try await source.explanation(of: request.target, address: request.address, method: request.method, book: request.book)
    }

    /// One read. Returns how long to wait before the next one.
    func poll() async -> Duration {
        guard let address else { return unreachableDelay }
        let method = self.method
        let serverURL = self.serverURL
        let book = self.book
        // An answer that arrives after a change is about something else, whatever it says.
        let isCurrent = { [self] in !Task.isCancelled && address == self.address && method == self.method && serverURL == self.serverURL && book == self.book }
        let timeout: Duration = portfolio == nil ? .seconds(180) : .seconds(15)
        do {
            let next = try await source.portfolio(address: address, method: method, book: book, timeout: timeout)
            guard isCurrent() else { return .zero }
            portfolio = next
            updatedAt = now()
            feed = state(of: next)
            return reachableDelay
        } catch {
            guard isCurrent(), !(error is CancellationError) else { return .zero }
            // Numbers by another method are wrong now, not just old, and there's no way to get the right ones.
            if portfolio?.method != method { portfolio = nil }
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
        static let server = "serverURL"
        static let book = "book"
    }
}
