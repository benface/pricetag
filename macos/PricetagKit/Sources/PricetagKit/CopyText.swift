extension Position {
    /// A holding as ⌘C copies it: what it is, how much, what it's worth and what it made, as the row shows them.
    /// Tabs between them, so it pastes into a spreadsheet as cells and into a message as one line.
    public func copyText(currency: CurrencyCode) -> String {
        let value = isHeld ? values.valueMicros.map { Format.estimate(Format.money($0, currency), estimates.value) } ?? Wording.noPrice : "—"
        let pnl = pnlMicros.map { Format.estimate(Format.signedMoney($0, currency), estimates.realized || estimates.unrealized) } ?? Wording.pnlUnavailable
        return [asset, Format.amount(values.qty, decimals: decimals), value, pnl].joined(separator: "\t")
    }
}
