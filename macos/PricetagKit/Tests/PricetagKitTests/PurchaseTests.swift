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

    func portfolio(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book, timeout: Duration) async throws -> Portfolio { throw FetchError.unreachable }
    func explanation(of target: ExplainTarget, address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book) async throws -> Explanation { throw FetchError.unreachable }
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
    }

    @Test func theSheetSaysWhatThePageWillDo() {
        #expect(PurchaseWording.checkoutNote(MoneyDisplay(main: .USD)) == "You'll need a Coinbase account. Its fees are added, and that total becomes the cost here.")
        #expect(PurchaseWording.checkoutNote(MoneyDisplay(main: .CAD, rateMicros: "1400000")).contains("starts at this amount in CAD"))
        #expect(PurchaseWording.checkoutNote(MoneyDisplay(main: .CAD)).hasPrefix("There's no current USD to CAD rate, so this is in US dollars"))
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
