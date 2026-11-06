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
            // Once `shot.sh` has started capturing, which takes it a while the first time.
            while !FileManager.default.fileExists(atPath: cue) {
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

/// Every kind of thing the menu bar item says, for each choice of what it shows, on a light, a dark and a tinted bar. These are stand-ins for the real menu bar,
/// which only macOS can draw: the system picks the item's color, so this shows the words and their lengths, not the real thing.
private struct MenuBarLabelScene: View {
    let portfolio: () -> Portfolio?

    private func summaries(_ shows: MenuBarShows) -> [FeedSummary] {
        let states: [FeedState] = [.noWallet, .reading, .live, .behind(seconds: 600), .serverUnreachable]
        return states.map { FeedSummary(feed: $0, portfolio: portfolio(), shows: shows) }
    }

    private func bar(_ shows: MenuBarShows, _ background: Color, _ foreground: Color) -> some View {
        let summaries = summaries(shows)
        return HStack(spacing: 16) {
            ForEach(Array(summaries.enumerated()), id: \.offset) { MenuBarLabelContent(summary: $0.element, isAlarm: false) }
            MenuBarLabelContent(summary: summaries[0], isAlarm: true)
        }
        .font(.system(size: 13))
        .foregroundStyle(foreground)
        .padding(.horizontal, 12)
        .frame(height: 24)
        .background(background)
    }

    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 8) {
            ForEach(MenuBarShows.allCases) { shows in
                GridRow {
                    Text(shows.label).font(.caption).foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 4) {
                        bar(shows, Color(white: 0.92), .black)
                        bar(shows, Color(white: 0.14), .white)
                        bar(shows, Color(red: 0.1, green: 0.32, blue: 0.62), .white)
                    }
                }
            }
        }
        .padding(8)
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

/// What a motion scene changes while it's being captured, from outside the views.
@Observable @MainActor
final class MotionCue {
    var revision = 0
    var range = ChartRange.all
    var scrubbed: Int?
    var stage = ProgressFooter.Stage.working("Sending…")
    var purchase = PurchasePhase.onItsWay
    var costIsKnown = false
}

/// The chart, on its own, doing what the scene's cue says.
private struct MotionChartScene: View {
    let store: PortfolioStore
    let cue: MotionCue

    var body: some View {
        Group {
            if let portfolio = store.portfolio {
                PnlHistorySection(portfolio: portfolio, isLive: true, range: Binding(get: { cue.range }, set: { cue.range = $0 }), scrubbedIndex: cue.scrubbed) { _ in }
                    .id(cue.revision)
            }
        }
        .padding(20)
        .frame(width: 760, height: 340)
        .background(.background)
    }
}

/// The page's numbers and boxes with Increase Contrast on, which can't be turned on from here for real.
private struct ContrastScene: View {
    let store: PortfolioStore

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let portfolio = store.portfolio {
                Notice(.info, Wording.demo)
                Notice(.warning, "This wallet's numbers aren't updating.")
                PortfolioSummary(portfolio: portfolio, isLive: true, size: 40) { _ in }
                PortfolioAttention(portfolio: portfolio, onOpen: { _ in }, onResolve: {})
                PnlHistorySection(portfolio: portfolio, isLive: true, range: .constant(.all)) { _ in }
                    .frame(height: 260)
            }
        }
        .padding(20)
        .frame(width: 900)
        .background(.background)
        .environment(\._colorSchemeContrast, .increased)
    }
}

/// What a send's confirmation goes through once Touch ID has said yes.
private struct MotionSendScene: View {
    let cue: MotionCue

    var body: some View {
        ConfirmationView(asker: .spendingMoney, hero: .amount("12.5", symbol: "USDC"), worth: "$12.50", rows: [ConfirmationRow(label: "To", value: "0x00000000000000000000000000000000000de302", isAddress: true, name: "Ledger"), ConfirmationRow(label: "Network fee", value: "About $0.0032")]) {
            ProgressFooter(stage: cue.stage, close: {})
        }
        .frame(width: 460)
        .background(.background)
    }
}

/// A purchase going from on its way to arrived, with its cost.
private struct MotionPurchaseScene: View {
    let cue: MotionCue

    private static let purchase = TrackedPurchase(
        ref: "arriving", wallet: HotWalletFixture.spending.lowercased, asset: "ETH", dollars: 25, startedAt: .now,
        order: OnrampOrder(id: "arriving", status: .succeeded, asset: "ETH", units: "8000000000000000", wallet: HotWalletFixture.spending.lowercased, network: "base", txHash: "0x" + String(repeating: "ab", count: 32), blockNum: 50)
    )

    var body: some View {
        PurchaseRow(purchase: Self.purchase, phase: cue.purchase, main: .USD) {}
            .padding(20)
            .frame(width: 420)
            .background(.background)
    }
}

/// Scenes press real buttons. What those save goes no further than this run, or the next scene, on any branch, would start from it.
private nonisolated final class SceneDefaults: UserDefaults, @unchecked Sendable {
    override func set(_ value: Any?, forKey key: String) {
        if let value { register(defaults: [key: value]) }
    }

    override func removeObject(forKey key: String) {}
}

enum TestScene: String, CaseIterable {
    case main
    case mainTransactions = "main-transactions"
    case mainDetails = "main-details"
    case mainNarrow = "main-narrow"
    case mainSmall = "main-small"
    case mainMedium = "main-medium"
    case mainHuge = "main-huge"
    // Around where the holdings table changes shape, with the sidebar open.
    case mainWidth660 = "main-width-660"
    case mainWidth760 = "main-width-760"
    case mainWidth860 = "main-width-860"
    case mainWidth960 = "main-width-960"
    case mainWidth1040 = "main-width-1040"
    case mainFirstRunSmall = "main-first-run-small"
    case mainTransactionsSmall = "main-transactions-small"
    case mainSpendingMoney = "main-spending-money"
    case mainSpendingMoneySmall = "main-spending-money-small"
    case mainSpendingMoneyServerDown = "main-spending-money-server-down"
    case mainTaxReport = "main-tax-report"
    case mainSecurity = "main-security"
    case security
    case securitySavings = "security-savings"
    case securityDemo = "security-demo"
    case securityReading = "security-reading"
    case securityStale = "security-stale"
    case securityNoSpendingMoney = "security-no-spending-money"
    case revoke
    case revokeOne = "revoke-one"
    case mainTaxReportSmall = "main-tax-report-small"
    /// The whole page, tall enough that nothing's scrolled out of the picture.
    case taxReport = "tax-report"
    /// The same, showing another wallet, so what's unknown is in a wallet added to the report.
    case taxReportAddedWallet = "tax-report-added-wallet"
    case taxReportOtherWallets = "tax-report-other-wallets"
    case taxReportLeftOver = "tax-report-left-over"
    case mainNoWalletSmall = "main-no-wallet-small"
    case mainNoWalletHasSpendingMoney = "main-no-wallet-has-spending-money"
    case mainNoWalletNotProvisioned = "main-no-wallet-not-provisioned"
    case mainNoWallet = "main-no-wallet"
    case mainNoWalletAfterDeleting = "main-no-wallet-after-deleting"
    case mainNoWalletSaved = "main-no-wallet-saved"
    case mainNoWalletSavedSmall = "main-no-wallet-saved-small"
    case mainReading = "main-reading"
    /// Another wallet's just been picked, or a setting changed: what was last known, while the read runs.
    case mainUpdating = "main-updating"
    case mainUpdatingNarrow = "main-updating-narrow"
    case mainUpdatingSmall = "main-updating-small"
    case mainUpdatingCAD = "main-updating-cad"
    case mainTransactionsUpdating = "main-transactions-updating"
    case mainServerDown = "main-server-down"
    case mainPricesDown = "main-prices-down"
    case mainPricesStop = "main-prices-stop"
    case mainTooSlow = "main-too-slow"
    case mainRetrying = "main-retrying"
    case mainRetryingNumbers = "main-retrying-numbers"
    case mainNotStartedFailing = "main-not-started-failing"
    case mainReadingStart = "main-reading-start"
    case mainNotUpdating = "main-not-updating"
    case mainNotUpdatingSmall = "main-not-updating-small"
    case mainLinkedFailed = "main-linked-failed"
    case mainEmpty = "main-empty"
    case mainEmptySmallest = "main-empty-smallest"
    case mainSmallest = "main-smallest"
    case mainSmallestEnd = "main-smallest-end"
    case mainEmptyNotice = "main-empty-notice"
    case mainFirstRun = "main-first-run"
    case mainFirstRunSmallest = "main-first-run-smallest"
    case mainFirstRunDetails = "main-first-run-details"
    case mainNotStarted = "main-not-started"
    case holdComparison = "hold-comparison"
    case mainHoldDetails = "main-hold-details"
    case mainCostWithheld = "main-cost-withheld"
    case mainSmallAmounts = "main-small-amounts"
    case mainSmallAmountsNarrow = "main-small-amounts-narrow"
    case mainLongHistory = "main-long-history"
    case mainChartWeek = "main-chart-week"
    case mainCAD = "main-cad"
    case mainTransactionsCAD = "main-transactions-cad"
    case mainDetailsCAD = "main-details-cad"
    case resolve
    /// Every question answered: what it was all for.
    case resolveFinished = "resolve-finished"
    case resolveCostWithheld = "resolve-cost-withheld"
    case resolvePublishFromDevice = "resolve-publish-from-device"
    case resolveAnsweredWallet = "resolve-answered-wallet"
    case walletSwitcher = "wallet-switcher"
    case walletSwitcherFirstRun = "wallet-switcher-first-run"
    case walletSwitcherRenaming = "wallet-switcher-renaming"
    case walletSwitcherProblem = "wallet-switcher-problem"
    case walletSwitcherLong = "wallet-switcher-long"
    case walletSwitcherNote = "wallet-switcher-note"
    case walletSwitcherNewKey = "wallet-switcher-new-key"
    case spendingMoneySetupSheet = "spending-money-setup-sheet"
    case mainShowingSpendingMoney = "main-showing-spending-money"
    case mainSavings = "main-savings"
    case mainEmptySpendingMoney = "main-empty-spending-money"
    case mainEmptySpendingMoneySmallest = "main-empty-spending-money-smallest"
    case mainEmptySavings = "main-empty-savings"
    case mainWatching = "main-watching"
    case mainWatchingNamed = "main-watching-named"
    case mainWatchingNamedSmallest = "main-watching-named-smallest"
    case popover
    case popoverNoWallet = "popover-no-wallet"
    case popoverNotUpdating = "popover-not-updating"
    case popoverNotStarted = "popover-not-started"
    case popoverFirstRun = "popover-first-run"
    case popoverLongName = "popover-long-name"
    case popoverLongNameReading = "popover-long-name-reading"
    case popoverCAD = "popover-cad"
    case popoverHotWallet = "popover-hot-wallet"
    case popoverHotWalletOverCap = "popover-hot-wallet-over-cap"
    case popoverHotWalletAlarm = "popover-hot-wallet-alarm"
    case popoverHotWalletCAD = "popover-hot-wallet-cad"
    case popoverReading = "popover-reading"
    case popoverUpdating = "popover-updating"
    case popoverServerDown = "popover-server-down"
    case popoverPricesDown = "popover-prices-down"
    case popoverRetrying = "popover-retrying"
    case popoverEmpty = "popover-empty"
    case popoverHotWalletNoSavings = "popover-hot-wallet-no-savings"
    case popoverHotWalletKeyMissing = "popover-hot-wallet-key-missing"
    case popoverNotProvisioned = "popover-not-provisioned"
    case popoverMissingPrice = "popover-missing-price"
    case mainMissingPrice = "main-missing-price"
    case popoverUnreadBalance = "popover-unread-balance"
    /// What the menu bar's buttons do, with the window closed and with it open on another section. Each fails unless its sheet opens.
    case routeSend = "route-send"
    case routeSendOpen = "route-send-open"
    case routeTopUp = "route-top-up"
    case routeTopUpOpen = "route-top-up-open"
    case routeBuy = "route-buy"
    case routeBuyOpen = "route-buy-open"
    case routeReceive = "route-receive"
    case routeReceiveOpen = "route-receive-open"
    case routeAddSavings = "route-add-savings"
    /// The menu bar's other destinations, starting from another section. Each fails unless it gets there and stays.
    case routeHoldings = "route-holdings"
    case routeHoldingsOpen = "route-holdings-open"
    case routeAddWallet = "route-add-wallet"
    case routeAddWalletOpen = "route-add-wallet-open"
    case routeDetails = "route-details"
    case routeDetailsOpen = "route-details-open"
    case routeAnswer = "route-answer"
    case routeAnswerOpen = "route-answer-open"
    case routeRemoveFromSavingsOpen = "route-remove-from-savings-open"
    case menuBarLabel = "menu-bar-label"
    case settings
    case settingsRules = "settings-rules"
    case settingsSmallDisplay = "settings-small-display"
    case settingsServer = "settings-server"
    case settingsServerProblem = "settings-server-problem"
    case settingsNoHotWallet = "settings-no-hot-wallet"
    case settingsHotWalletProblem = "settings-hot-wallet-problem"
    case settingsHotWallet = "settings-hot-wallet"
    case settingsCAD = "settings-cad"
    case settingsHotWalletCAD = "settings-hot-wallet-cad"
    case settingsHotWalletNoRate = "settings-hot-wallet-no-rate"
    case settingsReplacingKey = "settings-replacing-key"
    case settingsAnswers = "settings-answers"
    case settingsAnswersEmpty = "settings-answers-empty"
    case settingsNotificationsOff = "settings-notifications-off"
    case hotWalletSetup = "hot-wallet-setup"
    case hotWalletNotProvisioned = "hot-wallet-not-provisioned"
    case hotWalletUnreadable = "hot-wallet-unreadable"
    case hotWallet = "hot-wallet"
    case hotWalletCAD = "hot-wallet-cad"
    case hotWalletNoRate = "hot-wallet-no-rate"
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
    case hotWalletReplacingKeyMissing = "hot-wallet-replacing-key-missing"
    case hotWalletSites = "hot-wallet-sites"
    case hotWalletAddSavings = "hot-wallet-add-savings"
    case hotWalletAddSavingsFilled = "hot-wallet-add-savings-filled"
    case hotWalletAddSavingsFromDevice = "hot-wallet-add-savings-from-device"
    case addSavingsLedgerPlugIn = "add-savings-ledger-plug-in"
    case addSavingsLedgerPlugInTrouble = "add-savings-ledger-plug-in-trouble"
    case addSavingsLedgerApp = "add-savings-ledger-app"
    case addSavingsLedgerQuit = "add-savings-ledger-quit"
    case addSavingsLedgerQuitStillOpen = "add-savings-ledger-quit-still-open"
    case addSavingsLedgerBrowser = "add-savings-ledger-browser"
    case addSavingsLedgerBrowserSafari = "add-savings-ledger-browser-safari"
    case addSavingsLedgerBrowserNone = "add-savings-ledger-browser-none"
    case addSavingsLedgerWaiting = "add-savings-ledger-waiting"
    case addSavingsLedgerPaste = "add-savings-ledger-paste"
    case addSavingsLedgerCheckTrouble = "add-savings-ledger-check-trouble"
    case addSavingsKeystoneUnlock = "add-savings-keystone-unlock"
    case addSavingsKeystoneReceive = "add-savings-keystone-receive"
    case addSavingsKeystoneReceiveTrouble = "add-savings-keystone-receive-trouble"
    case addSavingsKeystoneScan = "add-savings-keystone-scan"
    case addSavingsKeystoneScanDenied = "add-savings-keystone-scan-denied"
    case addSavingsKeystoneScanNoCamera = "add-savings-keystone-scan-no-camera"
    case addSavingsKeystoneType = "add-savings-keystone-type"
    case addSavingsKeystoneCheck = "add-savings-keystone-check"
    case addSavingsKeystoneWalked = "add-savings-keystone-walked"
    case addSavingsOtherPaste = "add-savings-other-paste"
    case addSavingsPicked = "add-savings-picked"
    case addSavingsPickedCheck = "add-savings-picked-check"
    case addSavingsCheckStartsSweeps = "add-savings-check-starts-sweeps"
    case addSavingsCheckBalanceUnread = "add-savings-check-balance-unread"
    case addSavingsCheckFirstWallet = "add-savings-check-first-wallet"
    case addSavingsFinished = "add-savings-finished"
    case addSavingsFinishedSweeping = "add-savings-finished-sweeping"
    case addSavingsFinishedElsewhere = "add-savings-finished-elsewhere"
    case hotWalletPurchases = "hot-wallet-purchases"
    case hotWalletPurchasesCAD = "hot-wallet-purchases-cad"
    case hotWalletPurchasesCantCheck = "hot-wallet-purchases-cant-check"
    /// What clicking a notification opens: its row, lit up.
    case hotWalletPurchaseShown = "hot-wallet-purchase-shown"
    case hotWalletRecordShown = "hot-wallet-record-shown"
    /// A notification from before the key was replaced, whose row went with the old key.
    case hotWalletReplacedKeyShown = "hot-wallet-replaced-key-shown"
    case receive
    case receiveNoSavings = "receive-no-savings"
    case receiveCAD = "receive-cad"
    case receiveNotSetUp = "receive-not-set-up"
    case receiveAlarm = "receive-alarm"
    case buy
    case buyCAD = "buy-cad"
    case buyCADAboveRoom = "buy-cad-above-room"
    case buyCADTooLittle = "buy-cad-too-little"
    case buyNoRate = "buy-no-rate"
    case buyAboveRoom = "buy-above-room"
    case buyLarge = "buy-large"
    case buyAtCap = "buy-at-cap"
    case buyUSDCNoGas = "buy-usdc-no-gas"
    case buyNoWallet = "buy-no-wallet"
    case buyTooLittle = "buy-too-little"
    case buyNegative = "buy-negative"
    case buyNoSavings = "buy-no-savings"
    case buyNoSavingsAboveRoom = "buy-no-savings-above-room"
    case buyNoSavingsAtCap = "buy-no-savings-at-cap"
    case buyNoSavingsCAD = "buy-no-savings-cad"
    case buyFirstRead = "buy-first-read"
    case buyReading = "buy-reading"
    case buyNoSavingsFirstRead = "buy-no-savings-first-read"
    case buyNoSavingsAtCapFirstRead = "buy-no-savings-at-cap-first-read"
    case buyNotSetUp = "buy-not-set-up"
    case buyCantReachProvider = "buy-cant-reach-provider"
    case buyRefused = "buy-refused"
    case hotWalletTopUp = "hot-wallet-top-up"
    case hotWalletTopUpFirstRead = "hot-wallet-top-up-first-read"
    case hotWalletTopUpOneDollar = "hot-wallet-top-up-one-dollar"
    case hotWalletTopUpAtCap = "hot-wallet-top-up-at-cap"
    case hotWalletTopUpNoSavings = "hot-wallet-top-up-no-savings"
    case hotWalletTopUpNoSavingsAtCap = "hot-wallet-top-up-no-savings-at-cap"
    case hotWalletTopUpCAD = "hot-wallet-top-up-cad"
    case hotWalletTopUpSafari = "hot-wallet-top-up-safari"
    case hotWalletTopUpNoChromium = "hot-wallet-top-up-no-chromium"
    case send
    case sendCAD = "send-cad"
    case sendKnown = "send-known"
    case sendPicking = "send-picking"
    case sendSearching = "send-searching"
    case sendPicked = "send-picked"
    case sendTypo = "send-typo"
    case sendShortened = "send-shortened"
    case sendTyping = "send-typing"
    case sendWaiting = "send-waiting"
    case sendGoing = "send-going"
    case sendSent = "send-sent"
    case sendStopped = "send-stopped"
    case sendMoney = "send-money"
    case sendMoneyCAD = "send-money-cad"
    case sendLookalike = "send-lookalike"
    case sendLookalikeChecked = "send-lookalike-checked"
    case sendRefused = "send-refused"
    case sweep
    case sweepCAD = "sweep-cad"
    case sweepStopped = "sweep-stopped"
    case siteSend = "site-send"
    case siteSendToken = "site-send-token"
    case siteLongAmount = "site-long-amount"
    case siteCall = "site-call"
    case siteApprove = "site-approve"
    case siteUnlimited = "site-unlimited"
    case siteUnlimitedAcknowledged = "site-unlimited-acknowledged"
    case siteMessage = "site-message"
    case siteMessageUnreadable = "site-message-unreadable"
    case siteStopped = "site-stopped"
    case siteNext = "site-next"
    case siteBehind = "site-behind"
    case siteRefocused = "site-refocused"
    case siteSending = "site-sending"
    case siteSent = "site-sent"
    case siteSigning = "site-signing"
    case siteSigned = "site-signed"
    case siteFailure = "site-failure"
    case siteFailureMessage = "site-failure-message"
    case publishCost = "publish-cost"
    case publishCAD = "publish-cost-cad"
    case publishWaiting = "publish-cost-waiting"
    case publishFromDevice = "publish-from-device"
    case publishFromDeviceSafari = "publish-from-device-safari"
    case publishFromDeviceNoChromium = "publish-from-device-no-chromium"
    case ruleComparison = "rule-comparison"
    case ruleComparisonCAD = "rule-comparison-cad"
    case siteConnect = "site-connect"
    case siteTransaction = "site-transaction"
    case siteTransactionCAD = "site-transaction-cad"
    case sitePreview = "site-preview"
    case sitePreviewUnknown = "site-preview-unknown"
    case sitePreviewLong = "site-preview-long"
    case siteUnlimitedApproval = "site-unlimited-approval"
    case siteTypedPermit = "site-typed-permit"
    case sitePermit2 = "site-permit2"
    case sitePermitRemoval = "site-permit-removal"

