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

/// Runs something during gas estimation, which is the wait in the middle of a send.
private actor WaitingChain: ChainClient {
    let current = HotWalletKitTests.snapshot(eth: oneEth / 200, tokens: [usdc: usdcUnits(20)])
    var onEstimate: (@MainActor @Sendable () async -> Void)?
    private(set) var sent: [SignedTransaction] = []

    func setOnEstimate(_ hook: @escaping @MainActor @Sendable () async -> Void) { onEstimate = hook }
    func snapshot(of address: EthereumAddress) -> ChainSnapshot { current }
    func estimateGas(from: EthereumAddress, to: EthereumAddress, value: UInt128, data: [UInt8]) async -> UInt64 {
        await onEstimate?()
        return 60000
    }
    func send(_ transaction: SignedTransaction) { sent.append(transaction) }
    func receipt(of hash: String) -> Receipt? { nil }
    func read(_ method: String, _ parameters: JSONValue) -> RPCAnswer { .success(.null) }
    func l1Fee(ofPayload payload: [UInt8]) -> UInt128 { 1 }
}

@MainActor
private func waitingRig() throws -> (HotWallet, WaitingChain, FakeSigner, ScriptedPortfolios) {
    let chain = WaitingChain()
    let signer = FakeSigner(keys: [hotAddress], next: [nextAddress])
    let stateStore = MemoryStateStore()
    var state = DeviceWalletState()
    state.active = hotAddress
    try stateStore.save(state)
    let source = ScriptedPortfolios(.success(portfolio()))
    let wallet = HotWallet(signer: signer, settingsStore: MemorySettingsStore(), stateStore: stateStore, presence: FakePresence(allows: true), portfolioSource: { source }, makeChain: { _ in chain })
    return (wallet, chain, signer, source)
}

private let stolen = "0x" + String(repeating: "ab", count: 32)

@MainActor
@Suite struct WhileItWaitsTests {
    @Test func anAlarmDuringTheWaitStopsASend() async throws {
        let (wallet, chain, signer, source) = try waitingRig()
        await source.set(.success(portfolio(outgoing: [stolen])))
        await chain.setOnEstimate { await wallet.readHistory() }
        #expect(await wallet.send(SendRequest(token: usdc, amount: usdcUnits(5), to: coldAddress)) == false)
        #expect(wallet.alarm != nil)
        #expect(await signer.signed.isEmpty)
        #expect(await chain.sent.isEmpty)
        #expect(wallet.records.isEmpty)
    }

    @Test func anAlarmDuringTheWaitStopsANote() async throws {
        let (wallet, chain, signer, source) = try waitingRig()
        await source.set(.success(portfolio(outgoing: [stolen])))
        await chain.setOnEstimate { await wallet.readHistory() }
        let note = try #require(CostNote.calldata(txHash: stolen, asset: "USDC", usdMicros: "1"))
        #expect(await wallet.writeNote(note, asset: "USDC", from: hotAddress.lowercased) == false)
        #expect(await signer.signed.isEmpty)
        #expect(await chain.sent.isEmpty)
    }

    @Test func aNoteOnlyEverComesFromTheWalletItWasOfferedFor() async throws {
        let (wallet, _, signer, _) = try waitingRig()
        await wallet.replaceKey()
        await wallet.finishRotationLeavingFundsBehind()
        #expect(wallet.address == nextAddress)
        let note = try #require(CostNote.calldata(txHash: stolen, asset: "USDC", usdMicros: "1"))
        #expect(await wallet.writeNote(note, asset: "USDC", from: hotAddress.lowercased) == false)
        #expect(await signer.signed.allSatisfy { !$0.data.starts(with: Array("patina:cost:1:".utf8)) })
    }

    @Test func theAnswerStaysWithTheAddressItWasFor() async throws {
        let (wallet, chain, _, source) = try waitingRig()
        await wallet.tick()
        let store = PortfolioStore(defaults: UserDefaults(suiteName: "send-tests-\(UUID().uuidString)")!, makeSource: { _ in source })
        defer { store.stop() }
        let model = SendModel(wallet: wallet, store: store)
        model.token = usdc
        model.amountText = "5"
        model.addressText = friend.lowercased
        model.ownership = .mine
        await chain.setOnEstimate {
            // What keeps the sheet's Cancel and Escape from closing it on something that's still going out.
            #expect(model.isSending)
            model.addressText = nextAddress.lowercased
            model.ownership = .someoneElse
        }
        #expect(await model.send())
        #expect(!model.isSending)
        #expect(store.book.senders[friend.lowercased]?.kind == .mine)
        #expect(store.book.senders[nextAddress.lowercased] == nil)
    }
}

/// Says yes, whatever happened while it was asking.
private final class TouchLands: UserPresence, @unchecked Sendable {
    nonisolated(unsafe) var whileAsking: @MainActor (PresencePrompt) -> Void = { _ in }

    func confirm(reason: String) async throws {}

    @MainActor func confirm(reason: String, in prompt: PresencePrompt) async throws {
        whileAsking(prompt)
    }
}

