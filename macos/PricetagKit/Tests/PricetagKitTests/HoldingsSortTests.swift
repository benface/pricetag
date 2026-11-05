import Foundation
@testable import PricetagKit
import Testing

/// The same rules as the web app's, in `test/holdings.test.ts`.
@Suite struct HoldingsSortTests {
    private func order(_ sort: HoldingsSort) throws -> [String] {
        try demoPortfolio().listedPositions.sorted(using: sort).map(\.asset)
    }

    @Test func startsWithTheLargestValue() throws {
        #expect(try order(.largestFirst).prefix(3) == ["USDC", "cbBTC", "ETH"])
    }

    @Test func aReturnThatsUnknownGoesLastEitherWayAndIsntZero() throws {
        var sort = HoldingsSort(.return)
        #expect(sort.order == .reverse)
        let largest = try order(sort)
        #expect(largest.prefix(2) == ["AERO", "USDT"])
        sort.order = .forward
        let smallest = try order(sort)
        #expect(smallest.prefix(2) == ["USDT", "AERO"])
        // The rest have an unknown cost, so they keep their place at the end, by name.
        #expect(largest.dropFirst(2) == smallest.dropFirst(2))
        #expect(Array(largest.dropFirst(2)) == ["cbBTC", "DAI", "ETH", "USDC", "VIRTUAL"])
    }

    @Test func namesStartWithA() throws {
        #expect(HoldingsSort(.asset).order == .forward)
        #expect(try order(HoldingsSort(.asset)).prefix(3) == ["AERO", "cbBTC", "DAI"])
    }

    @Test func amountsAreComparedAsWholeTokens() throws {
        #expect(try order(HoldingsSort(.amount)).first == "USDC")
        #expect(try order(HoldingsSort(.amount)).last == "cbBTC")
    }

    @Test func remembersAChoiceInTheWebAppsWords() {
        #expect(HoldingsSort.largestFirst.rawValue == "value:desc")
        var sort = HoldingsSort(.return)
        sort.order = .forward
        #expect(HoldingsSort(rawValue: sort.rawValue) == sort)
        for text in ["", "value", "price:sideways", "bogus:asc"] { #expect(HoldingsSort(rawValue: text) == nil) }
    }

    @MainActor @Test func theStoreRemembersIt() {
        let defaults = UserDefaults(suiteName: "holdings-sort-\(UUID().uuidString)")!
        #expect(PortfolioStore(defaults: defaults).holdingsSort == .largestFirst)
        PortfolioStore(defaults: defaults).holdingsSort = HoldingsSort(.return)
        #expect(PortfolioStore(defaults: defaults).holdingsSort == HoldingsSort(.return))
    }
}

@Suite struct ReturnTests {
    @Test func comesFromTheServerAndIsNeverZeroWhenUnknown() throws {
        let portfolio = try demoPortfolio()
        let aero = try #require(portfolio.positions.first { $0.asset == "AERO" })
        #expect(aero.returnBps == "1202")
        #expect(Format.percent(bps: try #require(aero.returnBps)) == "+12.0%")
        #expect(portfolio.positions.filter(\.hasUnknownCost).allSatisfy { $0.returnBps == nil })
    }
}
