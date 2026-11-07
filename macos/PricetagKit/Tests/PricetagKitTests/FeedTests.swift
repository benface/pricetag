import Foundation
import Testing
@testable import PricetagKit

/// Answers from a script, and remembers what it was asked.
actor ScriptedSource: PortfolioSource {
    var answers: [Result<Portfolio, FetchError>]
    private(set) var methods: [CostMethod] = []
    private(set) var currencies: [CurrencyCode] = []
    private(set) var timeouts: [Duration] = []
    /// What asking for the rules runs into, if anything.
    var rulesFailure: FetchError?

    init(_ answers: [Result<Portfolio, FetchError>], rulesFailure: FetchError? = nil) {
        self.answers = answers
        self.rulesFailure = rulesFailure
    }

    func portfolio(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book, timeout: Duration) async throws -> Portfolio {
        methods.append(method)
        currencies.append(currency)
        timeouts.append(timeout)
        return try answers.removeFirst().get()
    }

    func rules() async throws -> [PricingRule] {
        if let rulesFailure { throw rulesFailure }
        return []
    }

    func explanation(of target: ExplainTarget, address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], shown: [String]?, book: Book) async throws -> Explanation {
        throw FetchError.unreachable
    }

    func taxReport(_ request: TaxReportRequest) async throws -> TaxReport {
        throw FetchError.unreachable
    }

    func proof(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Proof {
        throw FetchError.unreachable
    }

    func verification(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Verification {
        throw FetchError.unreachable
    }
}

/// Holds one read open until it's told how to answer.
actor GatedSource: PortfolioSource {
    private var waiting: CheckedContinuation<Portfolio, any Error>?

    func portfolio(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book, timeout: Duration) async throws -> Portfolio {
        try await withCheckedThrowingContinuation { waiting = $0 }
    }

    func explanation(of target: ExplainTarget, address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], shown: [String]?, book: Book) async throws -> Explanation {
        throw FetchError.unreachable
    }

    func taxReport(_ request: TaxReportRequest) async throws -> TaxReport {
        throw FetchError.unreachable
    }

    func proof(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Proof {
        throw FetchError.unreachable
    }

    func verification(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Verification {
        throw FetchError.unreachable
    }

    /// A failure rather than a test that spins forever, which keeps going even after `swift test` is killed.
    func waitUntilAsked() async {
        let deadline = Date.now.addingTimeInterval(10)
        while waiting == nil {
            guard Date.now < deadline else {
                Issue.record("Nothing asked.")
                return
            }
            try? await Task.sleep(for: .milliseconds(1))
        }
    }

    func answer(_ result: Result<Portfolio, FetchError>) {
        waiting?.resume(with: result.mapError { $0 as any Error })
        waiting = nil
    }
}

/// Answers once, runs out of time once, then holds the next read open until it's told how to answer.
actor TimedOutThenGatedSource: PortfolioSource {
    private var first: Portfolio?
    private var hasTimedOut = false
    private var waiting: CheckedContinuation<Portfolio, any Error>?

    init(first: Portfolio) {
        self.first = first
    }

    func portfolio(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book, timeout: Duration) async throws -> Portfolio {
        if let first {
            self.first = nil
            return first
        }
        if !hasTimedOut {
            hasTimedOut = true
            throw FetchError.timedOut
        }
        return try await withCheckedThrowingContinuation { waiting = $0 }
    }

    func explanation(of target: ExplainTarget, address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], shown: [String]?, book: Book) async throws -> Explanation {
        throw FetchError.unreachable
    }

    /// A failure rather than a test that spins forever, which keeps going even after `swift test` is killed.
    func waitUntilAsked() async {
        let deadline = Date.now.addingTimeInterval(10)
        while waiting == nil {
            guard Date.now < deadline else {
                Issue.record("Nothing asked.")
                return
            }
            try? await Task.sleep(for: .milliseconds(1))
        }
    }

    func answer(_ result: Result<Portfolio, FetchError>) {
        waiting?.resume(with: result.mapError { $0 as any Error })
        waiting = nil
    }
}

/// `demoPortfolio()`, but from a real source, and with its newest block at a given time.
func realPortfolio(at date: Date, status: PnlStatus? = nil, method: CostMethod = .average, currency: CurrencyCode = .USD, progress: ReadProgress? = nil, linkedFailed: [String] = []) throws -> Portfolio {
    var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(demoPortfolio())) as! [String: Any]
    object["mode"] = "raw"
    object["method"] = method.rawValue
    object["currency"] = currency.rawValue
    object["latest"] = ["blockNum": 53_505_400, "timestamp": date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))]
    if !linkedFailed.isEmpty { object["linkedFailed"] = linkedFailed }
    if let status { object["pnlStatus"] = status.rawValue }
    if let progress { object["progress"] = ["started": progress.started, "behindBlocks": progress.behindBlocks] }
    return try JSONDecoder().decode(Portfolio.self, from: JSONSerialization.data(withJSONObject: object))
}

