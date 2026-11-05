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
        store.setBook(store.book.answering(sender, .someoneElse, focus: nil), about: [AnswerEntry.senderID(sender): "0.002 ETH from Coinbase"])
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
        store.setBook(store.book.answering(sender, .someoneElse, focus: nil), about: [AnswerEntry.senderID(sender): "250 DAI"])
        store.removeAnswer(try entry(store, AnswerEntry.senderID(sender)))
        #expect(store.answerDetails == AnswerDetails())
        let reopened = PortfolioStore(defaults: defaults, makeSource: { _ in BookSource([]) })
        #expect(reopened.answerDetails == AnswerDetails(), "nothing can bring it back after a relaunch")
        store.undo()
        #expect(store.about(try entry(store, AnswerEntry.senderID(sender))) == "250 DAI", "Undo brings it back with the answer")
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
        store.changeCost(try entry(store, AnswerEntry.exchangeCostID(sender: other, asset: "ETH", receipts: [receipt])), to: "5200000")
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

    // Two withdrawals of ETH from one exchange account, in different blocks, each asked about and answered on its own.
    private func twoWithdrawals(_ store: PortfolioStore, clock: TestClock) -> (first: CostReceipt, second: CostReceipt) {
        let first = CostReceipt(wallet: wallet, legId: "unseen:53500120:ETH", asset: "ETH", units: "2100000000000000")
        let second = CostReceipt(wallet: wallet, legId: "unseen:53521400:ETH", asset: "ETH", units: "1850000000000000")
        store.setBook(store.book.answering(other, SenderAnswer(kind: .myExchange), focus: nil))
        for receipt in [first, second] {
            clock.date += 60
            let id = AnswerEntry.exchangeCostID(sender: other, asset: "ETH", receipts: [receipt])
            store.setBook(store.book.enteringExchangeCosts(other, receipts: [receipt], amounts: ["ETH": Money(micros: "5100000", currency: .USD)], focus: nil), about: [id: receipt == first ? "0.0021 ETH" : "0.00185 ETH"])
        }
        return (first, second)
    }

    @Test func eachTimeAnExchangeAccountWasPaidForIsItsOwnAnswer() throws {
        let clock = TestClock()
        let (store, _) = try makeStore(clock: clock)
        let (first, second) = twoWithdrawals(store, clock: clock)
        let ids = [first, second].map { AnswerEntry.exchangeCostID(sender: other, asset: "ETH", receipts: [$0]) }
        #expect(ids[0] != ids[1])
        #expect(store.about(try entry(store, ids[0])) == "0.0021 ETH")
        #expect(store.about(try entry(store, ids[1])) == "0.00185 ETH")
        #expect(store.answeredAt(try entry(store, ids[0])) == Date(timeIntervalSince1970: 1_793_750_460))
        #expect(store.answeredAt(try entry(store, ids[1])) == Date(timeIntervalSince1970: 1_793_750_520))
        #expect(store.answeredAt(try entry(store, AnswerEntry.senderID(other))) == Date(timeIntervalSince1970: 1_793_750_400), "paying for what it sent doesn't make it a new answer about who it is")
        let subject = try #require(CostSubject(wallet: first.wallet, legId: first.legId))
        #expect(subject.place == "in block 53,500,120")
    }

    @Test(arguments: [0, 1]) func takingBackOneCostKeepsTheAccountAndTheOther(_ removed: Int) throws {
        let clock = TestClock()
        let (store, _) = try makeStore(clock: clock)
        let receipts = twoWithdrawals(store, clock: clock)
        let both = [receipts.first, receipts.second]
        let ids = both.map { AnswerEntry.exchangeCostID(sender: other, asset: "ETH", receipts: [$0]) }
        let dates = try ids.map { store.answeredAt(try entry(store, $0)) }
        clock.date += 60
        store.removeAnswer(try entry(store, ids[removed]))
        let kept = 1 - removed
        #expect(store.book.senders[other]?.kind == .myExchange)
        #expect(store.book.senders[other]?.costs?.map(\.receipts) == [[both[kept]]])
        #expect(!store.answerEntries.contains { $0.id == ids[removed] })
        #expect(store.answeredAt(try entry(store, ids[kept])) == dates[kept], "the other keeps its date")
        #expect(store.about(try entry(store, ids[kept])) == (kept == 0 ? "0.0021 ETH" : "0.00185 ETH"))
        store.undo()
        #expect(store.book.senders[other]?.costs?.map(\.receipts) == [[both[0]], [both[1]]])
        #expect(try ids.map { store.answeredAt(try entry(store, $0)) } == dates)
    }

    @Test func takingBackTheLastCostKeepsItAnExchangeAccount() throws {
        let (store, _) = try makeStore()
        let receipt = CostReceipt(wallet: wallet, legId: "unseen:1:ETH", asset: "ETH", units: "1")
        store.setBook(store.book.enteringExchangeCosts(other, receipts: [receipt], amounts: ["ETH": Money(micros: "5100000", currency: .USD)], focus: nil))
        store.removeAnswer(try entry(store, AnswerEntry.exchangeCostID(sender: other, asset: "ETH", receipts: [receipt])))
        #expect(store.book.senders[other] == SenderAnswer(kind: .myExchange), "so what was paid is asked again")
    }

    @Test func changingOneCostLeavesTheOtherAlone() throws {
        let clock = TestClock()
        let (store, _) = try makeStore(clock: clock)
        let (first, second) = twoWithdrawals(store, clock: clock)
        store.changeCost(try entry(store, AnswerEntry.exchangeCostID(sender: other, asset: "ETH", receipts: [second])), to: "4000000")
        #expect(store.book.senders[other]?.costs?.map(\.micros) == ["5100000", "4000000"])
        #expect(store.book.senders[other]?.costs?.map(\.receipts) == [[first], [second]])
    }

    @Test func undoPutsBackTheDateOfARepeatedAnswer() throws {
        let clock = TestClock()
        let (store, _) = try makeStore(clock: clock)
        store.setBook(store.book.answering(sender, .someoneElse, focus: nil))
        clock.date += 60
        store.changeAnswer(try entry(store, AnswerEntry.senderID(sender)), to: .mine)
        clock.date += 60
        store.changeAnswer(try entry(store, AnswerEntry.senderID(sender)), to: .someoneElse)
        #expect(store.answeredAt(try entry(store, AnswerEntry.senderID(sender))) == Date(timeIntervalSince1970: 1_793_750_520))
        store.undo()
        #expect(store.answeredAt(try entry(store, AnswerEntry.senderID(sender))) == Date(timeIntervalSince1970: 1_793_750_460))
        store.undo()
        #expect(store.book.senders[sender] == .someoneElse)
        #expect(store.answeredAt(try entry(store, AnswerEntry.senderID(sender))) == Date(timeIntervalSince1970: 1_793_750_400))
    }

    @Test func undoPutsBackTheDateOfAnAnswerGivenAgain() throws {
        let clock = TestClock()
        let (store, _) = try makeStore(clock: clock)
        store.setBook(store.book.answering(sender, .someoneElse, focus: nil))
        clock.date += 60
        store.removeAnswer(try entry(store, AnswerEntry.senderID(sender)))
        clock.date += 60
        store.setBook(store.book.answering(sender, .someoneElse, focus: nil))
        #expect(store.answeredAt(try entry(store, AnswerEntry.senderID(sender))) == Date(timeIntervalSince1970: 1_793_750_520))
        store.undo()
        store.undo()
        #expect(store.answeredAt(try entry(store, AnswerEntry.senderID(sender))) == Date(timeIntervalSince1970: 1_793_750_400))
    }

    @Test func anAnswerFromBeforeDatesStaysUndatedThroughUndo() throws {
        let defaults = UserDefaults(suiteName: "answers-tests-\(UUID().uuidString)")!
        defaults.set(wallet, forKey: "wallet")
        defaults.set(try JSONEncoder().encode(Book().answering(sender, .someoneElse, focus: nil)), forKey: "answers")
        let source = BookSource([try demoPortfolio()])
        let store = PortfolioStore(defaults: defaults, makeSource: { _ in source })
        #expect(store.answeredAt(try entry(store, AnswerEntry.senderID(sender))) == nil)
        store.changeAnswer(try entry(store, AnswerEntry.senderID(sender)), to: .mine)
        #expect(store.answeredAt(try entry(store, AnswerEntry.senderID(sender))) != nil)
        store.undo()
        #expect(store.book.senders[sender] == .someoneElse)
        #expect(store.answeredAt(try entry(store, AnswerEntry.senderID(sender))) == nil, "it never had one, so it doesn't get today's")
    }

    @Test func takingBackAWalletMoveKeepsItsDate() throws {
        let clock = TestClock()
        let (store, _) = try makeStore(clock: clock)
        store.setBook(store.book.answering(sender, .someoneElse, focus: nil))
        clock.date += 60
        let snapshot = store.changeWallet(sender) { store.moveToYours(sender) }
        #expect(store.answeredAt(try entry(store, AnswerEntry.senderID(sender))) == Date(timeIntervalSince1970: 1_793_750_460))
        store.restore(snapshot)
        #expect(store.book.senders[sender] == .someoneElse)
        #expect(store.answeredAt(try entry(store, AnswerEntry.senderID(sender))) == Date(timeIntervalSince1970: 1_793_750_400))
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
