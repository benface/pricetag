import Foundation

public struct EthereumAddress: Hashable, Sendable, Codable, CustomStringConvertible {
    public let bytes: [UInt8]

    public static let zero = EthereumAddress(unchecked: [UInt8](repeating: 0, count: 20))

    init(unchecked bytes: [UInt8]) {
        self.bytes = bytes
    }

    /// nil unless it's 0x and 40 hex digits. Mixed case is a checksum, so a typo in one fails here. All lower or upper case has none.
    public init?(_ text: String) {
        guard text.hasPrefix("0x"), text.utf8.count == 42, let bytes = Hex.decode(text), bytes.count == 20 else { return nil }
        self.bytes = bytes
        let digits = text.dropFirst(2)
        let isSingleCase = digits == digits.lowercased() || digits == digits.uppercased()
        guard isSingleCase || checksummed == text else { return nil }
    }

    /// The last 20 bytes of the hash of an uncompressed public key, without its 0x04 prefix.
    public init?(uncompressedPublicKey key: [UInt8]) {
        guard key.count == 65, key[0] == 0x04 else { return nil }
        self.bytes = Array(keccak256(Array(key.dropFirst())).suffix(20))
    }

    public var lowercased: String { "0x" + Hex.encode(bytes) }

    /// EIP-55: each letter is capitalized when the matching digit of the address's hash is 8 or more.
    public var checksummed: String {
        let digits = Hex.encode(bytes)
        let hash = Hex.encode(keccak256(Array(digits.utf8)))
        return "0x" + String(zip(digits, hash).map { digit, hashDigit in
            digit.isLetter && hashDigit.hexDigitValue! >= 8 ? Character(digit.uppercased()) : digit
        })
    }

    public var description: String { checksummed }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(lowercased)
    }

    public init(from decoder: any Decoder) throws {
        let text = try decoder.singleValueContainer().decode(String.self)
        guard let address = EthereumAddress(text) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Not an address"))
        }
        self = address
    }
}