@MainActor
@Suite struct FeedTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    func makeStore(_ answers: [Result<Portfolio, FetchError>], rulesFailure: FetchError? = nil) -> (PortfolioStore, ScriptedSource, UserDefaults) {
        let defaults = UserDefaults(suiteName: "feed-tests-\(UUID().uuidString)")!
        defaults.set("0xabc", forKey: "wallet")
        let source = ScriptedSource(answers, rulesFailure: rulesFailure)
        let now = now
        let store = PortfolioStore(defaults: defaults, makeSource: { _ in source }, now: { now })
        return (store, source, defaults)
    }

    @Test func goesLiveOnAGoodRead() async throws {
        let (store, _, _) = makeStore([.success(try realPortfolio(at: now))])
        #expect(store.feed == .reading)
        await _ = store.poll()
        #expect(store.feed == .live)
        #expect(store.feed.isLive)
    }

    @Test func keepsNumbersButStopsCallingThemLiveWhenTheServerGoes() async throws {
        let (store, _, _) = makeStore([.success(try realPortfolio(at: now)), .failure(.unreachable)])
        await _ = store.poll()
        await _ = store.poll()
        #expect(store.feed == .serverUnreachable)
        #expect(!store.feed.isLive)
        #expect(store.portfolio != nil)
        let notice = try #require(store.feed.staleNotice(serverURL: store.serverURL, portfolio: store.portfolio))
        #expect(notice.contains("aren't updating"))
        #expect(!notice.contains("block"))
    }

    @Test func aBlipOnlyShowsInTheStatusUntilItsGoneOnAWhile() async throws {
        let defaults = UserDefaults(suiteName: "feed-tests-\(UUID().uuidString)")!
        defaults.set("0xabc", forKey: "wallet")
        let now = now
        let source = ScriptedSource([.success(try realPortfolio(at: now)), .failure(.unreachable), .success(try realPortfolio(at: now))])
        let store = PortfolioStore(defaults: defaults, makeSource: { _ in source }, now: { now }, longProblem: .milliseconds(30))
        await _ = store.poll()
        await _ = store.poll()
        #expect(store.feed == .serverUnreachable)
        #expect(store.staleNote == nil)
        #expect(store.statusLines.isEmpty)
        #expect(!store.statusMessages(names: [:]).isEmpty, "A click still says what's wrong.")
        #expect(store.canRetryStatus)
        try await Task.sleep(for: .milliseconds(200))
        #expect(store.staleNote?.contains("aren't updating") == true)
        #expect(store.statusLines.first?.hasPrefix("Last update") == true)
        await _ = store.poll()
        #expect(store.feed.isLive)
        #expect(!store.isProblemLong)
        #expect(store.statusMessages(names: [:]).isEmpty)
    }

    @Test func aRetryKeepsWhatsWrongUntilItAnswers() async throws {
        let defaults = UserDefaults(suiteName: "feed-tests-\(UUID().uuidString)")!
        defaults.set("0xabc", forKey: "wallet")
        let now = now
        let source = ScriptedSource([.success(try realPortfolio(at: now)), .failure(.unreachable), .success(try realPortfolio(at: now))])
        let store = PortfolioStore(defaults: defaults, makeSource: { _ in source }, now: { now }, longProblem: .zero)
        await _ = store.poll()
        await _ = store.poll()
        let said = store.statusMessages(names: [:])
        store.refresh()
        store.stop()
        #expect(store.feed == .reading)
        #expect(store.statusFeed == .serverUnreachable)
        #expect(store.statusMessages(names: [:]) == said)
        #expect(store.hasStatusDetails)
        #expect(store.canRetryStatus)
        #expect(store.statusLines.first?.hasPrefix("Last update") == true)
        await _ = store.poll()
        #expect(store.retriedProblem == nil)
        #expect(!store.hasStatusDetails)
        #expect(store.statusLines.isEmpty)
    }

    @Test func aLongReadSaysHowOldTheNumbersAre() async throws {
        let defaults = UserDefaults(suiteName: "feed-tests-\(UUID().uuidString)")!
        defaults.set("0xabc", forKey: "wallet")
        let gate = TimedOutThenGatedSource(first: try realPortfolio(at: now))
        // As long ago as it takes, so this doesn't wait out the real seconds.
        let store = PortfolioStore(defaults: defaults, makeSource: { _ in gate }, now: { Date().addingTimeInterval(-72) })
        await _ = store.poll()
        #expect(!store.isUpdatingLong)
        let read = Task { await store.poll() }
        await gate.waitUntilAsked()
        #expect(store.feed == .reading)
        #expect(store.isUpdatingLong)
        #expect(store.hasStatusDetails)
        #expect(store.statusLines.first?.hasPrefix("Last update") == true)
        await gate.answer(.success(try realPortfolio(at: now)))
        await _ = read.value
        #expect(!store.isReadLong)
        #expect(!store.hasStatusDetails)
        #expect(store.statusLines.isEmpty)
    }

    @Test func aWalletThatCouldntBeReadIsWhatTheStatusSays() async throws {
        let defaults = UserDefaults(suiteName: "feed-tests-\(UUID().uuidString)")!
        defaults.set("0xabc", forKey: "wallet")
        let now = now
        let source = ScriptedSource([.success(try realPortfolio(at: now, linkedFailed: ["0xdef"])), .failure(.unreachable)])
        let store = PortfolioStore(defaults: defaults, makeSource: { _ in source }, now: { now }, longProblem: .zero)
        await _ = store.poll()
        #expect(store.feed == .live)
        #expect(store.statusWarning == "Couldn't read 1 wallet")
        #expect(store.statusLines.isEmpty, "The status itself says so.")
        await _ = store.poll()
        #expect(store.statusLines.contains("Couldn't read 1 wallet"), "It's still missing while the status says something else.")
    }

    @Test func aProblemThatWontClearByItselfSaysSoAtOnce() {
        #expect(!FeedState.rejected("no").canBeBrief)
        #expect(!FeedState.behind(seconds: 600).canBeBrief)
        #expect(FeedState.serverUnreachable.canBeBrief)
        #expect(FeedState.rateLimited("wait").canBeBrief)
    }

    @Test func knowsWhenAReadStartedUntilItsDone() async throws {
        let clock = TestClock(now)
        let defaults = UserDefaults(suiteName: "feed-tests-\(UUID().uuidString)")!
        defaults.set("0xabc", forKey: "wallet")
        let source = ScriptedSource([.success(try realPortfolio(at: now)), .failure(.unreachable)])
        let store = PortfolioStore(defaults: defaults, makeSource: { _ in source }, now: { clock.date })
        #expect(store.readingSince == now)
        clock.date = now.addingTimeInterval(90)
        await _ = store.poll()
        #expect(store.feed == .live)
        #expect(store.readingSince == nil)
        store.setMethod(store.method == .average ? .fifo : .average)
        #expect(store.readingSince == now.addingTimeInterval(90))
        store.stop()
        await _ = store.poll()
        #expect(store.feed == .serverUnreachable)
        #expect(store.readingSince == nil)
    }

    @Test func comesBackWhenTheServerDoes() async throws {
        let (store, _, _) = makeStore([.failure(.unreachable), .success(try realPortfolio(at: now))])
        await _ = store.poll()
        #expect(store.feed == .serverUnreachable)
        await _ = store.poll()
        #expect(store.feed == .live)
    }

    @Test func aSlowReadFromAServerThatsAnsweringIsntOffline() async throws {
        let later = now.addingTimeInterval(1)
        let (store, source, _) = makeStore([.success(try realPortfolio(at: now)), .failure(.timedOut), .success(try realPortfolio(at: later))])
        await _ = store.poll()
        await _ = store.poll()
        #expect(store.feed == .live)
        #expect(store.portfolio?.latest.date == later)
        // Told to take as long as a first read, the second time.
        #expect(await source.timeouts == [.seconds(180), .seconds(15), .seconds(180)])
    }

    @Test func aSlowReadSaysItsOnItsWayWithoutCallingOldNumbersCurrent() async throws {
        let defaults = UserDefaults(suiteName: "feed-tests-\(UUID().uuidString)")!
        defaults.set("0xabc", forKey: "wallet")
        let gate = TimedOutThenGatedSource(first: try realPortfolio(at: now))
        let now = now
        let store = PortfolioStore(defaults: defaults, makeSource: { _ in gate }, now: { now })
        await _ = store.poll()
        let read = Task { await store.poll() }
        await gate.waitUntilAsked()
        #expect(store.feed == .reading)
        #expect(store.portfolio != nil)
        await gate.answer(.success(try realPortfolio(at: now)))
        await _ = read.value
        #expect(store.feed == .live)
    }

    func makeAgingStore(_ source: any PortfolioSource, liveFor: Duration) -> PortfolioStore {
        let defaults = UserDefaults(suiteName: "feed-tests-\(UUID().uuidString)")!
        defaults.set("0xabc", forKey: "wallet")
        let now = now
        return PortfolioStore(defaults: defaults, makeSource: { _ in source }, now: { now }, liveFor: liveFor)
    }

    @Test func aReadRunningAcrossAGapStopsCallingOldNumbersLive() async throws {
        let gate = GatedSource()
        let store = makeAgingStore(gate, liveFor: .milliseconds(200))
        let first = Task { await store.poll() }
        await gate.waitUntilAsked()
        await gate.answer(.success(try realPortfolio(at: now)))
        await _ = first.value
        #expect(store.feed == .live)
        let held = store.portfolio
        let second = Task { await store.poll() }
        await gate.waitUntilAsked()
        for _ in 0..<2000 where store.feed == .live {
            try await Task.sleep(for: .milliseconds(2))
        }
        #expect(store.feed == .reading)
        #expect(store.portfolio == held)
        #expect(MenuBarShows.allCases.allSatisfy { FeedSummary(feed: store.feed, portfolio: store.portfolio, shows: $0).text == "Updating…" })
        let later = now.addingTimeInterval(1)
        await gate.answer(.success(try realPortfolio(at: later)))
        await _ = second.value
        #expect(store.feed == .live)
        #expect(store.portfolio?.latest.date == later)
    }

    @Test func aNewReadKeepsNumbersLive() async throws {
        let answer = try realPortfolio(at: now)
        let store = makeAgingStore(ScriptedSource([.success(answer), .success(answer)]), liveFor: .seconds(1))
        await _ = store.poll()
        try await Task.sleep(for: .milliseconds(600))
        await _ = store.poll()
        // Past when the first read's numbers would have stopped being live.
        try await Task.sleep(for: .milliseconds(600))
        #expect(store.feed == .live)
    }

    @Test func restartingDoesntKeepOldNumbersLive() async throws {
        let gate = GatedSource()
        let store = makeAgingStore(gate, liveFor: .milliseconds(200))
        let first = Task { await store.poll() }
        await gate.waitUntilAsked()
        await gate.answer(.success(try realPortfolio(at: now)))
        await _ = first.value
        store.start()
        defer { store.stop() }
        await gate.waitUntilAsked()
        for _ in 0..<2000 where store.feed == .live {
            try await Task.sleep(for: .milliseconds(2))
        }
        #expect(store.feed == .reading)
        await gate.answer(.failure(.unreachable))
    }

    @Test func onlyLiveNumbersAge() async throws {
        let store = makeAgingStore(ScriptedSource([.success(try realPortfolio(at: now.addingTimeInterval(-600)))]), liveFor: .milliseconds(1))
        await _ = store.poll()
        let demo = makeAgingStore(ScriptedSource([.success(try demoPortfolio())]), liveFor: .milliseconds(1))
        await _ = demo.poll()
        try await Task.sleep(for: .milliseconds(50))
        #expect(store.feed == .behind(seconds: 600))
        #expect(demo.feed == .live, "demo data isn't reading from anywhere that can fall behind")
    }

    @Test func aReadThatTimesOutWithNothingAnsweringIsOffline() async throws {
        for rulesFailure in [FetchError.unreachable, .timedOut] {
            let (store, source, _) = makeStore([.success(try realPortfolio(at: now)), .failure(.timedOut)], rulesFailure: rulesFailure)
            await _ = store.poll()
            await _ = store.poll()
            #expect(store.feed == .serverUnreachable)
            #expect(store.portfolio != nil)
            #expect(await source.timeouts.count == 2)
        }
    }

    @Test func aServerThatSaysNoStillAnswers() async throws {
        let (store, source, _) = makeStore([.success(try realPortfolio(at: now)), .failure(.timedOut), .success(try realPortfolio(at: now))], rulesFailure: .rejected("No."))
        await _ = store.poll()
        await _ = store.poll()
        #expect(store.feed == .live)
        #expect(await source.timeouts.count == 3)
    }

    @Test func aReadThatNeverFinishesFromAnAnsweringServerIsntOffline() async throws {
        let (store, source, _) = makeStore([.success(try realPortfolio(at: now)), .failure(.timedOut), .failure(.timedOut)])
        await _ = store.poll()
        await _ = store.poll()
        #expect(store.feed == .tooSlow)
        #expect(store.portfolio != nil)
        #expect(await source.timeouts == [.seconds(180), .seconds(15), .seconds(180)])
    }

    @Test func aFirstReadThatTimesOutFromAnAnsweringServerIsntOffline() async throws {
        let (store, source, _) = makeStore([.failure(.timedOut)])
        await _ = store.poll()
        #expect(store.feed == .tooSlow)
        #expect(await source.timeouts == [.seconds(180)])
    }

    @Test func tellsTheServerApartFromAmp() async throws {
        let (store, _, _) = makeStore([.failure(.ampUnavailable("Couldn't read from Amp.")), .failure(.noAmpConfigured("No Amp."))])
        await _ = store.poll()
        #expect(store.feed == .ampUnavailable("Couldn't read from Amp."))
        await _ = store.poll()
        #expect(store.feed == .noAmpConfigured("No Amp."))
    }

    @Test func aReachableServerWithAnOldBlockIsntLive() async throws {
        let old = now.addingTimeInterval(-600)
        let (store, _, _) = makeStore([.success(try realPortfolio(at: old))])
        await _ = store.poll()
        #expect(store.feed == .behind(seconds: 600))
        #expect(MenuBarShows.allCases.allSatisfy { FeedSummary(feed: store.feed, portfolio: store.portfolio, shows: $0).text == "Behind" })
    }

    @Test func aDatasetBehindTheChainIsntLive() async throws {
        let behind = try realPortfolio(at: now, progress: ReadProgress(started: true, behindBlocks: 50))
        let (store, _, _) = makeStore([.success(behind)])
        await _ = store.poll()
        #expect(store.feed == .catchingUp)
        #expect(!store.feed.isStale)
        let notice = try #require(store.feed.staleNotice(serverURL: store.serverURL, portfolio: store.portfolio))
        #expect(notice.contains("about 2 min behind"))
        #expect(MenuBarShows.allCases.allSatisfy { FeedSummary(feed: store.feed, portfolio: store.portfolio, shows: $0).text == "Catching up" })
    }

    @Test func aDatasetThatHasntStartedIsntLive() async throws {
        let waiting = try realPortfolio(at: now, progress: ReadProgress(started: false, behindBlocks: 0))
        let (store, _, _) = makeStore([.success(waiting)])
        await _ = store.poll()
        #expect(store.feed == .catchingUp)
        // The empty state explains this, so a notice would only repeat it.
        #expect(store.feed.staleNotice(serverURL: store.serverURL, portfolio: store.portfolio) == nil)
    }

    @Test func demoDataIsNeverBehind() async throws {
        let (store, _, _) = makeStore([.success(try demoPortfolio())])
        await _ = store.poll()
        #expect(store.feed == .live)
    }

    @Test func dropsNumbersFromTheOtherMethodWhenItCantGetNewOnes() async throws {
        let (store, source, _) = makeStore([.success(try realPortfolio(at: now)), .failure(.unreachable)])
        await _ = store.poll()
        store.setMethod(.fifo)
        store.stop()
        await _ = store.poll()
        #expect(store.portfolio == nil)
        #expect(await source.methods.last == .fifo)
    }

    @Test func changingWalletDropsTheOldOnesNumbers() async throws {
        let (store, _, _) = makeStore([.success(try realPortfolio(at: now))])
        await _ = store.poll()
        store.setWallet("demo")
        store.stop()
        #expect(store.portfolio == nil)
        #expect(store.feed == .reading)
    }

    @Test func aReplacedWalletIsFollowed() {
        let (store, _, defaults) = makeStore([])
        store.followRetiredWallet("0xABC", to: "0xDEF")
        store.stop()
        #expect(store.address == "0xdef")
        #expect(store.feed == .reading)
        #expect(defaults.string(forKey: "wallet") == "0xdef", "and it's still there after a restart")
    }

    @Test func aDeletedWalletGoesBackToTheFirstScreen() {
        let (store, _, defaults) = makeStore([])
        store.followRetiredWallet("0xabc", to: nil)
        store.stop()
        #expect(store.address == nil)
        #expect(store.feed == .noWallet)
        #expect(defaults.string(forKey: "wallet") == nil)
    }

    @Test func anotherWalletStaysWhenAKeyIsRetired() {
        let (store, _, _) = makeStore([])
        store.followRetiredWallet("0xdef", to: "0x123")
        store.followRetiredWallet("0xdef", to: nil)
        store.stop()
        #expect(store.address == "0xabc")

        store.setWallet(WalletAddress.demo)
        store.followRetiredWallet("0xdef", to: nil)
        store.stop()
        #expect(store.address == WalletAddress.demo)

        store.setWallet(nil)
        store.followRetiredWallet("0xdef", to: "0x123")
        store.stop()
        #expect(store.address == nil, "nothing was showing, so nothing follows")
    }

    @Test func aNewMethodStopsCallingTheOldNumbersLiveAtOnce() async throws {
        let (store, _, _) = makeStore([.success(try realPortfolio(at: now)), .success(try realPortfolio(at: now, method: .fifo))])
        await _ = store.poll()
        store.setMethod(.fifo)
        store.stop()
        #expect(store.method == .fifo)
        #expect(store.portfolio?.method == .average)
        #expect(store.feed == .reading)
        #expect(!store.feed.isLive)
        await _ = store.poll()
        #expect(store.portfolio?.method == .fifo)
        #expect(store.feed == .live)
    }

    @Test func aNewServerDropsTheOldServersNumbersAtOnce() async throws {
        let (store, _, _) = makeStore([.success(try realPortfolio(at: now)), .success(try realPortfolio(at: now))])
        await _ = store.poll()
        store.setServerURL(URL(string: "http://127.0.0.1:9999")!)
        store.stop()
        #expect(store.portfolio == nil)
        #expect(store.feed == .reading)
        await _ = store.poll()
        #expect(store.feed == .live)
    }

    @Test func aFailureAfterANewServerDoesntBringBackAnything() async throws {
        let (store, _, _) = makeStore([.success(try realPortfolio(at: now)), .failure(.unreachable)])
        await _ = store.poll()
        store.setServerURL(URL(string: "http://127.0.0.1:9999")!)
        store.stop()
        await _ = store.poll()
        #expect(store.portfolio == nil)
        #expect(store.feed == .serverUnreachable)
    }

    /// A read that started before a change, and only answers after it.
    func answerLate(after change: (PortfolioStore) -> Void, answer: Result<Portfolio, FetchError>) async throws -> PortfolioStore {
        let defaults = UserDefaults(suiteName: "feed-tests-\(UUID().uuidString)")!
        defaults.set("0xabc", forKey: "wallet")
        let gate = GatedSource()
        let now = now
        let store = PortfolioStore(defaults: defaults, makeSource: { _ in gate }, now: { now })
        let read = Task { await store.poll() }
        await gate.waitUntilAsked()
        change(store)
        store.stop()
        let before = store.feed
        await gate.answer(answer)
        _ = await read.value
        #expect(store.feed == before)
        return store
    }

    @Test func ignoresALateAnswerFromTheOldMethod() async throws {
        let store = try await answerLate(after: { $0.setMethod(.fifo) }, answer: .success(try realPortfolio(at: now)))
        #expect(store.portfolio == nil)
        #expect(store.feed == .reading)
    }

    @Test func ignoresALateAnswerFromTheOldServer() async throws {
        let store = try await answerLate(after: { $0.setServerURL(URL(string: "http://127.0.0.1:9999")!) }, answer: .success(try realPortfolio(at: now)))
        #expect(store.portfolio == nil)
    }

    @Test func ignoresALateAnswerFromTheOldWallet() async throws {
        let store = try await answerLate(after: { $0.setWallet("0xdef") }, answer: .success(try realPortfolio(at: now)))
        #expect(store.portfolio == nil)
    }

    @Test func ignoresALateFailureFromTheOldMethod() async throws {
        let store = try await answerLate(after: { $0.setMethod(.fifo) }, answer: .failure(.unreachable))
        #expect(store.feed == .reading)
    }

    @Test func asksInTheChosenCurrencyAndKeepsTheOldNumbersLabeledUntilTheNewOnesArrive() async throws {
        let (store, source, _) = makeStore([.success(try realPortfolio(at: now)), .success(try realPortfolio(at: now, currency: .CAD))])
        await _ = store.poll()
        store.setCurrency(.CAD)
        store.stop()
        #expect(store.currency == .CAD)
        #expect(store.feed == .reading)
        #expect(store.portfolio?.currency == .USD)
        await _ = store.poll()
        #expect(store.portfolio?.currency == .CAD)
        #expect(await source.currencies.last == .CAD)
        #expect(store.feed == .live)
    }

    @Test func dropsNumbersInTheOtherCurrencyWhenItCantGetNewOnes() async throws {
        let (store, _, _) = makeStore([.success(try realPortfolio(at: now)), .failure(.ampUnavailable("Couldn't read from Amp."))])
        await _ = store.poll()
        store.setCurrency(.CAD)
        store.stop()
        await _ = store.poll()
        #expect(store.portfolio == nil)
    }

    @Test func aCurrencyIsPartOfWhatAnExplanationIsAbout() {
        let (store, _, _) = makeStore([])
        let before = store.explanationRequest(for: .total(.pnl))
        store.setCurrency(.CAD)
        store.stop()
        #expect(before != store.explanationRequest(for: .total(.pnl)))
        #expect(store.explanationRequest(for: .total(.pnl))?.currency == .CAD)
    }

    @Test func startsInUSDAndRemembersTheCurrencyAcrossARestart() {
        let (store, _, defaults) = makeStore([])
        #expect(store.currency == .USD)
        store.setCurrency(.CAD)
        store.stop()
        #expect(PortfolioStore(defaults: defaults).currency == .CAD)
    }

    @Test func remembersTheWalletAndMethodAcrossARestart() {
        let (store, _, defaults) = makeStore([])
        store.setWallet("0xDEF")
        store.setMethod(.fifo)
        store.setServerURL(URL(string: "http://127.0.0.1:9999")!)
        store.stop()
        let restarted = PortfolioStore(defaults: defaults)
        #expect(restarted.address == "0xdef")
        #expect(restarted.method == .fifo)
        #expect(restarted.serverURL.absoluteString == "http://127.0.0.1:9999")
        #expect(restarted.feed == .reading)
    }

    @Test func startsWithNoWallet() {
        let defaults = UserDefaults(suiteName: "feed-tests-\(UUID().uuidString)")!
        #expect(PortfolioStore(defaults: defaults).feed == .noWallet)
    }
}

