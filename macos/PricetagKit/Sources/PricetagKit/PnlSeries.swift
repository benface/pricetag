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

    init(points: [PnlPoint]) {
        let plotted = points.compactMap { point -> Plotted? in
            point.date.map { Plotted(point: point, date: $0, value: point.pnlUsdMicros.map(Format.chartValue)) }
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
    }

    /// The transaction nearest to a date, known or not, so a click on a gap still opens its legs.
    func nearestTransaction(to date: Date) -> Plotted? {
        plotted.filter { $0.point.txHash != nil }.min { abs($0.date.timeIntervalSince(date)) < abs($1.date.timeIntervalSince(date)) }
    }
}
