import Foundation

/// The name people see. It comes from `Config/App.xcconfig`, the one place it's set.
enum AppName {
    static let current = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "App"
}
