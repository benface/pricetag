import Foundation
import KeyVault
import PricetagKit
import Testing
@testable import HotWalletKit

private let over: ChainSnapshot = snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(500)])
private let otherHash = "0x" + String(repeating: "ab", count: 32)

/// The address and amount a transaction's calldata sends, read back from its bytes.
private func recipient(_ transaction: UnsignedTransaction) -> EthereumAddress? {
    EthereumAddress("0x" + Hex.encode(transaction.data[16..<36]))
}

@MainActor
@Suite struct SweepingTests {
    @Test func sweepsAboveTheCapToTheColdWalletWithNoPrompt() async throws {
        // No presence: the prompt would refuse, so this only works if a sweep never asks.
        let rig = await Rig(over, presence: false)
        await rig.wallet.tick()
        let signed = await rig.signer.signed
        let transaction = try #require(signed.first)
        #expect(signed.count == 1)
        #expect(transaction.to == usdc.contract)
        #expect(transaction.value == 0)
        #expect(recipient(transaction) == coldAddress)
        #expect(transaction.chainID == 8453)
        #expect(await rig.chain.sent.count == 1)
        #expect(rig.wallet.records.first?.status == .pending)
    }

    @Test func aTokenSweepNeverSendsAnywhereButTheChosenWallet() async throws {
        let rig = await Rig(over)
        let second = EthereumAddress("0x3333333333333333333333333333333333333333")!
        try rig.wallet.addColdWallet(address: second.lowercased, name: "Keystone")
        rig.wallet.setSweepDestination(second)
        await rig.wallet.tick()
        #expect(recipient(try #require(await rig.signer.signed.first)) == second)
    }

    @Test func twoAtOnceDontUseTheSameNonce() async throws {
        let rig = await Rig(snapshot(eth: oneEth / 100, tokens: [usdc: usdcUnits(500)]))
        async let tick: Void = rig.wallet.tick()
        async let sweep: Void = rig.wallet.sweepEverything()
        _ = await (tick, sweep)
        let nonces = await rig.signer.signed.map(\.nonce)
        #expect(Set(nonces).count == nonces.count)
    }

    @Test func writesTheRecordDownBeforeBroadcasting() async throws {
        let rig = await Rig(over)
        let store = rig.stateStore
        let seen = Seen()
        await rig.chain.setOnSend { transaction in
            seen.set(store.saved.records[hotAddress]?.contains { $0.hash == transaction.hash } ?? false)
        }
        await rig.wallet.tick()
        #expect(seen.value == true)
    }

    @Test func doesNothingWhileASweepIsOnItsWay() async throws {
        let rig = await Rig(over)
        await rig.wallet.tick()
        await rig.wallet.tick()
        #expect(await rig.chain.sent.count == 1)
    }

    @Test func aConfirmedSweepClearsTheWayForTheNext() async throws {
        let rig = await Rig(over)
        await rig.wallet.tick()
        await rig.chain.confirmAll()
        await rig.chain.set(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(500)], nonce: 1))
        await rig.wallet.tick()
        #expect(rig.wallet.records.count == 2)
        #expect(rig.wallet.records.last?.status == .confirmed)
        #expect(await rig.signer.signed.last?.nonce == 1)
    }

    @Test func noColdWalletMeansNoSigningAndALowerCap() async throws {
        let rig = await Rig(over, withCold: false)
        await rig.wallet.tick()
        #expect(await rig.signer.signed.isEmpty)
        #expect(rig.wallet.plan?.blockers == [.noDestination])
        #expect(rig.wallet.settings.capInDollars == 25)
    }

    @Test func refusesToSignOnAnotherChain() async throws {
        let rig = await Rig(snapshot(eth: oneEth, tokens: [usdc: usdcUnits(500)], chainID: 1))
        await rig.wallet.tick()
        #expect(await rig.signer.signed.isEmpty)
        await rig.wallet.sweepEverything()
        #expect(await rig.signer.signed.isEmpty)
        #expect(rig.wallet.sweepProblem == HotWalletWording.wrongChain)
    }

    @Test func aFailedReadDoesntLookLikeAnEmptyWallet() async throws {
        let rig = await Rig(over)
        await rig.wallet.tick()
        let chain = FailingChain()
        let stateStore = rig.stateStore
        let wallet = HotWallet(signer: rig.signer, settingsStore: MemorySettingsStore(), stateStore: stateStore, portfolioSource: { rig.portfolios }, makeChain: { _ in chain })
        await wallet.tick()
        #expect(wallet.chainProblem == .unreachable)
        #expect(wallet.snapshot == nil)
    }

    @Test func aRejectedSweepWaitsBeforeTryingAgain() async throws {
        let clock = Clock()
        let rig = await Rig(over, now: { clock.now })
        await rig.chain.setSendFailure(.rejected("insufficient funds"))
        await rig.wallet.tick()
        #expect(rig.wallet.sweepProblem?.contains("insufficient funds") == true)
        #expect(rig.wallet.records.first?.status == .dropped)

        await rig.chain.setSendFailure(nil)
        await rig.wallet.tick()
        #expect(await rig.chain.sent.isEmpty)
        clock.advance(HotWallet.pauseAfterFailure + 1)
        await rig.wallet.tick()
        #expect(await rig.chain.sent.count == 1)
        #expect(await rig.signer.signed.last?.nonce == 0, "a dropped transaction's nonce gets used again")
    }

    @Test func aFeeQuoteNoOneWouldChargeSignsNothing() async throws {
        let absurd = FeeQuote(maxFeePerGas: FeeQuote.highestPlausibleFeePerGas + 1, maxPriorityFeePerGas: FeeQuote.highestPlausibleFeePerGas, l1FeeWei: 0)
        let rig = await Rig(snapshot(eth: oneEth, tokens: [usdc: usdcUnits(5000)], fees: absurd))
        await rig.wallet.tick()
        await rig.wallet.sweepEverything()
        #expect(await rig.signer.signed.isEmpty)
        #expect(rig.wallet.sweepProblem == HotWalletWording.feesLookWrong)
    }

    @Test func anEstimateThatFailsSignsNothing() async throws {
        let rig = await Rig(over)
        await rig.chain.setEstimateFailure(.rejected("execution reverted"))
        await rig.wallet.tick()
        #expect(await rig.signer.signed.isEmpty)
        #expect(rig.wallet.sweepProblem?.contains("execution reverted") == true)
    }

    @Test func aBroadcastThatMightHaveWorkedStaysPending() async throws {
        let rig = await Rig(over)
        await rig.chain.setSendFailure(.unreachable)
        await rig.wallet.tick()
        #expect(rig.wallet.records.first?.status == .pending)
        #expect(rig.wallet.chainProblem == .unreachable)
    }

    @Test func aPendingTransactionThatNeverLandsIsSentAgainAsTheSameRecord() async throws {
        let clock = Clock()
        let rig = await Rig(over, now: { clock.now })
        await rig.wallet.tick()
        clock.advance(HotWallet.pendingTimeout + 1)
        await rig.wallet.tick()
        #expect(await rig.chain.sent.count == 2)
        #expect(rig.wallet.records.count == 1)
        #expect(rig.wallet.records.first?.status == .pending)

        await rig.chain.confirmAll()
        await rig.chain.set(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(50)], nonce: 1))
        await rig.wallet.tick()
        #expect(rig.wallet.records.first?.status == .confirmed)
        await rig.chain.set(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(500)], nonce: 1))
        await rig.wallet.tick()
        #expect(rig.wallet.records.count == 2, "the next deposit still sweeps")
    }

    @Test func aRetriedGainOnlyCountsOnce() async throws {
        let clock = Clock()
        let rig = await Rig(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(30)]), portfolio: .success(portfolio(realized: "12000000")), now: { clock.now })
        await rig.wallet.readHistory()
        await rig.wallet.tick()
        clock.advance(HotWallet.pendingTimeout + 1)
        await rig.wallet.tick()
        await rig.chain.confirmAll()
        await rig.chain.set(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(18)], nonce: 1))
        await rig.wallet.tick()
        await rig.wallet.tick()
        #expect(rig.stateStore.saved.sweptGains[hotAddress] == "12000000")
    }

    @Test func oneGivenUpOnThatLandsLateIsntSuspicious() async throws {
        let clock = Clock()
        let rig = await Rig(over, now: { clock.now })
        await rig.wallet.tick()
        let hash = try #require(rig.wallet.records.first?.hash)
        // Too old to wait for, and the retry is refused, so it's dropped. Then the first attempt turns out to have landed.
        clock.advance(HotWallet.pendingTimeout + 1)
        await rig.chain.setSendFailure(.rejected("already known"))
        await rig.wallet.tick()
        #expect(rig.wallet.records.first?.status == .dropped)
        await rig.chain.setSendFailure(nil)
        await rig.chain.setReceipt(hash, succeeded: true)
        await rig.chain.set(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(50)], nonce: 1))
        for _ in 0..<(HotWallet.readsBeforeAlarm + 1) { await rig.wallet.tick() }
        #expect(rig.wallet.records.first?.status == .confirmed)
        #expect(rig.wallet.alarm == nil)
    }

    @Test func theFirstAttemptLandingAfterAReplacementIsntSuspicious() async throws {
        let clock = Clock()
        let rig = await Rig(over, now: { clock.now })
        await rig.wallet.tick()
        let first = try #require(rig.wallet.records.first?.hash)
        // Too old to wait for, and fees have moved, so the same nonce goes out again with a different hash.
        clock.advance(HotWallet.pendingTimeout + 1)
        let dearer = FeeQuote(maxFeePerGas: cheapFees.maxFeePerGas * 2, maxPriorityFeePerGas: cheapFees.maxPriorityFeePerGas, l1FeeWei: cheapFees.l1FeeWei)
        await rig.chain.set(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(500)], fees: dearer))
        await rig.wallet.tick()
        #expect(rig.wallet.records.count == 2)
        #expect(await rig.signer.signed.map(\.nonce) == [0, 0])

        // The first one lands, and the replacement never will.
        await rig.chain.setReceipt(first, succeeded: true)
        await rig.chain.set(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(50)], nonce: 1))
        for _ in 0..<(HotWallet.readsBeforeAlarm + 1) { await rig.wallet.tick() }
        #expect(rig.wallet.alarm == nil)
        #expect(rig.wallet.records.first { $0.hash == first }?.status == .confirmed)
        #expect(rig.wallet.records.first { $0.hash != first }?.status == .dropped)
    }

    @Test func thatWaitSurvivesARestartForAutomaticAndManualSends() async throws {
        let rig = await Rig(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(60)]))
        await rig.wallet.tick()
        await rig.chain.confirmAll()
        await rig.wallet.tick()
        #expect(rig.stateStore.saved.settledThroughBlock == 1001)

        let settings = MemorySettingsStore()
        settings.save(rig.wallet.settings)
        let chain = rig.chain, signer = rig.signer, portfolios = rig.portfolios
        let restarted = HotWallet(signer: signer, settingsStore: settings, stateStore: rig.stateStore, presence: FakePresence(allows: true), portfolioSource: { portfolios }, makeChain: { _ in chain })
        await restarted.tick()
        await restarted.sweepEverything()
        #expect(await rig.chain.sent.count == 1)

        await rig.chain.set(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(60)], nonce: 1))
        await restarted.tick()
        #expect(await rig.chain.sent.count == 2, "and ends once a read is from after it")
    }

    @Test func aNewKeyDoesntWaitOnTheOldKeysBlocks() async throws {
        let rig = await Rig(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(60)]))
        await rig.wallet.tick()
        await rig.chain.confirmAll()
        await rig.wallet.tick()
        await rig.wallet.deleteWallet()
        #expect(rig.stateStore.saved.settledThroughBlock == nil)
    }

    @Test func aSweepWaitsForBalancesFromAfterTheLastReceipt() async throws {
        let rig = await Rig(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(60)]))
        await rig.wallet.tick()
        await rig.chain.confirmAll()
        await rig.wallet.tick()
        #expect(await rig.chain.sent.count == 1)
        await rig.wallet.sweepEverything()
        #expect(await rig.chain.sent.count == 1, "by hand too")
        #expect(rig.wallet.sweepProblem != nil)

        // Once a read is from after it, and there's still too much, it sweeps again.
        await rig.chain.set(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(60)], nonce: 1))
        await rig.wallet.tick()
        #expect(await rig.chain.sent.count == 2)
    }

    @Test func aRevertedSweepPauses() async throws {
        let clock = Clock()
        let rig = await Rig(over, now: { clock.now })
        await rig.wallet.tick()
        let hash = try #require(rig.wallet.records.first?.hash)
        await rig.chain.setReceipt(hash, succeeded: false)
        await rig.chain.set(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(500)], nonce: 1))
        await rig.wallet.tick()
        #expect(rig.wallet.records.first?.status == .failed)
        #expect(await rig.chain.sent.count == 1)
        #expect(rig.wallet.sweepProblem != nil)
    }

    @Test func aMissingKeyIsFlaggedAndSignsNothing() async throws {
        let rig = await Rig(over)
        await rig.signer.deleteKey(hotAddress)
        await rig.wallet.tick()
        #expect(rig.wallet.isKeyMissing)
        #expect(await rig.signer.signed.isEmpty)
    }
}

