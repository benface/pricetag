import Foundation

/// What VoiceOver says for what's on screen, where reading it as drawn would be wrong or leave something out.
/// A number always says what it is and what it's worth, then anything that changes what it means: unknown, partial, or not updating.
/// These are only spoken, so they're not in `Wording`, which the web app shares.
public enum Spoken {
    /// What a number on screen says, read aloud. "≈" is "about", since VoiceOver would say "almost equal to", a dash means there's none,
    /// and a dot between amounts is a pause.
    public static func text(_ shown: String) -> String {
        if shown == "—" { return "none" }
        let paused = shown.replacingOccurrences(of: " · ", with: ", ")
        guard paused.hasPrefix("≈") else { return paused }
        return "about " + paused.dropFirst()
    }

    /// A number's whole label. `shown` is nil when nothing is known, which is never read as zero.
    /// `isLive` is false when the numbers on screen have stopped updating, which is what their faded look says.
    public static func number(_ name: String, _ shown: String?, isPartial: Bool = false, isLive: Bool = true) -> String {
        var parts = [name, shown.map(text) ?? "unknown"]
        if shown != nil, isPartial { parts.append("partial") }
        if !isLive { parts.append(notUpdating) }
        return parts.joined(separator: ", ")
    }

    /// What a faded number says.
    public static let notUpdating = "not updating"

    /// An address, one character at a time in groups of four, so it can be checked against another as it's read.
    /// Spoken as a word, an address can sound like one, or like a number.
    public static func address(_ address: String) -> String {
        Format.addressGroups(address).joined(separator: " ")
    }

    /// The chart in a sentence: how long it covers, where it started and ended, and how high and low it went.
    /// What it can't know is said, never left out: an end that's unknown is "unknown", an amount that leaves something out is "partial", and one worked out between prices is "about".
    static func chartSummary(_ series: PnlSeries, _ currency: CurrencyCode, isLive: Bool) -> String {
        let known = series.plotted.filter { $0.value != nil }
        var extremes: (high: String, low: String)?
        if known.count > 2, let high = known.max(by: { $0.value! < $1.value! }), let low = known.min(by: { $0.value! < $1.value! }), high.id != low.id {
            extremes = (chartAmount(high.point.pnlMicros, of: high.point, .pnl, currency), chartAmount(low.point.pnlMicros, of: low.point, .pnl, currency))
        }
        return chartSummary(.pnl, plotted: series.plotted, extremes: extremes, hasGaps: !series.gaps.isEmpty, isEstimated: false, currency, isLive: isLive)
    }

    /// Its high and low are from everything the line goes through, so what was there just before a withdrawal counts.
    static func chartSummary(_ series: ValueSeries, _ currency: CurrencyCode, isLive: Bool) -> String {
        var extremes: (high: String, low: String)?
        if series.readings.count > 2, let high = series.readings.max(by: { $0.value < $1.value }), let low = series.readings.min(by: { $0.value < $1.value }), high.value != low.value {
            extremes = (chartAmount(high.micros, of: high.plotted.point, .value, currency), chartAmount(low.micros, of: low.plotted.point, .value, currency))
        }
        let isEstimated = series.lines.contains { !$0.known } || series.plotted.contains { $0.point.valueEstimated }
        return chartSummary(.value, plotted: series.plotted, extremes: extremes, hasGaps: !series.gaps.isEmpty, isEstimated: isEstimated, currency, isLive: isLive)
    }

    static func chartName(_ metric: ChartMetric) -> String {
        metric == .value ? "Value" : "Total PnL"
    }

