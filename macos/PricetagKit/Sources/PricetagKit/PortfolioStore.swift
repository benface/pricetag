// The live feed: reads when the server says there's a new block, polls when it can't say, remembers the wallet, and knows
// whether what it holds is still true.

import Foundation
import Observation

/// What the list and the answers said about one wallet, before a change to it.
public struct WalletListSnapshot: Sendable {
    let address: String
    let answer: SenderAnswer?
    let undoDepth: Int
    /// The answer the change gave, and the undo entry it made, if it made one.
    var changedAnswer: SenderAnswer?
    var undoEntry: UUID?
    let saved: SavedWallet?
    let orderIndex: Int?
    let wasHidden: Bool
    let wasShowing: Bool
}

/// One step Undo can take back: the answers before it, what the Edit menu calls it, and for a change to one wallet, the rest of what it changed.
private struct HistoryEntry {
    /// Kept through Undo and Redo, so the wallet list's own Undo can still find the change it made.
    let id: UUID
    let name: String
    /// Before the step while it's in the undo history, and after it while it's in the redo history.
    var book: Book
    /// When the answers in `book` were given, and what they were about, so Undo and Redo put back each answer's own date.
    var details: AnswerDetails
    var wallet: WalletStep?
}

/// A change to one wallet as the wallet list makes it. Undo puts all of it back, and Redo makes it again.
private struct WalletStep {
    var snapshot: WalletListSnapshot
    let change: () -> Void
    let alsoUndo: (() -> Void)?
}

public enum FeedState: Equatable, Sendable {
    case noWallet
    /// Waiting on an answer, which the first time for a wallet can take a minute. Numbers on screen are the last answer, and may be old.
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

    /// Only this state may show a number as current.
    public var isLive: Bool { self == .live }

