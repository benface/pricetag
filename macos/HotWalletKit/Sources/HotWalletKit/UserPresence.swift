import Foundation
import LocalAuthentication

public protocol UserPresence: Sendable {
    /// Returns once the person at this device says yes, and throws if they don't.
    func confirm(reason: String) async throws
}

/// Touch ID, or the login password where there's none. This is the app asking, not the Secure Enclave insisting: sweeps have to
/// unwrap the same key with nobody there, so the enclave can't require it. It keeps out a passer-by, not malware running as this user.
public struct DeviceOwnerPresence: UserPresence {
    public init() {}

    public func confirm(reason: String) async throws {
        _ = try await LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
    }
}
