// The live feed: reads when the server says there's a new block, polls when it can't say, and knows whether what it holds is still true.

import Foundation
import Observation

public enum FeedState: Equatable, Sendable {
    case noWallet
    /// Waiting on an answer, which the first time for a wallet can take a minute, or on one of All Yours' wallets being read again.
    /// Numbers on screen are the last answer, and may be old.
    case reading
    case live
    /// The server and Amp both answer, but Amp's newest block is old.
    case behind(seconds: Int)
    /// The chain is current, but the dataset hasn't processed up to it yet.
    case catchingUp
    case serverUnreachable
    /// The server answers, but this wallet's read didn't finish in as long as a first read gets.
    case tooSlow
    case ampUnavailable(String)
    case noAmpConfigured(String)
    case rejected(String)
    /// The server refused this wallet as having more history than it can hold, so there are no numbers for it.
    case tooBig(String)
    /// The server is holding this client back for now, which clears by itself.
    case rateLimited(String)
    /// The server answers, but it couldn't update some of All Yours' wallets, so the numbers stay as they were last read. Those wallets' notices say which.
    case walletsOutdated

    /// Only this state may show a number as current.
    public var isLive: Bool { self == .live }

    /// The last read failed or is old, so whatever's on screen has stopped moving.
    public var isStale: Bool {
        switch self {
        case .noWallet, .reading, .live, .catchingUp: false
        case .behind, .serverUnreachable, .tooSlow, .ampUnavailable, .noAmpConfigured, .rejected, .tooBig, .rateLimited, .walletsOutdated: true
        }
    }

    /// A blip, usually, so the status alone says so until it's gone on a while. The others say the numbers are old from the start.
    public var canBeBrief: Bool {
        switch self {
        case .serverUnreachable, .tooSlow, .ampUnavailable, .rateLimited: true
        default: false
        }
    }
}

extension FeedState {
    /// Whether the menu bar's panel says what kind of wallet this is. Not when the line beside it or under it already says the same:
    /// "Demo wallet", "No wallet yet", or "Reading this wallet…".
    public func showsWalletBadge(portfolio: Portfolio?) -> Bool {
        switch self {
        case .noWallet: false
        case .reading: portfolio != nil
        case .live: portfolio?.mode != .demo
        default: true
        }
    }
}

@MainActor
@Observable
final class FeedLoop {
    /// Past this, the newest block is too old to call live.
    private static let behindAfterSeconds = 120

    /// What it reads and for whom. The store owns this, and everything that's read depends on what the store says now.
    @ObservationIgnored weak var store: PortfolioStore?

    /// What the store holds, which may not be current: read `feed` before calling it live. While a new wallet's, method's, currency's
    /// or rule's numbers are on their way, the feed is `.reading` and this holds the last ones known, so the screen doesn't go blank.
    /// They're always this wallet's, though they can be by the last method, currency or rule it was read in.
    private(set) var portfolio: Portfolio? {
        didSet { portfolioRevision &+= 1 }
    }
    /// Goes up each time `portfolio` is replaced, however that happens: a read, the last read on the server, or what's kept from
    /// before. `updatedAt` only changes with a fresh read, so whatever's worked out from `portfolio` keys on this instead.
    private(set) var portfolioRevision = 0
    private(set) var feed: FeedState {
        didSet { noteProblem() }
    }
    /// Whether what's wrong has been worth saying beyond the status: it can't clear by itself in a moment, or it's had `longProblem` to. A read that's trying again keeps it.
    private(set) var isProblemLong = false
    @ObservationIgnored private var longProblemTask: Task<Void, Never>?
    /// What was wrong when someone asked to try again. It stands until that read answers.
    private(set) var retriedProblem: FeedState?
    /// When the read that's running now started, so a long one can say how long it's been, including a retry after a failure. nil between reads.
    /// A change starts a new read, so it starts this over. A read that waits longer on the same request keeps it.
    private(set) var readingSince: Date? {
        didSet { noteRead() }
    }
    /// Whether the read that's running has gone on for `longReadSeconds`, so it's worth saying more than that it's running.
    private(set) var isReadLong = false
    @ObservationIgnored private var longReadTask: Task<Void, Never>?
    /// Which read `readingSince` belongs to, so one a change left behind can't clear it when it finally ends.
    @ObservationIgnored private var readCount = 0
    private(set) var updatedAt: Date?

