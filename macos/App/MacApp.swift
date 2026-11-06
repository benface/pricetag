import HotWalletKit
import KeyVault
import PricetagKit
import SwiftUI

/// How a `patina://` link arrives. SwiftUI's own way would open a window of its choosing.
final class AppLinks: NSObject, NSApplicationDelegate {
    @MainActor static var onOpen: ((URL) -> Void)?

    func application(_ application: NSApplication, open urls: [URL]) {
        urls.forEach { Self.onOpen?($0) }
    }
}

@main
struct MacApp: App {
    @NSApplicationDelegateAdaptor(AppLinks.self) private var links
    @State private var store: PortfolioStore
    @State private var hotWallet: HotWallet
    @State private var navigation: Navigation
    @State private var siteBridge: SiteBridge
    @State private var purchases: PurchaseTracker
    @State private var notifications: MoneyNotifications
    @State private var bridgeServer: BridgeServer?
    @State private var firstRun: FirstRun

    init() {
        #if DEBUG
        TestMode.runIfAsked()
        HotWalletDebug.runSelfTestIfAsked()
        #endif
        // Before anything's had a chance to save a setting.
        let firstRun = FirstRun(isExistingInstall: PortfolioStore.hasBeenUsed())
        _firstRun = State(initialValue: firstRun)
        let store = PortfolioStore(cacheDirectory: .portfolioCache)
        let hotWallet = HotWalletFactory.make(store: store)
        let navigation = Navigation(store: store, hotWallet: hotWallet)
        let siteBridge = SiteBridge(wallet: hotWallet)
        siteBridge.onTopUp = { navigation.wantsTopUp = true }
        siteBridge.onReceive = { navigation.wantsReceive = true }
        navigation.onSwitcherClosed = { store.save(navigation.pendingWalletName, hotWallet: hotWallet) }
        // A watch-only build has no scheme of its own, and no savings to add.
        if !Build.isWatchOnly {
            AppLinks.onOpen = { url in
                if let link = AddSavingsLink(url: url) { navigation.addingSavings = link }
            }
        }
        hotWallet.onLinkedWalletsChange = {
            store.setLinkedWallets($0)
            siteBridge.walletChanged()
        }
        hotWallet.onKeyRetired = { old, next in
            store.followRetiredWallet(old.lowercased, to: next?.lowercased ?? store.walletList(hotWallet: hotWallet).next(afterRemoving: old.lowercased))
        }
        #if DEBUG
        HotWalletDebug.applyLaunchArguments(to: hotWallet, bridge: siteBridge)
        #endif
        _bridgeServer = State(initialValue: Self.startBridge(siteBridge))
        // Here and not in a view: the menu bar shows the total, and sweeps run, whether or not anything is open.
        hotWallet.start()
        // A key from before any of this is someone who's been here, whatever else they have.
        if hotWallet.address != nil, firstRun.isWelcoming { firstRun.skip() }
        store.start()
        TypingHistory.shared.start()
        // So an order still going when this last quit gets its cost.
        let purchases = PurchaseTracker(store: store)
        purchases.start()
        _purchases = State(initialValue: purchases)
        let notifications = MoneyNotifications(center: Self.postsNotifications ? .current() : nil)
        notifications.isLookingAtSpendingMoney = { NSApp.isActive && navigation.isShowingSpendingMoney && MainWindowState.isOnScreen }
        notifications.onOpen = { navigation.show(row: $0) }
        notifications.start(hotWallet: hotWallet, purchases: purchases)
        _notifications = State(initialValue: notifications)
        _store = State(initialValue: store)
        _hotWallet = State(initialValue: hotWallet)
        _navigation = State(initialValue: navigation)
        _siteBridge = State(initialValue: siteBridge)
    }

    /// Only a provisioned build can open this, and only a provisioned build has a wallet to offer. The extension says the app isn't open otherwise.
    private static func startBridge(_ bridge: SiteBridge) -> BridgeServer? {
        guard !Build.isWatchOnly else { return nil }
        guard let path = Bundle.main.bundleIdentifier.flatMap(BridgeEndpoint.socketPath) else { return nil }
        let server = BridgeServer(bridge: bridge, path: path)
        do {
            try server.start()
            return server
        } catch {
            FileHandle.standardError.write(Data("The browser extension can't reach this build: \(error)\n".utf8))
            return nil
        }
    }

