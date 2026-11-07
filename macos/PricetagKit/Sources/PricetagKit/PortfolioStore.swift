// What the app asks of a wallet, and the one place the app asks it: the wallet, its settings and its server live here, and the live feed,
// the answers and their history, the saved list and the current rate each have a type of their own, which this puts together.

import Foundation
import Observation

/// One number's explanation, in full context, because the same number means something else on another wallet, method or server.
public struct ExplanationRequest: Hashable, Sendable {
    public let target: ExplainTarget
    public let read: ReadContext
    /// All Yours' wallets in the numbers on screen, which the explanation can't leave out.
    public let shown: [String]?
    public let serverURL: URL
}

/// Whether anything answers at the server's address, whichever wallet is showing, and even with none.
public enum ServerCheck: Equatable, Sendable {
    case checking, answers, unreachable
}

@MainActor
@Observable
public final class PortfolioStore {
    /// The server `pnpm mac` runs on this Mac.
    nonisolated public static let localServerURL = URL(string: "http://127.0.0.1:8787")!
    /// Patina's own server when the build names one, in `PATINA_SERVER_HOST`, and otherwise the one on this Mac.
    nonisolated public static let defaultServerURL = hostedServerURL(host: Bundle.main.object(forInfoDictionaryKey: "PatinaServerHost") as? String) ?? localServerURL

    /// Only ever over HTTPS, since it's someone else's machine. Nil for a build that doesn't name one.
    nonisolated public static func hostedServerURL(host: String?) -> URL? {
        guard let host = host?.trimmingCharacters(in: .whitespaces), !host.isEmpty, host.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" }) else { return nil }
        return URL(string: "https://\(host)")
    }
    /// As long as a read of a wallet the server hasn't read yet can take.
    nonisolated static let firstReadTimeout: Duration = .seconds(180)

    @ObservationIgnored private let feedLoop: FeedLoop
    @ObservationIgnored private let answerHistory: AnswerHistory
    @ObservationIgnored private let walletList: SavedWalletList
    @ObservationIgnored private let rates: RateReader

    /// What the store holds, which may not be current: read `feed` before calling it live. See `FeedLoop`.
    public var portfolio: Portfolio? { feedLoop.portfolio }
    /// Goes up each time `portfolio` is replaced, however that happens, so whatever's worked out from `portfolio` keys on this.
    public var portfolioRevision: Int { feedLoop.portfolioRevision }
    public var feed: FeedState { feedLoop.feed }
    /// Whether what's wrong has been worth saying beyond the status.
    public var isProblemLong: Bool { feedLoop.isProblemLong }
    /// What was wrong when someone asked to try again. It stands until that read answers.
    public var retriedProblem: FeedState? { feedLoop.retriedProblem }
    /// When the read that's running now started, so a long one can say how long it's been. nil between reads.
    public var readingSince: Date? { feedLoop.readingSince }
    /// Whether the read that's running has gone on for `longReadSeconds`, so it's worth saying more than that it's running.
    public var isReadLong: Bool { feedLoop.isReadLong }
    public var updatedAt: Date? { feedLoop.updatedAt }
    public private(set) var address: String?
    public private(set) var method: CostMethod
    public private(set) var currency: CurrencyCode
    /// How the holdings are ordered. It's the same for every wallet, and it's remembered.
    public var holdingsSort: HoldingsSort {
        didSet { defaults.set(holdingsSort.rawValue, forKey: StoreKeys.holdingsSort) }
    }
    public private(set) var menuBarShows: MenuBarShows
    public private(set) var serverURL: URL
    /// What the server at `serverURL` knows this person by, or nil. Each invite belongs to the server it was given for, so it never
    /// follows the user to another one, and it's only sent over HTTPS.
    public private(set) var invite: String?
    /// The server at `serverURL` answered that it needs an invite, and hasn't taken one since.
    public internal(set) var needsInvite = false
    /// What the last question to the server found, for when there's no wallet being read to say so.
    public private(set) var serverCheck = ServerCheck.checking
    /// They said not now, so nothing asks again until they give an invite or move to another server.
    private var isInviteDeclined = false
    /// Whether to ask for an invite now. Giving one stops asking until the server answers, and if it's refused, this asks again.
    public var asksForInvite: Bool { needsInvite && !isInviteDeclined }
    /// When each answer was given and what it was about, for the list of answers. Never sent anywhere.
    public var answerDetails: AnswerDetails { answerHistory.details }
    public var undoStack: [Book] { answerHistory.undoStack }
    /// What each entry of `undoStack` takes back, in a menu's words, as in "Undo Answer".
    public var undoNames: [String] { answerHistory.undoNames }
    public var redoStack: [Book] { answerHistory.redoStack }
    public var redoNames: [String] { answerHistory.redoNames }
    /// The server's pricing rules. Empty when it has only one, so there's nothing to choose.
    public private(set) var rules: [PricingRule] = []
    /// What to ask the server for, or nil for its default.
    public private(set) var selectedRule: String?
    /// The user's own wallets. Transfers between them carry their cost, and aren't new purchases.
    public private(set) var linkedWallets: [String] = []
    /// Wallets the user has looked at, for the switcher. Addresses and names only.
    public var savedWallets: [SavedWallet] { walletList.saved }
    /// How the user arranged the list.
    public var walletOrder: [String] { walletList.order }
    /// Taken off the list, but still the user's, so costs keep following their money.
    public var hiddenWallets: [String] { walletList.hidden }

