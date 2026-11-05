import SwiftUI

/// The total, and what it leaves out, right under it.
public struct PnlHeadline: View {
    let portfolio: Portfolio
    let isLive: Bool
    let size: CGFloat
    let onOpen: () -> Void
    let onResolve: () -> Void

    public init(portfolio: Portfolio, isLive: Bool, size: CGFloat, onOpen: @escaping () -> Void, onResolve: @escaping () -> Void = {}) {
        self.portfolio = portfolio
        self.isLive = isLive
        self.size = size
        self.onOpen = onOpen
        self.onResolve = onResolve
    }

    private var isEstimate: Bool { isPositive(portfolio.totals.estimatedMicros) }

    /// nil when there's no number to show, and that says so instead of showing $0.
    private var pnl: String? {
        portfolio.pnlStatus == .unavailable ? nil : portfolio.totals.pnlMicros
    }

    private func signed(_ micros: String) -> String {
        Format.estimate(Format.signedMoney(micros, portfolio.currency), isEstimate)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Total PnL · \(portfolio.currency.rawValue)").font(.caption).foregroundStyle(.secondary).help(Wording.pnlHelp)
            Button(action: onOpen) {
                Group {
                    if let pnl {
                        LiveNumber(signed(pnl), tone: isLive ? Tone(signed: pnl) : .neutral)
                    } else {
                        WarningText(Wording.pnlUnavailable)
                    }
                }
                .font(.system(size: pnl != nil ? size : size * 0.7, weight: .semibold, design: .rounded))
                // One line whatever it says: a big number shrinks to fit instead of pushing everything down.
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .opacity(isLive ? 1 : 0.55)
                .animation(.easeOut(duration: 0.15), value: isLive)
            }
            .buttonStyle(NumberButtonStyle())
            .accessibilityLabel("Total PnL, \(pnl.map(signed) ?? Wording.pnlUnavailable)")
            .accessibilityHint("Shows the activity behind this number")
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
            PnlCaveats(portfolio: portfolio)
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
                    Text("partial").foregroundStyle(Tone.warning.style)
                }
            }
            .font(.caption)
            Button(action: onOpen) {
                Group {
                    if let text {
                        LiveNumber(text)
                    } else {
                        WarningText("Unavailable")
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
    /// The four sums beside the total, in reading order.
    public var totalStats: [(metric: TotalMetric, label: String, help: String?, text: String?, coverage: SumCoverage?)] {
        let money = { Format.money($0, currency) }
        let signed = { Format.signedMoney($0, currency) }
        return [
            (.value, "Value", nil, totals.valueMicros.map { Format.estimate(money($0), totals.estimated.value) }, totals.coverage.value),
            (.realized, "Realized", Wording.realizedHelp, totals.realizedMicros.map { Format.estimate(signed($0), totals.estimated.realized) }, totals.coverage.realized),
            (.unrealized, "Unrealized", Wording.unrealizedHelp, totals.unrealizedMicros.map { Format.estimate(signed($0), totals.estimated.unrealized) }, totals.coverage.unrealized),
            (.gas, Wording.networkFees, nil, totals.gasMicros.map(money), SumCoverage(known: 1, missing: totals.unpricedGas ? 1 : 0)),
        ]
    }
}
