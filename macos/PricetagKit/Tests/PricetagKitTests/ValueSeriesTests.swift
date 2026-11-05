import Foundation
import Testing
@testable import PricetagKit

@Suite struct ValueSeriesTests {
    /// Value in whole dollars before and after a transaction at that second.
    func point(_ second: Int, before: Int?, after: Int?, excluded: Int = 0, tx: Bool = true) -> PnlPoint {
        let date = Date(timeIntervalSince1970: 1_800_000_000 + Double(second))
        let timestamp = date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
        return PnlPoint(blockNum: second, timestamp: timestamp, txHash: tx ? "0x\(second)" : nil, pnlMicros: nil, excludedCount: 0, valueMicros: after.map { "\($0 * 1_000_000)" }, valueBeforeMicros: before.map { "\($0 * 1_000_000)" }, valueExcludedCount: excluded)
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
        let series = ValueSeries(points: [point(0, before: 0, after: 100), point(60, before: 100, after: 100, excluded: 1)])
        #expect(series.lines.map(\.known) == [true])
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
