import Foundation

/// Base's block explorer, where anyone can check what a transaction or an address did.
public enum Basescan {
    /// nil for what isn't a transaction's hash, so a menu never offers a page that doesn't exist.
    public static func transaction(_ hash: String) -> URL? {
        guard hash.wholeMatch(of: /0x[0-9a-fA-F]{64}/) != nil else { return nil }
        return URL(string: "https://basescan.org/tx/\(hash)")
    }

    public static func address(_ address: String) -> URL? {
        guard WalletAddress.isValid(address) else { return nil }
        return URL(string: "https://basescan.org/address/\(address)")
    }
}
