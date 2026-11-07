import Synchronization
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

    @Test func everyHoldingCanOpenItsAveragePrice() throws {
        let portfolio = try demoPortfolio()
        let held = portfolio.listedPositions.filter(\.isHeld)
        #expect(!held.isEmpty)
        #expect(held.allSatisfy { $0.explainableMetrics.contains(.average) })
        let usdc = try #require(held.first { $0.asset == "USDC" })
        #expect(usdc.explainableMetrics.map(\.title) == ["Balance check", "Amount", "Price", "Average price paid", "Value", "Realized PnL", "Unrealized PnL", "Return"])
    }

    /// The details say why there's no price, so a holding without one can still open it.
    @Test func aMissingPriceCanStillBeOpened() throws {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(demoPortfolio())) as! [String: Any]
        var positions = object["positions"] as! [[String: Any]]
        let index = try #require(positions.firstIndex { $0["asset"] as? String == "AERO" })
        positions[index]["price"] = NSNull()
        object["positions"] = positions
        let portfolio = try JSONDecoder().decode(Portfolio.self, from: JSONSerialization.data(withJSONObject: object))
        let aero = try #require(portfolio.listedPositions.first { $0.asset == "AERO" })
        #expect(aero.price == nil)
        #expect(aero.explainableMetrics.contains(.price))
        #expect(portfolio.listedPositions.allSatisfy { $0.explainableMetrics.contains(.price) })
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
        #expect(leg.hasTransaction)
        #expect(leg.date != nil)
    }

    @Test func readsWhereAPriceIsProven() throws {
        let body = #"{"currency":"USD","title":"AERO: Value","value":"$1.00","sourceValue":null,"lines":[],"priceProof":{"asset":"AERO","price":"1000000","wallet":"0xabc"},"legCount":0,"legs":[]}"#
        let explanation = try JSONDecoder().decode(Explanation.self, from: Data(body.utf8))
        #expect(explanation.priceProof == ExplanationPriceProof(asset: "AERO", price: "1000000", wallet: "0xabc"))
        let none = #"{"currency":"USD","title":"AERO: Amount","value":"1","sourceValue":null,"lines":[],"priceProof":null,"legCount":0,"legs":[]}"#
        #expect(try JSONDecoder().decode(Explanation.self, from: Data(none.utf8)).priceProof == nil)
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
    {"id":"opening:DAI","asset":"DAI","delta":"5","decimals":18,"kind":"transfer","priceMicros":null,"priceSource":null,"priceNote":null,"costLabel":"unknown","estimated":false,"partlyUnknown":false,"blockNum":1,"timestamp":"2026-11-04T00:00:00.000Z","txHash":"","opening":true,"summary":"Already held 5 DAI when this history starts.","unknown":"What this cost isn't known yet.","answerable":true,"effect":"Adds 5 DAI","netting":null}
    """
    let leg = try JSONDecoder().decode(ExplanationLeg.self, from: Data(json.utf8))
    #expect(!leg.hasTransaction)
}

@Test func ethThatArrivedWithNoTransactionToNameHasNoLinkOrProof() throws {
    let json = """
    {"id":"unseen:53525052:ETH","asset":"ETH","delta":"2061830000000000","decimals":18,"kind":"transfer","priceMicros":"2424450000","priceSource":"oracle","priceNote":null,"costLabel":"unknown","estimated":false,"partlyUnknown":false,"blockNum":53525052,"timestamp":"2026-11-05T00:44:04.000Z","txHash":"","opening":false,"summary":"Received $5.00 of ETH.","unknown":"What this cost isn't known yet.","answerable":true,"effect":"Adds 0.00206 ETH at an unknown cost","netting":null,"conversion":null}
    """
    let leg = try JSONDecoder().decode(ExplanationLeg.self, from: Data(json.utf8))
    #expect(leg.isIncoming)
    #expect(!leg.hasTransaction)
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
    json["otherTokens"] = [Any]()
    json["positions"] = [Any]()
    json["unreadAssets"] = [String]()
    #expect(try JSONDecoder().decode(Portfolio.self, from: JSONSerialization.data(withJSONObject: json)).isEmpty)
    json["unreadAssets"] = ["ETH"]
    #expect(try !JSONDecoder().decode(Portfolio.self, from: JSONSerialization.data(withJSONObject: json)).isEmpty)
}

@Suite struct ApprovalsModelTests {
    @Test func readsWhatTheServerSends() throws {
        let approvals = try resource("demo-approvals", as: WalletApprovals.self)
        #expect(approvals.mode == .demo)
        #expect(approvals.approvals.count == 4)
        #expect(approvals.unlimitedCount == 3)
        #expect(approvals.approvals.contains { $0.kind == .permit2 && $0.expiry != nil && $0.amountText == "250 USDC" })
        #expect(approvals.approvals.allSatisfy { $0.grantedDate != nil })
    }

    @MainActor @Test func aFailedRefreshKeepsTheListButSaysItsOld() async throws {
        let approvals = try resource("demo-approvals", as: WalletApprovals.self)
        let fails = Mutex(false)
        let model = ApprovalsModel(address: approvals.address) { _ in
            if fails.withLock({ $0 }) { throw FetchError.unreachable }
            return approvals
        }
        await model.load()
        #expect(model.refreshFailure == nil)
        fails.withLock { $0 = true }
        await model.load()
        #expect(model.approvals == approvals)
        #expect(model.refreshFailure == Wording.cantReachServer)
        fails.withLock { $0 = false }
        await model.load()
        #expect(model.refreshFailure == nil)
    }

    @MainActor @Test func neverShowsAnotherWalletsList() async throws {
        let approvals = try resource("demo-approvals", as: WalletApprovals.self)
        let model = ApprovalsModel(address: "0x00000000000000000000000000000000000a11ce") { _ in approvals }
        await model.load()
        #expect(model.approvals == nil)
        let matching = ApprovalsModel(address: approvals.address) { _ in approvals }
        await matching.load()
        #expect(matching.approvals == approvals)
    }
}
