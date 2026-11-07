import Foundation
import Testing
@testable import PricetagKit

private final class AnsweringSource: PortfolioSource, @unchecked Sendable {
    nonisolated(unsafe) var error: FetchError?

    init(error: FetchError? = nil) { self.error = error }

    func rules() async throws -> [PricingRule] {
        if let error { throw error }
        return []
    }

    func portfolio(_ read: ReadContext, timeout: Duration) async throws -> Portfolio { throw FetchError.unreachable }
    func explanation(of target: ExplainTarget, _ read: ReadContext, shown: [String]?) async throws -> Explanation { throw FetchError.unreachable }
}

/// Says what it's told about a contract, when it's told to. Its numbers never come, like a first read that's still going.
final class ContractSource: PortfolioSource, @unchecked Sendable {
    nonisolated(unsafe) var answer: Bool?
    nonisolated(unsafe) var isHeld = false
    nonisolated(unsafe) var asked: [String] = []

    init(answer: Bool?, isHeld: Bool = false) {
        self.answer = answer
        self.isHeld = isHeld
    }

    func readProgress(address: String) async throws -> FirstReadProgress? {
        asked.append(address)
        while isHeld { try await Task.sleep(for: .milliseconds(2)) }
        return FirstReadProgress(stage: .transfers, isContract: answer)
    }

    func portfolio(_ read: ReadContext, timeout: Duration) async throws -> Portfolio {
        try await Task.sleep(for: .seconds(600))
        throw FetchError.unreachable
    }

    func explanation(of target: ExplainTarget, _ read: ReadContext, shown: [String]?) async throws -> Explanation { throw FetchError.unreachable }
}

@MainActor struct FirstRunTests {
    private func defaults() throws -> UserDefaults {
        try #require(UserDefaults(suiteName: "FirstRunTests-\(UUID())"))
    }

    @Test func someoneNewSeesAllOfIt() throws {
        let firstRun = FirstRun(defaults: try defaults(), isExistingInstall: false)
        #expect(firstRun.isWelcoming)
        #expect(firstRun.explainsNumbers)
        #expect(firstRun.explainsQuestions)
    }

    @Test func anExistingInstallNeverSeesAnyOfIt() throws {
        let defaults = try defaults()
        let firstRun = FirstRun(defaults: defaults, isExistingInstall: true)
        #expect(!firstRun.isWelcoming)
        #expect(!firstRun.explainsNumbers)
        #expect(!firstRun.explainsQuestions)
        // Forgetting every wallet later doesn't make it someone new.
        let later = FirstRun(defaults: defaults, isExistingInstall: false)
        #expect(!later.isWelcoming)
        #expect(!later.explainsNumbers)
    }

    @Test func anInstallWithAWalletIsAnExistingOne() throws {
        let demoMac = try defaults()
        #expect(!PortfolioStore.hasBeenUsed(defaults: demoMac))
        demoMac.set("0x00000000000000000000000000000000000000aa", forKey: "wallet")
        #expect(PortfolioStore.hasBeenUsed(defaults: demoMac))
        #expect(!FirstRun(defaults: demoMac, isExistingInstall: PortfolioStore.hasBeenUsed(defaults: demoMac)).isWelcoming)
    }

    @Test func anySavedSettingMeansAnExistingInstall() throws {
        for key in ["method", "currency", "menuBarShows", "serverURL", "answers", "savedWallets"] {
            let used = try defaults()
            used.set("something", forKey: key)
            #expect(PortfolioStore.hasBeenUsed(defaults: used), "\(key)")
        }
    }

    @Test func anInviteGivenOnTheWayInDoesntEndTheWelcome() throws {
        let defaults = try defaults()
        _ = FirstRun(defaults: defaults, isExistingInstall: false)
        defaults.set(["https://patina.example": "an-invite"], forKey: "serverInvites")
        // It's used by now, and it's still someone new who hasn't got to a wallet.
        #expect(PortfolioStore.hasBeenUsed(defaults: defaults))
        #expect(FirstRun(defaults: defaults, isExistingInstall: PortfolioStore.hasBeenUsed(defaults: defaults)).isWelcoming)
    }

    @Test func eachPartHappensOnce() throws {
        let defaults = try defaults()
        let firstRun = FirstRun(defaults: defaults, isExistingInstall: false)
        firstRun.finishWelcome()
        firstRun.finishNumbers()
        let next = FirstRun(defaults: defaults, isExistingInstall: false)
        #expect(!next.isWelcoming)
        #expect(!next.explainsNumbers)
        #expect(next.explainsQuestions, "The first question hasn't come up yet")
        next.finishQuestions()
        #expect(!FirstRun(defaults: defaults, isExistingInstall: false).explainsQuestions)
    }

    @Test func skippingIsForGood() throws {
        let defaults = try defaults()
        FirstRun(defaults: defaults, isExistingInstall: false).skip()
        let next = FirstRun(defaults: defaults, isExistingInstall: false)
        #expect(!next.isWelcoming)
        #expect(!next.explainsNumbers)
        #expect(!next.explainsQuestions)
    }

