// Turns chart points into what can be drawn. Where PnL is unknown the line stops: it never passes through $0.

import Foundation

struct PnlSeries {
    struct Plotted: Identifiable, Equatable {
        let point: PnlPoint
        let date: Date
        /// nil where nothing is known.
        let value: Double?
        var id: String { point.id }
    }

    struct Step: Identifiable, Equatable {
        let id: String
        let date: Date
        let value: Double
    }

    /// Runs of known values, each drawn as its own line.
    let segments: [[Step]]
    /// Where nothing is known, from the first unknown point to the next known one, or the end.
    let gaps: [ClosedRange<Date>]
    let plotted: [Plotted]
    let transactions: PlottedTransactions

    init(points: [PnlPoint]) {
        let plotted = points.compactMap { point -> Plotted? in
            point.date.map { Plotted(point: point, date: $0, value: point.pnlMicros.flatMap(Format.chartValue)) }
        }
        var segments: [[Step]] = []
        var gaps: [ClosedRange<Date>] = []
        var current: [Step] = []
        var gapStart: Date?
        for item in plotted {
            if let value = item.value {
                if let start = gapStart {
                    gaps.append(start...item.date)
                    gapStart = nil
                }
                current.append(Step(id: item.id, date: item.date, value: value))
            } else {
                // PnL holds still between transactions, so the line runs up to where it stops being known.
                if let last = current.last {
                    current.append(Step(id: "\(item.id):end", date: item.date, value: last.value))
                    segments.append(current)
                    current = []
                }
                if gapStart == nil { gapStart = item.date }
            }
        }
        if !current.isEmpty { segments.append(current) }
        if let start = gapStart, let end = plotted.last?.date { gaps.append(start...end) }
        self.segments = segments
        self.gaps = gaps
        self.plotted = plotted
        transactions = PlottedTransactions(plotted)
    }
}

/// The points with a transaction behind them, ready for a pointer that asks about them on every move.
struct PlottedTransactions {
    /// Oldest first, and in their order in the series where they're at the same moment.
    private let byDate: [PnlSeries.Plotted]
    private let byID: [String: PnlSeries.Plotted]

    init(_ plotted: [PnlSeries.Plotted]) {
        byDate = plotted.filter { $0.point.txHash != nil }.sorted { $0.date < $1.date }
        byID = Dictionary(byDate.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    }

    subscript(id: String) -> PnlSeries.Plotted? { byID[id] }

    /// The earlier of two as near as each other, and the first of several at the same moment.
    func nearest(to date: Date) -> PnlSeries.Plotted? {
        let after = firstIndex(atOrAfter: date)
        guard after > 0 else { return byDate.first }
        let before = byDate[firstIndex(atOrAfter: byDate[after - 1].date)]
        guard after < byDate.count else { return before }
        return abs(byDate[after].date.timeIntervalSince(date)) < abs(before.date.timeIntervalSince(date)) ? byDate[after] : before
    }

    private func firstIndex(atOrAfter date: Date) -> Int {
        var low = 0
        var high = byDate.count
        while low < high {
            let middle = (low + high) / 2
            if byDate[middle].date < date { low = middle + 1 } else { high = middle }
        }
        return low
    }
}

/// What a chart can point at.
protocol PlottedSeries {
    var plotted: [PnlSeries.Plotted] { get }
    var transactions: PlottedTransactions { get }
    /// Everything drawn, for VoiceOver's own chart tools.
    func spokenPoints(_ currency: CurrencyCode) -> [Spoken.ChartPoint]
}

extension PlottedSeries {
    /// A transaction by its ID, as these points say it is now. nil once it's out of view.
    func transaction(id: String?) -> PnlSeries.Plotted? {
        id.flatMap { transactions[$0] }
    }

    /// The transaction nearest to a date, known or not, so a click on a gap still opens its legs.
    func nearestTransaction(to date: Date) -> PnlSeries.Plotted? {
        transactions.nearest(to: date)
    }
}

extension PnlSeries: PlottedSeries {}

/// What was held, which is only known where prices were read: at the wallet's own transactions, between them where the server read some, and now.
/// At each transaction it's known just before and just after, so a deposit is a jump. Between them only prices moved. If they were read along the way, that stretch is known. If nobody read them, it's a straight line marked as an estimate.
/// Where it's unknown there's a gap. So is a stretch where more than prices moved: two points that leave out different things, or ETH that arrived with no transaction to show for it.
struct ValueSeries: PlottedSeries {
    struct Line: Identifiable, Equatable {
        let id: Int
        let known: Bool
        let steps: [PnlSeries.Step]
    }

    /// A value the line goes through.
    struct Reading: Equatable {
        let plotted: PnlSeries.Plotted
        let micros: String
        let value: Double
        /// It's what was held just before the transaction, not after it.
        let isBefore: Bool
    }

    let lines: [Line]
    let gaps: [ClosedRange<Date>]
    let plotted: [PnlSeries.Plotted]
    let transactions: PlottedTransactions
    /// Every value drawn, before and after each transaction, in order.
    let readings: [Reading]
    /// The same, for the scale.
    var values: [Double] { readings.map(\.value) }
    /// Known points with no line to or from them, which only a dot can show.
    let isolated: Set<String>

    init(points: [PnlPoint]) {
        let plotted = points.compactMap { point -> PnlSeries.Plotted? in
            point.date.map { PnlSeries.Plotted(point: point, date: $0, value: point.valueMicros.flatMap(Format.chartValue)) }
        }
        var lines: [Line] = []
        var gaps: [ClosedRange<Date>] = []
        var readings: [Reading] = []
        var gapStart: Date?
        var previous: PnlSeries.Plotted?
        for item in plotted {
            guard let after = item.value else {
                if gapStart == nil { gapStart = item.date }
                previous = nil
                continue
            }
            if let start = gapStart {
                gaps.append(start...item.date)
                gapStart = nil
            }
            let before = item.point.valueBeforeMicros.flatMap(Format.chartValue)
            if let previous, let from = previous.value {
                if let before, item.point.valueContinues == true {
                    lines.append(Line(id: lines.count, known: item.point.valueRead == true, steps: [PnlSeries.Step(id: previous.id, date: previous.date, value: from), PnlSeries.Step(id: "\(item.id):before", date: item.date, value: before)]))
                } else {
                    gaps.append(previous.date...item.date)
                }
            }
            if let before, before != after {
                lines.append(Line(id: lines.count, known: true, steps: [PnlSeries.Step(id: "\(item.id):before", date: item.date, value: before), PnlSeries.Step(id: item.id, date: item.date, value: after)]))
            }
            if let before, before != after, let micros = item.point.valueBeforeMicros {
                readings.append(Reading(plotted: item, micros: micros, value: before, isBefore: true))
            }
            if let micros = item.point.valueMicros {
                readings.append(Reading(plotted: item, micros: micros, value: after, isBefore: false))
            }
            previous = item
        }
        if let start = gapStart, let end = plotted.last?.date { gaps.append(start...end) }
        let joined = Set(lines.flatMap { $0.steps.map(\.id) })
        self.lines = lines
        self.gaps = gaps
        self.plotted = plotted
        transactions = PlottedTransactions(plotted)
        self.readings = readings
        isolated = Set(plotted.filter { $0.value != nil && !joined.contains($0.id) }.map(\.id))
    }
}