@Suite struct FeedSummaryTests {
    private let server = URL(string: "http://127.0.0.1:8787")!

    @Test func onlyShowsANumberWhileLive() throws {
        let portfolio = try demoPortfolio()
        let states: [FeedState] = [.behind(seconds: 600), .serverUnreachable, .tooSlow, .ampUnavailable("x"), .noAmpConfigured("x"), .rejected("x"), .tooBig("x"), .rateLimited("x")]
        for state in states {
            for shows in MenuBarShows.allCases {
                let summary = FeedSummary(feed: state, portfolio: portfolio, shows: shows)
                #expect(summary.isWarning)
                #expect(!summary.text.contains("$"), "\(state)")
            }
        }
    }

    @Test func aPartialTotalWarns() throws {
        let summary = FeedSummary(feed: .live, portfolio: try demoPortfolio(), shows: .pnl)
        #expect(summary.isWarning)
        #expect(summary.text == "Demo ≈+$149.30")
    }

    @Test func anUnavailableTotalHasNoNumber() throws {
        let summary = FeedSummary(feed: .live, portfolio: try realPortfolio(at: Date(), status: .unavailable), shows: .pnl)
        #expect(summary.isWarning)
        #expect(summary.text == "PnL unavailable")
    }

    @Test func aNullTotalHasNoNumberWhateverTheStatusSays() throws {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(demoPortfolio())) as! [String: Any]
        var totals = object["totals"] as! [String: Any]
        totals["pnlMicros"] = NSNull()
        object["totals"] = totals
        let portfolio = try JSONDecoder().decode(Portfolio.self, from: JSONSerialization.data(withJSONObject: object))
        let summary = FeedSummary(feed: .live, portfolio: portfolio, shows: .pnl)
        #expect(summary.isWarning)
        #expect(!summary.text.contains("$"))
    }

    @Test func aProblemFitsInAFewWords() throws {
        let portfolio = try demoPortfolio()
        let states: [FeedState] = [.behind(seconds: 600), .serverUnreachable, .tooSlow, .ampUnavailable("A very long message from the server."), .noAmpConfigured("x"), .rejected("x"), .tooBig("x"), .rateLimited("x")]
        for state in states {
            let problem = try #require(state.shortProblem(portfolio: portfolio))
            #expect(problem.count <= 26, "\(state)")
            #expect(!problem.contains("."), "\(state)")
        }
        #expect(FeedState.behind(seconds: 600).shortProblem(portfolio: portfolio) == "Prices are 10 min behind")
    }

    @Test func nothingWrongHasNoProblem() throws {
        let portfolio = try demoPortfolio()
        for state in [FeedState.noWallet, .reading, .live] { #expect(state.shortProblem(portfolio: portfolio) == nil) }
        for state in [FeedState.noWallet, .reading, .live, .catchingUp] { #expect(state.problem(serverURL: server, portfolio: portfolio) == nil) }
    }

    @Test func aProblemSaysWhatHappenedThatMoneyIsFineAndWhatToDoWithoutTheServersAddress() throws {
        let portfolio = try realPortfolio(at: Date())
        let states: [FeedState] = [.behind(seconds: 600), .serverUnreachable, .tooSlow, .ampUnavailable("Couldn't read from Amp."), .noAmpConfigured("No Amp."), .rejected("Nope."), .tooBig("Too much history."), .rateLimited("Slow down.")]
        for state in states {
            for shown in [portfolio, nil] {
                let problem = try #require(state.problem(serverURL: server, portfolio: shown))
                #expect(problem.message.contains(Wording.moneyUnaffected), "\(state)")
                for technical in ["127.0.0.1", "http", "server", "Amp", "8787"] {
                    #expect(!problem.message.contains(technical), "\(state): \(technical)")
                    #expect(!problem.title.contains(technical), "\(state): \(technical)")
                }
                // Old numbers say they're old, and from when.
                #expect(problem.message.contains("aren't updating") == (shown != nil), "\(state)")
            }
        }
    }

    @Test func theTechnicalSideStaysAvailable() throws {
        let down = try #require(FeedState.serverUnreachable.problem(serverURL: server, portfolio: nil))
        #expect(down.title == "The Price Service Isn't Running")
        #expect(down.message.hasSuffix("Start it, then try again."))
        #expect(down.detail?.contains("http://127.0.0.1:8787") == true)
        #expect(down.detail?.contains("pnpm start") == true)
        #expect(FeedState.ampUnavailable("Couldn't read from Amp.").problem(serverURL: server, portfolio: nil)?.detail?.contains("Couldn't read from Amp.") == true)
        #expect(FeedState.rejected("Nope.").problem(serverURL: server, portfolio: nil)?.detail?.contains("Nope.") == true)
        let tooBig = try #require(FeedState.tooBig("Too much history.").problem(serverURL: server, portfolio: nil))
        #expect(tooBig.title == "Too Much History to Read")
        #expect(tooBig.message.contains("Trying again won't change this."))
        #expect(tooBig.detail?.contains("Too much history.") == true)
    }

    @Test func aServerElsewhereIsntOneToStart() throws {
        let remote = try #require(FeedState.serverUnreachable.problem(serverURL: URL(string: "https://prices.example.com")!, portfolio: nil))
        #expect(!remote.message.contains("this Mac"))
        #expect(!remote.message.contains("Start it"))
        #expect(remote.detail == "Nothing answered at https://prices.example.com.")
    }

    @Test func aServerElsewhereIsntOneToRestart() throws {
        let elsewhere = URL(string: "https://prices.example.com")!
        for state in [FeedState.noAmpConfigured("None."), .rejected("Nope.")] {
            let hosted = try #require(state.problem(serverURL: elsewhere, portfolio: nil))
            #expect(!hosted.message.contains("restart"))
            #expect(hosted.detail?.contains(".env.local") == false)
            let local = try #require(state.problem(serverURL: server, portfolio: nil))
            #expect(local.message.contains("restart the price service"))
        }
    }

    @Test func localhostInAnyCaseIsOnThisMac() throws {
        let shouted = URL(string: "http://LOCALHOST:8787")!
        for state in [FeedState.noAmpConfigured("None."), .rejected("Nope.")] {
            #expect(state.problem(serverURL: shouted, portfolio: nil) == state.problem(serverURL: server, portfolio: nil))
        }
        let unreachable = try #require(FeedState.serverUnreachable.problem(serverURL: shouted, portfolio: nil))
        #expect(unreachable.title == "The Price Service Isn't Running")
    }

    @Test func theGlanceListsWhatsHeldLargestFirst() throws {
        let portfolio = try demoPortfolio()
        let top = portfolio.largestHoldings(3)
        #expect(top.map(\.asset) == ["USDC", "cbBTC", "ETH"])
        #expect(portfolio.largestHoldings(100).allSatisfy { $0.isHeld })
    }

    @Test func aPositionWithNoPriceRanksLastInsteadOfAsNothing() throws {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(demoPortfolio())) as! [String: Any]
        var positions = object["positions"] as! [[String: Any]]
        let index = try #require(positions.firstIndex { $0["asset"] as? String == "USDC" })
        var values = positions[index]["values"] as! [String: Any]
        values["valueMicros"] = NSNull()
        positions[index]["values"] = values
        object["positions"] = positions
        let portfolio = try JSONDecoder().decode(Portfolio.self, from: JSONSerialization.data(withJSONObject: object))
        let all = portfolio.largestHoldings(100)
        #expect(all.last?.asset == "USDC")
        #expect(all.first?.asset == "cbBTC")
    }

    /// The demo, changed, with its value counted as partial the way the SDK counts it.
    private func partialPortfolio(valueCoverage: [String: Int] = ["known": 6, "missing": 1], _ change: (inout [String: Any]) -> Void) throws -> Portfolio {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(demoPortfolio())) as! [String: Any]
        var totals = object["totals"] as! [String: Any]
        var coverage = totals["coverage"] as! [String: Any]
        coverage["value"] = valueCoverage
        totals["coverage"] = coverage
        object["totals"] = totals
        change(&object)
        return try JSONDecoder().decode(Portfolio.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func changing(_ asset: String, in object: inout [String: Any], _ change: (inout [String: Any]) -> Void) {
        var positions = object["positions"] as! [[String: Any]]
        for index in positions.indices where positions[index]["asset"] as? String == asset { change(&positions[index]) }
        object["positions"] = positions
    }

    private func removingPrice(of asset: String, in object: inout [String: Any]) {
        changing(asset, in: &object) { position in
            var values = position["values"] as! [String: Any]
            values["valueMicros"] = NSNull()
            position["values"] = values
        }
    }

    @Test func aValueMissingAHoldingSaysSoEvenWhenThatHoldingIsntListed() throws {
        let portfolio = try partialPortfolio { removingPrice(of: "USDC", in: &$0) }
        #expect(!portfolio.largestHoldings(5).map(\.asset).contains("USDC"))
        #expect(portfolio.isValuePartial)
        #expect(portfolio.partialValueReason == "USDC has no price right now.")
    }

    @Test func anUnreadBalanceIsntCalledAMissingPrice() throws {
        let portfolio = try partialPortfolio(valueCoverage: ["known": 7, "missing": 1]) { $0["unreadAssets"] = ["wstETH"] }
        #expect(portfolio.partialValueReason == "Couldn't read the balance of wstETH.")
    }

    @Test func anUncheckedBalanceSaysSoUnlessItsStillCurrent() throws {
        let unchecked: (Bool) throws -> Portfolio = { isCurrent in
            try self.partialPortfolio { object in
                self.changing("AERO", in: &object) { $0["reconciliation"] = ["status": "unchecked", "heldIsCurrent": isCurrent] }
            }
        }
        #expect(try unchecked(false).partialValueReason == "Couldn't check the balance of AERO.")
        #expect(try unchecked(true).partialValueReason == "This value isn't complete.")
    }

    @Test func incompleteHistorySaysSo() throws {
        let portfolio = try partialPortfolio { object in
            changing("AERO", in: &object) { $0["shortfallQty"] = "5" }
        }
        #expect(portfolio.partialValueReason == "Incomplete history for AERO.")
    }

    @Test func aValueWithSeveralCausesNamesEach() throws {
        let portfolio = try partialPortfolio(valueCoverage: ["known": 5, "missing": 3]) { object in
            removingPrice(of: "USDC", in: &object)
            removingPrice(of: "DAI", in: &object)
            object["unreadAssets"] = ["wstETH"]
        }
        let reason = try #require(portfolio.partialValueReason)
        #expect(reason.contains("have no price right now."))
        #expect(reason.contains("USDC") && reason.contains("DAI"))
        #expect(reason.contains("Couldn't read the balance of wstETH."))
    }

    @Test func noKnownCauseDoesntGuessOne() throws {
        #expect(try partialPortfolio { _ in }.partialValueReason == "This value isn't complete.")
    }

    @Test func aWholeValueIsntPartial() throws {
        let portfolio = try demoPortfolio()
        #expect(!portfolio.isValuePartial)
        #expect(portfolio.partialValueReason == nil)
    }

    @Test func attentionFitsInAFewWords() throws {
        #expect(try demoPortfolio().shortAttention == "$3,603.42 has an unknown cost")
        #expect(try realPortfolio(at: Date(), status: .complete).shortAttention?.contains("\n") != true)
    }

    @Test func aCompleteTotalDoesntWarn() throws {
        let summary = FeedSummary(feed: .live, portfolio: try realPortfolio(at: Date(), status: .complete), shows: .pnl)
        #expect(!summary.isWarning)
        #expect(summary.text == "≈+$149.30")
    }

    @MainActor @Test func showsValueUnlessAskedOtherwise() throws {
        let defaults = UserDefaults(suiteName: "feed-tests-\(UUID().uuidString)")!
        let store = PortfolioStore(defaults: defaults)
        #expect(store.menuBarShows == .value)
        store.setMenuBarShows(.icon)
        #expect(PortfolioStore(defaults: defaults).menuBarShows == .icon)
    }

    @Test func valueSaysWhenItLeavesSomethingOut() throws {
        let portfolio = try realPortfolio(at: Date(), status: .complete)
        let summary = FeedSummary(feed: .live, portfolio: portfolio, shows: .value)
        #expect(summary.text == "≈$7,571.03")
        #expect(summary.isWarning == portfolio.isValuePartial)
        #expect(FeedSummary(feed: .live, portfolio: try demoPortfolio(), shows: .value).text == "Demo ≈$7,571.03")
    }

    @Test func anUnknownValueHasNoNumber() throws {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(realPortfolio(at: Date(), status: .complete))) as! [String: Any]
        var totals = object["totals"] as! [String: Any]
        totals["valueMicros"] = NSNull()
        object["totals"] = totals
        let portfolio = try JSONDecoder().decode(Portfolio.self, from: JSONSerialization.data(withJSONObject: object))
        let summary = FeedSummary(feed: .live, portfolio: portfolio, shows: .value)
        #expect(summary.isWarning)
        #expect(summary.text == "Value unavailable")
    }

    @Test func aFirstReadSaysSoWhateverItShows() {
        #expect(MenuBarShows.allCases.allSatisfy { FeedSummary(feed: .reading, portfolio: nil, shows: $0).text == "Reading…" })
    }

    @Test func iconOnlyShowsNoNumber() throws {
        let real = FeedSummary(feed: .live, portfolio: try realPortfolio(at: Date(), status: .unavailable), shows: .icon)
        #expect(real.text.isEmpty)
        #expect(!real.isWarning)
        #expect(FeedSummary(feed: .live, portfolio: try demoPortfolio(), shows: .icon).text == "Demo")
    }
}

