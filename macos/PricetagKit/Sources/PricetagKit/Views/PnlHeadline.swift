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
        // From one line down to a narrow column, so nothing is ever cut off. Each change moves what wraps, rather than swapping layouts.
        WrappingRow(spacing: 28, lineSpacing: 12) {
            WrappingRow(spacing: 28, lineSpacing: 12, fills: false) {
                valueStat
            } trailing: {
                pnlStat
            }
        } trailing: {
            ViewThatFits(in: .horizontal) {
                sums(HStackLayout(alignment: .lastTextBaseline, spacing: 24))
                sums(VStackLayout(alignment: .leading, spacing: 12))
            }
        }
    }

    private func sums(_ layout: some Layout) -> some View {
        layout {
            ForEach(portfolio.totalStats, id: \.metric) { stat in
                TotalStat(label: stat.label, help: stat.help, text: stat.text, isEstimate: stat.isEstimate, coverage: stat.coverage, isLive: isLive) { onOpen(stat.metric) }
            }
        }
    }

    private var valueStat: some View {
        VStack(alignment: .leading, spacing: 2) {
            statLabel("Value · \(portfolio.currency.rawValue)")
                .help(portfolio.partialValueReason ?? "")
                .updatingMark(.trailing)
                .staleMark(.trailing)
                // The number's own label says all of this.
                .accessibilityHidden(true)
            Button { onOpen(.value) } label: {
                big(value, size: size, tone: .neutral)
            }
            .buttonStyle(NumberButtonStyle())
            .accessibilityLabel(Spoken.number("Value", portfolio.spokenValueText, isPartial: portfolio.isValuePartial, isLive: isLive))
            .accessibilityHint("Shows the activity behind this number")
        }
    }

    private var pnlStat: some View {
        VStack(alignment: .leading, spacing: 2) {
            statLabel("Total PnL")
                .help(Wording.pnlHelp)
                .updatingMark(.trailing)
                .staleMark(.trailing)
                .accessibilityHidden(true)
            Button { onOpen(.pnl) } label: {
                big(pnl, size: size * 0.6, tone: isLive ? portfolio.totalPnlTone : .neutral)
            }
            .buttonStyle(NumberButtonStyle())
            .accessibilityLabel(Spoken.number("Total PnL", portfolio.spokenPnlText, isPartial: portfolio.pnlStatus == .partial, isLive: isLive))
            .accessibilityHint("Shows the activity behind this number")
        }
    }

    private func statLabel(_ text: String) -> some View {
        Text(text)
            .font(.subheadline)
            .secondaryText()
    }

    /// One line whatever it says: a big number shrinks to fit instead of pushing everything down. What's unknown stays a word, never $0.
    private func big(_ text: String?, size: CGFloat, tone: Tone) -> some View {
        Group {
            if let text {
                DisplayNumber(text, size: size, tone: tone)
            } else {
                LiveNumber("Unavailable", tone: .secondary)
                    .font(.display(max(size * 0.6, 17)))
            }
        }
        .lineLimit(1)
        .minimumScaleFactor(0.5)
        .stale(!isLive)
    }
}

/// What the numbers above leave out, once, in a sentence, with what to do about it. The full list is a hover or a click away.
public struct PortfolioAttention: View {
    let portfolio: Portfolio
    let onOpen: (ExplainTarget) -> Void
    let onResolve: () -> Void
    @Environment(\.walletNames) private var walletNames

    public init(portfolio: Portfolio, onOpen: @escaping (ExplainTarget) -> Void, onResolve: @escaping () -> Void) {
        self.portfolio = portfolio
        self.onOpen = onOpen
        self.onResolve = onResolve
    }