    @ObservationIgnored private(set) var source: any PortfolioSource {
        didSet {
            sourceChanges += 1
            rulesRetry?.cancel()
            rulesRetry = nil
            rulesFailureRetry?.cancel()
            rulesFailureRetry = nil
            rulesRead = nil
            rates.sourceChanged()
        }
    }
    /// How many times `source` has been replaced, so an answer from an earlier one can tell.
    @ObservationIgnored private(set) var sourceChanges = 0
    /// Asks for the rules again once the server has room. While it's there, nobody else asks.
    @ObservationIgnored private var rulesRetry: Task<Void, Never>?
    /// Asks for the rules again after a read that failed, so a server that comes up later still gets its rules read. Anyone can ask before then.
    @ObservationIgnored private var rulesFailureRetry: Task<Void, Never>?
    @ObservationIgnored private let rulesRetryDelay: Duration
    /// The read of the rules that's under way, which anyone else asking joins, so one answer settles it.
    @ObservationIgnored private var rulesRead: Task<Void, Never>?
    /// Nil reads the server with the invite.
    @ObservationIgnored private let customSource: (@Sendable (URL) -> any PortfolioSource)?
    public private(set) var hasUnreadableSaved: Bool
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let now: @Sendable () -> Date

    public init(
        defaults: UserDefaults = .standard,
        /// Where each wallet's last numbers stay across launches, or nil to keep them only in memory.
        cacheDirectory: URL? = nil,
        /// Nil reads the server with its invite in `defaults`.
        makeSource: (@Sendable (URL) -> any PortfolioSource)? = nil,
        now: @escaping @Sendable () -> Date = { Date() },
        reachableDelay: Duration = .seconds(2),
        unreachableDelay: Duration = .seconds(5),
        pushedDelay: Duration = .seconds(15),
        // The longest wait for a block, plus as long as a read gets before it's marked as on its way anyway.
        liveFor: Duration = .seconds(30),
        rateRetryDelay: Duration = .seconds(30),
        rulesRetryDelay: Duration = .seconds(15),
        longProblem: Duration = .seconds(60)
    ) {
        self.rulesRetryDelay = rulesRetryDelay
        self.defaults = defaults
        self.customSource = makeSource
        self.now = now
        let address = defaults.string(forKey: StoreKeys.wallet)
        let serverURL = defaults.string(forKey: StoreKeys.server).flatMap(URL.init(string:)) ?? Self.defaultServerURL
        self.address = address
        self.method = defaults.string(forKey: StoreKeys.method).flatMap(CostMethod.init(rawValue:)).flatMap { CostMethod.portfolio.contains($0) ? $0 : nil } ?? .average
        self.currency = defaults.string(forKey: StoreKeys.currency).flatMap(CurrencyCode.init(rawValue:)) ?? .USD
        self.holdingsSort = defaults.string(forKey: StoreKeys.holdingsSort).flatMap(HoldingsSort.init(rawValue:)) ?? .largestFirst
        self.menuBarShows = defaults.string(forKey: StoreKeys.menuBar).flatMap(MenuBarShows.init(rawValue:)) ?? .value
        self.serverURL = serverURL
        let invite = Self.invites(in: defaults)[Self.origin(of: serverURL)]
        self.invite = invite
        answerHistory = AnswerHistory(defaults: defaults, now: now)
        self.selectedRule = defaults.string(forKey: StoreKeys.rule)
        walletList = SavedWalletList(defaults: defaults, showing: address, now: now())
        self.hasUnreadableSaved = SetAside.hasUnseen(in: defaults)
        self.source = makeSource?(serverURL) ?? PricetagClient(serverURL: serverURL, invite: invite)
        feedLoop = FeedLoop(hasWallet: address != nil, cacheDirectory: cacheDirectory, now: now, reachableDelay: reachableDelay, unreachableDelay: unreachableDelay, pushedDelay: pushedDelay, liveFor: liveFor, longProblem: longProblem)
        rates = RateReader(retryDelay: rateRetryDelay, now: now)
        feedLoop.store = self
        rates.store = self
        answerHistory.onChange = { [weak self] in self?.answersChanged() }
        walletList.onHiddenChange = { [weak self] in
            // All Yours is every wallet that's listed, so it's something else now.
            guard let self, WalletAddress.isAllYours(self.address), feedLoop.isRunning else { return }
            answersChanged()
        }
        feedLoop.showLastKnown()
    }