    /// The last read failed or is old, so whatever's on screen has stopped moving.
    public var isStale: Bool {
        switch self {
        case .noWallet, .reading, .live, .catchingUp: false
        case .behind, .serverUnreachable, .tooSlow, .ampUnavailable, .noAmpConfigured, .rejected: true
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
    nonisolated static let firstReadTimeout: Duration = .seconds(180)

    /// What the store holds, which may not be current: read `feed` before calling it live. While a new wallet's, method's, currency's
    /// or rule's numbers are on their way, the feed is `.reading` and this holds the last ones known, so the screen doesn't go blank.
    /// They're always this wallet's, though they can be by the last method, currency or rule it was read in.
    public private(set) var portfolio: Portfolio?
    public private(set) var feed: FeedState
    /// When the read that's running now started, so a long one can say how long it's been, including a retry after a failure. nil between reads.
    /// A change starts a new read, so it starts this over. A read that waits longer on the same request keeps it.
    public private(set) var readingSince: Date?
    /// Which read `readingSince` belongs to, so one a change left behind can't clear it when it finally ends.
    @ObservationIgnored private var readCount = 0
    public private(set) var updatedAt: Date?
    public private(set) var address: String?
    public private(set) var method: CostMethod
    public private(set) var currency: CurrencyCode
    /// How the holdings are ordered. It's the same for every wallet, and it's remembered.
    public var holdingsSort: HoldingsSort {
        didSet { defaults.set(holdingsSort.rawValue, forKey: Keys.holdingsSort) }
    }
    public private(set) var menuBarShows: MenuBarShows
    /// What one USD buys right now in `currency`, for what isn't part of a wallet's own read. Nil in USD, or with no current rate.
    private var currentRate: CurrentRate?
    public private(set) var serverURL: URL
    /// What the user has said about where things came from. It stays on this device.
    private var answers: Book
    /// What each answer replaced, newest last, so Undo is always there. Accounts aren't in here, so it can't bring back one that's gone.
    /// When each answer was given and what it was about, for the list of answers. Never sent anywhere.
    public private(set) var answerDetails: AnswerDetails
    private var history: [HistoryEntry] = []
    /// What Undo took back, newest last, until something else changes.
    private var future: [HistoryEntry] = []
    public var undoStack: [Book] { history.map(\.book) }
    /// What each entry of `undoStack` takes back, in a menu's words, as in "Undo Answer".
    public var undoNames: [String] { history.map(\.name) }
    public var redoStack: [Book] { future.map(\.book) }
    public var redoNames: [String] { future.map(\.name) }
    /// The server's pricing rules. Empty when it has only one, so there's nothing to choose.
    public private(set) var rules: [PricingRule] = []
    /// What to ask the server for, or nil for its default.
    public private(set) var selectedRule: String?
    /// The user's own wallets. Transfers between them carry their cost, and aren't new purchases.
    public private(set) var linkedWallets: [String] = []
    /// Wallets the user has looked at, for the switcher. Addresses and names only.
    public private(set) var savedWallets: [SavedWallet]
    /// How the user arranged the list.
    public private(set) var walletOrder: [String]
    /// Taken off the list, but still the user's, so costs keep following their money.
    public private(set) var hiddenWallets: [String]

    @ObservationIgnored private var source: any PortfolioSource
    @ObservationIgnored private var cache: PortfolioCache
    /// Something changed, so the server can answer from what it last read while the real read runs.
    @ObservationIgnored private var wantsLastRead = true
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
        /// Where each wallet's last numbers stay across launches, or nil to keep them only in memory.
        cacheDirectory: URL? = nil,
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
        self.menuBarShows = defaults.string(forKey: Keys.menuBar).flatMap(MenuBarShows.init(rawValue:)) ?? .value
        self.serverURL = serverURL
        let answers = defaults.data(forKey: Keys.book).flatMap { try? JSONDecoder().decode(Book.self, from: $0) } ?? Book()
        self.answers = answers
        self.answerDetails = (defaults.data(forKey: Keys.answerDetails).flatMap { try? JSONDecoder().decode(AnswerDetails.self, from: $0) } ?? AnswerDetails()).keeping(answers)
        self.selectedRule = defaults.string(forKey: Keys.rule)
        var saved = defaults.data(forKey: Keys.savedWallets).flatMap { try? JSONDecoder().decode([SavedWallet].self, from: $0) } ?? []
        // From before there was a list, the wallet being shown is all there is to remember.
        if let address, address != WalletAddress.demo, !saved.contains(where: { $0.address == address }) {
            saved.append(SavedWallet(address: address, lastSeen: now()))
        }
        self.savedWallets = saved
        self.walletOrder = defaults.stringArray(forKey: Keys.walletOrder) ?? []
        self.hiddenWallets = defaults.stringArray(forKey: Keys.hiddenWallets) ?? []
        self.feed = address == nil ? .noWallet : .reading
        if address != nil { readingSince = now() }
        self.source = makeSource(serverURL)
        self.cache = PortfolioCache(directory: cacheDirectory, now: now())
        if address != nil { portfolio = lastKnown() }
    }

    /// Reads now, with the numbers on screen marked as on their way, because someone asked and should see it happen.
    public func refresh() {
        if address != nil { feed = .reading }
        start()
    }

    /// Starts following, or starts over, say after a change.
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

    public func stop() {
        rateTask?.cancel()
        rateTask = nil
        pollTask?.cancel()
        pollTask = nil
        readCount += 1
        readingSince = nil
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
            saveHidden(hiddenWallets.filter { $0 != next })
        }
        // In the same moment as the address, so one wallet's numbers are never on screen under another.
        portfolio = lastKnown()
        updatedAt = nil
        feed = next == nil ? .noWallet : .reading
        wantsLastRead = true
        start()
    }

    /// Keeps it in the list under this name, or makes it a recent one again with an empty name.
    public func renameWallet(_ address: String, to name: String) {
        let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
        var next = savedWallets
        if let index = next.firstIndex(where: { $0.address == address }) {
            next[index].name = clean.isEmpty ? nil : clean
            if clean.isEmpty { next[index].isKept = nil }
        } else if !clean.isEmpty {
            next.append(SavedWallet(address: address, name: clean, lastSeen: now()))
        }
        saveWallets(next)
    }

