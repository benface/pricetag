extension Position {
    /// A holding as ⌘C copies it: what it is, how much, its price, what it's worth, what it made and its return, as the row shows them.
    /// Tabs between them, so it pastes into a spreadsheet as cells and into a message as one line.
    public func copyText(currency: CurrencyCode) -> String {
        let priceText = price.map { Format.estimate(Format.price($0.micros, currency), estimates.value) } ?? Wording.noPrice
        return [asset, Format.amount(values.qty, decimals: decimals), priceText, valueText(currency), pnlText(currency), isHeld ? returnText : "—"].joined(separator: "\t")
    }

    /// What it's worth. Nothing for what's no longer held, and never $0 for what has no price.
    public func valueText(_ currency: CurrencyCode) -> String {
        if !isHeld { return "—" }
        return values.valueMicros.map { Format.estimate(Format.money($0, currency), estimates.value) } ?? Wording.noPrice
    }

    /// What it's made. A cost nobody can work out yet says so, because that's what there is to fix.
    public func pnlText(_ currency: CurrencyCode) -> String {
        if let pnlMicros { return Format.estimate(Format.signedMoney(pnlMicros, currency), estimates.realized || estimates.unrealized) }
        return isHeld && values.averageCostMicros == nil ? "Cost unknown" : Wording.pnlUnavailable
    }

    /// Unknown whenever its cost is, and never 0%. With a known cost of nothing, there's no share of it to show.
    public var returnText: String {
        if let returnBps { return Format.estimate(Format.percent(bps: returnBps), estimates.unrealized) }
        if values.costMicros == nil { return Wording.unknown }
        return values.valueMicros == nil ? Wording.noPrice : "—"
    }
}