@MainActor
@Suite struct ConfirmingASendTests {
    private func model(presence: Bool = true, userPresence: (any UserPresence)? = nil) async throws -> (SendModel, PortfolioStore, Rig) {
        let rig = await Rig(funded, presence: presence, userPresence: userPresence)
        await rig.wallet.tick()
        let source = ScriptedPortfolios(.success(portfolio()))
        let store = PortfolioStore(defaults: UserDefaults(suiteName: "send-tests-\(UUID().uuidString)")!, makeSource: { _ in source })
        let model = SendModel(wallet: rig.wallet, store: store)
        model.token = usdc
        model.amountText = "5"
        model.addressText = friend.lowercased
        return (model, store, rig)
    }

    // MARK: Picking a saved wallet

    @Test func offersOnlyWhereThisCanSend() async throws {
        let (model, _, rig) = try await model()
        let entry = { WalletEntry(address: $0, name: nil, kind: .watching) }
        #expect(model.canSend(to: entry(friend.lowercased)))
        #expect(!model.canSend(to: entry(try #require(rig.wallet.address).lowercased)))
        #expect(!model.canSend(to: entry(EthereumAddress.zero.lowercased)))
        #expect(!model.canSend(to: entry(try #require(usdc.contract).lowercased)))
        #expect(!model.canSend(to: entry(WalletAddress.demo)))
    }

    /// The name's for finding it. The address is still what's on the confirmation, and a name can't stand in for a changed one.
    @Test func aSavedNameComesWithTheAddressItBelongsTo() async throws {
        let (model, store, _) = try await model()
        #expect(model.recipientName == nil)
        store.renameWallet(friend.lowercased, to: "Treasury")
        #expect(model.recipientName == "Treasury")
        #expect(model.recipient == friend)
        model.addressText = "0x4444444444444444444444444444444444444444"
        #expect(model.recipientName == nil)
    }

    @Test func onlyWhatCanBeSentGetsAsFarAsConfirming() async throws {
        let (model, store, _) = try await model()
        defer { store.stop() }
        model.amountText = "99999"
        model.confirm()
        #expect(model.stage == .composing)
        model.amountText = "5"
        model.confirm()
        #expect(model.stage == .confirming)
        model.backToEditing()
        #expect(model.stage == .composing)
    }

    @Test func aConfirmedSendGoesOutAndSaysSo() async throws {
        let (model, store, rig) = try await model()
        defer { store.stop() }
        model.confirm()
        #expect(await model.sendConfirmed(in: PresencePrompt()) == .done)
        #expect(model.stage == .sent)
        #expect(await rig.signer.signed.count == 1)
        #expect(rig.wallet.nextPromptAt != nil)
    }

    @Test func aPromptThatSaysNoSendsNothingAndStaysOnTheConfirmation() async throws {
        let (model, store, rig) = try await model(presence: false)
        defer { store.stop() }
        model.confirm()
        guard case .failed = await model.sendConfirmed(in: PresencePrompt()) else {
            Issue.record("It should say why")
            return
        }
        #expect(model.stage == .confirming)
        #expect(await rig.signer.signed.isEmpty)
    }

    private func waitForTheNode(_ rig: Rig) async {
        for _ in 0..<5000 {
            if await rig.chain.heldCalls > 0 { return }
            try? await Task.sleep(for: .milliseconds(1))
        }
        Issue.record("Nothing reached the node")
    }

    /// So nothing on screen can look like it called back what's about to be signed anyway.
    @Test func editingStopsWorkingOnceTouchIDHasSaidYesWhileItWaitsForTheNode() async throws {
        let (model, store, rig) = try await model()
        defer { store.stop() }
        model.confirm()
        let gate = ApprovalPrompt(sleep: { _ in }) { prompt, _ in await model.sendConfirmed(in: prompt) }
        gate.promptPaired(gate.prompt)
        await rig.chain.hold(snapshots: true)
        gate.windowChanged(isInFront: true)
        await waitForTheNode(rig)
        #expect(gate.phase == .working)
        model.backToEditing()
        #expect(model.stage == .confirming, "there's no going back from here")
        gate.stop()
        #expect(gate.phase == .working, "going away doesn't change what's underway")
        await rig.chain.release()
        for _ in 0..<5000 where gate.phase == .working {
            try? await Task.sleep(for: .milliseconds(1))
        }
        #expect(gate.phase == .done)
        #expect(model.stage == .sent)
        #expect(await rig.signer.signed.count == 1)
    }

    @Test func aSweepIsWorkingOnceTouchIDHasSaidYesWhileItWaitsForTheNode() async throws {
        let rig = await Rig(funded, presence: true)
        let wallet = rig.wallet
        await wallet.tick()
        let gate = ApprovalPrompt(sleep: { _ in }) { prompt, _ in
            await wallet.sweepConfirmed(in: prompt)
        }
        gate.promptPaired(gate.prompt)
        await rig.chain.hold(snapshots: true)
        gate.windowChanged(isInFront: true)
        await waitForTheNode(rig)
        #expect(gate.phase == .working)
        await rig.chain.release()
        for _ in 0..<5000 where gate.phase == .working {
            try? await Task.sleep(for: .milliseconds(1))
        }
        #expect(gate.phase == .done)
    }

