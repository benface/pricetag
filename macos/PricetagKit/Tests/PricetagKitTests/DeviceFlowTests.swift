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

    @Test func keepsAStrangersNameShort() throws {
        let link = try #require(AddSavingsLink(url: URL(string: "patina://add-savings?address=\(cold)&name=\(String(repeating: "x", count: 500))")!))
        #expect(link.name.count == 40)
    }
}
