#if DEBUG
import AppKit
import HotWalletKit
import KeyVault
import PricetagKit
import SwiftUI

/// What `macos/shot.sh` runs: one screen of the app, from fixtures, without ever taking focus. See `macos/TESTING.md`.
/// None of this is in a release build.
enum TestMode {
    private nonisolated static func value(after flag: String) -> String? {
        CommandLine.arguments.firstIndex(of: flag).flatMap { CommandLine.arguments.indices.contains($0 + 1) ? CommandLine.arguments[$0 + 1] : nil }
    }

    /// Real numbers in place of fixtures, from `shot.sh --live`. It only reads: the hot wallet still has no key, and can't send.
    nonisolated struct Live: Sendable {
        let server: URL
        let wallet: String
        /// What the scenes that open the details open them on.
        let asset: String
    }

    nonisolated static let live: Live? = value(after: "--live-server").flatMap(URL.init(string:)).flatMap { server in
        value(after: "--live-wallet").map { Live(server: server, wallet: $0.lowercased(), asset: value(after: "--live-asset") ?? "ETH") }
    }
    static let liveCurrency = value(after: "--live-currency").flatMap(CurrencyCode.init(rawValue:))
    /// What the Overview chart shows, from `shot.sh --chart`.
    static let chartMetric = value(after: "--chart-metric").flatMap(ChartMetric.init(rawValue:)) ?? .pnl
    /// A wallet's first read can take minutes.
    static let readyTimeout: TimeInterval = live == nil ? 5 : 240
    /// Live scenes load more after they appear, like the details and the tax report, and nothing here can tell when that's done.
    static let settleTime = value(after: "--settle").flatMap(TimeInterval.init) ?? (live == nil ? 0.5 : 6)

    static let isRunning = CommandLine.arguments.contains("--test-scene")

    /// Takes over before anything of the real app exists, so there's no menu bar item, and nothing to call `DockPresence`.
    static func runIfAsked() {
        if CommandLine.arguments.contains("--test-scenes") {
            for scene in TestScene.allCases { print(scene.rawValue, scene.needsRealWindow ? "window" : "render") }
            exit(0)
        }
        guard let name = value(after: "--test-scene") else { return }
        guard let scene = TestScene(rawValue: name) else { fail("There's no scene called \(name).") }
        let dark = value(after: "--appearance") == "dark"
        // Only a scene about motion plays what happens by itself, so every other one shows the finished view.
        Motion.playsEntrances = scene == .motionChartDraw
        Motion.slowdown = value(after: "--slowdown").flatMap(Double.init) ?? 1
        let screen = scene.make()
        if let output = value(after: "--accessibility-output") {
            do {
                try AccessibilityTree.text(of: screen.view, size: screen.size, dark: dark, timeout: readyTimeout, settle: settleTime, isReady: screen.isReady).write(to: URL(filePath: output), atomically: true, encoding: .utf8)
            } catch {
                fail("Couldn't read \(name)'s accessibility: \(error)")
            }
            if NSApp.isActive { fail("This became the active app, which it must never do.") }
            exit(0)
        }
        if let output = value(after: "--output") {
            do {
                try OffscreenRenderer.png(of: screen.view, size: screen.size, dark: dark, timeout: readyTimeout, settle: settleTime, isReady: screen.isReady).write(to: URL(filePath: output))
            } catch {
                fail("Couldn't render \(name): \(error)")
            }
            if NSApp.isActive { fail("This became the active app, which it must never do.") }
            exit(0)
        }
        showBehindTheDesktop(screen, chrome: scene.chrome, dark: dark)
    }

    /// A real window, for what only the window server draws. `screencapture -l` won't take a window that's off every screen,
    /// but it will take one behind the desktop, where nobody can see or click it. `shot.sh` captures it by its number, then quits this.
    private static func showBehindTheDesktop(_ screen: TestScreen, chrome: TestScene.Chrome, dark: Bool) -> Never {
        // The one policy that can't become the active app, whatever the view does.
        NSApplication.shared.setActivationPolicy(.prohibited)
        // `open -j` starts it hidden, and a hidden app's windows have nothing to capture.
        NSApp.unhideWithoutActivation()
        let window = NSWindow(contentRect: CGRect(origin: .zero, size: screen.size ?? CGSize(width: 480, height: 320)), styleMask: chrome == TestScene.Chrome.none ? .borderless : [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        window.ignoresMouseEvents = true
        let controller = NSHostingController(rootView: screen.view)
        // Gives the view's title and toolbar to the window, as a SwiftUI scene does.
        controller.sceneBridgingOptions = .all
        window.contentViewController = controller
        window.toolbarStyle = .unified
        if chrome == .hiddenTitleBar {
            window.titleVisibility = .hidden
            window.titlebarAppearsTransparent = true
        }
        window.setContentSize(screen.size ?? controller.view.fittingSize)
        window.setFrameOrigin(.zero)
        window.orderBack(nil)

        let deadline = Date.now.addingTimeInterval(readyTimeout)
        while !screen.isReady() {
            guard Date.now < deadline else { fail("This scene's fixtures never arrived.") }
            RunLoop.main.run(until: .now.addingTimeInterval(0.05))
        }
        RunLoop.main.run(until: .now.addingTimeInterval(settleTime + 0.3))
        if screen.size == nil { window.setContentSize(controller.view.fittingSize) }
        RunLoop.main.run(until: .now.addingTimeInterval(0.2))
        if NSApp.isActive { fail("This became the active app, which it must never do.") }
        print("WINDOW \(window.windowNumber) \(ProcessInfo.processInfo.processIdentifier)")
        fflush(stdout)
        if let play = screen.play, let cue = value(after: "--play-when") {
            // Once `shot.sh` has started capturing, which takes it a while the first time. If it's gone, the cue never comes.
            let cueDeadline = Date.now.addingTimeInterval(60)
            while !FileManager.default.fileExists(atPath: cue) {
                guard Date.now < cueDeadline else { fail("Nothing started this scene's motion.") }
                RunLoop.main.run(until: .now.addingTimeInterval(0.01))
            }
            play()
        }
        // In case whoever started this is gone by now.
        RunLoop.main.run(until: .now.addingTimeInterval(60))
        exit(0)
    }

    nonisolated static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data((message + "\n").utf8))
        exit(1)
    }
}

/// A scene's view, and how to tell its fixtures have arrived.
struct TestScreen {
    let view: AnyView
    /// nil to fit the view.
    var size: CGSize?
    let isReady: () -> Bool
    /// What `shot.sh --frames` watches happen.
    var play: (@MainActor () -> Void)?
}
#endif