    /// Takes it off the list, and shows `next` if it was the one showing. Saying it's the user's goes with it, but an account this Mac's wallet
    /// holds stays theirs, so that one is only hidden.
    public func removeWallet(_ address: String, showing next: String?) {
        if linkedWallets.contains(address) {
            saveHidden(hiddenWallets + [address])
        } else if book.senders[address]?.kind == .mine {
            var answers = book
            answers.senders[address] = nil
            setBook(answers, action: "Remove from List")
        }
        saveWallets(savedWallets.filter { $0.address != address })
        saveOrder(walletOrder.filter { $0 != address })
        cache.forget(address)
        if self.address == address { setWallet(next) }
    }

    /// The user says it's theirs, which is what answering "My wallet" says: from now on costs follow money between it and their other wallets.
    /// This is only ever about costs. It can't sign, and it isn't a savings wallet, which takes the device check.
    public func moveToYours(_ address: String) {
        setBook(book.answering(address, .mine, focus: nil), action: "Move to Yours")
    }

    /// It's not the user's after all, so costs stop following its money. It stays listed under Watching, so a slip is easy to put right.
    public func moveToWatching(_ address: String) {
        var answers = book
        answers.senders[address] = nil
        setBook(answers, action: "Move to Watching")
        keepWallet(address)
    }

    /// Stays under Watching, instead of falling off the list once enough others have been looked at.
    public func keepWallet(_ address: String) {
        var next = SavedWallet.seeing(address, at: now(), in: savedWallets, own: book.linkedWallets)
        if let index = next.firstIndex(where: { $0.address == address }) { next[index].isKept = true }
        saveWallets(next)
    }

    /// `addresses` is a section as it's listed. Each section keeps its own order, so one moving doesn't disturb another.
    public func moveWallets(in addresses: [String], from source: IndexSet, to destination: Int) {
        let moved = source.map { addresses[$0] }
        var arranged = addresses.filter { !moved.contains($0) }
        arranged.insert(contentsOf: moved, at: destination - source.count { $0 < destination })
        saveOrder(walletOrder.filter { !addresses.contains($0) } + arranged)
    }

    /// Makes a change to one wallet, and returns what Undo needs to take back that change and nothing else. It's one step in Edit's history,
    /// called `name`, whatever it did to the answers: a watched wallet's removal or an account's unlinking changes none. Edit's Undo takes back
    /// the same, with `alsoUndo` for what's outside the store, and Redo makes the change again.
    @discardableResult
    public func changeWallet(_ address: String, name: String, alsoUndo: (() -> Void)? = nil, _ change: @escaping () -> Void) -> WalletListSnapshot {
        var snapshot = WalletListSnapshot(
            address: address,
            answer: answers.senders[address],
            undoDepth: undoStack.count,
            saved: savedWallets.first { $0.address == address },
            orderIndex: walletOrder.firstIndex(of: address),
            wasHidden: hiddenWallets.contains(address),
            wasShowing: self.address == address
        )
        let entriesBefore = Set(history.map(\.id))
        let bookBefore = answers
        let detailsBefore = answerDetails
        change()
        snapshot.changedAnswer = answers.senders[address]
        // An answer the change gave is part of it, so it's this entry and not one of its own.
        history.removeAll { !entriesBefore.contains($0.id) }
        let id = UUID()
        snapshot.undoEntry = id
        history.append(HistoryEntry(id: id, name: name, book: bookBefore, details: detailsBefore, wallet: WalletStep(snapshot: snapshot, change: change, alsoUndo: alsoUndo)))
        future = []
        return snapshot
    }

    /// Takes back one change to one wallet. Whatever else has changed since stays changed, and so does anything said about this wallet since.
    public func restore(_ snapshot: WalletListSnapshot) {
        putBack(snapshot)
        // What Undo took back may have the change in it or not, so Redo can't know what it would bring back.
        future = []
    }

