/// Addresses made to look like one someone already uses. A scammer sends a little from an address that starts and ends like a real one,
/// hoping it gets copied from the history later, because most screens only show the ends. Everything here stays on this device.
public enum Lookalike {
    /// How many characters at each end have to match. A real address matches another this well about once in 17 million pairs.
    public static let matchingEnds = 3

    /// The first of `known` that starts and ends like `address` without being it, in the order given, so the best-named comes first.
    public static func match(for address: String, among known: [String]) -> String? {
        let digits = hex(address)
        guard digits.count == 40 else { return nil }
        return known.first { other in
            let otherDigits = hex(other)
            return otherDigits.count == 40 && otherDigits != digits
                && otherDigits.prefix(matchingEnds) == digits.prefix(matchingEnds)
                && otherDigits.suffix(matchingEnds) == digits.suffix(matchingEnds)
        }
    }

    /// Which characters of `address` aren't the same in `other`, counting from the start of the text, `0x` included, so a view can mark them.
    public static func differences(between address: String, and other: String) -> Set<Int> {
        let a = Array(address.lowercased())
        let b = Array(other.lowercased())
        return Set(a.indices.filter { $0 >= b.count || a[$0] != b[$0] })
    }

    private static func hex(_ address: String) -> String {
        let lower = address.lowercased()
        return lower.hasPrefix("0x") ? String(lower.dropFirst(2)) : lower
    }
}
