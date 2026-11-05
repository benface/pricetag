// The live feed: reads when the server says there's a new block, polls when it can't say, remembers the wallet, and knows
// whether what it holds is still true.

import Foundation
import Observation

public enum FeedState: Equatable, Sendable {
    case noWallet
    /// Waiting on an answer, which the first time for a wallet can take a minute. Numbers on screen are the previous answer.
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
    /// As long as a read of a wallet the server hasn't read yet can take.
    static let firstReadTimeout: Duration = .seconds(180)

    /// What the store holds, which may not be current: read `feed` before calling it live. While a new method's, currency's
    /// or rule's numbers are on their way, the feed is `.reading` and this still holds the old ones, so the screen doesn't jump.
    public private(set) var portfolio: Portfolio?
    public private(set) var feed: FeedState
    public private(set) var updatedAt: Date?
    public private(set) var address: String?
    public private(set) var method: CostMethod
    public private(set) var currency: CurrencyCode
    /// How the holdings are ordered. It's the same for every wallet, and it's remembered.
    public var holdingsSort: HoldingsSort {
        didSet { defaults.set(holdingsSort.rawValue, forKey: Keys.holdingsSort) }
    }
    /// What one USD buys right now in `currency`, for what isn't part of a wallet's own read. Nil in USD, or with no current rate.
    private var currentRate: CurrentRate?
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
    /// Wallets the user has looked at, for the switcher. Addresses and names only.
    public private(set) var savedWallets: [SavedWallet]

    @ObservationIgnored private var source: any PortfolioSource
    @ObservationIgnored private let makeSource: @Sendable (URL) -> any PortfolioSource
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let reachableDelay: Duration
    @ObservationIgnored private let unreachableDelay: Duration
    @ObservationIgnored private let pushedDelay: Duration
    @ObservationIgnored private let liveFor: Duration
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var eventsTask: Task<Void, Never>?
    @ObservationIgnored private var liveExpiry: Task<Void, Never>?
    /// The server is telling this store about new blocks, so a read only needs to happen on a timer in case that stops working.
    @ObservationIgnored private var isPushed = false
    /// What the next read is waiting on, which a new block cuts short.
    @ObservationIgnored private var sleeper: Task<Void, Never>?
    @ObservationIgnored private var rateTask: Task<Void, Never>?
    @ObservationIgnored private let rateRetryDelay: Duration
    private static let rateDelay: Duration = .seconds(300)
    private static let rateLasts: TimeInterval = 60 * 60
    /// A block arrived during a read, which may have missed it.
    @ObservationIgnored private var wakePending = false

    public init(
        defaults: UserDefaults = .standard,
        makeSource: @escaping @Sendable (URL) -> any PortfolioSource = { PricetagClient(serverURL: $0) },
        now: @escaping @Sendable () -> Date = { Date() },
        reachableDelay: Duration = .seconds(2),
        unreachableDelay: Duration = .seconds(5),
        pushedDelay: Duration = .seconds(15),
        // The longest wait for a block, plus as long as a read gets before it's marked as on its way anyway.
        liveFor: Duration = .seconds(30),
        rateRetryDelay: Duration = .seconds(30)
    ) {
        self.rateRetryDelay = rateRetryDelay
        self.defaults = defaults
        self.makeSource = makeSource
        self.now = now
        self.reachableDelay = reachableDelay
        self.unreachableDelay = unreachableDelay
        self.pushedDelay = pushedDelay
        self.liveFor = liveFor
        let address = defaults.string(forKey: Keys.wallet)
        let serverURL = defaults.string(forKey: Keys.server).flatMap(URL.init(string:)) ?? Self.defaultServerURL
        self.address = address
        self.method = defaults.string(forKey: Keys.method).flatMap(CostMethod.init(rawValue:)) ?? .average
        self.currency = defaults.string(forKey: Keys.currency).flatMap(CurrencyCode.init(rawValue:)) ?? .USD
        self.holdingsSort = defaults.string(forKey: Keys.holdingsSort).flatMap(HoldingsSort.init(rawValue:)) ?? .largestFirst
        self.serverURL = serverURL
        self.answers = defaults.data(forKey: Keys.book).flatMap { try? JSONDecoder().decode(Book.self, from: $0) } ?? Book()
        self.selectedRule = defaults.string(forKey: Keys.rule)
        var saved = defaults.data(forKey: Keys.savedWallets).flatMap { try? JSONDecoder().decode([SavedWallet].self, from: $0) } ?? []
        // From before there was a list, the wallet being shown is all there is to remember.
        if let address, address != WalletAddress.demo, !saved.contains(where: { $0.address == address }) {
            saved.append(SavedWallet(address: address, lastSeen: now()))
        }
        self.savedWallets = saved
        self.feed = address == nil ? .noWallet : .reading
        self.source = makeSource(serverURL)
    }

