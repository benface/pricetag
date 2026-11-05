import SwiftUI

/// The top of a wallet: what it's worth, then how it's done, then the sums behind that. An investor comes to see what they have,
/// and a tiny loss on a new wallet shouldn't be the biggest thing on screen. It wraps when there's no room for one line.
/// What these leave out or estimate is said once, by `PortfolioAttention` right under them, and not on each number.
public struct PortfolioSummary: View {
    let portfolio: Portfolio
    let isLive: Bool
    let size: CGFloat
    let onOpen: (TotalMetric) -> Void

    public init(portfolio: Portfolio, isLive: Bool, size: CGFloat, onOpen: @escaping (TotalMetric) -> Void) {
        self.portfolio = portfolio
        self.isLive = isLive
        self.size = size
        self.onOpen = onOpen
    }

    private var pnl: String? { portfolio.totalPnlText }
    private var value: String? { portfolio.totalValueText }

    public var body: some View {
        // From one line down to a narrow column, so nothing is ever cut off.
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .lastTextBaseline, spacing: 28) {
                headline
                Spacer(minLength: 0)
                sums
            }
            VStack(alignment: .leading, spacing: 12) {
                headline
                sums
            }
            VStack(alignment: .leading, spacing: 12) {
                valueStat
                pnlStat
                sums
            }
            VStack(alignment: .leading, spacing: 12) {
                valueStat
                pnlStat
                ForEach(portfolio.totalStats, id: \.metric) { stat in
                    TotalStat(label: stat.label, help: stat.help, text: stat.text, coverage: stat.coverage, isLive: isLive) { onOpen(stat.metric) }
                }
            }
        }
    }

    private var headline: some View {
        HStack(alignment: .lastTextBaseline, spacing: 28) {
            valueStat
            pnlStat
        }
    }

    private var sums: some View {
        HStack(alignment: .lastTextBaseline, spacing: 24) {
            ForEach(portfolio.totalStats, id: \.metric) { stat in
                TotalStat(label: stat.label, help: stat.help, text: stat.text, coverage: stat.coverage, isLive: isLive) { onOpen(stat.metric) }
            }
        }
    }

    private var valueStat: some View {
        VStack(alignment: .leading, spacing: 2) {
            statLabel("Value · \(portfolio.currency.rawValue)")
                .help(portfolio.partialValueReason ?? "")
                .updatingMark(.trailing)
            Button { onOpen(.value) } label: {
                big(value, size: size, tone: .neutral)
            }
            .buttonStyle(NumberButtonStyle())
            // Read alone, it still says it's incomplete.
            .accessibilityLabel("Value, \(value ?? "unavailable")\(portfolio.isValuePartial ? ", partial" : "")")
            .accessibilityHint("Shows the activity behind this number")
        }
    }

    private var pnlStat: some View {
        VStack(alignment: .leading, spacing: 2) {
            statLabel("Total PnL")
                .help(Wording.pnlHelp)
                .updatingMark(.trailing)
            Button { onOpen(.pnl) } label: {
                big(pnl, size: size * 0.6, tone: isLive ? portfolio.totalPnlTone : .neutral)
            }
            .buttonStyle(NumberButtonStyle())
            .accessibilityLabel("Total PnL, \(pnl ?? Wording.pnlUnavailable)\(portfolio.pnlStatus == .partial ? ", partial" : "")")
            .accessibilityHint("Shows the activity behind this number")
        }
    }

    private func statLabel(_ text: String) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(.secondary)
    }

    /// One line whatever it says: a big number shrinks to fit instead of pushing everything down. What's unknown stays a word, never $0.
    private func big(_ text: String?, size: CGFloat, tone: Tone) -> some View {
        Group {
            if let text {
                DisplayNumber(text, size: size, tone: tone)
            } else {
                Text("Unavailable")
                    .font(.display(max(size * 0.6, 17)))
                    .foregroundStyle(.secondary)
            }
        }
        .lineLimit(1)
        .minimumScaleFactor(0.5)
        .opacity(isLive ? 1 : 0.55)
        .animation(Motion.state, value: isLive)
    }
}

/// What the numbers above leave out, once, in a sentence, with what to do about it. The full list is a hover or a click away.
public struct PortfolioAttention: View {
    let portfolio: Portfolio
    let onOpen: (ExplainTarget) -> Void
    let onResolve: () -> Void

    public init(portfolio: Portfolio, onOpen: @escaping (ExplainTarget) -> Void, onResolve: @escaping () -> Void) {
        self.portfolio = portfolio
        self.onOpen = onOpen
        self.onResolve = onResolve
    }