    private func putBack(_ snapshot: WalletListSnapshot) {
        let address = snapshot.address
        let isUnchanged = { (book: Book) in book.senders[address] == snapshot.changedAnswer }
        let before = snapshot.undoEntry.flatMap { entry in history.first { $0.id == entry }?.details }
        if isUnchanged(answers), answers.senders[address] != snapshot.answer {
            var next = answers
            next.senders[address] = snapshot.answer
            // The wallet's answer goes back to what it was, date included, and every other answer keeps its own.
            var details = answerDetails
            if let before {
                for id in Set(([answers, next]).flatMap(\.answerEntries).filter { $0.isAbout(address) }.map(\.id)) { details.restore(id, from: before) }
            }
            store(next, details: details)
        }
        // The change's own entry goes with it, wherever it is now.
        var since = snapshot.undoDepth
        if let entry = snapshot.undoEntry, let index = history.firstIndex(where: { $0.id == entry }) {
            history.remove(at: index)
            since = index
        }
        // What was saved for Undo since then has the change in it. Undoing something else mustn't bring it back, or its date.
        for index in history.indices where index >= since && isUnchanged(history[index].book) {
            let ids = history[index].book.answerEntries.filter { $0.isAbout(address) }.map(\.id)
            history[index].book.senders[address] = snapshot.answer
            if let before {
                for id in ids + history[index].book.answerEntries.filter({ $0.isAbout(address) }).map(\.id) { history[index].details.restore(id, from: before) }
            }
        }
        var wallets = savedWallets
        if let index = wallets.firstIndex(where: { $0.address == address }) {
            // A name given since is the user's latest word on it. Without one, an entry the change made goes with the change.
            wallets[index].isKept = snapshot.saved?.isKept
            if snapshot.saved == nil, wallets[index].name == nil { wallets.remove(at: index) }
        } else if let saved = snapshot.saved {
            wallets.append(saved)
        }
        saveWallets(wallets)
        if let index = snapshot.orderIndex, !walletOrder.contains(address) {
            var order = walletOrder
            order.insert(address, at: min(index, order.count))
            saveOrder(order)
        }
        saveHidden(hiddenWallets.filter { $0 != address } + (snapshot.wasHidden ? [address] : []))
        if snapshot.wasShowing { setWallet(address) }
    }

    private func saveDetails() {
        defaults.set(try? JSONEncoder().encode(answerDetails), forKey: Keys.answerDetails)
    }

    private func saveWallets(_ wallets: [SavedWallet]) {
        savedWallets = wallets
        defaults.set(try? JSONEncoder().encode(wallets), forKey: Keys.savedWallets)
    }

    private func saveOrder(_ order: [String]) {
        walletOrder = order
        defaults.set(order, forKey: Keys.walletOrder)
    }

    private func saveHidden(_ hidden: [String]) {
        hiddenWallets = hidden
        defaults.set(hidden, forKey: Keys.hiddenWallets)
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
        settingsChanged()
    }

    public func setLinkedWallets(_ wallets: [String]) {
        let next = wallets.map { $0.lowercased() }
        guard next != linkedWallets else { return }
        linkedWallets = next
        if address != nil, pollTask != nil { answersChanged() }
    }

    /// The answers, with the accounts in this wallet as `mine`. Nobody's asked about those, so there's nothing to undo or save, and
    /// one that's removed is simply gone, or a mistyped savings wallet would stay linked.
    public var book: Book {
        answers.linking(linkedWallets)
    }

    /// Whether there's anything of the user's own to forget.
    public var hasAnswers: Bool {
        !answerEntries.isEmpty
    }

    /// What the user has said, newest first. Accounts this Mac knows are theirs aren't answers, so they aren't here, even if something was said
    /// about one before it was an account.
    public var answerEntries: [AnswerEntry] {
        answers.answerEntries
            .filter { entry in
                switch entry.said {
                case .sender(let address, _), .exchangeCost(let address, _, _): !linkedWallets.contains(address)
                case .cost, .imported: true
                }
            }
            .sorted { (answeredAt($0) ?? .distantPast) > (answeredAt($1) ?? .distantPast) }
    }

    /// nil for one given before answers had dates.
    public func answeredAt(_ entry: AnswerEntry) -> Date? {
        answerDetails.dates[entry.id]
    }

    public func about(_ entry: AnswerEntry) -> String? {
        about(id: entry.id)
    }

    public func about(id: String) -> String? {
        answerDetails.about[id]
    }

    /// Takes back one answer, wherever it is in the list, so its question comes back. Undo brings it back.
    public func removeAnswer(_ entry: AnswerEntry) {
        setBook(answers.removing(entry), action: "Remove Answer")
    }

