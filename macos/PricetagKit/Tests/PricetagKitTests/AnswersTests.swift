import Foundation
import Testing
@testable import PricetagKit

/// A clock a test moves by hand.
private final class TestClock: @unchecked Sendable {
    var date = Date(timeIntervalSince1970: 1_793_750_400)
}

@MainActor
@Suite struct AnswersTests {
    let wallet = "0x00000000000000000000000000000000000000aa"
    let sender = "0x00000000000000000000000000000000000000bb"
    let other = "0x00000000000000000000000000000000000000cc"
    let costKey = "0x00000000000000000000000000000000000000aa:0x7d1c0e5a9b3f2e4d6c8a0b1f3e5d7c9a1b3d5f7e9c1a3b5d7f9e1c3a5b7d9f1e:AERO"

    private func makeStore(clock: TestClock = TestClock()) throws -> (PortfolioStore, UserDefaults) {
        let defaults = UserDefaults(suiteName: "answers-tests-\(UUID().uuidString)")!
        defaults.set(wallet, forKey: "wallet")
        let source = BookSource([try demoPortfolio()])
        return (PortfolioStore(defaults: defaults, makeSource: { _ in source }, now: { clock.date }), defaults)
    }

    private func entry(_ store: PortfolioStore, _ id: String) throws -> AnswerEntry {
        try #require(store.answerEntries.first { $0.id == id })
    }

    @Test func eachAnswerIsListedWithItsDateNewestFirst() throws {
        let clock = TestClock()
        let (store, _) = try makeStore(clock: clock)
        store.setBook(store.book.answering(sender, .someoneElse, focus: nil))
        clock.date += 60
        store.setBook(store.book.enteringCost(costKey, Money(micros: "5000000", currency: .USD)))
        #expect(store.answerEntries.map(\.id) == [AnswerEntry.costID(costKey), AnswerEntry.senderID(sender)])
        #expect(store.answeredAt(try entry(store, AnswerEntry.senderID(sender))) == Date(timeIntervalSince1970: 1_793_750_400))
        #expect(store.answeredAt(try entry(store, AnswerEntry.costID(costKey))) == Date(timeIntervalSince1970: 1_793_750_460))
    }

    @Test func anAnswerKeepsItsDateUntilItChanges() throws {
        let clock = TestClock()
        let (store, _) = try makeStore(clock: clock)
        store.setBook(store.book.answering(sender, .someoneElse, focus: nil))
        clock.date += 60
        store.setBook(store.book.enteringCost(costKey, Money(micros: "5000000", currency: .USD)))
        #expect(store.answeredAt(try entry(store, AnswerEntry.senderID(sender))) == Date(timeIntervalSince1970: 1_793_750_400), "another answer doesn't touch it")
        clock.date += 60
        store.changeAnswer(try entry(store, AnswerEntry.senderID(sender)), to: .mine)
        #expect(store.answeredAt(try entry(store, AnswerEntry.senderID(sender))) == Date(timeIntervalSince1970: 1_793_750_520))
        store.undo()
        #expect(store.book.senders[sender] == .someoneElse)
        #expect(store.answeredAt(try entry(store, AnswerEntry.senderID(sender))) == Date(timeIntervalSince1970: 1_793_750_400), "Undo brings back the answer as it was, date and all")
    }

    @Test func datesAndWhatItWasAboutStayOnThisMacAndAreNeverSent() async throws {
        let (store, defaults) = try makeStore()
        store.describe(AnswerEntry.senderID(sender), as: "0.002 ETH from Coinbase")
        store.setBook(store.book.answering(sender, .someoneElse, focus: nil))
        let reopened = PortfolioStore(defaults: defaults, makeSource: { _ in BookSource([]) })
        let answer = try entry(reopened, AnswerEntry.senderID(sender))
        #expect(reopened.answeredAt(answer) != nil)
        #expect(reopened.about(answer) == "0.002 ETH from Coinbase")
        let sent = String(decoding: try JSONEncoder().encode(store.book), as: UTF8.self)
        #expect(!sent.contains("Coinbase"))
        #expect(!sent.contains("1793750400"))
    }

    @Test func whatNoAnswerSaysAnyMoreIsDropped() throws {
        let (store, defaults) = try makeStore()
        store.describe(AnswerEntry.senderID(sender), as: "250 DAI")
        store.setBook(store.book.answering(sender, .someoneElse, focus: nil))
        store.removeAnswer(try entry(store, AnswerEntry.senderID(sender)))
        #expect(store.answerDetails.about[AnswerEntry.senderID(sender)] != nil, "Undo can still bring it back")
        let reopened = PortfolioStore(defaults: defaults, makeSource: { _ in BookSource([]) })
        #expect(reopened.answerDetails == AnswerDetails(), "nothing can bring it back after a relaunch")
    }

