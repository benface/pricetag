import AppKit
import PricetagKit

/// The menu bar item's right-click menu. `MenuBarExtra` has no way to add one, so this catches the click before the item does.
/// Everything else stays `MenuBarExtra`'s: the panel, how it closes, and the label that updates by itself.
@MainActor
final class StatusItemMenu: NSObject {
    static let shared = StatusItemMenu()

    /// Set while the panel is open, because a click this catches never reaches what would close it.
    var closePopover: (() -> Void)?
    private var shows: () -> MenuBarShows = { .value }
    private var setShows: (MenuBarShows) -> Void = { _ in }
    private var openApp: () -> Void = {}
    private var openSettings: () -> Void = {}
    private var monitor: Any?

    func start(shows: @escaping () -> MenuBarShows, setShows: @escaping (MenuBarShows) -> Void, openApp: @escaping () -> Void, openSettings: @escaping () -> Void) {
        self.shows = shows
        self.setShows = setShows
        self.openApp = openApp
        self.openSettings = openSettings
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { event in
            // AppKit calls this on the main thread, with an event that doesn't go anywhere else.
            nonisolated(unsafe) let event = event
            let wasHandled = MainActor.assumeIsolated { StatusItemMenu.shared.handle(event) }
            return wasHandled ? nil : event
        }
    }

    /// Only takes a right-click or Control-click on the item. Clicks anywhere else in the app are none of this.
    private func handle(_ event: NSEvent) -> Bool {
        guard event.type == .rightMouseDown || event.modifierFlags.contains(.control),
              let window = event.window, Self.isStatusItem(window) else { return false }
        closePopover?()
        show(under: window)
        return true
    }

    /// There's no public way to ask. Another display's menu bar holds a copy of the item in a window of this class with no button in it, so looking for the button would miss those.
    /// If this name ever changes, a right-click just opens the panel, as a left-click does.
    private static func isStatusItem(_ window: NSWindow) -> Bool {
        String(describing: type(of: window)) == "NSStatusBarWindow"
    }

    private static func statusButton(in view: NSView) -> NSStatusBarButton? {
        if let button = view as? NSStatusBarButton { return button }
        return view.subviews.lazy.compactMap(statusButton).first
    }

    /// Comes back once the menu has closed.
    private func show(under window: NSWindow) {
        let menu = NSMenu()
        menu.addItem(item("Open \(AppName.current)", #selector(openAppChosen), key: "o"))
        menu.addItem(item("Settings…", #selector(openSettingsChosen), key: ","))
        menu.addItem(.separator())
        // The same choice as in Settings, here too because this is where someone sharing their screen would look for it.
        menu.addItem(.sectionHeader(title: "Show in Menu Bar"))
        for choice in MenuBarShows.allCases {
            let entry = item(choice.label, #selector(showsChosen), key: "")
            entry.representedObject = choice.rawValue
            entry.state = choice == shows() ? .on : .off
            menu.addItem(entry)
        }
        menu.addItem(.separator())
        menu.addItem(item("Quit \(AppName.current)", #selector(quitChosen), key: "q"))
        let button = NSApp.windows.lazy.compactMap { $0.contentView.flatMap(Self.statusButton) }.first
        button?.highlight(true)
        // In screen coordinates, on whichever display was clicked: the item's left edge, directly under the menu bar, which is as tall as the item's window.
        menu.popUp(positioning: nil, at: window.frame.origin, in: nil)
        button?.highlight(false)
    }

    private func item(_ title: String, _ action: Selector, key: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    @objc private func openAppChosen() { openApp() }
    @objc private func openSettingsChosen() { openSettings() }
    @objc private func showsChosen(_ item: NSMenuItem) {
        (item.representedObject as? String).flatMap(MenuBarShows.init(rawValue:)).map(setShows)
    }
    @objc private func quitChosen() { NSApp.terminate(nil) }
}
