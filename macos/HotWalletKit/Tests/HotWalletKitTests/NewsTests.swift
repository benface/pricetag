import Foundation
import KeyVault
import PricetagKit
import Testing
@testable import HotWalletKit

private let over: ChainSnapshot = snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(500)])

private final class NewsClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 1_000_000)
    var now: Date { lock.withLock { current } }
    func advance(_ seconds: TimeInterval) { lock.withLock { current += seconds } }
}

@MainActor
private final class Heard {
    var news: [HotWalletNews] = []
    init(_ wallet: HotWallet) { wallet.onNews = { [unowned self] in news.append($0) } }
}

@MainActor
@Suite struct NewsTests {
    @Test func aSweepIsNewsOnceItsReceiptSaysItLanded() async throws {
        let rig = await Rig(over)
        let heard = Heard(rig.wallet)
        await rig.wallet.tick()
        #expect(heard.news.isEmpty, "on its way isn't news yet")
        await rig.chain.confirmAll()
        await rig.wallet.tick()
        let record = try #require(rig.wallet.records.first)
        #expect(heard.news == [.settled(record)])
        #expect(record.status == .confirmed)
    }

    @Test func aRevertedSweepIsNews() async throws {
        let rig = await Rig(over)
        let heard = Heard(rig.wallet)
        await rig.wallet.tick()
        await rig.chain.setReceipt(try #require(rig.wallet.records.first?.hash), succeeded: false)
        await rig.wallet.tick()
        let record = try #require(rig.wallet.records.first)
        #expect(heard.news == [.settled(record)])
        #expect(record.status == .failed)
    }

    @Test func aSendThatNeverLandsIsNews() async throws {
        let clock = NewsClock()
        let rig = await Rig(snapshot(eth: oneEth / 100, tokens: [usdc: usdcUnits(20)]), now: { clock.now })
        let heard = Heard(rig.wallet)
        await rig.wallet.tick()
        #expect(await rig.wallet.send(SendRequest(token: usdc, amount: usdcUnits(5), to: coldAddress)))
        clock.advance(HotWallet.pendingTimeout + 1)
        await rig.wallet.tick()
        let record = try #require(rig.wallet.records.first)
        #expect(record.status == .dropped)
        #expect(heard.news == [.unconfirmed(record)])
    }

    @Test func aSendGivenUpOnThatLandsLateIsNewsAgain() async throws {
        let clock = NewsClock()
        let rig = await Rig(snapshot(eth: oneEth / 100, tokens: [usdc: usdcUnits(20)]), now: { clock.now })
        let heard = Heard(rig.wallet)
        await rig.wallet.tick()
        #expect(await rig.wallet.send(SendRequest(token: usdc, amount: usdcUnits(5), to: coldAddress)))
        clock.advance(HotWallet.pendingTimeout + 1)
        await rig.wallet.tick()
        await rig.chain.confirmAll()
        await rig.chain.set(snapshot(eth: oneEth / 100, tokens: [usdc: usdcUnits(15)], nonce: 1))
        await rig.wallet.tick()
        let record = try #require(rig.wallet.records.first)
        #expect(record.status == .confirmed)
        #expect(heard.news.last == .landedLate(record))
        let said = notices(heard.news)
        #expect(said.map(\.title) == ["Send Not Confirmed Yet", "Sent"])
        #expect(Set(said.map(\.id)).count == 1, "what it turned out to be replaces what was said first")
    }

    @Test func aNoteGivenUpOnThatLandsLateIsNewsAgain() async throws {
        let clock = NewsClock()
        let rig = await Rig(snapshot(eth: oneEth / 100, tokens: [usdc: usdcUnits(20)]), now: { clock.now })
        let heard = Heard(rig.wallet)
        await rig.wallet.tick()
        let note = try #require(CostNote.calldata(txHash: "0x" + String(repeating: "ab", count: 32), asset: "USDC", usdMicros: "1"))
        #expect(await rig.wallet.writeNote(note, asset: "USDC", from: hotAddress.lowercased))
        clock.advance(HotWallet.pendingTimeout + 1)
        await rig.wallet.tick()
        await rig.chain.confirmAll()
        await rig.chain.set(snapshot(eth: oneEth / 100, tokens: [usdc: usdcUnits(20)], nonce: 1))
        await rig.wallet.tick()
        #expect(notices(heard.news).map(\.title) == ["Cost Not Published Yet", "Cost Published"])
    }

    private func notices(_ news: [HotWalletNews]) -> [MoneyNotice] {
        HotWalletWording.notices(for: news, savingsName: { $0 == coldAddress ? "Ledger" : nil }, in: MoneyDisplay(main: .USD))
    }

    @Test func anAutomaticSweepThatCantGoOutSaysSoOnce() async throws {
        let clock = NewsClock()
        let rig = await Rig(over, now: { clock.now })
        let heard = Heard(rig.wallet)
        await rig.chain.setSendFailure(.rejected("insufficient funds"))
        await rig.wallet.tick()
        #expect(heard.news == [.sweepDidntGoOut("A sweep of USDC didn't go out. There isn't enough ETH for this and its network fee. Add some ETH, then try again.")])
        clock.advance(HotWallet.pauseAfterFailure + 1)
        await rig.wallet.tick()
        #expect(await rig.signer.signed.count == 2, "it tried again")
        #expect(heard.news.count == 1, "and didn't say the same thing twice")
    }

    @Test func aSweepByHandThatCantGoOutIsSaidWhereItWasAskedFor() async throws {
        let rig = await Rig(over)
        let heard = Heard(rig.wallet)
        await rig.chain.setSendFailure(.rejected("insufficient funds"))
        await rig.wallet.sweepEverything()
        #expect(rig.wallet.lastActionProblem != nil)
        #expect(heard.news.isEmpty)
    }
}

@Suite struct NewsWordingTests {
    private func record(_ symbol: String, amount: String, decimals: Int, usd: String?, reason: SignedRecord.Reason, status: SignedRecord.Status, to: EthereumAddress = coldAddress, site: String? = nil) -> SignedRecord {
        SignedRecord(hash: "0x\(symbol)\(reason.rawValue)", nonce: 1, to: to, symbol: symbol, decimals: decimals, amount: amount, usdMicros: usd, gainUsdMicros: "0", reason: reason, createdAt: .distantPast, status: status, site: site)
    }