    /// A scripted run never shows anything outside its own windows, or asks the system for anything.
    private static var postsNotifications: Bool {
        #if DEBUG
        !HotWalletDebug.isQuiet && !Build.isWatchOnly
        #else
        !Build.isWatchOnly
        #endif
    }

    private var opensAtLaunch: Bool {
        #if DEBUG
        !HotWalletDebug.isQuiet
        #elseif PATINA_WATCH_ONLY
        // So macos/watch-only-test.sh can launch the built app without taking anyone's focus. There's no key in this build to protect from it.
        !UserDefaults.standard.bool(forKey: "launchesQuietly")
        #else
        true
        #endif
    }

    var body: some Scene {
        MenuBarExtra {
            PopoverView(store: store, hotWallet: hotWallet, navigation: navigation)
        } label: {
            MenuBarLabel(store: store, alarm: hotWallet.alarm, siteBridge: siteBridge, navigation: navigation)
        }
        .menuBarExtraStyle(.window)

        Window(AppName.current, id: WindowID.main) {
            MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: siteBridge, purchases: purchases, firstRun: firstRun)
                .holdsDockPresence()
        }
        .defaultSize(width: 1120, height: 760)
        .windowToolbarStyle(.unified)
        // Opens at launch, because a full menu bar can hide the item, and launching should always show something.
        .defaultLaunchBehavior(opensAtLaunch ? .presented : .suppressed)
        .restorationBehavior(.disabled)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandGroup(replacing: .undoRedo) {
                UndoCommands(store: store)
            }
            SidebarCommands()
            CommandGroup(after: .toolbar) {
                Divider()
                ForEach(AppSection.shown) { section in
                    OpenSectionCommand(section: section, navigation: navigation)
                        .keyboardShortcut(section.shortcut, modifiers: .command)
                }
                Divider()
                MainWindowCommand(navigation.target == nil ? "Show Details" : "Hide Details") { navigation.toggleDetails() }
                    .keyboardShortcut("i", modifiers: [.command, .control])
                    .disabled(!navigation.canShowDetails || store.portfolio == nil)
                Divider()
                Button("Refresh") { store.refresh() }
                    .keyboardShortcut("r", modifiers: .command)
            }
            CommandGroup(after: .textEditing) {
                MainWindowCommand(navigation.findTitle) { navigation.find() }
                    .keyboardShortcut("f", modifiers: .command)
                    .disabled(!navigation.canFind)
            }
            CommandMenu("Wallet") {
                WalletCommands(store: store, hotWallet: hotWallet, navigation: navigation)
            }
            CommandGroup(after: .newItem) {
                MainWindowCommand("\(Wording.answerQuestions)…") { navigation.resolve() }
                    .keyboardShortcut("r", modifiers: [.command, .shift])
                    .disabled(store.portfolio?.questions.isEmpty != false)
                MainWindowCommand("Export as CSV…") { navigation.isExporting = true }
                    .keyboardShortcut("e", modifiers: [.command, .shift])
                    .disabled(store.portfolio == nil)
                YourAnswersCommand(navigation: navigation)
            }
            // The menu's search still finds any command.
            CommandGroup(replacing: .help) {
                MainWindowCommand("Welcome to \(AppName.current)") {
                    let hasWallet = store.address != nil
                    firstRun.showAgain(hasWallet: hasWallet)
                    if hasWallet {
                        navigation.isShowingWelcomeAgain = true
                    } else {
                        navigation.section = .overview
                    }
                }
            }
        }

        Window(SiteApprovalWindow.title, id: WindowID.siteApproval) {
            SiteApprovalWindow(bridge: siteBridge)
                .windowMinimizeBehavior(.disabled)
                .holdsDockPresence()
        }
        .windowStyle(.hiddenTitleBar)
        .windowResizability(.contentSize)
        // It stays where it can be seen, so Touch ID's prompt is never about something covered up.
        .windowLevel(.floating)
        .defaultPosition(.center)
        .defaultLaunchBehavior(.suppressed)
        .restorationBehavior(.disabled)

        Settings {
            SettingsView(store: store, notifications: notifications, tab: Bindable(navigation).settingsPane)
                .holdsDockPresence()
        }
    }
}

enum WindowID {
    static let main = "main"
    static let siteApproval = "site-approval"
}

