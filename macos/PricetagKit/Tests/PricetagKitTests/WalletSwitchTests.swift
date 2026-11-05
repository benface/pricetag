import Foundation
import Testing
@testable import PricetagKit

/// Holds each wallet's reads open until it's told how to answer, so a test can look at what's on screen in between.
actor HeldSource: PortfolioSource {
    private var waiting: [String: [CheckedContinuation<Portfolio, any Error>]] = [:]
    private var lastReads: [String: Portfolio] = [:]

    func setLastRead(_ portfolio: Portfolio, for address: String) {
        lastReads[address] = portfolio
    }

    func portfolio(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book, timeout: Duration) async throws -> Portfolio {
        try await withCheckedThrowingContinuation { waiting[address, default: []].append($0) }
    }

    func lastRead(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book) async throws -> Portfolio? {
        lastReads[address]
    }

    func explanation(of target: ExplainTarget, address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book) async throws -> Explanation {
        throw FetchError.unreachable
    }

    func waitUntilAsked(about address: String) async {
        let deadline = Date.now.addingTimeInterval(10)
        while waiting[address]?.isEmpty != false {
            guard Date.now < deadline else {
                Issue.record("Nothing asked about \(address).")
                return
            }
            try? await Task.sleep(for: .milliseconds(1))
        }
    }

    /// Every read of this wallet that's waiting, because one a change left behind can't be told from the one that counts, and nothing listens to it.
    func answer(_ address: String, _ result: Result<Portfolio, FetchError>) {
        for continuation in waiting[address] ?? [] { continuation.resume(with: result.mapError { $0 as any Error }) }
        waiting[address] = nil
    }

    /// Reads a change left behind, which nothing's waiting for by now.
    func finish() {
        for continuation in waiting.values.joined() { continuation.resume(throwing: CancellationError()) }
        waiting = [:]
    }
}

@MainActor
@Suite struct WalletSwitchTests {
    /// The real time, because a file's age is measured against it.
    let now = Date.now
    let walletA = "0x00000000000000000000000000000000000000aa"
    let walletB = "0x00000000000000000000000000000000000000bb"

