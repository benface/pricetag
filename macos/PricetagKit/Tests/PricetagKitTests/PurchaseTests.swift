import Foundation
import Testing
@testable import PricetagKit

private let wallet = "0x3762620fbcb400b0f98365da4aad7d2a250e5d89"
private let hash = "0x" + String(repeating: "ab", count: 32)
private let paid = Money(micros: "25810000", currency: .USD)

private func delivered(id: String = "order", blockNum: Int? = 50, cost: Money? = paid, usd: String? = nil) -> OnrampOrder {
    OnrampOrder(id: id, status: .succeeded, asset: "ETH", units: "8000000000000000", wallet: wallet, network: "base", txHash: hash, blockNum: blockNum, cost: cost, costUsdMicros: usd)
}

/// Stands in for the server, one answer at a time.
private actor Orders: PortfolioSource {
    var orders: [OnrampOrder] = []
    var failure: FetchError?
    var page = "https://pay.coinbase.com/buy/select-asset?sessionToken=x"
    var asked = 0
    var askedFiat: Money?

    func say(_ orders: [OnrampOrder]) { self.orders = orders }
    func fail(_ error: FetchError?) { failure = error }
    func sendPage(_ url: String) { page = url }

    func portfolio(_ read: ReadContext, timeout: Duration) async throws -> Portfolio { throw FetchError.unreachable }
    func explanation(of target: ExplainTarget, _ read: ReadContext, shown: [String]?) async throws -> Explanation { throw FetchError.unreachable }
    func onrampCheckout(address: String, asset: String, cryptoAmount: String, fiat: Money?) async throws -> OnrampCheckout {
        if let failure { throw failure }
        askedFiat = fiat
        return OnrampCheckout(url: page, ref: "ref")
    }
    func onrampOrders(ref: String) async throws -> [OnrampOrder] {
        asked += 1
        if let failure { throw failure }
        return orders
    }
}

/// Holds the first read of "later" open, so a second check can start while the first is still going.
private actor PausingOrders: PortfolioSource {
    private(set) var laterReads = 0
    private var pause: CheckedContinuation<Void, Never>?
    var isPaused: Bool { pause != nil }

    func portfolio(_ read: ReadContext, timeout: Duration) async throws -> Portfolio { throw FetchError.unreachable }
    func explanation(of target: ExplainTarget, _ read: ReadContext, shown: [String]?) async throws -> Explanation { throw FetchError.unreachable }
    func onrampOrders(ref: String) async throws -> [OnrampOrder] {
        if ref == "older" { return [delivered(id: ref)] }
        laterReads += 1
        if laterReads == 1 { await withCheckedContinuation { pause = $0 } }
        return []
    }

    func release() {
        pause?.resume()
        pause = nil
    }
}

@MainActor
private func setup(match: PurchaseMatch.State? = nil, now: @escaping @Sendable () -> Date = { .now }) -> (PurchaseTracker, PortfolioStore, Orders, UserDefaults) {
    let defaults = UserDefaults(suiteName: "purchases-\(UUID())")!
    let source = Orders()
    let store = PortfolioStore(defaults: defaults, makeSource: { _ in source })
    return (PurchaseTracker(store: store, defaults: defaults, now: now, matchOf: { _ in match }), store, source, defaults)
}

@MainActor
struct PurchaseTrackerTests {
    @Test func whatWasTypedGoesToThePageAndStaysAsTyped() async throws {
        let (tracker, _, source, defaults) = setup()
        let typed = Money(micros: "28000000", currency: .CAD)
        _ = try await tracker.begin(wallet: wallet, asset: "ETH", dollars: 20, cryptoAmount: "0.008", typed: typed)
        #expect(await source.askedFiat == typed)
        let started = try #require(tracker.purchases(of: wallet).first)
        #expect(PurchaseWording.title(started, beside: .CAD) == "$28 of ETH")
        #expect(PurchaseWording.title(started, beside: .USD) == "CA$28 of ETH")
        let reloaded = PurchaseTracker(store: PortfolioStore(defaults: defaults, makeSource: { _ in source }), defaults: defaults, matchOf: { _ in nil })
        #expect(reloaded.purchases(of: wallet).first?.typed == typed)
    }

    /// Typed in USD, or saved before amounts in other currencies. It's a past amount, so today's rate has nothing to say about it.
    @Test func aPurchaseInUSDStaysInUSD() throws {
        let saved = #"{"ref":"r","wallet":"\#(wallet)","asset":"ETH","dollars":25,"startedAt":0}"#
        let purchase = try JSONDecoder().decode(TrackedPurchase.self, from: Data(saved.utf8))
        #expect(purchase.typed == nil)
        #expect(PurchaseWording.title(purchase, beside: .USD) == "$25 of ETH")
        #expect(PurchaseWording.title(purchase, beside: .CAD) == "US$25 of ETH")
    }

