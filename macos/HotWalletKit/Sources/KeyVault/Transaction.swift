import Foundation

enum RLP {
    case bytes([UInt8])
    case list([RLP])

    static func quantity(_ value: UInt128) -> RLP {
        .bytes(bigEndian(value))
    }

    var encoded: [UInt8] {
        switch self {
        case .bytes(let bytes):
            if bytes.count == 1, bytes[0] < 0x80 { return bytes }
            return Self.header(0x80, count: bytes.count) + bytes
        case .list(let items):
            let body = items.flatMap(\.encoded)
            return Self.header(0xC0, count: body.count) + body
        }
    }

    private static func header(_ offset: UInt8, count: Int) -> [UInt8] {
        if count < 56 { return [offset + UInt8(count)] }
        let length = bigEndian(UInt128(count))
        return [offset + 55 + UInt8(length.count)] + length
    }
}

/// The minimal big-endian bytes of a number, which RLP needs: zero is no bytes at all.
func bigEndian(_ value: UInt128) -> [UInt8] {
    var bytes: [UInt8] = []
    var rest = value
    while rest > 0 {
        bytes.insert(UInt8(truncatingIfNeeded: rest), at: 0)
        rest >>= 8
    }
    return bytes
}

/// An EIP-1559 transaction. Nothing here chooses the chain: `chainID` is in what's signed, so a signature can't be replayed elsewhere.
public struct UnsignedTransaction: Equatable, Sendable {
    public let chainID: UInt64
    public let nonce: UInt64
    public let maxPriorityFeePerGas: UInt128
    public let maxFeePerGas: UInt128
    public let gasLimit: UInt64
    public let to: EthereumAddress
    public let value: UInt128
    public let data: [UInt8]

    public init(chainID: UInt64, nonce: UInt64, maxPriorityFeePerGas: UInt128, maxFeePerGas: UInt128, gasLimit: UInt64, to: EthereumAddress, value: UInt128, data: [UInt8]) {
        self.chainID = chainID
        self.nonce = nonce
        self.maxPriorityFeePerGas = maxPriorityFeePerGas
        self.maxFeePerGas = maxFeePerGas
        self.gasLimit = gasLimit
        self.to = to
        self.value = value
        self.data = data
    }

    private var fields: [RLP] {
        [
            .quantity(UInt128(chainID)),
            .quantity(UInt128(nonce)),
            .quantity(maxPriorityFeePerGas),
            .quantity(maxFeePerGas),
            .quantity(UInt128(gasLimit)),
            .bytes(to.bytes),
            .quantity(value),
            .bytes(data),
            .list([]),
        ]
    }

    /// What gets hashed and signed. The chain also charges for its size: it's what the L1 data fee is worked out from.
    public var signingPayload: [UInt8] {
        [0x02] + RLP.list(fields).encoded
    }

    func signed(yParity: UInt8, r: [UInt8], s: [UInt8]) -> [UInt8] {
        let trim: ([UInt8]) -> [UInt8] = { Array($0.drop(while: { $0 == 0 })) }
        return [0x02] + RLP.list(fields + [.quantity(UInt128(yParity)), .bytes(trim(r)), .bytes(trim(s))]).encoded
    }
}

public struct SignedTransaction: Equatable, Sendable {
    public let raw: [UInt8]
    public var hash: String { "0x" + Hex.encode(keccak256(raw)) }
    public var rawHex: String { "0x" + Hex.encode(raw) }
}