    /// Reads now, with the numbers on screen marked as on their way, because someone asked and should see it happen.
    public func refresh() {
        feedLoop.markRetried()
        start()
    }

    /// Starts following, or starts over, say after a change.
    public func start() {
        stop()
        Task { await refreshRules() }
        rates.start()
        feedLoop.start()
    }

    public func stop() {
        rates.stop()
        rulesFailureRetry?.cancel()
        rulesFailureRetry = nil
        feedLoop.stop()
    }

    /// `address` is 0x… or `WalletAddress.demo`, or nil to forget the wallet.
    public func setWallet(_ address: String?) {
        let next = address?.lowercased()
        guard next != self.address else { return }
        self.address = next
        defaults.set(next, forKey: StoreKeys.wallet)
        if let next, next != WalletAddress.demo, !WalletAddress.isAllYours(next) {
            walletList.see(next, at: now(), own: book.linkedWallets)
        }
        feedLoop.walletChanged()
        start()
    }

    /// Keeps it in the list under this name, or makes it a recent one again with an empty name.
    public func renameWallet(_ address: String, to name: String) {
        walletList.rename(address, to: name, at: now())
    }

    /// Takes it off the list, and shows `next` if it was the one showing. Saying it's the user's goes with it, but an account this Mac's wallet
    /// holds stays theirs, so that one is only hidden.
    public func removeWallet(_ address: String, showing next: String?) {
        if linkedWallets.contains(address) {
            walletList.hide(address)
        } else if book.senders[address]?.kind == .mine {
            var answers = book
            answers.senders[address] = nil
            setBook(answers, action: "Remove from List")
        }
        walletList.remove(address)
        feedLoop.forget(address)
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
        walletList.keep(address, at: now(), own: book.linkedWallets)
    }

    /// `addresses` is a section as it's listed. Each section keeps its own order, so one moving doesn't disturb another.
    public func moveWallets(in addresses: [String], from source: IndexSet, to destination: Int) {
        walletList.move(in: addresses, from: source, to: destination)
    }

