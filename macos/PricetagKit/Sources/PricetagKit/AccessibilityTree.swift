#if DEBUG && canImport(AppKit)
import AppKit
import ApplicationServices
import SwiftUI

/// What VoiceOver would find in a view, as text, from a window that's never shown. It's for tests and `macos/shot.sh --accessibility`,
/// and isn't in a release build. It's the tree macOS builds for assistive apps, so it shows labels, values and order, and what's marked to be said a character at a time, but not how VoiceOver speaks them.
@MainActor
public enum AccessibilityTree {
    public struct Element: Sendable, Equatable {
        public var role: String
        public var label: String
        public var value: String
        public var help: String
        public var depth: Int
        public var isEnabled: Bool
        /// The parts of the label VoiceOver says a character at a time.
        public var spelledOut: [String] = []

        /// One line, as VoiceOver would roughly put it: what it is, what it says, and what kind of thing it is.
        public var line: String {
            let parts = [label, value].filter { !$0.isEmpty }
            let text = parts.isEmpty ? "(nothing to read)" : parts.joined(separator: ", ")
            return String(repeating: "  ", count: depth) + "\(text) [\(role)\(isEnabled ? "" : ", dimmed")]" + (help.isEmpty ? "" : " — \(help)") + spelledOut.map { " {spelled out: \($0)}" }.joined()
        }
    }

    /// Every element in reading order. Groups that have nothing to read of their own are left out, so their children sit one level up.
    public static func elements(of view: some View, size: CGSize? = nil, dark: Bool = false, timeout: TimeInterval = 5, settle: TimeInterval = 0.5, isReady: () -> Bool = { true }) throws -> [Element] {
        NSApplication.shared.setActivationPolicy(.prohibited)
        // Without it, the app doesn't answer assistive apps at all. Nothing in tests or the test mode has a delegate yet for it to tell.
        NSApplication.shared.finishLaunching()
        Motion.playsEntrances = false
        let controller = NSHostingController(rootView: view)
        let window = NSWindow(contentRect: CGRect(origin: .zero, size: size ?? CGSize(width: 480, height: 320)), styleMask: .borderless, backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.contentViewController = controller

        let deadline = Date.now.addingTimeInterval(timeout)
        while !isReady() {
            guard Date.now < deadline else { throw OffscreenRenderer.Failure.neverReady }
            RunLoop.main.run(until: .now.addingTimeInterval(0.05))
        }
        RunLoop.main.run(until: .now.addingTimeInterval(settle))
        window.setContentSize(size ?? controller.view.fittingSize)
        window.layoutIfNeeded()
        // Tables only make their rows when they draw.
        if let frame = window.contentView?.superview, let bitmap = frame.bitmapImageRepForCachingDisplay(in: frame.bounds) {
            frame.cacheDisplay(in: frame.bounds, to: bitmap)
        }
        // SwiftUI only builds its tree once an assistive app has asked something, so this asks, from another thread so the main one can answer.
        let pid = ProcessInfo.processInfo.processIdentifier
        let asked = DispatchSemaphore(value: 0)
        Thread.detachNewThread {
            let app = AXUIElementCreateApplication(pid)
            var windows: CFTypeRef?
            _ = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windows)
            asked.signal()
        }
        while asked.wait(timeout: .now()) == .timedOut { RunLoop.main.run(until: .now.addingTimeInterval(0.02)) }
        RunLoop.main.run(until: .now.addingTimeInterval(0.3))

        let controls: Set<String> = [NSAccessibility.Role.button, .checkBox, .radioButton, .popUpButton, .menuButton, .textField, .slider, .incrementor, .comboBox].map(\.rawValue).reduce(into: []) { $0.insert($1) }
        var result: [Element] = []
        var seen = Set<ObjectIdentifier>()
        // SwiftUI's elements answer the protocol's methods without declaring it, so they're asked dynamically.
        func walk(_ node: AnyObject, depth: Int) {
            guard seen.insert(ObjectIdentifier(node)).inserted else { return }
            // Some answers are attributed strings, and some values are numbers.
            func text(_ selector: Selector) -> String {
                guard node.responds(to: selector), let answer = node.perform(selector)?.takeUnretainedValue() else { return "" }
                return (answer as? NSAttributedString)?.string ?? "\(answer)"
            }
            let role = text(#selector(NSAccessibilityProtocol.accessibilityRole))
            let label = [text(#selector(NSAccessibilityProtocol.accessibilityLabel)), text(#selector(NSAccessibilityProtocol.accessibilityTitle))].first { !$0.isEmpty } ?? ""
            let value = text(#selector(NSAccessibilityProtocol.accessibilityValue))
            // Not in the protocol, and only SwiftUI's own elements answer it. That's where the plain label's marks went.
            var spelledOut: [String] = []
            let attributedLabel = NSSelectorFromString("accessibilityAttributedLabel")
            if node.responds(to: attributedLabel), let answer = node.perform(attributedLabel)?.takeUnretainedValue() as? NSAttributedString {
                answer.enumerateAttribute(NSAttributedString.Key("AXSpellOut"), in: NSRange(location: 0, length: answer.length)) { mark, range, _ in
                    if (mark as? Bool) == true { spelledOut.append(answer.attributedSubstring(from: range).string) }
                }
            }
            let help = text(#selector(NSAccessibilityProtocol.accessibilityHelp))
            let isElement = node.isAccessibilityElement?() ?? false
            // Only controls say whether they're enabled. Everything else says it isn't.
            let isEnabled = !controls.contains(role) || node.isAccessibilityEnabled?() ?? true
            let readable = !label.isEmpty || !value.isEmpty || isElement && role != NSAccessibility.Role.group.rawValue
            var next = depth
            if readable {
                result.append(Element(role: role.replacingOccurrences(of: "AX", with: ""), label: label, value: value, help: help, depth: depth, isEnabled: isEnabled, spelledOut: spelledOut))
                next += 1
            }
            let children = (node.accessibilityChildren?() as [Any]??).flatMap { $0 } ?? []
            // A table that's never been on screen has no children yet, but it has rows.
            let rows = children.isEmpty ? (node.accessibilityRows?() as [Any]??).flatMap { $0 } ?? [] : []
            for child in children + rows { walk(child as AnyObject, depth: next) }
        }
        walk(controller.view, depth: 0)
        return result
    }

    public static func text(of view: some View, size: CGSize? = nil, dark: Bool = false, timeout: TimeInterval = 5, settle: TimeInterval = 0.5, isReady: () -> Bool = { true }) throws -> String {
        try elements(of: view, size: size, dark: dark, timeout: timeout, settle: settle, isReady: isReady).map(\.line).joined(separator: "\n") + "\n"
    }
}
#endif
