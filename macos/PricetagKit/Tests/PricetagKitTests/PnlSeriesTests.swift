import Foundation
import Testing
@testable import PricetagKit

@Suite struct PnlSeriesTests {
    func point(_ second: Int, _ pnl: String?, tx: Bool = true) -> PnlPoint {
        let date = Date(timeIntervalSince1970: 1_800_000_000 + Double(second))
        let timestamp = date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
        return PnlPoint(blockNum: second, timestamp: timestamp, txHash: tx ? "0x\(second)" : nil, pnlMicros: pnl, excludedCount: pnl == nil ? 1 : 0)
    }

    @Test func aLeadingUnknownIsAGapAndNotAZero() {
        let series = PnlSeries(points: [point(0, nil), point(1, nil), point(2, "1000000")])
        #expect(series.segments.count == 1)
        #expect(series.segments[0].map(\.value) == [1])
        #expect(series.gaps.count == 1)
        #expect(series.gaps[0].lowerBound == series.plotted[0].date)
        #expect(series.gaps[0].upperBound == series.plotted[2].date)
    }

    @Test func theLineStopsAtAnUnknownAndStartsAgainAfterIt() {
        let series = PnlSeries(points: [point(0, "1000000"), point(1, nil), point(2, "2000000")])
        #expect(series.segments.count == 2)
        // It holds its value up to where it stops being known.
        #expect(series.segments[0].map(\.value) == [1, 1])
        #expect(series.segments[0].last?.date == series.plotted[1].date)
        #expect(series.segments[1].map(\.value) == [2])
        #expect(series.gaps.count == 1)
    }

    @Test func aTrailingUnknownRunsToTheEnd() {
        let series = PnlSeries(points: [point(0, "1000000"), point(1, nil), point(2, nil)])
        #expect(series.gaps[0].upperBound == series.plotted[2].date)
        #expect(series.segments.count == 1)
    }

    @Test func aKnownZeroIsDrawn() {
        let series = PnlSeries(points: [point(0, "0"), point(1, "0")])
        #expect(series.segments.flatMap { $0 }.map(\.value) == [0, 0])
        #expect(series.gaps.isEmpty)
    }

    @Test func nothingKnownDrawsNothing() {
        let series = PnlSeries(points: [point(0, nil), point(1, nil)])
        #expect(series.segments.isEmpty)
        #expect(series.gaps.count == 1)
    }

    @Test func aClickReachesAnUnknownTransactionButNotTheLatestPoint() {
        let series = PnlSeries(points: [point(0, nil), point(10, "1000000", tx: false)])
        let found = series.nearestTransaction(to: series.plotted[1].date)
        #expect(found?.point.txHash == "0x0")
    }

    private func portfolio(points: [PnlPoint]) throws -> Portfolio {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(demoPortfolio())) as! [String: Any]
        object["points"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(points))
        return try JSONDecoder().decode(Portfolio.self, from: JSONSerialization.data(withJSONObject: object))
    }

    @Test func aChartWaitsForAFewTransactionsOverSomeTime() throws {
        // A transaction or two says nothing, and neither do many of them in a couple of minutes.
        #expect(try portfolio(points: [point(0, "1"), point(3600, "2")]).isTooNewToChart)
        #expect(try portfolio(points: [point(0, "1"), point(60, "2"), point(120, "3")]).isTooNewToChart)
        #expect(try !portfolio(points: [point(0, "1"), point(300, "2"), point(600, "3")]).isTooNewToChart)
        // What's unknown can't be plotted, and the latest point isn't a transaction.
        #expect(try portfolio(points: [point(0, nil), point(300, nil), point(600, "3"), point(900, "3", tx: false)]).isTooNewToChart)
    }
}
