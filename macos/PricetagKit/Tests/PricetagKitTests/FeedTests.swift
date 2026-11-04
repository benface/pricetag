import Foundation
import Testing
@testable import PricetagKit

/// Answers from a script, and remembers what it was asked.
actor ScriptedSource: PortfolioSource {
    var answers: [Result<Portfolio, FetchError>]
    private(set) var methods: [CostMethod] = []

    init(_ answers: [Result<Portfolio, FetchError>]) {
        self.answers = answers
    }

    func portfolio(address: String, method: CostMethod, timeout: Duration) async throws -> Portfolio {
        methods.append(method)
        return try answers.removeFirst().get()
    }

    func explanation(of target: ExplainTarget, address: String, method: CostMethod) async throws -> Explanation {
        throw FetchError.unreachable
    }
}

/// `demoPortfolio()`, but from a real source, and with its newest block at a given time.
func realPortfolio(at date: Date, status: PnlStatus? = nil) throws -> Portfolio {
    var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(demoPortfolio())) as! [String: Any]
    object["mode"] = "raw"
    object["latest"] = ["blockNum": 53_505_400, "timestamp": date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))]
    if let status { object["pnlStatus"] = status.rawValue }
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
        #expect(summary.text == "Demo +$74.39")
    }

    @Test func anUnavailableTotalHasNoNumber() throws {
        let summary = FeedSummary(feed: .live, portfolio: try realPortfolio(at: Date(), status: .unavailable))
        #expect(summary.isWarning)
        #expect(summary.text == "PnL unavailable")
    }

    @Test func aCompleteTotalDoesntWarn() throws {
        let summary = FeedSummary(feed: .live, portfolio: try realPortfolio(at: Date(), status: .complete))
        #expect(!summary.isWarning)
        #expect(summary.text == "+$74.39")
    }
}
