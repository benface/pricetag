import AppKit
import SwiftUI

/// A menu bar app has no Dock icon or menus of its own. It takes both on while one of its windows is open,
/// so the window can be reached with ⌘-Tab and its keyboard shortcuts appear in a menu, and gives them back when it closes.
enum DockPresence {
    private static var openWindows = 0

    static func windowAppeared() {
        openWindows += 1
        bringForward()
    }

    /// `NSApp.activate()` only works if the app in front offers to yield, and a menu bar panel doesn't make it. The window
    /// then opens behind everything, so this asks with the older call, which is only ever made on a click in this app.
    static func bringForward() {
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
