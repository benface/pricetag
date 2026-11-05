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
        // In case whoever started this is gone by now.
        RunLoop.main.run(until: .now.addingTimeInterval(60))
        exit(0)
    }

    nonisolated static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data((message + "\n").utf8))
        exit(1)
    }
}

/// Every kind of thing the menu bar item says, on a light, a dark and a tinted bar. These are stand-ins for the real menu bar, which only macOS can draw:
/// the system picks the item's color, so this shows the words and their lengths, not the real thing.
private struct MenuBarLabelScene: View {
    let portfolio: () -> Portfolio?

    private var summaries: [FeedSummary] {
        let states: [FeedState] = [.noWallet, .reading, .live, .behind(seconds: 600), .serverUnreachable]
        return states.map { FeedSummary(feed: $0, portfolio: portfolio()) }
    }

    private func bar(_ background: Color, _ foreground: Color) -> some View {
        HStack(spacing: 16) {
            ForEach(summaries, id: \.text) { MenuBarLabelContent(summary: $0, isAlarm: false) }
            MenuBarLabelContent(summary: summaries[0], isAlarm: true)
        }
        .font(.system(size: 13))
        .foregroundStyle(foreground)
        .padding(.horizontal, 12)
        .frame(height: 24)
        .background(background)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            bar(Color(white: 0.92), .black)
            bar(Color(white: 0.14), .white)
            bar(Color(red: 0.1, green: 0.32, blue: 0.62), .white)
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
    case mainTaxReport = "main-tax-report"
    case mainTaxReportSmall = "main-tax-report-small"
    case mainNoWalletSmall = "main-no-wallet-small"
    case mainNoWalletHasSpendingMoney = "main-no-wallet-has-spending-money"
    case mainNoWalletNotProvisioned = "main-no-wallet-not-provisioned"
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
    case resolveCostWithheld = "resolve-cost-withheld"
    case resolvePublishFromDevice = "resolve-publish-from-device"
    case resolveAnsweredWallet = "resolve-answered-wallet"
    case walletSwitcher = "wallet-switcher"
    case walletSwitcherFirstRun = "wallet-switcher-first-run"
    case walletSwitcherRenaming = "wallet-switcher-renaming"
    case walletSwitcherProblem = "wallet-switcher-problem"
    case walletSwitcherLong = "wallet-switcher-long"
    case mainShowingSpendingMoney = "main-showing-spending-money"
    case mainSavings = "main-savings"
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
    case popoverServerDown = "popover-server-down"
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
    /// The menu bar's other destinations, starting from another section. Each fails unless it gets there and stays.
    case routeHoldings = "route-holdings"
    case routeHoldingsOpen = "route-holdings-open"
    case routeAddWallet = "route-add-wallet"
    case routeAddWalletOpen = "route-add-wallet-open"
    case routeDetails = "route-details"
    case routeDetailsOpen = "route-details-open"
    case routeAnswer = "route-answer"
    case routeAnswerOpen = "route-answer-open"
    case menuBarLabel = "menu-bar-label"
    case settings
    case settingsWallets = "settings-wallets"
    case settingsServer = "settings-server"
    case settingsHotWallet = "settings-hot-wallet"
    case settingsCAD = "settings-cad"
    case settingsHotWalletCAD = "settings-hot-wallet-cad"
    case settingsReplacingKey = "settings-replacing-key"
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
    case addSavingsCheckStartsSweeps = "add-savings-check-starts-sweeps"
    case addSavingsCheckBalanceUnread = "add-savings-check-balance-unread"
    case addSavingsCheckFirstWallet = "add-savings-check-first-wallet"
    case addSavingsFinished = "add-savings-finished"
    case addSavingsFinishedSweeping = "add-savings-finished-sweeping"
    case addSavingsFinishedElsewhere = "add-savings-finished-elsewhere"
    case hotWalletTopUp = "hot-wallet-top-up"
    case hotWalletTopUpFirstRead = "hot-wallet-top-up-first-read"
    case hotWalletTopUpOneDollar = "hot-wallet-top-up-one-dollar"
    case hotWalletTopUpAtCap = "hot-wallet-top-up-at-cap"
    case hotWalletTopUpCAD = "hot-wallet-top-up-cad"
    case hotWalletTopUpSafari = "hot-wallet-top-up-safari"
    case hotWalletTopUpNoChromium = "hot-wallet-top-up-no-chromium"
    case send
    case sendCAD = "send-cad"
    case sendKnown = "send-known"
    case sendWaiting = "send-waiting"
    case sendGoing = "send-going"
    case sendSent = "send-sent"
    case sendStopped = "send-stopped"
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

    enum Chrome { case titled, none }

    /// Rendering draws the inspector's text in the wrong color in dark mode, so these only come from a real window.
    var needsRealWindow: Bool { rawValue.hasPrefix("main") || rawValue.hasPrefix("settings") || rawValue.hasPrefix("route") || self == .mainDetails || self == .mainFirstRunDetails || self == .mainDetailsCAD || self == .mainHoldDetails || self == .mainSmallestEnd }

    var chrome: Chrome {
        switch self {
        case .walletSwitcher, .walletSwitcherFirstRun, .walletSwitcherRenaming, .walletSwitcherProblem, .walletSwitcherLong, .popoverLongName, .popoverLongNameReading, .holdComparison, .popover, .popoverNoWallet, .popoverNotUpdating, .popoverNotStarted, .popoverFirstRun, .resolve, .resolveCostWithheld, .resolvePublishFromDevice, .resolveAnsweredWallet, .popoverCAD, .popoverHotWallet, .popoverHotWalletOverCap, .popoverHotWalletAlarm, .popoverHotWalletCAD, .popoverReading, .popoverServerDown, .popoverEmpty, .popoverHotWalletNoSavings, .popoverHotWalletKeyMissing, .popoverNotProvisioned, .popoverMissingPrice, .popoverUnreadBalance, .menuBarLabel,
             .hotWalletAddSavings, .hotWalletAddSavingsFilled, .hotWalletAddSavingsFromDevice, .addSavingsLedgerPlugIn, .addSavingsLedgerPlugInTrouble, .addSavingsLedgerApp, .addSavingsLedgerQuit, .addSavingsLedgerQuitStillOpen, .addSavingsLedgerBrowser, .addSavingsLedgerBrowserSafari, .addSavingsLedgerBrowserNone, .addSavingsLedgerWaiting, .addSavingsLedgerPaste, .addSavingsLedgerCheckTrouble, .addSavingsKeystoneUnlock, .addSavingsKeystoneReceive, .addSavingsKeystoneReceiveTrouble, .addSavingsKeystoneScan, .addSavingsKeystoneScanDenied, .addSavingsKeystoneScanNoCamera, .addSavingsKeystoneType, .addSavingsKeystoneCheck, .addSavingsKeystoneWalked, .addSavingsOtherPaste, .addSavingsCheckStartsSweeps, .addSavingsCheckBalanceUnread, .addSavingsCheckFirstWallet, .addSavingsFinished, .addSavingsFinishedSweeping, .addSavingsFinishedElsewhere, .hotWalletTopUp, .hotWalletTopUpFirstRead, .hotWalletTopUpOneDollar, .hotWalletTopUpAtCap, .hotWalletTopUpCAD, .hotWalletTopUpSafari, .hotWalletTopUpNoChromium,
             .publishFromDevice, .publishFromDeviceSafari, .publishFromDeviceNoChromium, .send, .sendCAD, .sendKnown, .sendWaiting, .sendGoing, .sendSent, .sendStopped, .sweep, .sweepCAD, .sweepStopped, .siteSend, .siteSendToken, .siteLongAmount, .siteCall, .siteApprove, .siteUnlimited, .siteUnlimitedAcknowledged, .siteMessage, .siteMessageUnreadable, .siteStopped, .siteNext, .siteBehind, .siteRefocused, .siteSending, .siteSent, .siteSigning, .siteSigned, .siteFailure, .siteFailureMessage, .publishCost, .publishCAD, .publishWaiting, .ruleComparison, .ruleComparisonCAD:
            .none
        default: .titled
        }
    }

    private var feed: FixtureSource.Feed {
        switch self {
        case .popoverMissingPrice, .mainMissingPrice: .missingPrice
        case .popoverUnreadBalance: .unreadBalance
        case .mainReading, .popoverReading, .popoverLongNameReading: .neverAnswers
        case .mainServerDown, .popoverServerDown: .serverDown
        case .mainNotUpdating, .popoverNotUpdating: .stopsAnswering
        case .mainLinkedFailed: .linkedFails
        case .mainCostWithheld, .resolveCostWithheld: .costWithheld
        case .resolvePublishFromDevice: .costOnSavings
        case .mainSmallAmounts, .mainSmallAmountsNarrow: .smallAmounts
        case .mainLongHistory, .mainChartWeek: .longHistory
        case .resolveAnsweredWallet: .answeredWallet
        case .mainEmpty, .mainEmptySmallest, .popoverEmpty: .empty
        case .mainEmptyNotice: .emptyReadingLinked
        case .mainNotStarted, .popoverNotStarted: .notStarted
        case .mainFirstRun, .mainFirstRunSmallest, .mainFirstRunSmall, .mainFirstRunDetails, .popoverFirstRun, .popoverLongName, .mainShowingSpendingMoney, .mainSavings, .mainWatching, .mainWatchingNamed, .mainWatchingNamedSmallest: .firstRun
        default: .demo
        }
    }

    private var hasWallet: Bool {
        switch self {
        case .mainNoWallet, .mainNoWalletSmall, .mainNoWalletHasSpendingMoney, .mainNoWalletNotProvisioned, .popoverNoWallet, .routeAddWallet, .routeAddWalletOpen, .walletSwitcherFirstRun: false
        default: true
        }
    }

    private var usesDemoWallet: Bool {
        switch self {
        case .mainEmpty, .mainEmptySmallest, .mainEmptyNotice, .popoverEmpty, .mainNotStarted, .popoverNotStarted, .mainFirstRun, .mainFirstRunSmallest, .mainFirstRunSmall, .mainFirstRunDetails, .popoverFirstRun: false
        default: true
        }
    }

    private var shownWallet: String? {
        switch self {
        case .walletSwitcher, .walletSwitcherRenaming, .walletSwitcherProblem, .mainWatchingNamed, .mainWatchingNamedSmallest, .popoverLongName, .popoverLongNameReading: TestScene.namedWallet
        case .walletSwitcherLong: TestScene.manyWallets.last?.address
        case .mainShowingSpendingMoney: HotWalletFixture.spending.lowercased
        case .mainSavings: HotWalletFixture.savings.lowercased
        case .mainWatching: TestScene.recentWallet
        default: nil
        }
    }

    private var listsWallets: Bool {
        switch self {
        case .walletSwitcher, .walletSwitcherRenaming, .walletSwitcherProblem, .walletSwitcherLong, .mainShowingSpendingMoney, .mainSavings, .mainWatching, .mainWatchingNamed, .mainWatchingNamedSmallest, .popoverLongName, .popoverLongNameReading: true
        default: false
        }
    }

    private var currency: CurrencyCode {
        switch self {
        case .mainCAD, .mainTransactionsCAD, .mainDetailsCAD, .popoverCAD, .settingsCAD, .popoverHotWalletCAD, .settingsHotWalletCAD, .hotWalletCAD, .hotWalletNoSavingsCAD, .hotWalletOverCapCAD, .hotWalletTopUpCAD, .sendCAD, .sweepCAD, .publishCAD, .ruleComparisonCAD, .siteTransactionCAD: .CAD
        default: .USD
        }
    }

    private var hotWalletFixture: HotWalletFixture {
        switch self {
        case .hotWalletNotProvisioned, .popoverNotProvisioned, .mainNoWalletNotProvisioned: .notProvisioned
        case .hotWalletUnreadable: .unreadableRecords
        case .walletSwitcher, .walletSwitcherRenaming, .walletSwitcherProblem, .walletSwitcherLong, .mainShowingSpendingMoney, .mainSavings, .mainWatching, .mainWatchingNamed, .mainWatchingNamedSmallest, .routeSend, .routeSendOpen, .routeTopUp, .routeTopUpOpen, .mainSpendingMoney, .mainSpendingMoneySmall, .hotWallet, .hotWalletCAD, .mainNoWalletHasSpendingMoney, .popoverHotWallet, .popoverHotWalletCAD, .settingsHotWallet, .settingsHotWalletCAD, .hotWalletAddSavings, .hotWalletAddSavingsFilled, .hotWalletAddSavingsFromDevice, .addSavingsLedgerPlugIn, .addSavingsLedgerPlugInTrouble, .addSavingsLedgerApp, .addSavingsLedgerQuit, .addSavingsLedgerQuitStillOpen, .addSavingsLedgerBrowser, .addSavingsLedgerBrowserSafari, .addSavingsLedgerBrowserNone, .addSavingsLedgerWaiting, .addSavingsLedgerPaste, .addSavingsLedgerCheckTrouble, .addSavingsKeystoneUnlock, .addSavingsKeystoneReceive, .addSavingsKeystoneReceiveTrouble, .addSavingsKeystoneScan, .addSavingsKeystoneScanDenied, .addSavingsKeystoneScanNoCamera, .addSavingsKeystoneType, .addSavingsKeystoneCheck, .addSavingsKeystoneWalked, .addSavingsOtherPaste, .addSavingsFinishedElsewhere, .hotWalletTopUp, .hotWalletTopUpFirstRead, .hotWalletTopUpCAD, .hotWalletTopUpSafari, .hotWalletTopUpNoChromium, .send, .sendCAD, .sendKnown, .sendWaiting, .sendGoing, .sendSent, .sendStopped, .sweep, .sweepCAD, .sweepStopped: .funded
        case .siteConnect: .funded
        case .siteTransaction, .siteTransactionCAD, .sitePreview, .sitePreviewUnknown, .sitePreviewLong, .siteUnlimitedApproval, .siteTypedPermit: .connectedToSite
        case .hotWalletTopUpOneDollar: .nearCap
        case .hotWalletNoSavings, .hotWalletNoSavingsCAD, .popoverHotWalletNoSavings, .addSavingsFinished, .addSavingsCheckBalanceUnread, .addSavingsCheckFirstWallet: .noSavings
        case .hotWalletNoPrice: .noPrice
        case .hotWalletOverCap, .hotWalletOverCapCAD, .popoverHotWalletOverCap, .hotWalletTopUpAtCap: .overCap
        case .hotWalletOverCapNoSavings, .addSavingsCheckStartsSweeps, .addSavingsFinishedSweeping: .overCapNoSavings
        case .hotWalletKeyMissing, .popoverHotWalletKeyMissing: .keyMissing
        case .hotWalletAlarm, .popoverHotWalletAlarm: .alarm
        case .hotWalletReplacingKey, .settingsReplacingKey: .replacingKey
        case .hotWalletReplacingKeyStuck: .replacingKeyStuck
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
    private func addSavingsSheet(_ wallet: HotWallet) -> AnyView {
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
        return AnyView(AddColdWalletSheet(model: model, server: URL(string: "http://127.0.0.1:8787")!, mac: mac, showsTrouble: showsTrouble))
    }

    func make() -> TestScreen {
        // Registered values stay in memory, so this never reads or writes anyone's settings, as long as nothing here changes one.
        let defaults = UserDefaults(suiteName: "com.benface.pricetag.mac.test-mode")!
        var registered: [String: Any] = ["currency": (TestMode.liveCurrency ?? currency).rawValue]
        if hasWallet { registered["wallet"] = TestMode.live?.wallet ?? shownWallet ?? (usesDemoWallet ? WalletAddress.demo : TestScene.emptyWallet) }
        // The longest name anyone's likely to give, where there's the least room for it.
        let wallets = switch self {
        case .mainWatchingNamedSmallest, .popoverLongName, .popoverLongNameReading: [SavedWallet(address: TestScene.namedWallet, name: "The Long-Term Family Treasury Wallet on Base", lastSeen: .distantPast)]
        case .walletSwitcherLong: TestScene.manyWallets
        default: TestScene.savedWallets
        }
        if listsWallets, let saved = try? JSONEncoder().encode(wallets) { registered["savedWallets"] = saved }
        if self == .sendKnown, let book = try? JSONEncoder().encode(Book().answering(TestScene.recipient, .someoneElse, focus: nil)) { registered["answers"] = book }
        if self == .resolveAnsweredWallet, let book = try? JSONEncoder().encode(Book().answering(TestScene.answeredWallet, .mine, focus: nil)) { registered["answers"] = book }
        defaults.register(defaults: registered)
        let source: any PortfolioSource = TestMode.live.map { PricetagClient(serverURL: $0.server) } ?? FixtureSource(feed: feed)
        let store = PortfolioStore(defaults: defaults, makeSource: { _ in source }, reachableDelay: TestMode.live == nil ? .milliseconds(50) : .seconds(30), unreachableDelay: .seconds(30))
        store.start()
        let hotWallet = hotWalletFixture.make(source: source, costMethod: { store.method }, mainCurrency: { store.currency })
        // Before there's a view, which is how it'd be for anyone opening a sheet: a sheet works out what it offers when it appears.
        let hotWalletHasRead = ReadOnce()
        let readHotWallet: @MainActor () async -> Void = {
            await hotWallet.tick()
            await hotWallet.readHistory()
            hotWalletHasRead.isDone = true
        }
        // Adding a wallet doesn't wait for this read, and neither does that scene.
        if self != .hotWalletTopUpFirstRead, self != .addSavingsCheckBalanceUnread {
            Task { await readHotWallet() }
            let deadline = Date.now.addingTimeInterval(TestMode.readyTimeout)
            while !hotWalletHasRead.isDone {
                guard Date.now < deadline else { TestMode.fail("This scene's hot wallet never finished reading.") }
                RunLoop.main.run(until: .now.addingTimeInterval(0.01))
            }
        }
        let navigation = Navigation()
        if self == .mainChartWeek { navigation.chartRange = .week }
        if self == .mainTransactions || self == .mainTransactionsCAD || self == .mainTransactionsSmall { navigation.section = .transactions }
        if self == .mainSpendingMoney || self == .mainSpendingMoneySmall { navigation.section = .spendingMoney }
        if self == .mainTaxReport || self == .mainTaxReportSmall { navigation.section = .taxReport }
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
            case .demo, .missingPrice, .unreadBalance, .linkedFails, .costWithheld, .costOnSavings, .smallAmounts, .longHistory, .answeredWallet, .empty, .emptyReadingLinked, .notStarted, .firstRun: store.feed == .noWallet || store.portfolio != nil
            case .neverAnswers: true
            case .serverDown: store.feed == .serverUnreachable
            case .stopsAnswering: store.feed == .serverUnreachable && store.portfolio != nil
            }
        }
        switch self {
        case .resolve, .resolveCostWithheld, .resolveAnsweredWallet:
            return TestScreen(view: AnyView(ResolveFlow(store: store)), size: CGSize(width: 520, height: 560), isReady: isReady)
        case .resolvePublishFromDevice:
            return TestScreen(view: AnyView(ResolveFlow(store: store, noteWriter: SavingsNoteWriter()) { AnyView(PublishFromDeviceButton(link: $0, browsers: deviceBrowsers)) }), size: CGSize(width: 520, height: 560), isReady: isReady)
        case .holdComparison:
            return TestScreen(view: AnyView(HoldComparisonScene()), isReady: { true })
        case .mainShowingSpendingMoney, .mainSavings, .mainWatching, .mainWatchingNamed:
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet))), size: CGSize(width: 1120, height: 760), isReady: isReady)
        case .mainWatchingNamedSmallest:
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet))), size: MainWindow.minimumSize, isReady: isReady)
        case .mainNoWalletHasSpendingMoney, .mainNoWalletNotProvisioned:
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet))), size: CGSize(width: 1120, height: 760), isReady: isReady)
        case .mainChartWeek, .mainFirstRun, .mainFirstRunDetails, .main, .mainTransactions, .mainDetails, .mainHoldDetails, .mainNoWallet, .mainReading, .mainServerDown, .mainNotUpdating, .mainLinkedFailed, .mainEmpty, .mainEmptyNotice, .mainNotStarted, .mainCostWithheld, .mainSmallAmounts, .mainLongHistory, .mainCAD, .mainTransactionsCAD, .mainDetailsCAD:
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet))), size: CGSize(width: 1120, height: 760), isReady: isReady)
        case .mainSmallestEnd:
            // Starts at the end of the page, because a screenshot can't scroll to it.
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet)).defaultScrollAnchor(.bottom)), size: CGSize(width: 780, height: 560), isReady: isReady)
        case .mainEmptySmallest, .mainSmallest, .mainFirstRunSmallest:
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet))), size: CGSize(width: 780, height: 560), isReady: isReady)
        case .mainNarrow, .mainSmallAmountsNarrow:
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet))), size: CGSize(width: 780, height: 760), isReady: isReady)
        case .mainSmall, .mainFirstRunSmall, .mainTransactionsSmall, .mainSpendingMoneySmall, .mainTaxReportSmall, .mainNoWalletSmall:
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet))), size: MainWindow.minimumSize, isReady: isReady)
        case .mainMedium, .mainSpendingMoney, .mainTaxReport:
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet))), size: CGSize(width: 900, height: 640), isReady: isReady)
        case .mainWidth660, .mainWidth760, .mainWidth860, .mainWidth960, .mainWidth1040:
            let width = CGFloat(Int(rawValue.split(separator: "-").last ?? "") ?? 900)
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet))), size: CGSize(width: width, height: 760), isReady: isReady)
        case .mainHuge:
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet))), size: CGSize(width: 2200, height: 1300), isReady: isReady)
        case .mainMissingPrice:
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet))), size: CGSize(width: 1120, height: 760), isReady: isReady)
        case .routeSend, .routeSendOpen, .routeTopUp, .routeTopUpOpen, .routeHoldings, .routeHoldingsOpen, .routeAddWallet, .routeAddWalletOpen, .routeDetails, .routeDetailsOpen, .routeAnswer, .routeAnswerOpen:
            let press: () -> Void
            let hasArrived: () -> Bool
            let hasSheet = { NSApp.windows.contains { $0.attachedSheet != nil } }
            switch self {
            case .routeSend, .routeSendOpen:
                press = navigation.send
                hasArrived = { !navigation.wantsSend && navigation.section == .spendingMoney && hasSheet() }
            case .routeTopUp, .routeTopUpOpen:
                press = navigation.topUp
                hasArrived = { !navigation.wantsTopUp && navigation.section == .spendingMoney && hasSheet() }
            case .routeHoldings, .routeHoldingsOpen:
                navigation.section = .spendingMoney
                press = navigation.showOverview
                hasArrived = { navigation.section == .overview }
            case .routeAddWallet, .routeAddWalletOpen:
                navigation.section = .spendingMoney
                press = navigation.showOverview
                hasArrived = { navigation.section == .overview && store.feed == .noWallet }
            case .routeDetails, .routeDetailsOpen:
                navigation.section = .spendingMoney
                press = { navigation.explain(.asset("AERO", .amount)) }
                hasArrived = { navigation.section == .overview && navigation.target != nil }
            default:
                navigation.section = .spendingMoney
                press = { navigation.resolve() }
                hasArrived = { navigation.isResolving && hasSheet() }
            }
            // A closed window has no section on screen yet, so it finds where to go when it appears.
            var pressedAt: Date?
            if !rawValue.hasSuffix("-open") {
                press()
                pressedAt = .now
            }
            return TestScreen(view: AnyView(MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet))), size: CGSize(width: 900, height: 640), isReady: {
                guard isReady() else { return false }
                if pressedAt == nil {
                    press()
                    pressedAt = .now
                }
                // Long enough for whatever reacts to the change to have run, because arriving doesn't count if something then undoes it.
                return Date.now.timeIntervalSince(pressedAt ?? .now) > 0.5 && hasArrived()
            })
        case .walletSwitcher, .walletSwitcherFirstRun, .walletSwitcherRenaming, .walletSwitcherProblem, .walletSwitcherLong:
            let switcher = WalletSwitcher(store: store, hotWallet: hotWallet, pendingName: self == .walletSwitcherRenaming ? PendingWalletName(address: TestScene.namedWallet, text: "Treasury") : PendingWalletName(), onOpenSpendingMoney: {}, onDone: {}, problem: self == .walletSwitcherProblem ? Wording.notAnAddress : nil)
            return TestScreen(view: AnyView(switcher.background(.background)), isReady: isReady)
        case .popoverLongName, .popoverLongNameReading, .popover, .popoverNoWallet, .popoverNotUpdating, .popoverNotStarted, .popoverFirstRun, .popoverCAD, .popoverHotWallet, .popoverHotWalletOverCap, .popoverHotWalletAlarm, .popoverHotWalletCAD, .popoverReading, .popoverServerDown, .popoverEmpty, .popoverHotWalletNoSavings, .popoverHotWalletKeyMissing, .popoverNotProvisioned, .popoverMissingPrice, .popoverUnreadBalance:
            return TestScreen(view: AnyView(PopoverView(store: store, hotWallet: hotWallet, navigation: navigation)), isReady: isReady)
        case .menuBarLabel:
            return TestScreen(view: AnyView(MenuBarLabelScene(portfolio: { store.portfolio })), isReady: isReady)
        case .settings, .settingsWallets, .settingsServer, .settingsHotWallet, .settingsCAD, .settingsHotWalletCAD, .settingsReplacingKey:
            let pane: SettingsView.Pane = switch self {
            case .settingsWallets: .wallets
            case .settingsServer: .server
            case .settingsHotWallet, .settingsHotWalletCAD, .settingsReplacingKey: .spendingMoney
            default: .general
            }
            return TestScreen(view: AnyView(SettingsView(store: store, hotWallet: hotWallet, tab: pane)), isReady: isReady)
        case .hotWalletSetup, .hotWalletNotProvisioned, .hotWalletUnreadable:
            return TestScreen(view: AnyView(HotWalletWindow(wallet: hotWallet, store: store, siteBridge: SiteBridge(wallet: hotWallet), navigation: navigation)), size: CGSize(width: 560, height: 720), isReady: isReady)
        case .hotWallet, .hotWalletCAD, .hotWalletNoSavings, .hotWalletNoSavingsCAD, .hotWalletNoPrice, .hotWalletOverCap, .hotWalletOverCapCAD, .hotWalletOverCapNoSavings, .hotWalletKeyMissing, .hotWalletAlarm, .hotWalletReplacingKey, .hotWalletReplacingKeyStuck, .hotWalletReplacingKeyMissing, .hotWalletSites:
            // Taller than it opens, because a screenshot can't scroll to the actions and the activity at the bottom.
            return TestScreen(view: AnyView(HotWalletWindow(wallet: hotWallet, store: store, siteBridge: SiteBridge(wallet: hotWallet), navigation: navigation)), size: CGSize(width: 560, height: 1200), isReady: isReady)
        case .hotWalletAddSavings, .hotWalletAddSavingsFilled, .hotWalletAddSavingsFromDevice, .addSavingsLedgerPlugIn, .addSavingsLedgerPlugInTrouble, .addSavingsLedgerApp, .addSavingsLedgerQuit, .addSavingsLedgerQuitStillOpen, .addSavingsLedgerBrowser, .addSavingsLedgerBrowserSafari, .addSavingsLedgerBrowserNone, .addSavingsLedgerWaiting, .addSavingsLedgerPaste, .addSavingsLedgerCheckTrouble, .addSavingsKeystoneUnlock, .addSavingsKeystoneReceive, .addSavingsKeystoneReceiveTrouble, .addSavingsKeystoneScan, .addSavingsKeystoneScanDenied, .addSavingsKeystoneScanNoCamera, .addSavingsKeystoneType, .addSavingsKeystoneCheck, .addSavingsKeystoneWalked, .addSavingsOtherPaste, .addSavingsCheckStartsSweeps, .addSavingsCheckBalanceUnread, .addSavingsCheckFirstWallet, .addSavingsFinished, .addSavingsFinishedSweeping, .addSavingsFinishedElsewhere:
            return TestScreen(view: addSavingsSheet(hotWallet), isReady: isReady)
        case .hotWalletTopUp, .hotWalletTopUpOneDollar, .hotWalletTopUpAtCap, .hotWalletTopUpCAD, .hotWalletTopUpSafari, .hotWalletTopUpNoChromium:
            return TestScreen(view: AnyView(TopUpSheet(wallet: hotWallet, server: URL(string: "http://127.0.0.1:8787")!, browsers: deviceBrowsers)), isReady: isReady)
        case .hotWalletTopUpFirstRead:
            // The sheet opens first here, so the read has to change what it worked out.
            return TestScreen(view: AnyView(TopUpSheet(wallet: hotWallet, server: URL(string: "http://127.0.0.1:8787")!, browsers: deviceBrowsers).task { await readHotWallet() }), isReady: { hotWalletHasRead.isDone })
        case .send, .sendCAD, .sendKnown, .sendWaiting, .sendGoing, .sendSent, .sendStopped:
            let model = SendModel(wallet: hotWallet, store: store)
            model.token = Base.tokens.first { $0.symbol == "USDC" }!
            model.amountText = "12.50"
            model.addressText = TestScene.recipient
            switch self {
            // Touch ID's part never happens here: this only draws what's around it.
            case .sendWaiting: return TestScreen(view: AnyView(SendConfirmation(model: model, gate: .scene(.asking), done: {}).frame(width: 460)), isReady: isReady)
            case .sendGoing: return TestScreen(view: AnyView(SendConfirmation(model: model, gate: .scene(.working), done: {}).frame(width: 460)), isReady: isReady)
            case .sendSent: return TestScreen(view: AnyView(SendConfirmation(model: model, gate: .scene(.done), done: {}).frame(width: 460)), isReady: isReady)
            case .sendStopped: return TestScreen(view: AnyView(SendConfirmation(model: model, gate: .scene(.stopped(nil)), done: {}).frame(width: 460)), isReady: isReady)
            default: return TestScreen(view: AnyView(SendSheet(model: model)), isReady: isReady)
            }
        case .sweep, .sweepCAD:
            return TestScreen(view: AnyView(SweepSheet(wallet: hotWallet, gate: .scene(.asking))), isReady: isReady)
        case .sweepStopped:
            let problem = HotWalletWording.sweptOnlySome(onItsWay: ["USDC"], left: ["ETH"], because: "A sweep of ETH didn't go out: insufficient funds")
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
        case .siteConnect, .siteTransaction, .siteTransactionCAD, .sitePreview, .sitePreviewUnknown, .sitePreviewLong, .siteUnlimitedApproval, .siteTypedPermit:
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
            let view = SiteApprovalView(approval: approval, waitingBehind: 0, usd: { hotWallet.usd($0) }, gate: gate, connect: {}, reject: {})
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
            view = AnyView(SiteProgressView(work: SiteWork(origin: site, isTransaction: self == .siteSending || self == .siteSent, sceneApproval: approval), usd: { hotWallet.usd($0) }, isDone: self == .siteSent || self == .siteSigned))
        case .siteFailure:
            view = AnyView(SiteFailureView(failure: SiteFailure(sceneOrigin: site, isTransaction: true, reason: HotWalletWording.feesRoseAfterApproval), dismiss: {}))
        case .siteFailureMessage:
            view = AnyView(SiteFailureView(failure: SiteFailure(sceneOrigin: site, isTransaction: false, reason: HotWalletWording.keyMissing), dismiss: {}))
        default:
            view = AnyView(SiteApprovalView(approval: approval, waitingBehind: waitingBehind, usd: { hotWallet.usd($0) }, gate: .scene(phase, isInFront: self != .siteBehind), connect: {}, reject: {}))
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
    enum Feed { case demo, missingPrice, unreadBalance, neverAnswers, serverDown, stopsAnswering, linkedFails, costWithheld, costOnSavings, smallAmounts, longHistory, answeredWallet, empty, emptyReadingLinked, notStarted, firstRun }

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
        case .empty: return try newWallet(started: true, readingLinked: false, address: address)
        case .emptyReadingLinked: return try newWallet(started: true, readingLinked: true, address: address)
        case .notStarted: return try newWallet(started: false, readingLinked: false, address: address)
        case .firstRun: return try firstRun(address: address)
        case .neverAnswers: try await Task.sleep(for: .seconds(600))
        case .serverDown: throw FetchError.unreachable
        case .stopsAnswering: if read > 1 { throw FetchError.unreachable }
        }
        return try Self.decode(fixture("demo-portfolio", currency))
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
