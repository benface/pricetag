import SwiftUI

/// This wallet next to simply holding ETH. Calm on purpose: no colors for ahead or behind, and it asks nothing of anyone.
/// Clicking it says how it's worked out.
public struct HoldComparisonCard: View {
    let comparison: HoldComparison
    let currency: CurrencyCode
    let walletEstimated: Bool
    let isLive: Bool
    let onOpen: () -> Void

    public init(comparison: HoldComparison, currency: CurrencyCode, walletEstimated: Bool, isLive: Bool, onOpen: @escaping () -> Void) {
        self.comparison = comparison
        self.currency = currency
        self.walletEstimated = walletEstimated
        self.isLive = isLive
        self.onOpen = onOpen
    }

    private func signed(_ micros: String?, estimated: Bool) -> String? {
        micros.map { Format.estimate(Format.signedMoney($0, currency), estimated) }
    }

    private var isPartial: Bool { comparison.status == .partial }

    public var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 6) {
                Button(action: onOpen) {
                    HStack(alignment: .lastTextBaseline, spacing: 28) {
                        column(Wording.holdWallet, text: signed(comparison.walletMicros, estimated: walletEstimated), isPartial: comparison.walletLeavesOut)
                        column(Wording.holdEth, text: signed(comparison.holdMicros, estimated: comparison.estimated), isPartial: isPartial)
                        if let difference = comparison.differenceMicros {
                            Text(Wording.holdDifference(difference, currency, estimated: walletEstimated || comparison.estimated))
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                        }
                        Spacer(minLength: 0)
                    }
                    .opacity(isLive ? 1 : 0.55)
                    .animation(.easeOut(duration: 0.15), value: isLive)
                }
                .buttonStyle(NumberButtonStyle())
                .accessibilityHint("Shows how this is worked out")
                if let caveat = Wording.holdCaveat(comparison, currency) {
                    WarningText(caveat)
                        .font(.caption)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(4)
            .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            HStack {
                Text("\(Wording.holdTitle) · \(currency.rawValue)")
                Spacer()
                Text(Wording.holdPast)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func column(_ label: String, text: String?, isPartial: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Text(label).foregroundStyle(.secondary)
                if text != nil, isPartial {
                    Text("partial").foregroundStyle(Tone.warning.style)
                }
            }
            .font(.caption)
            Group {
                if let text {
                    LiveNumber(text)
                } else {
                    WarningText("Unavailable")
                }
            }
            .font(.body.weight(.medium))
            .lineLimit(1)
        }
    }
}