/// Has two pricing rules, and remembers which one each read asked for.
actor RuledSource: PortfolioSource {
    static let market = PricingRule(id: "market-price", name: "Market price", summary: "", dataset: "a/b@0.0.1", hash: String(repeating: "a", count: 64))
    static let cautious = PricingRule(id: "cautious-eth", name: "Cautious ETH", summary: "", dataset: "a/c@0.0.1", hash: String(repeating: "b", count: 64))
    private(set) var asked: [String?] = []
    private(set) var askedAboutProof: [String?] = []
    var failing = false
    /// The waits it'll answer `rules()` with before it gives the list.
    private var rulesRefusals: [Int]
    private let rulesTake: Duration?
    private(set) var rulesAskedAt: [ContinuousClock.Instant] = []
    var rulesAsked: Int { rulesAskedAt.count }

    init(rulesRefusals: [Int] = [], rulesTake: Duration? = nil) {
        self.rulesRefusals = rulesRefusals
        self.rulesTake = rulesTake
    }

    func portfolio(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book, timeout: Duration) async throws -> Portfolio {
        asked.append(rule)
        if failing { throw FetchError.ampUnavailable("Couldn't read this wallet's data.") }
        let portfolio = try demoPortfolio()
        var json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(portfolio)) as! [String: Any]
        json["rule"] = rule ?? Self.market.id
        return try JSONDecoder().decode(Portfolio.self, from: JSONSerialization.data(withJSONObject: json))
    }

    func explanation(of target: ExplainTarget, address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], shown: [String]?, book: Book) async throws -> Explanation {
        throw FetchError.unreachable
    }

    func taxReport(_ request: TaxReportRequest) async throws -> TaxReport {
        throw FetchError.unreachable
    }

    func proof(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Proof {
        askedAboutProof.append(rule)
        return try resource("proof", as: Proof.self)
    }

    func verification(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Verification {
        askedAboutProof.append(rule)
        return try resource("verification", as: Verification.self)
    }

    func rules() async throws -> [PricingRule] {
        rulesAskedAt.append(.now)
        let refusal = rulesRefusals.isEmpty ? nil : rulesRefusals.removeFirst()
        if let rulesTake { try await Task.sleep(for: rulesTake) }
        if let refusal { throw FetchError.rateLimited("Too many requests.", retryAfter: refusal) }
        return [Self.market, Self.cautious]
    }

    func setFailing() { failing = true }
}

/// A new source each time the store makes one, staying on the last.
final class Sources: @unchecked Sendable {
    private var left: [RuledSource]

    init(_ sources: [RuledSource]) { left = sources }

    func next() -> RuledSource { left.count > 1 ? left.removeFirst() : left[0] }
}

@MainActor
@Suite struct RuleTests {
    func makeStore(_ source: RuledSource, stored: String? = nil) -> PortfolioStore {
        makeStore(Sources([source]), stored: stored)
    }

    func makeStore(_ sources: Sources, stored: String? = nil) -> PortfolioStore {
        let defaults = UserDefaults(suiteName: "rules-\(UUID().uuidString)")!
        defaults.set("demo", forKey: "wallet")
        if let stored { defaults.set(stored, forKey: "pricingRule") }
        return PortfolioStore(defaults: defaults, makeSource: { _ in sources.next() }, reachableDelay: .seconds(60))
    }

    @Test func asksForTheServersDefaultUntilARuleIsChosen() async {
        let source = RuledSource()
        let store = makeStore(source)
        await store.refreshRules()
        _ = await store.poll()
        #expect(await source.asked == [nil])
        #expect(store.activeRuleName == nil)
    }

    @Test func aChosenRuleIsAskedForAndSaidOnScreen() async {
        let source = RuledSource()
        let store = makeStore(source)
        await store.refreshRules()
        store.setRule(RuledSource.cautious.id)
        store.stop()
        #expect(store.feed == .reading)
        _ = await store.poll()
        #expect(await source.asked.last == RuledSource.cautious.id)
        #expect(store.portfolio?.rule == RuledSource.cautious.id)
        #expect(store.activeRuleName == "Cautious ETH")
    }

    @Test func aRuleTheServerDoesntHaveIsDropped() async {
        let source = RuledSource()
        let store = makeStore(source, stored: "gone")
        await store.refreshRules()
        store.stop()
        #expect(store.selectedRule == nil)
    }

    @Test func numbersByTheOldRuleGoWhenTheNewOneCantBeRead() async {
        let source = RuledSource()
        let store = makeStore(source)
        await store.refreshRules()
        _ = await store.poll()
        #expect(store.portfolio != nil)
        await source.setFailing()
        store.setRule(RuledSource.cautious.id)
        store.stop()
        _ = await store.poll()
        #expect(store.portfolio == nil)
    }

    @Test func anExplanationIsAboutTheRuleOnScreen() async {
        let source = RuledSource()
        let store = makeStore(source)
        await store.refreshRules()
        let before = store.explanationRequest(for: .total(.pnl))
        store.setRule(RuledSource.cautious.id)
        store.stop()
        #expect(before != store.explanationRequest(for: .total(.pnl)))
    }

    @Test func aProofIsAboutTheRuleOnScreen() async throws {
        let source = RuledSource()
        let store = makeStore(source)
        await store.refreshRules()
        _ = try await store.proof(leg: "x", address: "demo")
        store.setRule(RuledSource.cautious.id)
        store.stop()
        _ = try await store.proof(leg: "x", address: "demo")
        _ = try await store.verification(leg: "x", address: "demo")
        #expect(await source.askedAboutProof == [nil, RuledSource.cautious.id, RuledSource.cautious.id])
    }

    private func waitForRules(_ store: PortfolioStore) async throws {
        for _ in 0..<2000 where store.rules.isEmpty { try await Task.sleep(for: .milliseconds(5)) }
        #expect(!store.rules.isEmpty)
    }

    @Test func aServerThatSaysToWaitIsAskedForRulesOnceThen() async throws {
        let source = RuledSource(rulesRefusals: [1])
        let store = makeStore(source)
        await store.refreshRules()
        #expect(store.rules.isEmpty)
        // Nobody else asks during the wait, like Settings opening.
        await store.refreshRules()
        await store.refreshRules()
        #expect(await source.rulesAsked == 1)
        try await waitForRules(store)
        let askedAt = await source.rulesAskedAt
        #expect(askedAt.count == 2)
        #expect(askedAt[1] - askedAt[0] >= .seconds(1))
    }

    @Test func checkingAServerThatSaidToWaitAnswersWithoutAskingEarly() async throws {
        let source = RuledSource(rulesRefusals: [1])
        let store = makeStore(source)
        await store.refreshRules()
        #expect(store.serverCheck == .answers)
        store.checkServer()
        #expect(store.serverCheck == .checking)
        for _ in 0..<100 where store.serverCheck == .checking { try await Task.sleep(for: .milliseconds(5)) }
        #expect(store.serverCheck == .answers)
        #expect(await source.rulesAsked == 1)
    }

    @Test func aServerThatKeepsSayingToWaitKeepsBeingWaitedFor() async throws {
        let source = RuledSource(rulesRefusals: [1, 1])
        let store = makeStore(source)
        await store.refreshRules()
        try await waitForRules(store)
        let askedAt = await source.rulesAskedAt
        #expect(askedAt.count == 3)
        #expect(askedAt[1] - askedAt[0] >= .seconds(1))
        #expect(askedAt[2] - askedAt[1] >= .seconds(1))
    }

    @Test func twoReadsAtOnceAskOnceAndWaitAsLongAsTheyreTold() async throws {
        let source = RuledSource(rulesRefusals: [1, 1], rulesTake: .milliseconds(50))
        let store = makeStore(source)
        async let first: Void = store.refreshRules()
        async let second: Void = store.refreshRules()
        _ = await (first, second)
        #expect(await source.rulesAsked == 1)
        try await waitForRules(store)
        try await Task.sleep(for: .milliseconds(100))
        let askedAt = await source.rulesAskedAt
        #expect(askedAt.count == 3)
        #expect(askedAt[1] - askedAt[0] >= .seconds(1))
        #expect(askedAt[2] - askedAt[1] >= .seconds(1))
    }

    @Test func twoReadsAtOnceHonorADifferentWaitNext() async throws {
        let source = RuledSource(rulesRefusals: [1, 2], rulesTake: .milliseconds(100))
        let store = makeStore(source)
        async let first: Void = store.refreshRules()
        async let second: Void = store.refreshRules()
        _ = await (first, second)
        try await waitForRules(store)
        let askedAt = await source.rulesAskedAt
        #expect(askedAt.count == 3)
        #expect(askedAt[1] - askedAt[0] >= .seconds(1))
        #expect(askedAt[2] - askedAt[1] >= .seconds(2))
    }

    @Test func aReadThatStartsDuringAnotherJoinsIt() async throws {
        let source = RuledSource(rulesRefusals: [1, 1], rulesTake: .milliseconds(200))
        let store = makeStore(source)
        async let first: Void = store.refreshRules()
        try await Task.sleep(for: .milliseconds(100))
        // Partway through the first read, and then partway through the one after the wait.
        await store.refreshRules()
        #expect(await source.rulesAsked == 1)
        await first
        try await Task.sleep(for: .milliseconds(1100))
        await store.refreshRules()
        try await waitForRules(store)
        let askedAt = await source.rulesAskedAt
        #expect(askedAt.count == 3)
        #expect(askedAt[1] - askedAt[0] >= .seconds(1))
        #expect(askedAt[2] - askedAt[1] >= .seconds(1))
    }

    @Test func aWaitEndsWithTheInviteItWasFor() async throws {
        let refused = RuledSource(rulesRefusals: [1])
        let next = RuledSource()
        let store = makeStore(Sources([refused, next]))
        await store.refreshRules()
        store.setInvite("another")
        store.stop()
        try await waitForRules(store)
        try await Task.sleep(for: .milliseconds(1200))
        #expect(await refused.rulesAsked == 1)
        #expect(await next.rulesAsked == 1)
    }

    @Test func aWaitEndsWithTheServerItWasFor() async throws {
        let refused = RuledSource(rulesRefusals: [1])
        let next = RuledSource()
        let store = makeStore(Sources([refused, next]))
        await store.refreshRules()
        store.setServerURL(URL(string: "http://127.0.0.1:1")!)
        store.stop()
        try await waitForRules(store)
        try await Task.sleep(for: .milliseconds(1200))
        #expect(await refused.rulesAsked == 1)
        #expect(await next.rulesAsked == 1)
    }

    @Test func anAnswerFromBeforeAnInviteChangeDoesntCount() async throws {
        let slow = RuledSource(rulesTake: .milliseconds(100))
        let next = RuledSource(rulesRefusals: [60])
        let store = makeStore(Sources([slow, next]))
        async let asked: Void = store.refreshRules()
        try await Task.sleep(for: .milliseconds(20))
        store.setInvite("another")
        store.stop()
        await asked
        #expect(store.rules.isEmpty)
    }

    @Test func aWaitFromBeforeAnInviteChangeDoesntCount() async throws {
        let slow = RuledSource(rulesRefusals: [1], rulesTake: .milliseconds(100))
        let next = RuledSource()
        let store = makeStore(Sources([slow, next]))
        async let asked: Void = store.refreshRules()
        try await Task.sleep(for: .milliseconds(20))
        store.setInvite("another")
        store.stop()
        await asked
        try await Task.sleep(for: .milliseconds(1200))
        #expect(await slow.rulesAsked == 1)
        #expect(!store.rules.isEmpty)
    }
}

/// Says to wait, once, then answers.
actor HeldBackSource: PortfolioSource {
    nonisolated let events: AsyncThrowingStream<Void, any Error>
    nonisolated let push: AsyncThrowingStream<Void, any Error>.Continuation
    private let answer: Portfolio
    private let retryAfter: Int
    private(set) var reads = 0

    init(answer: Portfolio, retryAfter: Int) {
        self.answer = answer
        self.retryAfter = retryAfter
        (events, push) = AsyncThrowingStream.makeStream(of: Void.self, throwing: (any Error).self)
    }

    nonisolated func headEvents() -> AsyncThrowingStream<Void, any Error>? { events }

    func portfolio(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book, timeout: Duration) async throws -> Portfolio {
        reads += 1
        if reads == 1 { throw FetchError.rateLimited("Too many requests.", retryAfter: retryAfter) }
        return answer
    }

    func explanation(of target: ExplainTarget, address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], shown: [String]?, book: Book) async throws -> Explanation { throw FetchError.unreachable }
}

