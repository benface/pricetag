import Foundation
import Testing
@testable import PricetagKit

@Suite struct PnlSeriesTests {
    func point(_ second: Int, _ pnl: String?, tx: Bool = true) -> PnlPoint {
        let date = Date(timeIntervalSince1970: 1_800_000_000 + Double(second))
        let timestamp = date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
        return PnlPoint(blockNum: second, timestamp: timestamp, txHash: tx ? "0x\(second)" : nil, pnlMicros: pnl, excludedCount: pnl == nil ? 1 : 0)
    }

    @Test func aPointedAtTransactionIsWhatThePointsSayNow() {
        let before = PnlSeries(points: [point(0, "10000000"), point(1, "20000000")])
        let id = try! #require(before.transaction(id: point(0, nil).id))
        #expect(id.value == 10)
        // After an answer or a refresh, the same transaction has a new PnL, and that's what's shown for it.
        let after = PnlSeries(points: [point(-1, "30000000"), point(0, "40000000"), point(1, "60000000")])
        #expect(after.transaction(id: id.id)?.value == 40)
        #expect(after.transaction(id: id.id)?.point.excludedCount == 0)
        // Out of view, nothing's pointed at.
        #expect(PnlSeries(points: [point(1, "60000000")]).transaction(id: id.id) == nil)
        // The last point isn't a transaction.
        #expect(before.transaction(id: point(2, "1", tx: false).id) == nil)
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

    @Test func theNearestTransactionIsWhatLookingAtEveryOneWouldFind() {
        // Several in one block, one with no transaction, and gaps of different sizes.
        func same(_ second: Int, _ tx: Int) -> PnlPoint {
            let moment = point(second, "1000000")
            return PnlPoint(blockNum: tx, timestamp: moment.timestamp, txHash: "0x\(tx)", pnlMicros: "1000000", excludedCount: 0)
        }
        let series = PnlSeries(points: [same(0, 100), point(4, "1"), same(10, 101), same(10, 102), point(12, "1", tx: false), same(20, 103), same(20, 104), same(21, 105)])
        let all = series.plotted.filter { $0.point.txHash != nil }
        for half in -4...60 {
            let date = Date(timeIntervalSince1970: 1_800_000_000 + Double(half) / 2)
            let expected = all.min { abs($0.date.timeIntervalSince(date)) < abs($1.date.timeIntervalSince(date)) }
            #expect(series.nearestTransaction(to: date)?.id == expected?.id, "at \(Double(half) / 2)")
        }
        #expect(PnlSeries(points: [point(0, "1", tx: false)]).nearestTransaction(to: .now) == nil)
    }

    @Test func aPointReadsTheSameAfterBeingSavedAndItsDateIsWorkedOutOnce() throws {
        var known = point(5, "1000000")
        known.valueEstimated = true
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(known)) as! [String: Any]
        #expect(json["timestamp"] as? String == known.timestamp)
        #expect(json["valueEstimated"] == nil, "that's never from a server")
        let read = try JSONDecoder().decode(PnlPoint.self, from: JSONEncoder().encode(known))
        #expect(read.date == Date(timeIntervalSince1970: 1_800_000_005))
        #expect(!read.valueEstimated)
        #expect(read.timestamp == known.timestamp)
        #expect(PnlPoint(blockNum: 1, timestamp: "not a date", txHash: nil, pnlMicros: nil, excludedCount: 0).date == nil)
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

@Suite struct ChartAxisTests {
    private func calendar(in zone: String = "America/Toronto") -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: zone)!
        return calendar
    }

    private var calendar: Calendar { calendar() }

    private func axis(from start: TimeInterval = 1_793_800_000, spanning span: TimeInterval, in zone: String = "America/Toronto") -> (axis: ChartAxis.TimeAxis, labels: [String]) {
        let date = Date(timeIntervalSince1970: start)
        let calendar = calendar(in: zone)
        let axis = ChartAxis.TimeAxis(dates: [date, date.addingTimeInterval(span)], calendar: calendar)
        var format = axis.format
        format.timeZone = calendar.timeZone
        format.locale = Locale(identifier: "en_US")
        return (axis, axis.ticks.map { $0.formatted(format) })
    }