    @Test func anAbsurdAmountDoesntTrap() {
        let purchase = TrackedPurchase(ref: "r", wallet: wallet, asset: "ETH", dollars: .max, startedAt: .now)
        #expect(PurchaseWording.title(purchase, beside: .USD).hasSuffix(" of ETH"))
    }

    @Test func nothingUSDIsSentAsWhatWasTyped() async throws {
        let (tracker, _, source, _) = setup()
        _ = try await tracker.begin(wallet: wallet, asset: "ETH", dollars: 25, cryptoAmount: "0.008")
        #expect(await source.askedFiat == nil)
        #expect(tracker.purchases(of: wallet).first?.typed == nil)
    }

    @Test func aCostSaysWhichDollarsOnlyBesideAnotherCurrency() {
        let usd = PurchasePhase.recorded(paid)
        let cad = PurchasePhase.recorded(Money(micros: "25810000", currency: .CAD))
        #expect(PurchaseWording.status(usd, beside: .USD) == "Cost $25.81, fees included")
        #expect(PurchaseWording.status(usd, beside: .CAD) == "Cost US$25.81, fees included")
        #expect(PurchaseWording.status(cad, beside: .CAD) == "Cost $25.81, fees included")
        #expect(PurchaseWording.status(cad, beside: .USD) == "Cost CA$25.81, fees included")
        for (currency, text) in [(CurrencyCode.EUR, "€25.81"), (.GBP, "£25.81"), (.CHF, "CHF\u{00A0}25.81")] {
            let paid = PurchasePhase.recorded(Money(micros: "25810000", currency: currency))
            #expect(PurchaseWording.status(paid, beside: .USD) == "Cost \(text), fees included")
            #expect(PurchaseWording.status(paid, beside: .CAD) == "Cost \(text), fees included")
        }
    }

    @Test func theSheetSaysWhatThePageWillDo() {
        #expect(PurchaseWording.checkoutNote(MoneyDisplay(main: .USD)) == "You'll need a Coinbase account. Its fees are added, and that total becomes the cost here.")
        #expect(PurchaseWording.checkoutNote(MoneyDisplay(main: .CAD, rateMicros: "1400000")).contains("starts at this amount in CAD"))
        #expect(PurchaseWording.checkoutNote(MoneyDisplay(main: .CAD)).hasPrefix("There's no current USD to CAD rate, so this is in US dollars"))
        // Its page only starts from an amount in USD, CAD, GBP and EUR, so in anything else it doesn't promise to.
        for main in [CurrencyCode.CHF, .AUD, .MXN, .ZAR] {
            let note = PurchaseWording.checkoutNote(MoneyDisplay(main: main, rateMicros: "1400000"))
            #expect(note.contains("can't start from an amount in \(main.rawValue)"), "\(main)")
            #expect(!note.contains("starts at this amount"), "\(main)")
        }
        #expect(PurchaseWording.checkoutNote(MoneyDisplay(main: .EUR, rateMicros: "900000")).contains("starts at this amount in EUR"))
    }

    @Test func followsAnOrderFromThePageToItsCost() async throws {
        let (tracker, store, source, _) = setup()
        let page = try await tracker.begin(wallet: wallet.uppercased().replacing("0X", with: "0x"), asset: "ETH", dollars: 25, cryptoAmount: "0.008")
        #expect(page.host() == "pay.coinbase.com")
        let started = try #require(tracker.purchases(of: wallet).first)
        #expect(tracker.phase(of: started) == .onProvidersPage)

        await source.say([OnrampOrder(id: "order", status: .pending)])
        await tracker.check()
        #expect(tracker.phase(of: tracker.purchases(of: wallet)[0]) == .onItsWay)
        #expect(store.book.purchases.isEmpty)

        await source.say([delivered()])
        await tracker.check()
        #expect(store.book.purchases.map(\.cost) == [paid])
        #expect(store.book.purchases.first?.txHash == hash)
        #expect(tracker.phase(of: tracker.purchases(of: wallet)[0]) == .arriving)
    }