/// Answers every read the same way, counts them, and reports new blocks when a test says so.
actor PushedSource: PortfolioSource {
    nonisolated let events: AsyncThrowingStream<Void, any Error>?
    nonisolated let push: AsyncThrowingStream<Void, any Error>.Continuation?
    private let answer: Portfolio
    private(set) var reads = 0

    init(answer: Portfolio, pushes: Bool) {
        self.answer = answer
        if pushes {
            let (events, push) = AsyncThrowingStream.makeStream(of: Void.self, throwing: (any Error).self)
            self.events = events
            self.push = push
        } else {
            events = nil
            push = nil
        }
    }

    nonisolated func headEvents() -> AsyncThrowingStream<Void, any Error>? { events }

    func portfolio(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book, timeout: Duration) async throws -> Portfolio {
        reads += 1
        return answer
    }

    func explanation(of target: ExplainTarget, address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], shown: [String]?, book: Book) async throws -> Explanation { throw FetchError.unreachable }
}

@MainActor
@Suite struct PushedFeedTests {
    let now = Date(timeIntervalSince1970: 1_800_000_100)

    func makeStore(_ source: any PortfolioSource, reachableDelay: Duration, pushedDelay: Duration) -> PortfolioStore {
        let defaults = UserDefaults(suiteName: "pushed-tests-\(UUID().uuidString)")!
        defaults.set("0xabc", forKey: "wallet")
        let now = now
        return PortfolioStore(defaults: defaults, makeSource: { _ in source }, now: { now }, reachableDelay: reachableDelay, unreachableDelay: .milliseconds(5), pushedDelay: pushedDelay)
    }