    @Test func noTwoTimesReadTheSameAtAnySpan() {
        let hour: TimeInterval = 3600
        let day: TimeInterval = 86400
        let spans: [TimeInterval] = [0.5, 1, 7, 42, 60, 75, 150, 400, 1800, 3 * hour, 9 * hour, 20 * hour, 26 * hour, 2.5 * day, 18 * day, 70 * day, 200 * day, 900 * day, 4000 * day]
        for span in spans {
            let found = axis(spanning: span)
            #expect(Set(found.labels).count == found.labels.count, "\(span): \(found.labels)")
            #expect((1...7).contains(found.labels.count), "\(span): \(found.labels)")
            #expect(found.axis.ticks.allSatisfy(found.axis.domain.contains), "\(span)")
        }
    }

    @Test func theHourThatRepeatsWhenTheClocksGoBackReadsDifferently() {
        // 2027-11-07T04:00:00Z, midnight in Toronto, with 1 AM coming twice.
        let found = axis(from: 1_825_560_000, spanning: 4 * 3600)
        #expect(found.axis.showsTimeZone)
        #expect(found.labels.count == 5)
        #expect(Set(found.labels).count == 5, "\(found.labels)")
        #expect(found.labels[1].contains("EDT") && found.labels[2].contains("EST"), "\(found.labels)")
        let halfHours = axis(from: 1_825_560_000 + 3600, spanning: 2 * 3600)
        #expect(Set(halfHours.labels).count == halfHours.labels.count, "\(halfHours.labels)")
    }

    @Test func aZoneThatMovesHalfAnHourAlsoReadsDifferently() {
        // 2027-04-03T14:00:00Z: Lord Howe goes back 30 minutes at 15:00Z, and its zones only have numeric names.
        let found = axis(from: 1_806_760_800, spanning: 3600, in: "Australia/Lord_Howe")
        #expect(found.axis.showsTimeZone)
        #expect(Set(found.labels).count == found.labels.count, "\(found.labels)")
    }

    @Test func aTimeZoneOnlyShowsWhenItsNeeded() {
        #expect(!axis(spanning: 4 * 3600).axis.showsTimeZone)
        // 2027-03-14T06:00:00Z: the clocks go ahead in Toronto, and no time comes twice.
        #expect(!axis(from: 1_805_004_000, spanning: 4 * 3600).axis.showsTimeZone)
    }

    @Test func aMinuteIsMarkedInSeconds() {
        let found = axis(spanning: 60)
        #expect(found.axis.label == .second)
        #expect(found.labels.allSatisfy { $0.filter { $0 == ":" }.count == 2 }, "\(found.labels)")
    }

    @Test func weeksAreMarkedInDaysNotTimesOfDay() {
        #expect(axis(spanning: 18 * 86400).axis.label == .day)
    }

    @Test func aSingleMomentStillHasAMarkAndAWidth() {
        let date = Date(timeIntervalSince1970: 1_793_800_000)
        let axis = ChartAxis.TimeAxis(dates: [date], calendar: calendar)
        #expect(axis.ticks == [date])
        #expect(axis.domain.lowerBound < axis.domain.upperBound)
        #expect(ChartAxis.TimeAxis(dates: [], calendar: calendar).ticks.count == 1)
    }

    @Test func smallAmountsGetDifferentLabels() {
        let ticks = ChartAxis.moneyTicks([-0.0023], .USD)
        #expect(ticks.map(\.label) == ["-$0.003", "-$0.002", "-$0.001", "$0.000"])
    }

    @Test func nothingKnownIsOneMarkWithAHeight() {
        let ticks = ChartAxis.moneyTicks([], .USD)
        #expect(ticks.map(\.label) == ["$0.00"])
        #expect(ChartAxis.moneyDomain(ticks).lowerBound < ChartAxis.moneyDomain(ticks).upperBound)
    }
}
