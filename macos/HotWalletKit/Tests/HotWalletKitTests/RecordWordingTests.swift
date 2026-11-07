import Foundation
@testable import KeyVault
import PricetagKit
import Testing
@testable import HotWalletKit

private func record(_ reason: SignedRecord.Reason, status: SignedRecord.Status = .confirmed, amount: String = "1500000", gain: String = "0", nonce: UInt64 = 1, site: String? = nil) -> SignedRecord {
    SignedRecord(hash: "0xAB\(nonce)", nonce: nonce, to: nextAddress, symbol: "USDC", decimals: 6, amount: amount, usdMicros: nil, gainUsdMicros: gain, reason: reason, createdAt: Date(timeIntervalSince1970: 0), status: status, site: site)
}

@Suite struct RecordWordingTests {
    private let short = Format.shortHash(nextAddress.checksummed)

    @Test func itsTitleSaysWhatMovedOrWhatItWasAbout() {
        #expect(record(.sent).title == "1.5 USDC")
        #expect(record(.note).title == "What you paid for USDC")
        #expect(record(.revoke).title == "Approval for USDC")
    }

    @Test func itsReasonSaysWhyItHappened() {
        #expect(record(.aboveCap).reasonText == "Above the cap")
        #expect(record(.aboveCap, gain: "5").reasonText == "Above the cap or realized gains")
        #expect(record(.manual).reasonText == "Swept by you")
        #expect(record(.rotation).reasonText == "Replacing the key")
        #expect(record(.site, site: "https://app.uniswap.org").reasonText == "app.uniswap.org")
        #expect(record(.site).reasonText == "A site")
        #expect(record(.sent).reasonText == "Sent to \(short)")
        #expect(record(.note).reasonText == "Published for anyone to read")
        #expect(record(.revoke).reasonText == "Revoked, for \(short)")
    }

    @Test func itsStatusSaysHowItWent() {
        #expect(record(.sent, status: .pending).statusText(among: []) == "On its way")
        #expect(record(.sent, status: .confirmed).statusText(among: []) == "Done")
        #expect(record(.sent, status: .failed).statusText(among: []) == "Failed")
    }

    @Test func aDroppedOneCanStillLandUnlessItsNonceWasUsed() {
        let dropped = record(.sent, status: .dropped, nonce: 7)
        #expect(dropped.statusText(among: [dropped]) == "Not confirmed")
        #expect(dropped.statusText(among: [dropped, record(.sent, status: .pending, nonce: 7)]) == "Not confirmed")
        #expect(dropped.statusText(among: [dropped, record(.sent, status: .confirmed, nonce: 8)]) == "Not confirmed")
        #expect(dropped.statusText(among: [dropped, record(.sent, status: .confirmed, nonce: 7)]) == "Never landed")
        #expect(dropped.statusText(among: [dropped, record(.sent, status: .failed, nonce: 7)]) == "Never landed")
    }

    @Test func onlyWhatsOnItsWayOrFailedIsAddedToTheTransactions() {
        #expect(SentTransaction(record(.sent, status: .confirmed)) == nil)
        #expect(SentTransaction(record(.sent, status: .dropped)) == nil)
        #expect(SentTransaction(record(.sent, status: .pending))?.status == .pending)
        #expect(SentTransaction(record(.sent, status: .failed))?.status == .failed)
    }

    @Test func aSentTransactionSaysWhatItDoes() {
        func summary(_ record: SignedRecord) -> String? { SentTransaction(record)?.summary }
        #expect(summary(record(.sent, status: .pending)) == "Send 1.5 USDC")
        #expect(summary(record(.site, status: .pending, site: "https://app.uniswap.org")) == "Send 1.5 USDC for app.uniswap.org")
        #expect(summary(record(.site, status: .pending)) == "Send 1.5 USDC for a site")
        #expect(summary(record(.site, status: .pending, amount: "0", site: "https://app.uniswap.org")) == "Transaction for app.uniswap.org")
        #expect(summary(record(.note, status: .pending)) == "Publish what you paid for USDC")
        #expect(summary(record(.revoke, status: .pending)) == "Revoke an approval for USDC")
        for reason: SignedRecord.Reason in [.aboveCap, .manual, .rotation] {
            #expect(summary(record(reason, status: .pending)) == "Move 1.5 USDC to savings")
        }
    }

    @Test func aNoteOrRevokeMovesNoAsset() {
        #expect(SentTransaction(record(.sent, status: .pending))?.asset == "USDC")
        #expect(SentTransaction(record(.note, status: .pending))?.asset == nil)
        #expect(SentTransaction(record(.revoke, status: .pending))?.asset == nil)
    }

    @Test func leavingAnOldKeySaysWhatsLost() {
        let lost = "What's still on the old address can never be moved again."
        #expect(HotWalletWording.leavingOldKey(isMissing: true, hold: .otherTokens(3)) == "This device no longer has it. \(lost)")
        #expect(HotWalletWording.leavingOldKey(isMissing: false, hold: .otherTokens(1)) == "It holds 1 token this app doesn't track. \(lost)")
        #expect(HotWalletWording.leavingOldKey(isMissing: false, hold: .otherTokens(3)) == "It holds 3 tokens this app doesn't track. \(lost)")
        #expect(HotWalletWording.leavingOldKey(isMissing: false, hold: .cantCheckOtherTokens) == "This app can't check right now whether it holds other tokens. \(lost)")
        #expect(HotWalletWording.leavingOldKey(isMissing: false, hold: .notWorthTheGas(["USDC"])) == "It holds some USDC that gas makes too costly to move right now. \(lost)")
        for hold: HotWallet.RotationHold? in [.notEnoughGas, nil] {
            #expect(HotWalletWording.leavingOldKey(isMissing: false, hold: hold) == "It holds tokens with no ETH to move them. \(lost)")
        }
    }
}

@MainActor
@Suite struct BuySuggestionTests {
    @Test func theresNoSuggestionBeforeTheWalletsBeenRead() async {
        #expect(await Rig().wallet.buySuggestion == nil)
    }

    @Test func withSavingsItsTwentyAtMost() async {
        let rig = await Rig(snapshot(eth: 0))
        await rig.wallet.tick()
        #expect(rig.wallet.buySuggestion == 20)
    }

    @Test func withoutSavingsItsAllTheRoom() async {
        let rig = await Rig(snapshot(eth: 0), withCold: false)
        await rig.wallet.tick()
        #expect(rig.wallet.buySuggestion == Int(rig.wallet.topUpRoom / Money.dollar))
    }

    @Test func itNeverStartsBelowWhatTheProviderTakes() async {
        let rig = await Rig(snapshot(eth: 0, tokens: [usdc: usdcUnits(10_000)]))
        await rig.wallet.tick()
        #expect(rig.wallet.buySuggestion == Int(BuyPlan.minimumUsdMicros / Money.dollar))
    }
}