enum MainWindowState {
    /// Open, and not in the Dock. SwiftUI names the window after its id.
    static var isOnScreen: Bool {
        NSApp.windows.contains { $0.identifier?.rawValue.hasPrefix(WindowID.main) == true && $0.isVisible && !$0.isMiniaturized }
    }
}

/// The window may be closed, so this opens it too.
private struct WalletCommands: View {
    let store: PortfolioStore
    let hotWallet: HotWallet
    let navigation: Navigation
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button("Switch Wallet…") {
            openMainWindow()
            navigation.switchWallet()
        }
        .keyboardShortcut("l", modifiers: .command)
        let address = store.walletList(hotWallet: hotWallet).entry(for: store.address)?.checksummedAddress
        Button("Copy Address") { address.map(Clipboard.copy) }
            .keyboardShortcut("c", modifiers: [.command, .shift])
            .disabled(address == nil)
        Button("View on Basescan") { if let url = address.flatMap(Basescan.address) { NSWorkspace.shared.open(url) } }
            .disabled(address == nil)
        Divider()
        if !Build.isWatchOnly {
            Button("Receive…") {
                openMainWindow()
                navigation.isReceiving = true
            }
            .disabled(!hotWallet.canSend)
            Button("Buy…") {
                openMainWindow()
                navigation.isBuying = true
            }
            .disabled(hotWallet.availability != .ready)
            Button(HotWalletWording.title) {
                openMainWindow()
                navigation.showSpendingMoney()
            }
            .keyboardShortcut("4", modifiers: .command)
            .disabled(hotWallet.availability == .notProvisioned)
            Button("Send…") {
                openMainWindow()
                navigation.send()
            }
            .disabled(!hotWallet.canSend)
            Divider()
        }
        WalletPicker(store: store, list: store.walletList(hotWallet: hotWallet), onChoose: openMainWindow)
    }

    private func openMainWindow() {
        openWindow(id: WindowID.main)
        DockPresence.bringForward()
    }
}

/// Answers have their own history, and typing has its own. While a field has something to take back, that comes first, as anywhere on a Mac.
private struct UndoCommands: View {
    let store: PortfolioStore
    private let typing = TypingHistory.shared

    var body: some View {
        Button(typing.undoTitle ?? store.undoNames.last.map { "Undo \($0)" } ?? "Undo") {
            if typing.undoTitle != nil { typing.undo() } else { store.undo() }
        }
        .keyboardShortcut("z", modifiers: .command)
        .disabled(typing.undoTitle == nil && store.undoStack.isEmpty)
        Button(typing.redoTitle ?? store.redoNames.last.map { "Redo \($0)" } ?? "Redo") {
            if typing.redoTitle != nil { typing.redo() } else { store.redo() }
        }
        .keyboardShortcut("z", modifiers: [.command, .shift])
        .disabled(typing.redoTitle == nil && store.redoStack.isEmpty)
    }
}

/// What can be taken back in the field being typed in. The menu reads it, so it's kept up to date after every event, when focus or typing can change.
@MainActor @Observable
final class TypingHistory {
    static let shared = TypingHistory()
    private(set) var undoTitle: String?
    private(set) var redoTitle: String?
    @ObservationIgnored private var observer: NSObjectProtocol?

    func start() {
        guard observer == nil else { return }
        observer = NotificationCenter.default.addObserver(forName: NSApplication.didUpdateNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { TypingHistory.shared.update() }
        }
    }

    /// A text field being edited has a text view in front of it, which keeps the window's history of typing.
    private var manager: UndoManager? {
        (NSApp.keyWindow?.firstResponder as? NSTextView)?.undoManager
    }

    /// Only what changed is set, since this runs after every event.
    private func update() {
        let manager = manager
        let undo = manager?.canUndo == true ? manager?.undoMenuItemTitle : nil
        let redo = manager?.canRedo == true ? manager?.redoMenuItemTitle : nil
        if undo != undoTitle { undoTitle = undo }
        if redo != redoTitle { redoTitle = redo }
    }

    func undo() { manager?.undo() }
    func redo() { manager?.redo() }
}

/// Opens Settings on the list of answers.
private struct YourAnswersCommand: View {
    let navigation: Navigation
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        Button("Your Answers…") {
            navigation.settingsPane = .answers
            openSettings()
            DockPresence.bringForward()
        }
    }
}

/// What it asks for happens in the window, which may be closed, so this opens it too.
private struct MainWindowCommand: View {
    let title: String
    let action: () -> Void
    @Environment(\.openWindow) private var openWindow

