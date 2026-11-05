#if DEBUG
import AppKit
import HotWalletKit
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
}

enum TestScene: String, CaseIterable {
    case main
    case mainTransactions = "main-transactions"
    case mainDetails = "main-details"
    case mainNarrow = "main-narrow"
    case mainNoWallet = "main-no-wallet"
    case mainReading = "main-reading"
    case mainServerDown = "main-server-down"
    case mainNotUpdating = "main-not-updating"
    case mainLinkedFailed = "main-linked-failed"
    case mainEmpty = "main-empty"
    case mainEmptySmallest = "main-empty-smallest"
    case mainSmallest = "main-smallest"
    case mainSmallestEnd = "main-smallest-end"
    case mainEmptyNotice = "main-empty-notice"
    case mainNotStarted = "main-not-started"
    case holdComparison = "hold-comparison"
    case mainHoldDetails = "main-hold-details"
    case mainCostWithheld = "main-cost-withheld"
    case mainCAD = "main-cad"
    case mainTransactionsCAD = "main-transactions-cad"
    case mainDetailsCAD = "main-details-cad"
    case resolve
    case resolveCostWithheld = "resolve-cost-withheld"
    case resolveAnsweredWallet = "resolve-answered-wallet"
    case changeWallet = "change-wallet"
    case popover
    case popoverNoWallet = "popover-no-wallet"
    case popoverNotUpdating = "popover-not-updating"
    case popoverNotStarted = "popover-not-started"
    case popoverCAD = "popover-cad"
    case popoverHotWallet = "popover-hot-wallet"
    case popoverHotWalletOverCap = "popover-hot-wallet-over-cap"
    case popoverHotWalletAlarm = "popover-hot-wallet-alarm"
    case popoverHotWalletCAD = "popover-hot-wallet-cad"
    case settings
    case settingsHotWallet = "settings-hot-wallet"
    case settingsCAD = "settings-cad"
    case settingsHotWalletCAD = "settings-hot-wallet-cad"
    case hotWalletSetup = "hot-wallet-setup"
    case hotWalletNotProvisioned = "hot-wallet-not-provisioned"
    case hotWalletUnreadable = "hot-wallet-unreadable"
    case hotWallet = "hot-wallet"
    case hotWalletCAD = "hot-wallet-cad"
    case hotWalletNoSavings = "hot-wallet-no-savings"
    case hotWalletNoSavingsCAD = "hot-wallet-no-savings-cad"
    case hotWalletNoPrice = "hot-wallet-no-price"
    case hotWalletOverCap = "hot-wallet-over-cap"
    case hotWalletOverCapCAD = "hot-wallet-over-cap-cad"
    case hotWalletOverCapNoSavings = "hot-wallet-over-cap-no-savings"
    case hotWalletKeyMissing = "hot-wallet-key-missing"
    case hotWalletAlarm = "hot-wallet-alarm"
    case hotWalletReplacingKey = "hot-wallet-replacing-key"
    case hotWalletReplacingKeyStuck = "hot-wallet-replacing-key-stuck"
    case hotWalletAddSavings = "hot-wallet-add-savings"
    case hotWalletAddSavingsFilled = "hot-wallet-add-savings-filled"
    case hotWalletTopUp = "hot-wallet-top-up"
    case hotWalletTopUpAtCap = "hot-wallet-top-up-at-cap"
    case hotWalletTopUpCAD = "hot-wallet-top-up-cad"
    case send
    case sendCAD = "send-cad"
    case sendKnown = "send-known"
    case sendWaiting = "send-waiting"
    case publishCost = "publish-cost"
    case publishCAD = "publish-cost-cad"
    case publishWaiting = "publish-cost-waiting"
    case ruleComparison = "rule-comparison"
    case ruleComparisonCAD = "rule-comparison-cad"

    enum Chrome { case titled, none }

    /// Rendering draws the inspector's text in the wrong color in dark mode, so these only come from a real window.
    var needsRealWindow: Bool { self == .mainDetails || self == .mainDetailsCAD || self == .mainHoldDetails || self == .mainSmallestEnd }