    /// Starts following, or starts over, say after a change or when asked to refresh.
    public func start() {
        stop()
        Task { await refreshRules() }
        rateTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let hasRead = await self?.readRate(), let delay = self?.rateRetryDelay else { return }
                try? await Task.sleep(for: hasRead ? Self.rateDelay : delay)
            }
        }
        guard address != nil else { return }
        eventsTask = Task { [weak self] in await self?.followEvents() }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let delay = await self?.poll() else { return }
                await self?.wait(delay)
            }
        }
    }

    public func stop() {
        rateTask?.cancel()
        rateTask = nil
        pollTask?.cancel()
        pollTask = nil
        eventsTask?.cancel()
        eventsTask = nil
        isPushed = false
        wakePending = false
    }

    /// Wakes a read for each new block the server reports, for as long as it can, and tries again when it stops.
    private func followEvents() async {
        while !Task.isCancelled {
            guard let events = source.headEvents() else { return }
            do {
                for try await _ in events {
                    guard !Task.isCancelled else { return }
                    isPushed = true
                    wake()
                }
            } catch {}
            guard !Task.isCancelled else { return }
            // Back to polling straight away, not after the long wait that being told about blocks allowed.
            isPushed = false
            wake()
            try? await Task.sleep(for: unreachableDelay)
        }
    }

    private func wake() {
        if let sleeper { sleeper.cancel() } else { wakePending = true }
    }

    /// Waits for the next read, which a new block ends early. The usual delay only applies while the server isn't reporting blocks, or a read just failed.
    private func wait(_ delay: Duration) async {
        if wakePending {
            wakePending = false
            return
        }
        let duration = isPushed && delay == reachableDelay && !feed.isStale ? pushedDelay : delay
        let sleeping = Task { _ = try? await Task.sleep(for: duration) }
        sleeper = sleeping
        await withTaskCancellationHandler { await sleeping.value } onCancel: { sleeping.cancel() }
        if sleeper == sleeping { sleeper = nil }
    }

    /// `address` is 0x… or `WalletAddress.demo`, or nil to forget the wallet.
    public func setWallet(_ address: String?) {
        let next = address?.lowercased()
        guard next != self.address else { return }
        self.address = next
        defaults.set(next, forKey: Keys.wallet)
        if let next, next != WalletAddress.demo {
            saveWallets(SavedWallet.seeing(next, at: now(), in: savedWallets, own: book.linkedWallets))
        }
        portfolio = nil
        updatedAt = nil
        feed = next == nil ? .noWallet : .reading
        start()
    }

    /// A wallet the user just made is what they want to see, unless they're already looking at a real one. Only the user replaces that.
    public func showNewWallet(_ address: String) {
        guard self.address == nil || self.address == WalletAddress.demo else { return }
        setWallet(address)
    }

    /// Keeps it in the list under this name, or makes it a recent one again with an empty name.
    public func renameWallet(_ address: String, to name: String) {
        let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
        var next = savedWallets
        if let index = next.firstIndex(where: { $0.address == address }) {
            next[index].name = clean.isEmpty ? nil : clean
        } else if !clean.isEmpty {
            next.append(SavedWallet(address: address, name: clean, lastSeen: now()))
        }
        saveWallets(next)
    }

    /// Takes it off the list, and shows `next` if it was the one showing.
    public func removeWallet(_ address: String, showing next: String?) {
        saveWallets(savedWallets.filter { $0.address != address })
        if self.address == address { setWallet(next) }
    }

    private func saveWallets(_ wallets: [SavedWallet]) {
        savedWallets = wallets
        defaults.set(try? JSONEncoder().encode(wallets), forKey: Keys.savedWallets)
    }

    /// A key is gone, and `next` took over from it, if anything did. Whoever's looking at its wallet follows, or they'd see an empty address and
    /// think the money vanished. Any other wallet stays, because only the user replaces that.
    public func followRetiredWallet(_ address: String, to next: String?) {
        guard self.address == address.lowercased() else { return }
        setWallet(next)
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

    /// USD amounts as they should read right now.
    public var moneyDisplay: MoneyDisplay {
        MoneyDisplay(main: currency, rateMicros: currentRate?.currency == currency ? currentRate?.micros : nil)
    }

    /// Reads the current rate. A failed read keeps the last one for a while, because the feed moves hourly at most, and after that amounts go back to USD. An answer of no rate counts straight away.
    /// True when the server answered, so a read that failed can be tried again sooner.
    @discardableResult
    public func readRate() async -> Bool {
        let currency = self.currency
        guard currency != .USD else {
            currentRate = nil
            return true
        }
        let source = self.source
        let server = serverURL
        do {
            let micros = try await source.currentRate(currency: currency)
            guard !Task.isCancelled, currency == self.currency, server == serverURL else { return true }
            currentRate = micros.map { CurrentRate(currency: currency, micros: $0, readAt: now()) }
            return true
        } catch {
            if Task.isCancelled { return true }
            if let currentRate, now().timeIntervalSince(currentRate.readAt) > Self.rateLasts { self.currentRate = nil }
            return false
        }
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
        currentRate = nil
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

    /// What a provider says, and not an answer, so there's nothing to undo, and undoing an answer doesn't lose it.
    public func recordPurchase(_ purchase: Purchase) {
        let next = answers.recording(purchase)
        guard next != answers else { return }
        undoStack = undoStack.map { $0.recording(purchase) }
        store(next)
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

    /// What goes along with a read. The demo isn't anyone's, and demo data and real data never mix, so it doesn't get this user's accounts.
    private func bookToSend(_ book: Book, for address: String) -> Book {
        WalletAddress.isDemo(address) ? book.unlinking(linkedWallets) : book
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

    /// Links a wallet that proved it's this user's by signing. Says whether the signature holds up. Only something shaped like one reaches the
    /// server, and only that wallet is linked: its signature says nothing about the one showing. Cancelling while it's checked links nothing, however it goes.
    public func linkProved(_ proof: WalletProof, signature: String) async throws -> Bool {
        guard WalletAddress.isSignature(signature) else { return false }
        let verified = try await source.verifyLink(owner: proof.owner, address: proof.address, signature: signature)
        try Task.checkCancellation()
        guard verified else { return false }
        setBook(book.answering(proof.address, .mine, focus: nil))
        return true
    }

    /// It's not the user's after all. It stays listed as one they're only looking at, so a slip is easy to put right.
    public func unlinkWallet(_ address: String) {
        var next = book
        next.senders[address] = nil
        setBook(next)
        saveWallets(SavedWallet.seeing(address, at: now(), in: savedWallets, own: book.linkedWallets))
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
        let timeout: Duration = portfolio?.currency == currency && !isOtherRule ? .seconds(15) : Self.firstReadTimeout
        let read = { [self] (timeout: Duration) in
            try await source.portfolio(address: address, method: method, currency: currency, rule: rule, linked: linked, book: bookToSend(book, for: address), timeout: timeout)
        }
        do {
            let next = try await patiently(read, timeout: timeout, isCurrent: isCurrent)
            guard isCurrent() else { return .zero }
            portfolio = next
            updatedAt = now()
            feed = state(of: next)
            expireLive()
            return reachableDelay
        } catch {
            guard isCurrent(), !(error is CancellationError) else { return .zero }
            // Numbers by another method or rule, or in another currency, are wrong now, not just old, and there's no way to get the right ones.
            if portfolio?.method != method || portfolio?.currency != currency || isOtherRule { portfolio = nil }
            feed = state(of: error)
            return feed == .serverUnreachable ? unreachableDelay : reachableDelay
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
            guard timeout < Self.firstReadTimeout else { throw FetchError.ampUnavailable(Wording.readTooSlow) }
            guard isCurrent() else { throw CancellationError() }
            feed = .reading
            return try await patiently(read, timeout: Self.firstReadTimeout, isCurrent: isCurrent)
        }
    }

    /// Whether anything's there, even to say no. The rules don't depend on Amp, so they come straight back.
    private func serverAnswers() async -> Bool {
        do {
            _ = try await source.rules()
            return true
        } catch let error as FetchError {
            return error != .unreachable && error != .timedOut
        } catch {
            return false
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
        case .unreachable, .timedOut, nil: .serverUnreachable
        }
    }

    private enum Keys {
        static let wallet = "wallet"
        static let method = "method"
        static let currency = "currency"
        static let server = "serverURL"
        static let book = "answers"
        static let rule = "pricingRule"
        static let savedWallets = "savedWallets"
        static let holdingsSort = "holdingsSort"
    }
}

private struct CurrentRate {
    let currency: CurrencyCode
    let micros: String
    let readAt: Date
}
