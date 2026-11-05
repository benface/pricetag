import SwiftUI

/// This wallet next to simply holding ETH, in a line. Calm on purpose: no colors for ahead or behind, and it asks nothing of anyone.
/// Clicking it shows the numbers and how they're worked out.
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

    public var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 10) {
                Text(Wording.holdTitle)
                Spacer(minLength: 8)
                Text(Wording.holdSummary(comparison, currency))
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .multilineTextAlignment(.trailing)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .font(.callout)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity)
            .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .stale(!isLive)
        // The fine print, a hover or a click away.
        .help([Wording.holdCaveat(comparison, currency), comparison.status == .unavailable ? nil : Wording.holdPast].compactMap(\.self).joined(separator: " "))
        .accessibilityHint("Shows how this is worked out")
    }
}
