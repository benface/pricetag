#if DEBUG
import AppKit
import HotWalletKit
import KeyVault
import PricetagKit
import SwiftUI
import Synchronization

/// What `macos/shot.sh` runs: one screen of the app, from fixtures, without ever taking focus. See `macos/TESTING.md`.
/// None of this is in a release build.
enum TestMode {
    private static func value(after flag: String) -> String? {
        CommandLine.arguments.firstIndex(of: flag).flatMap { CommandLine.arguments.indices.contains($0 + 1) ? CommandLine.arguments[$0 + 1] : nil }
    }

    /// Takes over before anything of the real app exists, so there's no menu bar item, and nothing to call `DockPresence`.
    static func runIfAsked() {
        if CommandLine.arguments.contains("--test-scenes") {
            for scene in TestScene.allCases { print(scene.rawValue, scene.needsRealWindow ? "window" : "render") }
            exit(0)
        }
        guard let name = value(after: "--test-scene") else { return }
        guard let scene = TestScene(rawValue: name) else { fail("There's no scene called \(name).") }
        let dark = value(after: "--appearance") == "dark"
        let screen = scene.make()
        if let output = value(after: "--output") {
            do {
                try OffscreenRenderer.png(of: screen.view, size: screen.size, dark: dark, isReady: screen.isReady).write(to: URL(filePath: output))
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
        let window = NSWindow(contentRect: CGRect(origin: .zero, size: screen.size ?? CGSize(width: 480, height: 320)), styleMask: chrome == .titled ? [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView] : .borderless, backing: .buffered, defer: true)
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
        window.setContentSize(screen.size ?? controller.view.fittingSize)
        window.setFrameOrigin(.zero)
        window.orderBack(nil)

        let deadline = Date.now.addingTimeInterval(5)
        while !screen.isReady() {
            guard Date.now < deadline else { fail("This scene's fixtures never arrived.") }
            RunLoop.main.run(until: .now.addingTimeInterval(0.05))
        }
        RunLoop.main.run(until: .now.addingTimeInterval(0.8))
        if screen.size == nil { window.setContentSize(controller.view.fittingSize) }
        RunLoop.main.run(until: .now.addingTimeInterval(0.2))
        if NSApp.isActive { fail("This became the active app, which it must never do.") }
        print("WINDOW \(window.windowNumber) \(ProcessInfo.processInfo.processIdentifier)")
        fflush(stdout)
        // In case whoever started this is gone by now.
        RunLoop.main.run(until: .now.addingTimeInterval(60))
        exit(0)
    }

    static func fail(_ message: String) -> Never {
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
}

enum TestScene: String, CaseIterable {
    case main
    case mainTransactions = "main-transactions"
    case mainDetails = "main-details"
    case mainNoWallet = "main-no-wallet"
    case mainReading = "main-reading"
    case mainServerDown = "main-server-down"
    case mainNotUpdating = "main-not-updating"
    case mainLinkedFailed = "main-linked-failed"
    case holdComparison = "hold-comparison"
    case mainHoldDetails = "main-hold-details"
    case resolve
    case changeWallet = "change-wallet"
    case popover
    case popoverNoWallet = "popover-no-wallet"
    case popoverNotUpdating = "popover-not-updating"
    case settings

    enum Chrome { case titled, none }

    /// Rendering draws the inspector's text in the wrong color in dark mode, so this one only comes from a real window.
    var needsRealWindow: Bool { self == .mainDetails || self == .mainHoldDetails }

    var chrome: Chrome {
        switch self {
        case .changeWallet, .holdComparison, .popover, .popoverNoWallet, .popoverNotUpdating, .resolve: .none
        default: .titled
        }
    }

    private var feed: FixtureSource.Feed {
        switch self {
        case .mainReading: .neverAnswers
        case .mainServerDown: .serverDown
        case .mainNotUpdating, .popoverNotUpdating: .stopsAnswering
        case .mainLinkedFailed: .linkedFails
        default: .demo
        }
    }

    private var hasWallet: Bool {
        self != .mainNoWallet && self != .popoverNoWallet
    }

    func make() -> TestScreen {
        // Registered values stay in memory, so this never reads or writes anyone's settings, as long as nothing here changes one.
        let defaults = UserDefaults(suiteName: "com.benface.pricetag.mac.test-mode")!
        defaults.register(defaults: hasWallet ? ["wallet": WalletAddress.demo] : [:])
        let source = FixtureSource(feed: feed)
        let store = PortfolioStore(defaults: defaults, makeSource: { _ in source }, reachableDelay: .milliseconds(50), unreachableDelay: .seconds(30))
        store.start()
        // Never started, so it reads nothing, and it has nowhere to get a key from or keep anything.
        let hotWallet = HotWallet(signer: NoKeys(), settingsStore: NoSavedSettings(), stateStore: NoSavedState(), presence: NoOneThere(), portfolioSource: { source }, costMethod: { store.method })
        let navigation = Navigation()
        navigation.showsTransactions = self == .mainTransactions
        if self == .mainDetails { navigation.target = .asset("AERO", .realized) }
        if self == .mainHoldDetails { navigation.target = .holdComparison }

        let isReady: () -> Bool = { [feed] in
            switch feed {
            case .demo, .linkedFails: store.feed == .noWallet || store.portfolio != nil
            case .neverAnswers: true
            case .serverDown: store.feed == .serverUnreachable
            case .stopsAnswering: store.feed == .serverUnreachable && store.portfolio != nil
            }
        }
        switch self {
        case .resolve:
            return TestScreen(view: AnyView(ResolveFlow(store: store)), size: CGSize(width: 520, height: 560), isReady: isReady)
        case .holdComparison:
            return TestScreen(view: AnyView(HoldComparisonScene()), isReady: { true })
        case .main, .mainTransactions, .mainDetails, .mainHoldDetails, .mainNoWallet, .mainReading, .mainServerDown, .mainNotUpdating, .mainLinkedFailed:
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation)), size: CGSize(width: 1120, height: 760), isReady: isReady)
        case .changeWallet:
            return TestScreen(view: AnyView(WalletSheet(store: store)), isReady: isReady)
        case .popover, .popoverNoWallet, .popoverNotUpdating:
            return TestScreen(view: AnyView(PopoverView(store: store, hotWallet: hotWallet, navigation: navigation)), isReady: isReady)
        case .settings:
            return TestScreen(view: AnyView(SettingsView(store: store, hotWallet: hotWallet)), isReady: isReady)
        }
    }
}