    var chrome: Chrome {
        switch self {
        case .changeWallet, .holdComparison, .popover, .popoverNoWallet, .popoverNotUpdating, .popoverNotStarted, .resolve, .resolveCostWithheld, .resolveAnsweredWallet, .popoverCAD, .popoverHotWallet, .popoverHotWalletOverCap, .popoverHotWalletAlarm, .popoverHotWalletCAD,
             .hotWalletAddSavings, .hotWalletAddSavingsFilled, .hotWalletTopUp, .hotWalletTopUpAtCap, .hotWalletTopUpCAD,
             .send, .sendCAD, .sendKnown, .sendWaiting, .publishCost, .publishCAD, .publishWaiting, .ruleComparison, .ruleComparisonCAD:
            .none
        default: .titled
        }
    }

    private var feed: FixtureSource.Feed {
        switch self {
        case .mainReading: .neverAnswers
        case .mainServerDown: .serverDown
        case .mainNotUpdating, .popoverNotUpdating: .stopsAnswering
        case .mainLinkedFailed: .linkedFails
        case .mainCostWithheld, .resolveCostWithheld: .costWithheld
        case .resolveAnsweredWallet: .answeredWallet
        case .mainEmpty, .mainEmptySmallest: .empty
        case .mainEmptyNotice: .emptyReadingLinked
        case .mainNotStarted, .popoverNotStarted: .notStarted
        default: .demo
        }
    }

    private var hasWallet: Bool {
        self != .mainNoWallet && self != .popoverNoWallet
    }

    private var usesDemoWallet: Bool {
        switch self {
        case .mainEmpty, .mainEmptySmallest, .mainEmptyNotice, .mainNotStarted, .popoverNotStarted: false
        default: true
        }
    }

    private var currency: CurrencyCode {
        switch self {
        case .mainCAD, .mainTransactionsCAD, .mainDetailsCAD, .popoverCAD, .settingsCAD, .popoverHotWalletCAD, .settingsHotWalletCAD, .hotWalletCAD, .hotWalletNoSavingsCAD, .hotWalletOverCapCAD, .hotWalletTopUpCAD, .sendCAD, .publishCAD, .ruleComparisonCAD: .CAD
        default: .USD
        }
    }

    private var hotWalletFixture: HotWalletFixture {
        switch self {
        case .hotWalletNotProvisioned: .notProvisioned
        case .hotWalletUnreadable: .unreadableRecords
        case .hotWallet, .hotWalletCAD, .popoverHotWallet, .popoverHotWalletCAD, .settingsHotWallet, .settingsHotWalletCAD, .hotWalletAddSavings, .hotWalletAddSavingsFilled, .hotWalletTopUp, .hotWalletTopUpCAD, .send, .sendCAD, .sendKnown: .funded
        case .sendWaiting: .waitingForTouchID
        case .hotWalletNoSavings, .hotWalletNoSavingsCAD: .noSavings
        case .hotWalletNoPrice: .noPrice
        case .hotWalletOverCap, .hotWalletOverCapCAD, .popoverHotWalletOverCap, .hotWalletTopUpAtCap: .overCap
        case .hotWalletOverCapNoSavings: .overCapNoSavings
        case .hotWalletKeyMissing: .keyMissing
        case .hotWalletAlarm, .popoverHotWalletAlarm: .alarm
        case .hotWalletReplacingKey: .replacingKey
        case .hotWalletReplacingKeyStuck: .replacingKeyStuck
        default: .none
        }
    }