    /// Set from inside the page, because the setting doesn't pass through the window's own panes.
    case increasedContrast = "increased-contrast"
    case chartHover = "chart-hover"
    /// Each plays something after the window appears, for `shot.sh --frames`. Hovering can't be done from here, so `motion-chart-scrub` moves what hovering moves.
    case motionChartDraw = "motion-chart-draw"
    case motionChartRange = "motion-chart-range"
    case motionChartScrub = "motion-chart-scrub"
    case motionSend = "motion-send"
    case motionPurchase = "motion-purchase"
    case motionCostKnown = "motion-cost-known"
    case motionDetails = "motion-details"

    var isAboutMotion: Bool { rawValue.hasPrefix("motion") }

    enum Chrome { case titled, hiddenTitleBar, none }

    /// Rendering draws the inspector's text in the wrong color in dark mode, and leaves out the title bar the site window leaves room for, so these only come from a real window.
    var needsRealWindow: Bool { isAboutMotion || chrome == .hiddenTitleBar || rawValue.hasPrefix("main") || rawValue.hasPrefix("settings") || rawValue.hasPrefix("route") || self == .mainDetails || self == .mainFirstRunDetails || self == .mainDetailsCAD || self == .mainHoldDetails || self == .mainSmallestEnd }

    var chrome: Chrome {
        switch self {
        case .motionChartDraw, .motionChartRange, .motionChartScrub, .motionSend, .motionPurchase, .chartHover:
            .none
        case .walletSwitcherNote, .walletSwitcherNewKey, .spendingMoneySetupSheet, .taxReport, .taxReportAddedWallet, .taxReportOtherWallets, .taxReportLeftOver, .walletSwitcher, .walletSwitcherFirstRun, .walletSwitcherRenaming, .walletSwitcherProblem, .walletSwitcherLong, .popoverLongName, .popoverLongNameReading, .holdComparison, .popover, .popoverNoWallet, .popoverNotUpdating, .popoverNotStarted, .popoverFirstRun, .resolve, .resolveCostWithheld, .resolvePublishFromDevice, .resolveAnsweredWallet, .popoverCAD, .popoverHotWallet, .popoverHotWalletOverCap, .popoverHotWalletAlarm, .popoverHotWalletCAD, .popoverReading, .popoverUpdating, .popoverServerDown, .popoverPricesDown, .popoverRetrying, .popoverEmpty, .popoverHotWalletNoSavings, .popoverHotWalletKeyMissing, .popoverNotProvisioned, .popoverMissingPrice, .popoverUnreadBalance, .menuBarLabel,
             .hotWalletAddSavings, .hotWalletAddSavingsFilled, .hotWalletAddSavingsFromDevice, .addSavingsLedgerPlugIn, .addSavingsLedgerPlugInTrouble, .addSavingsLedgerApp, .addSavingsLedgerQuit, .addSavingsLedgerQuitStillOpen, .addSavingsLedgerBrowser, .addSavingsLedgerBrowserSafari, .addSavingsLedgerBrowserNone, .addSavingsLedgerWaiting, .addSavingsLedgerPaste, .addSavingsLedgerCheckTrouble, .addSavingsKeystoneUnlock, .addSavingsKeystoneReceive, .addSavingsKeystoneReceiveTrouble, .addSavingsKeystoneScan, .addSavingsKeystoneScanDenied, .addSavingsKeystoneScanNoCamera, .addSavingsKeystoneType, .addSavingsKeystoneCheck, .addSavingsKeystoneWalked, .addSavingsOtherPaste, .addSavingsPicked, .addSavingsPickedCheck, .addSavingsCheckStartsSweeps, .addSavingsCheckBalanceUnread, .addSavingsCheckFirstWallet, .addSavingsFinished, .addSavingsFinishedSweeping, .addSavingsFinishedElsewhere, .receive, .receiveNoSavings, .receiveCAD, .receiveNotSetUp, .receiveAlarm, .buy, .buyCAD, .buyCADAboveRoom, .buyCADTooLittle, .buyNoRate, .buyAboveRoom, .buyLarge, .buyAtCap, .buyUSDCNoGas, .buyNoWallet, .buyTooLittle, .buyNegative, .buyNoSavings, .buyNoSavingsAboveRoom, .buyNoSavingsAtCap, .buyNoSavingsCAD, .buyFirstRead, .buyReading, .buyNoSavingsFirstRead, .buyNoSavingsAtCapFirstRead, .buyNotSetUp, .buyCantReachProvider, .buyRefused, .hotWalletTopUp, .hotWalletTopUpFirstRead, .hotWalletTopUpOneDollar, .hotWalletTopUpAtCap, .hotWalletTopUpNoSavings, .hotWalletTopUpNoSavingsAtCap, .hotWalletTopUpCAD, .hotWalletTopUpSafari, .hotWalletTopUpNoChromium,
             .publishFromDevice, .publishFromDeviceSafari, .publishFromDeviceNoChromium, .send, .sendCAD, .sendKnown, .sendPicking, .sendSearching, .sendPicked, .sendTypo, .sendShortened, .sendTyping, .sendWaiting, .sendGoing, .sendSent, .sendStopped, .sendMoney, .sendMoneyCAD, .sendLookalike, .sendLookalikeChecked, .sendRefused, .sweep, .sweepCAD, .sweepStopped, .revoke, .revokeOne, .siteSend, .siteSendToken, .siteLongAmount, .siteCall, .siteApprove, .siteUnlimited, .siteUnlimitedAcknowledged, .siteMessage, .siteMessageUnreadable, .siteStopped, .siteNext, .siteBehind, .siteRefocused, .siteSending, .siteSent, .siteSigning, .siteSigned, .siteFailure, .siteFailureMessage, .publishCost, .publishCAD, .publishWaiting, .ruleComparison, .ruleComparisonCAD:
            .none
        case .siteConnect, .siteTransaction, .siteTransactionCAD, .sitePreview, .sitePreviewUnknown, .sitePreviewLong, .siteUnlimitedApproval, .siteTypedPermit, .sitePermit2, .sitePermitRemoval:
            .hiddenTitleBar
        default: .titled
        }
    }

