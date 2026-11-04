import CryptoKit
import Foundation
@testable import KeyVault

/// The tests' stand-in for the Keychain. Nothing like it exists outside the tests.
final class MemoryStore: SealedKeyStore, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [EthereumAddress: SealedKey] = [:]

    func save(_ sealed: SealedKey, for address: EthereumAddress) throws {
        lock.withLock { items[address] = sealed }
    }

    func load(_ address: EthereumAddress) throws -> SealedKey? {
        lock.withLock { items[address] }
    }

    func delete(_ address: EthereumAddress) throws {
        lock.withLock { _ = items.removeValue(forKey: address) }
    }

    func addresses() throws -> [EthereumAddress] {
        lock.withLock { Array(items.keys) }
    }
}

/// HPKE like the real one, to a throwaway key, because `swift test` isn't signed in a way that reaches the Secure Enclave.
/// `pnpm check:keychain` runs the real wrapper and Keychain from a signed build.
struct TestWrapper: KeyWrapper {
    private let key = P256.KeyAgreement.PrivateKey()
    private let suite = HPKE.Ciphersuite.P256_SHA256_AES_GCM_256
    private let info = Data("test".utf8)

    func seal(_ secret: borrowing SecretBytes, context: [UInt8]) throws -> SealedKey {
        var sender = try HPKE.Sender(recipientKey: key.publicKey, ciphersuite: suite, info: info)
        let ciphertext = try secret.withBytes { try sender.seal($0, authenticating: context) }
        return SealedKey(wrappingKey: Data(), encapsulatedKey: sender.encapsulatedKey, ciphertext: ciphertext)
    }

    func open(_ sealed: SealedKey, context: [UInt8]) throws -> SecretBytes {
        var recipient = try HPKE.Recipient(privateKey: key, ciphersuite: suite, info: info, encapsulatedKey: sealed.encapsulatedKey)
        let opened = try recipient.open(sealed.ciphertext, authenticating: context)
        let secret = SecretBytes(count: opened.count)
        secret.withMutableBytes { $0.copyBytes(from: opened) }
        return secret
    }
}
