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
    }

    private func point(_ minute: Int, _ micros: String?, excluded: Int = 0, tx: Bool = true) -> PnlPoint {
        PnlPoint(blockNum: minute, timestamp: "2026-11-04T03:\(String(format: "%02d", minute)):00Z", txHash: tx ? "0x\(minute)" : nil, pnlMicros: micros, excludedCount: excluded)
    }

    @Test func aChartThatLeavesThingsOutSaysSo() {
        let series = PnlSeries(points: [point(0, "1000000", excluded: 1), point(10, "2000000", excluded: 1), point(20, "3000000", excluded: 2)])
        let summary = Spoken.chartSummary(series, .USD, isLive: true)
        #expect(summary.contains("It went from +$1.00 (partial) to +$3.00 (partial)"), "\(summary)")
        #expect(summary.contains("Some of it leaves out what's unknown."))
    }

    /// Its end is where it ends, even when what it says there is unknown.
    @Test func anUnknownEndIsTheEndAndSaysUnknown() throws {
        let series = PnlSeries(points: [point(0, "1000000"), point(10, "2000000"), point(20, nil)])
        let summary = Spoken.chartSummary(series, .USD, isLive: true)
        let end = try #require(series.plotted.last?.date)
        #expect(summary.contains("to \(Format.time(end))."), "\(summary)")
        #expect(summary.contains("It went from +$1.00 to unknown."))
        #expect(summary.contains("Unknown for part of it."))
    }

    @Test func aChartThatsAllUnknownStillSaysWhenAndHowFresh() {
        let series = PnlSeries(points: [point(0, nil, excluded: 1), point(10, nil, excluded: 1)])
        let summary = Spoken.chartSummary(series, .USD, isLive: false)
        #expect(summary.contains("It's unknown for all of it."))
        #expect(summary.hasSuffix("Not updating."))
        #expect(Spoken.chartSummary(PnlSeries(points: []), .USD, isLive: false) == "Total PnL over time: nothing to show yet. Not updating.")
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

    @Test func aHoldingsPriceAndReturnSayWhatTheyAre() throws {
        let portfolio = try demoPortfolio()
        let aero = try #require(portfolio.positions.first { $0.asset == "AERO" })
        let label = HoldingRow.spokenLabel(aero, portfolio.currency, isLive: true, amount: "500", price: "≈$1.40", returnText: "≈+27%")
        #expect(label == "AERO, amount, 500, price, about $1.40, value, about $700.00, PnL, about +$150.11, return, about +27%")
    }

    @Test func eachComparedNumberSaysWhatItIsAndByWhichRule() throws {
        let comparison = try resource("demo-rule-comparison", as: RuleComparison.self)
        let tree = try lines(RuleComparisonTable(comparison: comparison))
        #expect(tree.contains("Total PnL, by Market price, about +$149.30, partial"), "\(tree)")
        #expect(tree.contains { $0.hasPrefix("Total PnL, by Cautious ETH, ") && $0.hasSuffix(", partial") })
        #expect(tree.contains { $0.hasPrefix("Total PnL, difference, ") })
        // No bare "partial" or amount on its own.
        #expect(!tree.contains("partial"))
    }

    /// The server leaves a difference out when the two totals can't be compared. That's not the same as there being none.
    @Test func anUnknownDifferenceIsNeverReadAsNone() throws {
        let demo = try resource("demo-rule-comparison", as: RuleComparison.self)
        func row(_ label: String, _ b: String?, difference: String?) -> RuleRow {
            RuleRow(label: label, format: "money", a: "1000000", b: b, difference: difference, aPartial: false, bPartial: false, aEstimated: false, bEstimated: false)
        }
        let comparison = RuleComparison(address: demo.address, currency: demo.currency, blockNum: demo.blockNum, a: demo.a, b: demo.b, why: demo.why, warnings: [], rows: [
            row("No price", nil, difference: nil),
            row("Left out", "2000000", difference: nil),
            row("Equal", "1000000", difference: "0"),
        ], transactions: [], changedTxs: 0)
        let tree = try lines(RuleComparisonTable(comparison: comparison))
        #expect(tree.contains("No price, by \(demo.b.name), unknown"), "\(tree)")
        #expect(tree.contains("No price, difference, unknown"), "\(tree)")
        #expect(tree.contains("Left out, difference, unknown"), "\(tree)")
        #expect(tree.contains("Equal, difference, Same"), "\(tree)")
        #expect(!tree.contains { $0.hasSuffix(", none") }, "\(tree)")
    }

    @Test func theHoldComparisonSaysWhenItStoppedUpdating() throws {
        let portfolio = try demoPortfolio()
        let live = try lines(HoldComparisonCard(comparison: portfolio.holdComparison, currency: portfolio.currency, isLive: true) {})
        let old = try lines(HoldComparisonCard(comparison: portfolio.holdComparison, currency: portfolio.currency, isLive: false) {})
        let summary = Spoken.text(Wording.holdSummary(portfolio.holdComparison, portfolio.currency))
        #expect(live == ["Compared with holding ETH, \(summary)"])
        #expect(old == ["Compared with holding ETH, \(summary), not updating"])
    }

    @Test func theChartIsOneSummaryNotItsMarks() throws {
        let portfolio = try demoPortfolio()
        let tree = try lines(PnlChartView(points: portfolio.points, currency: portfolio.currency, isLive: true) { _ in }.frame(height: 200))
        #expect(tree.count == 1)
        #expect(tree.first?.hasPrefix("Total PnL over time, from ") == true)
    }
}
#endif
