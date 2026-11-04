import Foundation
import libsecp256k1
import Security

/// Bitcoin Core's libsecp256k1, called directly. The wrapper's Swift layer copies the key into an array on every signature,
/// which nothing would ever wipe, so this only uses its build of the C library and passes it a pointer to `SecretBytes`.
enum Secp256k1 {
    enum Failure: Error {
        case noContext
        case invalidKey
        case signingFailed
    }

    private static func withContext<R>(_ body: (OpaquePointer) throws -> R) throws -> R {
        guard let context = secp256k1_context_create(UInt32(SECP256K1_CONTEXT_NONE)) else { throw Failure.noContext }
        defer { secp256k1_context_destroy(context) }
        // Blinds signing against side channels, as the library recommends. This isn't the key: it's thrown away right after.
        let seed = SecretBytes(count: 32)
        try seed.withMutableBytes { try SecureRandom.fill($0) }
        let randomized = seed.withBytes { secp256k1_context_randomize(context, $0.bindMemory(to: UInt8.self).baseAddress!) }
        guard randomized == 1 else { throw Failure.noContext }
        return try body(context)
    }

    static func isValidKey(_ key: borrowing SecretBytes) throws -> Bool {
        try withContext { context in
            key.withBytes { secp256k1_ec_seckey_verify(context, $0.bindMemory(to: UInt8.self).baseAddress!) == 1 }
        }
    }

    static func publicKey(of key: borrowing SecretBytes) throws -> [UInt8] {
        try withContext { context in
            var publicKey = secp256k1_pubkey()
            let created = key.withBytes { secp256k1_ec_pubkey_create(context, &publicKey, $0.bindMemory(to: UInt8.self).baseAddress!) }
            guard created == 1 else { throw Failure.invalidKey }
            return serialize(publicKey, context)
        }
    }

    struct RecoverableSignature: Equatable {
        let r: [UInt8]
        let s: [UInt8]
        let yParity: UInt8
    }

    /// RFC 6979 nonces, and a low S, both from the library. `digest` has to be 32 bytes.
    static func sign(digest: [UInt8], with key: borrowing SecretBytes) throws -> RecoverableSignature {
        precondition(digest.count == 32)
        return try withContext { context in
            var signature = secp256k1_ecdsa_recoverable_signature()
            let signed = key.withBytes { secp256k1_ecdsa_sign_recoverable(context, &signature, digest, $0.bindMemory(to: UInt8.self).baseAddress!, nil, nil) }
            guard signed == 1 else { throw Failure.signingFailed }
            var compact = [UInt8](repeating: 0, count: 64)
            var recoveryID: Int32 = 0
            guard secp256k1_ecdsa_recoverable_signature_serialize_compact(context, &compact, &recoveryID, &signature) == 1 else { throw Failure.signingFailed }
            // 2 and 3 only happen about once in 2^127 signatures, and an Ethereum transaction can't express them.
            guard recoveryID == 0 || recoveryID == 1 else { throw Failure.signingFailed }
            return RecoverableSignature(r: Array(compact[0..<32]), s: Array(compact[32..<64]), yParity: UInt8(recoveryID))
        }
    }

    /// The uncompressed public key that signed this.
    static func recover(digest: [UInt8], signature: RecoverableSignature) throws -> [UInt8] {
        try withContext { context in
            var parsed = secp256k1_ecdsa_recoverable_signature()
            guard secp256k1_ecdsa_recoverable_signature_parse_compact(context, &parsed, signature.r + signature.s, Int32(signature.yParity)) == 1 else { throw Failure.signingFailed }
            var publicKey = secp256k1_pubkey()
            guard secp256k1_ecdsa_recover(context, &publicKey, &parsed, digest) == 1 else { throw Failure.signingFailed }
            return serialize(publicKey, context)
        }
    }

    private static func serialize(_ publicKey: secp256k1_pubkey, _ context: OpaquePointer) -> [UInt8] {
        var publicKey = publicKey
        var output = [UInt8](repeating: 0, count: 65)
        var length = 65
        secp256k1_ec_pubkey_serialize(context, &output, &length, &publicKey, UInt32(SECP256K1_EC_UNCOMPRESSED))
        return output
    }
}

/// The only source of key bytes. There's no way to pass in a seed.
enum SecureRandom {
    enum Failure: Error {
        case unavailable(OSStatus)
    }

    static func fill(_ buffer: UnsafeMutableRawBufferPointer) throws {
        let status = SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
        guard status == errSecSuccess else { throw Failure.unavailable(status) }
    }
}
