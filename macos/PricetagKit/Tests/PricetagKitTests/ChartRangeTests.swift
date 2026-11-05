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

    @Test func noChangeBetweenSumsThatLeaveOutDifferentThings() {
        var later = point(600, "2000000")
        later = PnlPoint(blockNum: later.blockNum, timestamp: later.timestamp, txHash: later.txHash, pnlMicros: later.pnlMicros, excludedCount: 2)
        #expect(ChartWindow(points: [point(0, "1000000"), later], range: .all).changeMicros == nil)
        #expect(ChartWindow(points: [point(0, nil), point(600, "2000000")], range: .all).changeMicros == nil)
    }
}
