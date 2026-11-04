import Foundation
import Testing
@testable import PricetagKit

@Suite struct ModelsTests {
    @Test func readsWhatTheServerSends() throws {
        let portfolio = try demoPortfolio()
        #expect(portfolio.mode == .demo)
        #expect(portfolio.method == .average)
        #expect(portfolio.pnlStatus == .partial)
        #expect(!portfolio.positions.isEmpty)
        #expect(portfolio.latest.date != nil)
        #expect(portfolio.points.allSatisfy { $0.date != nil })
    }

    @Test func keepsUnknownsUnknown() throws {
        let usdc = try #require(try demoPortfolio().positions.first { $0.asset == "USDC" })
        #expect(usdc.hasUnknownCost)
        #expect(usdc.pnlUsdMicros == nil)
        #expect(usdc.values.averageCostUsdMicros == nil)
    }

    @Test func readsAnExplanation() throws {
        let explanation = try resource("demo-explanation", as: Explanation.self)
        #expect(explanation.title == "AERO: Realized PnL")
        let leg = try #require(explanation.legs.first)
        #expect(!leg.effect.isEmpty)
        #expect(leg.transactionURL?.host() == "basescan.org")
        #expect(leg.date != nil)
    }

    @Test func checksAddresses() {
        #expect(WalletAddress.isValid("0x" + String(repeating: "aB", count: 20)))
        #expect(!WalletAddress.isValid("0x123"))
        #expect(!WalletAddress.isValid("demo"))
        #expect(!WalletAddress.isValid("0x" + String(repeating: "g", count: 40)))
    }

    @Test func saysWhatATotalLeavesOut() {
        let excluded = [Exclusion(asset: "USDC", reason: "unknown cost"), Exclusion(asset: "AERO", reason: "no current price"), Exclusion(asset: "ETH", reason: "unknown cost")]
        #expect(Wording.excluded(excluded) == "Excludes USDC, ETH (unknown cost); AERO (no current price).")
        #expect(Wording.excluded([]) == nil)
    }
}