    @MainActor private func waitForFeed(_ store: PortfolioStore, _ matches: (FeedState) -> Bool) async throws {
        for _ in 0..<600 where !matches(store.feed) { try await Task.sleep(for: .milliseconds(5)) }
        #expect(matches(store.feed))
    }

    private func waitForReads(_ source: PushedSource, _ count: Int) async throws {
        for _ in 0..<2000 {
            if await source.reads >= count { return }
            try await Task.sleep(for: .milliseconds(2))
        }
        Issue.record("Only \(await source.reads) reads, not \(count)")
    }

    @Test func readsAsSoonAsTheServerSaysThereIsABlock() async throws {
        let source = PushedSource(answer: try realPortfolio(at: now), pushes: true)
        let store = makeStore(source, reachableDelay: .seconds(600), pushedDelay: .seconds(600))
        store.start()
        defer { store.stop() }
        try await waitForReads(source, 1)
        source.push?.yield()
        try await waitForReads(source, 2)
        source.push?.yield()
        try await waitForReads(source, 3)
    }

    @Test func doesNotPollWhileTheServerIsReportingBlocks() async throws {
        let source = PushedSource(answer: try realPortfolio(at: now), pushes: true)
        let store = makeStore(source, reachableDelay: .milliseconds(5), pushedDelay: .seconds(600))
        store.start()
        defer { store.stop() }
        try await waitForReads(source, 1)
        source.push?.yield()
        try await waitForReads(source, 2)
        // Let the read that the block woke finish, then nothing should read until there's another.
        try await Task.sleep(for: .milliseconds(50))
        let settled = await source.reads
        try await Task.sleep(for: .milliseconds(100))
        #expect(await source.reads == settled)
    }