    /// Makes a change to one wallet, and returns what Undo needs to take back that change and nothing else. It's one step in Edit's history,
    /// called `name`, whatever it did to the answers: a watched wallet's removal or an account's unlinking changes none. Edit's Undo takes back
    /// the same, with `alsoUndo` for what's outside the store, and Redo makes the change again.
    @discardableResult
    public func changeWallet(_ address: String, name: String, alsoUndo: (() -> Void)? = nil, _ change: @escaping () -> Void) -> WalletListSnapshot {
        answerHistory.recording(
            WalletListSnapshot(
                address: address,
                answer: answers.senders[address],
                undoDepth: undoStack.count,
                saved: savedWallets.first { $0.address == address },
                orderIndex: walletOrder.firstIndex(of: address),
                wasHidden: hiddenWallets.contains(address),
                wasShowing: self.address == address
            ),
            name: name,
            alsoUndo: alsoUndo,
            change: change
        )
    }

    /// Takes back one change to one wallet. Whatever else has changed since stays changed, and so does anything said about this wallet since.
    public func restore(_ snapshot: WalletListSnapshot) {
        putBack(snapshot)
        answerHistory.clearRedo()
    }

    /// Whether the change is the last thing done, with nothing undone since. Only then can the wallet list still talk about it, and take it back without costing Redo anything.
    public func isLatestChange(_ snapshot: WalletListSnapshot) -> Bool {
        answerHistory.isLatest(snapshot)
    }

    private func putBack(_ snapshot: WalletListSnapshot) {
        answerHistory.putBack(snapshot)
        walletList.putBack(snapshot)
        if snapshot.wasShowing { setWallet(snapshot.address) }
    }

    /// Whether something saved here couldn't be read, and nobody's been told yet.
    func refreshUnreadableSaved() {
        hasUnreadableSaved = SetAside.hasUnseen(in: defaults)
    }

    public func dismissUnreadableSaved() {
        SetAside.markSeen(in: defaults)
        hasUnreadableSaved = false
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
        defaults.set(method.rawValue, forKey: StoreKeys.method)
        settingsChanged()
    }

    public func setLinkedWallets(_ wallets: [String]) {
        let next = wallets.map { $0.lowercased() }
        guard next != linkedWallets else { return }
        linkedWallets = next
        if address != nil, feedLoop.isRunning { answersChanged() }
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
        MoneyDisplay(main: currency, rateMicros: rates.currentRate?.currency == currency ? rates.currentRate?.micros : nil)
    }

    /// Reads the current rate. True when the server answered, so a read that failed can be tried again sooner.
    @discardableResult
    public func readRate() async -> Bool {
        await rates.readRate()
    }

    public func setCurrency(_ currency: CurrencyCode) {
        guard currency != self.currency else { return }
        self.currency = currency
        defaults.set(currency.rawValue, forKey: StoreKeys.currency)
        settingsChanged()
    }

    /// Only the menu bar changes, so there's nothing to read again.
    public func setMenuBarShows(_ shows: MenuBarShows) {
        menuBarShows = shows
        defaults.set(shows.rawValue, forKey: StoreKeys.menuBar)
    }

    public func setRule(_ id: String) {
        guard id != (selectedRule ?? rules.first?.id) else { return }
        selectedRule = id
        defaults.set(id, forKey: StoreKeys.rule)
        settingsChanged()
    }

    /// The numbers for these settings if they've been read before. If not, the ones on screen stay until the new ones arrive.
    private func settingsChanged() {
        feedLoop.settingsChanged()
        answersChanged()
    }

    /// Who an invite is for: the scheme, host and port, which is what a browser would call the same site.
    nonisolated public static func origin(of url: URL) -> String {
        "\(url.scheme?.lowercased() ?? "")://\(url.host()?.lowercased() ?? "")\(url.port.map { ":\($0)" } ?? "")"
    }

    private static func invites(in defaults: UserDefaults) -> [String: String] {
        defaults.dictionary(forKey: StoreKeys.invites) as? [String: String] ?? [:]
    }

