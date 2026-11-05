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

    private var isEstimate: Bool { isPositive(portfolio.totals.estimatedMicros) }

    /// nil when there's no number to show, and that says so instead of showing $0.
    private var pnl: String? {
        portfolio.pnlStatus == .unavailable ? nil : portfolio.totals.pnlMicros
    }

    private var value: String? {
        portfolio.totals.valueMicros.map { Format.estimate(Format.money($0, portfolio.currency), portfolio.totals.estimated.value) }
    }

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
                big(pnl.map { Format.estimate(Format.signedMoney($0, portfolio.currency), isEstimate) }, size: size * 0.62, tone: isLive ? Tone(signed: pnl) : .neutral)
            }
            .buttonStyle(NumberButtonStyle())
            .accessibilityLabel("Total PnL, \(pnl.map { Format.estimate(Format.signedMoney($0, portfolio.currency), isEstimate) } ?? Wording.pnlUnavailable)\(portfolio.pnlStatus == .partial ? ", partial" : "")")
            .accessibilityHint("Shows the activity behind this number")
        }
    }

    private func statLabel(_ text: String, isPartial: Bool) -> some View {
        HStack(spacing: 4) {
            Text(text)
            if isPartial { Text("partial").foregroundStyle(.tertiary) }
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

/// How much of the total is unknown or estimated, and a way to answer what can be answered.
public struct PnlCaveat: View {
    let portfolio: Portfolio
    let onResolve: () -> Void

    public init(portfolio: Portfolio, onResolve: @escaping () -> Void) {
        self.portfolio = portfolio
        self.onResolve = onResolve
    }

    public var body: some View {
        HStack(spacing: 8) {
            if let caveat = Wording.headlineCaveat(portfolio.totals, portfolio.currency) {
                Text(caveat).font(.callout.weight(.medium)).foregroundStyle(Tone.warning.style).monospacedDigit()
            }
            if !portfolio.questions.isEmpty {
                Button("Resolve \(portfolio.questions.count)", action: onResolve)
                    .controlSize(.small)
                    .help("Answer what the app can't work out by itself")
            }
        }
    }
}

public struct PnlCaveats: View {
    let portfolio: Portfolio

    public init(portfolio: Portfolio) {
        self.portfolio = portfolio
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let excluded = Wording.excluded(portfolio.totals.excluded) {
                WarningText(excluded)
            } else if portfolio.pnlStatus == .complete {
                Text("Nothing excluded.").foregroundStyle(.secondary)
            }
            if portfolio.totals.unpricedGas {
                WarningText(Wording.unpricedFees)
            }
            if !portfolio.gasUnknownTxs.isEmpty {
                WarningText(Wording.feesUnknown(portfolio.gasUnknownTxs.count))
            }
            if !portfolio.l1FeeUnknownTxs.isEmpty {
                WarningText(Wording.networkFeeUnknown(portfolio.l1FeeUnknownTxs.count)).help(Wording.pnlHelp)
            }
            ForEach(portfolio.withheld, id: \.self) { withheld in
                WarningText(Wording.withheld(wallet: withheld.wallet, asset: withheld.asset))
            }
            ForEach(Wording.missingRates(portfolio), id: \.self) { line in
                WarningText(line)
            }
        }
        .font(.caption)
        .fixedSize(horizontal: false, vertical: true)
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
                    Text("partial").foregroundStyle(.tertiary)
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
}
