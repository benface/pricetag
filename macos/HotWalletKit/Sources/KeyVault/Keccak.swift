import CryptoSwift

/// Ethereum's hash. It isn't SHA3-256, which CryptoKit has: the two differ in padding. It only ever hashes public data.
public func keccak256(_ bytes: [UInt8]) -> [UInt8] {
    SHA3(variant: .keccak256).calculate(for: bytes)
}
