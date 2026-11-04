import Foundation
import KeyVault
import PricetagKit
import Testing
@testable import HotWalletKit

@MainActor
@Suite struct SecondReviewTests {
    @Test func settledReceiptStillGuardsAgainstOldBalancesAfterRestart() async throws {
        let rig = await Rig(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(60)]))
        await rig.wallet.tick()
        await rig.chain.confirmAll()
        await rig.wallet.tick()
        #expect(await rig.chain.sent.count == 1)
        #expect(rig.wallet.records.allSatisfy { $0.status == .confirmed })

        let settings = MemorySettingsStore()
        settings.save(rig.wallet.settings)
        let restarted = HotWallet(signer: rig.signer, settingsStore: settings, stateStore: rig.stateStore,
            presence: FakePresence(allows: true), portfolioSource: { rig.portfolios }, makeChain: { _ in rig.chain })
        // The load-balanced node still returns block 1000, preceding the settled receipt in block 1001.
        await restarted.tick()
        #expect(await rig.chain.sent.count == 1, "restart must not sign a second $10 sweep from the pre-receipt balance")
    }

    @Test func rotationWaitsForHistoryToCoverCurrentSnapshot() async throws {
        var current = snapshot(eth: 0)
        current.blockNumber = 2000
        // Amp last answered at block 1000 with no other tokens. It has not reported blocks 1001...2000.
        let rig = await Rig(current, portfolio: .success(portfolio()))
        await rig.wallet.readHistory()
        #expect(rig.wallet.portfolio?.coverage.toBlock == 1000)
        await rig.wallet.replaceKey()
        for _ in 0..<4 { await rig.wallet.tick() }
        #expect(await rig.signer.hasKey(hotAddress), "an old empty result cannot rule out incoming tokens in unexamined blocks")
    }

    @Test func dismissingOldWalletNonceAlarmDoesNotSuppressNewWalletAlarm() async throws {
        let rig = await Rig(snapshot(eth: 0, nonce: 1))
        for _ in 0..<3 { await rig.wallet.tick() }
        #expect(rig.wallet.alarm != nil)
        rig.wallet.dismissAlarm()
        await rig.wallet.readHistory()
        await rig.wallet.replaceKey()
        for _ in 0..<4 { await rig.wallet.tick() }
        #expect(rig.wallet.address == nextAddress)
        // The new wallet now also has an unexplained nonce 0.
        await rig.chain.set(snapshot(eth: 0, nonce: 1))
        for _ in 0..<4 { await rig.wallet.tick() }
        #expect(rig.wallet.alarm != nil, "the old address's dismissal must not apply to the replacement key")
        #expect(!rig.wallet.canTopUp)
    }
}