    @ObservationIgnored private var cache: PortfolioCache
    /// Something changed, so the server can answer from what it last read while the real read runs.
    @ObservationIgnored private var wantsLastRead = true
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let reachableDelay: Duration
    @ObservationIgnored private let unreachableDelay: Duration
    @ObservationIgnored private let pushedDelay: Duration
    /// When the server said it'd have room again, after holding this client back.
    @ObservationIgnored private var heldUntil: Date?
    private let longProblem: Duration
    @ObservationIgnored private let liveFor: Duration
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var eventsTask: Task<Void, Never>?
    @ObservationIgnored private var liveExpiry: Task<Void, Never>?
    /// The server is telling this store about new blocks, so a read only needs to happen on a timer in case that stops working.
    @ObservationIgnored private var isPushed = false
    /// What the next read is waiting on, which a new block cuts short.
    @ObservationIgnored private var sleeper: Task<Void, Never>?
    /// A block arrived during a read, which may have missed it.
    @ObservationIgnored private var wakePending = false

    init(hasWallet: Bool, cacheDirectory: URL?, now: @escaping @Sendable () -> Date, reachableDelay: Duration, unreachableDelay: Duration, pushedDelay: Duration, liveFor: Duration, longProblem: Duration) {
        self.now = now
        self.reachableDelay = reachableDelay
        self.unreachableDelay = unreachableDelay
        self.pushedDelay = pushedDelay
        self.liveFor = liveFor
        self.longProblem = longProblem
        feed = hasWallet ? .reading : .noWallet
        readingSince = hasWallet ? now() : nil
        cache = PortfolioCache(directory: cacheDirectory, now: now())
    }

    /// Whether it's following, as opposed to stopped, so a change has reads to start over.
    var isRunning: Bool { pollTask != nil }

