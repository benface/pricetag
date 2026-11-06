import Foundation
import Testing
@testable import PricetagKit

@Suite struct ValueSeriesTests {
    /// Value in whole dollars before and after a transaction at that second.
    func point(_ second: Int, before: Int?, after: Int?, excluded: Int = 0, tx: Bool = true, continues: Bool = true) -> PnlPoint {
        let date = Date(timeIntervalSince1970: 1_800_000_000 + Double(second))
        let timestamp = date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
        return PnlPoint(blockNum: second, timestamp: timestamp, txHash: tx ? "0x\(second)" : nil, pnlMicros: nil, excludedCount: 0, valueMicros: after.map { "\($0 * 1_000_000)" }, valueBeforeMicros: before.map { "\($0 * 1_000_000)" }, valueExcludedCount: excluded, valueContinues: continues)
    }

    @Test func aDepositIsAKnownJumpAndWhatsBetweenIsAnEstimate() {
        let series = ValueSeries(points: [point(0, before: 0, after: 100), point(60, before: 110, after: 210), point(120, before: 200, after: 200, tx: false)])
        #expect(series.lines.map(\.known) == [true, false, true, false])
        #expect(series.lines.map { $0.steps.map(\.value) } == [[0, 100], [100, 110], [110, 210], [210, 200]])
        // Both ends of a jump are at the same moment.
        #expect(series.lines[2].steps[0].date == series.lines[2].steps[1].date)
        #expect(series.gaps.isEmpty)
    }

    @Test func aSwapAtTheSamePricesIsNoJump() {
        let series = ValueSeries(points: [point(0, before: 0, after: 100), point(60, before: 105, after: 105)])
        #expect(series.lines.map(\.known) == [true, false])
    }

    @Test func anUnknownIsAGapAndNotAZero() {
        let series = ValueSeries(points: [point(0, before: 0, after: 100), point(60, before: nil, after: nil), point(120, before: 50, after: 80)])
        #expect(series.gaps.count == 1)
        #expect(series.gaps[0].lowerBound == series.plotted[1].date)
        #expect(series.gaps[0].upperBound == series.plotted[2].date)
        // Nothing joins across it, and the only $0 is the real one before the first deposit.
        #expect(!series.lines.contains { line in line.steps.contains { $0.date == series.plotted[1].date } })
        #expect(series.values.filter { $0 == 0 }.count == 1)
    }

    @Test func pointsThatLeaveOutDifferentThingsArentJoined() {
        let series = ValueSeries(points: [point(0, before: 0, after: 100), point(60, before: 100, after: 100, excluded: 1, continues: false)])
        #expect(series.lines.map(\.known) == [true])
        #expect(series.gaps == [series.plotted[0].date...series.plotted[1].date])
    }

    /// From the SDK, by way of `test/portfolio.test.ts`.
    struct Breaks: Decodable {
        let unnamedEth: [PnlPoint]
        let differentOmissions: [PnlPoint]
    }

    @Test func aStretchWithEthThatArrivedUnnamedIsAGapAndNotPriceMovement() throws {
        let points = try resource("value-breaks", as: Breaks.self).unnamedEth
        let series = ValueSeries(points: points)
        // At minutes 0, 20, 120 and 150, with the ETH arriving at minute 60.
        #expect(series.gaps == [series.plotted[1].date...series.plotted[2].date])
        #expect(!series.lines.contains { line in !line.known && line.steps.first?.date == series.plotted[1].date })
        let window = ChartWindow(points: points, range: .hour)
        #expect(window.points.first?.valueMicros == nil)
        #expect(window.changeMicros(.value) == nil)
        #expect(ValueSeries(points: window.points).gaps == [window.points[0].date!...window.points[1].date!])
        // PnL has the same points as ever, and doesn't stop.
        #expect(PnlSeries(points: points).plotted.map(\.point.txHash) == ["0x1", "0x2", "0x3", nil])
    }

    @Test func pointsLeavingOutAsManyDifferentHoldingsAreAGap() throws {
        let points = try resource("value-breaks", as: Breaks.self).differentOmissions
        #expect(points[1].valueExcludedCount == points[2].valueExcludedCount)
        let series = ValueSeries(points: points)
        #expect(series.gaps.contains(series.plotted[1].date...series.plotted[2].date))
        #expect(!series.lines.contains { line in line.steps.first?.date == series.plotted[1].date && line.steps.last?.date == series.plotted[2].date })
        // A range starting between two like them doesn't go between them either.
        let window = ChartWindow(points: [point(0, before: 0, after: 100, excluded: 1), point(7200, before: 300, after: 300, excluded: 1, continues: false), point(7300, before: 300, after: 300, excluded: 1, tx: false)], range: .hour)
        #expect(window.points.first?.valueMicros == nil)
    }

