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

    private var isAvailable: Bool { portfolio.pnlStatus != .unavailable }

    public var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Total PnL").font(.caption).foregroundStyle(.secondary)
            Button(action: onOpen) {
                Group {
                    if isAvailable {
                        LiveNumber(Format.signedUSD(portfolio.totals.pnlUsdMicros), tone: isLive ? Tone(signed: portfolio.totals.pnlUsdMicros) : .neutral)
                    } else {
                        WarningText(Wording.pnlUnavailable)
                    }
                }
                .font(.system(size: size, weight: .semibold, design: .rounded))
                .opacity(isLive ? 1 : 0.55)
            }
            .buttonStyle(NumberButtonStyle())
            .accessibilityLabel("Total PnL, \(isAvailable ? Format.signedUSD(portfolio.totals.pnlUsdMicros) : Wording.pnlUnavailable)")
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
        }
        .font(.caption)
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// One of the sums beside the total. It says when it's partial, and shows no number when nothing's known.
public struct TotalStat: View {
    let label: String
    let text: String
    let coverage: SumCoverage?
    let isLive: Bool
    let onOpen: () -> Void

    public init(label: String, text: String, coverage: SumCoverage? = nil, isLive: Bool, onOpen: @escaping () -> Void) {
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
                if coverage?.isPartial == true {
                    Text("partial").foregroundStyle(Tone.warning.style)
                }
            }
            .font(.caption)
            Button(action: onOpen) {
                Group {
                    if coverage?.nothingKnown == true {
                        WarningText("Unavailable")
                    } else {
                        LiveNumber(text)
                    }
                }
                .font(.body.weight(.medium))
                .lineLimit(1)
                .opacity(isLive ? 1 : 0.55)
            }
            .buttonStyle(NumberButtonStyle())
            .accessibilityLabel("\(label), \(coverage?.nothingKnown == true ? "unavailable" : text)\(coverage?.isPartial == true ? ", partial" : "")")
        }
    }
}

extension Portfolio {
    /// The four sums beside the total, in reading order.
    public var totalStats: [(metric: TotalMetric, label: String, text: String, coverage: SumCoverage?)] {
        [
            (.value, "Value", Format.usd(totals.valueUsdMicros), totals.coverage.value),
            (.realized, "Realized", Format.signedUSD(totals.realizedUsdMicros), totals.coverage.realized),
            (.unrealized, "Unrealized", Format.signedUSD(totals.unrealizedUsdMicros), totals.coverage.unrealized),
            (.gas, "Gas paid", Format.usd(totals.gasUsdMicros), nil),
        ]
    }
}
