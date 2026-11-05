import Foundation

/// Everything that can be done with a hot wallet's key: make one, sign with it, or destroy it.
/// There's deliberately no way to import one, or to get one out.
public protocol Signer: Sendable {
    func createKey() async throws -> EthereumAddress
    func sign(_ transaction: UnsignedTransaction, from address: EthereumAddress) async throws -> SignedTransaction
    func sign(_ message: SignableMessage, from address: EthereumAddress) async throws -> MessageSignature
    func hasKey(_ address: EthereumAddress) async throws -> Bool
    func deleteKey(_ address: EthereumAddress) async throws
    func addresses() async throws -> [EthereumAddress]
}

public actor KeyVault: Signer {
    public enum Failure: Error, Equatable {
        case noSuchKey
        case secureEnclaveUnavailable
        /// A signature that doesn't recover to the wallet's address, or a blob that opens to another wallet's key.
        case wrongKey
        case notAMessage
    }

    private let store: any SealedKeyStore
    private let wrapper: any KeyWrapper

    public init(store: any SealedKeyStore = KeychainSealedKeyStore()) {
        self.store = store
        self.wrapper = SecureEnclaveWrapper()
    }

    init(store: any SealedKeyStore, wrapper: any KeyWrapper) {
        self.store = store
        self.wrapper = wrapper
    }

    public func createKey() throws -> EthereumAddress {
        let key = SecretBytes(count: 32)
        // A value outside the curve's range comes up about once in 2^128 tries. Any other result here means something's broken.
        for _ in 0..<8 {
            try key.withMutableBytes { try SecureRandom.fill($0) }
            if try Secp256k1.isValidKey(key) { break }
        }
        guard try Secp256k1.isValidKey(key) else { throw Secp256k1.Failure.invalidKey }
        guard let address = try EthereumAddress(uncompressedPublicKey: Secp256k1.publicKey(of: key)) else { throw Secp256k1.Failure.invalidKey }
        // Stored before anyone can fund the address, and opened again, so a key that couldn't be read back never gets used.
        try store.save(wrapper.seal(key, context: address.bytes), for: address)
        do {
            try _ = openKey(for: address)
        } catch {
            try? store.delete(address)
            throw error
        }
        return address
    }

    public func sign(_ transaction: UnsignedTransaction, from address: EthereumAddress) throws -> SignedTransaction {
        let signature = try sign(digest: keccak256(transaction.signingPayload), from: address)
        return SignedTransaction(raw: transaction.signed(yParity: signature.yParity, r: signature.r, s: signature.s))
    }

    public func sign(_ message: SignableMessage, from address: EthereumAddress) throws -> MessageSignature {
        guard let digest = message.digest else { throw Failure.notAMessage }
        let signature = try sign(digest: digest, from: address)
        return MessageSignature(r: signature.r, s: signature.s, v: 27 + signature.yParity)
    }

    private func sign(digest: [UInt8], from address: EthereumAddress) throws -> Secp256k1.RecoverableSignature {
        let signature = try {
            let key = try openKey(for: address)
            return try Secp256k1.sign(digest: digest, with: key)
            // The key's wiped here, as it goes out of scope.
        }()
        // Checked before anything's broadcast. A wrong signature would otherwise spend from someone else's address, or fail.
        guard try EthereumAddress(uncompressedPublicKey: Secp256k1.recover(digest: digest, signature: signature)) == address else { throw Failure.wrongKey }
        return signature
    }

    public func hasKey(_ address: EthereumAddress) throws -> Bool {
        try store.load(address) != nil
    }

    public func deleteKey(_ address: EthereumAddress) throws {
        try store.delete(address)
    }

    public func addresses() throws -> [EthereumAddress] {
        try store.addresses()
    }

    private func openKey(for address: EthereumAddress) throws -> SecretBytes {
        guard let sealed = try store.load(address) else { throw Failure.noSuchKey }
        let key = try wrapper.open(sealed, context: address.bytes)
        guard try EthereumAddress(uncompressedPublicKey: Secp256k1.publicKey(of: key)) == address else { throw Failure.wrongKey }
        return key
    }
}
