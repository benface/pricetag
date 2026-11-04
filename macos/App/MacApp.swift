import HotWalletKit
import KeyVault
import PricetagKit
import SwiftUI

@main
struct MacApp: App {
    @State private var store: PortfolioStore
    @State private var hotWallet: HotWallet
    @State private var navigation = Navigation()

    init() {
        #if DEBUG
        TestMode.runIfAsked()
        HotWalletDebug.runSelfTestIfAsked()
        #endif
        let store = PortfolioStore()
        let hotWallet = HotWalletFactory.make(store: store)
        hotWallet.onLinkedWalletsChange = { store.setLinkedWallets($0) }
        #if DEBUG
        HotWalletDebug.applyLaunchArguments(to: hotWallet)
        #endif
        // Here and not in a view: the menu bar shows the total, and sweeps run, whether or not anything is open.
        hotWallet.start()
        store.start()
        _store = State(initialValue: store)
        _hotWallet = State(initialValue: hotWallet)
    }

    var body: some Scene {
        MenuBarExtra {
            PopoverView(store: store, hotWallet: hotWallet, navigation: navigation)
        } label: {
            MenuBarLabel(summary: FeedSummary(feed: store.feed, portfolio: store.portfolio), alarm: hotWallet.alarm)
        }
        .menuBarExtraStyle(.window)

        Window(AppName.current, id: WindowID.main) {
            MainWindow(store: store, navigation: navigation)
                .holdsDockPresence()
        }
        .defaultSize(width: 1120, height: 760)
        .windowToolbarStyle(.unified)
        // Opens at launch, because a full menu bar can hide the item, and launching should always show something.
        .defaultLaunchBehavior(.presented)
        .restorationBehavior(.disabled)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandGroup(after: .toolbar) {
                Divider()
                ForEach(Array(CostMethod.allCases.enumerated()), id: \.element) { index, method in
                    Button("Cost: \(method.label)") { store.setMethod(method) }
                        .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
                }
                Divider()
                Button(navigation.showsTransactions ? "Show Chart" : "Show Transactions") { navigation.showsTransactions.toggle() }
                    .keyboardShortcut("t", modifiers: .command)
                Button("Refresh") { store.start() }
                    .keyboardShortcut("r", modifiers: .command)
                Button("Change Wallet…") { navigation.isChangingWallet = true }
                    .keyboardShortcut("l", modifiers: .command)
                Button("Export Tax Report…") { navigation.isExportingTaxReport = true }
                    .keyboardShortcut("e", modifiers: .command)
                    .disabled(store.address == nil)
            }
            CommandGroup(before: .windowList) {
                OpenHotWalletCommand()
            }
            CommandGroup(after: .newItem) {
                Button("Resolve Unknowns…") { navigation.resolve() }
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

        Window(HotWalletWording.title, id: WindowID.hotWallet) {
            HotWalletWindow(wallet: hotWallet, store: store)
                .holdsDockPresence()
        }
        .defaultSize(width: 560, height: 720)
        .windowResizability(.contentMinSize)
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
    static let hotWallet = "hot-wallet"
}

private struct OpenHotWalletCommand: View {
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button("\(HotWalletWording.title)…") {
            openWindow(id: WindowID.hotWallet)
            DockPresence.bringForward()
        }
        .keyboardShortcut("m", modifiers: [.command, .shift])
    }
}

struct MenuBarLabel: View {
    let summary: FeedSummary
    let alarm: StolenKeyAlarm?
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        label
            // In the label because it's the one view that's always there. A possibly stolen key can't wait for someone to look.
            .onChange(of: alarm?.findings.count) { _, count in
                guard count != nil else { return }
                NSSound(named: "Sosumi")?.play()
                openWindow(id: WindowID.hotWallet)
                DockPresence.bringForward()
                NSApp.requestUserAttention(.criticalRequest)
            }
    }

    @ViewBuilder
    private var label: some View {
        if alarm != nil {
            Text("\u{26A0}\u{FE0E} Key may be stolen")
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