    @Test func backingOutAsTheTouchLandsStopsASend() async throws {
        let presence = TouchLands()
        let (model, store, rig) = try await model(userPresence: presence)
        defer { store.stop() }
        presence.whileAsking = { _ in model.backToEditing() }
        model.confirm()
        #expect(await model.sendConfirmed(in: PresencePrompt()) == .cancelled)
        #expect(model.stage == .composing, "it can still be called off while it's asking")
        #expect(await rig.signer.signed.isEmpty)
    }

    @Test func backingOutAsTheTouchLandsStopsASweep() async throws {
        let presence = TouchLands()
        let rig = await Rig(funded, userPresence: presence)
        let wallet = rig.wallet
        await wallet.tick()
        let gate = ApprovalPrompt(sleep: { _ in }) { prompt, _ in
            await wallet.sweepConfirmed(in: prompt)
        }
        presence.whileAsking = { _ in #expect(gate.backOut()) }
        gate.promptPaired(gate.prompt)
        gate.windowChanged(isInFront: true)
        for _ in 0..<5000 where gate.phase != .stopped(nil) {
            try? await Task.sleep(for: .milliseconds(1))
        }
        #expect(gate.phase == .stopped(nil))
        #expect(wallet.sweepProblem == nil, "changing their mind isn't a problem to report")
        #expect(await rig.signer.signed.isEmpty)
    }

    @Test func aSendLeftBeforeItsPromptStartsNeverAsks() async throws {
        let presence = TouchLands()
        let (model, store, rig) = try await model(userPresence: presence)
        defer { store.stop() }
        var asked = false
        presence.whileAsking = { _ in asked = true }
        model.confirm()
        model.backToEditing()
        #expect(await model.sendConfirmed(in: PresencePrompt()) == .cancelled)
        #expect(!asked)
        #expect(await rig.signer.signed.isEmpty)
    }

    @Test func thereIsNoBackingOutOnceTouchIDHasSaidYes() async throws {
        let (model, store, rig) = try await model()
        defer { store.stop() }
        model.confirm()
        let gate = ApprovalPrompt(sleep: { _ in }) { prompt, _ in await model.sendConfirmed(in: prompt) }
        gate.promptPaired(gate.prompt)
        await rig.chain.hold(snapshots: true)
        gate.windowChanged(isInFront: true)
        await waitForTheNode(rig)
        #expect(gate.backOut() == false)
        #expect(!gate.prompt.isCancelled)
        await rig.chain.release()
        for _ in 0..<5000 where gate.phase == .working {
            try? await Task.sleep(for: .milliseconds(1))
        }
        #expect(gate.phase == .done, "and it can still say how it ended")
        #expect(await rig.signer.signed.count == 1)
    }

    @Test func theSweepShownIsWhatItWouldMove() async throws {
        let rig = await Rig(funded, presence: true)
        await rig.wallet.tick()
        let preview = try #require(rig.wallet.sweepPreview)
        #expect(preview.transfers.contains { $0.token == usdc && $0.amount == usdcUnits(20) })
        let eth = try #require(preview.transfers.first { $0.token.isNative })
        #expect(eth.amount < oneEth / 200, "it can't move what pays for moving it")
        #expect(preview.valueUsdMicros != nil)
        #expect(preview.feeWei > 0)
    }

    @Test func sweepingSaysWhetherItWentOut() async throws {
        let rig = await Rig(funded, presence: false)
        #expect(await rig.wallet.sweepEverything(in: PresencePrompt()) == false)
        #expect(await rig.signer.signed.isEmpty)
        let allowed = await Rig(funded, presence: true)
        #expect(await allowed.wallet.sweepEverything(in: PresencePrompt()))
    }

    /// Through the same gate as the sheet, up to wherever it stops. Only `.done` closes the sheet and says "On its way".
    private func approveSweep(on wallet: HotWallet) async -> ApprovalPrompt.Phase {
        let gate = ApprovalPrompt(sleep: { _ in }) { prompt, _ in await wallet.sweepConfirmed(in: prompt) }
        gate.promptPaired(gate.prompt)
        gate.windowChanged(isInFront: true)
        for _ in 0..<5000 {
            switch gate.phase {
            case .done, .stopped: return gate.phase
            default: try? await Task.sleep(for: .milliseconds(1))
            }
        }
        return gate.phase
    }

    @Test func aSweepTheNodeRejectsStaysOnTheSheet() async throws {
        let rig = await Rig(snapshot(tokens: [usdc: usdcUnits(10)]))
        await rig.chain.setSendFailure(.rejected("insufficient funds"))
        let phase = await approveSweep(on: rig.wallet)
        #expect(phase == .stopped(rig.wallet.sweepProblem))
        #expect(rig.wallet.sweepProblem == "A sweep of USDC didn't go out. There isn't enough ETH for this and its network fee. Add some ETH, then try again.")
        #expect(await rig.chain.sent.isEmpty)
    }

    @Test func aSweepWhoseEstimateFailsStaysOnTheSheet() async throws {
        let rig = await Rig(snapshot(tokens: [usdc: usdcUnits(10)]))
        await rig.chain.setEstimateFailure(.rejected("execution reverted"))
        #expect(await approveSweep(on: rig.wallet) == .stopped("A sweep of USDC didn't go out. \(HotWalletWording.refusal("execution reverted"))"))
        #expect(await rig.signer.signed.isEmpty)
    }

    @Test func aSweepAtFeesNoOneWouldChargeStaysOnTheSheet() async throws {
        let absurd = FeeQuote(maxFeePerGas: FeeQuote.highestPlausibleFeePerGas + 1, maxPriorityFeePerGas: FeeQuote.highestPlausibleFeePerGas, l1FeeWei: 0)
        let rig = await Rig(snapshot(eth: oneEth, tokens: [usdc: usdcUnits(10)], fees: absurd))
        #expect(await approveSweep(on: rig.wallet) == .stopped(HotWalletWording.feesLookWrong))
        #expect(await rig.signer.signed.isEmpty)
    }

    @Test func sweepingNothingSaysSo() async throws {
        let rig = await Rig(snapshot(eth: 0))
        #expect(await approveSweep(on: rig.wallet) == .stopped("There's nothing on this wallet to sweep."))
        #expect(await rig.signer.signed.isEmpty)
    }

    @Test func sweepingOnlyWhatsTooCostlyToMoveSaysSo() async throws {
        let rig = await Rig(snapshot(eth: 0, tokens: [usdc: 1]))
        #expect(await approveSweep(on: rig.wallet) == .stopped("There's nothing to sweep except some USDC that gas makes too costly to move right now."))
        #expect(await rig.signer.signed.isEmpty)
    }

    /// With no Touch ID to give, asking would end in nothing moving and no reason why, so a reason means it never asked.
    @Test(arguments: [
        (snapshot(eth: 0), "There's nothing on this wallet to sweep."),
        (snapshot(eth: 0, tokens: [usdc: 1]), "There's nothing to sweep except some USDC that gas makes too costly to move right now."),
        (snapshot(eth: 0, tokens: [usdc: usdcUnits(10)]), HotWalletWording.noGas),
    ]) func sweepingWhatTheLastReadSaysCantMoveDoesntAskForTouchID(held: ChainSnapshot, problem: String) async throws {
        let rig = await Rig(held, presence: false)
        await rig.wallet.tick()
        #expect(rig.wallet.sweepPreview?.whyNothing == problem)
        #expect(await approveSweep(on: rig.wallet) == .stopped(problem))
    }

    /// An automatic sweep needs no Touch ID, so one can be going with none to give. A reason means it never asked.
    @Test func sweepingWhileASweepIsOnItsWayDoesntAskForTouchID() async throws {
        let rig = await Rig(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(60)]), presence: false)
        await rig.wallet.tick()
        #expect(await rig.chain.sent.count == 1)
        #expect(await approveSweep(on: rig.wallet) == .stopped(HotWalletWording.lastOneOnItsWay))
        #expect(await rig.chain.sent.count == 1)
    }

    @Test func sweepingBeforeTheLastSweepShowsUpDoesntAskForTouchID() async throws {
        let rig = await Rig(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(60)]), presence: false)
        await rig.wallet.tick()
        await rig.chain.confirmAll()
        await rig.wallet.tick()
        #expect(rig.stateStore.saved.settledThroughBlock == 1001)
        #expect(await approveSweep(on: rig.wallet) == .stopped(HotWalletWording.lastOneStillShowingUp))
        #expect(await rig.chain.sent.count == 1)
    }

    @Test func aSweepWithSomethingToMoveHasNoReasonItWouldnt() async throws {
        let rig = await Rig(funded)
        await rig.wallet.tick()
        #expect(rig.wallet.sweepPreview?.whyNothing == nil)
    }

    @Test func moneyArrivingAfterNothingToSweepCanBeSwept() async throws {
        let rig = await Rig(snapshot(eth: 0))
        await rig.wallet.tick()
        #expect(await rig.wallet.sweepEverything(in: PresencePrompt()) == false)
        await rig.chain.set(funded)
        await rig.wallet.tick()
        #expect(rig.wallet.sweepPreview?.whyNothing == nil)
        #expect(await rig.wallet.sweepEverything(in: PresencePrompt()))
        #expect(await rig.chain.sent.count == 2)
    }

    /// The last read isn't what decides: it had something, and only the fresh one after Touch ID knows it's gone.
    @Test func aSweepOfWhatsAlreadyGoneStillSaysSo() async throws {
        let rig = await Rig(funded)
        await rig.wallet.tick()
        await rig.chain.set(snapshot(eth: 0))
        #expect(await approveSweep(on: rig.wallet) == .stopped("There's nothing on this wallet to sweep."))
        #expect(await rig.signer.signed.isEmpty)
    }

    @Test func aSweepThatStopsPartwaySaysWhatWentAndWhatDidnt() async throws {
        let rig = await Rig(funded)
        await rig.chain.setSendFailure(.rejected("nonce too low"), afterSends: 1)
        #expect(await approveSweep(on: rig.wallet) == .stopped("USDC is on its way, but ETH isn't. A sweep of ETH didn't go out. Another transaction from this wallet went first. Try again in a moment."))
        #expect(await rig.chain.sent.count == 1)
        #expect(rig.wallet.records.map(\.status) == [.dropped, .pending])

        // What went has to land first, so trying again can't reuse its nonce. Then only what's left goes.
        await rig.chain.setSendFailure(nil)
        #expect(await rig.wallet.sweepEverything(in: PresencePrompt()) == false)
        #expect(rig.wallet.sweepProblem == HotWalletWording.lastOneOnItsWay)
        #expect(await rig.chain.sent.count == 1)

        await rig.chain.confirmAll()
        await rig.chain.set(snapshot(eth: oneEth / 200, nonce: 1))
        await rig.wallet.tick()
        #expect(await rig.wallet.sweepEverything(in: PresencePrompt()))
        #expect(await rig.chain.sent.count == 2)
        #expect(await rig.signer.signed.last?.to == coldAddress)
    }

    @Test func aSweepThatLosesTheNetworkPartwayDoesntSayNothingWent() async throws {
        let rig = await Rig(funded)
        await rig.chain.setEstimateFailure(.unreachable, afterSends: 1)
        #expect(await approveSweep(on: rig.wallet) == .stopped("USDC is on its way, but ETH isn't. The network stopped answering. Try again in a moment."))
        #expect(await rig.chain.sent.count == 1)
    }

    @Test func aSweepTheNetworkLimitsPartwaySaysSo() async throws {
        let rig = await Rig(funded)
        await rig.chain.setSendFailure(.rateLimited, afterSends: 1)
        #expect(await approveSweep(on: rig.wallet) == .stopped("USDC is on its way, but ETH isn't. \(HotWalletWording.networkBusy)"))
    }

    @Test func aSweepThatMightHaveGoneCountsAsOnItsWay() async throws {
        let rig = await Rig(snapshot())
        await rig.chain.setSendFailure(.unreachable)
        #expect(await approveSweep(on: rig.wallet) == .done)
        #expect(rig.wallet.records.map(\.status) == [.pending])
        #expect(rig.wallet.sweepProblem == nil)
    }

    @Test func aSweepThatMightHaveGoneButHadMoreLeftSaysSo() async throws {
        let rig = await Rig(funded)
        await rig.chain.setSendFailure(.unreachable)
        #expect(await approveSweep(on: rig.wallet) == .stopped("USDC is on its way, but ETH isn't. The network stopped answering. Try again in a moment."))
        #expect(rig.wallet.records.map(\.status) == [.pending])
    }
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

    /// What's in the way isn't always a sweep, so the wait doesn't call it one.
    @Test func sweepingAfterASendSaysTheLastTransactionIsInTheWay() async throws {
        let rig = await Rig(funded)
        #expect(await rig.wallet.send(SendRequest(token: usdc, amount: usdcUnits(5), to: friend)))
        #expect(await rig.wallet.sweepEverything(in: PresencePrompt()) == false)
        #expect(rig.wallet.sweepProblem == HotWalletWording.lastOneOnItsWay)

        await rig.chain.confirmAll()
        await rig.wallet.tick()
        #expect(rig.stateStore.saved.settledThroughBlock == 1001)
        #expect(await rig.wallet.sweepEverything(in: PresencePrompt()) == false)
        #expect(rig.wallet.sweepProblem == HotWalletWording.lastOneStillShowingUp)
        #expect(await rig.chain.sent.count == 1)
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
        #expect(rig.wallet.sweepProblem == "Nothing was sent. The network refused it, saying \u{201C}nope\u{201D}. Try again in a moment.")
    }

    @Test func amountsAreReadExactly() {
        #expect(Money.units(fromText: "1.5", decimals: 6) == 1_500_000)
        #expect(Money.units(fromText: "1,000", decimals: 6) == 1_000_000_000)
        #expect(Money.units(fromText: "1,5", decimals: 6) == 1_500_000, "a decimal comma isn't thousands")
        #expect(Money.units(fromText: "46,20", decimals: 6) == 46_200_000)
        #expect(Money.units(fromText: ".25", decimals: 2) == 25)
        #expect(Money.units(fromText: "1.", decimals: 2) == 100)
        #expect(Money.units(fromText: "1.1234567", decimals: 6) == nil, "rounding someone's money isn't this app's call")
        for bad in ["", ".", "-1", "1e5", "1.2.3", "abc", "$5", "1.234,50", "12,3456", "1,23,456", "0,125"] { #expect(Money.units(fromText: bad, decimals: 6) == nil, "\(bad)") }
        #expect(Money.units(fromText: String(repeating: "9", count: 60), decimals: 18) == nil)
    }

    @Test func theMaximumReadsBackExactly() {
        for (units, decimals, text) in [(UInt128(1_500_000), 6, "1.5"), (0, 6, "0"), (7, 18, "0.000000000000000007"), (2_000_000, 6, "2"), (5, 0, "5")] {
            #expect(Money.text(ofUnits: units, decimals: decimals) == text)
            #expect(Money.units(fromText: text, decimals: decimals) == units)
        }
    }

    @Test func anAmountIsConfirmedTheWayItWasTyped() {
        for (typed, decimals, shown) in [("12.50", 6, "12.50"), ("12,50", 6, "12.50"), ("12.5", 6, "12.5"), ("12", 6, "12"), ("12.", 6, "12"), ("0.10", 18, "0.10"), ("7", 0, "7"), ("1,000", 6, "1000")] {
            let units = Money.units(fromText: typed, decimals: decimals)!
            let text = Money.text(ofUnits: units, decimals: decimals, minimumFractionDigits: Money.fractionDigits(inText: typed))
            #expect(text == shown, "\(typed)")
            #expect(Money.units(fromText: text, decimals: decimals) == units, "it's still exactly the same amount")
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
        try await rig.wallet.addColdWallet(address: friend.lowercased, name: "Keystone")
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
        #expect(await rig.wallet.writeNote(note, asset: "USDC", from: hotAddress.lowercased))
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
        #expect(await rig.wallet.writeNote(note, asset: "USDC", from: hotAddress.lowercased) == false)
        #expect(await rig.signer.signed.isEmpty)
    }

    @Test func itNeedsEthForTheFee() async throws {
        let rig = await Rig(snapshot(eth: 0, tokens: [usdc: usdcUnits(5)]))
        #expect(await rig.wallet.writeNote(note, asset: "USDC", from: hotAddress.lowercased) == false)
        #expect(rig.wallet.noteProblem == HotWalletWording.noGasToSend)
    }

    @Test func aFailedOneSaysItWasntPublished() async throws {
        let rig = await Rig(funded)
        #expect(await rig.wallet.writeNote(note, asset: "USDC", from: hotAddress.lowercased))
        let hash = try #require(rig.wallet.records.first?.hash)
        await rig.chain.setReceipt(hash, succeeded: false)
        await rig.wallet.tick()
        #expect(rig.wallet.sweepProblem == HotWalletWording.failedOnchain(try #require(rig.wallet.records.first)))
    }

    @Test func stoppedDuringARotation() async throws {
        let rig = await Rig(funded)
        await rig.wallet.replaceKey()
        #expect(!rig.wallet.canWriteNote(from: hotAddress.lowercased))
        #expect(await rig.wallet.writeNote(note, asset: "USDC", from: hotAddress.lowercased) == false)
    }
}

@MainActor
@Suite struct SendsAndNotesBetweenTicksTests {
    private let note = CostNote.calldata(txHash: stolen, asset: "USDC", usdMicros: "250000000")!

    private func sign(_ reason: SignedRecord.Reason, on rig: Rig) async throws -> String {
        let isOnItsWay = reason == .note
            ? await rig.wallet.writeNote(note, asset: "USDC", from: hotAddress.lowercased)
            : await rig.wallet.send(SendRequest(token: usdc, amount: usdcUnits(5), to: friend))
        #expect(isOnItsWay)
        let record = try #require(rig.wallet.records.first)
        #expect(record.reason == reason)
        #expect(record.status == .pending)
        return record.hash
    }

    @Test(arguments: [SignedRecord.Reason.sent, .note])
    func aRunningWalletShowsItLandingWithoutATick(_ reason: SignedRecord.Reason) async throws {
        let rig = await Rig(funded, tickDelay: .seconds(3600), receiptDelay: .milliseconds(10))
        rig.wallet.start()
        defer { rig.wallet.stop() }
        for _ in 0..<500 where rig.wallet.snapshot == nil { try await Task.sleep(for: .milliseconds(10)) }
        _ = try await sign(reason, on: rig)
        await rig.chain.confirmAll()
        for _ in 0..<500 where rig.wallet.records.first?.status != .confirmed { try await Task.sleep(for: .milliseconds(10)) }
        #expect(rig.wallet.records.first?.status == .confirmed)
        #expect(rig.wallet.sweepProblem == nil)
    }

    @Test(arguments: [SignedRecord.Reason.sent, .note])
    func oneThatLandsCatchesBalancesUp(_ reason: SignedRecord.Reason) async throws {
        let rig = await Rig(funded)
        _ = try await sign(reason, on: rig)
        await rig.chain.confirmAll()
        await rig.wallet.lookBetweenTicks()
        #expect(rig.wallet.records.first?.status == .confirmed)
        #expect(rig.wallet.snapshot?.nonce == 0, "the node's latest block doesn't include it yet")

        await rig.chain.set(snapshot(eth: oneEth / 200, tokens: [usdc: usdcUnits(15)], nonce: 1))
        await rig.wallet.lookBetweenTicks()
        #expect(rig.wallet.snapshot?.nonce == 1)
        #expect(rig.wallet.sweepProblem == nil)
        #expect(rig.stateStore.saved.sweptGains[hotAddress] == nil)
    }

    @Test(arguments: [SignedRecord.Reason.sent, .note])
    func oneThatRevertsSaysSoAndDoesntPauseSweeps(_ reason: SignedRecord.Reason) async throws {
        let rig = await Rig(funded)
        let hash = try await sign(reason, on: rig)
        await rig.chain.setReceipt(hash, succeeded: false)
        await rig.wallet.lookBetweenTicks()
        let record = try #require(rig.wallet.records.first)
        #expect(record.status == .failed)
        #expect(rig.wallet.sweepProblem == HotWalletWording.failedOnchain(record))

        await rig.chain.set(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(60)], nonce: 1))
        await rig.wallet.tick()
        #expect(await rig.chain.sent.count == 2, "the next deposit still sweeps")
    }
}