    private var feed: FixtureSource.Feed {
        switch self {
        case .popoverMissingPrice, .mainMissingPrice: .missingPrice
        case .popoverUnreadBalance: .unreadBalance
        case .mainReading, .mainReadingStart, .popoverReading, .popoverLongNameReading: .neverAnswers
        case .mainUpdating, .mainUpdatingNarrow, .mainUpdatingSmall, .mainUpdatingCAD, .mainTransactionsUpdating, .popoverUpdating: .updating
        case .mainServerDown, .mainSpendingMoneyServerDown, .popoverServerDown: .serverDown
        case .mainPricesDown, .popoverPricesDown: .pricesDown
        case .mainPricesStop: .pricesStop
        case .mainTooSlow: .tooSlow
        case .mainRetrying: .retrying
        case .mainRetryingNumbers, .popoverRetrying: .retryingWithNumbers
        case .mainNotStartedFailing: .notStartedFails
        case .mainNotUpdating, .mainNotUpdatingSmall, .popoverNotUpdating: .stopsAnswering
        case .mainLinkedFailed: .linkedFails
        case .mainCostWithheld, .resolveCostWithheld: .costWithheld
        case .resolvePublishFromDevice: .costOnSavings
        case .mainSmallAmounts, .mainSmallAmountsNarrow: .smallAmounts
        case .mainLongHistory, .mainChartWeek, .motionChartRange: .longHistory
        case .motionCostKnown: .costBecomesKnown
        case .resolveAnsweredWallet: .answeredWallet
        case .resolveFinished: .allAnswered
        case .mainEmpty, .mainEmptySmallest, .popoverEmpty, .mainEmptySpendingMoney, .mainEmptySpendingMoneySmallest, .mainEmptySavings: .empty
        case .mainEmptyNotice: .emptyReadingLinked
        case .mainNotStarted, .popoverNotStarted: .notStarted
        case .mainFirstRun, .mainFirstRunSmallest, .mainFirstRunSmall, .mainFirstRunDetails, .popoverFirstRun, .popoverLongName, .mainShowingSpendingMoney, .mainSavings, .mainWatching, .mainWatchingNamed, .mainWatchingNamedSmallest: .firstRun
        default: .demo
        }
    }

    private var hasWallet: Bool {
        switch self {
        case .mainNoWalletAfterDeleting, .mainNoWallet, .mainNoWalletSaved, .mainNoWalletSavedSmall, .mainNoWalletSmall, .mainNoWalletHasSpendingMoney, .mainNoWalletNotProvisioned, .popoverNoWallet, .routeAddWallet, .routeAddWalletOpen, .walletSwitcherFirstRun: false
        default: true
        }
    }

    private var usesDemoWallet: Bool {
        switch self {
        case .mainEmpty, .mainEmptySmallest, .mainEmptyNotice, .popoverEmpty, .mainNotStarted, .mainNotStartedFailing, .popoverNotStarted, .mainFirstRun, .mainFirstRunSmallest, .mainFirstRunSmall, .mainFirstRunDetails, .popoverFirstRun: false
        default: true
        }
    }

    private var shownWallet: String? {
        switch self {
        case .taxReportAddedWallet, .taxReportOtherWallets, .taxReportLeftOver, .walletSwitcher, .walletSwitcherRenaming, .walletSwitcherProblem, .mainWatchingNamed, .mainWatchingNamedSmallest, .popoverLongName, .popoverLongNameReading: TestScene.namedWallet
        case .walletSwitcherLong: TestScene.manyWallets.last?.address
        case .mainShowingSpendingMoney, .mainSpendingMoney, .mainSpendingMoneySmall, .mainSpendingMoneyServerDown, .routeRemoveFromSavingsOpen, .mainEmptySpendingMoney, .mainEmptySpendingMoneySmallest: HotWalletFixture.spending.lowercased
        case .mainSavings, .mainEmptySavings, .securitySavings: HotWalletFixture.savings.lowercased
        case .mainSecurity, .security, .securityReading, .securityStale: HotWalletFixture.spending.lowercased
        case .mainWatching: TestScene.recentWallet
        default: nil
        }
    }

    private var listsWallets: Bool {
        switch self {
        case .walletSwitcherNewKey, .walletSwitcher, .walletSwitcherRenaming, .walletSwitcherProblem, .walletSwitcherLong, .mainShowingSpendingMoney, .mainSavings, .mainWatching, .mainWatchingNamed, .mainWatchingNamedSmallest, .popoverLongName, .popoverLongNameReading, .sendPicking, .sendSearching, .sendPicked, .sendTypo, .sendShortened, .sendTyping, .sendLookalike, .sendLookalikeChecked, .addSavingsOtherPaste, .addSavingsLedgerPaste, .addSavingsKeystoneType, .addSavingsPicked, .addSavingsPickedCheck, .mainNoWalletSaved, .mainNoWalletSavedSmall, .taxReportOtherWallets, .taxReportLeftOver, .settingsAnswers, .mainSecurity, .security, .securitySavings: true
        default: false
        }
    }

    private var currency: CurrencyCode {
        switch self {
        case .mainCAD, .mainUpdatingCAD, .mainTransactionsCAD, .mainDetailsCAD, .popoverCAD, .settingsCAD, .popoverHotWalletCAD, .settingsHotWalletCAD, .settingsHotWalletNoRate, .buyCAD, .buyCADAboveRoom, .buyCADTooLittle, .buyNoRate, .buyNoSavingsCAD, .receiveCAD, .hotWalletCAD, .hotWalletNoRate, .hotWalletPurchasesCAD, .hotWalletNoSavingsCAD, .hotWalletOverCapCAD, .hotWalletTopUpCAD, .sendCAD, .sendMoneyCAD, .sweepCAD, .publishCAD, .ruleComparisonCAD, .siteTransactionCAD: .CAD
        default: .USD
        }
    }

    /// In another main currency, with a server that has no current rate.
    private var hasNoRate: Bool { self == .hotWalletNoRate || self == .buyNoRate || self == .settingsHotWalletNoRate }

    private var hotWalletFixture: HotWalletFixture {
        switch self {
        case .hotWalletNotProvisioned, .popoverNotProvisioned, .mainNoWalletNotProvisioned: .notProvisioned
        case .hotWalletUnreadable: .unreadableRecords
        case .routeRemoveFromSavingsOpen, .mainSpendingMoneyServerDown, .walletSwitcher, .walletSwitcherRenaming, .walletSwitcherProblem, .walletSwitcherLong, .mainShowingSpendingMoney, .mainSavings, .mainWatching, .mainWatchingNamed, .mainWatchingNamedSmallest, .routeBuy, .routeBuyOpen, .routeAddSavings, .routeSend, .routeSendOpen, .routeTopUp, .routeTopUpOpen, .mainSpendingMoney, .mainSpendingMoneySmall, .hotWallet, .hotWalletRecordShown, .hotWalletCAD, .mainNoWalletHasSpendingMoney, .popoverHotWallet, .popoverHotWalletCAD, .settingsHotWallet, .settingsHotWalletProblem, .settingsHotWalletCAD, .settingsHotWalletNoRate, .hotWalletNoRate, .hotWalletAddSavings, .hotWalletAddSavingsFilled, .hotWalletAddSavingsFromDevice, .addSavingsLedgerPlugIn, .addSavingsLedgerPlugInTrouble, .addSavingsLedgerApp, .addSavingsLedgerQuit, .addSavingsLedgerQuitStillOpen, .addSavingsLedgerBrowser, .addSavingsLedgerBrowserSafari, .addSavingsLedgerBrowserNone, .addSavingsLedgerWaiting, .addSavingsLedgerPaste, .addSavingsLedgerCheckTrouble, .addSavingsKeystoneUnlock, .addSavingsKeystoneReceive, .addSavingsKeystoneReceiveTrouble, .addSavingsKeystoneScan, .addSavingsKeystoneScanDenied, .addSavingsKeystoneScanNoCamera, .addSavingsKeystoneType, .addSavingsKeystoneCheck, .addSavingsKeystoneWalked, .addSavingsOtherPaste, .addSavingsPicked, .addSavingsPickedCheck, .addSavingsFinishedElsewhere, .hotWalletTopUp, .hotWalletTopUpFirstRead, .hotWalletTopUpCAD, .hotWalletTopUpSafari, .hotWalletTopUpNoChromium, .send, .sendCAD, .sendKnown, .sendPicking, .sendSearching, .sendPicked, .sendTypo, .sendShortened, .sendTyping, .sendWaiting, .sendGoing, .sendSent, .sendStopped, .sendMoney, .sendMoneyCAD, .sendLookalike, .sendLookalikeChecked, .sendRefused, .sweep, .sweepCAD, .sweepStopped, .mainSecurity, .security, .securitySavings, .securityDemo, .securityReading, .securityStale, .revoke, .revokeOne: .funded
        case .siteConnect, .buy, .buyFirstRead, .buyReading, .buyCAD, .buyCADAboveRoom, .buyCADTooLittle, .buyNoRate, .hotWalletPurchasesCAD, .buyAboveRoom, .buyLarge, .buyTooLittle, .buyNegative, .buyNotSetUp, .buyCantReachProvider, .buyRefused, .hotWalletPurchases, .hotWalletPurchaseShown, .hotWalletPurchasesCantCheck: .funded
        case .buyUSDCNoGas: .noGas
        case .buyNoSavings, .buyNoSavingsAboveRoom, .buyNoSavingsCAD, .buyNoSavingsFirstRead, .receiveNoSavings, .mainEmptySpendingMoney, .mainEmptySpendingMoneySmallest: .noSavings
        case .receive, .receiveCAD, .mainEmptySavings, .routeReceive, .routeReceiveOpen: .funded
        case .receiveAlarm: .alarm
        case .siteTransaction, .siteTransactionCAD, .sitePreview, .sitePreviewUnknown, .sitePreviewLong, .siteUnlimitedApproval, .siteTypedPermit, .sitePermit2, .sitePermitRemoval: .connectedToSite
        case .hotWalletTopUpOneDollar: .nearCap
        case .hotWalletNoSavings, .hotWalletNoSavingsCAD, .popoverHotWalletNoSavings, .hotWalletTopUpNoSavings, .addSavingsFinished, .addSavingsCheckBalanceUnread, .addSavingsCheckFirstWallet: .noSavings
        case .hotWalletNoPrice: .noPrice
        case .hotWalletOverCap, .hotWalletOverCapCAD, .popoverHotWalletOverCap, .hotWalletTopUpAtCap, .buyAtCap: .overCap
        case .hotWalletOverCapNoSavings, .hotWalletTopUpNoSavingsAtCap, .buyNoSavingsAtCap, .buyNoSavingsAtCapFirstRead, .addSavingsCheckStartsSweeps, .addSavingsFinishedSweeping: .overCapNoSavings
        case .hotWalletKeyMissing, .popoverHotWalletKeyMissing: .keyMissing
        case .hotWalletAlarm, .popoverHotWalletAlarm: .alarm
        case .hotWalletReplacingKey, .settingsReplacingKey: .replacingKey
        case .hotWalletReplacedKeyShown: .replaced
        case .hotWalletReplacingKeyStuck, .walletSwitcherNewKey: .replacingKeyStuck
        case .mainNoWalletAfterDeleting: .deleted
        case .hotWalletReplacingKeyMissing: .replacingKeyMissing
        case .hotWalletSites: .usedBySites
        default: .none
        }
    }

    /// Says what's there, and fails if a scene tries to open one.
    private func browsers(defaultBrowser: InstalledBrowser, installed: [InstalledBrowser]) -> DeviceBrowsers {
        DeviceBrowsers(choice: { LedgerBrowserChoice(defaultBrowser: defaultBrowser, installed: installed) }, open: { _, _ in TestMode.fail("A scene tried to open a browser.") })
    }

    private static let chrome = InstalledBrowser(bundleID: "com.google.Chrome", name: "Google Chrome", url: URL(filePath: "/Applications/Google Chrome.app"))
    private static let safari = InstalledBrowser(bundleID: "com.apple.Safari", name: "Safari", url: URL(filePath: "/Applications/Safari.app"))

    /// For scenes that only differ in the browsers on this Mac.
    private var deviceBrowsers: DeviceBrowsers {
        switch self {
        case .hotWalletTopUpSafari, .publishFromDeviceSafari: browsers(defaultBrowser: Self.safari, installed: [Self.safari, Self.chrome])
        case .hotWalletTopUpNoChromium, .publishFromDeviceNoChromium: browsers(defaultBrowser: Self.safari, installed: [Self.safari])
        default: browsers(defaultBrowser: Self.chrome, installed: [Self.chrome])
        }
    }