    @Test func recordsNoCostUntilAnOrderSaysAllOfIt() {
        #expect(delivered(cost: nil).purchase == nil, "Nothing said what it cost")
        #expect(delivered(cost: nil, usd: "25810000").purchase?.cost == paid, "Its USD total is still what it cost")
        #expect(OnrampOrder(id: "x", status: .pending, asset: "ETH", units: "1", wallet: wallet, txHash: hash, cost: paid).purchase == nil)
        #expect(OnrampOrder(id: "x", status: .failed, asset: "ETH", units: "1", wallet: wallet, txHash: hash, cost: paid).purchase == nil)
        #expect(OnrampOrder(id: "x", status: .succeeded, asset: "ETH", units: "1", wallet: wallet, cost: paid).purchase == nil, "Nothing to match it to")
    }

    @Test func eachStateReads() {
        let (tracker, _, _, _) = setup(match: .recorded)
        func phase(_ order: OnrampOrder?, age: TimeInterval = 1) -> PurchasePhase {
            tracker.phase(of: TrackedPurchase(ref: "r", wallet: wallet, asset: "ETH", dollars: 25, startedAt: .now.addingTimeInterval(-age), order: order))
        }
        #expect(phase(nil, age: 3 * 60 * 60) == .noOrderYet, "A long wait says nothing about whether someone paid")
        #expect(phase(OnrampOrder(id: "x", status: .failed, failure: .delivery)) == .failed(.delivery))
        #expect(phase(OnrampOrder(id: "x", status: .failed)) == .failed(.payment))
        #expect(phase(delivered()) == .recorded(paid))
        #expect(phase(delivered(cost: nil)) == .costNotSaid, "Delivered, and it never said what it cost")
        #expect(phase(OnrampOrder(id: "x", status: .succeeded, asset: "ETH", units: "1", wallet: wallet, txHash: hash, blockNum: 50, paidIn: "SEK")) == .noRateFor("SEK"))
        #expect(phase(OnrampOrder(id: "x", status: .succeeded, asset: "ETH", units: "1", wallet: wallet)) == .onItsWay, "Done, with nothing on the chain yet")
        let (waiting, _, _, _) = setup(match: .waiting)
        func arriving(blockNum: Int?, age: TimeInterval) -> PurchasePhase {
            waiting.phase(of: TrackedPurchase(ref: "r", wallet: wallet, asset: "ETH", dollars: 25, startedAt: .now.addingTimeInterval(-age), order: delivered(blockNum: blockNum)))
        }
        #expect(arriving(blockNum: nil, age: 60) == .arriving)
        #expect(arriving(blockNum: 50, age: 3 * 60 * 60) == .arriving, "Its block is known, so it's only that the read is behind")
        #expect(arriving(blockNum: nil, age: 3 * 60 * 60) == .costUnknown, "Its hash never led anywhere")
        let (unmatched, _, _, _) = setup(match: .unmatched)
        #expect(unmatched.phase(of: TrackedPurchase(ref: "r", wallet: wallet, asset: "ETH", dollars: 25, startedAt: .now, order: delivered())) == .costUnknown)
    }

    @Test func anOrderWithNoCostRecordsNothingAndStopsBeingAskedAbout() async throws {
        let (tracker, store, source, _) = setup()
        _ = try await tracker.begin(wallet: wallet, asset: "ETH", dollars: 25, cryptoAmount: "0.008")
        await source.say([delivered(cost: nil)])
        await tracker.check()
        #expect(store.book.purchases.isEmpty, "So what arrived is asked about as usual")
        #expect(tracker.phase(of: tracker.purchases[0]) == .costNotSaid)
    }

    @Test func paidInACurrencyWithNoRateIsAskedAboutAndSaysWhy() async throws {
        let (tracker, store, source, _) = setup()
        _ = try await tracker.begin(wallet: wallet, asset: "ETH", dollars: 25, cryptoAmount: "0.008")
        await source.say([OnrampOrder(id: "order", status: .succeeded, asset: "ETH", units: "1", wallet: wallet, txHash: hash, blockNum: 50, paidIn: "SEK")])
        await tracker.check()
        #expect(store.book.purchases.isEmpty, "So what arrived is asked about as usual")
        let phase = tracker.phase(of: tracker.purchases[0])
        #expect(phase.isFinished)
        #expect(PurchaseWording.isWarning(phase))
        #expect(PurchaseWording.status(phase, beside: .CAD) == "Cost unknown. There's no exchange rate for SEK")
    }

    @Test func aPurchaseInEurosIsRecordedInEuros() async throws {
        let euros = Money(micros: "46200000", currency: .EUR)
        let (tracker, store, source, _) = setup(match: .recorded)
        _ = try await tracker.begin(wallet: wallet, asset: "ETH", dollars: 25, cryptoAmount: "0.008")
        await source.say([delivered(cost: euros, usd: "50000000")])
        await tracker.check()
        #expect(store.book.purchases.first?.cost == euros)
        #expect(store.book.purchases.first?.costUsdMicros == "50000000")
        #expect(PurchaseWording.status(tracker.phase(of: tracker.purchases[0]), beside: .CAD) == "Cost €46.20, fees included")
    }