    private func makeSource(_ url: URL) -> any PortfolioSource {
        customSource?(url) ?? PricetagClient(serverURL: url, invite: Self.invites(in: defaults)[Self.origin(of: url)])
    }

    /// The numbers on screen aren't what they'd be now, so they can't be called live, and the next ones are on their way.
    private func answersChanged() {
        feedLoop.markChanged()
        start()
    }

    /// Whether these numbers answer what's being asked now. With no rule chosen, it's the server's first, and with no list of rules yet, there's no telling.
    func isForCurrentSettings(_ portfolio: Portfolio) -> Bool {
        guard portfolio.method == method, portfolio.currency == currency else { return false }
        guard let rule = selectedRule ?? rules.first?.id else { return true }
        return portfolio.rule == rule
    }

    /// The rule the numbers on screen were read through, when it isn't the server's default, so they can say so.
    public var activeRuleName: String? {
        guard let id = portfolio?.rule, id != rules.first?.id else { return nil }
        return rules.first { $0.id == id }?.name
    }

    /// Asks the server what rules it has, and again when it says to wait. A rule it doesn't have would fail every read, so that choice goes.
    public func refreshRules() async {
        guard rulesRetry == nil else {
            // A retry only waits on a server that answered, and a new source cancels it.
            serverCheck = .answers
            return
        }
        if let rulesRead { return await rulesRead.value }
        let source = self.source
        let asked = sourceChanges
        let read = Task<Void, Never> { [weak self] in await self?.readRules(from: source, asked: asked) }
        rulesRead = read
        await read.value
    }

    private func readRules(from source: any PortfolioSource, asked: Int) async {
        defer { if asked == sourceChanges { rulesRead = nil } }
        let next: [PricingRule]
        do {
            next = try await source.rules()
        } catch {
            // An answer to an invite that's since been replaced says nothing about the new one.
            guard asked == sourceChanges else { return }
            serverCheck = error as? FetchError == .unreachable || error as? FetchError == .timedOut ? .unreachable : .answers
            if case .needsInvite = error as? FetchError { needsInvite = true }
            if case .rateLimited(_, let retryAfter) = error as? FetchError {
                // Owned by the store, so closing Settings doesn't leave the list out of date.
                rulesRetry = Task { [weak self] in
                    try? await Task.sleep(for: .seconds(retryAfter))
                    guard !Task.isCancelled, let self else { return }
                    self.rulesRetry = nil
                    await self.refreshRules()
                }
            } else if !(error is CancellationError), !needsInvite {
                // Giving an invite asks again by itself, so one that's needed has nothing to wait for here.
                rulesFailureRetry?.cancel()
                rulesFailureRetry = Task { [weak self, rulesRetryDelay] in
                    try? await Task.sleep(for: rulesRetryDelay)
                    guard !Task.isCancelled, let self else { return }
                    self.rulesFailureRetry = nil
                    await self.refreshRules()
                }
            }
            return
        }
        guard asked == sourceChanges else { return }
        rulesFailureRetry?.cancel()
        rulesFailureRetry = nil
        serverCheck = .answers
        needsInvite = false
        rules = next
        if let chosen = selectedRule, !next.contains(where: { $0.id == chosen }) {
            selectedRule = nil
            defaults.removeObject(forKey: StoreKeys.rule)
            settingsChanged()
        }
    }

    public func comparison() async throws -> RuleComparison {
        guard let address else { throw CancellationError() }
        guard !WalletAddress.isAllYours(address) else { throw FetchError.rejected("Rules are compared one wallet at a time.") }
        return try await source.comparison(address: address, method: method, currency: currency, linked: linked(for: address), book: bookToSend(book, for: address))
    }

    /// Asks again, saying so until there's an answer.
    public func checkServer() {
        serverCheck = .checking
        Task { await refreshRules() }
    }

    public func setServerURL(_ url: URL) {
        guard url != serverURL else { return }
        serverURL = url
        defaults.set(url.absoluteString, forKey: StoreKeys.server)
        invite = Self.invites(in: defaults)[Self.origin(of: url)]
        needsInvite = false
        serverCheck = .checking
        isInviteDeclined = false
        source = makeSource(url)
        rules = []
        feedLoop.serverChanged()
        rates.forget()
        answersChanged()
    }