    /// One step of the flow. Nothing here reaches the camera, a browser or another app: `AddSavingsMac` says what's there.
    private func addSavingsSheet(_ wallet: HotWallet, wallets: [WalletEntry]) -> AnyView {
        let other = "0x00000000000000000000000000000000000de304"
        let chrome = Self.chrome
        let safari = Self.safari
        var defaultBrowser = chrome
        var installed = [chrome]
        var ledgerWalletIsOpen = false
        var camera = AddressScanner.State.running
        var showsTrouble = false
        let model: AddSavingsModel
        switch self {
        case .hotWalletAddSavingsFilled: model = AddSavingsModel(wallet: wallet, device: .other, step: .check, address: other)
        case .hotWalletAddSavingsFromDevice:
            model = AddSavingsModel(wallet: wallet)
            model.receive(AddSavingsLink(url: URL(string: "patina://add-savings?address=\(other)&name=Ledger&linked=0x\(String(repeating: "ab", count: 20))")!)!)
        case .addSavingsLedgerPlugIn: model = AddSavingsModel(wallet: wallet, device: .ledger, step: .ledgerPlugIn)
        case .addSavingsLedgerPlugInTrouble:
            model = AddSavingsModel(wallet: wallet, device: .ledger, step: .ledgerPlugIn)
            showsTrouble = true
        case .addSavingsLedgerApp: model = AddSavingsModel(wallet: wallet, device: .ledger, step: .ledgerApp)
        case .addSavingsLedgerQuit: model = AddSavingsModel(wallet: wallet, device: .ledger, step: .ledgerQuit)
        case .addSavingsLedgerQuitStillOpen:
            model = AddSavingsModel(wallet: wallet, device: .ledger, step: .ledgerQuit)
            ledgerWalletIsOpen = true
        case .addSavingsLedgerBrowser: model = AddSavingsModel(wallet: wallet, device: .ledger, step: .ledgerBrowser)
        case .addSavingsLedgerBrowserSafari:
            model = AddSavingsModel(wallet: wallet, device: .ledger, step: .ledgerBrowser)
            defaultBrowser = safari
            installed = [safari, chrome]
        case .addSavingsLedgerBrowserNone:
            model = AddSavingsModel(wallet: wallet, device: .ledger, step: .ledgerBrowser)
            defaultBrowser = safari
            installed = [safari]
        case .addSavingsLedgerWaiting: model = AddSavingsModel(wallet: wallet, device: .ledger, step: .ledgerBrowser, waitingForBrowser: true)
        case .addSavingsLedgerPaste: model = AddSavingsModel(wallet: wallet, device: .ledger, step: .paste)
        case .addSavingsLedgerCheckTrouble:
            model = AddSavingsModel(wallet: wallet, device: .ledger, step: .check, address: other)
            showsTrouble = true
        case .addSavingsKeystoneUnlock: model = AddSavingsModel(wallet: wallet, device: .keystone, step: .keystoneUnlock)
        case .addSavingsKeystoneReceive: model = AddSavingsModel(wallet: wallet, device: .keystone, step: .keystoneReceive)
        case .addSavingsKeystoneReceiveTrouble:
            model = AddSavingsModel(wallet: wallet, device: .keystone, step: .keystoneReceive)
            showsTrouble = true
        case .addSavingsKeystoneScan: model = AddSavingsModel(wallet: wallet, device: .keystone, step: .keystoneScan)
        case .addSavingsKeystoneScanDenied:
            model = AddSavingsModel(wallet: wallet, device: .keystone, step: .keystoneScan)
            camera = .denied
        case .addSavingsKeystoneScanNoCamera:
            model = AddSavingsModel(wallet: wallet, device: .keystone, step: .keystoneScan)
            camera = .noCamera
        case .addSavingsKeystoneType: model = AddSavingsModel(wallet: wallet, device: .keystone, step: .paste)
        case .addSavingsKeystoneCheck: model = AddSavingsModel(wallet: wallet, device: .keystone, step: .check, address: other)
        case .addSavingsKeystoneWalked:
            // Every other scene starts on its step, so this is the one that shows Back.
            model = AddSavingsModel(wallet: wallet)
            model.choose(.keystone)
            model.next()
            model.next()
            model.read(other)
            if model.step != .check { TestMode.fail("This scene's walk didn't reach the check.") }
        case .addSavingsOtherPaste: model = AddSavingsModel(wallet: wallet, device: .other, step: .paste)
        case .addSavingsPicked: model = AddSavingsModel(wallet: wallet, device: .other, step: .paste, address: TestScene.namedWallet)
        case .addSavingsPickedCheck: model = AddSavingsModel(wallet: wallet, device: .other, step: .check, address: TestScene.namedWallet)
        case .addSavingsCheckStartsSweeps, .addSavingsCheckBalanceUnread, .addSavingsCheckFirstWallet: model = AddSavingsModel(wallet: wallet, device: .ledger, step: .check, address: other)
        case .addSavingsFinished, .addSavingsFinishedSweeping, .addSavingsFinishedElsewhere:
            model = AddSavingsModel(wallet: wallet, device: .ledger, step: .check, address: other)
            model.matches = true
            do { try model.add() } catch { TestMode.fail("This scene's wallet couldn't be added.") }
            if model.step != .finished { TestMode.fail("This scene's wallet wasn't added.") }
        default: model = AddSavingsModel(wallet: wallet)
        }
        let mac = AddSavingsMac(
            browsers: browsers(defaultBrowser: defaultBrowser, installed: installed),
            ledgerWalletIsOpen: { [ledgerWalletIsOpen] in ledgerWalletIsOpen },
            scanner: { [camera] in AddressScanner(fixed: camera) }
        )
        return AnyView(AddColdWalletSheet(model: model, server: URL(string: "http://127.0.0.1:8787")!, mac: mac, showsTrouble: showsTrouble, wallets: wallets))
    }

    private static let twoRules = [
        PricingRule(id: "standard", name: "Standard", summary: "Chainlink prices, and swaps where there's no price.", dataset: "benface/pricetag@0.0.8", hash: "0x8f3a11c27d4e9b05"),
        PricingRule(id: "cautious-eth", name: "Cautious ETH", summary: "The same, with ETH counted 1% lower.", dataset: "benface/pricetag_cautious@0.0.3", hash: "0x2b71c9e04fa6d813"),
    ]

