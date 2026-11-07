import Observation
import ServiceManagement

/// The switch in Settings that opens the app when the person logs in, through the system's own list of login items, where they can also turn it off.
@Observable
final class LaunchAtLogin {
    enum State: Equatable {
        case off, on
        /// Asked for, but turned off in System Settings, where only the person can turn it back on.
        case needsApproval
    }

    private(set) var state: State
    /// Why the last change didn't happen, until the next one.
    private(set) var problem: String?

    /// Nil in test scenes, which must never change anything about the system.
    @ObservationIgnored private let service: SMAppService?

    /// `state` is for test scenes, which have no service to ask.
    init(service: SMAppService? = .mainApp, state: State = .off) {
        self.service = service
        self.state = state
        refresh()
    }

    var isOn: Bool { state != .off }

    /// Read again whenever Settings comes forward, because the person may have changed it in System Settings.
    func refresh() {
        guard let service else { return }
        state = Self.state(of: service.status)
    }

    func setOn(_ value: Bool) {
        guard let service else {
            state = value ? .on : .off
            return
        }
        do {
            if value {
                try service.register()
            } else {
                try service.unregister()
            }
            problem = nil
        } catch {
            problem = value ? "Couldn't add \(AppName.current) to your login items." : "Couldn't remove \(AppName.current) from your login items."
        }
        refresh()
    }

    func openSystemSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }

    static func state(of status: SMAppService.Status) -> State {
        switch status {
        case .enabled: .on
        case .requiresApproval: .needsApproval
        case .notRegistered, .notFound: .off
        @unknown default: .off
        }
    }
}
