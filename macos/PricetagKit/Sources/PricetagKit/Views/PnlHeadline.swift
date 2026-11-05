import SwiftUI

/// The top of a wallet: what it's worth, then how it's done, then the sums behind that. An investor comes to see what they have,
/// and a tiny loss on a new wallet shouldn't be the biggest thing on screen. It wraps when there's no room for one line.
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
            statLabel("Value · \(portfolio.currency.rawValue)", isPartial: value != nil && portfolio.totals.coverage.value.isPartial)
            Button { onOpen(.value) } label: {
                big(value, size: size, tone: .neutral)
            }
            .buttonStyle(NumberButtonStyle())
            .accessibilityLabel("Value, \(value ?? "unavailable")")
            .accessibilityHint("Shows the activity behind this number")
        }
    }

    private var pnlStat: some View {
        VStack(alignment: .leading, spacing: 2) {
            statLabel("Total PnL", isPartial: portfolio.pnlStatus == .partial)
                .help(Wording.pnlHelp)
            Button { onOpen(.pnl) } label: {
                big(pnl, size: size * 0.62, tone: isLive ? portfolio.totalPnlTone : .neutral)
            }
            .buttonStyle(NumberButtonStyle())
            .accessibilityLabel("Total PnL, \(pnl ?? Wording.pnlUnavailable)\(portfolio.pnlStatus == .partial ? ", partial" : "")")
            .accessibilityHint("Shows the activity behind this number")
        }
    }

    private func statLabel(_ text: String, isPartial: Bool) -> some View {
        HStack(spacing: 4) {
            Text(text)
            // As readable as what it qualifies, because it changes what the number means.
            if isPartial { Text("partial").fontWeight(.medium) }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    /// One line whatever it says: a big number shrinks to fit instead of pushing everything down. What's unknown stays a word, never $0.
    private func big(_ text: String?, size: CGFloat, tone: Tone) -> some View {
        Group {
            if let text {
                LiveNumber(text, tone: tone)
                    .font(.system(size: size, weight: .semibold))
            } else {
                Text("Unavailable")
                    .font(.system(size: max(size * 0.62, 17), weight: .semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .lineLimit(1)
        .minimumScaleFactor(0.5)
        .opacity(isLive ? 1 : 0.55)
        .animation(.easeOut(duration: 0.15), value: isLive)
    }
}

/// Everything the numbers above leave out, said once, right under them, with what to do about it.
/// Calm on purpose: it's usually a fact to know rather than something wrong, and a warning that never stops shouting stops being read.
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
            HStack(alignment: .center, spacing: 12) {
                message(attention)
                    .frame(maxWidth: .infinity, alignment: .leading)
                action
                    .fixedSize()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        } else if portfolio.pnlStatus == .complete {
            Text("Nothing excluded.").font(.caption).foregroundStyle(.secondary)
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
                .help("Answer what the app can't work out by itself (⇧⌘R)")
        } else {
            Button("See Why") { onOpen(portfolio.attentionTarget) }
                .controlSize(.small)
        }
    }
}

/// One of the sums beside the total. It says when it's partial, and shows no number when nothing's known.
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
            HStack(spacing: 4) {
                Text(label).foregroundStyle(.secondary).help(help ?? "")
                if text != nil, coverage?.isPartial == true {
                    Text("partial").foregroundStyle(.secondary).fontWeight(.medium)
                }
            }
            .font(.caption)
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
                .animation(.easeOut(duration: 0.15), value: isLive)
            }
            .buttonStyle(NumberButtonStyle())
            .accessibilityLabel("\(label), \(text ?? "unavailable")\(text != nil && coverage?.isPartial == true ? ", partial" : "")")
        }
    }
}

extension Portfolio {
    /// nil when there's no number to show, and that says so instead of showing $0.
    public var totalValueText: String? {
        totals.valueMicros.map { Format.estimate(Format.money($0, currency), totals.estimated.value) }
    }

    /// nil when there's no number to show, and that says so instead of showing $0.
    public var totalPnlText: String? {
        guard pnlStatus != .unavailable else { return nil }
        return totals.pnlMicros.map { Format.estimate(Format.signedMoney($0, currency), isPositive(totals.estimatedMicros)) }
    }

    public var totalPnlTone: Tone {
        Tone(signed: pnlStatus == .unavailable ? nil : totals.pnlMicros)
    }

    /// `attention` in a few words. The full version belongs in a tooltip beside this, and in the window.
    public var shortAttention: String? {
        guard attention != nil else { return nil }
        return Wording.shortLeavesOut(totals, currency) ?? "Some numbers are incomplete"
    }

    /// The sums beside the headline, in reading order.
    public var totalStats: [(metric: TotalMetric, label: String, help: String?, text: String?, coverage: SumCoverage?)] {
        let money = { Format.money($0, currency) }
        let signed = { Format.signedMoney($0, currency) }
        return [
            (.realized, "Realized", Wording.realizedHelp, totals.realizedMicros.map { Format.estimate(signed($0), totals.estimated.realized) }, totals.coverage.realized),
            (.unrealized, "Unrealized", Wording.unrealizedHelp, totals.unrealizedMicros.map { Format.estimate(signed($0), totals.estimated.unrealized) }, totals.coverage.unrealized),
            (.gas, Wording.networkFees, nil, totals.gasMicros.map(money), SumCoverage(known: 1, missing: totals.unpricedGas ? 1 : 0)),
        ]
    }

    /// What the top of a wallet has to say about its own numbers.
    public struct Attention: Equatable, Sendable {
        public let title: String
        public let details: [String]
    }

    /// nil when the numbers leave out nothing and rest on nothing estimated.
    public var attention: Attention? {
        var lines = [Wording.excluded(totals.excluded)].compactMap(\.self)
        if totals.unpricedGas { lines.append(Wording.unpricedFees) }
        if !gasUnknownTxs.isEmpty { lines.append(Wording.feesUnknown(gasUnknownTxs.count)) }
        if !l1FeeUnknownTxs.isEmpty { lines.append(Wording.networkFeeUnknown(l1FeeUnknownTxs.count)) }
        lines += withheld.map { Wording.withheld(wallet: $0.wallet, asset: $0.asset) }
        lines += Wording.missingRates(self)
        if let title = Wording.leavesOut(totals, currency) { return Attention(title: title, details: lines) }
        guard let first = lines.first else { return nil }
        return Attention(title: first, details: Array(lines.dropFirst()))
    }

    /// Where "See Why" goes: the balance that doesn't match when that's the reason, or else what the total is made of.
    public var attentionTarget: ExplainTarget {
        if let position = listedPositions.first(where: { $0.isIncomplete || $0.hasShortfall || $0.reconciliation?.status == .unchecked }) {
            return .asset(position.asset, .onchain)
        }
        return .total(.pnl)
    }
}