@MainActor
@Suite struct BetweenTicksTests {
    private let oneToSweep = snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(60)])

    /// Waits for something the running wallet does by itself.
    private func eventually(_ condition: @MainActor () async -> Bool) async throws {
        for _ in 0..<500 {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        Issue.record("It never happened.")
    }

    @Test func aSendShowsAsLandedWellBeforeTheNextTick() async throws {
        let rig = await Rig(oneToSweep, tickDelay: .seconds(3600), receiptDelay: .milliseconds(10))
        rig.wallet.start()
        defer { rig.wallet.stop() }
        try await eventually { await rig.chain.sent.count == 1 }
        await rig.chain.confirmAll()
        try await eventually { rig.wallet.records.first?.status == .confirmed }
        #expect(rig.stateStore.saved.settledThroughBlock == 1001)
    }

    @Test func aManualSendIsWatchedToo() async throws {
        let rig = await Rig(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(10)]), tickDelay: .seconds(3600), receiptDelay: .milliseconds(10))
        rig.wallet.start()
        defer { rig.wallet.stop() }
        try await eventually { rig.wallet.snapshot != nil }
        await rig.wallet.sweepEverything()
        let sent = await rig.chain.sent
        #expect(!sent.isEmpty)
        await rig.chain.confirmAll()
        try await eventually { rig.wallet.records.allSatisfy { $0.status == .confirmed } }
    }

    @Test func aWalletWithNothingPendingMakesNoExtraCalls() async throws {
        let rig = await Rig(tickDelay: .seconds(3600), receiptDelay: .milliseconds(1))
        rig.wallet.start()
        defer { rig.wallet.stop() }
        try await eventually { rig.wallet.snapshot != nil }
        try await Task.sleep(for: .milliseconds(100))
        #expect(await rig.chain.snapshotReads == 1)
        #expect(await rig.chain.receiptReads == 0)
    }

    @Test func goesQuietAgainOnceItSettles() async throws {
        let rig = await Rig(oneToSweep)
        await rig.wallet.tick()
        await rig.chain.confirmAll()
        await rig.wallet.lookBetweenTicks()
        await rig.chain.set(snapshot(tokens: [usdc: usdcUnits(10)], nonce: 1))
        await rig.wallet.lookBetweenTicks()
        let snapshots = await rig.chain.snapshotReads, receipts = await rig.chain.receiptReads
        for _ in 0..<5 { await rig.wallet.lookBetweenTicks() }
        #expect(await rig.chain.snapshotReads == snapshots)
        #expect(await rig.chain.receiptReads == receipts)
    }

    @Test func whilePendingItReadsOnlyTheReceipt() async throws {
        let rig = await Rig(oneToSweep)
        await rig.wallet.tick()
        let snapshots = await rig.chain.snapshotReads, receipts = await rig.chain.receiptReads
        for _ in 0..<3 { await rig.wallet.lookBetweenTicks() }
        #expect(await rig.chain.snapshotReads == snapshots)
        #expect(await rig.chain.receiptReads == receipts + 3)
        #expect(rig.wallet.records.first?.status == .pending)
    }

    @Test func noReceiptBetweenTicksCountsTowardAnAlarm() async throws {
        let clock = Clock()
        let rig = await Rig(oneToSweep, now: { clock.now })
        await rig.wallet.tick()
        // Its nonce is used and it's been too long, which only a tick is allowed to act on.
        await rig.chain.set(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(60)], nonce: 1))
        await rig.wallet.tick()
        clock.advance(HotWallet.pendingTimeout + 1)
        for _ in 0..<(HotWallet.readsBeforeAlarm * 5) { await rig.wallet.lookBetweenTicks() }
        #expect(rig.wallet.alarm == nil)
        #expect(rig.wallet.records.first?.status == .pending)
    }

    @Test func balancesCatchUpWithAReceiptAheadOfTheLatestBlock() async throws {
        let rig = await Rig(oneToSweep)
        await rig.wallet.tick()
        await rig.chain.confirmAll()
        await rig.wallet.lookBetweenTicks()
        #expect(rig.wallet.records.first?.status == .confirmed)
        #expect(rig.wallet.snapshot?.balances[usdc] == usdcUnits(60), "the node's latest block doesn't include it yet")

        await rig.chain.set(snapshot(tokens: [usdc: usdcUnits(10)], nonce: 1))
        await rig.wallet.lookBetweenTicks()
        #expect(rig.wallet.snapshot?.balances[usdc] == usdcUnits(10))
        #expect(rig.wallet.plan?.transfers.isEmpty == true)
    }

    @Test func aNodeThatStaysBehindIsLeftToTheNextTick() async throws {
        let rig = await Rig(oneToSweep)
        await rig.wallet.tick()
        await rig.chain.confirmAll()
        let before = await rig.chain.snapshotReads
        for _ in 0..<(HotWallet.readsToCatchUp * 3) { await rig.wallet.lookBetweenTicks() }
        #expect(await rig.chain.snapshotReads == before + HotWallet.readsToCatchUp)
    }

    @Test func onlyATickSignsTheNextSweep() async throws {
        let rig = await Rig(oneToSweep)
        await rig.wallet.tick()
        await rig.chain.confirmAll()
        await rig.wallet.lookBetweenTicks()
        await rig.chain.set(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(60)], nonce: 1))
        for _ in 0..<3 { await rig.wallet.lookBetweenTicks() }
        #expect(await rig.chain.sent.count == 1)
        await rig.wallet.tick()
        #expect(await rig.chain.sent.count == 2)
    }

    @Test func aReceiptThatRevertedPausesLikeItDoesOnATick() async throws {
        let rig = await Rig(oneToSweep)
        await rig.wallet.tick()
        let hash = try #require(rig.wallet.records.first?.hash)
        await rig.chain.setReceipt(hash, succeeded: false)
        await rig.wallet.lookBetweenTicks()
        #expect(rig.wallet.records.first?.status == .failed)
        #expect(rig.wallet.sweepProblem?.hasPrefix("A sweep of USDC") == true)

        await rig.chain.set(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(60)], nonce: 1))
        await rig.wallet.tick()
        #expect(await rig.chain.sent.count == 1, "and waits before trying again")
    }

    @Test func aMissedCheckIsntAProblemToReportButAFailedTickStopsTheChecks() async throws {
        let rig = await Rig(oneToSweep)
        await rig.wallet.tick()
        await rig.chain.setReadFailure(.unreachable)
        await rig.wallet.lookBetweenTicks()
        #expect(rig.wallet.chainProblem == nil)
        #expect(rig.wallet.sweepProblem == nil)

        await rig.wallet.tick()
        #expect(rig.wallet.chainProblem == .unreachable)
        let receipts = await rig.chain.receiptReads
        await rig.wallet.lookBetweenTicks()
        #expect(await rig.chain.receiptReads == receipts)

        await rig.chain.setReadFailure(nil)
        await rig.wallet.tick()
        await rig.wallet.lookBetweenTicks()
        #expect(await rig.chain.receiptReads > receipts, "and a good one starts them again")
    }

    @Test func staysOffAChainItCantReadOrShouldntTrust() async throws {
        let rig = await Rig(oneToSweep)
        await rig.wallet.tick()
        let receipts = await rig.chain.receiptReads

        rig.wallet.setRPC(URL(string: "https://example.com")!)
        await rig.wallet.lookBetweenTicks()
        #expect(await rig.chain.receiptReads == receipts, "a node no tick has read yet")

        await rig.chain.set(snapshot(chainID: 1))
        await rig.wallet.tick()
        let onTheWrongChain = await rig.chain.receiptReads
        await rig.wallet.lookBetweenTicks()
        #expect(await rig.chain.receiptReads == onTheWrongChain, "another chain")
    }
}