    public var body: some View {
        if let attention = portfolio.attention {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) {
                    message(attention)
                    Spacer(minLength: 0)
                    action
                }
                VStack(alignment: .leading, spacing: 8) {
                    message(attention)
                    action
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .softBox()
            .help(attention.fullList ?? "")
        }
    }

    private func message(_ attention: Portfolio.Attention) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.callout)
                .foregroundStyle(Tone.warning.style)
                .accessibilityLabel("Warning")
            VStack(alignment: .leading, spacing: 2) {
                Text(attention.title)
                    .font(.callout.weight(.medium))
                    .monospacedDigit()
                ForEach(attention.details, id: \.self) { line in
                    Text(line)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var action: some View {
        if !portfolio.questions.isEmpty {
            Button(Wording.answerQuestions(portfolio.questions.count), action: onResolve)
                .controlSize(.small)
                .fixedSize()
                .help("Answer what the app can't work out by itself (⇧⌘R)")
        } else {
            Button("See Why") { onOpen(portfolio.attentionTarget) }
                .controlSize(.small)
                .fixedSize()
        }
    }
}

/// One of the sums beside the total. It shows no number when nothing's known. What it leaves out is said once, under the headline.
public struct TotalStat: View {
    let label: String
    let help: String?
    /// nil when nothing in the sum is known.
    let text: String?
    let coverage: SumCoverage?
    let isLive: Bool
    let onOpen: () -> Void

    public init(label: String, help: String? = nil, text: String?, coverage: SumCoverage? = nil, isLive: Bool, onOpen: @escaping () -> Void) {
        self.label = label
        self.help = help
        self.text = text
        self.coverage = coverage
        self.isLive = isLive
        self.onOpen = onOpen
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .help(help ?? "")
            Button(action: onOpen) {
                Group {
                    if let text {
                        LiveNumber(text)
                    } else {
                        Text("Unavailable").foregroundStyle(.secondary)
                    }
                }
                .font(.body.weight(.medium))
                .lineLimit(1)
                .opacity(isLive ? 1 : 0.55)
                .animation(Motion.state, value: isLive)
            }
            .buttonStyle(NumberButtonStyle())
            .accessibilityLabel("\(label), \(text ?? "unavailable")\(text != nil && coverage?.isPartial == true ? ", partial" : "")")
        }
    }
}

extension Portfolio {
    /// nil when there's no number to show, and that says so instead of showing $0. What it estimates is in `attention`, which is always beside it.
    public var totalValueText: String? {
        totals.valueMicros.map { Format.money($0, currency) }
    }

    /// nil when there's no number to show, and that says so instead of showing $0. What it leaves out or estimates is in `attention`, which is always beside it.
    public var totalPnlText: String? {
        guard pnlStatus != .unavailable else { return nil }
        return totals.pnlMicros.map { Format.signedMoney($0, currency) }
    }

    /// Whether the value leaves out something held, which changes what the number means.
    public var isValuePartial: Bool {
        totalValueText != nil && totals.coverage.value.isPartial
    }

    /// Why the value is partial, for its tooltip, by the same causes the SDK counts. nil when it isn't.
    public var partialValueReason: String? {
        guard isValuePartial else { return nil }
        let listed = listedPositions
        let unchecked = listed.filter { $0.reconciliation?.status == .unchecked && $0.reconciliation?.heldIsCurrent != true }
        return Wording.partialValue(
            noPrice: listed.filter { $0.isHeld && $0.values.valueMicros == nil }.map(\.asset),
            unread: unreadAssets,
            unchecked: unchecked.map(\.asset),
            // Unconfirmed positions already say so, and that's the bigger doubt.
            incompleteHistory: listed.filter { position in position.hasShortfall && position.reconciliation?.status != .unchecked && position.reconciliation?.status != .incomplete }.map(\.asset)
        )
    }

    public var totalPnlTone: Tone {
        Tone(signed: pnlStatus == .unavailable ? nil : totals.pnlMicros)
    }

    /// `attention` in a few words. The full version belongs in a tooltip beside this, and in the window.
    /// What the value leaves out comes first, because the value is the biggest number beside it. An unknown cost says the PnL
    /// is incomplete, so what else the PnL leaves out only comes before an estimate.
    public var shortAttention: String? {
        guard attention != nil else { return nil }
        if isValuePartial { return Wording.valueLeavesOut(valueLeftOut) }
        if isPositive(totals.unresolvedMicros) { return Wording.shortLeavesOut(totals, currency) }
        if pnlStatus == .partial, !pnlLeftOut.isEmpty { return Wording.pnlLeavesOut(pnlLeftOut, also: false) }
        return Wording.shortLeavesOut(totals, currency) ?? "Some numbers are incomplete"
    }

