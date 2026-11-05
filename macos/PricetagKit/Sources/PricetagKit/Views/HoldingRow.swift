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
        if !position.isHeld { return "None left" }
        if let average = position.values.averageCostMicros { return "Average paid \(Format.estimate(Format.price(average, currency), position.estimates.cost))" }
        return "Cost unknown"
    }

    private var pnlText: String {
        position.pnlMicros.map { Format.estimate(Format.signedMoney($0, currency), position.estimates.realized || position.estimates.unrealized) } ?? Wording.pnlUnavailable
    }

    private var valueText: String {
        if !position.isHeld { return "—" }
        return position.values.valueMicros.map { Format.estimate(Format.money($0, currency), position.estimates.value) } ?? "No price"
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    Text(position.asset).fontWeight(.medium)
                    OnchainCheck(position: position)
                }
                LiveNumber(amount, tone: .secondary)
                    .font(.caption)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 1) {
                LiveNumber(valueText, tone: position.isHeld && position.values.valueMicros == nil ? .secondary : .neutral)
                Text(cost)
                    .monospacedDigit()
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            LiveNumber(pnlText, tone: position.pnlMicros == nil ? .secondary : Tone(signed: position.pnlMicros))
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

/// Says when a position doesn't match the chain or can't be checked, or has a number nobody can work out yet. A row with nothing to flag shows nothing.
public struct OnchainCheck: View {
    let position: Position
    @Environment(\.backgroundProminence) private var prominence

    public init(position: Position) {
        self.position = position
    }

    private var label: String? {
        if let status = position.reconciliation?.status, status != .reconciled { return Wording.checkLabel(status) }
        return position.hasShortfall ? Wording.checkLabel(.incomplete) : nil
    }

    private var help: String {
        Wording.check(position) ?? "More left this wallet than we saw arrive, so its history is incomplete."
    }

    public var body: some View {
        if let label {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.caption2)
                .foregroundStyle(prominence == .increased ? Tone.neutral.style : Tone.warning.style)
                .help(help)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(position.asset): \(label)")
        }
    }
}
