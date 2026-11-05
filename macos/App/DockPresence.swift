import AppKit
import SwiftUI

/// A menu bar app has no Dock icon or menus of its own. It takes both on while one of its windows is open,
/// so the window can be reached with ⌘-Tab and its keyboard shortcuts appear in a menu, and gives them back when it closes.
enum DockPresence {
    private static var openWindows = 0
    private static var observer: (any NSObjectProtocol)?

    static func windowAppeared() {
        openWindows += 1
        bringForward()
        allowFullScreen()
    }

    /// A window made while the app is a menu bar app never gets to go full screen, so its green button only zooms. That stays true after the app
    /// gets a Dock icon, and a reopened window gets explicitly barred. SwiftUI's own `windowFullScreenBehavior` doesn't change this. The flag gets
    /// set after the window is on screen, because anything earlier is overwritten, and again each time it comes forward.
    private static func allowFullScreen() {
        if observer == nil {
            observer = NotificationCenter.default.addObserver(forName: NSWindow.didBecomeKeyNotification, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { NSApp.windows.forEach(mark) }
            }
        }
        for delay in [0.0, 0.1, 0.5] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { NSApp.windows.forEach(mark) }
        }
    }

    private static func mark(_ window: NSWindow) {
        // The main window only. Full screen makes no sense for Settings or a site's request, and a request has to stay in front of what it's about.
        guard window.identifier?.rawValue.hasPrefix(WindowID.main) == true else { return }
        window.collectionBehavior.remove(.fullScreenNone)
        window.collectionBehavior.insert(.fullScreenPrimary)
    }

    /// `NSApp.activate()` only works if the app in front offers to yield, and a menu bar panel doesn't make it. The window
    /// then opens behind everything, so this asks with the older call, which is only ever made on a click in this app.
    static func bringForward() {
        #if DEBUG
        if HotWalletDebug.isQuiet { return }
        #endif
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    static func windowDisappeared() {
        openWindows = max(0, openWindows - 1)
        if openWindows == 0 { NSApp.setActivationPolicy(.accessory) }
    }
}

extension View {
    func holdsDockPresence() -> some View {
        onAppear(perform: DockPresence.windowAppeared).onDisappear(perform: DockPresence.windowDisappeared)
    }
}