    private func notices(_ news: [HotWalletNews]) -> [MoneyNotice] {
        HotWalletWording.notices(for: news, savingsName: { $0 == coldAddress ? "Ledger" : nil }, in: MoneyDisplay(main: .USD))
    }

    @Test func aSweepOfTwoTokensIsOneNotification() {
        let eth = record("ETH", amount: "4000000000000000", decimals: 18, usd: "12000000", reason: .aboveCap, status: .confirmed)
        let usdc = record("USDC", amount: "12500000", decimals: 6, usd: "12500000", reason: .aboveCap, status: .confirmed)
        let result = notices([.settled(eth), .settled(usdc)])
        #expect(result.count == 1)
        #expect(result.first?.title == "Swept to Savings")
        #expect(result.first?.body == "0.004 ETH and 12.5 USDC, worth $24.50, moved to Ledger.")
        #expect(result.first?.row == MoneyNotice.recordRow(eth.hash))
    }

    @Test func titlesNeverSayHowMuch() {
        let all: [HotWalletNews] = [
            .settled(record("ETH", amount: "4000000000000000", decimals: 18, usd: "12000000", reason: .aboveCap, status: .confirmed)),
            .settled(record("USDC", amount: "5000000", decimals: 6, usd: "5000000", reason: .sent, status: .confirmed)),
            .settled(record("USDC", amount: "5000000", decimals: 6, usd: "5000000", reason: .site, status: .failed, site: "https://app.example.com")),
            .unconfirmed(record("ETH", amount: "1000000000000000", decimals: 18, usd: nil, reason: .sent, status: .dropped)),
        ]
        for notice in notices(all) {
            #expect(notice.title.allSatisfy { !$0.isNumber }, "\(notice.title)")
            #expect(!notice.title.contains("$"), "\(notice.title)")
        }
    }

    @Test func aSentOrSiteTransactionThatLandedIsLeftToWhereItWasAskedFor() {
        let site = record("USDC", amount: "5000000", decimals: 6, usd: "5000000", reason: .site, status: .confirmed, site: "https://app.example.com")
        let note = record("ETH", amount: "0", decimals: 18, usd: nil, reason: .note, status: .confirmed)
        #expect(notices([.settled(site), .settled(note)]).isEmpty)
    }

