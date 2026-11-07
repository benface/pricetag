extension Position {
    /// A holding as ⌘C copies it: what it is, how much, its price, what it's worth, what it made and its return, as the row shows them.
    /// Tabs between them, so it pastes into a spreadsheet as cells and into a message as one line.
    public func copyText(currency: CurrencyCode) -> String {
        [asset, Format.amount(values.qty, decimals: decimals), priceText(currency) ?? Wording.noPrice, valueText(currency), pnlText(currency) ?? Wording.pnlUnavailable, isHeld ? returnText : "—"].joined(separator: "\t")
    }

    /// Its price right now, or nil with none.
    public func priceText(_ currency: CurrencyCode) -> String? {
        price.map { Format.estimate(Format.price($0.micros, currency), estimates.value) }
    }

    /// What it's worth, which is nothing to show once it isn't held, and never $0 for lack of a price.
    public func valueText(_ currency: CurrencyCode) -> String {
        guard isHeld else { return "—" }
        return values.valueMicros.map { Format.estimate(Format.money($0, currency), estimates.value) } ?? Wording.noPrice
    }

    /// What it made, or nil when that's not known. What that means depends on where it's said.
    public func pnlText(_ currency: CurrencyCode) -> String? {
        pnlMicros.map { Format.estimate(Format.signedMoney($0, currency), estimates.realized || estimates.unrealized) }
    }

    /// Unknown whenever its cost is, and never 0%. With a known cost of nothing, there's no share of it to show.
    public var returnText: String {
        if let returnBps { return Format.estimate(Format.percent(bps: returnBps), estimates.unrealized) }
        if values.costMicros == nil { return Wording.unknown }
        return values.valueMicros == nil ? Wording.noPrice : "—"
    }
}
