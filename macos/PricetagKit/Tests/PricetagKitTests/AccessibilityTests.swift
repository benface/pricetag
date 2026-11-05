#if DEBUG && canImport(AppKit)
import AppKit
import ApplicationServices
import SwiftUI
import Testing
@testable import PricetagKit

struct SpokenTests {
    @Test func saysAboutForAnEstimateAndNoneForADash() {
        #expect(Spoken.text("≈+$149.30") == "about +$149.30")
        #expect(Spoken.text("$12.50") == "$12.50")
        #expect(Spoken.text("—") == "none")
        #expect(Spoken.text("20 USDC · 0.005 ETH") == "20 USDC, 0.005 ETH")
    }

    @Test func aNumberSaysWhatItIsAndAnythingThatChangesWhatItMeans() {
        #expect(Spoken.number("Total PnL", "≈+$149.30", isPartial: true) == "Total PnL, about +$149.30, partial")
        #expect(Spoken.number("Value", "$7.00", isLive: false) == "Value, $7.00, not updating")
        // Nothing known is never read as a number, and isn't partial either.
        #expect(Spoken.number("Total PnL", nil, isPartial: true) == "Total PnL, unknown")
    }

    @Test func anAddressIsReadInGroups() {
        #expect(Spoken.address("0x00000000000000000000000000000000000De302") == "0x 0000 0000 0000 0000 0000 0000 0000 0000 000D e302")
    }

    @Test func theChartSaysHowItWentAndWhatItCantKnow() throws {
        let portfolio = try demoPortfolio()
        let summary = Spoken.chartSummary(PnlSeries(points: portfolio.points), portfolio.currency, isLive: false)
        #expect(summary.hasPrefix("Total PnL over time, from "))
        #expect(summary.contains("transactions."))
        #expect(summary.hasSuffix("Not updating."))
        let empty = PnlSeries(points: [PnlPoint(blockNum: 1, timestamp: "2026-11-04T03:00:00Z", txHash: "0x1", pnlMicros: nil, excludedCount: 1)])
        #expect(Spoken.chartSummary(empty, .USD, isLive: true) == "Total PnL over time: unknown")
    }
}

/// What VoiceOver finds, read from the tree macOS builds for it. Reading it needs Accessibility in System Settings for whatever runs the tests.
@MainActor
@Suite(.serialized, .enabled(if: AXIsProcessTrusted()))
struct AccessibilityTreeTests {
    private func lines(_ view: some View) throws -> [String] {
        try AccessibilityTree.elements(of: view.frame(width: 640), settle: 0.05).map { [$0.label, $0.value].filter { !$0.isEmpty }.joined(separator: ", ") }
    }

    @Test func numbersSayWhatTheyAreAndWhenTheyStoppedUpdating() throws {
        let portfolio = try demoPortfolio()
        let live = try lines(PortfolioSummary(portfolio: portfolio, isLive: true, size: 30) { _ in }.padding())
        #expect(live.contains("Total PnL, about +$149.30, partial"))
        // The label above the number isn't read again on its own.
        #expect(!live.contains("Total PnL"))
        let old = try lines(PortfolioSummary(portfolio: portfolio, isLive: false, size: 30) { _ in }.padding())
        #expect(old.contains("Value, about $7,571.03, not updating"))
    }

    @Test func aHoldingSaysWhichNumberIsWhich() throws {
        let portfolio = try demoPortfolio()
        let aero = try #require(portfolio.positions.first { $0.asset == "AERO" })
        #expect(try lines(HoldingRow(position: aero, currency: portfolio.currency, isLive: true)) == ["AERO, value, about $700.00, PnL, about +$150.11"])
        let eth = try #require(portfolio.positions.first { $0.asset == "ETH" })
        #expect(try lines(HoldingRow(position: eth, currency: portfolio.currency, isLive: false)) == ["ETH, value, $1,366.68, Cost unknown, not updating"])
    }

    @Test func theChartIsOneSummaryNotItsMarks() throws {
        let portfolio = try demoPortfolio()
        let tree = try lines(PnlChartView(points: portfolio.points, currency: portfolio.currency, isLive: true) { _ in }.frame(height: 200))
        #expect(tree.count == 1)
        #expect(tree.first?.hasPrefix("Total PnL over time, from ") == true)
    }
}
#endif
