extension Position {
    /// Whether it has every word of `query`, in its token, its note, or which wallets hold it and what they're called.
    public func matches(_ query: String, names: [String: String] = [:]) -> Bool {
        let parts = (wallets ?? []).flatMap { [$0.wallet, names[$0.wallet.lowercased()]] }
        let text = ([asset, note] + parts).compactMap(\.self).joined(separator: "\n").lowercased()
        return query.lowercased().split(whereSeparator: \.isWhitespace).allSatisfy(text.contains)
    }
}
