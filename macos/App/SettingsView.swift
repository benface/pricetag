import PricetagKit
import SwiftUI

struct SettingsView: View {
    /// What applies to the whole app. What belongs to one wallet, like Spending Money's cap, is on that wallet's page.
    enum Pane: Hashable { case general, answers, server }

    let store: PortfolioStore
    let notifications: MoneyNotifications
    @Binding var tab: Pane
    @State var server = ""
    @State var serverError: String?
    @State var invite = ""
    @State private var isComparing = false
    @State private var isChangingInvite = false
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
            Tab("Answers", systemImage: "checklist", value: Pane.answers) { pane(.answers) { AnswersList(store: store) } }
            // A build for other people reads the server it was built for, and its invite is under General.
            if !Build.isForOtherPeople {
                Tab("Price Service", systemImage: "server.rack", value: Pane.server) { connection }
            }
        }
        .onAppear {
            // What didn't save stays, next to what's wrong with it.
            if serverError == nil { server = store.serverURL.absoluteString }
            invite = store.invite ?? ""
        }
        .task { await store.refreshRules() }
        // The person may have just changed it in System Settings.
        .task { await notifications.refreshAuthorization() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in Task { await notifications.refreshAuthorization() } }
        .sheet(isPresented: $isComparing) { RuleComparisonSheet(store: store) }
        .sheet(isPresented: $isChangingInvite) { InvitePrompt(store: store, decline: { isChangingInvite = false }, submitted: { isChangingInvite = false }) }
        // It read one wallet's numbers once, and replacing a key can change the wallet behind it.
        .onChange(of: store.address) { isComparing = false }
        // Opens at its size, and only moves after that.
        .onChange(of: targetHeight) { _, height in
            guard let height else { return }
            if shownHeight == nil || reduceMotion {
                shownHeight = height
            } else {
                withAnimation(Motion.panel) { shownHeight = height }
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
                        .disabled(store.address == nil || store.address == WalletAddress.demo || WalletAddress.isAllYours(store.address))
                }
            }
            if Build.isForOtherPeople {
                Section {
                    LabeledContent("Invite") {
                        Button(store.invite == nil ? "Enter Invite…" : "Change Invite…") { isChangingInvite = true }
                    }
                    // The main window asks again, but it may not be open.
                    if store.needsInvite, store.invite != nil {
                        WarningText("The server didn't accept that invite.")
                            .font(.callout)
                    }
                } footer: {
                    if Build.isWatchOnly {
                        Text(Wording.watchOnlyNotice)
                            .font(.caption)
                            .secondaryText()
                    }
                }
            }
            if !Build.isWatchOnly {
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
                        .secondaryText()
                }
            }
        }
    }

    private var connection: some View {
        pane(.server) {
            Section {
                TextField("Address", text: $server, prompt: Text(PortfolioStore.defaultServerURL.absoluteString))
                    .onSubmit(applyConnection)
                    // Leaving the tab or closing the window counts as being done, because there's no Save button to say otherwise.
                    .onDisappear(perform: applyConnection)
                if let serverError {
                    WarningText(serverError).font(.callout)
                }
                SecureField("Invite", text: $invite, prompt: Text("Only for a shared server"))
                    .onSubmit(applyConnection)
                    .onDisappear(perform: applyConnection)
                    .help("Only sent over HTTPS, to the server above.")
            } footer: {
                Text("Where \(AppName.current) gets prices and history. It runs on this Mac unless you change this.")
                    .font(.caption)
                    .secondaryText()
            }
        }
    }

    /// Both fields at once, whichever was left last, so an invite is always saved for the server beside it. One that was only
    /// still showing from the last server stays that server's, and the new one's own shows instead.
    private func applyConnection() {
        let value = server.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: value), url.scheme == "http" || url.scheme == "https", url.host() != nil else {
            serverError = "That isn't a web address. It should look like \(PortfolioStore.defaultServerURL.absoluteString)."
            return
        }
        serverError = nil
        let shownFor = store.invite ?? ""
        let moved = PortfolioStore.origin(of: url) != PortfolioStore.origin(of: store.serverURL)
        store.setServerURL(url)
        if moved && invite == shownFor {
            invite = store.invite ?? ""
        } else {
            store.setInvite(invite)
        }
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