    @Test func anOrderSavedBeforePaidInExistedStillReads() throws {
        let saved = #"{"provider":"coinbase","id":"x","status":"succeeded"}"#
        #expect(try JSONDecoder().decode(OnrampOrder.self, from: Data(saved.utf8)).paidIn == nil)
    }

    @Test func picksUpWhatWasStillGoingAfterARestart() async throws {
        let (tracker, _, source, defaults) = setup()
        _ = try await tracker.begin(wallet: wallet, asset: "ETH", dollars: 25, cryptoAmount: "0.008")
        await source.say([OnrampOrder(id: "order", status: .pending)])
        await tracker.check()

        let store = PortfolioStore(defaults: defaults, makeSource: { _ in source })
        let again = PurchaseTracker(store: store, defaults: defaults, matchOf: { _ in nil })
        #expect(again.purchases(of: wallet).count == 1)
        #expect(again.phase(of: again.purchases(of: wallet)[0]) == .onItsWay)
        await source.say([delivered()])
        await again.check()
        #expect(store.book.purchases.count == 1)
    }

    @Test func keepsAPurchaseWhenItCantCheck() async throws {
        let (tracker, store, source, _) = setup()
        _ = try await tracker.begin(wallet: wallet, asset: "ETH", dollars: 25, cryptoAmount: "0.008")
        await source.fail(.ampUnavailable("Coinbase can't be reached right now."))
        await tracker.check()
        #expect(tracker.problem == "Coinbase can't be reached right now.")
        #expect(tracker.purchases.count == 1)
        #expect(store.book.purchases.isEmpty)
        await source.fail(nil)
        await source.say([delivered()])
        await tracker.check()
        #expect(tracker.problem == nil)
        #expect(store.book.purchases.count == 1)
    }

