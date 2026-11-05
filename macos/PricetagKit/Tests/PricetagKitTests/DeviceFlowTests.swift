import Foundation
import Testing
@testable import PricetagKit

/// `test/cold.test.ts` reads these same strings on the web app's side.
@Suite struct DeviceFlowTests {
    private let server = URL(string: "http://127.0.0.1:8787")!
    private let hot = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    private let cold = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    private let tx = "0x" + String(repeating: "ab", count: 32)

    @Test func aTopUpLink() {
        #expect(DeviceFlow.topUp(server: server, to: hot, dollars: 20)?.absoluteString == "http://127.0.0.1:8787?topup=\(hot)&usd=20")
    }

    @Test func aPublishLink() {
        let draft = CostNoteDraft(wallet: cold, txHash: tx, asset: "USDC", decimals: 6, units: "1500000")
        #expect(DeviceFlow.publish(server: server, draft: draft, usd: "250")?.absoluteString == "http://127.0.0.1:8787?publish=\(tx)&wallet=\(cold)&asset=USDC&units=1500000&decimals=6&usd=250")
    }

    @Test func aPublishLinkLeavesOutWhatIsntAnAmount() {
        let draft = CostNoteDraft(wallet: cold, txHash: tx, asset: "USDC", decimals: 6, units: "1500000")
        #expect(DeviceFlow.publish(server: server, draft: draft, usd: "lots")?.absoluteString.contains("usd") == false)
        #expect(DeviceFlow.publish(server: server, draft: draft, usd: nil)?.absoluteString.contains("usd") == false)
    }

    @Test func readsTheWebAppsLink() throws {
        let link = try #require(AddSavingsLink(url: URL(string: "patina://add-savings?address=\(cold)&name=Ledger&linked=\(hot)")!))
        #expect(link.address == cold)
        #expect(link.name == "Ledger")
        #expect(link.linked == [hot])
    }

    @Test func ignoresWhatIsntOne() {
        #expect(AddSavingsLink(url: URL(string: "patina://add-savings?address=nope")!) == nil)
        #expect(AddSavingsLink(url: URL(string: "patina://something-else?address=\(cold)")!) == nil)
        #expect(AddSavingsLink(url: URL(string: "https://add-savings?address=\(cold)")!) == nil)
        #expect(AddSavingsLink(url: URL(string: "patina://add-savings")!) == nil)
    }

    @Test func leavesOutBadLinkedAccountsAndTheOneBeingAdded() throws {
        let link = try #require(AddSavingsLink(url: URL(string: "patina://add-savings?address=\(cold)&linked=nope,\(cold.uppercased().replacing("0X", with: "0x")),\(hot)")!))
        #expect(link.linked == [hot])
    }

    @Test func anAccountTheLinkNamesIsntLinkedUnlessItsAccepted() throws {
        let forged = "0x" + String(repeating: "cc", count: 20)
        let link = try #require(AddSavingsLink(url: URL(string: "patina://add-savings?address=\(cold)&linked=\(hot),\(forged)")!))
        #expect(link.accountsToLink(accepted: [], adding: cold).isEmpty, "checking the main address says nothing about the others")
        #expect(link.accountsToLink(accepted: [hot], adding: cold) == [hot], "the forged one stays out")
        #expect(link.accountsToLink(accepted: [hot, forged], adding: cold) == [hot, forged])
    }

    @Test func editingTheAddressDropsWhatTheLinkNamed() throws {
        let link = try #require(AddSavingsLink(url: URL(string: "patina://add-savings?address=\(cold)&linked=\(hot)")!))
        let other = "0x" + String(repeating: "dd", count: 20)
        #expect(link.accountsToLink(accepted: [hot], adding: other).isEmpty)
        #expect(link.accountsToLink(accepted: [hot], adding: " \(cold.uppercased().replacing("0X", with: "0x")) ") == [hot], "the same address, tidied up, is still that wallet")
    }

    @Test func aLinkCantFillTheSheetWithAccounts() throws {
        let many = (0..<50).map { String(format: "0x%040x", $0 + 1) }.joined(separator: ",")
        let link = try #require(AddSavingsLink(url: URL(string: "patina://add-savings?address=\(cold)&linked=\(many),\(String(format: "0x%040x", 1))")!))
        #expect(link.linked.count == 8)
        #expect(Set(link.linked).count == 8)
    }

    @Test func keepsAStrangersNameShort() throws {
        let link = try #require(AddSavingsLink(url: URL(string: "patina://add-savings?address=\(cold)&name=\(String(repeating: "x", count: 500))")!))
        #expect(link.name.count == 40)
    }
}
