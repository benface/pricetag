import Foundation
import KeyVault
import PricetagKit
import Testing
@testable import HotWalletKit

private let friend = EthereumAddress("0x3333333333333333333333333333333333333333")!
private final class Seen: @unchecked Sendable {
    private let lock = NSLock()
    private var seen: Bool?

    var value: Bool? { lock.withLock { seen } }
    func set(_ value: Bool) { lock.withLock { seen = value } }
}

/// Under the cap, so nothing sweeps by itself.
private let funded = snapshot(eth: oneEth / 200, tokens: [usdc: usdcUnits(20)])

private func sent(_ transaction: UnsignedTransaction) -> EthereumAddress? {
    EthereumAddress("0x" + Hex.encode(transaction.data[16..<36]))
}

/// Everything a store needs to take an answer, and no more.
private struct NoServer: PortfolioSource {
    func portfolio(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book, timeout: Duration) async throws -> Portfolio { throw FetchError.unreachable }
    func explanation(of target: ExplainTarget, address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book) async throws -> Explanation { throw FetchError.unreachable }
    func previews(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], candidates: [Book]) async throws -> [BookPreview] { throw FetchError.unreachable }
}

@MainActor
private func makeStore() -> PortfolioStore {
    PortfolioStore(defaults: UserDefaults(suiteName: "send-tests-\(UUID().uuidString)")!, makeSource: { _ in NoServer() })
}

@MainActor
@Suite struct SendTests {
    @Test func aTokenGoesToWhoeverWasChosenAfterAsking() async throws {
        let rig = await Rig(funded, presence: true)
        #expect(await rig.wallet.send(SendRequest(token: usdc, amount: usdcUnits(5), to: friend)))
        let transaction = try #require(await rig.signer.signed.first)
        #expect(transaction.to == usdc.contract)
        #expect(transaction.value == 0)
        #expect(sent(transaction) == friend)
        #expect(transaction.chainID == 8453)
        let record = try #require(rig.wallet.records.first)
        #expect(record.reason == .sent)
        #expect(record.to == friend)
        #expect(record.status == .pending)
        #expect(record.usdMicros == String(5 * Money.dollar))
    }

    @Test func nothingIsSignedWithoutThePerson() async throws {
        let rig = await Rig(funded, presence: false)
        #expect(await rig.wallet.send(SendRequest(token: usdc, amount: usdcUnits(5), to: friend)) == false)
        #expect(await rig.signer.signed.isEmpty)
    }

    @Test func ethUsesExactlyWhatAPlainSendIsQuoted() async throws {
        let rig = await Rig(funded)
        #expect(await rig.wallet.send(SendRequest(token: Base.eth, amount: oneEth / 1000, to: friend)))
        let transaction = try #require(await rig.signer.signed.first)
        #expect(transaction.to == friend)
        #expect(transaction.value == oneEth / 1000)
        #expect(transaction.data.isEmpty)
        #expect(transaction.gasLimit == 21000)
    }

    @Test func theRecordIsOnDiskBeforeItLeaves() async throws {
        let rig = await Rig(funded)
        let store = rig.stateStore
        let seen = Seen()
        await rig.chain.setOnSend { transaction in
            seen.set(store.saved.records[hotAddress]?.contains { $0.hash == transaction.hash } ?? false)
        }
        #expect(await rig.wallet.send(SendRequest(token: usdc, amount: usdcUnits(5), to: friend)))
        #expect(seen.value == true)
    }

    @Test func itIsntMistakenForAThief() async throws {
        let rig = await Rig(funded)
        #expect(await rig.wallet.send(SendRequest(token: usdc, amount: usdcUnits(5), to: friend)))
        let hash = try #require(rig.wallet.records.first?.hash)
        #expect(AlarmCheck.findings(outgoingTxs: [hash], records: rig.wallet.records).isEmpty)
        #expect(AlarmCheck.findings(onchainNonce: 1, records: rig.wallet.records).isEmpty)
    }

