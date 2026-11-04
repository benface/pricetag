import SwiftUI

/// The total, and what it leaves out, right under it.
public struct PnlHeadline: View {
    let portfolio: Portfolio
    let isLive: Bool
    let size: CGFloat
    let onOpen: () -> Void

    public init(portfolio: Portfolio, isLive: Bool, size: CGFloat, onOpen: @escaping () -> Void) {
        self.portfolio = portfolio
        self.isLive = isLive
        self.size = size
        self.onOpen = onOpen
    }

    /// nil when there's no number to show, and that says so instead of showing $0.
    private var pnl: String? {
        portfolio.pnlStatus == .unavailable ? nil : portfolio.totals.pnlMicros
    }

    private func signed(_ micros: String) -> String {
        Format.signedMoney(micros, portfolio.currency)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Total PnL · \(portfolio.currency.rawValue)").font(.caption).foregroundStyle(.secondary)
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
            .accessibilityHint("Shows the legs behind this number")
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
                WarningText(Wording.unpricedGas)
            }
            if !portfolio.gasUnknownTxs.isEmpty {
                WarningText(Wording.gasUnknown(portfolio.gasUnknownTxs.count))
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
    /// nil when nothing in the sum is known.
    let text: String?
    let coverage: SumCoverage?
    let isLive: Bool
    let onOpen: () -> Void

    public init(label: String, text: String?, coverage: SumCoverage? = nil, isLive: Bool, onOpen: @escaping () -> Void) {
        self.label = label
        self.text = text
        self.coverage = coverage
        self.isLive = isLive
        self.onOpen = onOpen
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Text(label).foregroundStyle(.secondary)
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
    public var totalStats: [(metric: TotalMetric, label: String, text: String?, coverage: SumCoverage?)] {
        let money = { Format.money($0, currency) }
        let signed = { Format.signedMoney($0, currency) }
        return [
            (.value, "Value", totals.valueMicros.map(money), totals.coverage.value),
            (.realized, "Realized", totals.realizedMicros.map(signed), totals.coverage.realized),
            (.unrealized, "Unrealized", totals.unrealizedMicros.map(signed), totals.coverage.unrealized),
            (.gas, "Gas paid", totals.gasMicros.map(money), SumCoverage(known: 1, missing: totals.unpricedGas ? 1 : 0)),
        ]
    }
}
