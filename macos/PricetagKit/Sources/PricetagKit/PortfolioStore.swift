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
    public let linked: [String]
    public let serverURL: URL
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
        self.serverURL = serverURL
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

    public func setLinkedWallets(_ wallets: [String]) {
        let next = wallets.map { $0.lowercased() }
        guard next != linkedWallets else { return }
        linkedWallets = next
        if address != nil, pollTask != nil { start() }
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

    /// nil with no wallet, when there's nothing to explain.
    public func explanationRequest(for target: ExplainTarget) -> ExplanationRequest? {
        address.map { ExplanationRequest(target: target, address: $0, method: method, linked: linked(for: $0), serverURL: serverURL) }
    }

    public func explanation(for request: ExplanationRequest) async throws -> Explanation {
        // A request from before a change has nothing to say about what's on screen now.
        guard request == explanationRequest(for: request.target) else { throw CancellationError() }
        return try await source.explanation(of: request.target, address: request.address, method: request.method, linked: request.linked)
    }

    private func linked(for address: String) -> [String] {
        // Costs only carry over onto a wallet that's the user's own. A wallet being watched could be anyone's.
        linkedWallets.contains(address) ? linkedWallets.filter { $0 != address } : []
    }

    /// Where this store reads from, for anything else that needs the same server.
    public var currentSource: any PortfolioSource { source }

    /// One read. Returns how long to wait before the next one.
    func poll() async -> Duration {
        guard let address else { return unreachableDelay }
        let method = self.method
        let serverURL = self.serverURL
        let linked = linked(for: address)
        // An answer that arrives after a change is about something else, whatever it says.
        let isCurrent = { [self] in !Task.isCancelled && address == self.address && method == self.method && serverURL == self.serverURL && linked == self.linked(for: address) }
        let timeout: Duration = portfolio == nil ? .seconds(180) : .seconds(15)
        do {
            let next = try await source.portfolio(address: address, method: method, linked: linked, timeout: timeout)
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
    }
}