    @Test func saysWhyAPurchaseCantStart() async throws {
        let (tracker, _, source, _) = setup()
        await source.fail(.noAmpConfigured("Buying isn't set up on this server."))
        await #expect(throws: FetchError.noAmpConfigured("Buying isn't set up on this server.")) {
            _ = try await tracker.begin(wallet: wallet, asset: "ETH", dollars: 25, cryptoAmount: "0.008")
        }
        #expect(tracker.purchases.isEmpty)
    }

    @Test func wontOpenAnyPageButCoinbases() async throws {
        let (tracker, _, source, _) = setup()
        for page in ["https://pay.coinbase.com.evil.example/buy", "http://pay.coinbase.com/buy", "https://evil.example/pay.coinbase.com"] {
            await source.sendPage(page)
            await #expect(throws: FetchError.self) {
                _ = try await tracker.begin(wallet: wallet, asset: "ETH", dollars: 25, cryptoAmount: "0.008")
            }
        }
        #expect(tracker.purchases.isEmpty)
    }

    @Test func aDeliveryWithNoBlockIsAskedAboutAgainAndTakesOver() async throws {
        let (tracker, store, source, _) = setup()
        _ = try await tracker.begin(wallet: wallet, asset: "ETH", dollars: 25, cryptoAmount: "0.008")
        await source.say([delivered(blockNum: nil)])
        await tracker.check()
        #expect(store.book.purchases.map(\.blockNum) == [nil])
        await source.say([delivered()])
        await tracker.check()
        #expect(store.book.purchases.map(\.blockNum) == [50])
        // The loop `begin` started may still have a read on its way.
        try await Task.sleep(for: .milliseconds(100))
        let asked = await source.asked
        await tracker.check()
        #expect(await source.asked == asked, "There's nothing left to ask about")
    }

    /// What a restart finds: something from hours ago, with its answer waiting at the provider.
    private func restarted(with old: TrackedPurchase, answer: [OnrampOrder]) async throws -> (PurchaseTracker, PortfolioStore, Orders) {
        let (_, store, source, defaults) = setup()
        defaults.set(try JSONEncoder().encode([old]), forKey: "purchases")
        await source.say(answer)
        return (PurchaseTracker(store: store, defaults: defaults, pollDelay: .milliseconds(5), matchOf: { _ in .recorded }), store, source)
    }

    private func until(_ condition: @MainActor () async -> Bool) async throws {
        let deadline = Date.now.addingTimeInterval(30)
        while await !condition(), Date.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
    }

    private func old(_ order: OnrampOrder? = nil) -> TrackedPurchase {
        TrackedPurchase(ref: "ref", wallet: wallet, asset: "ETH", dollars: 25, startedAt: .now.addingTimeInterval(-3 * 60 * 60), order: order)
    }

    @Test func anOrderPaidForWhileTheAppWasClosedGetsItsCostOnStart() async throws {
        let (tracker, store, source) = try await restarted(with: old(), answer: [delivered()])
        #expect(tracker.phase(of: tracker.purchases[0]) == .noOrderYet)
        tracker.start()
        try await until { store.book.purchases.count == 1 }
        #expect(store.book.purchases.map(\.cost) == [paid])
        #expect(tracker.phase(of: tracker.purchases[0]) == .recorded(paid))
        #expect(await source.asked >= 1)
    }

    @Test func anOrderPaidForLongAgoAlsoGetsItsCostOnComingBack() async throws {
        let (tracker, store, _) = try await restarted(with: old(), answer: [delivered()])
        await tracker.check()
        #expect(store.book.purchases.map(\.cost) == [paid])
    }

    @Test func aDeliverysBlockThatTurnsUpLateStillFindsABatchedPayout() async throws {
        let (tracker, store, _) = try await restarted(with: old(delivered(blockNum: nil)), answer: [delivered()])
        tracker.start()
        try await until { store.book.purchases.first?.blockNum == 50 }
        #expect(store.book.purchases.map(\.blockNum) == [50])
        #expect(tracker.purchases[0].order?.blockNum == 50)
    }

    @Test func somethingOldIsReadOnceAndNotPolled() async throws {
        let (tracker, _, source) = try await restarted(with: old(), answer: [])
        tracker.start()
        try await until { await source.asked >= 1 }
        try await Task.sleep(for: .milliseconds(100))
        #expect(await source.asked == 1, "It's asked about again when the app comes back")
        #expect(tracker.phase(of: tracker.purchases[0]) == .noOrderYet)
        await tracker.check()
        #expect(await source.asked == 2)
    }

    @Test func somethingRecentKeepsBeingPolled() async throws {
        let recent = TrackedPurchase(ref: "ref", wallet: wallet, asset: "ETH", dollars: 25, startedAt: .now)
        let (tracker, _, source) = try await restarted(with: recent, answer: [])
        tracker.start()
        try await until { await source.asked >= 3 }
        #expect(await source.asked >= 3)
        tracker.dismiss(tracker.purchases[0])
    }

    @Test func whatsUnresolvedIsNeverTrimmedAway() async throws {
        let (_, store, source, defaults) = setup()
        let settled = (0..<8).map { TrackedPurchase(ref: "done\($0)", wallet: wallet, asset: "ETH", dollars: 25, startedAt: .now, order: delivered(id: "done\($0)")) }
        defaults.set(try JSONEncoder().encode([old()] + settled), forKey: "purchases")
        await source.say([])
        let tracker = PurchaseTracker(store: store, defaults: defaults, matchOf: { _ in nil })
        await tracker.check()
        #expect(tracker.purchases.contains { $0.ref == "ref" })
        #expect(tracker.purchases.count == 6, "That and the newest five")
    }

    private func finishing(_ refs: [String], after newer: Int) async throws -> (PurchaseTracker, PortfolioStore, Orders) {
        let (_, store, source, defaults) = setup()
        let going = refs.map { TrackedPurchase(ref: $0, wallet: wallet, asset: "ETH", dollars: 25, startedAt: .now, order: OnrampOrder(id: $0, status: .pending)) }
        let settled = (0..<newer).map { TrackedPurchase(ref: "done\($0)", wallet: wallet, asset: "ETH", dollars: 25, startedAt: .now, order: delivered(id: "done\($0)")) }
        defaults.set(try JSONEncoder().encode(going + settled), forKey: "purchases")
        await source.say([delivered(id: "older")])
        return (PurchaseTracker(store: store, defaults: defaults, matchOf: { _ in .recorded }), store, source)
    }

    @Test func anOlderPurchaseThatFinishesLastKeepsItsRow() async throws {
        let (tracker, store, _) = try await finishing(["older"], after: 5)
        await tracker.check()
        #expect(store.book.purchases.map(\.order) == ["older"])
        #expect(tracker.purchases.map(\.ref) == ["older", "done1", "done2", "done3", "done4"], "It stays, and the oldest of what's already been seen goes")
        await tracker.check()
        #expect(tracker.purchases.map(\.ref) == ["older", "done1", "done2", "done3", "done4"], "And it's still there the next time")
    }

    @Test func olderPurchasesThatFinishTogetherAllKeepTheirRows() async throws {
        let (tracker, _, _) = try await finishing(["older", "older2"], after: 5)
        await tracker.check()
        #expect(tracker.purchases.map(\.ref) == ["older", "older2", "done2", "done3", "done4"])
    }

    @Test func aCheckDuringAnotherLeavesWhatItJustFinishedAlone() async throws {
        let defaults = UserDefaults(suiteName: "purchases-\(UUID())")!
        let source = PausingOrders()
        let store = PortfolioStore(defaults: defaults, makeSource: { _ in source })
        let going = ["older", "later"].map { TrackedPurchase(ref: $0, wallet: wallet, asset: "ETH", dollars: 25, startedAt: .now, order: OnrampOrder(id: $0, status: .pending)) }
        let settled = (0..<5).map { TrackedPurchase(ref: "done\($0)", wallet: wallet, asset: "ETH", dollars: 25, startedAt: .now, order: delivered(id: "done\($0)")) }
        defaults.set(try JSONEncoder().encode(going + settled), forKey: "purchases")
        let tracker = PurchaseTracker(store: store, defaults: defaults, matchOf: { _ in .recorded })

        let first = Task { await tracker.check() }
        let deadline = Date.now.addingTimeInterval(5)
        while await !source.isPaused, Date.now < deadline { await Task.yield() }
        #expect(await source.isPaused, "The first check has finished older and is waiting on later")
        await tracker.check()
        #expect(tracker.purchases.map(\.ref) == ["older", "later", "done1", "done2", "done3", "done4"], "The second one knows what the first just saw finish")
        await source.release()
        await first.value

        #expect(store.book.purchases.map(\.order) == ["older"])
        #expect(tracker.purchases.map(\.ref) == ["older", "later", "done1", "done2", "done3", "done4"], "It stays once both are done, and the oldest of what's already been seen goes")
        await tracker.check()
        #expect(tracker.purchases.map(\.ref) == ["older", "later", "done1", "done2", "done3", "done4"], "And it's still there the next time")
    }

    @Test func aPurchaseSeenFinishedIsTrimmedInItsTurn() async throws {
        let (tracker, _, source) = try await finishing(["older"], after: 5)
        await tracker.check()
        await source.say([delivered(id: "newest")])
        _ = try await tracker.begin(wallet: wallet, asset: "ETH", dollars: 25, cryptoAmount: "0.008")
        try await until { tracker.purchases.count == 5 && tracker.purchases.last?.order?.id == "newest" }
        #expect(tracker.purchases.map(\.ref) == ["done1", "done2", "done3", "done4", "ref"], "A later one finishing makes room from the top, as it always has")
    }

    @Test func dismissingForgetsThePurchaseAndNotItsCost() async throws {
        let (tracker, store, source, _) = setup()
        _ = try await tracker.begin(wallet: wallet, asset: "ETH", dollars: 25, cryptoAmount: "0.008")
        await source.say([delivered()])
        await tracker.check()
        tracker.dismiss(tracker.purchases[0])
        #expect(tracker.purchases.isEmpty)
        #expect(store.book.purchases.count == 1)
    }
}