    @Test func eachMetricSaysWhetherItsOwnStretchIsUnknown() {
        // Value's known throughout, and PnL isn't at the first point.
        let valueKnown = [point(0, before: 0, after: 100), point(60, before: 100, after: 100)]
        #expect(!ChartWindow(points: valueKnown, range: .all).hasUnknown(.value))
        #expect(ChartWindow(points: valueKnown, range: .all).hasUnknown(.pnl))
        // More than prices moved between these two, and PnL has nothing to do with it.
        let broken = [point(0, before: 0, after: 100), point(60, before: 300, after: 300, continues: false)].map(\.withKnownPnl)
        #expect(ChartWindow(points: broken, range: .all).hasUnknown(.value))
        #expect(!ChartWindow(points: broken, range: .all).hasUnknown(.pnl))
    }

    @Test func aRangeThatStartsInsideAValueGapSaysSo() {
        let points = [point(0, before: 0, after: 100), point(7200, before: 300, after: 300, continues: false), point(7300, before: 300, after: 300, tx: false)]
        #expect(ChartWindow(points: points, range: .hour).hasUnknown(.value))
    }

    @Test func aRangeStartsOnTheEstimateBetweenTwoTransactions() {
        let points = [point(0, before: 0, after: 100), point(7200, before: 300, after: 300), point(7300, before: 300, after: 300, tx: false)]
        let window = ChartWindow(points: points, range: .hour)
        // An hour before the end is at 3,700 of the 7,200 seconds between them.
        let start = try! #require(window.points.first)
        #expect(start.txHash == nil)
        #expect(start.valueMicros.map { Int($0)! / 10_000 } == 20_277)
        #expect(start.valueBeforeMicros == start.valueMicros)
        #expect(window.changeText(.USD, estimated: false, metric: .value) == "≈+$97.22 in the past hour")
    }

    @Test func noValueChangeWhenEitherEndLeavesSomethingOut() {
        let points = [point(0, before: 0, after: 100), point(7200, before: 300, after: 300, excluded: 1)]
        #expect(ChartWindow(points: points, range: .hour).changeMicros(.value) == nil)
    }
}

/// What VoiceOver says has to be what's drawn.
@Suite struct ValueSpeechTests {
    private func point(_ second: Int, _ before: Int?, _ after: Int?, _ excluded: Int, _ tx: Bool, _ continues: Bool) -> PnlPoint {
        ValueSeriesTests().point(second, before: before, after: after, excluded: excluded, tx: tx, continues: continues)
    }

    @Test func aWithdrawalsHighIsWhatWasThereJustBeforeIt() {
        let series = ValueSeries(points: [point(0, 0, 100, 0, true, false), point(7200, 300, 150, 0, true, true), point(7300, 150, 150, 0, false, true)])
        let summary = Spoken.chartSummary(series, .USD, isLive: true)
        #expect(summary.contains("It went from $100.00 to $150.00, with a high of $300.00 and a low of $0.00."), "\(summary)")
        #expect(series.spokenPoints(.USD).map(\.value) == [0, 100, 300, 150, 150])
    }

    @Test func aDepositsHighIsWhatItBrought() {
        let series = ValueSeries(points: [point(0, 100, 100, 0, true, false), point(60, 110, 310, 0, true, true), point(120, 200, 200, 0, false, true)])
        let summary = Spoken.chartSummary(series, .USD, isLive: true)
        #expect(summary.contains("with a high of $310.00 and a low of $100.00."), "\(summary)")
    }

    /// Two transactions are enough to go higher than where either stands afterward.
    @Test func twoPointsCanStillHaveAHigh() {
        let series = ValueSeries(points: [point(0, 100, 100, 0, true, false), point(60, 300, 150, 0, true, true)])
        #expect(Spoken.chartSummary(series, .USD, isLive: true).contains("with a high of $300.00 and a low of $100.00."))
    }

    @Test func aHighThatLeavesThingsOutSaysSo() {
        let series = ValueSeries(points: [point(0, 100, 100, 1, true, false), point(60, 300, 150, 1, true, true), point(120, 150, 150, 1, false, true)])
        #expect(Spoken.chartSummary(series, .USD, isLive: true).contains("with a high of $300.00 (partial) and a low of $100.00 (partial)."))
    }

    /// VoiceOver's chart tools go up the jump as the line does, and each end says which it is.
    @Test func theChartToolsGetBothEndsOfAJump() {
        var withdrawal = point(60, 300, 150, 0, true, true)
        withdrawal.summary = "Sent 1 ETH"
        let points = ValueSeries(points: [point(0, 100, 100, 0, true, false), withdrawal]).spokenPoints(.USD)
        #expect(points.map(\.value) == [100, 300, 150])
        #expect(points[1].label.hasSuffix("$300.00, just before its transaction"), "\(points[1].label)")
        #expect(points[2].label.hasSuffix("$150.00, Sent 1 ETH"), "\(points[2].label)")
        #expect(points[1].date == points[2].date)
    }

