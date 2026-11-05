import SwiftUI

/// A position at a glance, on one line: what it is, what it's worth, and what it's made. What's unknown says so, and never shows $0.
public struct HoldingRow: View {
    let position: Position
    let currency: CurrencyCode
    let isLive: Bool

    public init(position: Position, currency: CurrencyCode, isLive: Bool) {
        self.position = position
        self.currency = currency
        self.isLive = isLive
    }

    private var pnlText: String {
        if let pnl = position.pnlMicros { return Format.estimate(Format.signedMoney(pnl, currency), position.estimates.realized || position.estimates.unrealized) }
        return position.isHeld && position.values.averageCostMicros == nil ? "Cost unknown" : Wording.pnlUnavailable
    }

    private var valueText: String {
        if !position.isHeld { return "—" }
        return position.values.valueMicros.map { Format.estimate(Format.money($0, currency), position.estimates.value) } ?? "No price"
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            HStack(spacing: 4) {
                Text(position.asset).fontWeight(.medium)
                OnchainCheck(position: position)
            }
            Spacer(minLength: 0)
            LiveNumber(valueText, tone: position.isHeld && position.values.valueMicros == nil ? .secondary : .neutral)
            LiveNumber(pnlText, tone: position.pnlMicros == nil ? .secondary : Tone(signed: position.pnlMicros))
                .font(.callout)
                // At least this wide so the columns line up, and wider rather than cutting off a number.
                .frame(minWidth: 88, alignment: .trailing)
                .fixedSize()
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