@MainActor
struct PurchaseBookTests {
    @Test func aBookSavedBeforePurchasesStillReads() throws {
        let saved = #"{"senders":{},"costs":{},"withdrawals":[]}"#
        #expect(try JSONDecoder().decode(Book.self, from: Data(saved.utf8)).purchases == [])
    }

    @Test func undoingAnAnswerDoesntLoseAPurchase() throws {
        let (_, store, _, _) = setup()
        store.setBook(store.book.enteringCost("k", paid))
        store.recordPurchase(try #require(delivered().purchase))
        store.undo()
        #expect(store.book.costs.isEmpty)
        #expect(store.book.purchases.count == 1)
        store.undo()
        #expect(store.book.purchases.count == 1, "A purchase isn't an answer, so there's nothing of it to undo")
    }

    @Test func aPurchaseGoesToTheServerInTheBook() throws {
        let book = Book().recording(try #require(delivered().purchase))
        let json = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(book)) as? [String: Any])
        let first = try #require((json["purchases"] as? [[String: Any]])?.first)
        #expect(first["provider"] as? String == "coinbase")
        #expect((first["cost"] as? [String: String])?["micros"] == "25810000")
        #expect(first["blockNum"] as? Int == 50)
    }

    @Test func aNewerReadOfAnOrderTakesOver() throws {
        let book = Book().recording(try #require(delivered(blockNum: nil).purchase)).recording(try #require(delivered().purchase))
        #expect(book.purchases.map(\.blockNum) == [50])
    }
}

@Suite struct PurchaseNoticeTests {
    private let purchase = TrackedPurchase(ref: "ref", wallet: wallet, asset: "ETH", dollars: 25, startedAt: .now, order: delivered())

