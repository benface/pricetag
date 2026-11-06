import Foundation
import Testing
@testable import KeyVault

private let cold = EthereumAddress("0x1234567890123456789012345678901234567890")!

private func transaction(nonce: UInt64 = 0, value: UInt128 = 1, to: EthereumAddress = cold) -> UnsignedTransaction {
    UnsignedTransaction(chainID: 8453, nonce: nonce, maxPriorityFeePerGas: 1_000_000, maxFeePerGas: 100_000_000, gasLimit: 21000, to: to, value: value, data: [])
}

/// Reads a signed transaction's fields back, the way a node would.
private func decodeSignature(_ raw: [UInt8]) throws -> (payloadFields: [[UInt8]], yParity: UInt8, r: [UInt8], s: [UInt8]) {
    #expect(raw[0] == 0x02)
    let fields = try #require(RLPDecoder.topLevelItems(Array(raw.dropFirst())))
    let parity = fields[fields.count - 3].first ?? 0
    return (Array(fields.dropLast(3)), parity, fields[fields.count - 2], fields[fields.count - 1])
}

enum RLPDecoder {
    static func topLevelItems(_ bytes: [UInt8]) -> [[UInt8]]? {
        guard let first = bytes.first, first >= 0xC0 else { return nil }
        var index: Int
        if first <= 0xF7 {
            index = 1
        } else {
            index = 1 + Int(first - 0xF7)
        }
        var items: [[UInt8]] = []
        while index < bytes.count {
            let head = bytes[index]
            switch head {
            case 0..<0x80:
                items.append([head])
                index += 1
            case 0x80...0xB7:
                let count = Int(head - 0x80)
                items.append(Array(bytes[(index + 1)..<(index + 1 + count)]))
                index += 1 + count
            case 0xC0...0xF7:
                let count = Int(head - 0xC0)
                items.append([])
                index += 1 + count
            default:
                return nil
            }
        }
        return items
    }
}

@Suite struct KeyVaultTests {
    private func vault() -> (KeyVault, MemoryStore) {
        let store = MemoryStore()
        return (KeyVault(store: store, wrapper: TestWrapper()), store)
    }

    /// The answer is from viem's `hashMessage`.
    @Test func messagesAreHashedWithTheirPrefix() {
        #expect(SignableMessage.personal(Array("hello".utf8)).digest.map { Hex.encode($0) } == "50b2c43fd39106bafbba0da34fc430e1f91e3c96ea2acee2bc34119f92b37750")
    }

    @Test func aMessageSignsForItsOwnAddress() async throws {
        let (vault, _) = vault()
        let address = try await vault.createKey()
        for message in [SignableMessage.personal(Array("hello".utf8)), .typedData(domainSeparator: [UInt8](repeating: 1, count: 32), structHash: [UInt8](repeating: 2, count: 32))] {
            let signature = try await vault.sign(message, from: address)
            #expect(signature.v == 27 || signature.v == 28)
            #expect(signature.hex.count == 132)
            let recovered = try Secp256k1.recover(digest: try #require(message.digest), signature: .init(r: signature.r, s: signature.s, yParity: signature.v - 27))
            #expect(EthereumAddress(uncompressedPublicKey: recovered) == address)
        }
    }

    /// Every digest a message can make starts from 0x19, so no site can get a transaction signed by calling it a message.
    @Test func aMessageCantBeATransaction() async throws {
        let (vault, _) = vault()
        let address = try await vault.createKey()
        let payload = transaction().signingPayload
        #expect(SignableMessage.personal(payload).digest != keccak256(payload))
        await #expect(throws: KeyVault.Failure.notAMessage) {
            _ = try await vault.sign(.typedData(domainSeparator: [1], structHash: [2]), from: address)
        }
    }

    @Test func createsAKeyThatSignsForItsOwnAddress() async throws {
        let (vault, _) = vault()
        let address = try await vault.createKey()
        let signed = try await vault.sign(transaction(), from: address)
        let (_, parity, r, s) = try decodeSignature(signed.raw)
        let digest = keccak256(transaction().signingPayload)
        let pad: ([UInt8]) -> [UInt8] = { [UInt8](repeating: 0, count: 32 - $0.count) + $0 }
        let recovered = try Secp256k1.recover(digest: digest, signature: .init(r: pad(r), s: pad(s), yParity: parity))
        #expect(EthereumAddress(uncompressedPublicKey: recovered) == address)
    }

    @Test func everyKeyIsDifferent() async throws {
        let (vault, _) = vault()
        var seen = Set<EthereumAddress>()
        for _ in 0..<20 { seen.insert(try await vault.createKey()) }
        #expect(seen.count == 20)
    }

    @Test func whatsStoredIsNotTheKey() async throws {
        let (vault, store) = vault()
        let address = try await vault.createKey()
        let sealed = try #require(try store.load(address))
        // 32 bytes of key plus an AES-GCM tag. It's encrypted, so it opens only through the wrapper.
        #expect(sealed.ciphertext.count == 48)
        #expect(sealed.encapsulatedKey.count == 65)
    }