/// The card in each state it can be in, from what `test/hold.test.ts` wrote.
private struct HoldComparisonScene: View {
    private struct Vector: Decodable {
        let currency: CurrencyCode
        let comparison: HoldComparison
    }

    private let vectors: [Vector] = {
        guard let url = Bundle.main.url(forResource: "hold-vectors", withExtension: "json"), let data = try? Data(contentsOf: url), let vectors = try? JSONDecoder().decode([Vector].self, from: data) else { TestMode.fail("There's no fixture called hold-vectors.") }
        return vectors
    }()

    var body: some View {
        VStack(spacing: 12) {
            ForEach(vectors.indices, id: \.self) { index in
                HoldComparisonCard(comparison: vectors[index].comparison, currency: vectors[index].currency, isLive: true) {}
            }
        }
        .padding(16)
        .frame(width: 800)
        .background(.background)
    }
}

/// The test mode never makes, loads or signs with a key, and this is what makes sure of it.
private struct NoKeys: Signer {
    struct NotInTestMode: Error {}

    func createKey() async throws -> EthereumAddress { throw NotInTestMode() }
    func sign(_ transaction: UnsignedTransaction, from address: EthereumAddress) async throws -> SignedTransaction { throw NotInTestMode() }
    func hasKey(_ address: EthereumAddress) async throws -> Bool { false }
    func deleteKey(_ address: EthereumAddress) async throws {}
    func addresses() async throws -> [EthereumAddress] { [] }
}

private struct NoSavedSettings: WalletSettingsStore {
    func load() -> WalletSettings { WalletSettings() }
    func save(_ settings: WalletSettings) {}
}

private struct NoSavedState: DeviceStateStore {
    func load() throws -> DeviceWalletState { DeviceWalletState() }
    func save(_ state: DeviceWalletState) throws {}
}

private struct NoOneThere: UserPresence {
    func confirm(reason: String) async throws { throw NoKeys.NotInTestMode() }
}

/// Stands in for the server, with the same demo wallet the tests read.
private final class FixtureSource: PortfolioSource {
    enum Feed { case demo, neverAnswers, serverDown, stopsAnswering, linkedFails }

    private let feed: Feed
    private let reads = Mutex(0)

    init(feed: Feed) {
        self.feed = feed
    }

    func portfolio(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book, timeout: Duration) async throws -> Portfolio {
        let read = reads.withLock { reads in
            reads += 1
            return reads
        }
        switch feed {
        case .demo: break
        case .linkedFails:
            // The demo, with one of its linked wallets unreadable.
            guard let url = Bundle.main.url(forResource: "demo-portfolio", withExtension: "json"), var object = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] else { throw FetchError.rejected("There's no fixture called demo-portfolio.") }
            object["linkedFailed"] = ["0x00000000000000000000000000000000000de301"]
            return try JSONDecoder().decode(Portfolio.self, from: JSONSerialization.data(withJSONObject: object))
        case .neverAnswers: try await Task.sleep(for: .seconds(600))
        case .serverDown: throw FetchError.unreachable
        case .stopsAnswering: if read > 1 { throw FetchError.unreachable }
        }
        return try decode("demo-portfolio")
    }

    func explanation(of target: ExplainTarget, address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book) async throws -> Explanation {
        try decode(target == .holdComparison ? "demo-hold-explanation" : "demo-explanation")
    }

    func proof(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Proof {
        throw FetchError.unreachable
    }

    func verification(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Verification {
        throw FetchError.unreachable
    }

    func taxReport(_ request: TaxReportRequest) async throws -> TaxReport {
        throw FetchError.rejected("There's no tax report fixture.")
    }

    /// What each answer would do, as the demo's own numbers, so a card shows them in place.
    func previews(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], candidates: [Book]) async throws -> [BookPreview] {
        let totals = (try decode("demo-portfolio") as Portfolio).totals
        return candidates.map { _ in BookPreview(pnlMicros: totals.pnlMicros, pnlStatus: .partial, estimatedMicros: totals.estimatedMicros, unresolvedMicros: totals.unresolvedMicros, open: 4, pending: false, failed: false) }
    }

    private func decode<T: Decodable>(_ name: String) throws -> T {
        guard let url = Bundle.main.url(forResource: name, withExtension: "json") else { throw FetchError.rejected("There's no fixture called \(name).") }
        return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
    }
}
#endif
