import Foundation
import LocalAuthentication
import Observation

public protocol UserPresence: Sendable {
    /// Returns once the person at this device says yes, and throws if they don't.
    func confirm(reason: String) async throws
    /// The same, asked inside a window of ours when it can be, so what's being approved stays in view.
    @MainActor func confirm(reason: String, in prompt: PresencePrompt) async throws
}

extension UserPresence {
    @MainActor public func confirm(reason: String, in prompt: PresencePrompt) async throws {
        try await confirm(reason: reason)
    }
}

/// One ask for Touch ID. A view pairs `context` with `LAAuthenticationView`, which draws the prompt in that view instead of a dialog
/// on top. It has no words of its own, so the window around it has to say what's being approved. Used once, so no touch counts twice.
@MainActor
@Observable
public final class PresencePrompt {
    public private(set) var context = LAContext()
    /// macOS's own dialog is asking instead, because this Mac can't ask inline right now. It names what's being approved by itself.
    public private(set) var isSystemDialog = false
    /// The person said yes, so what it was asking about is underway, and cancelling this can't call that back.
    public private(set) var isConfirmed = false
    @ObservationIgnored private(set) var isCancelled = false

    public init() {}

    func markConfirmed() {
        isConfirmed = true
    }

    public func cancel() {
        isCancelled = true
        context.invalidate()
    }

    /// False with no sensor in reach, say with the lid closed, or after too many tries, when only the password will do.
    var canAskInline: Bool {
        context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometricsOrCompanion, error: nil)
    }

    func switchToSystemDialog() -> LAContext {
        context = LAContext()
        isSystemDialog = true
        return context
    }
}

/// Touch ID, or the login password where there's none. This is the app asking, not the Secure Enclave insisting: sweeps have to
/// unwrap the same key with nobody there, so the enclave can't require it. It keeps out a passer-by, not malware running as this user.
public struct DeviceOwnerPresence: UserPresence {
    public init() {}

    public func confirm(reason: String) async throws {
        _ = try await LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
    }

    @MainActor public func confirm(reason: String, in prompt: PresencePrompt) async throws {
        if prompt.canAskInline {
            do {
                _ = try await prompt.context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometricsOrCompanion, localizedReason: reason)
                return
            } catch let error as LAError where Self.needsSystemDialog(error.code) && !prompt.isCancelled {
                // Below, with its password field.
            }
        }
        guard !prompt.isCancelled else { throw LAError(.appCancel) }
        _ = try await prompt.switchToSystemDialog().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
    }

    /// The sensor went away or locked up while asking. A finger it didn't recognize isn't here: that's trying again, not a different way in.
    private static func needsSystemDialog(_ code: LAError.Code) -> Bool {
        #if os(macOS)
        if code == .biometryDisconnected || code == .biometryNotPaired { return true }
        #endif
        return [.biometryLockout, .biometryNotAvailable, .biometryNotEnrolled, .companionNotAvailable, .notInteractive].contains(code)
    }
}
