// What one USD buys right now, for what isn't part of a wallet's own read. It's read on its own schedule, and a server that said to wait isn't asked any sooner.

import Foundation
import Observation

@MainActor
@Observable
final class RateReader {
    private static let delay: Duration = .seconds(300)
    private static let lasts: TimeInterval = 60 * 60

    /// What it reads and for whom. The store owns this.
    @ObservationIgnored weak var store: PortfolioStore?
    /// In `store`'s currency, or nil in USD, or with no current rate.
    private(set) var currentRate: CurrentRate?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private let retryDelay: Duration
    /// When the server said it'd have room for a rate read again. Starting over doesn't change that, but another server or invite does.
    @ObservationIgnored private var heldUntil: Date?
    /// Lets a rate go at the end of its time, when the server said to wait past that.
    @ObservationIgnored private var expiry: Task<Void, Never>?
    @ObservationIgnored private let now: @Sendable () -> Date

    init(retryDelay: Duration, now: @escaping @Sendable () -> Date) {
        self.retryDelay = retryDelay
        self.now = now
    }

    func start() {
        task = Task { [weak self] in
            while !Task.isCancelled {
                guard let hasRead = await self?.readRate(), let delay = self?.holdLeft ?? self?.retryDelay else { return }
                try? await Task.sleep(for: hasRead ? Self.delay : delay)
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
        expiry?.cancel()
        expiry = nil
    }

    /// Another server or invite hasn't said to wait.
    func sourceChanged() {
        heldUntil = nil
    }

    /// Another server's rate isn't this one's.
    func forget() {
        currentRate = nil
    }

    /// Reads the current rate. A failed read keeps the last one for a while, because the feed moves hourly at most, and after that amounts go back to USD. An answer of no rate counts straight away.
    /// True when the server answered, so a read that failed can be tried again sooner.
    @discardableResult
    func readRate() async -> Bool {
        guard let store else { return false }
        let currency = store.currency
        guard currency != .USD else {
            currentRate = nil
            return true
        }
        guard holdLeft == nil else { return notRead() }
        let source = store.source
        let asked = store.sourceChanges
        let server = store.serverURL
        do {
            let micros = try await source.currentRate(currency: currency)
            guard !Task.isCancelled, currency == store.currency, server == store.serverURL else { return true }
            currentRate = micros.map { CurrentRate(currency: currency, micros: $0, readAt: now()) }
            return true
        } catch {
            // The server said it whether or not anyone's still waiting on this read, and the longest wait it's given is the one that counts.
            if case FetchError.rateLimited(_, let retryAfter) = error, asked == store.sourceChanges {
                let until = now().addingTimeInterval(TimeInterval(retryAfter))
                heldUntil = max(heldUntil ?? until, until)
            }
            if Task.isCancelled { return true }
            return notRead()
        }
    }

    /// How much of the server's wait is left, if any.
    private var holdLeft: Duration? {
        guard let left = heldUntil?.timeIntervalSince(now()), left > 0 else { return nil }
        return .seconds(left)
    }

    /// There's no new rate, so the last one only stays while it's new enough.
    private func notRead() -> Bool {
        if let currentRate, now().timeIntervalSince(currentRate.readAt) > Self.lasts { self.currentRate = nil }
        if let holdLeft { expire(within: holdLeft) }
        return false
    }

    /// The next read is too late to notice a rate getting too old if it runs out within this time, and a server that said to wait isn't asked any sooner.
    private func expire(within wait: Duration) {
        guard let currentRate else { return }
        let left = Self.lasts - now().timeIntervalSince(currentRate.readAt)
        guard .seconds(left) < wait else { return }
        expiry?.cancel()
        expiry = Task { [weak self] in
            try? await Task.sleep(for: .seconds(left))
            guard !Task.isCancelled, let self, self.currentRate == currentRate else { return }
            self.currentRate = nil
        }
    }
}

struct CurrentRate: Equatable {
    let currency: CurrencyCode
    let micros: String
    let readAt: Date
}