    /// A different answer about who a sender is.
    public func changeAnswer(_ entry: AnswerEntry, to kind: SenderAnswer.Kind) {
        guard case .sender(let address, _) = entry.said else { return }
        setBook(answers.changing(address, to: kind), action: "Change Answer")
    }

    /// A different amount for what was paid, in the currency it was given in.
    public func changeCost(_ entry: AnswerEntry, to micros: String) {
        setBook(answers.changingCost(of: entry, to: micros), action: "Change Answer")
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
        settingsChanged()
    }

    /// Only the menu bar changes, so there's nothing to read again.
    public func setMenuBarShows(_ shows: MenuBarShows) {
        menuBarShows = shows
        defaults.set(shows.rawValue, forKey: Keys.menuBar)
    }

    public func setRule(_ id: String) {
        guard id != (selectedRule ?? rules.first?.id) else { return }
        selectedRule = id
        defaults.set(id, forKey: Keys.rule)
        settingsChanged()
    }

    /// The numbers for these settings if they've been read before. If not, the ones on screen stay until the new ones arrive.
    private func settingsChanged() {
        if let known = lastKnown() { portfolio = known }
        answersChanged()
    }

    /// The numbers on screen aren't what they'd be now, so they can't be called live, and the next ones are on their way.
    private func answersChanged() {
        if address != nil { feed = .reading }
        wantsLastRead = true
        start()
    }

    /// What this wallet last showed on this server, by these settings if it can be.
    private func lastKnown() -> Portfolio? {
        guard let address else { return nil }
        return cache.last(of: address, on: serverURL, preferring: isForCurrentSettings)
    }

    /// Whether these numbers answer what's being asked now. With no rule chosen, it's the server's first, and with no list of rules yet, there's no telling.
    private func isForCurrentSettings(_ portfolio: Portfolio) -> Bool {
        guard portfolio.method == method, portfolio.currency == currency else { return false }
        guard let rule = selectedRule ?? rules.first?.id else { return true }
        return portfolio.rule == rule
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
            settingsChanged()
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
        // Another server's numbers can be different facts, so these aren't kept even for a moment. What's known is this server's own.
        portfolio = lastKnown()
        currentRate = nil
        updatedAt = nil
        answersChanged()
    }

    /// Takes effect right away, and the numbers follow as soon as the server has folded them. Undo goes back to what this replaced,
    /// and the Edit menu calls it `action`. Each answer this says something new for is dated now. `about` is what a question was about, in its own words, by answer.
    public func setBook(_ next: Book, about: [String: String] = [:], action: String = "Answer") {
        let nextAnswers = answers(in: next)
        guard nextAnswers != answers else { return }
        let given = answers.answerEntries
        var details = answerDetails
        for entry in nextAnswers.answerEntries where !given.contains(where: { $0.id == entry.id && $0.says(entry) }) { details.dates[entry.id] = now() }
        details.about.merge(about) { _, new in new }
        history.append(HistoryEntry(id: UUID(), name: action, book: answers, details: answerDetails))
        future = []
        store(nextAnswers, details: details)
    }

    /// What a provider says, and not an answer, so there's nothing to undo, and undoing an answer doesn't lose it.
    public func recordPurchase(_ purchase: Purchase) {
        let next = answers.recording(purchase)
        guard next != answers else { return }
        for index in history.indices { history[index].book = history[index].book.recording(purchase) }
        for index in future.indices { future[index].book = future[index].book.recording(purchase) }
        store(next)
    }

    public func undo() {
        guard var entry = history.last else { return }
        let detailsBefore = entry.details
        entry.details = answerDetails
        if let wallet = entry.wallet {
            // All of it, as the wallet list's own Undo does: its name, its place in the list, and whether it was showing.
            wallet.alsoUndo?()
            putBack(wallet.snapshot)
        } else {
            history.removeLast()
            let previous = entry.book
            entry.book = answers
            store(previous, details: detailsBefore)
        }
        future.append(entry)
    }