    private func notice(_ told: PurchaseMilestone, _ phase: PurchasePhase) -> MoneyNotice? {
        PurchaseWording.notice(for: purchase, phase: phase, after: told, beside: .USD)
    }

    @Test func nothingForWhatsStillOnThePage() {
        #expect(notice(.started, .onItsWay) == nil)
        #expect(notice(.started, .noOrderYet) == nil)
    }

    @Test func deliveredThenRecordedIsOneNotificationThatsReplaced() {
        let delivered = notice(.started, .arriving)
        let recorded = notice(.delivered, .recorded(paid))
        #expect(delivered?.title == "Purchase Delivered")
        #expect(delivered?.body == "0.008 ETH arrived from Coinbase. Its cost is recorded once it shows up here.")
        #expect(recorded?.title == "Purchase Cost Recorded")
        #expect(recorded?.body == "0.008 ETH arrived. It cost $25.81, fees included.")
        #expect(delivered?.id == recorded?.id, "the second replaces the first")
        #expect(recorded?.row == MoneyNotice.purchaseRow("ref"))
    }

    @Test func skippingStraightToTheCostIsStillADelivery() {
        #expect(notice(.started, .recorded(paid))?.title == "Purchase Delivered")
    }

    @Test func nothingThatsAlreadyBeenTold() {
        #expect(notice(.delivered, .arriving) == nil)
        #expect(notice(.finished, .arriving) == nil)
        #expect(notice(.finished, .recorded(paid)) == nil)
    }

    @Test func anUnknownCostSaysSo() {
        #expect(notice(.delivered, .costUnknown)?.title == "Purchase Cost Unknown")
        #expect(notice(.costUnknown, .costUnknown) == nil)
        #expect(notice(.costUnknown, .recorded(paid))?.title == "Purchase Cost Recorded", "and saying it's known later still is news")
        #expect(notice(.started, .noRateFor("SEK"))?.body == "0.008 ETH arrived, but its cost is unknown: there's no exchange rate for SEK.")
    }

    @Test func aFailureSaysNothingWasBought() {
        #expect(notice(.started, .failed(.payment))?.body == "Coinbase couldn't take the payment for 0.008 ETH. Nothing was bought.")
        #expect(notice(.started, .failed(.delivery))?.title == "Purchase Didn't Arrive")
    }
}

/// What the app keeps between launches, driven by a real tracker whose cost match comes and goes with the wallet that's chosen.
@MainActor
struct PurchaseNewsTests {
    private final class Shown { var match: PurchaseMatch.State? }

    private final class Clock: @unchecked Sendable { var now = Date.now }

    private func rig(clock: Clock = Clock()) -> (PurchaseTracker, Orders, Shown) {
        let defaults = UserDefaults(suiteName: "purchases-\(UUID())")!
        let source = Orders()
        let shown = Shown()
        let store = PortfolioStore(defaults: defaults, makeSource: { _ in source })
        return (PurchaseTracker(store: store, defaults: defaults, now: { clock.now }, matchOf: { _ in shown.match }), source, shown)
    }

    /// A delivery whose block takes hours to show is called unknown, and a late block and match can still record its cost.
    @Test func anUnknownCostThatBecomesKnownIsToldOnce() async throws {
        let clock = Clock()
        let (tracker, source, shown) = rig(clock: clock)
        var news = PurchaseNews()
        _ = try await tracker.begin(wallet: wallet, asset: "ETH", dollars: 25, cryptoAmount: "0.008")
        _ = news.update(phases(tracker), beside: .USD)
        clock.now += 3 * 60 * 60
        await source.say([delivered(id: "ref", blockNum: nil)])
        await tracker.check()
        #expect(tracker.phase(of: tracker.purchases[0]) == .costUnknown)
        let unknown = news.update(phases(tracker), beside: .USD)
        #expect(unknown.map(\.title) == ["Purchase Delivered"])
        #expect(unknown.first?.body.contains("its cost is unknown") == true)

        // A relaunch, and then its block and its match arrive.
        var relaunched = try JSONDecoder().decode(PurchaseNews.self, from: JSONEncoder().encode(news))
        await source.say([delivered(id: "ref")])
        await tracker.check()
        shown.match = .recorded
        let known = relaunched.update(phases(tracker), beside: .USD)
        #expect(known.map(\.title) == ["Purchase Cost Recorded"])
        #expect(known.first?.id == unknown.first?.id, "it replaces what was said")

        // Then another wallet is chosen and the hot wallet again, which says nothing more.
        shown.match = nil
        #expect(relaunched.update(phases(tracker), beside: .USD).isEmpty)
        shown.match = .recorded
        #expect(relaunched.update(phases(tracker), beside: .USD).isEmpty)
    }