    @Test func aServerThatSaysToWaitIsLeftAloneUntilThen() async throws {
        let source = HeldBackSource(answer: try realPortfolio(at: now), retryAfter: 1)
        let store = makeStore(source, reachableDelay: .milliseconds(5), pushedDelay: .seconds(600))
        store.start()
        defer { store.stop() }
        try await waitForFeed(store) { $0 == .rateLimited("Too many requests.") }
        #expect(store.feed.isStale)
        // New blocks say nothing about when there's room.
        source.push.yield()
        source.push.yield()
        try await Task.sleep(for: .milliseconds(100))
        #expect(await source.reads == 1)
        // Then it comes back by itself.
        try await waitForFeed(store) { $0 == .live }
        #expect(await source.reads == 2)
    }

    @Test func oneReadABlockIsWellUnderTheLimit() async throws {
        let source = PushedSource(answer: try realPortfolio(at: now), pushes: true)
        let store = makeStore(source, reachableDelay: .seconds(600), pushedDelay: .seconds(600))
        store.start()
        defer { store.stop() }
        try await waitForReads(source, 1)
        // A minute's blocks at one every 2 s, with the reads faster than the blocks, as they are for an ordinary wallet.
        for count in 2...31 {
            source.push?.yield()
            try await waitForReads(source, count)
        }
        try await Task.sleep(for: .milliseconds(50))
        #expect(await source.reads == 31, "Hosted servers allow 120 requests a minute")
    }