struct LandingTests {
    private func record(_ nonce: UInt64, _ status: SignedRecord.Status) -> SignedRecord {
        SignedRecord(hash: "0x\(nonce)", nonce: nonce, to: EthereumAddress("0x00000000000000000000000000000000000de302")!, symbol: "USDC", decimals: 6, amount: "1", usdMicros: nil, gainUsdMicros: "0", reason: .sent, createdAt: .distantPast, status: status)
    }

    @Test func nothingHasLandedUntilEveryReceiptSaysSo() {
        #expect(Landing([]) == .onItsWay)
        #expect(Landing([record(1, .pending)]) == .onItsWay)
        #expect(Landing([record(1, .confirmed), record(2, .pending)]) == .onItsWay)
        #expect(Landing([record(1, .confirmed), record(2, .confirmed)]) == .landed)
        #expect(Landing([record(1, .confirmed), record(2, .failed)]) == .didntLand)
        #expect(Landing([record(1, .pending), record(2, .dropped)]) == .didntLand)
    }
}

/// A display that can change under a send, the way a rate does.
@MainActor
private final class Display {
    var current = MoneyDisplay(main: .CAD, rateMicros: "1400000")
}

@MainActor
@Suite struct TypingInMoneyTests {
    private func model(_ display: Display = Display()) async -> (SendModel, PortfolioStore) {
        let rig = await Rig(funded, moneyDisplay: { display.current })
        await rig.wallet.tick()
        let store = makeStore()
        let model = SendModel(wallet: rig.wallet, store: store)
        model.token = usdc
        model.addressText = friend.lowercased
        return (model, store)
    }

