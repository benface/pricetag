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
        #expect(usdc.pnlMicros == nil)
        #expect(usdc.values.averageCostMicros == nil)
    }

    @Test func keepsUnknownPointsUnknown() throws {
        let portfolio = try demoPortfolio()
        #expect(portfolio.points.first?.pnlMicros == nil)
        #expect(portfolio.hasChartableData)
    }

    @Test func listsTransactionsNewestFirstWithoutTheLatestPoint() throws {
        let transactions = try demoPortfolio().transactions
        #expect(transactions.allSatisfy { $0.txHash != nil })
        #expect(transactions.map(\.blockNum) == transactions.map(\.blockNum).sorted(by: >))
    }

    @Test func readsAnExplanation() throws {
        let explanation = try resource("demo-explanation", as: Explanation.self)
        #expect(explanation.title == "AERO: Realized PnL")
        let leg = try #require(explanation.legs.first)
        #expect(!leg.effect.isEmpty)
        #expect(leg.transactionURL?.host() == "basescan.org")
        #expect(leg.date != nil)
    }

    @Test func readsAPortfolioInAnotherCurrency() throws {
        let portfolio = try resource("demo-portfolio-cad", as: Portfolio.self)
        #expect(portfolio.currency == .CAD)
        #expect(portfolio.exchange?.source == "Chainlink's CAD / USD price on Base")
        #expect(Wording.missingRates(portfolio).isEmpty)
        #expect(try demoPortfolio().exchange == nil)
        #expect(try Wording.missingRates(demoPortfolio()).isEmpty)
    }

    @Test func readsAnExplanationInAnotherCurrency() throws {
        let explanation = try resource("demo-explanation-cad", as: Explanation.self)
        #expect(explanation.currency == .CAD)
        #expect(explanation.sourceValue?.hasSuffix(" USD") == true)
        #expect(explanation.legs.allSatisfy { $0.conversion != nil })
    }

    @Test func saysWhatAMissingRateLeavesUnavailable() throws {
        func portfolio(missing: [String], latest: String?) throws -> Portfolio {
            var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(demoPortfolio())) as! [String: Any]
            object["currency"] = "CAD"
            object["exchange"] = ["source": "A feed", "latestRateMicros": latest as Any, "missingRateTxs": missing]
            return try JSONDecoder().decode(Portfolio.self, from: JSONSerialization.data(withJSONObject: object))
        }
        #expect(try Wording.missingRates(portfolio(missing: ["0xa"], latest: "1400000")) == ["1 transaction has no USD to CAD rate, so what depends on it is unavailable in CAD."])
        #expect(try Wording.missingRates(portfolio(missing: ["0xa", "0xb"], latest: "1400000")) == ["2 transactions have no USD to CAD rate, so what depends on them is unavailable in CAD."])
        #expect(try Wording.missingRates(portfolio(missing: [], latest: nil)) == ["There's no current USD to CAD rate, so what's held has no current value."])
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

@Test func demoPositionsCarryTheirOnchainCheck() throws {
    let portfolio = try demoPortfolio()
    let cbBTC = try #require(portfolio.positions.first { $0.asset == "cbBTC" })
    #expect(cbBTC.isIncomplete)
    #expect(cbBTC.pnlMicros == nil)
    #expect(cbBTC.reconciliation?.differenceQty == "500000")
    #expect(Wording.check(cbBTC)?.contains("difference +0.005 cbBTC") == true)
    let usdc = try #require(portfolio.positions.first { $0.asset == "USDC" })
    #expect(usdc.isReconciled)
}

@Test func anOpeningBalanceIsNotATransaction() throws {
    let json = """
    {"id":"opening:DAI","asset":"DAI","delta":"5","decimals":18,"kind":"transfer","priceMicros":null,"priceSource":null,"priceNote":null,"costLabel":"unknown","estimated":false,"partlyUnknown":false,"blockNum":1,"timestamp":"2026-11-04T00:00:00.000Z","txHash":"","opening":true,"effect":"Adds 5 DAI","netting":null}
    """
    let leg = try JSONDecoder().decode(ExplanationLeg.self, from: Data(json.utf8))
    #expect(leg.transactionURL == nil)
}

/// The Mac app's screenshot scenes read these, and one the models can't decode stops every scene that uses it.
@Test func theAppsFixturesStillDecode() throws {
    let folder = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../../App/TestMode").standardized
    let names = try FileManager.default.contentsOfDirectory(atPath: folder.path()).filter { $0.hasSuffix(".json") }
    let portfolios = names.filter { $0.hasPrefix("demo-portfolio") }
    let explanations = names.filter { $0.hasPrefix("demo-explanation") }
    #expect(portfolios.count >= 2 && explanations.count >= 2)
    for name in portfolios { _ = try JSONDecoder().decode(Portfolio.self, from: Data(contentsOf: folder.appending(path: name))) }
    for name in explanations { _ = try JSONDecoder().decode(Explanation.self, from: Data(contentsOf: folder.appending(path: name))) }
}

@Test func anUnreadBalanceIsNotAnEmptyWallet() throws {
    let url = try #require(Bundle.module.url(forResource: "demo-portfolio", withExtension: "json", subdirectory: "Resources"))
    var json = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    json["positions"] = [Any]()
    json["unreadAssets"] = [String]()
    #expect(try JSONDecoder().decode(Portfolio.self, from: JSONSerialization.data(withJSONObject: json)).isEmpty)
    json["unreadAssets"] = ["ETH"]
    #expect(try !JSONDecoder().decode(Portfolio.self, from: JSONSerialization.data(withJSONObject: json)).isEmpty)
}
