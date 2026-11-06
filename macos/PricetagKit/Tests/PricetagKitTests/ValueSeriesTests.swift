import Foundation
import Testing
@testable import PricetagKit

@Suite struct ValueSeriesTests {
    /// Value in whole dollars before and after a transaction at that second.
    func point(_ second: Int, before: Int?, after: Int?, excluded: Int = 0, tx: Bool = true, continues: Bool = true, read: Bool? = nil) -> PnlPoint {
        let date = Date(timeIntervalSince1970: 1_800_000_000 + Double(second))
        let timestamp = date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
        return PnlPoint(blockNum: second, timestamp: timestamp, txHash: tx ? "0x\(second)" : nil, pnlMicros: nil, excludedCount: 0, valueMicros: after.map { "\($0 * 1_000_000)" }, valueBeforeMicros: before.map { "\($0 * 1_000_000)" }, valueExcludedCount: excluded, valueContinues: continues, valueRead: read)
    }

    @Test func aStretchWithPricesReadAlongItIsKnown() {
        let series = ValueSeries(points: [
            point(0, before: 0, after: 100),
            point(30, before: 120, after: 120, tx: false, read: true),
            point(60, before: 110, after: 210, read: true),
            point(120, before: 200, after: 200, tx: false),
        ])
        #expect(series.lines.map(\.known) == [true, true, true, true, false])
        #expect(series.lines[1].steps.map(\.value) == [100, 120])
        #expect(series.lines[2].steps.map(\.value) == [120, 110])
        #expect(series.gaps.isEmpty)
        #expect(series.values.contains(120), "what's only read between transactions is on the scale")
    }

    @Test func aReadAfterAMissingPriceStartsANewStretch() {
        let series = ValueSeries(points: [
            point(0, before: nil, after: 100, excluded: 1, continues: false),
            point(30, before: 120, after: 120, tx: false, continues: false),
            point(60, before: 130, after: 130, tx: false, read: true),
        ])
        #expect(series.lines.map(\.known) == [true])
        #expect(series.lines[0].steps.map(\.value) == [120, 130])
        #expect(series.gaps.count == 1)
    }

    @Test func aReadAfterNothingKnownStartsANewStretch() {
        let series = ValueSeries(points: [
            point(0, before: nil, after: nil, excluded: 1, continues: false),
            point(30, before: 120, after: 120, tx: false, continues: false),
            point(60, before: 130, after: 130, tx: false, read: true),
        ])
        #expect(series.lines.map(\.known) == [true])
        #expect(series.lines[0].steps.map(\.value) == [120, 130])
        #expect(series.gaps.count == 1)
    }

    @Test func pointsWithNoTransactionArentTransactions() {
        let series = ValueSeries(points: [point(0, before: 0, after: 100), point(30, before: 120, after: 120, tx: false, read: true), point(60, before: 110, after: 110, read: true)])
        #expect(series.nearestTransaction(to: series.plotted[1].date)?.point.txHash != nil)
        #expect(TransactionLog(points: series.plotted.map(\.point)).items.count == 2)
    }

    @Test func aRangeThatStartsBetweenTwoReadPointsGoesBetweenThem() {
        let points = [point(0, before: 0, after: 100), point(3600, before: 200, after: 200, tx: false, read: true), point(7200, before: 300, after: 300, tx: false, read: true), point(7300, before: 300, after: 300, read: true)]
        let window = ChartWindow(points: points, range: .hour)
        #expect(window.points.first?.valueMicros.map { Int($0)! / 1_000_000 } == 202)
        #expect(ValueSeries(points: window.points).lines.allSatisfy { $0.known })
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

private extension PnlPoint {
    var withKnownPnl: PnlPoint {
        PnlPoint(blockNum: blockNum, timestamp: timestamp, txHash: txHash, pnlMicros: "1000000", excludedCount: 0, valueMicros: valueMicros, valueBeforeMicros: valueBeforeMicros, valueExcludedCount: valueExcludedCount, valueContinues: valueContinues)
    }
}
