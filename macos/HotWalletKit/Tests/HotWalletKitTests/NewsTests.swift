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
        #expect(heard.news == [.neverLanded(record)])
    }

    @Test func anAutomaticSweepThatCantGoOutSaysSoOnce() async throws {
        let clock = NewsClock()
        let rig = await Rig(over, now: { clock.now })
        let heard = Heard(rig.wallet)
        await rig.chain.setSendFailure(.rejected("insufficient funds"))
        await rig.wallet.tick()
        #expect(heard.news == [.sweepDidntGoOut("A sweep of USDC didn't go out: insufficient funds")])
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
        #expect(rig.wallet.sweepProblem != nil)
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
            .neverLanded(record("ETH", amount: "1000000000000000", decimals: 18, usd: nil, reason: .sent, status: .dropped)),
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
        let dropped = notices([.neverLanded(record("USDC", amount: "5000000", decimals: 6, usd: "5000000", reason: .sent, status: .dropped))])
        #expect(dropped.map(\.title) == ["Send Didn't Go Through"])
        #expect(dropped.map(\.body) == ["5 USDC to Ledger never landed, so nothing moved."])
    }

    @Test func aSweepThatDidntLandGoesAgainWithoutANotification() {
        #expect(notices([.neverLanded(record("USDC", amount: "5000000", decimals: 6, usd: "5000000", reason: .aboveCap, status: .dropped))]).isEmpty)
    }
}