@MainActor
@Suite struct GainTests {
    private let underCap = snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(30)])

    @Test func sweepsRealizedGainsOnce() async throws {
        let rig = await Rig(underCap, portfolio: .success(portfolio(realized: "12000000")))
        await rig.wallet.readHistory()
        await rig.wallet.tick()
        #expect(await rig.chain.sent.count == 1)
        #expect(rig.wallet.records.first?.gainUsdMicros == "12000000")

        await rig.chain.confirmAll()
        await rig.chain.set(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(18)], nonce: 1))
        await rig.wallet.tick()
        #expect(rig.stateStore.saved.sweptGains[hotAddress] == "12000000")
        await rig.wallet.tick()
        #expect(await rig.chain.sent.count == 1, "already swept")
    }

    @Test func neverSweepsAGainThatRestsOnAnEstimate() async throws {
        let rig = await Rig(underCap, portfolio: .success(portfolio(realized: "10000000", estimatedRealized: true)))
        await rig.wallet.readHistory()
        await rig.wallet.tick()
        #expect(await rig.chain.sent.isEmpty)
    }

    @Test func neverSweepsAGainWhileALinkedWalletCantBeRead() async throws {
        let rig = await Rig(underCap, portfolio: .success(portfolio(realized: "10000000", linkedFailed: ["0x00000000000000000000000000000000000000cc"])))
        await rig.wallet.readHistory()
        await rig.wallet.tick()
        #expect(await rig.chain.sent.isEmpty)
    }

    @Test func aGainOnlyCountsAsSweptOnceItLands() async throws {
        let rig = await Rig(underCap, portfolio: .success(portfolio(realized: "12000000")))
        await rig.wallet.readHistory()
        await rig.wallet.tick()
        #expect(rig.stateStore.saved.sweptGains[hotAddress] == nil)
    }

    @Test func anUnknownRealizedSweepsNothing() async throws {
        let rig = await Rig(underCap, portfolio: .success(portfolio(realized: nil)))
        await rig.wallet.readHistory()
        await rig.wallet.tick()
        #expect(await rig.chain.sent.isEmpty)
    }

    @Test func aRealizedTotalThatLeavesSomethingOutSweepsNothing() async throws {
        let rig = await Rig(underCap, portfolio: .success(portfolio(realized: "12000000", realizedMissing: 1)))
        await rig.wallet.readHistory()
        await rig.wallet.tick()
        #expect(await rig.chain.sent.isEmpty)
    }

    @Test func aRealizedLossSweepsNothing() async throws {
        let rig = await Rig(underCap, portfolio: .success(portfolio(realized: "-12000000")))
        await rig.wallet.readHistory()
        await rig.wallet.tick()
        #expect(await rig.chain.sent.isEmpty)
    }

    @Test func canBeTurnedOff() async throws {
        let rig = await Rig(underCap, portfolio: .success(portfolio(realized: "12000000")))
        rig.wallet.setSweepsRealizedGains(false)
        await rig.wallet.readHistory()
        await rig.wallet.tick()
        #expect(await rig.chain.sent.isEmpty)
    }
}

