#if DEBUG && canImport(AppKit)
import AppKit
import SwiftUI

/// Draws a view to a PNG from a window that's never shown, so it can't take focus. It's for tests and `macos/shot.sh`, and isn't in a release build.
/// See `macos/TESTING.md` for what it can't draw. `ImageRenderer` isn't enough here: it leaves out anything AppKit draws, like tables and segmented controls.
@MainActor
public enum OffscreenRenderer {
    public enum Failure: Error {
        case neverReady
        case nothingToDraw
    }

    /// `size` is the view's own size if it's nil. `isReady` says when whatever the view loads has arrived.
    public static func png(of view: some View, size: CGSize? = nil, dark: Bool = false, timeout: TimeInterval = 5, settle: TimeInterval = 0.5, isReady: () -> Bool = { true }) throws -> Data {
        // The one policy that can't become the active app, whatever the view does.
        NSApplication.shared.setActivationPolicy(.prohibited)
        Motion.playsEntrances = false
        let controller = NSHostingController(rootView: view)
        let window = NSWindow(contentRect: CGRect(origin: .zero, size: size ?? CGSize(width: 480, height: 320)), styleMask: .borderless, backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.contentViewController = controller

        let deadline = Date.now.addingTimeInterval(timeout)
        while !isReady() {
            guard Date.now < deadline else { throw Failure.neverReady }
            RunLoop.main.run(until: .now.addingTimeInterval(0.05))
        }
        // Lets what just arrived lay out, and what that starts loading arrive too.
        RunLoop.main.run(until: .now.addingTimeInterval(settle))
        window.setContentSize(size ?? controller.view.fittingSize)
        window.layoutIfNeeded()

        // The frame view and not the content view, because it's what draws the window's background.
        guard let frame = window.contentView?.superview, let bitmap = frame.bitmapImageRepForCachingDisplay(in: frame.bounds) else { throw Failure.nothingToDraw }
        window.effectiveAppearance.performAsCurrentDrawingAppearance {
            frame.cacheDisplay(in: frame.bounds, to: bitmap)
        }
        guard let png = bitmap.representation(using: .png, properties: [:]) else { throw Failure.nothingToDraw }
        return png
    }
}
#endif