    @Test func moneyBecomesTheTokenAmountItBuys() async {
        let (model, store) = await model()
        defer { store.stop() }
        #expect(model.canTypeMoney)
        model.switchUnit()
        model.amountText = "14"
        #expect(model.amount == usdcUnits(10), "CA$14 at 1.4 is US$10, which is 10 USDC")
        #expect(model.tokenAmountText == "10 USDC")
        #expect(model.availableText == "$28.00")
    }

    @Test func switchingKeepsTheAmount() async {
        let (model, store) = await model()
        defer { store.stop() }
        model.amountText = "5"
        model.switchUnit()
        #expect(model.unit == .money)
        #expect(model.amountText == "7.00")
        #expect(model.amount == usdcUnits(5))
        model.switchUnit()
        #expect(model.amountText == "5")
    }

    @Test func maxInMoneyIsExactlyTheMost() async {
        let display = Display()
        display.current = MoneyDisplay(main: .CAD, rateMicros: "1333333")
        let (model, store) = await model(display)
        defer { store.stop() }
        model.switchUnit()
        model.useMaximum()
        #expect(model.amount == model.maximum, "not what the rounded money would buy")
        model.amountText = "1"
        #expect(model.amount != model.maximum)
    }

    /// What Touch ID is asked about is what's on the confirmation, whatever the rate does meanwhile.
    @Test func aRateThatMovesAfterConfirmingChangesNothingSigned() async {
        let display = Display()
        let (model, store) = await model(display)
        defer { store.stop() }
        model.switchUnit()
        model.amountText = "14"
        model.confirm()
        #expect(model.stage == .confirming)
        display.current = MoneyDisplay(main: .CAD, rateMicros: "2000000")
        #expect(model.amount == usdcUnits(10))
        model.backToEditing()
        #expect(model.amount == usdcUnits(7), "editing again uses the rate as it is now")
    }