    func numbers(_ address: String, method: CostMethod = .average, currency: CurrencyCode = .USD, block: Int = 53_505_400, secondsOld: TimeInterval = 0) throws -> Portfolio {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(realPortfolio(at: now.addingTimeInterval(-secondsOld), method: method, currency: currency))) as! [String: Any]
        object["address"] = address
        var latest = object["latest"] as! [String: Any]
        latest["blockNum"] = block
        object["latest"] = latest
        return try JSONDecoder().decode(Portfolio.self, from: JSONSerialization.data(withJSONObject: object))
    }

    func makeStore(_ source: any PortfolioSource, wallet: String?, directory: URL? = nil, defaults: UserDefaults? = nil) -> PortfolioStore {
        let defaults = defaults ?? UserDefaults(suiteName: "switch-tests-\(UUID().uuidString)")!
        if let wallet { defaults.set(wallet, forKey: "wallet") }
        let now = now
        return PortfolioStore(defaults: defaults, cacheDirectory: directory, makeSource: { _ in source }, now: { now }, reachableDelay: .seconds(600), unreachableDelay: .seconds(600), pushedDelay: .seconds(600))
    }

    /// Answers until `portfolio` is on screen, since the read that counts may not have asked yet.
    func answer(_ store: PortfolioStore, _ source: HeldSource, _ address: String, with portfolio: Portfolio) async {
        await until(store.portfolio == portfolio && store.feed != .reading) { await source.answer(address, .success(portfolio)) }
    }

    /// Answers with a failure until the store has heard it.
    func fail(_ store: PortfolioStore, _ source: HeldSource, _ address: String) async {
        await until(store.feed != .reading) { await source.answer(address, .failure(.unreachable)) }
    }

    /// A failure rather than a test that never ends.
    func until(_ condition: @autoclosure () -> Bool, doing step: () async -> Void = {}) async {
        let deadline = Date.now.addingTimeInterval(10)
        while !condition() {
            guard Date.now < deadline else {
                Issue.record("This never happened.")
                return
            }
            await step()
            try? await Task.sleep(for: .milliseconds(1))
        }
    }

    func tempDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appending(path: "portfolio-cache-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    /// Until a write that's been asked for is there.
    func waitForFile(in directory: URL, count: Int = 1) async throws {
        for _ in 0..<2000 {
            if (try FileManager.default.contentsOfDirectory(atPath: directory.path)).count == count { return }
            try await Task.sleep(for: .milliseconds(2))
        }
        Issue.record("The file never appeared.")
    }

    @Test func goingBackShowsThatWalletsNumbersAtOnceWithoutCallingThemCurrent() async throws {
        let source = HeldSource()
        let store = makeStore(source, wallet: walletA)
        store.start()
        let a = try numbers(walletA)
        await answer(store, source, walletA, with: a)

        store.setWallet(walletB)
        #expect(store.portfolio == nil, "there's nothing to show yet for a wallet this hasn't read")
        #expect(store.feed == .reading)
        #expect(store.updatingNote == nil, "with no numbers, the whole screen says it's reading")
        let b = try numbers(walletB)
        await answer(store, source, walletB, with: b)

        store.setWallet(walletA)
        #expect(store.portfolio == a, "in the same moment as the address")
        #expect(store.feed == .reading)
        #expect(!store.feed.isLive)
        #expect(store.updatingNote?.hasPrefix("Updating.") == true)
        #expect(FeedSummary(feed: store.feed, portfolio: store.portfolio).text == "Updating…")
        let newer = try numbers(walletA, block: 53_505_500)
        await answer(store, source, walletA, with: newer)
        #expect(store.feed == .live)
        #expect(store.updatingNote == nil)
        store.stop()
        await source.finish()
    }

    @Test func aFastDoubleSwitchNeverShowsAWalletsNumbersUnderAnother() async throws {
        let source = HeldSource()
        let store = makeStore(source, wallet: walletA)
        store.start()
        let a = try numbers(walletA)
        await answer(store, source, walletA, with: a)
        store.setWallet(walletB)
        let b = try numbers(walletB)
        await answer(store, source, walletB, with: b)

        // Straight back and forth, with nothing having time to run in between.
        store.setWallet(walletA)
        #expect(store.portfolio?.address == walletA)
        store.setWallet(walletB)
        #expect(store.portfolio?.address == walletB)
        store.setWallet(walletA)
        #expect(store.portfolio?.address == walletA)
        await source.waitUntilAsked(about: walletA)
        // And with a read left running, which answers late for the wallet it was asked about.
        store.setWallet(walletB)
        await source.waitUntilAsked(about: walletB)
        store.setWallet(walletA)
        #expect(store.portfolio?.address == walletA)
        await source.answer(walletB, .success(try numbers(walletB, block: 53_505_900)))
        try await Task.sleep(for: .milliseconds(50))
        #expect(store.address == walletA)
        #expect(store.portfolio == a)
        #expect(store.feed == .reading)
        store.stop()
        await source.finish()
    }

    @Test func aFailedReadSaysTheNumbersAreOldAndFromWhen() async throws {
        let source = HeldSource()
        let store = makeStore(source, wallet: walletA)
        store.start()
        let a = try numbers(walletA, secondsOld: 60)
        await answer(store, source, walletA, with: a)
        store.setWallet(walletB)
        await source.waitUntilAsked(about: walletB)
        store.setWallet(walletA)
        await fail(store, source, walletA)
        #expect(store.portfolio == a)
        #expect(!store.feed.isLive)
        let notice = try #require(store.feed.staleNotice(serverURL: store.serverURL, portfolio: store.portfolio))
        #expect(notice.contains("aren't updating"))
        #expect(notice.contains(Format.time(try #require(a.latest.date))))
        store.stop()
        await source.finish()
    }

    @Test func aSettingReadBeforeShowsAtOnceAndOneThatWasntKeepsTheNumbersUntilItsRead() async throws {
        let source = HeldSource()
        let store = makeStore(source, wallet: walletA)
        store.start()
        let average = try numbers(walletA)
        await answer(store, source, walletA, with: average)
        store.setMethod(.fifo)
        #expect(store.portfolio == average, "never read by this method, so the last numbers stay")
        #expect(store.feed == .reading)
        let fifo = try numbers(walletA, method: .fifo)
        await answer(store, source, walletA, with: fifo)

        store.setMethod(.average)
        #expect(store.portfolio == average)
        #expect(store.feed == .reading)
        await answer(store, source, walletA, with: average)
        store.setCurrency(.CAD)
        #expect(store.portfolio == average)
        // The server's own CAD numbers, whose amounts differ from the USD ones under the same "$".
        var cadObject = try JSONSerialization.jsonObject(with: JSONEncoder().encode(resource("demo-portfolio-cad", as: Portfolio.self))) as! [String: Any]
        cadObject["address"] = walletA
        cadObject["latest"] = (try JSONSerialization.jsonObject(with: JSONEncoder().encode(numbers(walletA))) as! [String: Any])["latest"]
        let cad = try JSONDecoder().decode(Portfolio.self, from: JSONSerialization.data(withJSONObject: cadObject))
        await answer(store, source, walletA, with: cad)
        store.setCurrency(.USD)
        #expect(store.portfolio == average)
        store.setWallet(walletB)
        await source.waitUntilAsked(about: walletB)
        store.setCurrency(.CAD)
        #expect(store.portfolio == nil, "another wallet's numbers don't stand in for this one's")
        store.setWallet(walletA)
        #expect(store.portfolio == cad, "the wallet's, in this currency")
        store.stop()
        await source.finish()
    }

    @Test func numbersBySomeOtherSettingGoIfTheRightOnesCantBeRead() async throws {
        let source = HeldSource()
        let store = makeStore(source, wallet: walletA)
        store.start()
        await answer(store, source, walletA, with: try numbers(walletA))
        store.setWallet(walletB)
        await source.waitUntilAsked(about: walletB)
        store.setMethod(.fifo)
        store.setWallet(walletA)
        #expect(store.portfolio?.method == .average, "shown while the read runs, and marked as updating")
        await fail(store, source, walletA)
        #expect(store.portfolio == nil, "they aren't old now, they're wrong")
        store.stop()
        await source.finish()
    }

    @Test func whatTheServerLastReadShowsWhileTheRealReadRunsAndIsntCalledLive() async throws {
        let source = HeldSource()
        let last = try numbers(walletA, block: 53_505_400)
        await source.setLastRead(last, for: walletA)
        let store = makeStore(source, wallet: walletA)
        store.start()
        await source.waitUntilAsked(about: walletA)
        #expect(store.portfolio == last)
        #expect(store.feed == .reading)
        await answer(store, source, walletA, with: try numbers(walletA, block: 53_505_450))
        #expect(store.portfolio?.latest.blockNum == 53_505_450)
        // Behind what's on screen, as after a reorg, so it stays out of the way.
        store.setBook(store.book.answering(walletB, .someoneElse, focus: nil))
        #expect(store.feed == .reading, "these numbers don't have that answer in them yet")
        await source.waitUntilAsked(about: walletA)
        #expect(store.portfolio?.latest.blockNum == 53_505_450)
        store.stop()
        await source.finish()
    }

    @Test func refreshingShowsAReadIsRunning() async throws {
        let source = HeldSource()
        let store = makeStore(source, wallet: walletA)
        store.start()
        await answer(store, source, walletA, with: try numbers(walletA))
        store.refresh()
        #expect(store.feed == .reading)
        #expect(store.portfolio != nil)
        store.stop()
        await source.finish()
    }

    @Test func aWalletsNumbersAreThereAtTheNextLaunchMarkedAsOld() async throws {
        let directory = try tempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let source = HeldSource()
        let store = makeStore(source, wallet: walletA, directory: directory)
        store.start()
        let a = try numbers(walletA)
        await answer(store, source, walletA, with: a)
        store.stop()
        await source.finish()
        try await waitForFile(in: directory)

        let next = makeStore(HeldSource(), wallet: walletA, directory: directory)
        #expect(next.portfolio == a, "before anything's been read")
        #expect(next.feed == .reading)
        #expect(!next.feed.isLive)
        #expect(next.updatingNote != nil)
    }

    @Test func nothingFromTheDiskCrossesWalletsOrServersOrSurvivesBeingUnreadable() async throws {
        let directory = try tempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let source = HeldSource()
        let defaults = UserDefaults(suiteName: "switch-tests-\(UUID().uuidString)")!
        let store = makeStore(source, wallet: walletA, directory: directory, defaults: defaults)
        store.start()
        await answer(store, source, walletA, with: try numbers(walletA))
        store.stop()
        await source.finish()
        try await waitForFile(in: directory)

        #expect(makeStore(HeldSource(), wallet: walletB, directory: directory).portfolio == nil)

        let otherServer = UserDefaults(suiteName: "switch-tests-\(UUID().uuidString)")!
        otherServer.set("http://127.0.0.1:9999", forKey: "serverURL")
        #expect(makeStore(HeldSource(), wallet: walletA, directory: directory, defaults: otherServer).portfolio == nil)

        // A file under one wallet's name holding another's is never believed, however it got there.
        let file = try #require(try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).first)
        let moved = directory.appending(path: file.lastPathComponent.replacing(walletA, with: walletB))
        try FileManager.default.copyItem(at: file, to: moved)
        #expect(makeStore(HeldSource(), wallet: walletB, directory: directory).portfolio == nil)

        try Data("not what this version wrote".utf8).write(to: file)
        #expect(makeStore(HeldSource(), wallet: walletA, directory: directory).portfolio == nil)
    }

    @Test func removingAWalletLeavesNothingBehind() async throws {
        let directory = try tempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let source = HeldSource()
        let store = makeStore(source, wallet: walletA, directory: directory)
        store.start()
        await answer(store, source, walletA, with: try numbers(walletA))
        try await waitForFile(in: directory)
        store.removeWallet(walletA, showing: walletB)
        try await waitForFile(in: directory, count: 0)
        store.setWallet(walletA)
        #expect(store.portfolio == nil)
        store.stop()
        await source.finish()
    }

    @Test func theDemoStaysOffTheDisk() async throws {
        let directory = try tempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let source = HeldSource()
        let store = makeStore(source, wallet: WalletAddress.demo, directory: directory)
        store.start()
        await answer(store, source, WalletAddress.demo, with: try demoPortfolio())
        store.stop()
        await source.finish()
        try await Task.sleep(for: .milliseconds(50))
        #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty)
    }

    @Test func aWalletNobodysLookedAtInAMonthIsCleared() async throws {
        let directory = try tempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let old = directory.appending(path: "\(walletA)-127.0.0.1-8787.json")
        try Data("{}".utf8).write(to: old)
        try FileManager.default.setAttributes([.modificationDate: now.addingTimeInterval(-40 * 24 * 3600)], ofItemAtPath: old.path)
        let recent = directory.appending(path: "\(walletB)-127.0.0.1-8787.json")
        try Data("{}".utf8).write(to: recent)
        try FileManager.default.setAttributes([.modificationDate: now], ofItemAtPath: recent.path)
        _ = makeStore(HeldSource(), wallet: nil, directory: directory)
        try await waitForFile(in: directory)
        #expect(FileManager.default.fileExists(atPath: recent.path))
    }

    /// The transactions list rebuilds whenever this changes, so it has to change with every new portfolio, read fresh or not.
    @Test func everyNewPortfolioHasItsOwnRevisionEvenWhenNoFreshReadArrives() async throws {
        let source = HeldSource()
        let store = makeStore(source, wallet: walletA)
        store.start()
        await answer(store, source, walletA, with: try numbers(walletA))
        let read = store.updatedAt
        let usd = store.portfolioRevision

        // The server's last read in the new currency, at the same block and with the same transactions, then a fresh read that fails.
        // The server's own CAD numbers, whose amounts differ from the USD ones under the same "$".
        var cadObject = try JSONSerialization.jsonObject(with: JSONEncoder().encode(resource("demo-portfolio-cad", as: Portfolio.self))) as! [String: Any]
        cadObject["address"] = walletA
        cadObject["latest"] = (try JSONSerialization.jsonObject(with: JSONEncoder().encode(numbers(walletA))) as! [String: Any])["latest"]
        let cad = try JSONDecoder().decode(Portfolio.self, from: JSONSerialization.data(withJSONObject: cadObject))
        await source.setLastRead(cad, for: walletA)
        store.setCurrency(.CAD)
        await until(store.portfolio?.currency == .CAD)
        #expect(store.portfolioRevision != usd)
        #expect(store.updatedAt == read, "nothing was read fresh, so this can't tell the lists apart")
        #expect(store.portfolio?.points.map(\.id) == (try numbers(walletA)).points.map(\.id))
        let cadRevision = store.portfolioRevision
        await fail(store, source, walletA)
        #expect(store.portfolio == cad)
        #expect(store.portfolioRevision == cadRevision, "a failure leaves the CAD numbers, so the list built from them stands")
        let log = TransactionLog(points: cad.points, currency: cad.currency)
        #expect(log.currency == .CAD)
        // The amounts are CAD's, which aren't USD's, even though both say "$".
        let receipt = try #require(log.items.last?.amount?.micros)
        #expect(receipt != (try numbers(walletA)).points.first?.amount?.micros)
        #expect(log.items.last?.amountText(log.currency) == "+\(Format.money(receipt, .CAD))")

        // Same currency, same block and transactions, but an answer changed what something cost.
        var changed = try JSONSerialization.jsonObject(with: JSONEncoder().encode(cad)) as! [String: Any]
        var points = changed["points"] as! [[String: Any]]
        let sale = try #require(points.firstIndex { $0["summary"] as? String == "Sold 0.5 ETH for 1,300 USDC" })
        points[sale]["gain"] = ["micros": "1000000", "estimated": false]
        changed["points"] = points
        let answered = try JSONDecoder().decode(Portfolio.self, from: JSONSerialization.data(withJSONObject: changed))
        await source.setLastRead(answered, for: walletA)
        store.setBook(store.book.answering(walletB, .someoneElse, focus: nil))
        await until(store.portfolio == answered)
        #expect(store.portfolioRevision != cadRevision)
        #expect(store.updatedAt == read)
        await source.finish()
    }
}