    func make() -> TestScreen {
        // Registered values stay in memory, so this never reads or writes anyone's settings, as long as nothing here changes one.
        // Its own name, since older branches still save to the one they share, and what's saved there hides what's registered here.
        let defaults = SceneDefaults(suiteName: "com.benface.pricetag.mac.test-mode.scenes")!
        var registered: [String: Any] = ["currency": (TestMode.liveCurrency ?? currency).rawValue]
        if hasWallet { registered["wallet"] = TestMode.live?.wallet ?? shownWallet ?? (usesDemoWallet ? WalletAddress.demo : TestScene.emptyWallet) }
        // The longest name anyone's likely to give, where there's the least room for it.
        let wallets = switch self {
        case .mainWatchingNamedSmallest, .popoverLongName, .popoverLongNameReading: [SavedWallet(address: TestScene.namedWallet, name: "The Long-Term Family Treasury Wallet on Base", lastSeen: .distantPast)]
        case .walletSwitcherLong: TestScene.manyWallets
        default: TestScene.savedWallets
        }
        if listsWallets, let saved = try? JSONEncoder().encode(wallets) { registered["savedWallets"] = saved }
        if self == .taxReportOtherWallets || self == .taxReportLeftOver { registered["taxOtherWallets"] = "\(TestScene.recentWallet)\n0x0000000000000000000000000000000000c0ffee\n0xnope" }
        if self == .sendKnown, let book = try? JSONEncoder().encode(Book().answering(TestScene.recipient, .someoneElse, focus: nil)) { registered["answers"] = book }
        if self == .settingsAnswers, let book = try? JSONEncoder().encode(TestScene.answers), let details = try? JSONEncoder().encode(TestScene.answerDetails) {
            registered["answers"] = book
            registered["answerDetails"] = details
        }
        if self == .resolveAnsweredWallet, let book = try? JSONEncoder().encode(Book().answering(TestScene.answeredWallet, .mine, focus: nil)) { registered["answers"] = book }
        if self == .hotWalletPurchases || self == .hotWalletPurchaseShown || self == .hotWalletReplacedKeyShown || self == .hotWalletPurchasesCAD || self == .hotWalletPurchasesCantCheck, let saved = try? JSONEncoder().encode(self != .hotWalletPurchasesCantCheck ? TestScene.purchases(inCAD: self == .hotWalletPurchasesCAD) : Array(TestScene.purchases().suffix(3))) { registered["purchases"] = saved }
        defaults.register(defaults: registered)
        let cue = MotionCue()
        let source: any PortfolioSource = TestMode.live.map { PricetagClient(serverURL: $0.server) } ?? FixtureSource(feed: feed, hasRate: !hasNoRate, rules: self == .settingsRules || self == .settingsSmallDisplay ? TestScene.twoRules : [])
        // A read that's been going a while, so these show how a long one looks. The store's clock is only behind for scenes that never finish a read.
        let readStarted: TimeInterval = TestMode.live == nil && [.neverAnswers, .updating, .retrying, .retryingWithNumbers].contains(feed) && self != .mainReadingStart ? 72 : 0
        let store = PortfolioStore(defaults: defaults, makeSource: { _ in source }, now: { Date().addingTimeInterval(-readStarted) }, reachableDelay: TestMode.live == nil ? .milliseconds(50) : .seconds(30), unreachableDelay: .seconds(30))
        store.start()
        let hotWallet = hotWalletFixture.make(source: source, costMethod: { store.method }, moneyDisplay: { store.moneyDisplay })
        if !hasWallet, TestMode.live == nil, store.address != nil { TestMode.fail("This scene should start with no wallet, but it's showing \(store.address ?? "").") }
        // Never started, so it reads nothing, and only what these scenes registered is there.
        let purchases = PurchaseTracker(store: store, defaults: defaults, matchOf: { TestScene.purchaseMatches[$0] })
        // Before there's a view, which is how it'd be for anyone opening a sheet: a sheet works out what it offers when it appears.
        let hotWalletHasRead = ReadOnce()
        let readHotWallet: @MainActor () async -> Void = {
            await store.readRate()
            await hotWallet.tick()
            await hotWallet.readHistory()
            hotWalletHasRead.isDone = true
        }
        // Adding a wallet doesn't wait for this read, and neither does that scene.
        if ![.hotWalletTopUpFirstRead, .addSavingsCheckBalanceUnread, .buyFirstRead, .buyReading, .buyNoSavingsFirstRead, .buyNoSavingsAtCapFirstRead].contains(self) {
            Task { await readHotWallet() }
            let deadline = Date.now.addingTimeInterval(TestMode.readyTimeout)
            while !hotWalletHasRead.isDone {
                guard Date.now < deadline else { TestMode.fail("This scene's hot wallet never finished reading.") }
                RunLoop.main.run(until: .now.addingTimeInterval(0.01))
            }
        }
        // The real app hears about this from the wallet, which these scenes never start.
        if self == .walletSwitcherNewKey || self == .mainNoWalletAfterDeleting { store.setLinkedWallets(hotWallet.linkedWallets) }
        let navigation = Navigation(store: store, hotWallet: hotWallet)
        if self == .mainChartWeek { navigation.chartRange = .week }
        if self == .mainTransactions || self == .mainTransactionsCAD || self == .mainTransactionsSmall || self == .mainTransactionsUpdating { navigation.section = .transactions }
        if self == .mainTaxReport || self == .mainTaxReportSmall { navigation.section = .taxReport }
        if self == .mainSecurity { navigation.section = .security }
        // Once the window has its size, as when someone clicks. Before that it's too small for the details to fit beside the section.
        let opened: ExplainTarget? = switch self {
        case .mainDetails, .mainDetailsCAD: .asset(TestMode.live?.asset ?? "AERO", .realized)
        case .mainHoldDetails: .holdComparison
        case .mainFirstRunDetails: .asset("ETH", .onchain)
        default: nil
        }
        if let opened { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { navigation.target = opened } }

        let isReady: () -> Bool = { [feed] in
            if TestMode.live != nil { return store.feed == .noWallet || store.portfolio != nil }
            return switch feed {
            case .demo, .costBecomesKnown, .missingPrice, .unreadBalance, .linkedFails, .costWithheld, .costOnSavings, .smallAmounts, .longHistory, .answeredWallet, .allAnswered, .empty, .emptyReadingLinked, .notStarted, .firstRun: store.feed == .noWallet || store.portfolio != nil
            case .updating: store.portfolio != nil
            case .neverAnswers: true
            case .serverDown: store.feed == .serverUnreachable
            case .pricesDown: store.feed.isStale
            case .pricesStop: store.feed.isStale && store.portfolio != nil
            case .tooSlow: store.feed == .tooSlow
            case .retrying: store.feed.isStale && store.readingSince != nil
            case .retryingWithNumbers: store.feed.isStale && store.readingSince != nil && store.portfolio != nil
            case .notStartedFails: store.feed.isStale && store.portfolio != nil
            case .stopsAnswering: store.feed == .serverUnreachable && store.portfolio != nil
            }
        }
        switch self {
        case .chartHover:
            cue.scrubbed = 6
            return TestScreen(view: AnyView(MotionChartScene(store: store, cue: cue)), isReady: isReady)
        case .motionChartDraw:
            return TestScreen(view: AnyView(MotionChartScene(store: store, cue: cue)), isReady: isReady, play: {
                forgetDrawnCharts()
                cue.revision += 1
            })
        case .motionChartRange:
            return TestScreen(view: AnyView(MotionChartScene(store: store, cue: cue)), isReady: isReady, play: { cue.range = .week })
        case .motionChartScrub:
            return TestScreen(view: AnyView(MotionChartScene(store: store, cue: cue)), isReady: isReady, play: {
                Task {
                    for index in 2...6 {
                        cue.scrubbed = index
                        try? await Task.sleep(for: .seconds(0.3 * Motion.slowdown))
                    }
                }
            })
        case .motionSend:
            return TestScreen(view: AnyView(MotionSendScene(cue: cue)), isReady: { true }, play: {
                Task {
                    try? await Task.sleep(for: .seconds(0.4))
                    cue.stage = .onItsWay
                    try? await Task.sleep(for: .seconds(0.8))
                    cue.stage = .finished("Sent")
                }
            })
        case .motionPurchase:
            return TestScreen(view: AnyView(MotionPurchaseScene(cue: cue)), isReady: { true }, play: {
                Task {
                    try? await Task.sleep(for: .seconds(0.4))
                    cue.purchase = .arriving
                    try? await Task.sleep(for: .seconds(0.8))
                    cue.purchase = .recorded(Money(micros: "25810000", currency: .USD))
                }
            })
        case .motionCostKnown:
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet), purchases: purchases)), size: CGSize(width: 1120, height: 820), isReady: isReady, play: {
                FixtureSource.costIsKnown.withLock { $0 = true }
                store.start()
            })
        case .motionDetails:
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet), purchases: purchases)), size: CGSize(width: 1120, height: 760), isReady: isReady, play: {
                navigation.target = .asset("AERO", .realized)
            })
        case .increasedContrast:
            return TestScreen(view: AnyView(ContrastScene(store: store)), isReady: isReady)
        case .resolve, .resolveCostWithheld, .resolveAnsweredWallet, .resolveFinished:
            return TestScreen(view: AnyView(ResolveFlow(store: store)), size: CGSize(width: 520, height: 560), isReady: isReady)
        case .resolvePublishFromDevice:
            return TestScreen(view: AnyView(ResolveFlow(store: store, noteWriter: SavingsNoteWriter()) { AnyView(PublishFromDeviceButton(link: $0, browsers: deviceBrowsers)) }), size: CGSize(width: 520, height: 560), isReady: isReady)
        case .holdComparison:
            return TestScreen(view: AnyView(HoldComparisonScene()), isReady: { true })
        case .mainShowingSpendingMoney, .mainSavings, .mainWatching, .mainWatchingNamed, .mainEmptySpendingMoney, .mainEmptySavings:
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet), purchases: purchases)), size: CGSize(width: 1120, height: 760), isReady: isReady)
        case .mainWatchingNamedSmallest:
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet), purchases: purchases)), size: MainWindow.minimumSize, isReady: isReady)
        case .mainNoWalletHasSpendingMoney, .mainNoWalletNotProvisioned:
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet), purchases: purchases)), size: CGSize(width: 1120, height: 760), isReady: isReady)
        case .mainNoWalletAfterDeleting, .mainChartWeek, .mainFirstRun, .mainFirstRunDetails, .main, .mainTransactions, .mainDetails, .mainHoldDetails, .mainNoWallet, .mainNoWalletSaved, .mainReading, .mainReadingStart, .mainUpdating, .mainUpdatingCAD, .mainTransactionsUpdating, .mainServerDown, .mainPricesDown, .mainPricesStop, .mainTooSlow, .mainRetrying, .mainRetryingNumbers, .mainNotStartedFailing, .mainNotUpdating, .mainLinkedFailed, .mainEmpty, .mainEmptyNotice, .mainNotStarted, .mainCostWithheld, .mainSmallAmounts, .mainLongHistory, .mainCAD, .mainTransactionsCAD, .mainDetailsCAD:
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet), purchases: purchases)), size: CGSize(width: 1120, height: 760), isReady: isReady)
        case .mainSmallestEnd:
            // Starts at the end of the page, because a screenshot can't scroll to it.
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet), purchases: purchases).defaultScrollAnchor(.bottom)), size: CGSize(width: 780, height: 560), isReady: isReady)
        case .mainEmptySmallest, .mainSmallest, .mainFirstRunSmallest, .mainEmptySpendingMoneySmallest:
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet), purchases: purchases)), size: CGSize(width: 780, height: 560), isReady: isReady)
        case .mainNarrow, .mainSmallAmountsNarrow, .mainUpdatingNarrow:
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet), purchases: purchases)), size: CGSize(width: 780, height: 760), isReady: isReady)
        case .mainSmall, .mainUpdatingSmall, .mainNotUpdatingSmall, .mainFirstRunSmall, .mainTransactionsSmall, .mainSpendingMoneySmall, .mainTaxReportSmall, .mainNoWalletSmall, .mainNoWalletSavedSmall:
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet), purchases: purchases)), size: MainWindow.minimumSize, isReady: isReady)
        case .mainMedium, .mainSpendingMoney, .mainSpendingMoneyServerDown, .mainTaxReport:
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet), purchases: purchases)), size: CGSize(width: 900, height: 640), isReady: isReady)
        case .mainWidth660, .mainWidth760, .mainWidth860, .mainWidth960, .mainWidth1040:
            let width = CGFloat(Int(rawValue.split(separator: "-").last ?? "") ?? 900)
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet), purchases: purchases)), size: CGSize(width: width, height: 760), isReady: isReady)
        case .mainHuge:
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet), purchases: purchases)), size: CGSize(width: 2200, height: 1300), isReady: isReady)
        case .mainMissingPrice:
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet), purchases: purchases)), size: CGSize(width: 1120, height: 760), isReady: isReady)
        case .routeRemoveFromSavingsOpen, .routeBuy, .routeBuyOpen, .routeReceive, .routeReceiveOpen, .routeAddSavings, .routeSend, .routeSendOpen, .routeTopUp, .routeTopUpOpen, .routeHoldings, .routeHoldingsOpen, .routeAddWallet, .routeAddWalletOpen, .routeDetails, .routeDetailsOpen, .routeAnswer, .routeAnswerOpen:
            let press: () -> Void
            let hasArrived: () -> Bool
            let hasSheet = { NSApp.windows.contains { $0.attachedSheet != nil } }
            let isOnSpendingMoney = { navigation.section == .overview && hotWallet.address != nil && store.address == hotWallet.address?.lowercased }
            switch self {
            case .routeSend, .routeSendOpen:
                press = navigation.send
                hasArrived = { !navigation.wantsSend && isOnSpendingMoney() && hasSheet() }
            case .routeTopUp, .routeTopUpOpen:
                press = navigation.topUp
                hasArrived = { !navigation.wantsTopUp && isOnSpendingMoney() && hasSheet() }
            case .routeBuy, .routeBuyOpen:
                press = { navigation.isBuying = true }
                hasArrived = { navigation.isBuying && hasSheet() }
            case .routeReceive, .routeReceiveOpen:
                press = { navigation.isReceiving = true }
                hasArrived = { navigation.isReceiving && hasSheet() }
            case .routeAddSavings:
                press = navigation.addSavings
                hasArrived = { !navigation.wantsAddSavings && isOnSpendingMoney() && hasSheet() }
            case .routeHoldings, .routeHoldingsOpen:
                navigation.section = .transactions
                press = navigation.showOverview
                hasArrived = { navigation.section == .overview }
            case .routeAddWallet, .routeAddWalletOpen:
                navigation.section = .transactions
                press = navigation.showOverview
                hasArrived = { navigation.section == .overview && store.feed == .noWallet }
            case .routeDetails, .routeDetailsOpen:
                navigation.section = .transactions
                press = { navigation.explain(.asset("AERO", .amount)) }
                hasArrived = { navigation.section == .overview && navigation.target != nil }
            case .routeRemoveFromSavingsOpen:
                // As the list's row does it: the list closes in the same moment, and the question still has to appear.
                navigation.section = .overview
                navigation.isSwitchingWallet = true
                press = {
                    navigation.isSwitchingWallet = false
                    navigation.removingFromSavings = WalletEntry(address: HotWalletFixture.savings.lowercased, name: "Ledger", kind: .savings)
                }
                hasArrived = { !navigation.isSwitchingWallet && navigation.removingFromSavings != nil && NSApp.windows.contains { $0.attachedSheet != nil } }
            default:
                navigation.section = .transactions
                press = { navigation.resolve() }
                hasArrived = { navigation.isResolving && hasSheet() }
            }
            // A closed window has no section on screen yet, so it finds where to go when it appears.
            var pressedAt: Date?
            if !rawValue.hasSuffix("-open") {
                press()
                pressedAt = .now
            }
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet), purchases: purchases)), size: CGSize(width: 900, height: 640), isReady: {
                guard isReady() else { return false }
                if pressedAt == nil {
                    press()
                    pressedAt = .now
                }
                // Long enough for whatever reacts to the change to have run, because arriving doesn't count if something then undoes it.
                return Date.now.timeIntervalSince(pressedAt ?? .now) > 0.5 && hasArrived()
            })
        case .walletSwitcherNote, .walletSwitcherNewKey, .walletSwitcher, .walletSwitcherFirstRun, .walletSwitcherRenaming, .walletSwitcherProblem, .walletSwitcherLong:
            let switcher = WalletSwitcher(store: store, hotWallet: hotWallet, pendingName: self == .walletSwitcherRenaming ? PendingWalletName(address: TestScene.namedWallet, text: "Treasury") : PendingWalletName(), onOpenSpendingMoney: {}, onRemoveFromSavings: { _ in }, onDeleteSpendingMoney: {}, onDone: {}, input: self == .walletSwitcherProblem ? "0x1234…abcd" : "", note: self == .walletSwitcherNote ? WalletListNote(text: Wording.movedToYours, undo: {}) : nil)
            return TestScreen(view: AnyView(switcher.background(.background)), isReady: isReady)
        case .taxReport, .taxReportAddedWallet:
            let view = TaxReportView(store: store, model: TaxReportModel(defaults: defaults, currency: store.currency, fetch: { try await store.taxReport($0) }), onResolve: { _ in }, onOpen: { _ in })
            return TestScreen(view: AnyView(view.frame(width: 640, height: 1240).background(.background)), isReady: isReady)
        case .taxReportOtherWallets, .taxReportLeftOver:
            let view = TaxReportView(store: store, wallets: store.walletList(hotWallet: hotWallet).pickable, readAddress: AddressText.readAnywhere, addingWallet: self == .taxReportLeftOver ? "0x2222 0x33zz" : "", model: TaxReportModel(defaults: defaults, currency: store.currency, fetch: { try await store.taxReport($0) }))
            return TestScreen(view: AnyView(view.frame(width: 640, height: 640).background(.background)), isReady: isReady)
        case .spendingMoneySetupSheet:
            return TestScreen(view: AnyView(SpendingMoneySetup(wallet: hotWallet, store: store, onDone: {}).frame(width: 480, height: 400)), isReady: isReady)
        case .popoverLongName, .popoverLongNameReading, .popover, .popoverNoWallet, .popoverNotUpdating, .popoverNotStarted, .popoverFirstRun, .popoverCAD, .popoverHotWallet, .popoverHotWalletOverCap, .popoverHotWalletAlarm, .popoverHotWalletCAD, .popoverReading, .popoverUpdating, .popoverServerDown, .popoverPricesDown, .popoverRetrying, .popoverEmpty, .popoverHotWalletNoSavings, .popoverHotWalletKeyMissing, .popoverNotProvisioned, .popoverMissingPrice, .popoverUnreadBalance:
            return TestScreen(view: AnyView(PopoverView(store: store, hotWallet: hotWallet, navigation: navigation)), isReady: isReady)
        case .menuBarLabel:
            return TestScreen(view: AnyView(MenuBarLabelScene(portfolio: { store.portfolio })), isReady: isReady)
        case .settings, .settingsRules, .settingsSmallDisplay, .settingsServer, .settingsServerProblem, .settingsNoHotWallet, .settingsHotWallet, .settingsHotWalletProblem, .settingsCAD, .settingsHotWalletCAD, .settingsHotWalletNoRate, .settingsReplacingKey, .settingsAnswers, .settingsAnswersEmpty, .settingsNotificationsOff:
            let pane: SettingsView.Pane = switch self {
            case .settingsServer, .settingsServerProblem: .server
            case .settingsAnswers, .settingsAnswersEmpty: .answers
            case .settingsNoHotWallet, .settingsHotWallet, .settingsHotWalletProblem, .settingsHotWalletCAD, .settingsHotWalletNoRate, .settingsReplacingKey: .spendingMoney
            default: .general
            }
            let view = SettingsView(
                store: store,
                hotWallet: hotWallet,
                notifications: MoneyNotifications(center: nil, defaults: defaults, authorization: self == .settingsNotificationsOff ? .denied : .authorized),
                tab: .constant(pane),
                server: self == .settingsServerProblem ? "localhost 8787" : "",
                serverError: self == .settingsServerProblem ? "That isn't a web address. It should look like \(PortfolioStore.defaultServerURL.absoluteString)." : nil,
                rpc: self == .settingsHotWalletProblem ? "base rpc" : "",
                rpcError: self == .settingsHotWalletProblem ? "That isn't a network address. It should look like \(Base.publicRPC.absoluteString)." : nil,
                displayRoom: self == .settingsSmallDisplay ? 240 : nil
            )
            return TestScreen(view: AnyView(view), isReady: isReady)
        case .hotWalletSetup, .hotWalletNotProvisioned, .hotWalletUnreadable:
            return TestScreen(view: AnyView(HotWalletWindow(wallet: hotWallet, store: store, siteBridge: SiteBridge(wallet: hotWallet), navigation: navigation, purchases: purchases)), size: CGSize(width: 560, height: 720), isReady: isReady)
        case .hotWallet, .hotWalletRecordShown, .hotWalletCAD, .hotWalletNoRate, .hotWalletNoSavings, .hotWalletNoSavingsCAD, .hotWalletNoPrice, .hotWalletOverCap, .hotWalletOverCapCAD, .hotWalletOverCapNoSavings, .hotWalletKeyMissing, .hotWalletAlarm, .hotWalletReplacingKey, .hotWalletReplacingKeyStuck, .hotWalletReplacingKeyMissing, .hotWalletSites:
            // The manual sweep, which is a row in the middle of the activity.
            if self == .hotWalletRecordShown { navigation.show(row: MoneyNotice.recordRow("0xde4" + String(repeating: "0", count: 59) + "20")) }
            // Taller than it opens, because a screenshot can't scroll to the actions and the activity at the bottom.
            return TestScreen(view: AnyView(HotWalletWindow(wallet: hotWallet, store: store, siteBridge: SiteBridge(wallet: hotWallet), navigation: navigation, purchases: purchases)), size: CGSize(width: 560, height: 1200), isReady: isReady)
        case .hotWalletAddSavings, .hotWalletAddSavingsFilled, .hotWalletAddSavingsFromDevice, .addSavingsLedgerPlugIn, .addSavingsLedgerPlugInTrouble, .addSavingsLedgerApp, .addSavingsLedgerQuit, .addSavingsLedgerQuitStillOpen, .addSavingsLedgerBrowser, .addSavingsLedgerBrowserSafari, .addSavingsLedgerBrowserNone, .addSavingsLedgerWaiting, .addSavingsLedgerPaste, .addSavingsLedgerCheckTrouble, .addSavingsKeystoneUnlock, .addSavingsKeystoneReceive, .addSavingsKeystoneReceiveTrouble, .addSavingsKeystoneScan, .addSavingsKeystoneScanDenied, .addSavingsKeystoneScanNoCamera, .addSavingsKeystoneType, .addSavingsKeystoneCheck, .addSavingsKeystoneWalked, .addSavingsOtherPaste, .addSavingsPicked, .addSavingsPickedCheck, .addSavingsCheckStartsSweeps, .addSavingsCheckBalanceUnread, .addSavingsCheckFirstWallet, .addSavingsFinished, .addSavingsFinishedSweeping, .addSavingsFinishedElsewhere:
            return TestScreen(view: addSavingsSheet(hotWallet, wallets: store.walletList(hotWallet: hotWallet).pickable), isReady: isReady)
        case .receive, .receiveNoSavings, .receiveCAD, .receiveNotSetUp, .receiveAlarm:
            return TestScreen(view: AnyView(ReceiveSheet(wallet: hotWallet) {}), isReady: isReady)
        case .buy, .buyCAD, .buyCADAboveRoom, .buyCADTooLittle, .buyNoRate, .buyAboveRoom, .buyLarge, .buyAtCap, .buyUSDCNoGas, .buyNoWallet, .buyTooLittle, .buyNegative, .buyNoSavings, .buyNoSavingsAboveRoom, .buyNoSavingsAtCap, .buyNoSavingsCAD, .buyFirstRead, .buyReading, .buyNoSavingsFirstRead, .buyNoSavingsAtCapFirstRead, .buyNotSetUp, .buyCantReachProvider, .buyRefused:
            let typed: Int? = switch self {
            case .buyAboveRoom, .buyCADAboveRoom, .buyNoSavingsAboveRoom: 100
            case .buyLarge: 5000
            case .buyAtCap, .buyUSDCNoGas: 50
            case .buyTooLittle, .buyCADTooLittle: 2
            case .buyNegative: -5
            default: nil
            }
            let failure: String? = switch self {
            case .buyNotSetUp: "Buying isn't set up on this server."
            case .buyCantReachProvider: "Coinbase can't be reached right now."
            case .buyRefused: "Coinbase said: This project has reached its trial limit. Complete onboarding to continue."
            default: nil
            }
            let sheet = BuySheet(wallet: hotWallet, purchases: purchases, typed: typed, asset: self == .buyUSDCNoGas ? .usdc : .eth, failure: failure) {} addSavings: {}
            // These open before the first read, so the read has to change the amount it starts at.
            if [.buyFirstRead, .buyNoSavingsFirstRead, .buyNoSavingsAtCapFirstRead].contains(self) {
                return TestScreen(view: AnyView(sheet.task { await readHotWallet() }), isReady: { hotWalletHasRead.isDone })
            }
            // Never read, to show what it says while it waits.
            if self == .buyReading { return TestScreen(view: AnyView(sheet), isReady: { true }) }
            return TestScreen(view: AnyView(sheet), isReady: isReady)
        case .hotWalletPurchases, .hotWalletPurchaseShown, .hotWalletReplacedKeyShown, .hotWalletPurchasesCAD, .hotWalletPurchasesCantCheck:
            if self == .hotWalletPurchaseShown { navigation.show(row: MoneyNotice.purchaseRow("recorded")) }
            // The old key's manual sweep, which isn't shown anymore.
            if self == .hotWalletReplacedKeyShown { navigation.show(row: MoneyNotice.recordRow("0xde4" + String(repeating: "0", count: 59) + "20")) }
            // It keeps few enough that checking has nothing to trim, because that would save over what's registered here.
            if purchases.purchases.isEmpty { TestMode.fail("This scene's purchases weren't read. Something saved over them.") }
            return TestScreen(view: AnyView(HotWalletWindow(wallet: hotWallet, store: store, siteBridge: SiteBridge(wallet: hotWallet), navigation: navigation, purchases: purchases).task { if self == .hotWalletPurchasesCantCheck { await purchases.check() } }), size: CGSize(width: 780, height: 900), isReady: isReady)
        case .hotWalletTopUp, .hotWalletTopUpOneDollar, .hotWalletTopUpAtCap, .hotWalletTopUpNoSavings, .hotWalletTopUpNoSavingsAtCap, .hotWalletTopUpCAD, .hotWalletTopUpSafari, .hotWalletTopUpNoChromium:
            return TestScreen(view: AnyView(TopUpSheet(wallet: hotWallet, server: URL(string: "http://127.0.0.1:8787")!, browsers: deviceBrowsers)), isReady: isReady)
        case .hotWalletTopUpFirstRead:
            // The sheet opens first here, so the read has to change what it worked out.
            return TestScreen(view: AnyView(TopUpSheet(wallet: hotWallet, server: URL(string: "http://127.0.0.1:8787")!, browsers: deviceBrowsers).task { await readHotWallet() }), isReady: { hotWalletHasRead.isDone })
        case .send, .sendCAD, .sendKnown, .sendPicking, .sendSearching, .sendPicked, .sendTypo, .sendShortened, .sendTyping, .sendWaiting, .sendGoing, .sendSent, .sendStopped, .sendMoney, .sendMoneyCAD, .sendLookalike, .sendLookalikeChecked, .sendRefused:
            let model = SendModel(wallet: hotWallet, store: store)
            model.token = Base.tokens.first { $0.symbol == "USDC" }!
            model.amountText = "12.50"
            model.addressText = switch self {
            case .sendPicking: ""
            case .sendSearching: "tre"
            case .sendPicked: TestScene.namedWallet
            // One letter's case changed in a checksummed address.
            case .sendTypo: "0x52908400098527886e0F7030069857D2E4169EE7"
            case .sendShortened: "0x3762…5D89"
            case .sendTyping: "0x5290840009852788"
            // Starts and ends like Treasury's, the way a poisoned address does.
            case .sendLookalike, .sendLookalikeChecked: "0x0007b3e9a14c5d2f60e8b91a7c3d5e2f4a6c0e01"
            default: TestScene.recipient
            }
            if self == .sendLookalikeChecked { model.acceptsLookalike = true }
            if self == .sendMoney || self == .sendMoneyCAD {
                model.switchUnit()
                model.amountText = "25"
            }
            switch self {
            // Touch ID's part never happens here: this only draws what's around it.
            case .sendWaiting: return TestScreen(view: AnyView(SendConfirmation(model: model, gate: .scene(.asking), done: {}).frame(width: 460)), isReady: isReady)
            case .sendGoing: return TestScreen(view: AnyView(SendConfirmation(model: model, gate: .scene(.working), done: {}).frame(width: 460)), isReady: isReady)
            case .sendSent: return TestScreen(view: AnyView(SendConfirmation(model: model, gate: .scene(.done), done: {}).frame(width: 460)), isReady: isReady)
            case .sendStopped: return TestScreen(view: AnyView(SendConfirmation(model: model, gate: .scene(.stopped(nil)), done: {}).frame(width: 460)), isReady: isReady)
            case .sendRefused: return TestScreen(view: AnyView(SendConfirmation(model: model, gate: .scene(.stopped(HotWalletWording.notSent("insufficient funds for gas * price + value"))), done: {}).frame(width: 460)), isReady: isReady)
            default: return TestScreen(view: AnyView(SendSheet(model: model, wallets: store.walletList(hotWallet: hotWallet).pickable)), isReady: isReady)
            }
        case .mainSecurity:
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet), purchases: purchases)), size: CGSize(width: 1120, height: 900), isReady: isReady)
        case .security, .securitySavings, .securityDemo, .securityReading, .securityStale, .securityNoSpendingMoney:
            guard let address = store.address else { TestMode.fail("This scene has no wallet to show.") }
            let reads = ReadOnce()
            let model = ApprovalsModel(address: address) { [self] in
                if self == .securityReading { try await Task.sleep(for: .seconds(3600)) }
                // The second read fails, so what the first found is what's showing.
                if self == .securityStale, await MainActor.run(body: { reads.isDone }) { throw FetchError.unreachable }
                return try await store.approvals(address: $0)
            }
            if self != .securityReading {
                Task {
                    await model.load()
                    reads.isDone = true
                    if self == .securityStale { await model.load() }
                }
            }
            let page = SecurityPage(store: store, hotWallet: hotWallet, navigation: navigation, readBasics: { MacBasics(hasPassword: true, fileVaultOn: nil) }, approvalsModel: model)
            return TestScreen(view: AnyView(page.frame(width: 860, height: 1560).background(.background)), isReady: { [self] in isReady() && (self == .securityReading || model.approvals != nil) && (self != .securityStale || model.refreshFailure != nil) })
        case .revoke, .revokeOne:
            guard let approvals: WalletApprovals = try? FixtureSource.decode("demo-approvals") else { TestMode.fail("There's no approvals fixture.") }
            let revocations = approvals.approvals.compactMap(Revocation.init)
            let quote = RevocationQuote(feeWei: 4_000_000_000_000, feeUsdMicros: 14_000, transactions: self == .revokeOne ? 1 : 3)
            return TestScreen(view: AnyView(RevokeSheet(wallet: hotWallet, revocations: self == .revokeOne ? [revocations[0]] : revocations, quote: quote, gate: .scene(.asking))), isReady: isReady)
        case .sweep, .sweepCAD:
            return TestScreen(view: AnyView(SweepSheet(wallet: hotWallet, gate: .scene(.asking))), isReady: isReady)
        case .sweepStopped:
            let problem = HotWalletWording.sweptOnlySome(onItsWay: ["USDC"], left: ["ETH"], because: "A sweep of ETH didn't go out. \(HotWalletWording.refusal("insufficient funds"))")
            return TestScreen(view: AnyView(SweepSheet(wallet: hotWallet, gate: .scene(.stopped(problem)))), isReady: isReady)
        case .siteSend, .siteSendToken, .siteLongAmount, .siteCall, .siteApprove, .siteUnlimited, .siteUnlimitedAcknowledged, .siteMessage, .siteMessageUnreadable, .siteStopped, .siteNext, .siteBehind, .siteRefocused, .siteSending, .siteSent, .siteSigning, .siteSigned, .siteFailure, .siteFailureMessage:
            return siteScreen(hotWallet: hotWallet, isReady: isReady)
        case .publishCost, .publishCAD, .publishWaiting:
            let draft = CostNoteDraft(wallet: "0x00000000000000000000000000000000000de301", txHash: "0x" + String(repeating: "ab", count: 32), asset: "USDC", decimals: 6, units: "250000000")
            return TestScreen(view: AnyView(PublishCostSheet(draft: draft, currency: currency, typed: "250", publish: { _ in false }, problem: { nil }, isPublishing: { [self] in self == .publishWaiting })), isReady: isReady)
        case .publishFromDevice, .publishFromDeviceSafari, .publishFromDeviceNoChromium:
            // What the button's popover holds, because a render has no popovers. The page itself isn't part of this.
            return TestScreen(view: AnyView(PublishFromDeviceOffer(link: URL(string: "http://127.0.0.1:8787")!, browsers: deviceBrowsers, done: {}).background(.background)), isReady: { true })
        case .ruleComparison, .ruleComparisonCAD:
            if TestMode.live != nil { return TestScreen(view: AnyView(RuleComparisonSheet(store: store)), isReady: isReady) }
            guard let comparison: RuleComparison = try? FixtureSource.decode(self == .ruleComparison ? "demo-rule-comparison" : "demo-rule-comparison-cad") else { TestMode.fail("There's no comparison fixture.") }
            return TestScreen(view: AnyView(RuleComparisonTable(comparison: comparison).padding(20).frame(width: 720).background(.background)), isReady: { true })
        case .siteConnect, .siteTransaction, .siteTransactionCAD, .sitePreview, .sitePreviewUnknown, .sitePreviewLong, .siteUnlimitedApproval, .siteTypedPermit, .sitePermit2, .sitePermitRemoval:
            guard let wallet = hotWallet.address?.lowercased else { TestMode.fail("This scene's hot wallet has no address.") }
            let bridge = SiteBridge(wallet: hotWallet)
            let request = siteRequest(from: wallet)
            // Through the real checks and wording, up to the window. Nothing answers it there, so it goes no further.
            _ = bridge.begin(SiteRequest(connection: UUID(), id: "1", origin: HotWalletFixture.site, method: request.method, parameters: request.parameters))
            let armed = ContinuousClock.now + SiteApprovalView.armingDelay
            // The long one as a laptop would show it, whatever screen this runs on.
            let heightLimit: CGFloat? = self == .sitePreviewLong ? 760 : nil
            return TestScreen(view: AnyView(SiteApprovalWindow(bridge: bridge).environment(\.confirmationHeightLimit, heightLimit).navigationTitle(SiteApprovalWindow.title)), isReady: { bridge.current != nil && ContinuousClock.now >= armed })
        }
    }

    /// One purchase in each state it can be in.
    private static func purchases(inCAD: Bool = false) -> [TrackedPurchase] {
        let wallet = HotWalletFixture.spending.lowercased
        let hash = "0x" + String(repeating: "ab", count: 32)
        let paid = Money(micros: "25810000", currency: inCAD ? .CAD : .USD)
        func delivered(_ id: String) -> OnrampOrder {
            OnrampOrder(id: id, status: .succeeded, asset: "ETH", units: "8000000000000000", wallet: wallet, network: "base", txHash: hash, blockNum: 50, cost: paid)
        }
        func purchase(_ ref: String, dollars: Int, typed: PricetagKit.Money? = nil, asset: String = "ETH", at age: TimeInterval = 60, _ order: OnrampOrder? = nil) -> TrackedPurchase {
            TrackedPurchase(ref: ref, wallet: wallet, asset: asset, dollars: dollars, typed: typed, startedAt: .now.addingTimeInterval(-age), order: order)
        }
        return [
            purchase("gone", dollars: 10, at: 3 * 60 * 60),
            purchase("no-delivery", dollars: 15, OnrampOrder(id: "no-delivery", status: .failed, failure: .delivery)),
            purchase("no-payment", dollars: 20, asset: "USDC", OnrampOrder(id: "no-payment", status: .failed, failure: .payment)),
            purchase("held", dollars: 25, OnrampOrder(id: "held", status: .succeeded, asset: "ETH", units: "8000000000000000", wallet: wallet, network: "base", txHash: hash, blockNum: 50)),
            purchase("no-rate", dollars: 25, OnrampOrder(id: "no-rate", status: .succeeded, asset: "ETH", units: "8000000000000000", wallet: wallet, network: "base", txHash: hash, blockNum: 50, paidIn: "SEK")),
            purchase("different", dollars: 25, delivered("different")),
            purchase("recorded", dollars: 25, delivered("recorded")),
            purchase("recorded-eur", dollars: 25, OnrampOrder(id: "recorded-eur", status: .succeeded, asset: "ETH", units: "8000000000000000", wallet: wallet, network: "base", txHash: hash, blockNum: 50, cost: Money(micros: "23150000", currency: .EUR))),
            purchase("arriving", dollars: 25, delivered("arriving")),
            purchase("going", dollars: 30, typed: inCAD ? Money(micros: "42000000", currency: .CAD) : nil, OnrampOrder(id: "going", status: .pending)),
            purchase("page", dollars: 20, typed: inCAD ? Money(micros: "28000000", currency: .CAD) : nil),
        ]
    }

    private static let purchaseMatches: [String: PurchaseMatch.State] = ["different": .unmatched, "recorded": .recorded, "recorded-eur": .recorded, "arriving": .waiting]

    /// What a site asks for in each of its scenes.
    private func siteRequest(from wallet: String) -> (method: String, parameters: JSONValue?) {
        let spender = "4444444444444444444444444444444444444444"
        guard let usdc = Base.tokens.first(where: { $0.symbol == "USDC" })?.contract?.lowercased else { TestMode.fail("There's no USDC.") }
        func transaction(to: String, value: String, data: String) -> (String, JSONValue?) {
            ("eth_sendTransaction", .array([.object(["from": .string(wallet), "to": .string(to), "value": .string(value), "data": .string(data)])]))
        }
        switch self {
        case .siteTransaction, .siteTransactionCAD:
            return transaction(to: "0x3333333333333333333333333333333333333333", value: "0x71afd498d0000", data: "0x12345678" + String(repeating: "0", count: 24) + spender)
        case .sitePreview:
            return transaction(to: HotWalletFixture.swapRouter, value: "0x0", data: "0x12345678")
        case .sitePreviewUnknown:
            return transaction(to: HotWalletFixture.unknownRouter, value: "0x71afd498d0000", data: "0x12345678")
        case .sitePreviewLong:
            return transaction(to: HotWalletFixture.longRouter, value: "0x0", data: "0x12345678")
        case .siteUnlimitedApproval:
            return transaction(to: usdc, value: "0x0", data: "0x095ea7b3" + String(repeating: "0", count: 24) + spender + String(repeating: "f", count: 64))
        case .siteTypedPermit:
            let permit = #"{"domain":{"name":"USD Coin","version":"2","chainId":8453,"verifyingContract":"\#(usdc)"},"types":{"Permit":[{"name":"owner","type":"address"},{"name":"spender","type":"address"},{"name":"value","type":"uint256"},{"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"}]},"primaryType":"Permit","message":{"owner":"\#(wallet)","spender":"0x\#(spender)","value":"115792089237316195423570985008687907853269984665640564039457584007913129639935","nonce":"0","deadline":"1793836800"}}"#
            return ("eth_signTypedData_v4", .array([.string(wallet), .string(permit)]))
        case .sitePermitRemoval:
            // A request to take an allowance back to nothing, which only does that if it's sent.
            let permit = #"{"domain":{"name":"USD Coin","version":"2","chainId":8453,"verifyingContract":"\#(usdc)"},"types":{"Permit":[{"name":"owner","type":"address"},{"name":"spender","type":"address"},{"name":"value","type":"uint256"},{"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"}]},"primaryType":"Permit","message":{"owner":"\#(wallet)","spender":"0x6ff5693b99212da76ad316178a184ab56d299b43","value":"0","nonce":"1","deadline":"1793838600"}}"#
            return ("eth_signTypedData_v4", .array([.string(wallet), .string(permit)]))
        case .sitePermit2:
            // 250 USDC for Uniswap's router, through Permit2, for 30 days from 2026-11-05.
            let permit = #"{"domain":{"name":"Permit2","chainId":8453,"verifyingContract":"0x000000000022d473030f116ddee9f6b43ac78ba3"},"types":{"PermitSingle":[{"name":"details","type":"PermitDetails"},{"name":"spender","type":"address"},{"name":"sigDeadline","type":"uint256"}],"PermitDetails":[{"name":"token","type":"address"},{"name":"amount","type":"uint160"},{"name":"expiration","type":"uint48"},{"name":"nonce","type":"uint48"}]},"primaryType":"PermitSingle","message":{"details":{"token":"\#(usdc)","amount":"250000000","expiration":"1796428800","nonce":"0"},"spender":"0x6ff5693b99212da76ad316178a184ab56d299b43","sigDeadline":"1793838600"}}"#
            return ("eth_signTypedData_v4", .array([.string(wallet), .string(permit)]))
        default:
            return ("eth_requestAccounts", nil)
        }
    }

    /// The approval window in each state, from what a real request reads as. Its buttons answer nothing, so nothing can get as far as a key.
    private func siteScreen(hotWallet: HotWallet, isReady: @escaping () -> Bool) -> TestScreen {
        let site = "https://app.uniswap.org"
        let usdc = EthereumAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")!
        let friend = EthereumAddress("0x0000000000000000000000000000000000c0ffee")!
        let word = { (bytes: [UInt8]) in [UInt8](repeating: 0, count: 32 - bytes.count) + bytes }
        let address = word(Hex.decode(friend.lowercased) ?? [])
        let transfer = [0xA9, 0x05, 0x9C, 0xBB] + address + word([0x0B, 0xEB, 0xC2, 0x00])
        let limited = [0x09, 0x5E, 0xA7, 0xB3] + address + word([0x02, 0xFA, 0xF0, 0x80])
        let approval: SiteApproval
        var phase = ApprovalPrompt.Phase.asking
        var waitingBehind = 0
        switch self {
        case .siteSendToken, .siteStopped, .siteSending, .siteSent: approval = .sceneTransaction(origin: site, to: usdc, data: transfer)
        case .siteLongAmount: approval = .sceneTransaction(origin: site, to: friend, value: 123_456_789_012_345_678)
        case .siteCall: approval = .sceneTransaction(origin: site, to: friend, value: 1_000_000_000_000_000, data: [0xDE, 0xAD, 0xBE, 0xEF] + address)
        case .siteApprove: approval = .sceneTransaction(origin: site, to: usdc, data: limited)
        case .siteUnlimited, .siteUnlimitedAcknowledged: approval = .sceneUnlimitedApproval(origin: site, token: usdc, spender: friend)
        case .siteMessage, .siteSigning, .siteSigned: approval = .sceneMessage(origin: site, text: "Sign in to Uniswap\n\nThis doesn't cost anything.\nNonce: 8f2a91c4")
        case .siteMessageUnreadable: approval = .sceneUnreadableMessage(origin: site)
        default: approval = .sceneTransaction(origin: site, to: friend, value: 2_000_000_000_000_000)
        }
        if self == .siteStopped { phase = .stopped(nil) }
        if self == .siteBehind { phase = .waiting }
        if self == .siteUnlimited || self == .siteMessageUnreadable { phase = .needsAcknowledgment }
        if self == .siteNext {
            phase = .waiting
            waitingBehind = 2
        }
        // An interruption replaces the prompt. This isn't ready until the system's view on screen is paired with the new one, so if
        // it never is, the scene fails instead of drawing, and a real prompt would have been a dialog over the details.
        if self == .siteRefocused {
            let gate = ApprovalPrompt.scene(.waiting)
            var isReplaced = false
            let view = SiteApprovalView(approval: approval, waitingBehind: 0, money: { hotWallet.money($0) }, gate: gate, connect: {}, reject: {})
            return TestScreen(view: AnyView(view.frame(width: 480).background(.background)), isReady: {
                guard isReady(), gate.isPromptPaired else { return false }
                if isReplaced { return true }
                isReplaced = true
                gate.sceneReplacePrompt()
                return false
            })
        }
        let view: AnyView
        switch self {
        case .siteSending, .siteSent, .siteSigning, .siteSigned:
            view = AnyView(SiteProgressView(work: SiteWork(origin: site, isTransaction: self == .siteSending || self == .siteSent, sceneApproval: approval), money: { hotWallet.money($0) }, isDone: self == .siteSent || self == .siteSigned))
        case .siteFailure:
            view = AnyView(SiteFailureView(failure: SiteFailure(sceneOrigin: site, isTransaction: true, reason: HotWalletWording.feesRoseAfterApproval), dismiss: {}))
        case .siteFailureMessage:
            view = AnyView(SiteFailureView(failure: SiteFailure(sceneOrigin: site, isTransaction: false, reason: HotWalletWording.keyMissing), dismiss: {}))
        default:
            view = AnyView(SiteApprovalView(approval: approval, waitingBehind: waitingBehind, money: { hotWallet.money($0) }, gate: .scene(phase, isInFront: self != .siteBehind), connect: {}, reject: {}))
        }
        return TestScreen(view: AnyView(view.frame(width: 480).background(.background)), isReady: isReady)
    }

    private static let recipient = "0x0000000000000000000000000000000000c0ffee"
    private static let emptyWallet = "0x00000000000000000000000000000000000de301"
    private static let answeredWallet = "0x00000000000000000000000000000000000de301"
    private static let namedWallet = "0x00000000000000000000000000000000c0ffee01"
    private static let recentWallet = "0x00000000000000000000000000000000c0ffee02"
    /// More than the list has room for, with the wallet showing at the far end.
    private static let manyWallets = (1...20).map { SavedWallet(address: "0x" + String(format: "%040x", 0xc0ffee00 + $0), name: String(format: "Wallet %02d", $0), lastSeen: Date(timeIntervalSince1970: 1_793_750_400)) }
    /// One of each kind of answer: a wallet that's yours, an exchange account with what was paid, someone else, a cost, and an import.
    private static let answers: Book = {
        let exchange = "0x00000000000000000000000000000000c0ffee04"
        // Decoded, because only the server makes these, so they have no initializer outside the package.
        var book = Book().answering(namedWallet, .mine, focus: nil).answering("0x0000000000000000000000000000000000bee5", .someoneElse, focus: nil)
        // Two withdrawals of ETH from the same exchange, each asked about and answered on its own, for the same amount.
        for receipt in exchangeReceipts {
            book = book.enteringExchangeCosts(exchange, receipts: [receipt], amounts: ["ETH": Money(micros: "5100000", currency: .USD)], focus: nil)
        }
        book = book.enteringCost("0x00000000000000000000000000000000000de300:0x7d1c0e5a9b3f2e4d6c8a0b1f3e5d7c9a1b3d5f7e9c1a3b5d7f9e1c3a5b7d9f1e:VIRTUAL", Money(micros: "40000000", currency: .USD))
        book.withdrawals = (1...3).map { try! JSONDecoder().decode(ExchangeWithdrawal.self, from: Data(#"{"exchange":"coinbase","asset":"ETH","units":"\#($0)000000000000000","at":"2026-11-0\#($0)T12:00:00Z","cost":{"micros":"\#($0 * 3_000_000)","currency":"USD"},"toAddress":null}"#.utf8)) }
        return book
    }()
    private static let exchangeReceipts = [("53500120", "2100000000000000"), ("53521400", "1850000000000000")].map { block, units in
        try! JSONDecoder().decode(CostReceipt.self, from: Data(#"{"wallet":"0x00000000000000000000000000000000000de300","legId":"unseen:\#(block):ETH","asset":"ETH","units":"\#(units)"}"#.utf8))
    }
    private static let answerDetails: AnswerDetails = {
        var details = AnswerDetails()
        for (index, entry) in answers.answerEntries.enumerated() {
            details.dates[entry.id] = Date(timeIntervalSince1970: 1_793_750_400 - Double(index) * 5_400)
        }
        let exchange = "0x00000000000000000000000000000000c0ffee04"
        details.about[AnswerEntry.senderID(exchange)] = "0.0021 ETH from Coinbase"
        for (receipt, amount) in zip(exchangeReceipts, ["0.0021 ETH", "0.00185 ETH"]) {
            details.about[AnswerEntry.exchangeCostID(sender: exchange, asset: "ETH", receipts: [receipt])] = amount
        }
        details.about[AnswerEntry.senderID("0x0000000000000000000000000000000000bee5")] = "250 DAI"
        details.about[AnswerEntry.costID("0x00000000000000000000000000000000000de300:0x7d1c0e5a9b3f2e4d6c8a0b1f3e5d7c9a1b3d5f7e9c1a3b5d7f9e1c3a5b7d9f1e:VIRTUAL")] = "50 VIRTUAL"
        return details
    }()

    private static let savedWallets = [
        SavedWallet(address: namedWallet, name: "Treasury", lastSeen: Date(timeIntervalSince1970: 1_793_750_400)),
        SavedWallet(address: recentWallet, lastSeen: Date(timeIntervalSince1970: 1_793_750_300)),
        SavedWallet(address: "0x00000000000000000000000000000000c0ffee03", lastSeen: Date(timeIntervalSince1970: 1_793_750_200)),
    ]
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

/// Says every wallet is savings, so the only way to publish is from a device. Nothing here ever signs.
private final class SavingsNoteWriter: CostNoteWriter {
    func canWriteNote(from wallet: String) -> Bool { false }
    func canWriteNoteOnDevice(from wallet: String) -> Bool { true }
    func writeNote(_ calldata: [UInt8], asset: String, from wallet: String) async -> Bool { false }
    var noteProblem: String? { nil }
}

private final class ReadOnce {
    var isDone = false
}

/// Stands in for the server, with the same demo wallet the tests read.
final class FixtureSource: PortfolioSource {
    enum Feed { case demo, costBecomesKnown, missingPrice, unreadBalance, neverAnswers, updating, serverDown, stopsAnswering, pricesDown, pricesStop, tooSlow, retrying, retryingWithNumbers, notStartedFails, linkedFails, costWithheld, costOnSavings, smallAmounts, longHistory, answeredWallet, allAnswered, empty, emptyReadingLinked, notStarted, firstRun }

    private let feed: Feed
    private let hasRate: Bool
    private let pricingRules: [PricingRule]
    private let reads = Mutex(0)
    /// For `motion-cost-known`: whether what you paid has come in yet.
    static let costIsKnown = Mutex(false)

    func rules() async throws -> [PricingRule] { pricingRules }

    init(feed: Feed, hasRate: Bool = true, rules: [PricingRule] = []) {
        pricingRules = rules
        self.feed = feed
        self.hasRate = hasRate
    }

    /// The same rate as the demo's CAD portfolio.
    func currentRate(currency: CurrencyCode) async throws -> String? { hasRate ? "1398601" : nil }

    func portfolio(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book, timeout: Duration) async throws -> Portfolio {
        let read = reads.withLock { reads in
            reads += 1
            return reads
        }
        switch feed {
        case .demo: break
        case .costBecomesKnown:
            guard Self.costIsKnown.withLock({ $0 }) else { break }
            return try demo { object in
                var positions = object["positions"] as? [[String: Any]] ?? []
                for index in positions.indices {
                    var values = positions[index]["values"] as? [String: Any] ?? [:]
                    guard (values["unknownCostQty"] as? String) != "0" else { continue }
                    values["unknownCostQty"] = "0"
                    let value = Int64(values["valueMicros"] as? String ?? "") ?? 0
                    let cost = value * 9 / 10
                    let price = (positions[index]["price"] as? [String: Any])?["micros"] as? String
                    values["costMicros"] = String(cost)
                    values["averageCostMicros"] = String((Int64(price ?? "") ?? 0) * 9 / 10)
                    values["realizedMicros"] = "0"
                    values["unrealizedMicros"] = String(value - cost)
                    positions[index]["values"] = values
                    positions[index]["pnlMicros"] = String(value - cost)
                    positions[index]["resolvable"] = false
                }
                object["positions"] = positions
                object["questions"] = [Any]()
                object["pnlStatus"] = "complete"
                var totals = object["totals"] as? [String: Any] ?? [:]
                totals["excluded"] = [Any]()
                totals["unresolvedMicros"] = "0"
                totals["pnlMicros"] = "361230000"
                totals["unrealizedMicros"] = "287050000"
                totals["coverage"] = ["value": ["known": 7, "missing": 0], "realized": ["known": 7, "missing": 0], "unrealized": ["known": 7, "missing": 0], "pnl": ["known": 7, "missing": 0]]
                object["totals"] = totals
            }
        case .missingPrice:
            // The demo, with no price for USDC right now. It's the largest holding, so its value is a big part of the total, and with no price it's listed last.
            return try demo { object in
                var positions = object["positions"] as? [[String: Any]] ?? []
                for index in positions.indices where positions[index]["asset"] as? String == "USDC" {
                    var values = positions[index]["values"] as? [String: Any] ?? [:]
                    values["valueMicros"] = NSNull()
                    positions[index]["values"] = values
                }
                object["positions"] = positions
                var totals = object["totals"] as? [String: Any] ?? [:]
                totals["valueMicros"] = "4321680200"
                var coverage = totals["coverage"] as? [String: Any] ?? [:]
                coverage["value"] = ["known": 6, "missing": 1]
                totals["coverage"] = coverage
                object["totals"] = totals
            }
        case .unreadBalance:
            // The demo, with every price known and a balance that couldn't be read.
            return try demo { object in
                object["unreadAssets"] = ["wstETH"]
                var totals = object["totals"] as? [String: Any] ?? [:]
                var coverage = totals["coverage"] as? [String: Any] ?? [:]
                coverage["value"] = ["known": 7, "missing": 1]
                totals["coverage"] = coverage
                object["totals"] = totals
            }
        case .linkedFails:
            // The demo, with one of its linked wallets unreadable.
            return try demo { $0["linkedFailed"] = ["0x00000000000000000000000000000000000de301"] }
        case .costWithheld, .costOnSavings:
            // The demo, with what one of its linked wallets sent left unknown. On savings, a note could answer it, and there's every way to answer it.
            return try demo { object in
                object["withheld"] = [["wallet": "0x00000000000000000000000000000000000de301", "asset": "USDC"]]
                let asked: [String: Any] = ["id": "cost:0xdemo:0xwithheld:USDC", "kind": "cost", "wallet": object["address"] ?? "", "receipts": [["wallet": object["address"] ?? "", "legId": "0xwithheld:USDC", "asset": "USDC", "units": "500000000"]], "costKey": "0xdemo:0xwithheld:USDC", "sender": feed == .costOnSavings ? "0x00000000000000000000000000000000000de301" : NSNull(), "noteAbout": feed == .costOnSavings ? "0x" + String(repeating: "ab", count: 32) : NSNull(), "needsCost": false, "arrivals": [["asset": "USDC", "decimals": 6, "units": "500000000"]], "transfers": 1, "firstAt": "2026-11-04T12:00:00.000Z", "lastAt": "2026-11-04T12:00:00.000Z", "evidence": ["0x0000…e301, your wallet, sent this, and its USDC history can't be confirmed"], "valueMicros": "500000000"]
                object["questions"] = [asked] + (object["questions"] as? [[String: Any]] ?? [])
            }
        case .smallAmounts:
            // A wallet's first minute: fractions of a cent in PnL, and the longest amounts a warning can sit beside.
            return try demo { object in
                object["points"] = Self.points(every: 15, pnl: [-1500, -2300, -2300, -2300, -2300])
                let amounts = ["ETH": "1648710000000000", "cbBTC": "123", "USDC": "1234567890000", "AERO": "123000000"]
                var positions = object["positions"] as? [[String: Any]] ?? []
                for index in positions.indices {
                    guard let asset = positions[index]["asset"] as? String, let amount = amounts[asset] else { continue }
                    var values = positions[index]["values"] as? [String: Any] ?? [:]
                    values["qty"] = amount
                    positions[index]["values"] = values
                    positions[index]["shortfallQty"] = "1"
                }
                object["positions"] = positions
            }
        case .longHistory:
            // Weeks of history, where a time of day on the axis would say nothing.
            return try demo {
                let points = Self.points(every: 3 * 86_400, pnl: [1_000_000, 250_000_000, 1_250_000_000, 900_000_000, 400_000_000, 1_100_000_000, 800_000_000])
                $0["points"] = points
                // At 2 s a block, so what's offered goes back as far as these do.
                $0["coverage"] = ["fromBlock": 53_500_000 - points.count * 3 * 86_400 / 2, "toBlock": 53_500_000]
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
        case .allAnswered: return try demo { $0["questions"] = [Any]() }
        case .empty: return try newWallet(started: true, readingLinked: false, address: address)
        case .emptyReadingLinked: return try newWallet(started: true, readingLinked: true, address: address)
        case .notStarted: return try newWallet(started: false, readingLinked: false, address: address)
        case .firstRun: return try firstRun(address: address)
        case .neverAnswers, .updating: try await Task.sleep(for: .seconds(600))
        case .serverDown: throw FetchError.unreachable
        case .stopsAnswering: if read > 1 { throw FetchError.unreachable }
        case .pricesDown: throw FetchError.ampUnavailable("Couldn't read this wallet's data.")
        case .pricesStop: if read > 1 { throw FetchError.ampUnavailable("Couldn't read this wallet's data.") }
        // The server still answers, so the store gives up on the read rather than calling it offline.
        case .tooSlow: throw FetchError.timedOut
        // Fails, then the retry after it takes a while.
        case .retrying:
            if read == 1 { throw FetchError.ampUnavailable("Couldn't read this wallet's data.") }
            try await Task.sleep(for: .seconds(600))
        case .retryingWithNumbers:
            if read == 2 { throw FetchError.ampUnavailable("Couldn't read this wallet's data.") }
            if read > 2 { try await Task.sleep(for: .seconds(600)) }
        case .notStartedFails: throw FetchError.ampUnavailable("Couldn't read this wallet's data.")
        }
        return try Self.decode(fixture("demo-portfolio", currency))
    }

    func lastRead(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book) async throws -> Portfolio? {
        switch feed {
        case .updating: try Self.decode(fixture("demo-portfolio", currency))
        // What the server last read, from before the data reached this wallet.
        case .notStartedFails: try newWallet(started: false, readingLinked: false, address: address)
        default: nil
        }
    }

    /// Chart points this many seconds apart, the last one being now.
    private static func points(every seconds: Int, pnl: [Int]) -> [[String: Any]] {
        let start = Date(timeIntervalSince1970: 1_793_800_000)
        return pnl.enumerated().map { index, micros in
            let isLast = index == pnl.count - 1
            return [
                "blockNum": 53_500_000 + index,
                "timestamp": start.addingTimeInterval(Double(index * seconds)).formatted(.iso8601),
                "txHash": isLast ? NSNull() : "0xde3\(String(repeating: "0", count: 60))\(index)",
                "pnlMicros": String(micros),
                "excludedCount": 0,
            ] as [String: Any]
        }
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

    /// A real wallet minutes after it was funded, from benface's test in WORK-336: $4 of ETH that arrived with no transaction showing it, a swap to $1 of USDC, and its fee.
    /// It's what most people see first, and it's the demo. The rich demo wallet hides how this looks.
    private func firstRun(address: String) throws -> Portfolio {
        let now = Date.now
        let blockNum = 53_525_400
        func stamp(_ secondsAgo: Double) -> String { now.addingTimeInterval(-secondsAgo).formatted(.iso8601) }
        func position(_ asset: String, decimals: Int, note: Any, price: String, qty: String, unknownCostQty: String, averageCost: Any, value: String, realized: Any, unrealized: Any, pnl: Any, check: [String: Any], resolvable: Bool) -> [String: Any] {
            [
                "asset": asset, "decimals": decimals, "note": note,
                "price": ["micros": price, "source": "oracle", "blockNum": blockNum],
                "values": ["qty": qty, "unknownCostQty": unknownCostQty, "costMicros": averageCost is NSNull ? NSNull() : "1000000", "averageCostMicros": averageCost, "valueMicros": value, "realizedMicros": realized, "unrealizedMicros": unrealized, "estimatedCostMicros": "0", "estimatedRealizedMicros": "0"],
                "pnlMicros": pnl, "shortfallQty": "0", "legCount": 3, "reconciliation": check, "noMarket": false,
                "estimates": ["cost": false, "value": false, "realized": false, "unrealized": false],
                "resolvable": resolvable,
            ]
        }
        return try demo {
            $0["address"] = address
            $0["mode"] = "dataset"
            $0["coverage"] = ["fromBlock": 53_515_000, "toBlock": blockNum]
            $0["latest"] = ["blockNum": blockNum, "timestamp": stamp(0)]
            $0["progress"] = ["started": true, "behindBlocks": 0]
            $0["questions"] = [Any]()
            $0["unlisted"] = [Any]()
            $0["outgoingTxs"] = ["0x" + String(repeating: "a1", count: 32)]
            $0["meter"] = ["open": 0, "answered": 0, "waiting": 0]
            $0["positions"] = [
                position("ETH", decimals: 18, note: "incl. wrapped ETH", price: "2426000000", qty: "1648711832883181", unknownCostQty: "1648711832883181", averageCost: NSNull(), value: "4000000", realized: NSNull(), unrealized: NSNull(), pnl: NSNull(), check: ["status": "incomplete", "blockNum": blockNum, "computedQty": "-413118167116819", "actualQty": "1648711832883181", "differenceQty": "2061830000000000"], resolvable: false),
                position("USDC", decimals: 6, note: NSNull(), price: "1000000", qty: "1000000", unknownCostQty: "0", averageCost: "999800", value: "1000000", realized: "0", unrealized: "0", pnl: "0", check: ["status": "reconciled", "blockNum": blockNum, "computedQty": "1000000", "actualQty": "1000000", "differenceQty": "0"], resolvable: false),
            ]
            $0["totals"] = [
                "valueMicros": "5000000", "realizedMicros": NSNull(), "unrealizedMicros": "0", "gasMicros": "2300", "pnlMicros": "-2300",
                "excluded": [["asset": "ETH", "reason": "doesn't match its actual balance"]],
                "unpricedGas": false,
                "coverage": ["value": ["known": 2, "missing": 0], "realized": ["known": 0, "missing": 1], "unrealized": ["known": 1, "missing": 1], "pnl": ["known": 1, "missing": 1]],
                "unresolvedMicros": "4000000", "estimatedMicros": "0",
                "estimated": ["value": false, "realized": false, "unrealized": false],
                "noMarket": [Any](),
            ]
            $0["pnlStatus"] = "partial"
            $0["points"] = [
                ["blockNum": blockNum - 30, "timestamp": stamp(70), "txHash": "0x" + String(repeating: "a1", count: 32), "pnlMicros": "-2300", "excludedCount": 1],
                ["blockNum": blockNum, "timestamp": stamp(0), "txHash": NSNull(), "pnlMicros": "-2300", "excludedCount": 1],
            ]
            $0["holdComparison"] = [
                "walletMicros": "-2300", "gainThatLeftMicros": "0", "walletLeavesOut": true, "walletEstimated": false, "putInMicros": "0", "takenOutMicros": "0", "ethPriceMicros": "2426000000", "unknownAmounts": 1, "ranOut": false,
                "status": "unavailable", "unavailable": "nothing known put in", "holdMicros": NSNull(), "differenceMicros": NSNull(), "ethQty": "0", "ethValueMicros": "0", "estimated": false,
            ]
        }
    }

    func explanation(of target: ExplainTarget, address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book) async throws -> Explanation {
        if feed == .firstRun {
            // In the words `onchainLines` in `src/core/explain.ts` uses for this balance.
            let object: [String: Any] = ["currency": currency.rawValue, "title": "ETH: Balance check", "value": NSNull(), "sourceValue": NSNull(), "legCount": 0, "legs": [Any](), "lines": [
                "Worked out from its transactions: -0.00041 ETH.",
                "Actual balance at block 53,525,400: 0.00164 ETH.",
                "Difference: +0.00206 ETH.",
                "This wallet holds more ETH than its transactions explain. Most likely a contract sent it some, which we can't see yet.",
                "Value uses the actual balance. PnL is unavailable, because we know some of this wallet's activity is missing.",
            ]]
            return try JSONDecoder().decode(Explanation.self, from: JSONSerialization.data(withJSONObject: object))
        }
        return try Self.decode(target == .holdComparison ? "demo-hold-explanation" : fixture("demo-explanation", currency))
    }

    func proof(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Proof {
        throw FetchError.unreachable
    }

    func verification(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Verification {
        throw FetchError.unreachable
    }

    func taxReport(_ request: TaxReportRequest) async throws -> TaxReport {
        try Self.decode("demo-tax-report")
    }

    /// The demo's, said of whichever wallet asks.
    func approvals(address: String) async throws -> WalletApprovals {
        (try Self.decode("demo-approvals") as WalletApprovals).said(of: address)
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