@MainActor
@Suite struct PriceTests {
    @Test func aTokenWithAFeedCountsTowardTheCap() async throws {
        let rig = await Rig(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [dai: oneEth * 500], prices: ["DAI": Money.dollar]))
        await rig.wallet.readHistory()
        await rig.wallet.tick()
        #expect(await rig.chain.sent.count == 1)
        #expect(await rig.signer.signed.first?.to == dai.contract)
    }

    @Test func aTokenWithNoPriceIsFlaggedAndStaysPut() async throws {
        let rig = await Rig(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [dai: oneEth * 500]))
        await rig.wallet.readHistory()
        await rig.wallet.tick()
        #expect(await rig.chain.sent.isEmpty)
        #expect(rig.wallet.unpricedSymbols == ["DAI"])
    }

    /// A market price is good enough to show, but what moves money only trusts what it read from the chain itself.
    @Test func aPriceFromTheServerMovesNothing() async throws {
        let rig = await Rig(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [dai: oneEth * 500]), portfolio: .success(portfolio(positions: [position("DAI", decimals: 18, priceMicros: "1000000")])))
        await rig.wallet.readHistory()
        await rig.wallet.tick()
        #expect(await rig.chain.sent.isEmpty)
        #expect(rig.wallet.unpricedSymbols == ["DAI"])
    }

    @Test func wethIsPricedAsEth() async throws {
        let rig = await Rig(snapshot(eth: 0, tokens: [weth: oneEth]))
        await rig.wallet.tick()
        #expect(rig.wallet.holdings.first { $0.token == weth }?.priceUsdMicros == ethPrice)
    }

    @Test func showsWhatsOffTheAllowlistWithoutTouchingIt() async throws {
        let spam = "0x00000000000000000000000000000000000000f1"
        let rig = await Rig(snapshot(eth: oneEth / 100), portfolio: .success(portfolio(unlisted: [spam])))
        await rig.wallet.readHistory()
        await rig.wallet.tick()
        #expect(rig.wallet.unlisted.map(\.token) == [spam])
        let touched = await rig.signer.signed.map(\.to.lowercased)
        #expect(!touched.contains(spam))
    }

    @Test func nothingOffTheAllowlistIsEverCalled() async throws {
        let rig = await Rig(snapshot(eth: oneEth, tokens: [usdc: usdcUnits(500), dai: oneEth, weth: oneEth]))
        await rig.wallet.sweepEverything()
        let allowed = Set(Base.tokens.compactMap(\.contract)).union([coldAddress])
        for transaction in await rig.signer.signed { #expect(allowed.contains(transaction.to)) }
    }

    @Test func topUpRoomIsWhatTheCapHasLeft() async throws {
        let rig = await Rig(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(30)]))
        await rig.wallet.tick()
        #expect(rig.wallet.topUpRoom == 20 * Money.dollar)
    }

    @Test func thereIsNoTopUpRoomOverTheCap() async throws {
        let rig = await Rig(over, withCold: false)
        await rig.wallet.tick()
        #expect(rig.wallet.topUpRoom == 0)
    }
}

@MainActor
@Suite struct AlarmTests {
    @Test func whatTheAppSignedIsntSuspicious() async throws {
        let rig = await Rig(over)
        await rig.wallet.tick()
        let hash = try #require(rig.wallet.records.first?.hash)
        await rig.portfolios.set(.success(portfolio(outgoing: [hash.uppercased().replacingOccurrences(of: "0X", with: "0x")])))
        await rig.wallet.readHistory()
        #expect(rig.wallet.alarm == nil)
    }

    @Test func aTransactionItDidntSignRaisesTheAlarm() async throws {
        let rig = await Rig(portfolio: .success(portfolio(outgoing: [otherHash])))
        await rig.wallet.readHistory()
        #expect(rig.wallet.alarm?.findings == [.unknownTransaction(hash: otherHash)])
        #expect(rig.wallet.canTopUp == false)
        #expect(rig.stateStore.saved.alarm != nil, "survives a restart")
    }

    @Test func aHigherNonceRaisesTheAlarmOnceItHolds() async throws {
        let rig = await Rig(snapshot(nonce: 1))
        await rig.wallet.tick()
        await rig.wallet.tick()
        #expect(rig.wallet.alarm == nil, "a node can be briefly wrong")
        await rig.wallet.tick()
        #expect(rig.wallet.alarm?.findings == [.nonceAhead(signed: 0, onchain: 1)])
    }

    @Test func aNonceBelowWhatWasSignedIsJustANodeBehind() async throws {
        let rig = await Rig(over)
        await rig.wallet.tick()
        await rig.wallet.tick()
        await rig.wallet.tick()
        await rig.wallet.tick()
        #expect(rig.wallet.alarm == nil)
    }

    @Test func anotherTransactionUsingOurNonceRaisesTheAlarm() async throws {
        let rig = await Rig(over)
        await rig.wallet.tick()
        let hash = try #require(rig.wallet.records.first?.hash)
        await rig.chain.set(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(500)], nonce: 1))
        for _ in 0..<HotWallet.readsBeforeAlarm { await rig.wallet.tick() }
        #expect(rig.wallet.alarm?.findings.contains(.nonceTaken(nonce: 0, ours: hash)) == true)
    }

    @Test func aGapSurvivesThisAppsOwnLaterTransactionsAndARestart() async throws {
        let rig = await Rig(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(60)], nonce: 1), portfolio: .failure(.unreachable))
        await rig.wallet.tick()
        await rig.chain.confirmAll()
        await rig.chain.set(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(50)], nonce: 2))
        // A new launch, with only what's on disk.
        let settings = MemorySettingsStore()
        let chain = rig.chain, signer = rig.signer, portfolios = rig.portfolios
        let restarted = HotWallet(signer: signer, settingsStore: settings, stateStore: rig.stateStore, portfolioSource: { portfolios }, makeChain: { _ in chain })
        for _ in 0..<HotWallet.readsBeforeAlarm { await restarted.tick() }
        #expect(restarted.alarm?.findings == [.nonceAhead(signed: 1, onchain: 2)])
    }

    @Test func aDismissedGapStaysDismissedButANewOneDoesnt() async throws {
        let rig = await Rig(snapshot(nonce: 1))
        for _ in 0..<HotWallet.readsBeforeAlarm { await rig.wallet.tick() }
        rig.wallet.dismissAlarm()
        await rig.chain.set(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(60)], nonce: 1))
        await rig.wallet.tick()
        #expect(await rig.signer.signed.last?.nonce == 1)
        await rig.chain.confirmAll()
        await rig.chain.set(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(50)], nonce: 2))
        for _ in 0..<(HotWallet.readsBeforeAlarm + 1) { await rig.wallet.tick() }
        #expect(rig.wallet.alarm == nil, "this app's own sweep isn't a new gap")

        await rig.chain.set(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(50)], nonce: 3))
        for _ in 0..<HotWallet.readsBeforeAlarm { await rig.wallet.tick() }
        #expect(rig.wallet.alarm?.findings == [.nonceAhead(signed: 2, onchain: 3)])
    }

    @Test func aFreshAlarmReplacesTheCountRatherThanAddingToIt() async throws {
        let rig = await Rig(snapshot(nonce: 1))
        for _ in 0..<HotWallet.readsBeforeAlarm { await rig.wallet.tick() }
        await rig.chain.set(snapshot(nonce: 2))
        await rig.wallet.tick()
        #expect(rig.wallet.alarm?.findings == [.nonceAhead(signed: 0, onchain: 2)])
    }

    @Test func aDismissalDoesntOutliveADeletedKey() async throws {
        let chain = FakeChain(snapshot(eth: 0, nonce: 1))
        let signer = FakeSigner(keys: [hotAddress], next: [nextAddress])
        let store = MemoryStateStore()
        var state = DeviceWalletState()
        state.active = hotAddress
        try store.save(state)
        let portfolios = ScriptedPortfolios(.success(portfolio()))
        let wallet = HotWallet(signer: signer, settingsStore: MemorySettingsStore(), stateStore: store, presence: FakePresence(allows: true), portfolioSource: { portfolios }, makeChain: { _ in chain })
        for _ in 0..<HotWallet.readsBeforeAlarm { await wallet.tick() }
        #expect(wallet.alarm != nil)
        wallet.dismissAlarm()
        await wallet.deleteWallet()
        #expect(store.saved.acknowledged.isEmpty)
        #expect(store.saved.acknowledgedThroughNonce == nil)

        await wallet.createWallet()
        wallet.stop()
        #expect(wallet.address == nextAddress)
        for _ in 0..<HotWallet.readsBeforeAlarm { await wallet.tick() }
        #expect(wallet.alarm?.findings == [.nonceAhead(signed: 0, onchain: 1)], "the same finding on a new key is a new finding")
        #expect(!wallet.canTopUp)
    }

    @Test func aDismissedTransactionStillSurvivesARestart() async throws {
        let rig = await Rig(portfolio: .success(portfolio(outgoing: [otherHash])))
        await rig.wallet.readHistory()
        rig.wallet.dismissAlarm()
        let chain = rig.chain, signer = rig.signer, portfolios = rig.portfolios
        let restarted = HotWallet(signer: signer, settingsStore: MemorySettingsStore(), stateStore: rig.stateStore, portfolioSource: { portfolios }, makeChain: { _ in chain })
        await restarted.readHistory()
        #expect(restarted.alarm == nil)
    }

    @Test func anAbsurdNonceFromANodeDoesntHang() {
        #expect(AlarmCheck.findings(onchainNonce: .max, records: []) == [.nonceAhead(signed: 0, onchain: .max)])
    }

    @Test func sweepsKeepGoingDuringAnAlarm() async throws {
        let rig = await Rig(over, portfolio: .success(portfolio(outgoing: [otherHash])))
        await rig.wallet.readHistory()
        await rig.wallet.tick()
        #expect(await rig.chain.sent.count == 1)
    }

    @Test func aDismissedFindingDoesntComeBack() async throws {
        let rig = await Rig(portfolio: .success(portfolio(outgoing: [otherHash])))
        await rig.wallet.readHistory()
        rig.wallet.dismissAlarm()
        await rig.wallet.readHistory()
        #expect(rig.wallet.alarm == nil)
        await rig.portfolios.set(.success(portfolio(outgoing: [otherHash, "0x" + String(repeating: "cd", count: 32)])))
        await rig.wallet.readHistory()
        #expect(rig.wallet.alarm?.findings.count == 1)
    }

    @Test func aFailedHistoryReadSaysSoAndRaisesNothing() async throws {
        let rig = await Rig(portfolio: .failure(.unreachable))
        await rig.wallet.readHistory()
        #expect(rig.wallet.ampProblem)
        #expect(rig.wallet.alarm == nil)
    }
}

