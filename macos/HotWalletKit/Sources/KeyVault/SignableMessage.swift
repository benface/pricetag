import Foundation

/// A message a site can ask to have signed. There's deliberately no case for a bare hash: every digest here starts with 0x19,
/// which can't begin a transaction's payload, so nothing signed through this can ever spend as a transaction.
public enum SignableMessage: Equatable, Sendable {
    /// EIP-191, `personal_sign`.
    case personal([UInt8])
    /// EIP-712, once its domain and message have been hashed.
    case typedData(domainSeparator: [UInt8], structHash: [UInt8])

    var digest: [UInt8]? {
        switch self {
        case .personal(let bytes):
            keccak256(Array("\u{19}Ethereum Signed Message:\n\(bytes.count)".utf8) + bytes)
        case .typedData(let domainSeparator, let structHash):
            domainSeparator.count == 32 && structHash.count == 32 ? keccak256([0x19, 0x01] + domainSeparator + structHash) : nil
        }
    }
}

public struct MessageSignature: Equatable, Sendable {
    public let r: [UInt8]
    public let s: [UInt8]
    /// 27 or 28, which is what `personal_sign` and `eth_signTypedData_v4` return.
    public let v: UInt8

    public var hex: String { "0x" + Hex.encode(r + s + [v]) }
}