    /// Max stands for what it showed. A deposit afterwards doesn't make it more, and an edit makes it ordinary money again.
    @Test func maxStaysWhatItShowed() async {
        let rig = await Rig(snapshot(tokens: [usdc: usdcUnits(20)]), withCold: false)
        await rig.wallet.tick()
        let store = makeStore()
        defer { store.stop() }
        let model = SendModel(wallet: rig.wallet, store: store)
        model.token = usdc
        model.addressText = coldAddress.lowercased
        model.switchUnit()
        model.useMaximum()
        #expect(model.amountText == "20.00")
        await rig.chain.set(snapshot(tokens: [usdc: usdcUnits(40)]))
        await rig.wallet.tick()
        #expect(model.amount == usdcUnits(20), "what $20.00 showed, not the new balance")
        model.amountText = "1"
        model.amountText = "20.00"
        #expect(model.amount == usdcUnits(20), "typed again, it's $20 of USDC")
    }

    @Test func aMoneyAmountWithNoPriceLeftIsntReadAsTokens() async {
        let aero = token("AERO")
        let rig = await Rig(snapshot(tokens: [aero: oneEth * 20], prices: ["AERO": 2 * Money.dollar]), withCold: false)
        await rig.wallet.tick()
        let store = makeStore()
        defer { store.stop() }
        let model = SendModel(wallet: rig.wallet, store: store)
        model.token = aero
        model.addressText = coldAddress.lowercased
        model.switchUnit()
        model.amountText = "10"
        #expect(model.amount == oneEth * 5)
        await rig.chain.set(snapshot(tokens: [aero: oneEth * 20], prices: [:]))
        await rig.wallet.tick()
        #expect(model.amount == nil)
        model.switchUnit()
        #expect(model.unit == .token)
        #expect(model.amountText.isEmpty, "$10 isn't 10 AERO")
        #expect(!model.canSend)
    }

