import Foundation
import KeyVault
import PricetagKit
import Testing
@testable import HotWalletKit

private final class ReviewClock: @unchecked Sendable {
    private let lock = NSLock()
    private var date = Date(timeIntervalSince1970: 1_000)
    var now: Date { lock.withLock { date } }
    func advance(_ seconds: TimeInterval) { lock.withLock { date += seconds } }
}

@MainActor
@Suite struct FirstReviewTests {
    @Test func identicalRetrySettlesAndDoesNotBlockFutureSweeps() async throws {
        let clock = ReviewClock()
        let rig = await Rig(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(60)]), now: { clock.now })
        await rig.chain.setSendFailure(.rejected("temporary refusal"))
        await rig.wallet.tick()
        await rig.chain.setSendFailure(nil)
        clock.advance(301)
        await rig.wallet.tick()
        #expect(Set(rig.wallet.records.map(\.hash)).count == 1, "identical payloads have identical hashes")
        await rig.chain.confirmAll()
        await rig.chain.set(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(50)], nonce: 1))
        await rig.wallet.tick()
        #expect(!rig.wallet.records.contains { $0.status == .pending }, "confirmed retry must stop blocking")
        await rig.chain.set(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(70)], nonce: 1))
        await rig.wallet.tick()
        #expect(await rig.chain.sent.count == 2, "new over-cap deposit must sweep")
    }

    @Test func anAutomaticSweepDoesNotHideAnUnsignedNonce() async throws {
        let rig = await Rig(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(60)], nonce: 1), portfolio: .failure(.unreachable))
        await rig.wallet.readHistory()
        await rig.wallet.tick()
        #expect(await rig.signer.signed.first?.nonce == 1)
        await rig.chain.confirmAll()
        await rig.chain.set(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(50)], nonce: 2))
        for _ in 0..<4 { await rig.wallet.tick() }
        #expect(rig.wallet.alarm != nil, "nonce 0 was never signed here")
        #expect(!rig.wallet.canTopUp)
    }

    @Test func aReceiptNewerThanTheSnapshotDoesNotSweepTheSameExcessAgain() async throws {
        let rig = await Rig(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(60)]))
        await rig.wallet.tick()
        await rig.chain.confirmAll()
        // Receipt has arrived, but the snapshot is still the old block/balance.
        await rig.wallet.tick()
        #expect(await rig.chain.sent.count == 1, "the same $10 excess must not be sent twice")
    }

    @Test func rotationDoesNotSilentlyDestroyAccessToUnlistedHoldings() async throws {
        let item = "0x3333333333333333333333333333333333333333"
        let rig = await Rig(snapshot(eth: 0), portfolio: .success(portfolio(unlisted: [item])))
        await rig.wallet.readHistory()
        #expect(!rig.wallet.unlisted.isEmpty)
        await rig.wallet.replaceKey()
        for _ in 0..<4 { await rig.wallet.tick() }
        #expect(await rig.signer.hasKey(hotAddress), "cannot delete without acknowledging remaining holdings")
    }

    @Test func underCapTokensWithoutGasExplainWhyRotationIsStuck() async throws {
        let rig = await Rig(snapshot(eth: 0, tokens: [usdc: usdcUnits(10)]))
        await rig.wallet.replaceKey()
        await rig.wallet.tick()
        #expect(rig.wallet.notices.contains { $0.text == HotWalletWording.noGas })
        #expect(rig.wallet.plan?.blockers.contains(.notEnoughGas) == true)
    }
}