@MainActor
@Suite struct ManualActionTests {
    @Test func sweepEverythingAsksFirst() async throws {
        let rig = await Rig(over, presence: false)
        await rig.wallet.sweepEverything()
        #expect(await rig.signer.signed.isEmpty)
    }

    @Test func sweepEverythingMovesEverythingIncludingUnpricedTokens() async throws {
        let rig = await Rig(snapshot(eth: oneEth / 100, tokens: [usdc: usdcUnits(10), dai: oneEth]))
        await rig.wallet.sweepEverything()
        #expect(rig.wallet.records.map(\.symbol).sorted() == ["DAI", "ETH", "USDC"])
    }

    @Test func createsOnlyOneWallet() async throws {
        let rig = await Rig()
        await rig.wallet.createWallet()
        #expect(await rig.signer.addresses() == [hotAddress])
    }

    @Test func replacingTheKeyAsksFirst() async throws {
        let rig = await Rig(presence: false)
        await rig.wallet.replaceKey()
        #expect(rig.wallet.rotation == nil)
        #expect(await rig.signer.addresses() == [hotAddress])
    }

    @Test func replacingTheKeyMovesEverythingThenDeletesTheOldOne() async throws {
        let signer = FakeSigner(keys: [hotAddress], next: [nextAddress])
        let chain = FakeChain(snapshot(eth: oneEth / 100, tokens: [usdc: usdcUnits(10)]))
        let store = MemoryStateStore()
        var state = DeviceWalletState()
        state.active = hotAddress
        try store.save(state)
        let wallet = HotWallet(signer: signer, settingsStore: MemorySettingsStore(), stateStore: store, presence: FakePresence(allows: true), portfolioSource: { ScriptedPortfolios(.success(portfolio(toBlock: 2000))) }, makeChain: { _ in chain })

        await wallet.replaceKey()
        #expect(wallet.rotation?.to == nextAddress)
        #expect(wallet.linkedWallets.contains(nextAddress.lowercased))

        await wallet.tick()
        let signed = await signer.signed
        #expect(signed.map(\.to).contains(nextAddress), "the ETH goes straight to the new key")
        #expect(signed.contains { $0.to == usdc.contract && recipient($0) == nextAddress })
        #expect(await signer.hasKey(hotAddress), "the old key stays until it's empty")

        await wallet.readHistory()
        await chain.confirmAll()
        await chain.set(snapshot(eth: 0, nonce: 2))
        for _ in 1..<HotWallet.readsBeforeAlarm { await wallet.tick() }
        #expect(await signer.hasKey(hotAddress), "one read saying it's empty isn't enough to delete a key")
        await wallet.tick()
        #expect(wallet.address == nextAddress)
        #expect(wallet.rotation == nil)
        #expect(await signer.hasKey(hotAddress) == false)
        #expect(wallet.state.retired == [hotAddress])
        #expect(wallet.linkedWallets.contains(hotAddress.lowercased), "the old key's costs still carry over")
    }

    @Test func afterAnAlarmWhatsLeftGoesToSavingsAndTheAlarmEndsWithTheOldKey() async throws {
        let signer = FakeSigner(keys: [hotAddress], next: [nextAddress])
        let chain = FakeChain(snapshot(eth: oneEth / 100, tokens: [usdc: usdcUnits(10)]))
        let store = MemoryStateStore()
        var state = DeviceWalletState()
        state.active = hotAddress
        try store.save(state)
        let settings = MemorySettingsStore()
        var values = WalletSettings()
        values.add(ColdWallet(address: coldAddress, name: "Ledger", confirmedOnDeviceAt: Date()))
        settings.save(values)
        let portfolios = ScriptedPortfolios(.success(portfolio(outgoing: [otherHash])))
        let wallet = HotWallet(signer: signer, settingsStore: settings, stateStore: store, presence: FakePresence(allows: true), portfolioSource: { portfolios }, makeChain: { _ in chain })

        await wallet.readHistory()
        #expect(wallet.alarm != nil)
        await wallet.replaceKey()
        #expect(wallet.rotation?.destination == coldAddress)
        await wallet.tick()
        #expect(await signer.signed.contains { $0.to == usdc.contract && recipient($0) == coldAddress })

        await portfolios.set(.success(portfolio(toBlock: 2000)))
        await wallet.readHistory()
        await chain.confirmAll()
        await chain.set(snapshot(eth: 0, nonce: 2))
        for _ in 0..<HotWallet.readsBeforeAlarm { await wallet.tick() }
        #expect(wallet.address == nextAddress)
        #expect(wallet.alarm == nil)
    }

    @Test func aRotationThatCantPayForGasWaitsAndSaysSo() async throws {
        let rig = await Rig(snapshot(eth: 0, tokens: [usdc: usdcUnits(10)]))
        await rig.wallet.replaceKey()
        await rig.wallet.tick()
        #expect(rig.wallet.address == hotAddress)
        #expect(await rig.signer.hasKey(hotAddress))
        await rig.wallet.finishRotationLeavingFundsBehind()
        #expect(rig.wallet.address != hotAddress)
        #expect(await rig.signer.hasKey(hotAddress) == false)
    }

    @Test func aRotationKeepsTheOldKeyWhileItHoldsOtherTokens() async throws {
        let spam = "0x00000000000000000000000000000000000000f1"
        let rig = await Rig(snapshot(eth: 0), portfolio: .success(portfolio(unlisted: [spam])))
        await rig.wallet.readHistory()
        await rig.wallet.replaceKey()
        for _ in 0..<(HotWallet.readsBeforeAlarm + 1) { await rig.wallet.tick() }
        #expect(rig.wallet.rotationHold == .otherTokens(1))
        #expect(await rig.signer.hasKey(hotAddress))
        #expect(rig.wallet.address == hotAddress)
        #expect(rig.wallet.notices.contains { $0.text == HotWalletWording.rotationHeldByOtherTokens(1) })
        #expect(await rig.signer.signed.isEmpty, "and it never touches them")

        await rig.wallet.finishRotationLeavingFundsBehind()
        #expect(await rig.signer.hasKey(hotAddress) == false, "only when the user says so")
        #expect(rig.wallet.address == nextAddress)
    }