    @Test func refusesAddressesThatWouldLoseIt() async throws {
        let rig = await Rig(funded)
        for (address, problem) in [(EthereumAddress.zero, SendProblem.isZero), (hotAddress, .isThisWallet), (try #require(usdc.contract), .isAToken)] {
            #expect(rig.wallet.problem(sendingTo: address) == problem)
            #expect(await rig.wallet.send(SendRequest(token: usdc, amount: usdcUnits(5), to: address)) == false)
            #expect(rig.wallet.sweepProblem == problem.message)
        }
        #expect(await rig.signer.signed.isEmpty)
    }

    @Test func refusesARetiredKey() async throws {
        let rig = await Rig(funded)
        await rig.wallet.replaceKey()
        await rig.chain.set(snapshot(eth: 0))
        await rig.wallet.finishRotationLeavingFundsBehind()
        #expect(rig.wallet.problem(sendingTo: hotAddress) == .isARetiredKey)
    }

    @Test func checksAgainstAFreshRead() async throws {
        let rig = await Rig(funded)
        await rig.wallet.tick()
        await rig.chain.set(snapshot(eth: oneEth / 200, tokens: [usdc: usdcUnits(1)]))
        #expect(await rig.wallet.send(SendRequest(token: usdc, amount: usdcUnits(5), to: friend)) == false)
        #expect(rig.wallet.sweepProblem == HotWalletWording.notEnoughToSend)
        #expect(await rig.signer.signed.isEmpty)
    }

    @Test func ethLeavesWhatSweepsNeed() async throws {
        let rig = await Rig(funded)
        await rig.wallet.tick()
        let maximum = rig.wallet.maximumSend(of: Base.eth)
        #expect(maximum == oneEth / 200 - SweepPlanner.gasReserve(cheapFees))
        #expect(await rig.wallet.send(SendRequest(token: Base.eth, amount: maximum + 1, to: friend)) == false)
        #expect(await rig.signer.signed.isEmpty)
        #expect(await rig.wallet.send(SendRequest(token: Base.eth, amount: maximum, to: friend)))
    }

    @Test func aTokenNeedsEthToPayTheFee() async throws {
        let rig = await Rig(snapshot(eth: 0, tokens: [usdc: usdcUnits(5)]))
        #expect(await rig.wallet.send(SendRequest(token: usdc, amount: usdcUnits(5), to: friend)) == false)
        #expect(rig.wallet.sweepProblem == HotWalletWording.noGasToSend)
    }

    @Test func oneAtATimeUntilTheLastHasLanded() async throws {
        let rig = await Rig(funded)
        let request = SendRequest(token: usdc, amount: usdcUnits(5), to: friend)
        #expect(await rig.wallet.send(request))
        #expect(await rig.wallet.send(request) == false)
        #expect(rig.wallet.sweepProblem == HotWalletWording.lastOneOnItsWay)
        await rig.chain.confirmAll()
        await rig.chain.set(snapshot(eth: oneEth / 200, tokens: [usdc: usdcUnits(15)], nonce: 1))
        #expect(await rig.wallet.send(request), "what landed since the last look doesn't need another tick")
        let nonces = await rig.signer.signed.map(\.nonce)
        #expect(nonces == [0, 1])
    }

    @Test func stoppedDuringARotation() async throws {
        let rig = await Rig(funded)
        await rig.wallet.replaceKey()
        #expect(!rig.wallet.canSend)
        #expect(await rig.wallet.send(SendRequest(token: usdc, amount: usdcUnits(5), to: friend)) == false)
        #expect(!rig.wallet.records.contains { $0.reason == .sent })
    }

    @Test func stoppedByAnAlarm() async throws {
        let rig = await Rig(snapshot(eth: oneEth / 200, tokens: [usdc: usdcUnits(20)], nonce: 1))
        for _ in 0..<HotWallet.readsBeforeAlarm { await rig.wallet.tick() }
        #expect(rig.wallet.alarm != nil)
        #expect(!rig.wallet.canSend)
        #expect(await rig.wallet.send(SendRequest(token: usdc, amount: usdcUnits(5), to: friend)) == false)
        #expect(await rig.signer.signed.isEmpty)
    }

    @Test func aFailedOneDoesntHoldUpSweeps() async throws {
        let rig = await Rig(funded)
        #expect(await rig.wallet.send(SendRequest(token: usdc, amount: usdcUnits(5), to: friend)))
        let hash = try #require(rig.wallet.records.first?.hash)
        await rig.chain.setReceipt(hash, succeeded: false)
        await rig.chain.set(snapshot(eth: oneEth / 200, tokens: [usdc: usdcUnits(500)]))
        await rig.wallet.tick()
        #expect(rig.wallet.records.first { $0.hash == hash }?.status == .failed)
        #expect(rig.wallet.records.contains { $0.reason == .aboveCap }, "it's what's above the cap that sweeps, whatever else happened")
    }

    @Test func maybeSentCountsAsOnItsWay() async throws {
        let rig = await Rig(funded)
        await rig.chain.setSendFailure(.unreachable)
        #expect(await rig.wallet.send(SendRequest(token: usdc, amount: usdcUnits(5), to: friend)))
        #expect(rig.wallet.records.first?.status == .pending)
    }

    @Test func aRefusedOneIsntOnItsWay() async throws {
        let rig = await Rig(funded)
        await rig.chain.setSendFailure(.rejected("nope"))
        #expect(await rig.wallet.send(SendRequest(token: usdc, amount: usdcUnits(5), to: friend)) == false)
        #expect(rig.wallet.records.first?.status == .dropped)
        #expect(rig.wallet.sweepProblem == "nope")
    }

    @Test func amountsAreReadExactly() {
        #expect(Money.units(fromText: "1.5", decimals: 6) == 1_500_000)
        #expect(Money.units(fromText: "1,000", decimals: 6) == 1_000_000_000)
        #expect(Money.units(fromText: ".25", decimals: 2) == 25)
        #expect(Money.units(fromText: "1.", decimals: 2) == 100)
        #expect(Money.units(fromText: "1.1234567", decimals: 6) == nil, "rounding someone's money isn't this app's call")
        for bad in ["", ".", "-1", "1e5", "1.2.3", "abc"] { #expect(Money.units(fromText: bad, decimals: 6) == nil, "\(bad)") }
        #expect(Money.units(fromText: String(repeating: "9", count: 60), decimals: 18) == nil)
    }

    @Test func theMaximumReadsBackExactly() {
        for (units, decimals, text) in [(UInt128(1_500_000), 6, "1.5"), (0, 6, "0"), (7, 18, "0.000000000000000007"), (2_000_000, 6, "2"), (5, 0, "5")] {
            #expect(Money.text(ofUnits: units, decimals: decimals) == text)
            #expect(Money.units(fromText: text, decimals: decimals) == units)
        }
    }
}

@MainActor
@Suite struct IsThisYoursTests {
    private func makeModel(_ rig: Rig, store: PortfolioStore) -> SendModel {
        rig.wallet.onLinkedWalletsChange = { store.setLinkedWallets($0) }
        store.setLinkedWallets(rig.wallet.linkedWallets)
        let model = SendModel(wallet: rig.wallet, store: store)
        model.token = usdc
        model.amountText = "5"
        return model
    }

    @Test func aNewAddressIsAskedAbout() async throws {
        let rig = await Rig(funded)
        await rig.wallet.tick()
        let model = makeModel(rig, store: makeStore())
        #expect(!model.asksIfItsYours, "not until there's an address")
        model.addressText = friend.lowercased
        #expect(model.asksIfItsYours)
        #expect(model.canSend, "it's offered, never required")
    }

    @Test func theAnswerIsSavedWithTheSend() async throws {
        let rig = await Rig(funded)
        await rig.wallet.tick()
        let store = makeStore()
        let model = makeModel(rig, store: store)
        model.addressText = friend.checksummed
        model.ownership = .mine
        #expect(store.book.senders[friend.lowercased] == nil)
        #expect(await model.send())
        #expect(store.book.senders[friend.lowercased]?.kind == .mine)
        #expect(store.undoStack.count == 1, "Undo is always there")
    }

    @Test(arguments: [(Ownership.myExchange, SenderAnswer.Kind.myExchange), (.someoneElse, .someoneElse)])
    func everyAnswerIsKept(ownership: Ownership, kind: SenderAnswer.Kind) async throws {
        let rig = await Rig(funded)
        await rig.wallet.tick()
        let store = makeStore()
        let model = makeModel(rig, store: store)
        model.addressText = friend.lowercased
        model.ownership = ownership
        #expect(await model.send())
        #expect(store.book.senders[friend.lowercased]?.kind == kind)
    }

    @Test func noAnswerStaysUnanswered() async throws {
        let rig = await Rig(funded)
        await rig.wallet.tick()
        let store = makeStore()
        let model = makeModel(rig, store: store)
        model.addressText = friend.lowercased
        #expect(await model.send())
        #expect(store.book.senders[friend.lowercased] == nil)
        #expect(store.undoStack.isEmpty)
    }

    @Test func aSendThatDidntGoOutSavesNothing() async throws {
        let rig = await Rig(funded, presence: false)
        await rig.wallet.tick()
        let store = makeStore()
        let model = makeModel(rig, store: store)
        model.addressText = friend.lowercased
        model.ownership = .mine
        #expect(await model.send() == false)
        #expect(store.book.senders[friend.lowercased] == nil)
        #expect(model.ownership == .mine, "it's still there to try again")
    }

    @Test func aDifferentAddressDoesntKeepTheAnswer() async throws {
        let rig = await Rig(funded)
        await rig.wallet.tick()
        let model = makeModel(rig, store: makeStore())
        model.addressText = friend.lowercased
        model.ownership = .mine
        model.addressText = coldAddress.lowercased
        #expect(model.ownership == nil)
    }

    @Test func accountsInThisWalletAreNeverAskedAbout() async throws {
        let rig = await Rig(funded)
        await rig.wallet.tick()
        let store = makeStore()
        let model = makeModel(rig, store: store)
        model.addressText = coldAddress.lowercased
        #expect(!model.asksIfItsYours)
        #expect(model.knownAs == .mine)
        #expect(store.book.senders[hotAddress.lowercased]?.kind == .mine)
    }

    @Test func aNewSavingsWalletIsLinkedAndARemovedOneIsnt() async throws {
        let rig = await Rig(funded)
        let store = makeStore()
        _ = makeModel(rig, store: store)
        try rig.wallet.addColdWallet(address: friend.lowercased, name: "Keystone")
        #expect(store.book.senders[friend.lowercased]?.kind == .mine)
        rig.wallet.removeColdWallet(friend)
        #expect(store.book.senders[friend.lowercased] == nil)
    }

    @Test func anEarlierAnswerIsntAskedAgain() async throws {
        let rig = await Rig(funded)
        await rig.wallet.tick()
        let store = makeStore()
        store.setBook(store.book.answering(friend.lowercased, .someoneElse, focus: nil))
        let model = makeModel(rig, store: store)
        model.addressText = friend.lowercased
        #expect(!model.asksIfItsYours)
        #expect(model.knownAs == .someoneElse)
    }

    @Test func aMistypedAddressIsntAnAddress() async throws {
        let rig = await Rig(funded)
        await rig.wallet.tick()
        let model = makeModel(rig, store: makeStore())
        // The right address with one letter's case changed, which is what its checksum catches.
        let right = friend.checksummed
        let wrong = "0x000000000000000000000000000000000000dEaD"
        model.addressText = right
        #expect(model.recipient == friend)
        model.addressText = String(wrong.dropLast()) + "d"
        #expect(model.recipient == nil)
        #expect(!model.canSend)
    }

    @Test func aTypedProblemShowsBeforeAsking() async throws {
        let rig = await Rig(funded)
        await rig.wallet.tick()
        let model = makeModel(rig, store: makeStore())
        model.addressText = hotAddress.lowercased
        #expect(model.recipientProblem == .isThisWallet)
        #expect(!model.asksIfItsYours)
        #expect(!model.canSend)
        model.addressText = friend.lowercased
        model.amountText = "41"
        #expect(model.amountProblem == .moreThanHeld)
        #expect(!model.canSend)
    }
}

@MainActor
@Suite struct WritingNotesTests {
    private let note = CostNote.calldata(txHash: "0x" + String(repeating: "ab", count: 32), asset: "USDC", usdMicros: "250000000")!

    @Test func itsAZeroValueSendToItself() async throws {
        let rig = await Rig(funded)
        #expect(await rig.wallet.writeNote(note, asset: "USDC"))
        let transaction = try #require(await rig.signer.signed.first)
        #expect(transaction.to == hotAddress)
        #expect(transaction.value == 0)
        #expect(transaction.data == note)
        let record = try #require(rig.wallet.records.first)
        #expect(record.reason == .note)
        #expect(record.amount == "0")
    }

    @Test func itsOnlyOfferedForThisWallet() async throws {
        let rig = await Rig(funded)
        #expect(rig.wallet.canWriteNote(from: hotAddress.checksummed))
        #expect(!rig.wallet.canWriteNote(from: coldAddress.lowercased), "a cold wallet's notes need its device")
    }

    @Test func nothingIsSignedWithoutThePerson() async throws {
        let rig = await Rig(funded, presence: false)
        #expect(await rig.wallet.writeNote(note, asset: "USDC") == false)
        #expect(await rig.signer.signed.isEmpty)
    }

    @Test func itNeedsEthForTheFee() async throws {
        let rig = await Rig(snapshot(eth: 0, tokens: [usdc: usdcUnits(5)]))
        #expect(await rig.wallet.writeNote(note, asset: "USDC") == false)
        #expect(rig.wallet.noteProblem == HotWalletWording.noGasToSend)
    }

    @Test func aFailedOneSaysItWasntPublished() async throws {
        let rig = await Rig(funded)
        #expect(await rig.wallet.writeNote(note, asset: "USDC"))
        let hash = try #require(rig.wallet.records.first?.hash)
        await rig.chain.setReceipt(hash, succeeded: false)
        await rig.wallet.tick()
        #expect(rig.wallet.sweepProblem == HotWalletWording.failedOnchain(try #require(rig.wallet.records.first)))
    }

    @Test func stoppedDuringARotation() async throws {
        let rig = await Rig(funded)
        await rig.wallet.replaceKey()
        #expect(!rig.wallet.canWriteNote(from: hotAddress.lowercased))
        #expect(await rig.wallet.writeNote(note, asset: "USDC") == false)
    }
}