    @Test func helpBringsItBack() throws {
        let defaults = try defaults()
        let firstRun = FirstRun(defaults: defaults, isExistingInstall: true)
        firstRun.showAgain(hasWallet: true)
        #expect(!firstRun.isWelcoming, "A wallet's already on screen, so there's nothing to get to")
        #expect(firstRun.explainsNumbers)
        #expect(firstRun.explainsQuestions)
        firstRun.showAgain(hasWallet: false)
        #expect(firstRun.isWelcoming)
        #expect(FirstRun(defaults: defaults, isExistingInstall: true).isWelcoming)
    }

    @Test func whatsFinishedStaysFinished() {
        FirstRun.finished.showAgain(hasWallet: false)
        #expect(!FirstRun.finished.isWelcoming)
        #expect(!FirstRun.finished.explainsNumbers)
    }

    private let contract = "0x4200000000000000000000000000000000000006"
    private let person = "0x00000000000000000000000000000000000000aa"

    /// A failure rather than a test that never ends.
    private func until(_ condition: @autoclosure () -> Bool) async throws {
        let deadline = Date.now.addingTimeInterval(10)
        while !condition(), Date.now < deadline { try await Task.sleep(for: .milliseconds(2)) }
        #expect(condition())
    }

    @Test func aContractIsFoundWithoutAnythingOnScreenAskingAndWithoutStoppingAnything() async throws {
        let firstRun = FirstRun(defaults: try defaults(), isExistingInstall: false)
        let source = ContractSource(answer: true)
        firstRun.checkContract(of: contract) { source }
        try await until(firstRun.warnsOfContract(contract))
        #expect(!firstRun.warnsOfContract(person), "Only for the wallet it's about")
    }

    @Test func aReplyAfterTheNumbersStillCounts() async throws {
        let firstRun = FirstRun(defaults: try defaults(), isExistingInstall: false)
        let source = ContractSource(answer: true, isHeld: true)
        firstRun.checkContract(of: contract) { source }
        try await until(source.asked == [contract])
        // Numbers arriving end the welcome, and the note can be dismissed, before the node has said.
        firstRun.finishWelcome()
        firstRun.finishNumbers()
        #expect(!firstRun.warnsOfContract(contract))
        source.isHeld = false
        try await until(firstRun.warnsOfContract(contract))
    }

    @Test func aPersonsWalletSaysNothing() async throws {
        let firstRun = FirstRun(defaults: try defaults(), isExistingInstall: false)
        let source = ContractSource(answer: false)
        firstRun.checkContract(of: person) { source }
        try await until(source.asked == [person])
        try await Task.sleep(for: .milliseconds(20))
        #expect(!firstRun.warnsOfContract(person))
    }

    @Test func aNodeThatDidntSayGetsAskedAgain() async throws {
        let firstRun = FirstRun(defaults: try defaults(), isExistingInstall: false)
        let source = ContractSource(answer: nil)
        firstRun.checkContract(of: contract, retryDelay: .milliseconds(2)) { source }
        try await until(source.asked.count >= 2)
        #expect(!firstRun.warnsOfContract(contract))
        source.answer = true
        try await until(firstRun.warnsOfContract(contract))
    }

    @Test func anotherWalletReplacesTheQuestion() async throws {
        let firstRun = FirstRun(defaults: try defaults(), isExistingInstall: false)
        let slow = ContractSource(answer: true, isHeld: true)
        firstRun.checkContract(of: contract) { slow }
        try await until(slow.asked == [contract])
        firstRun.checkContract(of: person) { ContractSource(answer: false) }
        slow.isHeld = false
        try await Task.sleep(for: .milliseconds(20))
        #expect(!firstRun.warnsOfContract(contract))
        #expect(!firstRun.warnsOfContract(person))
    }

    @Test func askingAgainAboutTheSameWalletDoesNothing() async throws {
        let firstRun = FirstRun(defaults: try defaults(), isExistingInstall: false)
        let source = ContractSource(answer: true)
        firstRun.checkContract(of: contract) { source }
        try await until(firstRun.warnsOfContract(contract))
        firstRun.checkContract(of: contract) { source }
        try await Task.sleep(for: .milliseconds(20))
        #expect(source.asked == [contract])
    }

    @Test func onlyRealAddressesGetAsked() async throws {
        let firstRun = FirstRun(defaults: try defaults(), isExistingInstall: false)
        let source = ContractSource(answer: true)
        for address in [WalletAddress.demo, WalletAddress.allYours, nil] { firstRun.checkContract(of: address) { source } }
        try await Task.sleep(for: .milliseconds(20))
        #expect(source.asked.isEmpty)
    }

