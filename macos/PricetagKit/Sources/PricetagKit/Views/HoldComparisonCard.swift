import SwiftUI

/// This wallet next to simply holding ETH. Calm on purpose: no colors for ahead or behind, and it asks nothing of anyone.
/// Clicking it says how it's worked out.
public struct HoldComparisonCard: View {
    let comparison: HoldComparison
    let currency: CurrencyCode
    let isLive: Bool
    let onOpen: () -> Void

    public init(comparison: HoldComparison, currency: CurrencyCode, isLive: Bool, onOpen: @escaping () -> Void) {
        self.comparison = comparison
        self.currency = currency
        self.isLive = isLive
        self.onOpen = onOpen
    }

    private func signed(_ micros: String?, estimated: Bool) -> String? {
        micros.map { Format.estimate(Format.signedMoney($0, currency), estimated) }
    }

    private var isPartial: Bool { comparison.status == .partial }

    public var body: some View {
        Button(action: onOpen) {
            if comparison.status == .unavailable {
                unavailable
            } else {
                comparing
            }
        }
        .buttonStyle(NumberButtonStyle())
        .frame(maxWidth: .infinity, alignment: .leading)
        .opacity(isLive ? 1 : 0.55)
        .animation(.easeOut(duration: 0.15), value: isLive)
        .accessibilityHint("Shows how this is worked out")
    }

    /// One quiet line, because there's nothing to compare yet. It doesn't take a band of the window to say so.
    private var unavailable: some View {
        (Text(Wording.holdTitle).fontWeight(.medium) + Text(". ") + Text(Wording.holdCaveat(comparison, currency) ?? ""))
            .font(.caption)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var comparing: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 24) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(Wording.holdTitle).font(.callout.weight(.medium))
                    Text([comparison.differenceMicros.map { Wording.holdDifference($0, currency, estimated: comparison.walletEstimated || comparison.estimated) }, Wording.holdPast].compactMap(\.self).joined(separator: " "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                column(Wording.holdWallet, text: signed(comparison.walletMicros, estimated: comparison.walletEstimated), isPartial: comparison.walletLeavesOut)
                column(Wording.holdEth, text: signed(comparison.holdMicros, estimated: comparison.estimated), isPartial: isPartial)
            }
            if let caveat = Wording.holdCaveat(comparison, currency) {
                Text(caveat)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func column(_ label: String, text: String?, isPartial: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Text(label).foregroundStyle(.secondary)
                if text != nil, isPartial {
                    Text("partial").foregroundStyle(.tertiary)
                }
            }
            .font(.caption)
            .fixedSize()
            Group {
                if let text {
                    LiveNumber(text)
                } else {
                    Text("Unavailable").foregroundStyle(.secondary)
                }
            }
            .font(.body.weight(.medium))
            .lineLimit(1)
        }
    }
}