    @Test func aRotationKeepsTheOldKeyWhenItCantLookForOtherTokens() async throws {
        let rig = await Rig(snapshot(eth: 0), portfolio: .failure(.unreachable))
        await rig.wallet.replaceKey()
        await rig.wallet.readHistory()
        for _ in 0..<(HotWallet.readsBeforeAlarm + 1) { await rig.wallet.tick() }
        #expect(rig.wallet.rotationHold == .cantCheckOtherTokens)
        #expect(await rig.signer.hasKey(hotAddress))

        await rig.portfolios.set(.success(portfolio()))
        await rig.wallet.readHistory()
        for _ in 0..<HotWallet.readsBeforeAlarm { await rig.wallet.tick() }
        #expect(rig.wallet.address == nextAddress, "and carries on once it can")
    }

    @Test func aRotationWaitsQuietlyForHistoryThatReachesNowThenSaysSoIfItDoesnt() async throws {
        let clock = Clock()
        var current = snapshot(eth: 0)
        current.blockNumber = 2000
        let rig = await Rig(current, portfolio: .success(portfolio(toBlock: 1000)), now: { clock.now })
        await rig.wallet.readHistory()
        await rig.wallet.replaceKey()
        for _ in 0..<(HotWallet.readsBeforeAlarm + 1) { await rig.wallet.tick() }
        #expect(rig.wallet.rotationHold == nil, "a read just hasn't come back yet")
        #expect(await rig.signer.hasKey(hotAddress))

        clock.advance(HotWallet.historyGrace + 1)
        await rig.wallet.tick()
        #expect(rig.wallet.rotationHold == .cantCheckOtherTokens)
        #expect(await rig.signer.hasKey(hotAddress))

        await rig.portfolios.set(.success(portfolio(toBlock: 2000)))
        await rig.wallet.readHistory()
        for _ in 0..<HotWallet.readsBeforeAlarm { await rig.wallet.tick() }
        #expect(rig.wallet.address == nextAddress, "and carries on once history reaches now")
    }

    @Test func historyHasToReachTheBlockWhereTheKeyFirstReadEmpty() async throws {
        var current = snapshot(eth: 0)
        current.blockNumber = 2000
        // Close enough to now to count as fresh, but it doesn't cover the block this decision is about.
        let rig = await Rig(current, portfolio: .success(portfolio(toBlock: 1990)))
        await rig.wallet.readHistory()
        await rig.wallet.replaceKey()
        for _ in 0..<(HotWallet.readsBeforeAlarm + 1) { await rig.wallet.tick() }
        #expect(await rig.signer.hasKey(hotAddress))
    }

    @Test func historyThatReachedTheBlockButHasFallenBehindDoesntCount() async throws {
        var current = snapshot(eth: 0)
        current.blockNumber = 2000
        let rig = await Rig(current, portfolio: .success(portfolio(toBlock: 2000)))
        await rig.wallet.readHistory()
        await rig.wallet.replaceKey()
        await rig.wallet.tick()
        current.blockNumber = 2000 + 31
        await rig.chain.set(current)
        for _ in 0..<(HotWallet.readsBeforeAlarm + 1) { await rig.wallet.tick() }
        #expect(await rig.signer.hasKey(hotAddress))
    }

    @Test func historyKeepsItsMinuteOnceBlocksAre200Ms() async throws {
        var current = snapshot(eth: 0)
        current.blockNumber = 60_000_000
        let rig = await Rig(current, portfolio: .success(portfolio(toBlock: 60_000_000)))
        await rig.wallet.readHistory()
        await rig.wallet.replaceKey()
        await rig.wallet.tick()
        // 20 s later. At 2 s a block this would be over three minutes, and too old to delete a key on.
        current.blockNumber = 60_000_100
        await rig.chain.set(current)
        for _ in 0..<(HotWallet.readsBeforeAlarm + 1) { await rig.wallet.tick() }
        #expect(rig.wallet.address == nextAddress)
    }

    @Test func historyOverAMinuteOldStaysTooOldOnceBlocksAre200Ms() async throws {
        var current = snapshot(eth: 0)
        current.blockNumber = 60_000_000
        let rig = await Rig(current, portfolio: .success(portfolio(toBlock: 60_000_000)))
        await rig.wallet.readHistory()
        await rig.wallet.replaceKey()
        await rig.wallet.tick()
        current.blockNumber = 60_000_301
        await rig.chain.set(current)
        for _ in 0..<(HotWallet.readsBeforeAlarm + 1) { await rig.wallet.tick() }
        #expect(await rig.signer.hasKey(hotAddress))
    }

    @Test func aTokenThatShowsUpInTheNewerBlocksStopsTheDeletion() async throws {
        var current = snapshot(eth: 0)
        current.blockNumber = 2000
        let spam = "0x00000000000000000000000000000000000000f1"
        let rig = await Rig(current, portfolio: .success(portfolio(toBlock: 2000)))
        await rig.wallet.readHistory()
        await rig.wallet.replaceKey()
        await rig.wallet.tick()
        await rig.portfolios.set(.success(portfolio(toBlock: 2001, unlisted: [spam])))
        await rig.wallet.readHistory()
        for _ in 0..<(HotWallet.readsBeforeAlarm + 1) { await rig.wallet.tick() }
        #expect(rig.wallet.rotationHold == .otherTokens(1))
        #expect(await rig.signer.hasKey(hotAddress))
    }

    @Test func aRotationStuckWithoutGasSaysSoAndOffersAWayOut() async throws {
        let rig = await Rig(snapshot(eth: 0, tokens: [usdc: usdcUnits(10)]))
        await rig.wallet.replaceKey()
        await rig.wallet.tick()
        #expect(rig.wallet.rotationHold == .notEnoughGas)
        #expect(rig.wallet.notices.contains { $0.text == HotWalletWording.noGas })
    }

    @Test func aRotationThatRunsOutOfGasPartWaySaysSo() async throws {
        // Enough for one token, but not both.
        let rig = await Rig(snapshot(eth: cheapFees.costWei(of: usdc), tokens: [usdc: usdcUnits(10), dai: oneEth]))
        await rig.wallet.replaceKey()
        await rig.wallet.tick()
        #expect(rig.wallet.rotationHold == .notEnoughGas)
        #expect(rig.wallet.notices.contains { $0.text == HotWalletWording.noGas })
    }

    /// A token transfer costs $30 at this fee, the highest `FeeQuote.isPlausible` allows.
    private static let expensiveFees = FeeQuote(maxFeePerGas: 100_000_000_000, maxPriorityFeePerGas: 1_000_000, l1FeeWei: 0)

    @Test func aRotationKeepsTheOldKeyWhenGasCostsMoreThanAPricedToken() async throws {
        #expect(Self.expensiveFees.isPlausible)
        let rig = await Rig(snapshot(eth: 0, tokens: [dai: 20 * oneEth], prices: ["DAI": Money.dollar], fees: Self.expensiveFees))
        await rig.wallet.readHistory()
        await rig.wallet.replaceKey()
        for _ in 0..<(HotWallet.readsBeforeAlarm + 1) { await rig.wallet.tick() }
        #expect(await rig.signer.signed.isEmpty)
        #expect(await rig.signer.hasKey(hotAddress), "the 20 DAI never moved, and the user never agreed to leave it")
        #expect(rig.wallet.address == hotAddress)
        #expect(rig.wallet.rotationHold == .notWorthTheGas(["DAI"]))
        #expect(rig.wallet.notices.contains { $0.text == HotWalletWording.rotationHeldByGas(["DAI"]) })
    }

    @Test func aRotationKeepsTheOldKeyWhenGasCostsMoreThanAnUnpricedToken() async throws {
        let rig = await Rig(snapshot(eth: 0, tokens: [dai: 20 * oneEth], fees: Self.expensiveFees))
        await rig.wallet.readHistory()
        await rig.wallet.replaceKey()
        for _ in 0..<(HotWallet.readsBeforeAlarm + 1) { await rig.wallet.tick() }
        #expect(await rig.signer.hasKey(hotAddress))
        #expect(rig.wallet.rotationHold == .notEnoughGas)
    }

