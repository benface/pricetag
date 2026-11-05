import Foundation
import Testing
@testable import PricetagKit

@Suite struct ChartRangeTests {
    func point(_ second: Int, _ pnl: String?, tx: Bool = true) -> PnlPoint {
        let date = Date(timeIntervalSince1970: 1_800_000_000 + Double(second))
        let timestamp = date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
        return PnlPoint(blockNum: second, timestamp: timestamp, txHash: tx ? "0x\(second)" : nil, pnlMicros: pnl, excludedCount: pnl == nil ? 1 : 0)
    }

    @Test func onlyOffersWhatHistoryCanFill() {
        #expect(ChartRange.available(historyMs: 30 * 60 * 1000) == [.all])
        #expect(ChartRange.available(historyMs: 8 * 3600 * 1000) == [.hour, .all])
        #expect(ChartRange.available(historyMs: 40 * 86400 * 1000) == [.hour, .day, .week, .month, .all])
    }

    @Test func aRangeStartsFromWhatPnlWasThen() {
        let window = ChartWindow(points: [point(0, "1000000"), point(4000, "2000000"), point(8000, "5000000")], range: .hour)
        #expect(window.points.count == 2)
        #expect(window.points.first?.pnlMicros == "2000000")
        #expect(window.points.first?.txHash == nil)
        #expect(window.changeMicros == "3000000")
        #expect(window.changeText(.USD, estimated: false) == "+$3.00 in the past hour")
    }

    @Test func noRangeInventsAPastBeforeTheFirstPoint() {
        let window = ChartWindow(points: [point(0, "1000000"), point(600, "2000000")], range: .hour)
        #expect(window.points.count == 2)
    }

    @Test func allIsEverything() {
        let points = [point(0, "1"), point(9000, "2")]
        #expect(ChartWindow(points: points, range: .all).points == points)
    }

    private func partial(_ second: Int, _ pnl: String, excluded: Int) -> PnlPoint {
        let known = point(second, pnl)
        return PnlPoint(blockNum: known.blockNum, timestamp: known.timestamp, txHash: known.txHash, pnlMicros: known.pnlMicros, excludedCount: excluded)
    }

    @Test func noChangeBetweenSumsThatLeaveOutSomething() {
        // Both leave out one thing, but not the same thing: another holding became measurable, which isn't a gain.
        let window = ChartWindow(points: [partial(0, "1000000", excluded: 1), partial(4000, "1000000", excluded: 1), partial(8000, "4000000", excluded: 1)], range: .hour)
        #expect(window.changeMicros == nil)
        #expect(ChartWindow(points: [point(0, "1000000"), partial(8000, "4000000", excluded: 2)], range: .hour).changeMicros == nil)
        #expect(ChartWindow(points: [point(0, nil), point(8000, "2000000")], range: .hour).changeMicros == nil)
    }

    @Test func noChangeWithoutAKnownStart() {
        // Three fees in the last 25 minutes of a longer history. The first point is already after the first fee, and nothing assumes zero before it.
        let window = ChartWindow(points: [point(0, "-100000"), point(700, "-200000"), point(1500, "-300000")], range: .hour)
        #expect(window.changeMicros == nil)
        #expect(window.changeText(.USD, estimated: false) == nil)
    }

    @Test func allStatesNoChange() {
        #expect(ChartWindow(points: [point(0, "1000000"), point(8000, "5000000")], range: .all).changeText(.USD, estimated: false) == nil)
    }
}
