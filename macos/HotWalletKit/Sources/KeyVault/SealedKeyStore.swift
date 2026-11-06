import Foundation
import Security

#if PATINA_WATCH_ONLY
/// Only what the rest of the app reads to learn that this build can't hold a key. It has no way to reach the Keychain.
public enum KeychainSealedKeyStore {
    public enum Failure: Error, Equatable {
        case notProvisioned
        case keychain(OSStatus)
    }
}
#else
public protocol SealedKeyStore: Sendable {
    func save(_ sealed: SealedKey, for address: EthereumAddress) throws
    func load(_ address: EthereumAddress) throws -> SealedKey?
    func delete(_ address: EthereumAddress) throws
    func addresses() throws -> [EthereumAddress]
}

/// A device-only Keychain item for each key. It never syncs, isn't in backups that restore to another device, and works after
/// the first unlock since boot, so a sweep can run while the screen's locked. It needs the data protection Keychain, which
/// only a provisioned build can use. See `macos/run.sh`.
public struct KeychainSealedKeyStore: SealedKeyStore {
    public enum Failure: Error, Equatable {
        /// This build isn't signed in a way that can reach the data protection Keychain.
        case notProvisioned
        case keychain(OSStatus)
    }

    private let service: String

    public init(service: String = "com.benface.pricetag.hot-wallet") {
        self.service = service
    }

    private func query(_ address: EthereumAddress? = nil) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecUseDataProtectionKeychain as String: true,
            kSecAttrSynchronizable as String: false,
        ]
        if let address { query[kSecAttrAccount as String] = address.lowercased }
        return query
    }

    private func failure(_ status: OSStatus) -> Failure {
        status == errSecMissingEntitlement ? .notProvisioned : .keychain(status)
    }

    public func save(_ sealed: SealedKey, for address: EthereumAddress) throws {
        var attributes = query(address)
        attributes[kSecValueData as String] = try JSONEncoder().encode(sealed)
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        attributes[kSecAttrLabel as String] = "Hot wallet key, wrapped by the Secure Enclave"
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else { throw failure(status) }
    }

    public func load(_ address: EthereumAddress) throws -> SealedKey? {
        var request = query(address)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw failure(status) }
        return try JSONDecoder().decode(SealedKey.self, from: data)
    }

    /// How an item is really stored, for checking it from a signed build.
    public func attributes(of address: EthereumAddress) throws -> (accessible: String, synchronizable: Bool) {
        var request = query(address)
        request[kSecReturnAttributes as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        guard status == errSecSuccess, let item = result as? [String: Any] else { throw failure(status) }
        return (item[kSecAttrAccessible as String] as? String ?? "", (item[kSecAttrSynchronizable as String] as? Bool) ?? false)
    }

    public func delete(_ address: EthereumAddress) throws {
        let status = SecItemDelete(query(address) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw failure(status) }
    }

    public func addresses() throws -> [EthereumAddress] {
        var request = query()
        request[kSecReturnAttributes as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitAll
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess, let items = result as? [[String: Any]] else { throw failure(status) }
        return items.compactMap { ($0[kSecAttrAccount as String] as? String).flatMap(EthereumAddress.init) }
    }
}
#endif
