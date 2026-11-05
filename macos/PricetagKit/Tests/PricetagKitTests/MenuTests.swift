import Foundation
import Testing
@testable import PricetagKit

@Suite struct MenuTests {
    @Test func copiesAHoldingAsItsRowShowsIt() throws {
        let portfolio = try demoPortfolio()
        let usdc = try #require(portfolio.positions.first { $0.asset == "USDC" })
        let cells = usdc.copyText(currency: portfolio.currency).components(separatedBy: "\t")
        #expect(cells.count == 4)
        #expect(cells[0] == "USDC")
        #expect(cells[1] == Format.amount(usdc.values.qty, decimals: usdc.decimals))
        // Unknown stays unknown, and never reads as $0.
        #expect(cells[3] == Wording.pnlUnavailable)
    }

    @Test func linksOnlyToPagesThatExist() {
        let hash = "0x" + String(repeating: "ab", count: 32)
        #expect(Basescan.transaction(hash)?.absoluteString == "https://basescan.org/tx/\(hash)")
        #expect(Basescan.transaction("") == nil)
        #expect(Basescan.transaction("0x1234") == nil)
        let address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
        #expect(Basescan.address(address)?.absoluteString == "https://basescan.org/address/\(address)")
        #expect(Basescan.address(WalletAddress.demo) == nil)
    }
}