    @Test func maxWithNoPriceLeftShowsTokens() async {
        let aero = token("AERO")
        let rig = await Rig(snapshot(tokens: [aero: oneEth * 20], prices: ["AERO": 2 * Money.dollar]), withCold: false)
        await rig.wallet.tick()
        let store = makeStore()
        defer { store.stop() }
        let model = SendModel(wallet: rig.wallet, store: store)
        model.token = aero
        model.addressText = coldAddress.lowercased
        model.switchUnit()
        model.amountText = "10"
        await rig.chain.set(snapshot(tokens: [aero: oneEth * 20], prices: [:]))
        await rig.wallet.tick()
        model.useMaximum()
        #expect(model.unit == .token)
        #expect(model.amountText == "20", "never an empty field standing for the whole balance")
        #expect(model.amount == oneEth * 20)
    }

    @Test func aTokenWithNoPriceIsTypedInItself() async {
        let rig = await Rig(snapshot(eth: oneEth / 200, tokens: [usdc: usdcUnits(20), dai: oneEth]))
        await rig.wallet.tick()
        let store = makeStore()
        defer { store.stop() }
        let model = SendModel(wallet: rig.wallet, store: store)
        model.token = usdc
        model.switchUnit()
        model.amountText = "3"
        model.token = dai
        #expect(!model.canTypeMoney)
        #expect(model.unit == .token)
        #expect(model.amountText.isEmpty, "3 dollars isn't 3 DAI")
    }
}

