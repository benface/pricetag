import Foundation

/// What an address field makes of what's in it. A saved wallet is only a quicker way to fill one in, so nothing here says whose an address is.
public enum AddressInput: Equatable, Sendable {
    case empty
    /// A name, or anything else that isn't trying to be an address yet.
    case searching
    /// On its way to being an address, with this many of its 40 characters.
    case typing(digits: Int)
    case address
    case problem(String)

    /// `read` finds the one address in the text, or says there isn't one. A place that moves money is pickier about that than one that only looks.
    /// Nothing's wrong with a half-typed address until the user says it's finished, by pressing Return.
    /// With `takesSeveral`, more than one entry is fine, and what's left of them after the good ones are taken is a problem as a group.
    public init(text: String, isSubmitted: Bool = false, hasMatches: Bool = false, takesSeveral: Bool = false, read: (String) -> String? = WalletAddress.pasted(in:)) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let entries = Self.entries(in: text)
        if text.isEmpty {
            self = .empty
        } else if takesSeveral, !hasMatches, entries.count > 1, isSubmitted || entries.contains(where: { $0.hasPrefix("0x") }) {
            self = .problem(Wording.notAllAddresses)
        } else if read(text) != nil {
            self = .address
        } else if WalletAddress.isValid(text) {
            self = .problem(Wording.addressHasATypo)
        } else if text.wholeMatch(of: /0x[0-9a-fA-F]+(…|\.{2,3})[0-9a-fA-F]*/) != nil {
            self = .problem(Wording.addressIsShortened)
        } else if !WalletAddress.all(in: text).isEmpty {
            self = .problem(Wording.addressWithExtras)
        } else if hasMatches {
            self = .searching
        } else if WalletAddress.isTooLong(text) {
            self = .problem(Wording.notAnAddress)
        } else if text == "0" || text.wholeMatch(of: /0x[0-9a-fA-F]*/) != nil {
            self = isSubmitted ? .problem(Wording.notAnAddress) : .typing(digits: max(text.count - 2, 0))
        } else if text.hasPrefix("0x") || isSubmitted {
            self = .problem(Wording.notAnAddress)
        } else {
            self = .searching
        }
    }

    /// Sorts a paste of several wallets one entry at a time, so that nothing around the good ones goes missing with them.
    /// Nil unless there's more than one entry and at least one is an address: it's still a name being typed, or nothing that can be added yet.
    public static func sort(_ text: String, read: (String) -> String?) -> (addresses: [String], rest: String)? {
        let entries = entries(in: text)
        let addresses = entries.compactMap(read)
        guard entries.count > 1, !addresses.isEmpty else { return nil }
        return (addresses, entries.filter { read($0) == nil }.joined(separator: " "))
    }

    private static func entries(in text: String) -> [String] {
        text.split(whereSeparator: { $0.isWhitespace || $0 == "," }).map(String.init)
    }

    /// The wallets to offer for what's typed: all of them until there's something to go on, and none once it's a whole address.
    public static func suggestions(for text: String, in wallets: [WalletEntry]) -> [WalletEntry] {
        let query = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if query.isEmpty { return wallets }
        if !WalletAddress.all(in: query).isEmpty { return [] }
        return wallets.filter { wallet in
            [wallet.name, wallet.kind.label, wallet.address, wallet.shortAddress].compactMap(\.self).contains { $0.lowercased().contains(query) }
        }
    }
}
