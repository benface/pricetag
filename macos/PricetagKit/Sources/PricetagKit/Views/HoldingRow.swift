import SwiftUI

/// A position in a compact list: what you hold on the left, what it cost and made on the right.
/// Every line is one line tall whatever it says, so nothing moves when a value changes.
public struct HoldingRow: View {
    let position: Position
    let currency: CurrencyCode
    let isLive: Bool

    public init(position: Position, currency: CurrencyCode, isLive: Bool) {
        self.position = position
        self.currency = currency
        self.isLive = isLive
    }

    private var amount: String {
        Format.amount(position.values.qty, decimals: position.decimals)
    }

    private var cost: String {
        if !position.isHeld { return "Closed" }
        if let average = position.values.averageCostMicros { return "Cost \(Format.price(average, currency))" }
        return "Cost unknown"
    }

    private var pnlText: String {
        position.pnlMicros.map { Format.signedMoney($0, currency) } ?? Wording.pnlUnavailable
    }

    private var valueText: String {
        if !position.isHeld { return "—" }
        return position.values.valueMicros.map { Format.money($0, currency) } ?? "No price"
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    Text(position.asset).fontWeight(.medium)
                    if position.hasShortfall {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.caption2)
                            .foregroundStyle(Tone.warning.style)
                            .help("More left this wallet than we saw arrive, so its history is incomplete.")
                    }
                }
                LiveNumber(amount, tone: .secondary)
                    .font(.caption)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 1) {
                LiveNumber(valueText, tone: position.isHeld && position.values.valueMicros == nil ? .warning : .neutral)
                Text(cost)
                    .monospacedDigit()
                    .font(.caption)
                    .foregroundStyle(position.isHeld && position.hasUnknownCost ? Tone.warning.style : AnyShapeStyle(.secondary))
            }
            LiveNumber(pnlText, tone: Tone(signed: position.pnlMicros))
                .font(position.pnlMicros == nil ? .caption : .body)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .frame(width: 104, alignment: .trailing)
        }
        .lineLimit(1)
        .opacity(isLive ? (position.isHeld ? 1 : 0.6) : 0.55)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