    public var body: some View {
        if let attention = portfolio.attention(names: walletNames) {
            WrappingRow(alignment: .center, spacing: 12, lineSpacing: 8) {
                message(attention)
            } trailing: {
                action
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
                        .secondaryText()
                }
            }
            .fixedSize(horizontal: false, vertical: true)
        }
        // One sentence, not a picture and then its words.
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var action: some View {
        if !portfolio.questions.isEmpty {
            Button(Wording.answerQuestions(portfolio.questions.count), action: onResolve)
                .controlSize(.small)
                .fixedSize()
                .help("Say what the app can't work out by itself, so what you paid is known (⇧⌘R)")
        } else {
            Button(Wording.showMissing) { onOpen(portfolio.attentionTarget) }
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
    /// Only read aloud. On screen, the line under the headline says it once.
    let isEstimate: Bool
    let coverage: SumCoverage?
    let isLive: Bool
    let onOpen: () -> Void

    public init(label: String, help: String? = nil, text: String?, isEstimate: Bool = false, coverage: SumCoverage? = nil, isLive: Bool, onOpen: @escaping () -> Void) {
        self.label = label
        self.help = help
        self.text = text
        self.isEstimate = isEstimate
        self.coverage = coverage
        self.isLive = isLive
        self.onOpen = onOpen
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.subheadline)
                .secondaryText()
                .help(help ?? "")
                .accessibilityHidden(true)
            Button(action: onOpen) {
                Group {
                    if let text {
                        LiveNumber(text)
                    } else {
                        LiveNumber("Unavailable", tone: .secondary)
                    }
                }
                .font(.body.weight(.medium))
                .lineLimit(1)
                .stale(!isLive)
            }
            .buttonStyle(NumberButtonStyle())
            .accessibilityLabel(Spoken.number(label, text.map { Format.estimate($0, isEstimate) }, isPartial: coverage?.isPartial == true, isLive: isLive))
            .accessibilityHint(help ?? "")
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

    /// The value read aloud, which says it's an estimate. A number read alone doesn't have the line under it.
    public var spokenValueText: String? {
        totalValueText.map { Format.estimate($0, totals.estimated.value) }
    }

    /// The PnL read aloud, which says it's an estimate. A number read alone doesn't have the line under it.
    public var spokenPnlText: String? {
        totalPnlText.map { Format.estimate($0, isPositive(totals.estimatedMicros)) }
    }

    /// Whether the value leaves out something held, which changes what the number means.
    public var isValuePartial: Bool {
        totalValueText != nil && totals.coverage.value.isPartial
    }

    /// Why the value is partial, for its tooltip, by the same causes the SDK counts. nil when it isn't.
    public var partialValueReason: String? {
        guard isValuePartial else { return nil }
        let gaps = valueGaps
        return Wording.partialValue(noPrice: gaps.noPrice, unread: gaps.unread, unchecked: gaps.unchecked, incompleteHistory: gaps.incompleteHistory)
    }

    /// Why the value is partial, by the same causes the SDK counts. The first two are left out of it. The last two are in it,
    /// as a best estimate, so they're never called left out.
    public var valueGaps: ValueGaps {
        let listed = listedPositions
        return ValueGaps(
            noPrice: listed.filter { $0.isHeld && $0.values.valueMicros == nil }.map(\.asset),
            unread: unreadAssets,
            unchecked: listed.filter { $0.reconciliation?.status == .unchecked && $0.reconciliation?.heldIsCurrent != true }.map(\.asset),
            // Unconfirmed positions already say so, and that's the bigger doubt.
            incompleteHistory: listed.filter { position in position.hasShortfall && position.reconciliation?.status != .unchecked && position.reconciliation?.status != .incomplete }.map(\.asset)
        )
    }

    public struct ValueGaps: Equatable, Sendable {
        public let noPrice: [String]
        public let unread: [String]
        public let unchecked: [String]
        public let incompleteHistory: [String]
    }

    public var totalPnlTone: Tone {
        Tone(signed: pnlStatus == .unavailable ? nil : totals.pnlMicros)
    }

    /// `attention` in a few words. The full version belongs in a tooltip beside this, and in the window.
    /// What's wrong with the value comes first, because the value is the biggest number beside it. Whatever makes the PnL
    /// incomplete comes before an estimate, which only says how sure a number is.
    public var shortAttention: String? {
        guard attention != nil else { return nil }
        if isValuePartial { return Wording.shortValueGaps(valueGaps) }
        if isPositive(totals.unresolvedMicros) { return Wording.shortLeavesOut(totals, currency) }
        if pnlStatus == .partial { return pnlLeftOut.isEmpty ? (leavesOutFees ? Wording.pnlLeavesOutFees : Wording.pnlIncomplete) : Wording.pnlLeavesOut(pnlLeftOut, also: false) }
        return Wording.shortLeavesOut(totals, currency) ?? "Some numbers are incomplete"
    }

    /// Network fees that aren't in the PnL, or are in it for less than they were.
    private var leavesOutFees: Bool {
        totals.unpricedGas || !gasUnknownTxs.isEmpty || !l1FeeUnknownTxs.isEmpty
    }

    /// What a partial PnL leaves out that "has an unknown cost" doesn't already say, when the headline's line says that.
    /// A holding whose history is incomplete is still in it, so it's said with the value, not as left out.
    private var pnlLeftOut: [String] {
        let saysUnknownCost = isPositive(totals.unresolvedMicros)
        return unique(totals.excluded.filter { $0.reason != "incomplete history" && (!saysUnknownCost || $0.reason != "unknown cost") }.map(\.asset))
    }

    private func unique(_ assets: [String]) -> [String] {
        var seen = Set<String>()
        return assets.filter { seen.insert($0).inserted }
    }

    /// The sums beside the headline, in reading order.
    public var totalStats: [(metric: TotalMetric, label: String, help: String?, text: String?, isEstimate: Bool, coverage: SumCoverage?)] {
        let money = { Format.money($0, currency) }
        let signed = { Format.signedMoney($0, currency) }
        return [
            (.realized, "Realized", Wording.realizedHelp, totals.realizedMicros.map(signed), totals.estimated.realized, totals.coverage.realized),
            (.unrealized, "Unrealized", Wording.unrealizedHelp, totals.unrealizedMicros.map(signed), totals.estimated.unrealized, totals.coverage.unrealized),
            (.gas, Wording.networkFees, nil, totals.gasMicros.map(money), false, SumCoverage(known: 1, missing: totals.unpricedGas ? 1 : 0)),
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
    public var attention: Attention? { attention(names: [:]) }

    /// The same, calling each of the user's wallets by its name in `names`, for a total across several of them.
    public func attention(names: [String: String]) -> Attention? {
        let name = { (address: String) in names[address] ?? Format.shortHash(address) }
        // A value that's partial says it of what couldn't be read, with what that means for the value.
        var lines = isValuePartial ? [] : Wording.unreadBalances(unreadAssets).map { [$0] } ?? []
        if totals.unpricedGas { lines.append(Wording.unpricedFees) }
        if !gasUnknownTxs.isEmpty { lines.append(Wording.feesUnknown(gasUnknownTxs.count)) }
        if !l1FeeUnknownTxs.isEmpty { lines.append(Wording.networkFeeUnknown(l1FeeUnknownTxs.count)) }
        lines += withheld.map { Wording.withheld(wallet: $0.wallet, asset: $0.asset, name: name) }
        lines += Wording.missingRates(self)
        // The sentence about estimates only counts what's in the PnL. A value from a market price is an estimate too.
        let estimates = totals.estimated
        if !isPositive(totals.estimatedMicros), estimates.value || estimates.realized || estimates.unrealized { lines.append(Wording.marketEstimates) }
        let excludedList = Wording.excluded(totals.excluded, name: name)
        // What the value is missing or can't vouch for. The list below names exclusions from the PnL, and says nothing about which of them the value still holds.
        let valueLine = isValuePartial ? [Wording.valueGaps(valueGaps)] : []
        if let title = Wording.leavesOut(totals, currency) {
            // That says how much is unknown or estimated, not which totals leave something out, and the numbers above don't say either.
            var omissions: [String] = []
            if pnlStatus == .partial {
                if !pnlLeftOut.isEmpty { omissions.append(Wording.pnlLeavesOut(pnlLeftOut, also: isPositive(totals.unresolvedMicros)) + ".") }
                // The fee lines below say it then.
                else if !isPositive(totals.unresolvedMicros), !leavesOutFees { omissions.append(Wording.pnlIncomplete + ".") }
            }
            return Attention(title: title, details: valueLine + omissions + lines, fullList: excludedList)
        }
        lines = valueLine + lines
        if let excludedList { return Attention(title: excludedList, details: lines, fullList: nil) }
        if lines.isEmpty, pnlStatus == .partial { lines.append(Wording.pnlIncomplete + ".") }
        guard let first = lines.first else { return nil }
        return Attention(title: first, details: Array(lines.dropFirst()), fullList: nil)
    }

    /// Where "Show What's Missing" goes: the balance that doesn't match when that's the reason, or else what the total is made of.
    public var attentionTarget: ExplainTarget {
        if let position = listedPositions.first(where: { $0.isIncomplete || $0.hasShortfall || $0.reconciliation?.status == .unchecked }) {
            return .asset(position.asset, .onchain)
        }
        return .total(.pnl)
    }
}
