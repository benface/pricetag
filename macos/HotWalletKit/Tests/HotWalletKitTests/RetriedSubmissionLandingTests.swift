import Foundation
import KeyVault
import PricetagKit
import Testing
@testable import HotWalletKit

@MainActor
/// From the review of WORK-489: a retried send or sweep follows the receipts of what it put on its way, and nothing else.
@Suite struct RetriedSubmissionLandingTests {
    @Test func sweepRetryWithNewHashOnlyTracksTheSuccessfulAttempt() async throws {
        let rig = await Rig(snapshot())
        await rig.chain.setSendFailure(.rejected("underpriced"))
        #expect(await rig.wallet.sweepEverything(in: PresencePrompt()) == false)
        let first = try #require(rig.wallet.records.first)
        #expect(first.status == .dropped)
        await rig.chain.setSendFailure(nil)
        let fees = FeeQuote(maxFeePerGas: 20_000_000, maxPriorityFeePerGas: 1_000_000, l1FeeWei: 300_000_000_000)
        await rig.chain.set(snapshot(fees: fees))
        #expect(await rig.wallet.sweepEverything(in: PresencePrompt()))
        await rig.chain.confirmAll()
        await rig.wallet.lookBetweenTicks()
        #expect(rig.wallet.records.first?.status == .confirmed)
        // What SweepSheet follows: the old dropped attempt isn't part of it.
        #expect(rig.wallet.landing(of: rig.wallet.lastSubmitted) == .landed)
    }

    @Test func reopenedSweepTracksARebroadcastOfTheSameHash() async throws {
        let rig = await Rig(snapshot())
        await rig.chain.setSendFailure(.rejected("underpriced"))
        #expect(await rig.wallet.sweepEverything(in: PresencePrompt()) == false)
        // Close the failed sheet and open another before retrying.
        await rig.chain.setSendFailure(nil)
        #expect(await rig.wallet.sweepEverything(in: PresencePrompt()))
        #expect(rig.wallet.landing(of: rig.wallet.lastSubmitted) == .onItsWay)
        await rig.chain.confirmAll()
        await rig.wallet.lookBetweenTicks()
        #expect(rig.wallet.records.count == 1)
        #expect(rig.wallet.records.first?.status == .confirmed)
        #expect(rig.wallet.landing(of: rig.wallet.lastSubmitted) == .landed)
    }

    @Test func sendRetryTracksTheHashThatWasRebroadcast() async throws {
        let rig = await Rig(snapshot(tokens: [usdc: usdcUnits(20)]))
        await rig.chain.setSendFailure(.rejected("underpriced"))
        #expect(await rig.wallet.send(SendRequest(token: usdc, amount: usdcUnits(5), to: coldAddress)) == false)
        let retriedHash = try #require(rig.wallet.records.first?.hash)
        #expect(await rig.wallet.send(SendRequest(token: usdc, amount: usdcUnits(6), to: coldAddress)) == false)
        await rig.chain.setSendFailure(nil)
        let store = PortfolioStore(defaults: UserDefaults(suiteName: "reviewer489-\(UUID().uuidString)")!, makeSource: { _ in rig.portfolios })
        defer { store.stop() }
        let model = SendModel(wallet: rig.wallet, store: store)
        model.token = usdc
        model.amountText = "5"
        model.addressText = coldAddress.lowercased
        #expect(await model.send())
        #expect(await rig.chain.sent.last?.hash == retriedHash)
        #expect(model.landing == .onItsWay)
        await rig.chain.confirmAll()
        await rig.wallet.lookBetweenTicks()
        #expect(rig.wallet.records.first(where: { $0.hash == retriedHash })?.status == .confirmed)
        #expect(model.landing == .landed)
    }
}