    /// The same server's numbers, so what's on screen stays while it's asked again with the invite.
    public func setInvite(_ value: String?) {
        let value = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        let next = value?.isEmpty == false ? value : nil
        isInviteDeclined = false
        guard next != invite else { return }
        invite = next
        needsInvite = false
        serverCheck = .checking
        var invites = Self.invites(in: defaults)
        invites[Self.origin(of: serverURL)] = next
        defaults.set(invites, forKey: StoreKeys.invites)
        source = makeSource(serverURL)
        rules = []
        answersChanged()
    }

    /// They've changed their mind about Not Now.
    public func askForInvite() {
        isInviteDeclined = false
    }

    /// Not now. It only answers the question being asked, so it can't silence one the server hasn't raised yet.
    public func declineInvite() {
        if needsInvite { isInviteDeclined = true }
    }

    /// Takes effect right away, and the numbers follow as soon as the server has folded them. Undo goes back to what this replaced,
    /// and the Edit menu calls it `action`. Each answer this says something new for is dated now. `about` is what a question was about, in its own words, by answer.
    public func setBook(_ next: Book, about: [String: String] = [:], action: String = "Answer") {
        answerHistory.set(next, linked: linkedWallets, about: about, action: action)
    }

    /// What a provider says, and not an answer, so there's nothing to undo, and undoing an answer doesn't lose it.
    public func recordPurchase(_ purchase: Purchase) {
        answerHistory.record(purchase)
    }

    public func undo() {
        answerHistory.undo(putBack: putBack)
    }

    public func redo() {
        answerHistory.redo { address, name, alsoUndo, change in
            changeWallet(address, name: name, alsoUndo: alsoUndo, change)
        }
    }

    /// What the user has said, without the accounts in `book`.
    private var answers: Book { answerHistory.answers }

    /// What goes along with a read. The demo isn't anyone's, and demo data and real data never mix, so it doesn't get this user's accounts.
    func bookToSend(_ book: Book, for address: String) -> Book {
        WalletAddress.isDemo(address) ? book.unlinking(linkedWallets) : book
    }

    /// What a read of this wallet asks for right now.
    private func readContext(for address: String) -> ReadContext {
        ReadContext(address: address, method: method, currency: currency, rule: selectedRule, linked: linked(for: address), book: bookToSend(book, for: address))
    }

    /// What these answers would do to the headline. Nothing's kept, so asking changes nothing.
    public func previews(of candidates: [Book]) async throws -> [BookPreview] {
        guard let address else { throw FetchError.unreachable }
        return try await source.previews(address: address, method: method, currency: currency, rule: selectedRule, linked: linked(for: address), candidates: candidates.map { bookToSend($0, for: address) })
    }

    /// Every movement as a spreadsheet, marked so an estimate or an unknown can't pass for an exact number.
    public func exportCSV() async throws -> String {
        guard let address else { throw FetchError.unreachable }
        return try await source.exportCSV(readContext(for: address), shown: walletsShown)
    }

    /// Reads an exchange's history, and says how many withdrawals had no usable cost. Nothing's kept until someone vouches for the file.
    public func readCoinbase(csv: String) async throws -> ExchangeImport {
        try await source.importCoinbase(csv: csv)
    }

    /// Adds what a file found to what's on this device.
    public func keepImport(_ imported: ExchangeImport) {
        setBook(book.importing(imported.withdrawals), action: "Import")
    }

    /// nil with no wallet, when there's nothing to explain.
    public func explanationRequest(for target: ExplainTarget) -> ExplanationRequest? {
        address.map { ExplanationRequest(target: target, read: readContext(for: $0), shown: walletsShown, serverURL: serverURL) }
    }

    public func explanation(for request: ExplanationRequest) async throws -> Explanation {
        // A request from before a change has nothing to say about what's on screen now.
        guard request == explanationRequest(for: request.target) else { throw CancellationError() }
        return try await source.explanation(of: request.target, request.read, shown: request.shown)
    }

