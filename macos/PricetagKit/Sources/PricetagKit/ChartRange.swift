// What the chart shows of a wallet's history. It only offers what history can fill, and it says how far that goes.

import Foundation

public enum ChartRange: String, CaseIterable, Identifiable, Sendable {
    case hour, day, week, month, year, all

    public var id: Self { self }

    public var label: String {
        switch self {
        case .hour: "1H"
        case .day: "1D"
        case .week: "1W"
        case .month: "1M"
        case .year: "1Y"
        case .all: "All"
        }
    }

    /// In a sentence, after the change it covers.
    var phrase: String? {
        switch self {
        case .hour: "in the past hour"
        case .day: "in the past day"
        case .week: "in the past week"
        case .month: "in the past month"
        case .year: "in the past year"
        case .all: nil
        }
    }

    var duration: TimeInterval? {
        switch self {
        case .hour: 3600
        case .day: 86400
        case .week: 7 * 86400
        case .month: 30 * 86400
        case .year: 365 * 86400
        case .all: nil
        }
    }

    /// A range longer than the history would promise a past that isn't there, so All is the most it offers.
    public static func available(historyMs: Int) -> [ChartRange] {
        allCases.filter { range in
            guard let duration = range.duration else { return true }
            return duration * 1000 < Double(historyMs)
        }
    }
}

extension Portfolio {
    var historyMs: Int { BlockTime.msBetween(coverage.fromBlock, coverage.toBlock) }

    public var availableChartRanges: [ChartRange] { ChartRange.available(historyMs: historyMs) }

    /// How far back this goes, in words, for what's beside the chart.
    public var historyLength: String { "About \(Format.duration(ms: historyMs)) of history" }
}

/// The part of the history in a range. PnL holds still between transactions, so what it was when the range starts comes along as its first point.
public struct ChartWindow: Equatable, Sendable {
    public let range: ChartRange
    public let points: [PnlPoint]
    /// There's a known point from before the range began, so its first point really is what PnL was when it started.
    private let startsAtRangeStart: Bool

    public init(points all: [PnlPoint], range: ChartRange) {
        self.range = range
        startsAtRangeStart = Self.hasPointBefore(all, range)
        guard let duration = range.duration, let end = all.last?.date else {
            points = all
            return
        }
        let start = end.addingTimeInterval(-duration)
        let inside = all.filter { ($0.date ?? end) >= start }
        guard let before = all.last(where: { ($0.date ?? end) < start }) else {
            points = inside
            return
        }
        let carried = PnlPoint(blockNum: before.blockNum, timestamp: start.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true)), txHash: nil, pnlMicros: before.pnlMicros, excludedCount: before.excludedCount)
        points = [carried] + inside
    }

    private static func hasPointBefore(_ all: [PnlPoint], _ range: ChartRange) -> Bool {
        guard let duration = range.duration, let end = all.last?.date else { return false }
        let start = end.addingTimeInterval(-duration)
        return all.contains { ($0.date ?? end) < start }
    }

    /// How much PnL moved across the whole range, or nil when that can't honestly be said:
    /// - Either end leaves something out. The same count doesn't mean the same things, and what became measurable in between isn't a gain or a loss.
    /// - Nothing's known from before the range began. The first point is already after its first transaction, and nothing here assumes PnL was zero before it.
    public var changeMicros: String? {
        guard startsAtRangeStart, let first = points.first, let last = points.last, first.excludedCount == 0, last.excludedCount == 0,
              let from = first.pnlMicros.flatMap({ Int128($0) }), let to = last.pnlMicros.flatMap({ Int128($0) }) else { return nil }
        return String(to - from)
    }

    /// "+$12.40 in the past day", or nil when there's no change to state.
    public func changeText(_ currency: CurrencyCode, estimated: Bool) -> String? {
        guard let change = changeMicros, let phrase = range.phrase else { return nil }
        return "\(Format.estimate(Format.signedMoney(change, currency), estimated)) \(phrase)"
    }
}