    @Test func removingAnAnswerAsksItsQuestionAgainAndUndoBringsItBack() throws {
        let (store, _) = try makeStore()
        store.setBook(store.book.answering(sender, .someoneElse, focus: nil).enteringCost(costKey, Money(micros: "5000000", currency: .USD)))
        store.removeAnswer(try entry(store, AnswerEntry.senderID(sender)))
        #expect(store.book.senders[sender] == nil)
        #expect(store.book.costs[costKey] != nil, "only that answer goes, however old")
        store.undo()
        #expect(store.book.senders[sender] == .someoneElse)
    }

    @Test func changingWhoASenderIsIsOnlyAboutThatSender() throws {
        let (store, _) = try makeStore()
        store.setBook(store.book.answering(sender, .mine, focus: wallet))
        store.changeAnswer(try entry(store, AnswerEntry.senderID(sender)), to: .someoneElse)
        #expect(store.book.senders[sender] == .someoneElse)
        #expect(store.book.senders[wallet] == .mine, "the wallet that was showing keeps its own answer")
    }

    @Test func whatWasPaidCanChangeAndKeepsItsCurrency() throws {
        let (store, _) = try makeStore()
        store.setBook(store.book.enteringCost(costKey, Money(micros: "5000000", currency: .CAD)))
        store.changeCost(try entry(store, AnswerEntry.costID(costKey)), to: "6500000")
        #expect(store.book.costs[costKey] == Money(micros: "6500000", currency: .CAD))

        let receipt = CostReceipt(wallet: wallet, legId: "unseen:1:ETH", asset: "ETH", units: "1")
        store.setBook(store.book.enteringExchangeCosts(other, receipts: [receipt], amounts: ["ETH": Money(micros: "5100000", currency: .USD)], focus: nil))
        store.changeCost(try entry(store, AnswerEntry.senderID(other)), index: 0, to: "5200000")
        let costs = try #require(store.book.senders[other]?.costs)
        #expect(costs.map(\.micros) == ["5200000"])
        #expect(costs.first?.receipts == [receipt], "it still covers what it covered")
    }

    @Test func anExchangeAccountsCostsGoWhenItsSomethingElse() throws {
        let (store, _) = try makeStore()
        let receipt = CostReceipt(wallet: wallet, legId: "unseen:1:ETH", asset: "ETH", units: "1")
        store.setBook(store.book.enteringExchangeCosts(other, receipts: [receipt], amounts: ["ETH": Money(micros: "5100000", currency: .USD)], focus: nil))
        store.changeAnswer(try entry(store, AnswerEntry.senderID(other)), to: .someoneElse)
        #expect(store.book.senders[other] == .someoneElse)
        store.changeAnswer(try entry(store, AnswerEntry.senderID(other)), to: .myExchange)
        #expect(store.book.senders[other] == SenderAnswer(kind: .myExchange), "so what was paid is asked again")
    }

    @Test func thisMacsOwnAccountsArentAnswers() throws {
        let (store, _) = try makeStore()
        store.setLinkedWallets([other])
        store.setBook(store.book.answering(sender, .someoneElse, focus: nil))
        #expect(store.answerEntries.map(\.id) == [AnswerEntry.senderID(sender)])
    }

    @Test func anImportIsOneAnswer() async throws {
        let (store, _) = try makeStore()
        _ = try await store.importCoinbase(csv: "")
        let imported = try entry(store, AnswerEntry.importedID)
        store.removeAnswer(imported)
        #expect(store.book.withdrawals.isEmpty)
    }

    @Test func answeringAQuestionSaysWhatItWasAbout() async throws {
        let (store, _) = try makeStore()
        await _ = store.poll()
        let model = ResolveModel(store: store)
        let question = try #require(model.current)
        let sender = try #require(question.sender)
        model.answer(.someoneElse)
        let arrived = question.arrivals.map { "\(Format.amount($0.units, decimals: $0.decimals)) \($0.asset)" }.formatted(.list(type: .and))
        #expect(store.about(try entry(store, AnswerEntry.senderID(sender))) == arrived)
    }

    @Test func aCostKeySaysWhatItsAbout() throws {
        let subject = try #require(CostSubject(key: costKey))
        #expect(subject.wallet == wallet)
        #expect(subject.transaction == "0x7d1c0e5a9b3f2e4d6c8a0b1f3e5d7c9a1b3d5f7e9c1a3b5d7f9e1c3a5b7d9f1e")
        #expect(subject.asset == "AERO")
        let unseen = try #require(CostSubject(key: "\(wallet):unseen:53500120:ETH"))
        #expect(unseen.transaction == nil)
        #expect(unseen.block == 53_500_120)
        #expect(CostSubject(key: "k") == nil)
    }

    @Test func anAmountReadsAsItCouldBeTyped() {
        #expect(Format.typed("5100000") == "5.10")
        #expect(Format.typed("40000000") == "40.00")
        #expect(Format.typed("1234567") == "1.234567")
        #expect(Format.typed("5") == "0.000005")
        #expect(Format.typed("0") == "0.00")
        #expect(Format.micros(fromDollars: Format.typed("1234567")) == "1234567")
    }
}