    private func phases(_ tracker: PurchaseTracker) -> [(TrackedPurchase, PurchasePhase)] {
        tracker.purchases.map { ($0, tracker.phase(of: $0)) }
    }

    @Test func switchingWalletsOrRelaunchingNeverTellsItAgain() async throws {
        let (tracker, source, shown) = rig()
        var news = PurchaseNews()
        _ = try await tracker.begin(wallet: wallet, asset: "ETH", dollars: 25, cryptoAmount: "0.008")
        #expect(news.update(phases(tracker), beside: .USD).isEmpty, "it's only just started")

        await source.say([delivered(id: "ref")])
        await tracker.check()
        #expect(news.update(phases(tracker), beside: .USD).map(\.title) == ["Purchase Delivered"])
        shown.match = .recorded
        #expect(news.update(phases(tracker), beside: .USD).map(\.title) == ["Purchase Cost Recorded"])

        // Another wallet is chosen, so its cost isn't matched for now, and then the hot wallet is chosen again.
        shown.match = nil
        #expect(tracker.phase(of: tracker.purchases[0]) == .arriving)
        #expect(news.update(phases(tracker), beside: .USD).isEmpty)
        shown.match = .recorded
        #expect(news.update(phases(tracker), beside: .USD).isEmpty)

        // A relaunch, before the wallet's numbers are back.
        var relaunched = try JSONDecoder().decode(PurchaseNews.self, from: JSONEncoder().encode(news))
        shown.match = nil
        #expect(relaunched.update(phases(tracker), beside: .USD).isEmpty)
        shown.match = .recorded
        #expect(relaunched.update(phases(tracker), beside: .USD).isEmpty)
    }

    @Test func aCostThatArrivesAfterARelaunchIsStillNews() async throws {
        let (tracker, source, shown) = rig()
        var news = PurchaseNews()
        _ = try await tracker.begin(wallet: wallet, asset: "ETH", dollars: 25, cryptoAmount: "0.008")
        _ = news.update(phases(tracker), beside: .USD)
        await source.say([delivered(id: "ref")])
        await tracker.check()
        #expect(news.update(phases(tracker), beside: .USD).map(\.title) == ["Purchase Delivered"])
        var relaunched = try JSONDecoder().decode(PurchaseNews.self, from: JSONEncoder().encode(news))
        shown.match = .recorded
        #expect(relaunched.update(phases(tracker), beside: .USD).map(\.title) == ["Purchase Cost Recorded"])
    }

    @Test func aPurchaseFromBeforeThisKeptTrackIsntNews() {
        var news = PurchaseNews()
        let old = TrackedPurchase(ref: "old", wallet: wallet, asset: "ETH", dollars: 25, startedAt: .now, order: delivered(id: "old"))
        #expect(news.update([(old, .arriving)], beside: .USD).isEmpty)
        #expect(news.update([(old, .recorded(paid))], beside: .USD).isEmpty)
        let going = TrackedPurchase(ref: "going", wallet: wallet, asset: "ETH", dollars: 25, startedAt: .now, order: OnrampOrder(id: "going", status: .pending))
        #expect(news.update([(going, .onItsWay)], beside: .USD).isEmpty)
        #expect(news.update([(going.delivering(), .arriving)], beside: .USD).map(\.title) == ["Purchase Delivered"], "what happens after it's seen still is")
    }
}

private extension TrackedPurchase {
    func delivering() -> TrackedPurchase {
        var next = self
        next.order = delivered(id: ref)
        return next
    }
}

@MainActor
struct PurchasesAcrossKeysTests {
    /// After a key's replaced, what was bought for the old one is still listed, so a notification about it has a row to open.
    @Test func aReplacedKeysPurchasesAreListedWithTheNewOnes() async throws {
        let (tracker, _, _, _) = setup()
        let replacement = "0x00000000000000000000000000000000000DE303"
        _ = try await tracker.begin(wallet: wallet, asset: "ETH", dollars: 25, cryptoAmount: "0.008")
        _ = try await tracker.begin(wallet: replacement, asset: "USDC", dollars: 20, cryptoAmount: "20")
        #expect(tracker.purchases(of: wallet).count == 1)
        let both = tracker.purchases(of: [replacement, wallet])
        #expect(both.map(\.asset) == ["USDC", "ETH"], "newest first, across both")
    }
}
