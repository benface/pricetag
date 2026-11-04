import PricetagKit
import SwiftUI

@main
struct MacApp: App {
    @State private var store: PortfolioStore
    @State private var navigation = Navigation()

    init() {
        let store = PortfolioStore()
        // Here and not in a view: the menu bar shows the total whether or not anything is open.
        store.start()
        _store = State(initialValue: store)
    }

    var body: some Scene {
        MenuBarExtra {
            PopoverView(store: store, navigation: navigation)
        } label: {
            MenuBarLabel(summary: FeedSummary(feed: store.feed, portfolio: store.portfolio))
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
                    Button(method.label) { store.setMethod(method) }
                        .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
                }
                Divider()
                Button(navigation.showsTransactions ? "Show Chart" : "Show Transactions") { navigation.showsTransactions.toggle() }
                    .keyboardShortcut("t", modifiers: .command)
                Button("Refresh") { store.start() }
                    .keyboardShortcut("r", modifiers: .command)
                Button("Change Wallet…") { navigation.isChangingWallet = true }
                    .keyboardShortcut("l", modifiers: .command)
            }
            CommandGroup(after: .newItem) {
                Button("Resolve Unknowns…") { navigation.resolve() }
                    .keyboardShortcut("r", modifiers: [.command, .shift])
                    .disabled(store.portfolio?.questions.isEmpty != false)
                Button("Export as CSV…") { navigation.isExporting = true }
                    .keyboardShortcut("e", modifiers: .command)
                    .disabled(store.portfolio == nil)
                Button("Undo Last Answer") { store.undo() }
                    .keyboardShortcut("z", modifiers: [.command, .option])
                    .disabled(store.undoStack.isEmpty)
            }
        }

        Settings {
            SettingsView(store: store)
                .holdsDockPresence()
        }
    }
}

enum WindowID {
    static let main = "main"
}

struct MenuBarLabel: View {
    let summary: FeedSummary

    var body: some View {
        if summary.text.isEmpty {
            Image(systemName: "tag")
                .accessibilityLabel(AppName.current)
        } else {
            // A character and not a symbol image, which the menu bar leaves out of a label with text.
            Text(summary.isWarning ? "\u{26A0}\u{FE0E} \(summary.text)" : summary.text)
                .monospacedDigit()
        }
    }
}
