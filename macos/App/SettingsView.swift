import PricetagKit
import SwiftUI

struct SettingsView: View {
    /// What applies to the whole app. What belongs to one wallet, like Spending Money's cap, is on that wallet's page.
    enum Pane: Hashable { case general, server }

    let store: PortfolioStore
    let notifications: MoneyNotifications
    @Binding var tab: Pane
    @State var server = ""
    @State var serverError: String?
    @State private var isComparing = false
    /// How tall what's in each tab wants to be. A tab has no answer until it's first shown.
    @State private var contentHeights: [Pane: CGFloat] = [:]
    /// How tall the tab is right now, which is what moves the window. It's one number for all the tabs, so it can animate from one to the next.
    @State private var shownHeight: CGFloat?
    @State private var room = SettingsView.roomOnDisplay
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Stands in for a small display in a test scene.
    var displayRoom: CGFloat?

    /// What's left of the display under the title bar and the tabs.
    private static var roomOnDisplay: CGFloat {
        (NSScreen.main?.visibleFrame.height ?? 700) - 100
    }

    private var availableHeight: CGFloat { displayRoom ?? room }

    private var targetHeight: CGFloat? {
        contentHeights[tab].map { min($0, availableHeight) }
    }

    var body: some View {
        TabView(selection: $tab) {
            Tab("General", systemImage: "gearshape", value: Pane.general) { general }
            Tab("Server", systemImage: "server.rack", value: Pane.server) { connection }
        }
        .onAppear {
            // What didn't save stays, next to what's wrong with it.
            if serverError == nil { server = store.serverURL.absoluteString }
        }
        .task { await store.refreshRules() }
        // The person may have just changed it in System Settings.
        .task { await notifications.refreshAuthorization() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in Task { await notifications.refreshAuthorization() } }
        .sheet(isPresented: $isComparing) { RuleComparisonSheet(store: store) }
        // It read one wallet's numbers once, and replacing a key can change the wallet behind it.
        .onChange(of: store.address) { isComparing = false }
        // Opens at its size, and only moves after that.
        .onChange(of: targetHeight) { _, height in
            guard let height else { return }
            if shownHeight == nil || reduceMotion {
                shownHeight = height
            } else {
                withAnimation(.easeInOut(duration: 0.25)) { shownHeight = height }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didChangeScreenNotification)) { _ in room = Self.roomOnDisplay }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didChangeScreenParametersNotification)) { _ in room = Self.roomOnDisplay }
    }

    /// As tall as what's in it, and it only scrolls if that's more than the display has room for. The form lays out at its full height
    /// inside the scroll view, because a form that scrolls by itself has no height of its own to ask for.
    private func pane(_ pane: Pane, @ViewBuilder content: () -> some View) -> some View {
        ScrollView {
            Form(content: content)
                .formStyle(.grouped)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self, of: \.size.height) { contentHeights[pane] = $0 }
        }
        .scrollDisabled((contentHeights[pane] ?? 0) <= availableHeight)
        .modifier(WindowMovingHeight(height: shownHeight ?? contentHeights[pane] ?? 200))
        .frame(width: 480)
    }

    private var general: some View {
        pane(.general) {
            Section {
                Picker("Main currency", selection: Binding(get: { store.currency }, set: { store.setCurrency($0) })) {
                    ForEach(CurrencyCode.mainChoices) { Text("\($0.rawValue) · \($0.name)").tag($0) }
                }
                .help("Costs use the rate when each transaction happened, and values use the current rate.")
                Picker(Wording.methodName, selection: Binding(get: { store.method }, set: { store.setMethod($0) })) {
                    ForEach(CostMethod.allCases) { Text($0.label).tag($0) }
                }
                .help(Wording.methodHelp)
                Picker("Menu bar shows", selection: Binding(get: { store.menuBarShows }, set: { store.setMenuBarShows($0) })) {
                    ForEach(MenuBarShows.allCases) { Text($0.label).tag($0) }
                }
                .help("Also in the menu bar item's right-click menu. Problems with the data show whichever you choose.")
            }
            if store.rules.count > 1 {
                Section {
                    RulePicker(store: store)
                        .help(Wording.rulesHelp)
                    Button("Compare Side by Side…") { isComparing = true }
                        .disabled(store.address == nil || store.address == WalletAddress.demo)
                }
            }
            Section {
                Toggle("Notify me when money moves", isOn: Binding(get: { notifications.isOn }, set: { notifications.setOn($0) }))
                if notifications.isOn, notifications.authorization == .denied {
                    LabeledContent {
                        Button("Open System Settings…") { notifications.openSystemSettings() }
                            .controlSize(.small)
                    } label: {
                        WarningText("They're turned off for \(AppName.current) in System Settings.")
                    }
                }
            } header: {
                Text("Notifications")
            } footer: {
                Text("Sweeps, purchases, and sends that didn't go through. Never prices.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Section {
                LabeledContent("Who sent what") {
                    Button("Forget All My Answers", role: .destructive) { store.setBook(Book()) }
                        .controlSize(.small)
                        .disabled(!store.hasAnswers)
                }
                .help("They stay on this Mac. They're only sent to your server to work out your numbers, and it doesn't keep them.")
            } header: {
                Text("Your Answers")
            }
        }
    }

    private var connection: some View {
        pane(.server) {
            Section {
                TextField("Server", text: $server, prompt: Text(PortfolioStore.defaultServerURL.absoluteString))
                    .onSubmit(applyServer)
                    // Leaving the tab or closing the window counts as being done, because there's no Save button to say otherwise.
                    .onDisappear(perform: applyServer)
                if let serverError {
                    WarningText(serverError).font(.callout)
                }
            } footer: {
                Text("\(AppName.current) only talks to this server.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func applyServer() {
        let value = server.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: value), url.scheme == "http" || url.scheme == "https", url.host() != nil else {
            serverError = "That isn't a server address. It should look like \(PortfolioStore.defaultServerURL.absoluteString)."
            return
        }
        serverError = nil
        store.setServerURL(url)
    }
}

/// A window follows the size of what's in it but not an animation of that size, so it would jump. This gives the content a real height on every frame of the animation.
@Animatable
private struct WindowMovingHeight: ViewModifier {
    var height: CGFloat

    func body(content: Content) -> some View {
        content.frame(height: height)
    }
}