    /// The holdings a partial value leaves out, as the SDK counts them.
    private var valueLeftOut: [String] {
        let reasons: Set = ["no current price", "incomplete history", "balance couldn't be read", "not checked against its actual balance"]
        return unique(totals.excluded.filter { reasons.contains($0.reason) }.map(\.asset) + unreadAssets)
    }

    /// What a partial PnL leaves out that "has an unknown cost" doesn't already say, when the headline's line says that.
    private var pnlLeftOut: [String] {
        let saysUnknownCost = isPositive(totals.unresolvedMicros)
        return unique(totals.excluded.filter { !saysUnknownCost || $0.reason != "unknown cost" }.map(\.asset))
    }

    private func unique(_ assets: [String]) -> [String] {
        var seen = Set<String>()
        return assets.filter { seen.insert($0).inserted }
    }

    /// The sums beside the headline, in reading order.
    public var totalStats: [(metric: TotalMetric, label: String, help: String?, text: String?, coverage: SumCoverage?)] {
        let money = { Format.money($0, currency) }
        let signed = { Format.signedMoney($0, currency) }
        return [
            (.realized, "Realized", Wording.realizedHelp, totals.realizedMicros.map(signed), totals.coverage.realized),
            (.unrealized, "Unrealized", Wording.unrealizedHelp, totals.unrealizedMicros.map(signed), totals.coverage.unrealized),
            (.gas, Wording.networkFees, nil, totals.gasMicros.map(money), SumCoverage(known: 1, missing: totals.unpricedGas ? 1 : 0)),
        ]
    }

    /// What the top of a wallet has to say about its own numbers.
    public struct Attention: Equatable, Sendable {
        public let title: String
        /// What no row or number below would show.
        public let details: [String]
        /// Exactly what's excluded and why, when the title only says how much. The holdings show which, row by row.
        public let fullList: String?
    }

    /// The one place the headline says it's incomplete or estimated, so it's never nil while any of its numbers is.
    /// nil when the numbers leave out nothing and rest on nothing estimated.
    public var attention: Attention? {
        var lines = Wording.unreadBalances(unreadAssets).map { [$0] } ?? []
        if totals.unpricedGas { lines.append(Wording.unpricedFees) }
        if !gasUnknownTxs.isEmpty { lines.append(Wording.feesUnknown(gasUnknownTxs.count)) }
        if !l1FeeUnknownTxs.isEmpty { lines.append(Wording.networkFeeUnknown(l1FeeUnknownTxs.count)) }
        lines += withheld.map { Wording.withheld(wallet: $0.wallet, asset: $0.asset) }
        lines += Wording.missingRates(self)
        // The sentence about estimates only counts what's in the PnL. A value from a market price is an estimate too.
        let estimates = totals.estimated
        if !isPositive(totals.estimatedMicros), estimates.value || estimates.realized || estimates.unrealized { lines.append(Wording.marketEstimates) }
        let excludedList = Wording.excluded(totals.excluded)
        if let title = Wording.leavesOut(totals, currency) {
            // That says how much is unknown or estimated, not which totals leave something out, and the numbers above don't say either.
            var omissions: [String] = []
            if isValuePartial { omissions.append(Wording.valueLeavesOut(valueLeftOut) + ".") }
            if pnlStatus == .partial, !pnlLeftOut.isEmpty { omissions.append(Wording.pnlLeavesOut(pnlLeftOut, also: isPositive(totals.unresolvedMicros)) + ".") }
            return Attention(title: title, details: omissions + lines, fullList: excludedList)
        }
        // A value with nothing in the list to say why still says so.
        if excludedList == nil, isValuePartial { lines.insert(Wording.valueLeavesOut(valueLeftOut) + ".", at: 0) }
        if let excludedList { return Attention(title: excludedList, details: lines, fullList: nil) }
        guard let first = lines.first else { return nil }
        return Attention(title: first, details: Array(lines.dropFirst()), fullList: nil)
    }

    /// Where "See Why" goes: the balance that doesn't match when that's the reason, or else what the total is made of.
    public var attentionTarget: ExplainTarget {
        if let position = listedPositions.first(where: { $0.isIncomplete || $0.hasShortfall || $0.reconciliation?.status == .unchecked }) {
            return .asset(position.asset, .onchain)
        }
        return .total(.pnl)
    }
}