    @Test func anExistingInstallIsNeverAskedAboutOrToldOfAContract() async throws {
        let firstRun = FirstRun(defaults: try defaults(), isExistingInstall: true)
        let source = ContractSource(answer: true)
        firstRun.checkContract(of: contract) { source }
        try await Task.sleep(for: .milliseconds(20))
        #expect(source.asked.isEmpty)
        #expect(!firstRun.warnsOfContract(contract))
    }

    @Test func skippingCoversContractsToo() async throws {
        let defaults = try defaults()
        let firstRun = FirstRun(defaults: defaults, isExistingInstall: false)
        firstRun.skip()
        #expect(!firstRun.explainsContract)
        #expect(!FirstRun(defaults: defaults, isExistingInstall: false).explainsContract)
    }

    @Test func aContractIsExplainedOnceAndHelpBringsItBack() async throws {
        let defaults = try defaults()
        let firstRun = FirstRun(defaults: defaults, isExistingInstall: false)
        let source = ContractSource(answer: true)
        firstRun.checkContract(of: contract) { source }
        try await until(firstRun.warnsOfContract(contract))
        firstRun.finishContract()
        #expect(!firstRun.warnsOfContract(contract))
        #expect(!FirstRun(defaults: defaults, isExistingInstall: false).explainsContract)
        firstRun.showAgain(hasWallet: true)
        #expect(firstRun.warnsOfContract(contract), "It's still known, so it doesn't need asking again")
    }

    @Test func helpAsksAboutTheWalletThatsShowing() async throws {
        let firstRun = FirstRun(defaults: try defaults(), isExistingInstall: true)
        let source = ContractSource(answer: true)
        firstRun.checkContract(of: contract) { source }
        firstRun.showAgain(hasWallet: true)
        firstRun.checkContract(of: contract) { source }
        try await until(firstRun.warnsOfContract(contract))
    }

    @Test func stepsFollowTheServer() {
        #expect(FirstReadProgress(stage: .waiting).steps.map(\.state) == [.now, .later, .later, .later])
        #expect(FirstReadProgress(stage: .transfers).steps.map(\.state) == [.now, .later, .later, .later])
        #expect(FirstReadProgress(stage: .checking, transfers: 3).steps.map(\.state) == [.done, .done, .now, .later])
        #expect(FirstReadProgress(stage: .costs, transfers: 3).steps.map(\.state) == [.done, .done, .done, .now])
    }

    @Test func aCountIsOnlySaidOnceItsKnown() {
        #expect(FirstReadProgress(stage: .transfers).steps[0].title == "Finding transfers")
        #expect(FirstReadProgress(stage: .prices, transfers: 1).steps[0].title == "Found 1 transfer")
        #expect(FirstReadProgress(stage: .prices, transfers: 0).steps[0].title == "No transfers found")
        #expect(FirstReadProgress(stage: .prices, transfers: 1284).steps[0].title == "Found \(1284.formatted()) transfers")
    }

    @Test func wordsAreForAnyone() {
        let words = [Wording.welcomeTitle, Wording.welcomePitch(appName: "Patina"), Wording.watchHint, Wording.savingsSummary, Wording.readingTitle, Wording.readTakingLong, Wording.contractNotice, Wording.emptyOnFirstRead, Wording.firstQuestion].joined(separator: " ").lowercased()
        for term in ["fifo", "oracle", " leg", "every token", "any chain", "any evm", "guaranteed"] {
            #expect(!words.contains(term), "\(term)")
        }
    }

    private func store(_ source: AnsweringSource, defaults: UserDefaults) -> PortfolioStore {
        PortfolioStore(defaults: defaults, makeSource: { _ in source })
    }

    @Test func aServerThatsDownSaysSoWithNoWalletToRead() async throws {
        let source = AnsweringSource(error: .unreachable)
        let store = store(source, defaults: try defaults())
        #expect(store.serverCheck == .checking)
        await store.refreshRules()
        #expect(store.serverCheck == .unreachable)
        #expect(!store.needsInvite)
        source.error = nil
        await store.refreshRules()
        #expect(store.serverCheck == .answers)
    }

    @Test func aServerThatWantsAnInviteIsAnswering() async throws {
        let source = AnsweringSource(error: .needsInvite("This server needs an invite."))
        let store = store(source, defaults: try defaults())
        await store.refreshRules()
        #expect(store.serverCheck == .answers)
        #expect(store.needsInvite)
        #expect(store.invite == nil, "Nothing's been refused yet")
    }

    @Test func aRefusedInviteAsksAgainAndAGoodOneDoesnt() async throws {
        let source = AnsweringSource(error: .needsInvite("This server needs an invite."))
        let store = store(source, defaults: try defaults())
        await store.refreshRules()
        store.setInvite("wrong")
        #expect(store.serverCheck == .checking)
        #expect(!store.needsInvite)
        await store.refreshRules()
        #expect(store.needsInvite)
        #expect(store.invite == "wrong", "So it can say that one was refused")
        source.error = nil
        store.setInvite("right")
        await store.refreshRules()
        #expect(!store.needsInvite)
        #expect(store.serverCheck == .answers)
    }
}