    func start() {
        guard store?.address != nil else { return }
        // In the same moment as whatever changed, so no frame shows the last read's time against the next one.
        readingSince = now()
        eventsTask = Task { [weak self] in await self?.followEvents() }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let delay = await self?.poll() else { return }
                await self?.wait(delay)
            }
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
        readCount += 1
        readingSince = nil
        eventsTask?.cancel()
        eventsTask = nil
        isPushed = false
        wakePending = false
    }

    /// Someone asked to read again, and should see it happen.
    func markRetried() {
        if feed.isStale { retriedProblem = feed }
        if store?.address != nil { feed = .reading }
    }

    /// The numbers on screen aren't what they'd be now, so they can't be called live, and the next ones are on their way.
    func markChanged() {
        if store?.address != nil { feed = .reading }
        wantsLastRead = true
    }

    /// In the same moment as the address, so one wallet's numbers are never on screen under another.
    func walletChanged() {
        portfolio = lastKnown()
        updatedAt = nil
        retriedProblem = nil
        feed = store?.address == nil ? .noWallet : .reading
        wantsLastRead = true
    }

    /// The numbers for these settings if they've been read before. If not, the ones on screen stay until the new ones arrive.
    func settingsChanged() {
        if let known = lastKnown() { portfolio = known }
    }

    /// Another server's numbers can be different facts, so these aren't kept even for a moment. What's known is this server's own.
    func serverChanged() {
        portfolio = lastKnown()
        updatedAt = nil
    }

    /// What this wallet showed last time, for when the app opens.
    func showLastKnown() {
        if store?.address != nil { portfolio = lastKnown() }
    }

    /// It's off the list, so nothing about it stays here.
    func forget(_ address: String) {
        cache.forget(address)
    }

    /// What this wallet last showed on this server, by these settings if it can be.
    private func lastKnown() -> Portfolio? {
        guard let store, let address = store.address else { return nil }
        return cache.last(of: address, on: store.serverURL, preferring: store.isForCurrentSettings)
    }

    /// Wakes a read for each new block the server reports, for as long as it can, and tries again when it stops.
    private func followEvents() async {
        while !Task.isCancelled {
            guard let events = store?.source.headEvents() else { return }
            var again = unreachableDelay
            do {
                for try await _ in events {
                    guard !Task.isCancelled else { return }
                    isPushed = true
                    wake()
                }
            } catch FetchError.rateLimited(_, let retryAfter) {
                again = .seconds(retryAfter)
            } catch {}
            guard !Task.isCancelled else { return }
            // Back to polling straight away, not after the long wait that being told about blocks allowed.
            isPushed = false
            wake()
            try? await Task.sleep(for: again)
        }
    }

    private func wake() {
        // A new block isn't a reason to ask a server that's said to wait.
        if let heldUntil, now() < heldUntil { return }
        if let sleeper { sleeper.cancel() } else { wakePending = true }
    }

    /// Waits for the next read, which a new block ends early. The usual delay only applies while the server isn't reporting blocks, or a read just failed.
    private func wait(_ delay: Duration) async {
        if wakePending {
            wakePending = false
            return
        }
        // While All Yours still has wallets on their way, they could be done by the next read, block or not.
        let isWaitingOnWallets = portfolio?.isAllYours == true && (portfolio?.linkedReading.isEmpty == false || portfolio?.linkedUpdating?.isEmpty == false)
        let duration = isPushed && delay == reachableDelay && !feed.isStale && !isWaitingOnWallets ? pushedDelay : delay
        let sleeping = Task { _ = try? await Task.sleep(for: duration) }
        sleeper = sleeping
        await withTaskCancellationHandler { await sleeping.value } onCancel: { sleeping.cancel() }
        if sleeper == sleeping { sleeper = nil }
    }

    /// One read. Returns how long to wait before the next one.
    func poll() async -> Duration {
        guard let store, let address = store.address else { return unreachableDelay }
        readCount += 1
        let thisRead = readCount
        readingSince = now()
        defer { if thisRead == readCount { readingSince = nil } }
        let method = store.method
        let currency = store.currency
        let rule = store.selectedRule
        let serverURL = store.serverURL
        let book = store.book
        let linked = store.linked(for: address)
        // An answer that arrives after a change is about something else, whatever it says.
        let isCurrent = { !Task.isCancelled && address == store.address && method == store.method && currency == store.currency && rule == store.selectedRule && serverURL == store.serverURL && book == store.book && linked == store.linked(for: address) }
        let context = ReadContext(address: address, method: method, currency: currency, rule: rule, linked: linked, book: store.bookToSend(book, for: address))
        if wantsLastRead {
            wantsLastRead = false
            // Comes straight back when the server has read this wallet, so a change of method or an answer doesn't wait on the chain. It's no help if it can't.
            let last = try? await store.source.lastRead(context)
            guard isCurrent() else { return .zero }
            if let last, shouldShow(last) {
                let shown = holdingWhatsShown(last)
                portfolio = shown
                cache.remember(shown, of: address, on: serverURL, at: now())
            }
        }
        let isOtherRule = rule != nil && portfolio?.rule != rule
        // The first read in a currency also reads its rate at each of this wallet's transactions, and the first by a rule
        // reads the wallet again, so they get as long as a first read.
        let timeout: Duration = portfolio?.currency == currency && !isOtherRule ? .seconds(15) : PortfolioStore.firstReadTimeout
        let read = { (timeout: Duration) in
            try await store.source.portfolio(context, timeout: timeout)
        }
        do {
            let answer = try await patiently(read, timeout: timeout, isCurrent: isCurrent)
            guard isCurrent() else { return .zero }
            let next = holdingWhatsShown(answer)
            portfolio = next
            updatedAt = now()
            store.needsInvite = false
            cache.remember(next, of: address, on: serverURL, at: now())
            feed = state(of: next)
            heldUntil = nil
            expireLive()
            return reachableDelay
        } catch {
            guard isCurrent(), !(error is CancellationError) else { return .zero }
            // Numbers by another method or rule, or in another currency, are wrong now, not just old, and there's no way to get the right ones.
            if let portfolio, !store.isForCurrentSettings(portfolio) { self.portfolio = nil }
            feed = state(of: error)
            if case .needsInvite = error as? FetchError { store.needsInvite = true }
            if case FetchError.rateLimited(_, let retryAfter) = error {
                heldUntil = now().addingTimeInterval(TimeInterval(retryAfter))
                wakePending = false
                return .seconds(retryAfter)
            }
            return feed == .serverUnreachable ? unreachableDelay : reachableDelay
        }
    }

    private func holdingWhatsShown(_ answer: Portfolio) -> Portfolio {
        portfolio.map(answer.holding) ?? answer
    }

    /// Not when it's behind numbers on screen that answer the same question, as it can be after a reorg or if the app has seen further.
    private func shouldShow(_ last: Portfolio) -> Bool {
        guard let portfolio, store?.isForCurrentSettings(portfolio) == true else { return true }
        return last.latest.blockNum >= portfolio.latest.blockNum
    }

    /// By the same clock as `ReadingClock`, so this agrees with the seconds on screen.
    private func noteRead() {
        longReadTask?.cancel()
        longReadTask = nil
        isReadLong = false
        guard let readingSince else { return }
        let remaining = Double(FeedState.longReadSeconds) - Date.now.timeIntervalSince(readingSince)
        guard remaining > 0 else {
            isReadLong = true
            return
        }
        longReadTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(remaining))
            guard let self, !Task.isCancelled else { return }
            isReadLong = true
        }
    }

    private func noteProblem() {
        if feed != .reading { retriedProblem = nil }
        guard feed.isStale else {
            // A read says nothing yet, so whatever was wrong stands until it answers.
            if feed != .reading {
                longProblemTask?.cancel()
                longProblemTask = nil
                isProblemLong = false
            }
            return
        }
        guard !isProblemLong else { return }
        guard feed.canBeBrief, longProblem > .zero else {
            longProblemTask?.cancel()
            longProblemTask = nil
            isProblemLong = true
            return
        }
        guard longProblemTask == nil else { return }
        longProblemTask = Task { [weak self, longProblem] in
            try? await Task.sleep(for: longProblem)
            guard let self, !Task.isCancelled else { return }
            isProblemLong = true
        }
    }

    /// Stops calling these numbers live once they're older than a read should leave them, say after a Mac sleeps. Checking when a read starts
    /// wouldn't do, because one from before it slept can still be running. This sleep counts time the Mac is asleep, so it ends on waking. Demo data
    /// doesn't age. `stop` leaves this running, because starting over doesn't make the numbers any newer.
    private func expireLive() {
        liveExpiry?.cancel()
        liveExpiry = Task { [weak self, liveFor] in
            try? await Task.sleep(for: liveFor)
            guard let self, !Task.isCancelled, feed == .live, portfolio?.mode != .demo else { return }
            feed = .reading
        }
    }

    /// A read that runs out of time says nothing about the server, which may only be slow to catch up on this wallet, say when a Mac wakes up.
    /// If it's still answering, the read gets as long as a first read, with the numbers on screen marked as on their way.
    private func patiently(_ read: (Duration) async throws -> Portfolio, timeout: Duration, isCurrent: () -> Bool) async throws -> Portfolio {
        do {
            return try await read(timeout)
        } catch FetchError.timedOut {
            guard await serverAnswers() else { throw FetchError.unreachable }
            guard timeout < PortfolioStore.firstReadTimeout else { throw ReadTooSlow() }
            guard isCurrent() else { throw CancellationError() }
            feed = .reading
            return try await patiently(read, timeout: PortfolioStore.firstReadTimeout, isCurrent: isCurrent)
        }
    }

    /// Whether anything's there, even to say no. The rules don't depend on Amp, so they come straight back.
    private func serverAnswers() async -> Bool {
        guard let store else { return false }
        do {
            _ = try await store.source.rules()
            return true
        } catch let error as FetchError {
            return error != .unreachable && error != .timedOut
        } catch {
            return false
        }
    }

    private func state(of portfolio: Portfolio) -> FeedState {
        guard portfolio.mode != .demo else { return .live }
        // First, because they're why these numbers have stopped moving, however old that's made them.
        if portfolio.linkedOutdated?.isEmpty == false { return .walletsOutdated }
        if portfolio.linkedUpdating?.isEmpty == false { return .reading }
        // With no way to tell how old these numbers are, they can't be called live.
        guard let newest = portfolio.latest.date else { return .catchingUp }
        let age = Int(now().timeIntervalSince(newest))
        if age > Self.behindAfterSeconds { return .behind(seconds: age) }
        return portfolio.progress.started && portfolio.progress.behindBlocks == 0 ? .live : .catchingUp
    }

    private func state(of error: any Error) -> FeedState {
        if error is ReadTooSlow { return .tooSlow }
        return switch error as? FetchError {
        case .ampUnavailable(let message): .ampUnavailable(message)
        case .noAmpConfigured(let message): .noAmpConfigured(message)
        case .rejected(let message), .needsInvite(let message), .priceChanged(let message), .notCaughtUp(let message): .rejected(message)
        case .tooBig(let message): .tooBig(message)
        case .rateLimited(let message, _): .rateLimited(message)
        case .unreachable, .timedOut, nil: .serverUnreachable
        }
    }
}

private struct ReadTooSlow: Error {}
