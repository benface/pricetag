extension Position {
    /// A holding as ⌘C copies it: what it is, how much, its price, what it's worth, what it made and its return, as the row shows them.
    /// Tabs between them, so it pastes into a spreadsheet as cells and into a message as one line.
    public func copyText(currency: CurrencyCode) -> String {
        let priceText = price.map { Format.estimate(Format.price($0.micros, currency), estimates.value) } ?? "No price"
        let value = isHeld ? values.valueMicros.map { Format.estimate(Format.money($0, currency), estimates.value) } ?? "No price" : "—"
        let pnl = pnlMicros.map { Format.estimate(Format.signedMoney($0, currency), estimates.realized || estimates.unrealized) } ?? Wording.pnlUnavailable
        return [asset, Format.amount(values.qty, decimals: decimals), priceText, value, pnl, isHeld ? returnText : "—"].joined(separator: "\t")
    }

    /// Unknown whenever its cost is, and never 0%. With a known cost of nothing, there's no share of it to show.
    public var returnText: String {
        if let returnBps { return Format.estimate(Format.percent(bps: returnBps), estimates.unrealized) }
        if values.costMicros == nil { return Wording.unknown }
        return values.valueMicros == nil ? "No price" : "—"
    }
}