    @Test func aBlobFromAnotherWalletDoesNotOpen() async throws {
        let store = MemoryStore()
        let vault = KeyVault(store: store, wrapper: TestWrapper())
        let first = try await vault.createKey()
        let second = try await vault.createKey()
        try store.save(try #require(try store.load(first)), for: second)
        await #expect(throws: (any Error).self) { try await vault.sign(transaction(), from: second) }
    }

    @Test func refusesAnAddressItHasNoKeyFor() async throws {
        let (vault, _) = vault()
        await #expect(throws: KeyVault.Failure.noSuchKey) { try await vault.sign(transaction(), from: cold) }
    }

    @Test func aDeletedKeyIsGone() async throws {
        let (vault, _) = vault()
        let address = try await vault.createKey()
        try await vault.deleteKey(address)
        #expect(try await vault.hasKey(address) == false)
        await #expect(throws: KeyVault.Failure.noSuchKey) { try await vault.sign(transaction(), from: address) }
    }

    @Test func signaturesHaveALowS() async throws {
        let (vault, _) = vault()
        let address = try await vault.createKey()
        // Half the curve's order. Above this, a signature is malleable and nodes reject it.
        let halfOrder = Hex.decode("7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0")!
        for nonce in 0..<32 {
            let signed = try await vault.sign(transaction(nonce: UInt64(nonce)), from: address)
            let (_, _, _, s) = try decodeSignature(signed.raw)
            let padded = [UInt8](repeating: 0, count: 32 - s.count) + s
            #expect(padded.lexicographicallyPrecedes(halfOrder))
        }
    }

    @Test func secretBytesCanBeWiped() {
        let secret = SecretBytes(count: 32)
        _ = secret.withMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 7) }
        #expect(secret.withBytes { $0.allSatisfy { $0 == 7 } })
    }
}

@Suite struct EncodingTests {
    @Test func keccakKnownAnswers() {
        #expect(Hex.encode(keccak256([])) == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")
        #expect(Hex.encode(keccak256(Array("transfer(address,uint256)".utf8)).prefix(4)) == "a9059cbb")
    }

    @Test func addressFromThePublicKeyOfTheCurvesGenerator() throws {
        // The curve's generator point, which is public, and its well-known address.
        let x = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
        let y = "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8"
        let address = try #require(EthereumAddress(uncompressedPublicKey: Hex.decode("04" + x + y)!))
        #expect(address.checksummed == "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf")
    }

    @Test(arguments: [
        "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
        "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
        "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
        "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
    ])
    func eip55Vectors(_ text: String) throws {
        #expect(try #require(EthereumAddress(text)).checksummed == text)
    }

    @Test func aChecksumCatchesATypo() {
        #expect(EthereumAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD") == nil)
        #expect(EthereumAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed") != nil, "no checksum to check")
        #expect(EthereumAddress("0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED") != nil, "no checksum to check")
    }

    @Test(arguments: ["", "0x", "5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beae", "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaeg"])
    func rejectsWhatIsntAnAddress(_ text: String) {
        #expect(EthereumAddress(text) == nil)
    }

    @Test func rlpVectors() {
        // From the Ethereum wiki's RLP page.
        #expect(RLP.bytes(Array("dog".utf8)).encoded == [0x83] + Array("dog".utf8))
        #expect(RLP.list([.bytes(Array("cat".utf8)), .bytes(Array("dog".utf8))]).encoded == [0xC8, 0x83] + Array("cat".utf8) + [0x83] + Array("dog".utf8))
        #expect(RLP.bytes([]).encoded == [0x80])
        #expect(RLP.list([]).encoded == [0xC0])
        #expect(RLP.quantity(0).encoded == [0x80])
        #expect(RLP.quantity(15).encoded == [0x0F])
        #expect(RLP.quantity(1024).encoded == [0x82, 0x04, 0x00])
        let long = Array("Lorem ipsum dolor sit amet, consectetur adipisicing elit".utf8)
        #expect(RLP.bytes(long).encoded == [0xB8, 0x38] + long)
    }

    @Test func eip1559PayloadMatchesCast() {
        // 0x02 and what `cast to-rlp` gives for these fields.
        let tx = UnsignedTransaction(
            chainID: 8453, nonce: 7, maxPriorityFeePerGas: 1_000_000, maxFeePerGas: 100_000_000, gasLimit: 65000,
            to: EthereumAddress("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913")!, value: 0,
            data: Hex.decode("a9059cbb00000000000000000000000012345678901234567890123456789012345678900000000000000000000000000000000000000000000000000000000000000064")!
        )
        #expect(Hex.encode(tx.signingPayload) == "02f86d82210507830f42408405f5e10082fde894833589fcd6edb6e08f4c7c32d4f71b54bda0291380b844a9059cbb00000000000000000000000012345678901234567890123456789012345678900000000000000000000000000000000000000000000000000000000000000064c0")
    }
}
