import Foundation
import Testing
@testable import PricetagKit

private let a = "0x" + String(repeating: "a", count: 40)
private let b = "0x" + String(repeating: "b", count: 40)
private let c = "0x" + String(repeating: "c", count: 40)
private let d = "0x" + String(repeating: "d", count: 40)

/// Answers every read with all of the test's wallets as one, and remembers what it was asked for.
private actor AllYoursSource: PortfolioSource {
    private(set) var asked: [(address: String, linked: [String])] = []
    private(set) var proofs: [String] = []

    func portfolio(_ read: ReadContext, timeout: Duration) async throws -> Portfolio {
        asked.append((read.address, read.linked))
        return try resource("all-yours-portfolio", as: Portfolio.self)
    }

    func explanation(of target: ExplainTarget, _ read: ReadContext, shown: [String]?) async throws -> Explanation {
        throw FetchError.unreachable
    }

    func proof(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Proof {
        proofs.append(address)
        throw FetchError.unreachable
    }
}

/// Answers each read with the next of the test's answers.
private actor AnswersInTurn: PortfolioSource {
    private var answers: [Result<Portfolio, FetchError>]

    init(_ answers: [Result<Portfolio, FetchError>]) { self.answers = answers }

    func portfolio(_ read: ReadContext, timeout: Duration) async throws -> Portfolio {
        try answers.removeFirst().get()
    }

    func explanation(of target: ExplainTarget, _ read: ReadContext, shown: [String]?) async throws -> Explanation {
        throw FetchError.unreachable
    }

    func proof(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Proof {
        throw FetchError.unreachable
    }
}

/// Answers each read with the next of the test's answers, and explains and exports as the server does: it won't leave out a wallet it's told is showing.
private actor ForgetfulServer: PortfolioSource {
    private var answers: [Portfolio]
    /// The wallets it still has.
    var has: Set<String>
    private(set) var shownAsked: [[String]?] = []

    init(_ answers: [Portfolio], has: Set<String>) {
        self.answers = answers
        self.has = has
    }

    func forget(keeping wallets: Set<String>) { has = wallets }

    private func refusing(_ shown: [String]?) throws {
        shownAsked.append(shown)
        if !(shown ?? []).allSatisfy(has.contains) { throw FetchError.notCaughtUp("Not yet") }
    }

    func portfolio(_ read: ReadContext, timeout: Duration) async throws -> Portfolio {
        answers.removeFirst()
    }

    func explanation(of target: ExplainTarget, _ read: ReadContext, shown: [String]?) async throws -> Explanation {
        try refusing(shown)
        return Explanation(currency: .USD, title: "Value", value: "\(has.count) wallets", sourceValue: nil, lines: [], legCount: 0, legs: [])
    }

    func exportCSV(_ read: ReadContext, shown: [String]?) async throws -> String {
        try refusing(shown)
        return has.sorted().joined(separator: "\n")
    }

    func proof(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Proof {
        throw FetchError.unreachable
    }
}

/// Refuses every request the way the server does when a wallet that's showing isn't back, after noting what it was sent.
private final class BehindProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var bodies: [[String: Any]] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var data = Data()
            var chunk = [UInt8](repeating: 0, count: 65_536)
            while case let count = stream.read(&chunk, maxLength: chunk.count), count > 0 { data.append(chunk, count: count) }
            if let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { Self.bodies.append(body) }
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 409, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"error":"Not yet"}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

/// All Yours as the server would answer, from real data, with each wallet where it's got to and the numbers at `block`.
private func answer(_ states: KeyValuePairs<String, CombinedWallet.State>, block: Int, value: String = "1000000", currency: CurrencyCode = .USD, at now: Date) throws -> Portfolio {
    var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(try resource("all-yours-portfolio", as: Portfolio.self))) as! [String: Any]
    object["mode"] = "raw"
    object["currency"] = currency.rawValue
    object["latest"] = ["blockNum": block, "timestamp": now.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))]
    object["wallets"] = states.map { ["address": $0.key, "state": $0.value.rawValue] }
    let inState = { (state: CombinedWallet.State) in states.filter { $0.value == state }.map(\.key) }
    object["linkedReading"] = inState(.reading)
    object["linkedFailed"] = inState(.failed)
    object["linkedUpdating"] = inState(.updating)
    object["linkedOutdated"] = inState(.outdated)
    var totals = object["totals"] as! [String: Any]
    totals["valueMicros"] = value
    object["totals"] = totals
    return try JSONDecoder().decode(Portfolio.self, from: JSONSerialization.data(withJSONObject: object))
}