    init(_ title: String, action: @escaping () -> Void) {
        self.title = title
        self.action = action
    }

    var body: some View {
        Button(title) {
            action()
            openWindow(id: WindowID.main)
            DockPresence.bringForward()
        }
    }
}

/// The window may be closed, so this opens it too.
private struct OpenSectionCommand: View {
    let section: AppSection
    let navigation: Navigation
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button(section.title) {
            navigation.section = section
            openWindow(id: WindowID.main)
            DockPresence.bringForward()
        }
    }
}

struct MenuBarLabel: View {
    let store: PortfolioStore
    let alarm: StolenKeyAlarm?
    let siteBridge: SiteBridge
    let navigation: Navigation
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismissWindow) private var dismissWindow
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        MenuBarLabelContent(summary: FeedSummary(feed: store.feed, portfolio: store.portfolio, shows: store.menuBarShows), isAlarm: alarm != nil)
            .onAppear {
                StatusItemMenu.shared.start(
                    shows: { store.menuBarShows },
                    setShows: { store.setMenuBarShows($0) },
                    openApp: {
                        openWindow(id: WindowID.main)
                        DockPresence.bringForward()
                    },
                    openSettings: {
                        openSettings()
                        DockPresence.bringForward()
                    }
                )
            }
            // In the label because it's the one view that's always there. A possibly stolen key can't wait for someone to look.
            .onChange(of: alarm?.findings.count) { _, count in
                guard count != nil else { return }
                NSSound(named: "Sosumi")?.play()
                navigation.showSpendingMoney()
                openWindow(id: WindowID.main)
                DockPresence.bringForward()
                NSApp.requestUserAttention(.criticalRequest)
            }
            // Here for the same reason. A site asked for something, and it's the app's window that answers.
            .onChange(of: siteBridge.windowID) { _, id in
                #if DEBUG
                if HotWalletDebug.isQuiet { return }
                #endif
                if id == nil {
                    // A moment to see that it went through, unless something else has come up by then.
                    Task {
                        if siteBridge.finished != nil { try? await Task.sleep(for: .seconds(1.1)) }
                        if siteBridge.windowID == nil { dismissWindow(id: WindowID.siteApproval) }
                    }
                } else {
                    openWindow(id: WindowID.siteApproval)
                    DockPresence.bringForward()
                }
            }
            .onChange(of: navigation.wantsTopUp) { _, wants in
                guard wants else { return }
                #if DEBUG
                if HotWalletDebug.isQuiet {
                    FileHandle.standardError.write(Data("TOP UP ASKED\n".utf8))
                    return
                }
                #endif
                navigation.showSpendingMoney()
                openWindow(id: WindowID.main)
                DockPresence.bringForward()
            }
            .onChange(of: navigation.wantsReceive) { _, wants in
                guard wants else { return }
                navigation.wantsReceive = false
                #if DEBUG
                if HotWalletDebug.isQuiet {
                    FileHandle.standardError.write(Data("RECEIVE ASKED\n".utf8))
                    return
                }
                #endif
                navigation.isReceiving = true
                openWindow(id: WindowID.main)
                DockPresence.bringForward()
            }
            .onChange(of: navigation.addingSavings) { _, link in
                guard link != nil else { return }
                navigation.showSpendingMoney()
                openWindow(id: WindowID.main)
                DockPresence.bringForward()
            }
            // A notification was clicked, so the person wants to see it, wherever the window is.
            .onChange(of: navigation.shownRow) { _, row in
                guard row != nil else { return }
                openWindow(id: WindowID.main)
                DockPresence.bringForward()
            }
    }
}

/// What the menu bar item says. It has no colors of its own, so the system draws it to suit any menu bar: light, dark or tinted.
struct MenuBarLabelContent: View {
    let summary: FeedSummary
    let isAlarm: Bool

    var body: some View {
        if isAlarm {
            Text("\u{26A0}\u{FE0E} \(HotWalletWording.alarmShort)")
        } else if summary.text.isEmpty {
            Image(systemName: "tag")
                .accessibilityLabel(AppName.current)
        } else {
            // A character and not a symbol image, which the menu bar leaves out of a label with text.
            Text(summary.isWarning ? "\u{26A0}\u{FE0E} \(summary.text)" : summary.text)
                .monospacedDigit()
        }
    }
}
