import Foundation

public enum WalletAddress {
    /// What the server accepts in place of an address, to read its fixtures.
    public static let demo = "demo"
    /// What the server accepts in place of an address, for all of the user's wallets at once. It's never anyone's address.
    public static let allYours = "all"

    public static func isAllYours(_ value: String?) -> Bool {
        value == allYours
    }

    /// Whether the server reads this from its fixtures, which it also does for the fixtures' own addresses.
    public static func isDemo(_ value: String) -> Bool {
        [demo, "0x00000000000000000000000000000000000de300", "0x00000000000000000000000000000000000de301"].contains(value.lowercased())
    }

    public static func isValid(_ value: String) -> Bool {
        value.wholeMatch(of: /0x[0-9a-fA-F]{40}/) != nil
    }

    /// The one address in whatever was pasted, which is often more than the address: `base:0x…`, or a link to an explorer's page.
    /// Nil if there's none, or several to choose between. A transaction hash is longer, so it never counts.
    public static func find(in text: String) -> String? {
        pasted(in: text)?.lowercased()
    }

    /// The same, with its case as it was, because mixed case is a checksum that can still be checked.
    public static func pasted(in text: String) -> String? {
        let found = all(in: text)
        return found.count == 1 ? found.first : nil
    }

    /// Every different address in the text, in the order they came. The same one twice only counts once, whatever its case.
    public static func all(in text: String) -> [String] {
        var seen = Set<String>()
        return text.matches(of: /(?:^|[^0-9a-zA-Z])(0x[0-9a-fA-F]{40})(?=$|[^0-9a-zA-Z])/).map { String($0.output.1) }.filter { seen.insert($0.lowercased()).inserted }
    }

    /// Too long to still be on its way to being an address, so there's no point waiting to say so.
    public static func isTooLong(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).count >= 42 && find(in: text) == nil
    }
}