/// Answers every read with nothing still on its way, and remembers which wallets it was asked about.
private actor UpToDateServer: PortfolioSource {
    private(set) var asked: [[String]] = []

    func portfolio(_ read: ReadContext, timeout: Duration) async throws -> Portfolio {
        asked.append(read.linked)
        return try answer([a: .read, b: .read], block: 10, at: Date())
    }

    func explanation(of target: ExplainTarget, _ read: ReadContext, shown: [String]?) async throws -> Explanation {
        throw FetchError.unreachable
    }

    func proof(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Proof {
        throw FetchError.unreachable
    }
}

@MainActor
struct AllYoursTests {
    private func date(_ seconds: TimeInterval) -> Date { Date(timeIntervalSince1970: seconds) }

    private func allYoursStore(_ source: any PortfolioSource, at now: Date) -> PortfolioStore {
        let defaults = UserDefaults(suiteName: "all-yours-held-\(UUID().uuidString)")!
        defaults.set(WalletAddress.allYours, forKey: "wallet")
        return PortfolioStore(defaults: defaults, makeSource: { _ in source }, now: { now })
    }

    @Test func explainsAndExportsOnlyWhatCanIncludeEveryWalletShowing() async throws {
        let now = Date()
        let server = ForgetfulServer([
            try answer([a: .read, b: .read], block: 10, value: "2000000", at: now),
            // Slow, and the server's let go of its last answer, then failed, and then it's back.
            try answer([a: .read, b: .reading], block: 20, at: now),
            try answer([a: .read, b: .failed], block: 21, at: now),
            try answer([a: .read, b: .read], block: 22, value: "2100000", at: now),
        ], has: [a, b])
        let store = allYoursStore(server, at: now)
        _ = await store.poll()
        let target = ExplainTarget.total(.value)
        let open = ExplanationModel(fetch: { try await store.explanation(for: $0) })
        await open.show(store.explanationRequest(for: target))
        #expect(open.explanation?.value == "2 wallets")

        await server.forget(keeping: [a])
        for expected in [CombinedWallet.State.updating, .outdated] {
            _ = await store.poll()
            #expect(store.portfolio?.totals.valueMicros == "2000000")
            #expect(store.portfolio?.wallets?.map(\.state) == [.read, expected])
            // What's open stays, as the total does.
            await open.show(store.explanationRequest(for: target))
            await open.refresh()
            #expect(open.explanation?.value == "2 wallets")
            #expect(open.failure == nil)
            // Anything opened now says why there's nothing, and doesn't say something about one wallet.
            let opened = ExplanationModel(fetch: { try await store.explanation(for: $0) })
            await opened.show(store.explanationRequest(for: target))
            #expect(opened.explanation == nil)
            #expect(opened.failure == "Not yet")
            await #expect(throws: FetchError.notCaughtUp("Not yet")) { try await store.exportCSV() }
        }
        #expect(await server.shownAsked.allSatisfy { $0 == [a, b] })

        await server.forget(keeping: [a, b])
        _ = await store.poll()
        #expect(store.portfolio?.totals.valueMicros == "2100000")
        await open.refresh()
        #expect(open.explanation?.value == "2 wallets")
        #expect(try await store.exportCSV() == "\(a)\n\(b)")
    }

    @Test func asksOnlyForTheWalletsInTheNumbers() async throws {
        let now = Date()
        let server = ForgetfulServer([try answer([a: .read, b: .reading, c: .failed], block: 10, at: now)], has: [a])
        let store = allYoursStore(server, at: now)
        _ = await store.poll()
        #expect(store.explanationRequest(for: .total(.value))?.shown == [a])
        #expect(try await store.exportCSV() == a)
    }

    @Test func tellsTheServerWhatsShowingAndHearsWhenItsBehind() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [BehindProtocol.self]
        let client = PricetagClient(serverURL: URL(string: "http://127.0.0.1:1")!, configuration: configuration)
        await #expect(throws: FetchError.notCaughtUp("Not yet")) {
            try await client.exportCSV(ReadContext(address: WalletAddress.allYours, method: .average, currency: .USD, rule: nil, linked: [a, b], book: Book()), shown: [a, b])
        }
        await #expect(throws: FetchError.notCaughtUp("Not yet")) {
            try await client.explanation(of: .total(.value), ReadContext(address: WalletAddress.allYours, method: .average, currency: .USD, rule: nil, linked: [a, b], book: Book()), shown: [a])
        }
        #expect(BehindProtocol.bodies.compactMap { $0["shown"] as? [String] } == [[a, b], [a]])
    }

    @Test func keepsTheLastAnswerWhenTheServerHasForgottenIt() async throws {
        let now = Date()
        let first = try answer([a: .read, b: .read], block: 10, value: "2000000", at: now)
        let store = allYoursStore(AnswersInTurn([
            .success(first),
            // The server's let go of its last answer, and only has the wallet that's been read.
            .success(try answer([a: .read, b: .reading], block: 20, value: "1000000", at: now)),
            .success(try answer([a: .reading, b: .failed], block: 20, value: "1000000", at: now)),
            .success(try answer([a: .read, b: .read], block: 20, value: "2100000", at: now)),
        ]), at: now)
        _ = await store.poll()
        #expect(store.feed == .live)
        _ = await store.poll()
        #expect(store.portfolio?.totals == first.totals)
        #expect(store.portfolio?.latest.blockNum == 10, "with every wallet at the one block")
        #expect(store.portfolio?.wallets?.map(\.state) == [.read, .updating])
        #expect(store.portfolio?.linkedUpdating == [b])
        #expect(store.portfolio?.linkedReading == [])
        #expect(store.feed == .reading)
        #expect(MenuBarShows.allCases.allSatisfy { FeedSummary(feed: store.feed, portfolio: store.portfolio, shows: $0).text == "Updating…" })
        #expect(store.updatingNote == Wording.updatingLastRead(1))
        _ = await store.poll()
        #expect(store.portfolio?.totals == first.totals)
        #expect(store.portfolio?.linkedUpdating == [a])
        #expect(store.portfolio?.linkedOutdated == [b])
        #expect(store.feed == .walletsOutdated)
        _ = await store.poll()
        #expect(store.portfolio?.totals.valueMicros == "2100000")
        #expect(store.portfolio?.wallets?.map(\.state) == [.read, .read])
        #expect(store.feed == .live)
    }

    @Test func aWalletThatsNewStaysOutOfAKeptAnswer() throws {
        let now = Date()
        let last = try answer([a: .read, b: .read], block: 10, at: now)
        let held = try answer([a: .read, b: .reading, c: .read], block: 20, at: now).holding(last)
        #expect(held.wallets?.map(\.address) == [a, b, c])
        #expect(held.wallets?.map(\.state) == [.read, .updating, .reading])
        #expect(held.latest.blockNum == 10)
        #expect(held.linkedReading == [c])
        let failed = try answer([a: .read, b: .reading, c: .failed], block: 20, at: now).holding(last)
        #expect(failed.linkedFailed == [c])
    }

    @Test func onlyKeepsAnAnswerToTheSameQuestion() throws {
        let now = Date()
        let last = try answer([a: .read, b: .read], block: 10, at: now)
        let whole = try answer([a: .read, b: .read, c: .read], block: 20, at: now)
        #expect(whole.holding(last) == whole)
        let withoutOne = try answer([a: .read, c: .reading], block: 20, at: now)
        #expect(withoutOne.holding(last) == withoutOne, "b is no longer one of them")
        let otherCurrency = try answer([a: .read, b: .reading], block: 20, currency: .CAD, at: now)
        #expect(otherCurrency.holding(last) == otherCurrency)
        let serverKept = try answer([a: .updating, b: .outdated], block: 10, at: now)
        #expect(serverKept.holding(last) == serverKept)
        let notYetIn = try answer([a: .read, b: .reading], block: 10, at: now)
        #expect(try answer([a: .read, b: .read], block: 20, at: now).holding(notYetIn).wallets?.map(\.state) == [.read, .read])
    }

    @Test func oldNumbersAreNeverCalledLive() async throws {
        let now = Date()
        let cases: [(states: KeyValuePairs<String, CombinedWallet.State>, feed: FeedState, says: String, warns: Bool)] = [
            ([a: .updating, b: .read], .reading, "Updating…", false),
            ([a: .updating, b: .updating], .reading, "Updating…", false),
            ([a: .outdated, b: .read], .walletsOutdated, "Can't update", true),
            ([a: .outdated, b: .outdated], .walletsOutdated, "Can't update", true),
            ([a: .updating, b: .outdated], .walletsOutdated, "Can't update", true),
        ]
        for (states, feed, says, warns) in cases {
            let store = allYoursStore(AnswersInTurn([.success(try answer(states, block: 10, at: now))]), at: now)
            _ = await store.poll()
            #expect(store.feed == feed)
            #expect(!store.feed.isLive)
            for shows in MenuBarShows.allCases {
                let summary = FeedSummary(feed: store.feed, portfolio: store.portfolio, shows: shows)
                #expect(summary.text == says)
                #expect(summary.isWarning == warns)
            }
            // Which wallets, and what to do about them, are in the status's details, so this adds no second copy of them.
            #expect(store.feed.problem(serverURL: URL(string: "http://127.0.0.1:8787")!, portfolio: store.portfolio) == nil)
            #expect(store.feed.shortProblem(portfolio: store.portfolio) == nil)
        }
    }

    @Test func theStatusSaysWhichWalletsAreBehind() async throws {
        let now = Date()
        let names = [a: "Savings", b: "Spending Money"]
        let store = allYoursStore(AnswersInTurn([.success(try answer([a: .updating, b: .read], block: 10, at: now)), .success(try answer([a: .read, b: .outdated], block: 10, at: now))]), at: now)
        _ = await store.poll()
        #expect(store.statusMessages(names: names) == [Wording.allYoursUpdating(["Savings"])])
        #expect(store.hasStatusDetails)
        #expect(!store.canRetryStatus, "It's on its way already.")
        _ = await store.poll()
        #expect(store.statusMessages(names: names) == [Wording.allYoursOutdated(["Spending Money"])])
        #expect(store.hasStatusDetails)
        #expect(store.canRetryStatus)
    }

    @Test func transactionsSayWhichWalletAndCanBeFoundByIt() throws {
        let portfolio = try resource("all-yours-portfolio", as: Portfolio.self)
        let log = TransactionLog(points: portfolio.points, names: [b: "Savings"])
        #expect(log.items.first { $0.txHash == "0x2" }?.wallets == [a, b])
        #expect(log.filtered(query: "savings", asset: nil).map(\.txHash).contains("0x2"))
        #expect(!log.filtered(query: "savings", asset: nil).map(\.txHash).contains("0x1"))
    }

    @Test func holdingsCanBeFoundByWhichWallet() throws {
        let portfolio = try resource("all-yours-portfolio", as: Portfolio.self)
        let eth = try #require(portfolio.positions.first { $0.asset == "ETH" })
        #expect(eth.matches("savings", names: [c: "Savings"]))
        #expect(eth.matches("eth savings", names: [c: "Savings"]))
        #expect(eth.matches(c))
        #expect(!eth.matches("savings"))
        #expect(!eth.matches("usdc savings", names: [c: "Savings"]))
    }

    @Test func saysWhichWalletsAreInTheNumbersAsTheyWereLastRead() throws {
        var text = String(decoding: try Data(contentsOf: try #require(Bundle.module.url(forResource: "all-yours-portfolio", withExtension: "json", subdirectory: "Resources"))), as: UTF8.self)
        text = text.replacing("\"linkedUpdating\": []", with: "\"linkedUpdating\": [\"\(a)\"]").replacing("\"linkedOutdated\": []", with: "\"linkedOutdated\": [\"\(b)\"]")
        text = text.replacing("\"state\": \"reading\"", with: "\"state\": \"updating\"")
        let portfolio = try JSONDecoder().decode(Portfolio.self, from: Data(text.utf8))
        #expect(portfolio.linkedUpdating == [a])
        #expect(portfolio.linkedOutdated == [b])
        #expect(portfolio.wallets?.last?.state == .updating)
        #expect(Wording.allYoursUpdating(["Savings"]) == "Updating Savings. These numbers use its last read until then.")
        #expect(Wording.allYoursOutdated(["Savings", "Ledger 2"]) == "Couldn't update Savings and Ledger 2, so these numbers use their last read.")
        #expect(Wording.updatingLastRead(2) == "Updating. 2 wallets are being read again, and these numbers use their last read until then.")
    }

    @Test func readsWhatTheServerSends() throws {
        let portfolio = try resource("all-yours-portfolio", as: Portfolio.self)
        #expect(portfolio.isAllYours)
        #expect(portfolio.wallets?.map(\.state) == [.read, .read, .read, .reading])
        let eth = try #require(portfolio.positions.first { $0.asset == "ETH" })
        #expect(eth.wallets?.filter(\.hasUnknownCost).map(\.wallet) == [c])
        #expect(portfolio.totals.excluded.map(\.wallet) == [c])
        #expect(portfolio.transactions.first { $0.txHash == "0x2" }?.amount == TransactionAmount(direction: .trade, micros: "3000000000"))
        #expect(portfolio.transactions.first { $0.txHash == "0x2" }?.wallets == [a, b])
        #expect(portfolio.transactions.first { $0.txHash == "0x2" }?.summary == "Moved 1 ETH between your wallets")

        let explanation = try resource("all-yours-explanation", as: Explanation.self)
        #expect(explanation.parts?.map(\.wallet) == [a, b, c])
        // A move is the same leg in both wallets, and a list of them still tells them apart.
        #expect(Set(explanation.legs.map(\.rowID)).count == explanation.legs.count)
        #expect(explanation.legs.allSatisfy { $0.wallet != nil })
    }

    @Test func saysWhichWalletWhatsLeftOutIsIn() throws {
        let portfolio = try resource("all-yours-portfolio", as: Portfolio.self)
        let attention = try #require(portfolio.attention(names: [c: "Laptop"]))
        #expect([attention.title, attention.fullList].compactMap(\.self).contains { $0.contains("ETH in Laptop (unknown cost)") })
        #expect(Wording.excluded([Exclusion(asset: "ETH", reason: "unknown cost", wallet: c)]) == "Excludes ETH in \(Format.shortHash(c)) (unknown cost).")
    }

    @Test func isOfferedOnceThereAreTwoWalletsToAddUp() {
        let one = WalletList(spending: NamedWallet(address: a, name: "Spending Money"), savings: [], linked: [a], saved: [], current: a)
        #expect(one.allYours == nil)
        let two = WalletList(spending: NamedWallet(address: a, name: "Spending Money"), savings: [NamedWallet(address: b, name: "Ledger")], linked: [a, b], saved: [SavedWallet(address: d, name: "Treasury", lastSeen: date(1))], current: a)
        #expect(two.allYours?.title == "All Yours")
        #expect(two.allYours?.detail == "2 wallets")
        #expect(two.all.first?.kind == .allYours, "at the top")
        #expect(two.yours.map(\.address) == [a, b], "and never a wallet that's only watched")
        #expect(!two.pickable.contains { $0.kind == .allYours }, "it has no address to paste anywhere")
        #expect(two.allYours?.canRename == false && two.allYours?.canRemove == false)
        #expect(two.names[b] == "Ledger")
        // Still there while it's showing, whatever's happened to the list.
        let showing = WalletList(spending: nil, savings: [], linked: [a], saved: [], current: WalletAddress.allYours)
        #expect(showing.entry(for: WalletAddress.allYours)?.kind == .allYours)
        #expect(showing.recent.isEmpty, "and it's never a recent wallet")
    }

    @Test func comesBackAfterARelaunchAsAllYoursAndNothingElse() throws {
        let defaults = UserDefaults(suiteName: "all-yours-relaunch-\(UUID().uuidString)")!
        defaults.set(WalletAddress.allYours, forKey: "wallet")
        // What an earlier build could have saved.
        defaults.set(try JSONEncoder().encode([SavedWallet(address: WalletAddress.allYours, lastSeen: date(1)), SavedWallet(address: d, name: "Treasury", lastSeen: date(2))]), forKey: "savedWallets")
        defaults.set(try JSONEncoder().encode(Book().answering(a, .mine, focus: nil).answering(b, .mine, focus: nil)), forKey: "answers")
        let store = PortfolioStore(defaults: defaults, makeSource: { _ in AllYoursSource() })
        #expect(store.address == WalletAddress.allYours)
        let list = WalletList(spending: nil, savings: [], linked: store.book.linkedWallets, saved: store.savedWallets, current: store.address)
        #expect(list.all.filter { $0.address == WalletAddress.allYours }.map(\.kind) == [.allYours], "once, as itself")
        #expect(list.recent.isEmpty && list.watching.map(\.address) == [d])
        #expect(!list.pickable.contains { WalletAddress.isAllYours($0.address) })
        #expect(Set(list.all.map(\.id)).count == list.all.count)
        // Even if a saved list still has it, the list never shows it as a wallet.
        let stale = WalletList(spending: nil, savings: [], linked: [a, b], saved: [SavedWallet(address: WalletAddress.allYours, lastSeen: date(1))], current: WalletAddress.allYours)
        #expect(stale.recent.isEmpty && stale.watching.isEmpty)
    }

    @Test func readsEveryWalletOfYoursAsOne() async throws {
        let defaults = UserDefaults(suiteName: "all-yours-\(UUID().uuidString)")!
        let source = AllYoursSource()
        let store = PortfolioStore(defaults: defaults, makeSource: { _ in source })
        store.setLinkedWallets([a, b])
        store.setBook(store.book.answering(c, .mine, focus: nil))
        store.stop()
        store.setWallet(WalletAddress.allYours)
        store.stop()
        #expect(store.savedWallets.isEmpty, "it's not a wallet to remember")
        #expect(store.linked(for: WalletAddress.allYours) == [a, b, c])

        _ = await store.poll()
        let asked = await source.asked
        #expect(asked.last?.address == WalletAddress.allYours)
        #expect(asked.last?.linked == [a, b, c])
        #expect(store.portfolio?.isAllYours == true)
        // A wallet that's still being read is on its way, so the numbers say they're updating until it's in.
        #expect(store.updatingNote == Wording.updatingWallets(1))

        // Taking one off the list takes it out of All Yours, and a leg in one of them can show its proof.
        store.removeWallet(c, showing: nil)
        store.stop()
        #expect(store.linked(for: WalletAddress.allYours) == [a, b])
        await #expect(throws: FetchError.unreachable) { try await store.proof(leg: "0x2:ETH", address: b) }
        await #expect(throws: CancellationError.self) { try await store.proof(leg: "0x2:ETH", address: d) }
        #expect(await source.proofs == [b])
    }

    /// A failure rather than a test that never ends.
    private func until(_ condition: () async -> Bool) async throws {
        let deadline = Date.now.addingTimeInterval(10)
        while await !condition(), Date.now < deadline { try await Task.sleep(for: .milliseconds(2)) }
        #expect(await condition())
    }

    /// What's showing is whatever was chosen since launch, not what the app opened on.
    @Test func takingAWalletOffTheListChangesAllYoursChosenAfterLaunch() async throws {
        let defaults = UserDefaults(suiteName: "all-yours-\(UUID().uuidString)")!
        defaults.set(d, forKey: "wallet")
        let server = UpToDateServer()
        let store = PortfolioStore(defaults: defaults, makeSource: { _ in server })
        defer { store.stop() }
        store.setLinkedWallets([a, b, c])
        store.setWallet(WalletAddress.allYours)
        try await until { await server.asked.last == [a, b, c] && store.feed == .live }

        let removal = store.changeWallet(c, name: "Remove from List") { store.removeWallet(c, showing: nil) }
        #expect(store.feed == .reading, "the total on screen still has it")
        try await until { await server.asked.last == [a, b] && store.feed == .live }

        store.restore(removal)
        #expect(store.feed == .reading, "the total on screen still leaves it out")
        try await until { await server.asked.last == [a, b, c] && store.feed == .live }
    }

    /// Opened on All Yours, then moved on: the one wallet showing has nothing to do with the list.
    @Test func takingAWalletOffTheListLeavesAnotherWalletLive() async throws {
        let defaults = UserDefaults(suiteName: "all-yours-\(UUID().uuidString)")!
        defaults.set(WalletAddress.allYours, forKey: "wallet")
        let server = UpToDateServer()
        let store = PortfolioStore(defaults: defaults, makeSource: { _ in server })
        defer { store.stop() }
        store.setLinkedWallets([a, b, c])
        store.setWallet(d)
        try await until { store.feed == .live }

        store.removeWallet(c, showing: nil)
        #expect(store.feed == .live)
    }
}