    func make() -> TestScreen {
        // Registered values stay in memory, so this never reads or writes anyone's settings, as long as nothing here changes one.
        let defaults = UserDefaults(suiteName: "com.benface.pricetag.mac.test-mode")!
        var registered: [String: Any] = ["currency": currency.rawValue]
        if hasWallet { registered["wallet"] = usesDemoWallet ? WalletAddress.demo : TestScene.emptyWallet }
        if self == .sendKnown, let book = try? JSONEncoder().encode(Book().answering(TestScene.recipient, .someoneElse, focus: nil)) { registered["answers"] = book }
        if self == .resolveAnsweredWallet, let book = try? JSONEncoder().encode(Book().answering(TestScene.answeredWallet, .mine, focus: nil)) { registered["answers"] = book }
        defaults.register(defaults: registered)
        let source = FixtureSource(feed: feed)
        let store = PortfolioStore(defaults: defaults, makeSource: { _ in source }, reachableDelay: .milliseconds(50), unreachableDelay: .seconds(30))
        store.start()
        let hotWallet = hotWalletFixture.make(source: source, costMethod: { store.method }, mainCurrency: { store.currency })
        // Before there's a view, which is how it'd be for anyone opening a sheet: a sheet works out what it offers when it appears.
        let hotWalletHasRead = ReadOnce()
        Task {
            await hotWallet.tick()
            await hotWallet.readHistory()
            hotWalletHasRead.isDone = true
        }
        let deadline = Date.now.addingTimeInterval(5)
        while !hotWalletHasRead.isDone {
            guard Date.now < deadline else { TestMode.fail("This scene's hot wallet never finished reading.") }
            RunLoop.main.run(until: .now.addingTimeInterval(0.01))
        }
        let navigation = Navigation()
        navigation.showsTransactions = self == .mainTransactions || self == .mainTransactionsCAD
        if self == .mainDetails || self == .mainDetailsCAD { navigation.target = .asset("AERO", .realized) }
        if self == .mainHoldDetails { navigation.target = .holdComparison }

        let isReady: () -> Bool = { [feed] in
            switch feed {
            case .demo, .linkedFails, .costWithheld, .answeredWallet, .empty, .emptyReadingLinked, .notStarted: store.feed == .noWallet || store.portfolio != nil
            case .neverAnswers: true
            case .serverDown: store.feed == .serverUnreachable
            case .stopsAnswering: store.feed == .serverUnreachable && store.portfolio != nil
            }
        }
        switch self {
        case .resolve, .resolveCostWithheld, .resolveAnsweredWallet:
            return TestScreen(view: AnyView(ResolveFlow(store: store)), size: CGSize(width: 520, height: 560), isReady: isReady)
        case .holdComparison:
            return TestScreen(view: AnyView(HoldComparisonScene()), isReady: { true })
        case .main, .mainTransactions, .mainDetails, .mainHoldDetails, .mainNoWallet, .mainReading, .mainServerDown, .mainNotUpdating, .mainLinkedFailed, .mainEmpty, .mainEmptyNotice, .mainNotStarted, .mainCostWithheld, .mainCAD, .mainTransactionsCAD, .mainDetailsCAD:
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation)), size: CGSize(width: 1120, height: 760), isReady: isReady)
        case .mainSmallestEnd:
            // Starts at the end of the page, because a screenshot can't scroll to it.
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation).defaultScrollAnchor(.bottom)), size: CGSize(width: 780, height: 560), isReady: isReady)
        case .mainEmptySmallest, .mainSmallest:
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation)), size: CGSize(width: 780, height: 560), isReady: isReady)
        case .mainNarrow:
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation)), size: CGSize(width: 780, height: 760), isReady: isReady)
        case .changeWallet:
            return TestScreen(view: AnyView(WalletSheet(store: store)), isReady: isReady)
        case .popover, .popoverNoWallet, .popoverNotUpdating, .popoverNotStarted, .popoverCAD, .popoverHotWallet, .popoverHotWalletOverCap, .popoverHotWalletAlarm, .popoverHotWalletCAD:
            return TestScreen(view: AnyView(PopoverView(store: store, hotWallet: hotWallet, navigation: navigation)), isReady: isReady)
        case .settings, .settingsHotWallet, .settingsCAD, .settingsHotWalletCAD:
            return TestScreen(view: AnyView(SettingsView(store: store, hotWallet: hotWallet)), isReady: isReady)
        case .hotWalletSetup, .hotWalletNotProvisioned, .hotWalletUnreadable:
            return TestScreen(view: AnyView(HotWalletWindow(wallet: hotWallet, store: store)), size: CGSize(width: 560, height: 720), isReady: isReady)
        case .hotWallet, .hotWalletCAD, .hotWalletNoSavings, .hotWalletNoSavingsCAD, .hotWalletNoPrice, .hotWalletOverCap, .hotWalletOverCapCAD, .hotWalletOverCapNoSavings, .hotWalletKeyMissing, .hotWalletAlarm, .hotWalletReplacingKey, .hotWalletReplacingKeyStuck:
            // Taller than it opens, because a screenshot can't scroll to the actions and the activity at the bottom.
            return TestScreen(view: AnyView(HotWalletWindow(wallet: hotWallet, store: store)), size: CGSize(width: 560, height: 1200), isReady: isReady)
        case .hotWalletAddSavings:
            return TestScreen(view: AnyView(AddColdWalletSheet(wallet: hotWallet)), isReady: isReady)
        case .hotWalletAddSavingsFilled:
            return TestScreen(view: AnyView(AddColdWalletSheet(wallet: hotWallet, address: HotWalletFixture.savings.lowercased)), isReady: isReady)
        case .hotWalletTopUp, .hotWalletTopUpAtCap, .hotWalletTopUpCAD:
            return TestScreen(view: AnyView(TopUpSheet(wallet: hotWallet)), isReady: isReady)
        case .send, .sendCAD, .sendKnown, .sendWaiting:
            let model = SendModel(wallet: hotWallet, store: store)
            model.token = Base.tokens.first { $0.symbol == "USDC" }!
            model.amountText = "12.50"
            model.addressText = TestScene.recipient
            let isWaiting = self == .sendWaiting
            // It never gets past the prompt, and there's no key behind it anyway.
            if isWaiting { Task { _ = await model.send() } }
            return TestScreen(view: AnyView(SendSheet(model: model)), isReady: { !isWaiting || model.isSending })
        case .publishCost, .publishCAD, .publishWaiting:
            let draft = CostNoteDraft(wallet: "0x00000000000000000000000000000000000de301", txHash: "0x" + String(repeating: "ab", count: 32), asset: "USDC", decimals: 6, units: "250000000")
            return TestScreen(view: AnyView(PublishCostSheet(draft: draft, currency: currency, typed: "250", publish: { _ in false }, problem: { nil }, isPublishing: { [self] in self == .publishWaiting })), isReady: isReady)
        case .ruleComparison, .ruleComparisonCAD:
            guard let comparison: RuleComparison = try? FixtureSource.decode(self == .ruleComparison ? "demo-rule-comparison" : "demo-rule-comparison-cad") else { TestMode.fail("There's no comparison fixture.") }
            return TestScreen(view: AnyView(RuleComparisonTable(comparison: comparison).padding(20).frame(width: 720).background(.background)), isReady: { true })
        }
    }

    private static let recipient = "0x0000000000000000000000000000000000c0ffee"
    private static let emptyWallet = "0x00000000000000000000000000000000000de301"
    private static let answeredWallet = "0x00000000000000000000000000000000000de301"
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