    @Test func aFlatLineHasNoHighOrLow() {
        let series = ValueSeries(points: [point(0, 100, 100, 0, true, false), point(60, 100, 100, 0, true, true), point(120, 100, 100, 0, false, true)])
        let summary = Spoken.chartSummary(series, .USD, isLive: true)
        #expect(summary.contains("It went from $100.00 to $100.00."), "\(summary)")
    }

    @Test func aRangeStartBetweenPricesIsAnEstimateEverywhereItsSaid() throws {
        let window = ChartWindow(points: [point(0, 0, 100, 0, true, false), point(7200, 300, 150, 0, true, true), point(7300, 150, 150, 0, false, true)], range: .hour)
        let series = ValueSeries(points: window.points)
        let summary = Spoken.chartSummary(series, .USD, isLive: true)
        #expect(summary.contains("It went from about $202.78 to $150.00, with a high of $300.00 and a low of $150.00."), "\(summary)")
        #expect(summary.contains("Estimated where prices weren't read."), "\(summary)")
        let start = try #require(series.spokenPoints(.USD).first)
        #expect(start.label.hasSuffix("about $202.78"), "\(start.label)")
        #expect(Spoken.chartStep(series.plotted[0], .USD, metric: .value).hasSuffix("about $202.78"))
        #expect(series.spokenPoints(.USD).dropFirst().allSatisfy { !$0.label.contains("about") }, "only the start is worked out")
    }

    /// Points with no transaction, as when prices are read between transactions, are no more a reason to call the start known.
    @Test func aRangeStartBetweenPointsWithNoTransactionIsAnEstimateToo() {
        let window = ChartWindow(points: [point(0, 100, 100, 0, true, false), point(3600, 200, 200, 0, false, true), point(7200, 300, 300, 0, false, true), point(7300, 300, 300, 0, false, true)], range: .hour)
        #expect(Spoken.chartSummary(ValueSeries(points: window.points), .USD, isLive: true).contains("from about $"))
    }

    /// With nothing to go between, the start is unknown and not an estimate.
    @Test func aRangeStartThatsAGapIsUnknownAndNotAnEstimate() {
        let window = ChartWindow(points: [point(0, 100, 100, 0, true, false), point(7200, 300, 150, 0, true, false), point(7300, 150, 150, 0, false, true)], range: .hour)
        #expect(window.points[0].valueMicros == nil)
        #expect(!window.points[0].valueEstimated)
        #expect(Spoken.chartSummary(ValueSeries(points: window.points), .USD, isLive: true).contains("It went from unknown to $150.00"))
    }

    @Test func pnlNeverSaysAboutForARangeStart() {
        var first = point(0, 0, 100, 0, true, false)
        first = PnlPoint(blockNum: first.blockNum, timestamp: first.timestamp, txHash: first.txHash, pnlMicros: "5000000", excludedCount: 0, valueMicros: first.valueMicros, valueBeforeMicros: first.valueBeforeMicros, valueExcludedCount: 0, valueContinues: false)
        var second = point(7200, 300, 150, 0, true, true)
        second = PnlPoint(blockNum: second.blockNum, timestamp: second.timestamp, txHash: second.txHash, pnlMicros: "7000000", excludedCount: 0, valueMicros: second.valueMicros, valueBeforeMicros: second.valueBeforeMicros, valueExcludedCount: 0, valueContinues: true)
        let window = ChartWindow(points: [first, second, second.withoutTransaction(at: 7300)], range: .hour)
        let summary = Spoken.chartSummary(PnlSeries(points: window.points), .USD, isLive: true)
        #expect(summary.contains("It went from +$5.00 to +$7.00"), "\(summary)")
        #expect(!summary.contains("about") && !summary.contains("Estimated"), "\(summary)")
    }
}

private extension PnlPoint {
    var withKnownPnl: PnlPoint {
        PnlPoint(blockNum: blockNum, timestamp: timestamp, txHash: txHash, pnlMicros: "1000000", excludedCount: 0, valueMicros: valueMicros, valueBeforeMicros: valueBeforeMicros, valueExcludedCount: valueExcludedCount, valueContinues: valueContinues)
    }
}

private extension PnlPoint {
    func withoutTransaction(at second: Int) -> PnlPoint {
        let date = Date(timeIntervalSince1970: 1_800_000_000 + Double(second))
        return PnlPoint(blockNum: second, timestamp: date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true)), txHash: nil, pnlMicros: pnlMicros, excludedCount: 0, valueMicros: valueMicros, valueBeforeMicros: valueMicros, valueExcludedCount: 0, valueContinues: true)
    }
}
