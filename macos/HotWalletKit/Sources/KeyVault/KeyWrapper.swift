// Key material only, so a watch-only build has none of it. See macos/watch-only.sh.
#if !PATINA_WATCH_ONLY
import CryptoKit
import Foundation
import Security

/// A key as it's stored: encrypted, and only something this device can open.
public struct SealedKey: Codable, Equatable, Sendable {
    /// Opaque to everything but the enclave that made it. It's not the wrapping key itself, which never leaves the enclave.
    public let wrappingKey: Data
    public let encapsulatedKey: Data
    public let ciphertext: Data

    public init(wrappingKey: Data, encapsulatedKey: Data, ciphertext: Data) {
        self.wrappingKey = wrappingKey
        self.encapsulatedKey = encapsulatedKey
        self.ciphertext = ciphertext
    }
}

/// Encrypts a key so it can only be read on this device. `context` is authenticated, so a blob can't be swapped for another wallet's.
protocol KeyWrapper: Sendable {
    func seal(_ key: borrowing SecretBytes, context: [UInt8]) throws -> SealedKey
    func open(_ sealed: SealedKey, context: [UInt8]) throws -> SecretBytes
}

/// HPKE (RFC 9180) to a Secure Enclave P-256 key, from CryptoKit, so there's no cryptography of our own here.
/// The enclave can't sign with Ethereum's curve, so it unwraps a key that then signs in memory, and is wiped right after.
struct SecureEnclaveWrapper: KeyWrapper {
    private static let suite = HPKE.Ciphersuite.P256_SHA256_AES_GCM_256
    private static let info = Data("patina.hot-wallet.v1".utf8)

    func seal(_ key: borrowing SecretBytes, context: [UInt8]) throws -> SealedKey {
        var error: Unmanaged<CFError>?
        // No user presence flag: a sweep has to be able to unwrap with nobody there.
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, .privateKeyUsage, &error) else {
            throw error!.takeRetainedValue()
        }
        let enclaveKey = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access)
        var sender = try HPKE.Sender(recipientKey: enclaveKey.publicKey, ciphersuite: Self.suite, info: Self.info)
        let ciphertext = try key.withBytes { try sender.seal($0, authenticating: context) }
        return SealedKey(wrappingKey: enclaveKey.dataRepresentation, encapsulatedKey: sender.encapsulatedKey, ciphertext: ciphertext)
    }

    func open(_ sealed: SealedKey, context: [UInt8]) throws -> SecretBytes {
        let enclaveKey = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: sealed.wrappingKey)
        var recipient = try HPKE.Recipient(privateKey: enclaveKey, ciphersuite: Self.suite, info: Self.info, encapsulatedKey: sealed.encapsulatedKey)
        var opened = try recipient.open(sealed.ciphertext, authenticating: context)
        // Foundation's copy gets wiped too, once the bytes are somewhere that wipes itself.
        defer { opened.withUnsafeMutableBytes { _ = memset_s($0.baseAddress, $0.count, 0, $0.count) } }
        let key = SecretBytes(count: opened.count)
        key.withMutableBytes { $0.copyBytes(from: opened) }
        return key
    }
}
#endif