    /// What can't be left out of an answer about what's on screen. Nil for what's about one wallet, or with nothing on screen.
    private var walletsShown: [String]? {
        portfolio.flatMap { $0.address == address ? $0.walletsInNumbers : nil }
    }

    /// Whether a leg in this wallet belongs to what's on screen.
    private func isShowing(_ address: String) -> Bool {
        address == self.address || (WalletAddress.isAllYours(self.address) && allYoursWallets.contains(address))
    }

    public func proof(leg: String, address: String) async throws -> Proof {
        guard isShowing(address) else { throw CancellationError() }
        return try await source.proof(leg: leg, address: address, currency: currency, rule: selectedRule)
    }

    public func verification(leg: String, address: String) async throws -> Verification {
        guard isShowing(address) else { throw CancellationError() }
        return try await source.verification(leg: leg, address: address, currency: currency, rule: selectedRule)
    }

    public func priceProof(asset: String, price: String, address: String) async throws -> Proof {
        guard isShowing(address) else { throw CancellationError() }
        return try await source.priceProof(asset: asset, price: price, address: address, currency: currency, rule: selectedRule)
    }

    public func priceVerification(asset: String, revision: String?, address: String) async throws -> Verification {
        guard isShowing(address) else { throw CancellationError() }
        return try await source.priceVerification(asset: asset, revision: revision, address: address, currency: currency, rule: selectedRule)
    }

    /// Any wallet's, not just the one showing, since the security page asks about each of them.
    public func approvals(address: String) async throws -> WalletApprovals {
        try await source.approvals(address: address)
    }

    public func taxReport(_ request: TaxReportRequest) async throws -> TaxReport {
        // A request from before a change of server has nothing to say about what's on screen now.
        guard request.serverURL == serverURL else { throw CancellationError() }
        return try await source.taxReport(request)
    }

    public func linked(for address: String) -> [String] {
        // All Yours is read as every wallet it adds up, which are all the user's own.
        if WalletAddress.isAllYours(address) { return allYoursWallets }
        // Costs only carry over onto a wallet that's the user's own. A wallet being watched could be anyone's.
        return linkedWallets.contains(address) ? linkedWallets.filter { $0 != address } : []
    }

    /// What All Yours adds up: every wallet that's the user's and still on the list. The demo's aren't anyone's.
    public var allYoursWallets: [String] {
        book.linkedWallets.filter { !hiddenWallets.contains($0) && !WalletAddress.isDemo($0) }
    }

    /// Where this store reads from, for anything else that needs the same server.
    public var currentSource: any PortfolioSource { source }

    /// One read. Returns how long to wait before the next one.
    func poll() async -> Duration {
        await feedLoop.poll()
    }

    /// Whether this Mac has used the app before, from anything it would have saved by now.
    public nonisolated static func hasBeenUsed(defaults: UserDefaults = .standard) -> Bool {
        [StoreKeys.wallet, StoreKeys.method, StoreKeys.currency, StoreKeys.menuBar, StoreKeys.server, StoreKeys.invites, StoreKeys.book, StoreKeys.answerDetails, StoreKeys.rule, StoreKeys.savedWallets, StoreKeys.walletOrder, StoreKeys.hiddenWallets, StoreKeys.holdingsSort].contains { defaults.object(forKey: $0) != nil }
    }
}

/// Where the store and what it's made of keep things in the settings.
enum StoreKeys {
    static let wallet = "wallet"
    static let method = "method"
    static let currency = "currency"
    static let menuBar = "menuBarShows"
    static let server = "serverURL"
    static let invites = "serverInvites"
    static let book = "answers"
    static let answerDetails = "answerDetails"
    static let rule = "pricingRule"
    static let savedWallets = "savedWallets"
    static let walletOrder = "walletOrder"
    static let hiddenWallets = "hiddenWallets"
    static let holdingsSort = "holdingsSort"
}
