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
    /// What it can't know is said, never left out: an end that's unknown is "unknown", and an amount that leaves something out is "partial".
    static func chartSummary(_ series: PnlSeries, _ currency: CurrencyCode, isLive: Bool) -> String {
        let freshness = isLive ? "" : " Not updating."
        guard let first = series.plotted.first, let last = series.plotted.last else { return "Total PnL over time: nothing to show yet.\(freshness)" }
        let money = { (point: PnlPoint) in
            point.pnlMicros.map { Format.signedMoney($0, currency) + (point.excludedCount > 0 ? " (partial)" : "") } ?? "unknown"
        }
        var sentence = "Total PnL over time, from \(Format.time(first.date)) to \(Format.time(last.date))."
        let known = series.plotted.filter { $0.value != nil }
        if known.isEmpty {
            sentence += " It's unknown for all of it."
        } else {
            sentence += " It went from \(money(first.point)) to \(money(last.point))"
            if known.count > 2, let high = known.max(by: { $0.value! < $1.value! }), let low = known.min(by: { $0.value! < $1.value! }), high.id != low.id {
                sentence += ", with a high of \(money(high.point)) and a low of \(money(low.point))"
            }
            sentence += "."
        }
        let transactions = series.plotted.filter { $0.point.txHash != nil }.count
        sentence += " \(transactions == 1 ? "1 transaction" : "\(transactions) transactions")."
        if !known.isEmpty, !series.gaps.isEmpty { sentence += " Unknown for part of it." }
        if known.contains(where: { $0.point.excludedCount > 0 }) { sentence += " Some of it leaves out what's unknown." }
        return sentence + freshness
    }

    /// One transaction on the chart, for stepping through it.
    static func chartStep(_ plotted: PnlSeries.Plotted, _ currency: CurrencyCode) -> String {
        var parts = [Format.time(plotted.date), plotted.point.pnlMicros.map { Format.signedMoney($0, currency) } ?? "unknown"]
        if let summary = plotted.point.summary { parts.append(summary) }
        if plotted.point.excludedCount > 0 { parts.append("leaves out \(plotted.point.excludedCount) unknown") }
        return parts.joined(separator: ", ")
    }
}