private final class ReadOnce {
    var isDone = false
}

/// Stands in for the server, with the same demo wallet the tests read.
final class FixtureSource: PortfolioSource {
    enum Feed { case demo, neverAnswers, serverDown, stopsAnswering, linkedFails, costWithheld, answeredWallet, empty, emptyReadingLinked, notStarted }

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
            return try demo { $0["linkedFailed"] = ["0x00000000000000000000000000000000000de301"] }
        case .costWithheld:
            // The demo, with what one of its linked wallets sent left unknown.
            return try demo { object in
                object["withheld"] = [["wallet": "0x00000000000000000000000000000000000de301", "asset": "USDC"]]
                let asked: [String: Any] = ["id": "cost:0xdemo:0xwithheld:USDC", "kind": "cost", "wallet": object["address"] ?? "", "receipts": [["wallet": object["address"] ?? "", "legId": "0xwithheld:USDC", "asset": "USDC", "units": "500000000"]], "costKey": "0xdemo:0xwithheld:USDC", "noteAbout": NSNull(), "needsCost": false, "arrivals": [["asset": "USDC", "decimals": 6, "units": "500000000"]], "transfers": 1, "firstAt": "2026-11-04T12:00:00.000Z", "lastAt": "2026-11-04T12:00:00.000Z", "evidence": ["0x0000…e301, your wallet, sent this, and its USDC history can't be confirmed"], "valueMicros": "500000000"]
                object["questions"] = [asked] + (object["questions"] as? [[String: Any]] ?? [])
            }
        case .answeredWallet:
            // What a wallet being read gets asked about one of the user's own wallets, which isn't what the demo itself would ask.
            return try demo { object in
                var questions = object["questions"] as? [[String: Any]] ?? []
                guard var first = questions.first else { return }
                first["evidence"] = ["You've said this is your wallet. Choose My wallet if the one you're looking at is yours too, or Someone else if it isn't."]
                questions[0] = first
                object["questions"] = questions
            }
        case .empty: return try newWallet(started: true, readingLinked: false, address: address)
        case .emptyReadingLinked: return try newWallet(started: true, readingLinked: true, address: address)
        case .notStarted: return try newWallet(started: false, readingLinked: false, address: address)
        case .neverAnswers: try await Task.sleep(for: .seconds(600))
        case .serverDown: throw FetchError.unreachable
        case .stopsAnswering: if read > 1 { throw FetchError.unreachable }
        }
        return try Self.decode(fixture("demo-portfolio", currency))
    }

    /// The demo, changed a little.
    private func demo(_ change: (inout [String: Any]) -> Void) throws -> Portfolio {
        guard let url = Bundle.main.url(forResource: "demo-portfolio", withExtension: "json"), var object = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] else { throw FetchError.rejected("There's no fixture called demo-portfolio.") }
        change(&object)
        return try JSONDecoder().decode(Portfolio.self, from: JSONSerialization.data(withJSONObject: object))
    }

    /// A real wallet with nothing in it yet, optionally waiting on another one, which is a notice above the empty state.
    private func newWallet(started: Bool, readingLinked: Bool, address: String) throws -> Portfolio {
        try demo {
            $0["address"] = address
            $0["mode"] = "dataset"
            $0["positions"] = [Any]()
            $0["points"] = [Any]()
            $0["questions"] = [Any]()
            $0["outgoingTxs"] = [Any]()
            $0["unlisted"] = [Any]()
            $0["progress"] = ["started": started, "behindBlocks": 0]
            // Up to date, so the only notice is the one asked for.
            $0["latest"] = ["blockNum": 53505400, "timestamp": Date.now.formatted(.iso8601)]
            if readingLinked { $0["linkedReading"] = ["0x00000000000000000000000000000000000de302"] }
        }
    }

    func explanation(of target: ExplainTarget, address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book) async throws -> Explanation {
        try Self.decode(target == .holdComparison ? "demo-hold-explanation" : fixture("demo-explanation", currency))
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
        let totals = (try Self.decode(fixture("demo-portfolio", currency)) as Portfolio).totals
        return candidates.map { _ in BookPreview(pnlMicros: totals.pnlMicros, pnlStatus: .partial, estimatedMicros: totals.estimatedMicros, unresolvedMicros: totals.unresolvedMicros, open: 4, pending: false, failed: false) }
    }

    private func fixture(_ name: String, _ currency: CurrencyCode) -> String {
        currency == .USD ? name : "\(name)-\(currency.rawValue.lowercased())"
    }

    static func decode<T: Decodable>(_ name: String) throws -> T {
        guard let url = Bundle.main.url(forResource: name, withExtension: "json") else { throw FetchError.rejected("There's no fixture called \(name).") }
        return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
    }
}
#endif