    @Test func dustOfAnyTokenKeepsTheOldKeyAtOrdinaryFees() async throws {
        for (dust, price) in [(usdc, nil), (weth, nil), (dai, Money.dollar)] as [(Token, UInt128?)] {
            let prices = price.map { [dust.asset: $0] } ?? [:]
            let rig = await Rig(snapshot(eth: 0, tokens: [dust: 1], prices: prices))
            await rig.wallet.readHistory()
            await rig.wallet.replaceKey()
            for _ in 0..<(HotWallet.readsBeforeAlarm + 1) { await rig.wallet.tick() }
            #expect(await rig.signer.hasKey(hotAddress), "\(dust.symbol)")
            #expect(rig.wallet.rotationHold == .notWorthTheGas([dust.symbol]))
        }
    }

    @Test func aHeldTokenMovesOnceGasFalls() async throws {
        let rig = await Rig(snapshot(eth: 0, tokens: [dai: 20 * oneEth], prices: ["DAI": Money.dollar], fees: Self.expensiveFees), portfolio: .success(portfolio(toBlock: 2000)))
        await rig.wallet.replaceKey()
        await rig.wallet.tick()
        #expect(rig.wallet.rotationHold == .notWorthTheGas(["DAI"]))

        await rig.chain.set(snapshot(eth: oneEth / 1000, tokens: [dai: 20 * oneEth], prices: ["DAI": Money.dollar]))
        await rig.wallet.tick()
        #expect(rig.wallet.rotationHold == nil)
        #expect(await rig.signer.signed.contains { $0.to == dai.contract && recipient($0) == nextAddress })
        #expect(await rig.signer.hasKey(hotAddress), "the old key stays until it's empty")
    }

    @Test func ethTheGasMakesNotWorthMovingKeepsTheOldKeyToo() async throws {
        // About $10 of ETH, and $6.30 to send it.
        let rig = await Rig(snapshot(eth: oneEth / 300, fees: Self.expensiveFees))
        await rig.wallet.readHistory()
        await rig.wallet.replaceKey()
        for _ in 0..<(HotWallet.readsBeforeAlarm + 1) { await rig.wallet.tick() }
        #expect(await rig.signer.hasKey(hotAddress))
        #expect(rig.wallet.rotationHold == .notWorthTheGas(["ETH"]))
    }

    /// What it says could be someone's reason to give up what's there for good, so it can't claim more than is known.
    @Test func aHoldOverEthDoesntSayItsWorthLessThanItsGas() async throws {
        let unpriced = await Rig(snapshot(eth: 2 * cheapFees.costWei(of: Base.eth), ethUsd: nil))
        // About $10 of ETH, and $6.30 to send it.
        let priced = await Rig(snapshot(eth: oneEth / 300, fees: Self.expensiveFees))
        for rig in [unpriced, priced] {
            await rig.wallet.replaceKey()
            await rig.wallet.tick()
            #expect(rig.wallet.rotationHold == .notWorthTheGas(["ETH"]))
            #expect(await rig.signer.hasKey(hotAddress))
            #expect(rig.wallet.notices.contains { $0.text == "The old key still holds some ETH that gas makes too costly to move right now. It keeps the old key, and moves it if that changes, until you choose to leave it behind." })
        }
    }

    @Test func whatsLeftAfterTheLastTransferDoesntKeepTheOldKey() async throws {
        // Paying for ETH's own last transfer always leaves a little, so this has to be able to finish.
        let rig = await Rig(snapshot(eth: cheapFees.costWei(of: Base.eth)), portfolio: .success(portfolio(toBlock: 2000)))
        await rig.wallet.replaceKey()
        await rig.wallet.readHistory()
        for _ in 0..<(HotWallet.readsBeforeAlarm + 1) { await rig.wallet.tick() }
        #expect(rig.wallet.rotationHold == nil)
        #expect(await rig.signer.hasKey(hotAddress) == false)
    }

    @Test func theUserCanStillLeaveHeldTokensBehind() async throws {
        let rig = await Rig(snapshot(eth: 0, tokens: [usdc: 1]))
        await rig.wallet.replaceKey()
        await rig.wallet.tick()
        #expect(rig.wallet.rotationHold == .notWorthTheGas(["USDC"]))
        await rig.wallet.finishRotationLeavingFundsBehind()
        #expect(await rig.signer.hasKey(hotAddress) == false)
        #expect(rig.wallet.address == nextAddress)
    }

    @Test func deletingAsksFirstAndForgetsTheKey() async throws {
        let rig = await Rig(presence: false)
        await rig.wallet.deleteWallet()
        #expect(await rig.signer.hasKey(hotAddress))
        let allowed = await Rig(presence: true)
        await allowed.wallet.deleteWallet()
        #expect(allowed.wallet.address == nil)
        #expect(await allowed.signer.hasKey(hotAddress) == false)
    }

    @Test func picksUpAKeyWhoseRecordsWereLost() async throws {
        let signer = FakeSigner(keys: [hotAddress])
        let wallet = HotWallet(signer: signer, settingsStore: MemorySettingsStore(), stateStore: MemoryStateStore(), portfolioSource: { ScriptedPortfolios(.failure(.unreachable)) }, makeChain: { _ in FailingChain() })
        await wallet.tick()
        #expect(wallet.address == hotAddress)
    }
}

@MainActor
@Suite struct NoticeTests {
    private func texts(_ wallet: HotWallet) -> [String] { wallet.notices.map(\.text) }

    @Test func nothingToSayWhenAllIsWell() async throws {
        let rig = await Rig(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(30)]))
        await rig.wallet.tick()
        #expect(rig.wallet.notices.isEmpty)
        #expect(!rig.wallet.needsAttention)
    }

    @Test func usdSaysSoOnlyBesideAnotherCurrency() {
        #expect(HotWalletWording.usd(50 * Money.dollar, beside: .USD) == "$50.00")
        #expect(HotWalletWording.usd(50 * Money.dollar, beside: .CAD) == "US$50.00")
        #expect(HotWalletWording.usd(4000, beside: .CAD) == "US$0.004")
        #expect(HotWalletWording.usd(dollars: 25, beside: .USD) == "$25")
        #expect(HotWalletWording.usd(dollars: 25, beside: .CAD) == "US$25")
    }

    @Test func noticesFollowTheMainCurrency() async throws {
        var main = CurrencyCode.CAD
        let rig = await Rig(snapshot(eth: SweepPlanner.minimumGasReserveWei), withCold: false, mainCurrency: { main })
        await rig.wallet.tick()
        #expect(texts(rig.wallet) == [HotWalletWording.addSavings(beside: .CAD)])
        #expect(texts(rig.wallet).first?.contains("US$25") == true)
        #expect(rig.wallet.usd(dollars: 25) == "US$25")
        main = .USD
        #expect(texts(rig.wallet) == [HotWalletWording.addSavings(beside: .USD)])
        #expect(rig.wallet.usd(dollars: 25) == "$25")
    }

    @Test func overTheCapSaysWhichDollars() {
        #expect(HotWalletWording.overCap(by: 10 * Money.dollar, hasDestination: true, beside: .CAD).hasPrefix("US$10.00 over the cap."))
        #expect(HotWalletWording.overCap(by: 10 * Money.dollar, hasDestination: false, beside: .USD).hasPrefix("$10.00 over the cap,"))
    }

    @Test func noColdWalletSaysToAddOne() async throws {
        let rig = await Rig(snapshot(eth: SweepPlanner.minimumGasReserveWei), withCold: false)
        await rig.wallet.tick()
        #expect(texts(rig.wallet) == [HotWalletWording.addSavings(beside: .USD)])
        #expect(rig.wallet.needsAttention)
    }

    @Test func overTheCapWithNoColdWalletSaysSoOnce() async throws {
        let rig = await Rig(over, withCold: false)
        await rig.wallet.tick()
        #expect(texts(rig.wallet).count == 1)
        #expect(texts(rig.wallet).first?.contains("over the cap, with nowhere to sweep it") == true)
    }

    @Test func aGainWithNoColdWalletStillSaysToAddOne() async throws {
        let rig = await Rig(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(10)]), withCold: false, portfolio: .success(portfolio(realized: "12000000")))
        await rig.wallet.readHistory()
        await rig.wallet.tick()
        #expect(rig.wallet.plan?.blockers == [.noDestination])
        #expect(rig.wallet.plan?.excessUsdMicros == 0)
        #expect(texts(rig.wallet) == [HotWalletWording.addSavings(beside: .USD)])
        #expect(rig.wallet.needsAttention)
    }

    @Test func overTheCapWithAGainAndNoColdWalletSaysSoOnce() async throws {
        let rig = await Rig(over, withCold: false, portfolio: .success(portfolio(realized: "12000000")))
        await rig.wallet.readHistory()
        await rig.wallet.tick()
        #expect(texts(rig.wallet).count == 1)
        #expect(texts(rig.wallet).first?.contains("over the cap, with nowhere to sweep it") == true)
    }

    @Test func tokensWithNoGasSaySoEvenUnderTheCap() async throws {
        let rig = await Rig(snapshot(eth: 0, tokens: [usdc: usdcUnits(10)]))
        await rig.wallet.tick()
        #expect(texts(rig.wallet).contains(HotWalletWording.noGas))
    }

    @Test func noGasSaysSo() async throws {
        let rig = await Rig(snapshot(eth: 0, tokens: [usdc: usdcUnits(500)]))
        await rig.wallet.tick()
        #expect(texts(rig.wallet).contains(HotWalletWording.noGas))
    }

    @Test func dustIsntAWarning() async throws {
        let rig = await Rig(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(50) + 500_000]))
        await rig.wallet.tick()
        #expect(texts(rig.wallet) == [HotWalletWording.excessIsDust])
        #expect(!rig.wallet.needsAttention)
    }

    @Test func noPriceNamesTheToken() async throws {
        let rig = await Rig(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [dai: oneEth]))
        await rig.wallet.tick()
        #expect(texts(rig.wallet).contains(HotWalletWording.noPrice(["DAI"])))
    }

    @Test func noEthPriceSaysSo() async throws {
        let rig = await Rig(snapshot(eth: oneEth, ethUsd: nil))
        await rig.wallet.tick()
        #expect(texts(rig.wallet).contains(HotWalletWording.noEthPrice))
    }

    @Test func anAlarmNeedsAttention() async throws {
        let rig = await Rig(portfolio: .success(portfolio(outgoing: [otherHash])))
        await rig.wallet.readHistory()
        #expect(rig.wallet.needsAttention)
    }
}