    @Test func goesBackToPollingStraightAwayWhenTheEventsStop() async throws {
        let source = PushedSource(answer: try realPortfolio(at: now), pushes: true)
        let store = makeStore(source, reachableDelay: .milliseconds(5), pushedDelay: .seconds(600))
        store.start()
        defer { store.stop() }
        try await waitForReads(source, 1)
        source.push?.yield()
        try await waitForReads(source, 2)
        try await Task.sleep(for: .milliseconds(50))
        let settled = await source.reads
        source.push?.finish(throwing: FetchError.unreachable)
        try await waitForReads(source, settled + 5)
    }

    @Test func pollsASourceThatCanNotReportBlocks() async throws {
        let source = PushedSource(answer: try realPortfolio(at: now), pushes: false)
        let store = makeStore(source, reachableDelay: .milliseconds(5), pushedDelay: .seconds(600))
        store.start()
        defer { store.stop() }
        try await waitForReads(source, 5)
    }
}

/// Answers `/api/events` with what a test gives it, without opening a socket.
final class EventsProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var body = ""
    nonisolated(unsafe) static var status = 200
    nonisolated(unsafe) static var retryAfter: String?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: nil, headerFields: ["content-type": "text/event-stream"].merging(Self.retryAfter.map { ["Retry-After": $0] } ?? [:]) { $1 })!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(Self.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

/// Fails every request the way a test says, without opening a socket.
final class FailingProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var code = URLError.Code.timedOut

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        client?.urlProtocol(self, didFailWithError: URLError(Self.code))
    }
}

@Suite(.serialized) struct ClientFailureTests {
    @Test func toldApartFromATimeout() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FailingProtocol.self]
        let client = PricetagClient(serverURL: URL(string: "http://127.0.0.1:8787")!, configuration: configuration)
        FailingProtocol.code = .timedOut
        await #expect(throws: FetchError.timedOut) { try await client.rules() }
        FailingProtocol.code = .cannotConnectToHost
        await #expect(throws: FetchError.unreachable) { try await client.rules() }
    }
}

@Suite(.serialized) struct HeadEventsTests {
    private func client() -> PricetagClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [EventsProtocol.self]
        return PricetagClient(serverURL: URL(string: "http://127.0.0.1:8787")!, configuration: configuration)
    }

    @Test func countsHeadsAndIgnoresEverythingElse() async throws {
        EventsProtocol.status = 200
        EventsProtocol.body = ": connected\n\nevent: head\ndata: {\"blockNum\":1}\n\nevent: down\ndata: {}\n\nevent: head\ndata: {\"blockNum\":2}\n\n"
        var heads = 0
        for try await _ in try #require(client().headEvents()) { heads += 1 }
        #expect(heads == 2)
    }

    @Test func saysHowLongToWaitWhenItsHeldBack() async throws {
        EventsProtocol.status = 429
        EventsProtocol.body = ""
        EventsProtocol.retryAfter = "17"
        defer { EventsProtocol.retryAfter = nil }
        await #expect(throws: FetchError.rateLimited("Too many requests.", retryAfter: 17)) {
            for try await _ in try #require(client().headEvents()) {}
        }
    }

    @Test func aReadSaysWhatTheServerSaidAndHowLongToWait() async throws {
        EventsProtocol.status = 429
        EventsProtocol.body = #"{"error":"Too many requests from this invite."}"#
        EventsProtocol.retryAfter = "17"
        defer { EventsProtocol.retryAfter = nil }
        await #expect(throws: FetchError.rateLimited("Too many requests from this invite.", retryAfter: 17)) { try await client().rules() }
        EventsProtocol.retryAfter = nil
        await #expect(throws: FetchError.rateLimited("Too many requests from this invite.", retryAfter: 60)) { try await client().rules() }
    }

    @Test func failsOnAnErrorResponse() async throws {
        EventsProtocol.status = 500
        EventsProtocol.body = ""
        await #expect(throws: (any Error).self) {
            for try await _ in try #require(client().headEvents()) {}
        }
    }
}

@Suite struct WalletBadgeTests {
    @Test func itsLeftOutWhenTheLineBesideItSaysTheSame() throws {
        let demo = try demoPortfolio()
        #expect(!FeedState.noWallet.showsWalletBadge(portfolio: nil))
        #expect(!FeedState.reading.showsWalletBadge(portfolio: nil))
        #expect(FeedState.reading.showsWalletBadge(portfolio: demo))
        #expect(!FeedState.live.showsWalletBadge(portfolio: demo))
        #expect(FeedState.live.showsWalletBadge(portfolio: nil))
        #expect(FeedState.serverUnreachable.showsWalletBadge(portfolio: nil))
    }
}