    @Test func aSendSaysWhereItWent() {
        let friend = EthereumAddress("0x00000000000000000000000000000000000de302")!
        let toFriend = notices([.settled(record("USDC", amount: "5000000", decimals: 6, usd: "5000000", reason: .sent, status: .confirmed, to: friend))])
        #expect(toFriend.map(\.body) == ["5 USDC went to \(Format.shortHash(friend.checksummed))."])
        let toSavings = notices([.settled(record("USDC", amount: "5000000", decimals: 6, usd: "5000000", reason: .sent, status: .confirmed))])
        #expect(toSavings.map(\.body) == ["5 USDC went to Ledger."])
    }

    @Test func failuresSayNothingMoved() {
        let failed = notices([.settled(record("USDC", amount: "5000000", decimals: 6, usd: "5000000", reason: .sent, status: .failed))])
        #expect(failed.map(\.title) == ["Send Failed"])
        #expect(failed.map(\.body) == ["Sending USDC failed onchain. Nothing moved, but its gas was spent."])
    }

    /// It can still land, so nothing says it didn't, or that nothing moved.
    @Test func oneGivenUpOnIsNotConfirmedRatherThanFailed() {
        let site = record("USDC", amount: "5000000", decimals: 6, usd: "5000000", reason: .site, status: .dropped, site: "https://app.example.com")
        let all = notices([
            .unconfirmed(record("USDC", amount: "5000000", decimals: 6, usd: "5000000", reason: .sent, status: .dropped)),
            .unconfirmed(site),
            .unconfirmed(record("ETH", amount: "0", decimals: 18, usd: nil, reason: .note, status: .dropped)),
        ])
        #expect(all.map(\.title) == ["Send Not Confirmed Yet", "Transaction Not Confirmed Yet", "Cost Not Published Yet"])
        #expect(all.first?.body == "5 USDC to Ledger hasn't landed after 3 minutes. It may still go through, so check Spending Money before sending it again.")
        for notice in all {
            #expect(!notice.body.contains("nothing moved") && !notice.body.contains("never landed"), "\(notice.body)")
        }
        var landed = site
        landed.status = .confirmed
        let late = notices([.landedLate(landed)])
        #expect(late.map(\.body) == ["The transaction for app.example.com landed after all."])
        #expect(late.first?.id == all[1].id)
    }

    @Test func aSweepThatDidntLandGoesAgainWithoutANotification() {
        #expect(notices([.unconfirmed(record("USDC", amount: "5000000", decimals: 6, usd: "5000000", reason: .aboveCap, status: .dropped))]).isEmpty)
    }

    /// Its row leaving the page says a revoke landed, so only what's still in doubt or failed is news.
    @Test func aRevokeIsNewsWhenItDidntGoAsExpected() {
        let revoke = record("USDC", amount: "0", decimals: 0, usd: nil, reason: .revoke, status: .confirmed)
        #expect(notices([.settled(revoke)]).isEmpty)
        #expect(notices([.landedLate(revoke)]).map(\.body) == ["The approval for USDC was revoked after all."])
        var dropped = revoke
        dropped.status = .dropped
        #expect(notices([.unconfirmed(dropped)]).map(\.body) == ["Revoking an approval for USDC hasn't landed after 3 minutes. It may still go through, so check before revoking it again."])
        var failed = revoke
        failed.status = .failed
        let failure = notices([.settled(failed)])
        #expect(failure.map(\.title) == ["Revoke Failed"])
        #expect(failure.map(\.body) == ["Revoking an approval for USDC failed onchain. It may still be there, and its gas was spent."])
    }

    /// The old key's records go with it, so the notification opens what the money's on now.
    @Test func aReplacedKeysSweepOpensTheBalance() {
        let moved = notices([.settled(record("USDC", amount: "5000000", decimals: 6, usd: "5000000", reason: .rotation, status: .confirmed, to: EthereumAddress("0x2222222222222222222222222222222222222222")!))])
        #expect(moved.map(\.title) == ["Moved Off the Old Key"])
        #expect(moved.map(\.body) == ["5 USDC moved to the new key."])
        #expect(moved.map(\.row) == [MoneyNotice.balanceRow])
    }
}