@MainActor
@Suite struct LookalikeTests {
    /// Starts with 123 and ends with 890, like the rig's Ledger.
    private let poisoned = EthereumAddress("0x123aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa890")!

    private func model() async -> (SendModel, PortfolioStore, Rig) {
        let rig = await Rig(funded)
        await rig.wallet.tick()
        let store = makeStore()
        let model = SendModel(wallet: rig.wallet, store: store)
        model.token = usdc
        model.amountText = "5"
        return (model, store, rig)
    }

    @Test func anAddressThatOnlyLooksLikeASavingsWalletNeedsADeliberateStep() async {
        let (model, store, _) = await model()
        defer { store.stop() }
        model.addressText = poisoned.lowercased
        #expect(model.lookalike == LookalikeMatch(address: coldAddress, name: "Ledger"))
        #expect(!model.canSend)
        #expect(!model.asksIfItsYours, "\"My wallet\" is the wrong thing to offer here")
        model.acceptsLookalike = true
        #expect(model.canSend)
        model.addressText = ""
        model.addressText = poisoned.checksummed
        #expect(!model.acceptsLookalike, "it's asked again for each address")
    }

    @Test func theRealOneIsntALookalike() async {
        let (model, store, _) = await model()
        defer { store.stop() }
        model.addressText = coldAddress.lowercased
        #expect(model.lookalike == nil)
        #expect(model.canSend)
    }

    @Test func oneLikeThisWalletOrAPastRecipientCounts() async {
        let (model, store, rig) = await model()
        defer { store.stop() }
        model.addressText = "0x111bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb111"
        #expect(model.lookalike?.name == HotWalletWording.title)
        #expect(await rig.wallet.send(SendRequest(token: usdc, amount: usdcUnits(1), to: friend)))
        model.addressText = "0x333ccccccccccccccccccccccccccccccccc3333"
        #expect(model.lookalike == LookalikeMatch(address: friend, name: "an address you've sent to"))
    }

    @Test func aSavedNameComesFirst() async {
        let (model, store, _) = await model()
        defer { store.stop() }
        store.renameWallet(friend.lowercased, to: "Treasury")
        model.addressText = "0x333ccccccccccccccccccccccccccccccccc3333"
        #expect(model.lookalike?.name == "Treasury")
    }
}

@Suite struct SendFailureWordingTests {
    @Test func whatANodeSaysBecomesWhatToDo() {
        #expect(HotWalletWording.notSent("insufficient funds for gas * price + value") == "Nothing was sent. There isn't enough ETH for this and its network fee. Add some ETH, then try again.")
        #expect(HotWalletWording.refusal("execution reverted: ERC20: transfer amount exceeds balance").hasPrefix("The token's contract refused it."))
        #expect(HotWalletWording.refusal("nonce too low").hasPrefix("Another transaction"))
        #expect(HotWalletWording.refusal("replacement transaction underpriced").hasPrefix("Another transaction"))
        #expect(HotWalletWording.refusal("max fee per gas less than block base fee").hasPrefix("Network fees went up"))
        #expect(HotWalletWording.refusal("something new").contains("\u{201C}something new\u{201D}"), "one it doesn't know keeps the node's words")
    }

    @Test func aWalletProblemIsSaidForASend() {
        #expect(HotWalletWording.sendFailure(HotWalletWording.cantReachChain).hasPrefix("Nothing was sent"))
        #expect(HotWalletWording.sendFailure(HotWalletWording.touchIDDidNotConfirm).hasPrefix("Nothing was sent"))
        #expect(HotWalletWording.sendFailure(HotWalletWording.lastOneOnItsWay) == HotWalletWording.lastOneOnItsWay)
    }

    @MainActor
    @Test func aSendTheNodeRefusesSaysSoPlainly() async {
        let rig = await Rig(funded)
        await rig.wallet.tick()
        await rig.chain.setEstimateFailure(.rejected("execution reverted"))
        let store = makeStore()
        defer { store.stop() }
        let model = SendModel(wallet: rig.wallet, store: store)
        model.token = usdc
        model.amountText = "5"
        model.addressText = friend.lowercased
        #expect(await model.send() == false)
        #expect(model.failure == HotWalletWording.notSent("execution reverted"))
    }
}