@MainActor
@Suite struct ColdWalletTests {
    @Test func refusesWhatIsntAColdWallet() async throws {
        let rig = await Rig()
        #expect(throws: HotWallet.ColdWalletProblem.notAnAddress) { try rig.wallet.addColdWallet(address: "nope", name: "") }
        #expect(throws: HotWallet.ColdWalletProblem.isThisHotWallet) { try rig.wallet.addColdWallet(address: hotAddress.lowercased, name: "") }
        #expect(throws: HotWallet.ColdWalletProblem.isZero) { try rig.wallet.addColdWallet(address: EthereumAddress.zero.lowercased, name: "") }
    }

    @Test func holdsSeveral() async throws {
        let rig = await Rig()
        try rig.wallet.addColdWallet(address: "0x3333333333333333333333333333333333333333", name: " Keystone ")
        #expect(rig.wallet.settings.coldWallets.map(\.name) == ["Ledger", "Keystone"])
        #expect(rig.wallet.settings.sweepDestination == coldAddress, "adding one doesn't change where sweeps go")
    }

    @Test func aRenameKeepsEverythingElse() async throws {
        let rig = await Rig()
        let before = rig.wallet.settings
        rig.wallet.renameColdWallet(coldAddress, to: " Vault ")
        #expect(rig.wallet.settings.coldWallets.first?.name == "Vault")
        #expect(rig.wallet.settings.coldWallets.first?.confirmedOnDeviceAt == before.coldWallets.first?.confirmedOnDeviceAt)
        #expect(rig.wallet.settings.sweepDestination == before.sweepDestination)
        rig.wallet.renameColdWallet(coldAddress, to: "  ")
        #expect(rig.wallet.settings.coldWallets.first?.name == "Savings", "It always has a name")
    }

    @Test func allOfThemCountAsLinked() async throws {
        let rig = await Rig()
        var published: [String] = []
        rig.wallet.onLinkedWalletsChange = { published = $0 }
        try rig.wallet.addColdWallet(address: "0x3333333333333333333333333333333333333333", name: "Keystone")
        #expect(Set(published) == [hotAddress.lowercased, coldAddress.lowercased, "0x3333333333333333333333333333333333333333"])
    }

    @Test func theServerHearsAboutLinkedWalletsButNotTheWalletItself() async throws {
        let rig = await Rig()
        await rig.wallet.readHistory()
        #expect(await rig.portfolios.linked.last == [coldAddress.lowercased])
        #expect(await rig.portfolios.rules.allSatisfy { $0 == nil }, "a rule picked to compare numbers must never decide what money moves")
    }
}

@Suite struct DeviceStateTests {
    @Test func survivesTheFile() throws {
        let url = URL.temporaryDirectory.appending(path: "work331-\(UUID().uuidString)/state.json")
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = FileDeviceStateStore(url: url)
        #expect(try store.load() == DeviceWalletState())
        var state = DeviceWalletState()
        state.active = hotAddress
        state.records[hotAddress] = [SignedRecord(hash: otherHash, nonce: 3, to: coldAddress, symbol: "USDC", decimals: 6, amount: "1", usdMicros: nil, gainUsdMicros: "0", reason: .aboveCap, createdAt: Date(timeIntervalSince1970: 1), status: .pending)]
        state.alarm = StolenKeyAlarm(address: hotAddress, findings: [.nonceAhead(signed: 1, onchain: 2), .unknownTransaction(hash: otherHash)], raisedAt: Date(timeIntervalSince1970: 2))
        try store.save(state)
        #expect(try store.load() == state)
    }

    @Test func aFileFromBeforeTheNewFieldsStillLoads() throws {
        let url = URL.temporaryDirectory.appending(path: "work331-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        // What an earlier build of this branch wrote.
        try Data(#"{"retired":[],"records":[],"sweptGains":[],"acknowledged":[]}"#.utf8).write(to: url)
        #expect(try FileDeviceStateStore(url: url).load().settledThroughBlock == nil)
    }

    @Test func aCorruptFileStopsTheWalletInsteadOfForgettingWhatItSigned() throws {
        let url = URL.temporaryDirectory.appending(path: "work331-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        try Data("nope".utf8).write(to: url)
        #expect(throws: (any Error).self) { try FileDeviceStateStore(url: url).load() }
    }

    @MainActor @Test func aCorruptFileMakesTheWalletUnavailable() throws {
        let url = URL.temporaryDirectory.appending(path: "work331-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        try Data("nope".utf8).write(to: url)
        let wallet = HotWallet(signer: FakeSigner(), settingsStore: MemorySettingsStore(), stateStore: FileDeviceStateStore(url: url), portfolioSource: { ScriptedPortfolios(.failure(.unreachable)) }, makeChain: { _ in FailingChain() })
        if case .unavailable = wallet.availability {} else { Issue.record("Should be unavailable") }
    }
}

private final class Seen: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Bool?
    var value: Bool? { lock.withLock { stored } }
    func set(_ value: Bool) { lock.withLock { stored = value } }
}

private final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 1_000_000)
    var now: Date { lock.withLock { current } }
    func advance(_ seconds: TimeInterval) { lock.withLock { current += seconds } }
}

private struct FailingChain: ChainClient {
    func snapshot(of address: EthereumAddress) throws -> ChainSnapshot { throw ChainError.unreachable }
    func estimateGas(from: EthereumAddress, to: EthereumAddress, value: UInt128, data: [UInt8]) throws -> UInt64 { throw ChainError.unreachable }
    func send(_ transaction: SignedTransaction) throws { throw ChainError.unreachable }
    func receipt(of hash: String) throws -> Receipt? { throw ChainError.unreachable }
    func read(_ method: String, _ parameters: JSONValue) throws -> RPCAnswer { throw ChainError.unreachable }
    func l1Fee(ofPayload payload: [UInt8]) throws -> UInt128 { throw ChainError.unreachable }
}