    public func redo() {
        guard let entry = future.popLast() else { return }
        if let wallet = entry.wallet {
            // Making it again clears what's left to redo, which is still there to redo after it.
            let rest = future
            changeWallet(wallet.snapshot.address, name: entry.name, alsoUndo: wallet.alsoUndo, wallet.change)
            future = rest
            // The same change as before, so the wallet list's Undo, which knows it by its first snapshot, still finds it.
            if let last = history.popLast() {
                var step = last.wallet
                step?.snapshot.undoEntry = entry.id
                history.append(HistoryEntry(id: entry.id, name: last.name, book: last.book, details: last.details, wallet: step))
            }
            // The same answer as before too, so it keeps the date it had, not today's.
            var details = answerDetails
            for answer in answers.answerEntries where answer.isAbout(wallet.snapshot.address) { details.restore(answer.id, from: entry.details) }
            if details != answerDetails {
                answerDetails = details
                saveDetails()
            }
        } else {
            history.append(HistoryEntry(id: entry.id, name: entry.name, book: answers, details: answerDetails))
            store(entry.book, details: entry.details)
        }
    }

    /// `details` goes with `next`, or what's there now stays for whatever `next` still says.
    private func store(_ next: Book, details: AnswerDetails? = nil) {
        answers = next
        defaults.set(try? JSONEncoder().encode(next), forKey: Keys.book)
        answerDetails = (details ?? answerDetails).keeping(next)
        saveDetails()
        answersChanged()
    }

    /// A book built on `book` has the accounts in it, and they aren't answers. What was said about one before it was an account stays.
    /// Purchases aren't answers either, and an order that's finished isn't read again, so only `recordPurchase` changes them.
    private func answers(in next: Book) -> Book {
        var kept = next.unlinking(linkedWallets)
        kept.purchases = answers.purchases
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
        setBook(next, action: "Import")
        return imported
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
        readCount += 1
        let thisRead = readCount
        readingSince = now()
        defer { if thisRead == readCount { readingSince = nil } }
        let method = self.method
        let currency = self.currency
        let rule = selectedRule
        let serverURL = self.serverURL
        let book = self.book
        let linked = linked(for: address)
        // An answer that arrives after a change is about something else, whatever it says.
        let isCurrent = { [self] in !Task.isCancelled && address == self.address && method == self.method && currency == self.currency && rule == self.selectedRule && serverURL == self.serverURL && book == self.book && linked == self.linked(for: address) }
        if wantsLastRead {
            wantsLastRead = false
            // Comes straight back when the server has read this wallet, so a change of method or an answer doesn't wait on the chain. It's no help if it can't.
            let last = try? await source.lastRead(address: address, method: method, currency: currency, rule: rule, linked: linked, book: bookToSend(book, for: address))
            guard isCurrent() else { return .zero }
            if let last, shouldShow(last) {
                portfolio = last
                cache.remember(last, of: address, on: serverURL, at: now())
            }
        }
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
            cache.remember(next, of: address, on: serverURL, at: now())
            feed = state(of: next)
            expireLive()
            return reachableDelay
        } catch {
            guard isCurrent(), !(error is CancellationError) else { return .zero }
            // Numbers by another method or rule, or in another currency, are wrong now, not just old, and there's no way to get the right ones.
            if let portfolio, !isForCurrentSettings(portfolio) { self.portfolio = nil }
            feed = state(of: error)
            return feed == .serverUnreachable ? unreachableDelay : reachableDelay
        }
    }

    /// Not when it's behind numbers on screen that answer the same question, as it can be after a reorg or if the app has seen further.
    private func shouldShow(_ last: Portfolio) -> Bool {
        guard let portfolio, isForCurrentSettings(portfolio) else { return true }
        return last.latest.blockNum >= portfolio.latest.blockNum
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
            guard timeout < Self.firstReadTimeout else { throw ReadTooSlow() }
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
        if error is ReadTooSlow { return .tooSlow }
        return switch error as? FetchError {
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
        static let menuBar = "menuBarShows"
        static let server = "serverURL"
        static let book = "answers"
        static let answerDetails = "answerDetails"
        static let rule = "pricingRule"
        static let savedWallets = "savedWallets"
        static let walletOrder = "walletOrder"
        static let hiddenWallets = "hiddenWallets"
        static let holdingsSort = "holdingsSort"
    }
}

private struct ReadTooSlow: Error {}

private struct CurrentRate {
    let currency: CurrencyCode
    let micros: String
    let readAt: Date
}
