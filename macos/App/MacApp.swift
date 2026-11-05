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
    @State private var bridgeServer: BridgeServer?

    init() {
        #if DEBUG
        TestMode.runIfAsked()
        HotWalletDebug.runSelfTestIfAsked()
        #endif
        let store = PortfolioStore()
        let hotWallet = HotWalletFactory.make(store: store)
        let navigation = Navigation()
        let siteBridge = SiteBridge(wallet: hotWallet)
        siteBridge.onTopUp = { navigation.wantsTopUp = true }
        AppLinks.onOpen = { url in
            if let link = AddSavingsLink(url: url) { navigation.addingSavings = link }
        }
        hotWallet.onLinkedWalletsChange = {
            store.setLinkedWallets($0)
            siteBridge.walletChanged()
        }
        hotWallet.onKeyRetired = { store.followRetiredWallet($0.lowercased, to: $1?.lowercased) }
        #if DEBUG
        HotWalletDebug.applyLaunchArguments(to: hotWallet, bridge: siteBridge)
        #endif
        _bridgeServer = State(initialValue: Self.startBridge(siteBridge))
        // Here and not in a view: the menu bar shows the total, and sweeps run, whether or not anything is open.
        hotWallet.start()
        store.start()
        _store = State(initialValue: store)
        _hotWallet = State(initialValue: hotWallet)
        _navigation = State(initialValue: navigation)
        _siteBridge = State(initialValue: siteBridge)
    }

    /// Only a provisioned build can open this, and only a provisioned build has a wallet to offer. The extension says the app isn't open otherwise.
    private static func startBridge(_ bridge: SiteBridge) -> BridgeServer? {
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

    private var opensAtLaunch: Bool {
        #if DEBUG
        !HotWalletDebug.isQuiet
        #else
        true
        #endif
    }

    var body: some Scene {
        MenuBarExtra {
            PopoverView(store: store, hotWallet: hotWallet, navigation: navigation)
        } label: {
            MenuBarLabel(summary: FeedSummary(feed: store.feed, portfolio: store.portfolio), alarm: hotWallet.alarm, siteBridge: siteBridge, navigation: navigation)
        }
        .menuBarExtraStyle(.window)

        Window(AppName.current, id: WindowID.main) {
            MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: siteBridge)
                .holdsDockPresence()
        }
        .defaultSize(width: 1120, height: 760)
        .windowToolbarStyle(.unified)
        // Opens at launch, because a full menu bar can hide the item, and launching should always show something.
        .defaultLaunchBehavior(opensAtLaunch ? .presented : .suppressed)
        .restorationBehavior(.disabled)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandGroup(after: .toolbar) {
                Divider()
                ForEach(Array(AppSection.allCases.enumerated()), id: \.element) { index, section in
                    OpenSectionCommand(section: section, navigation: navigation)
                        .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
                }
                Divider()
                Picker("Cost", selection: Binding(get: { store.method }, set: { store.setMethod($0) })) {
                    ForEach(CostMethod.allCases) { Text($0.label).tag($0) }
                }
                Button("Refresh") { store.start() }
                    .keyboardShortcut("r", modifiers: .command)
                Button("Change Wallet…") { navigation.isChangingWallet = true }
                    .keyboardShortcut("l", modifiers: .command)
            }
            CommandGroup(after: .newItem) {
                Button("Answer Questions…") { navigation.resolve() }
                    .keyboardShortcut("r", modifiers: [.command, .shift])
                    .disabled(store.portfolio?.questions.isEmpty != false)
                Button("Export as CSV…") { navigation.isExporting = true }
                    .keyboardShortcut("e", modifiers: [.command, .shift])
                    .disabled(store.portfolio == nil)
                Button("Undo Last Answer") { store.undo() }
                    .keyboardShortcut("z", modifiers: [.command, .option])
                    .disabled(store.undoStack.isEmpty)
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
            SettingsView(store: store, hotWallet: hotWallet)
                .holdsDockPresence()
        }
    }
}

enum WindowID {
    static let main = "main"
    static let siteApproval = "site-approval"
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
    let summary: FeedSummary
    let alarm: StolenKeyAlarm?
    let siteBridge: SiteBridge
    let navigation: Navigation
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismissWindow) private var dismissWindow

    var body: some View {
        MenuBarLabelContent(summary: summary, isAlarm: alarm != nil)
            // In the label because it's the one view that's always there. A possibly stolen key can't wait for someone to look.
            .onChange(of: alarm?.findings.count) { _, count in
                guard count != nil else { return }
                NSSound(named: "Sosumi")?.play()
                navigation.section = .spendingMoney
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
                navigation.section = .spendingMoney
                openWindow(id: WindowID.main)
                DockPresence.bringForward()
            }
            .onChange(of: navigation.addingSavings) { _, link in
                guard link != nil else { return }
                navigation.section = .spendingMoney
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