    private static func chartSummary(_ metric: ChartMetric, plotted: [PnlSeries.Plotted], extremes: (high: String, low: String)?, hasGaps: Bool, isEstimated: Bool, _ currency: CurrencyCode, isLive: Bool) -> String {
        let freshness = isLive ? "" : " Not updating."
        let name = chartName(metric)
        guard let first = plotted.first, let last = plotted.last else { return "\(name) over time: nothing to show yet.\(freshness)" }
        var sentence = "\(name) over time, from \(Format.time(first.date)) to \(Format.time(last.date))."
        let known = plotted.filter { $0.value != nil }
        if known.isEmpty {
            sentence += " It's unknown for all of it."
        } else {
            let from = chartAmount(metric.micros(first.point), of: first.point, metric, currency)
            let to = chartAmount(metric.micros(last.point), of: last.point, metric, currency)
            sentence += " It went from \(from) to \(to)"
            if let extremes { sentence += ", with a high of \(extremes.high) and a low of \(extremes.low)" }
            sentence += "."
        }
        let transactions = plotted.filter { $0.point.txHash != nil }.count
        sentence += " \(transactions == 1 ? "1 transaction" : "\(transactions) transactions")."
        if !known.isEmpty, hasGaps { sentence += " Unknown for part of it." }
        if !known.isEmpty, isEstimated { sentence += " Estimated where prices weren't read." }
        if known.contains(where: { metric.excludedCount($0.point) > 0 }) { sentence += " Some of it leaves out what's unknown." }
        return sentence + freshness
    }

    /// One transaction on the chart, for stepping through it.
    static func chartStep(_ plotted: PnlSeries.Plotted, _ currency: CurrencyCode, metric: ChartMetric = .pnl) -> String {
        chartStep(plotted, micros: metric.micros(plotted.point), saying: plotted.point.summary, currency, metric: metric)
    }

    /// A place on the Value line, which can be just before a transaction, and so isn't what the transaction did.
    static func chartStep(_ reading: ValueSeries.Reading, _ currency: CurrencyCode) -> String {
        chartStep(reading.plotted, micros: reading.micros, saying: reading.isBefore ? "just before its transaction" : reading.plotted.point.summary, currency, metric: .value)
    }

    private static func chartStep(_ plotted: PnlSeries.Plotted, micros: String?, saying what: String?, _ currency: CurrencyCode, metric: ChartMetric) -> String {
        var parts = [Format.time(plotted.date), micros.map { chartMoney($0, of: plotted.point, metric, currency) } ?? "unknown"]
        if let what { parts.append(what) }
        let excluded = metric.excludedCount(plotted.point)
        if excluded > 0 { parts.append(metric == .value ? "leaves out \(excluded == 1 ? "1 holding" : "\(excluded) holdings")" : "leaves out \(excluded) unknown") }
        return parts.joined(separator: ", ")
    }

    /// One place the line goes, for VoiceOver's own chart tools.
    struct ChartPoint: Equatable {
        let date: Date
        let value: Double
        let label: String
    }

    private static func chartAmount(_ micros: String?, of point: PnlPoint, _ metric: ChartMetric, _ currency: CurrencyCode) -> String {
        micros.map { chartMoney($0, of: point, metric, currency) + (metric.excludedCount(point) > 0 ? " (partial)" : "") } ?? "unknown"
    }

    private static func chartMoney(_ micros: String, of point: PnlPoint, _ metric: ChartMetric, _ currency: CurrencyCode) -> String {
        text(Format.estimate(metric == .value ? Format.money(micros, currency) : Format.signedMoney(micros, currency), metric.isEstimated(point)))
    }
}

extension PnlSeries {
    func spokenPoints(_ currency: CurrencyCode) -> [Spoken.ChartPoint] {
        plotted.compactMap { item in
            item.value.map { Spoken.ChartPoint(date: item.date, value: $0, label: Spoken.chartStep(item, currency)) }
        }
    }
}

extension ValueSeries {
    func spokenPoints(_ currency: CurrencyCode) -> [Spoken.ChartPoint] {
        readings.map { reading in
            Spoken.ChartPoint(date: reading.plotted.date, value: reading.value, label: Spoken.chartStep(reading, currency))
        }
    }
}
