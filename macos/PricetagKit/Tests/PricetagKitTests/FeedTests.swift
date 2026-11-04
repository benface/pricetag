import Foundation
import Testing
@testable import PricetagKit

/// Answers from a script, and remembers what it was asked.
actor ScriptedSource: PortfolioSource {
    var answers: [Result<Portfolio, FetchError>]
    private(set) var methods: [CostMethod] = []
    private(set) var currencies: [CurrencyCode] = []

    init(_ answers: [Result<Portfolio, FetchError>]) {
        self.answers = answers
    }

    func portfolio(address: String, method: CostMethod, currency: CurrencyCode, timeout: Duration) async throws -> Portfolio {
        methods.append(method)
        currencies.append(currency)
        return try answers.removeFirst().get()
    }

    func explanation(of target: ExplainTarget, address: String, method: CostMethod, currency: CurrencyCode) async throws -> Explanation {
        throw FetchError.unreachable
    }

    func taxReport(_ request: TaxReportRequest) async throws -> TaxReport {
        throw FetchError.unreachable
    }
}

/// Holds one read open until it's told how to answer.
actor GatedSource: PortfolioSource {
    private var waiting: CheckedContinuation<Portfolio, any Error>?

    func portfolio(address: String, method: CostMethod, currency: CurrencyCode, timeout: Duration) async throws -> Portfolio {
        try await withCheckedThrowingContinuation { waiting = $0 }
    }

    func explanation(of target: ExplainTarget, address: String, method: CostMethod, currency: CurrencyCode) async throws -> Explanation {
        throw FetchError.unreachable
    }

    func taxReport(_ request: TaxReportRequest) async throws -> TaxReport {
        throw FetchError.unreachable
    }

    func waitUntilAsked() async {
        while waiting == nil { await Task.yield() }
    }

    func answer(_ result: Result<Portfolio, FetchError>) {
        waiting?.resume(with: result.mapError { $0 as any Error })
        waiting = nil
    }
}

/// `demoPortfolio()`, but from a real source, and with its newest block at a given time.
func realPortfolio(at date: Date, status: PnlStatus? = nil, method: CostMethod = .average, currency: CurrencyCode = .USD, progress: ReadProgress? = nil) throws -> Portfolio {
    var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(demoPortfolio())) as! [String: Any]
    object["mode"] = "raw"
    object["method"] = method.rawValue
    object["currency"] = currency.rawValue
    object["latest"] = ["blockNum": 53_505_400, "timestamp": date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))]
    if let status { object["pnlStatus"] = status.rawValue }
    if let progress { object["progress"] = ["started": progress.started, "behindBlocks": progress.behindBlocks] }
    return try JSONDecoder().decode(Portfolio.self, from: JSONSerialization.data(withJSONObject: object))
}

@MainActor
@Suite struct FeedTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    func makeStore(_ answers: [Result<Portfolio, FetchError>]) -> (PortfolioStore, ScriptedSource, UserDefaults) {
        let defaults = UserDefaults(suiteName: "feed-tests-\(UUID().uuidString)")!
        defaults.set("0xabc", forKey: "wallet")
        let source = ScriptedSource(answers)
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
        #expect(notice.contains("53,505,400"))
    }

    @Test func comesBackWhenTheServerDoes() async throws {
        let (store, _, _) = makeStore([.failure(.unreachable), .success(try realPortfolio(at: now))])
        await _ = store.poll()
        #expect(store.feed == .serverUnreachable)
        await _ = store.poll()
        #expect(store.feed == .live)
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
        #expect(FeedSummary(feed: store.feed, portfolio: store.portfolio).text == "Behind")
    }

    @Test func aDatasetBehindTheChainIsntLive() async throws {
        let behind = try realPortfolio(at: now, progress: ReadProgress(started: true, behindBlocks: 50))
        let (store, _, _) = makeStore([.success(behind)])
        await _ = store.poll()
        #expect(store.feed == .catchingUp)
        #expect(!store.feed.isStale)
        let notice = try #require(store.feed.staleNotice(serverURL: store.serverURL, portfolio: store.portfolio))
        #expect(notice.contains("50 blocks behind"))
        #expect(FeedSummary(feed: store.feed, portfolio: store.portfolio).text == "Catching up")
    }

    @Test func aDatasetThatHasntStartedIsntLive() async throws {
        let waiting = try realPortfolio(at: now, progress: ReadProgress(started: false, behindBlocks: 0))
        let (store, _, _) = makeStore([.success(waiting)])
        await _ = store.poll()
        #expect(store.feed == .catchingUp)
        #expect(try #require(store.feed.staleNotice(serverURL: store.serverURL, portfolio: store.portfolio)).contains("hasn't reached"))
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
    @Test func onlyShowsANumberWhileLive() throws {
        let portfolio = try demoPortfolio()
        let states: [FeedState] = [.behind(seconds: 600), .serverUnreachable, .ampUnavailable("x"), .noAmpConfigured("x"), .rejected("x")]
        for state in states {
            let summary = FeedSummary(feed: state, portfolio: portfolio)
            #expect(summary.isWarning)
            #expect(!summary.text.contains("$"), "\(state)")
        }
    }

    @Test func aPartialTotalWarns() throws {
        let summary = FeedSummary(feed: .live, portfolio: try demoPortfolio())
        #expect(summary.isWarning)
        #expect(summary.text == "Demo +$74.28")
    }

    @Test func anUnavailableTotalHasNoNumber() throws {
        let summary = FeedSummary(feed: .live, portfolio: try realPortfolio(at: Date(), status: .unavailable))
        #expect(summary.isWarning)
        #expect(summary.text == "PnL unavailable")
    }

    @Test func aNullTotalHasNoNumberWhateverTheStatusSays() throws {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(demoPortfolio())) as! [String: Any]
        var totals = object["totals"] as! [String: Any]
        totals["pnlMicros"] = NSNull()
        object["totals"] = totals
        let portfolio = try JSONDecoder().decode(Portfolio.self, from: JSONSerialization.data(withJSONObject: object))
        let summary = FeedSummary(feed: .live, portfolio: portfolio)
        #expect(summary.isWarning)
        #expect(!summary.text.contains("$"))
    }

    @Test func aCompleteTotalDoesntWarn() throws {
        let summary = FeedSummary(feed: .live, portfolio: try realPortfolio(at: Date(), status: .complete))
        #expect(!summary.isWarning)
        #expect(summary.text == "+$74.28")
    }
}
