import HotWalletKit
import PricetagKit
import SwiftUI

struct SettingsView: View {
    enum Pane: Hashable { case general, spendingMoney, server }

    let store: PortfolioStore
    let hotWallet: HotWallet
    @Binding var tab: Pane
    @State var server = ""
    @State var serverError: String?
    @State private var isComparing = false
    @State var rpc = ""
    @State var rpcError: String?
    @State private var isConfirmingDelete = false
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
            Tab(HotWalletWording.title, systemImage: "banknote", value: Pane.spendingMoney) { spendingMoney }
            Tab("Server", systemImage: "server.rack", value: Pane.server) { connection }
        }
        .onAppear {
            // What didn't save stays, next to what's wrong with it.
            if serverError == nil { server = store.serverURL.absoluteString }
            if rpcError == nil { rpc = hotWallet.settings.rpcURL.absoluteString }
        }
        .task { await store.refreshRules() }
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
                Picker("Cost method", selection: Binding(get: { store.method }, set: { store.setMethod($0) })) {
                    ForEach(CostMethod.allCases) { Text($0.label).tag($0) }
                }
                .help(Wording.methodHelp)
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

    private var spendingMoney: some View {
        pane(.spendingMoney) {
            Section {
                LabeledContent("Cap") {
                    HStack {
                        Slider(value: Binding(get: { Double(hotWallet.settings.capInDollars) }, set: { hotWallet.setCap(dollars: Int($0)) }), in: 1...Double(hotWallet.settings.capCeiling / Money.dollar))
                        Text(hotWallet.money(dollars: hotWallet.settings.capInDollars))
                            .monospacedDigit()
                            .frame(width: 56, alignment: .trailing)
                    }
                }
                Toggle("Sweep realized gains to savings", isOn: Binding(get: { hotWallet.settings.sweepsRealizedGains }, set: { hotWallet.setSweepsRealizedGains($0) }))
                TextField("Network", text: $rpc, prompt: Text(Base.publicRPC.absoluteString))
                    .onSubmit(applyRPC)
                    .onDisappear(perform: applyRPC)
                    .help("Only reads balances and passes on what this app signed. It can't move anything by itself.")
                if let rpcError {
                    WarningText(rpcError).font(.callout)
                }
                if hotWallet.address != nil {
                    Button("Delete This Mac's Spending Money…", role: .destructive) { isConfirmingDelete = true }
                        .disabled(!hotWallet.canDelete)
                        .confirmationDialog("Delete this wallet's key?", isPresented: $isConfirmingDelete) {
                            if hotWallet.settings.sweepDestination != nil {
                                Button("Sweep Everything to Savings First") { Task { await hotWallet.sweepEverything() } }
                            }
                            Button("Delete Forever", role: .destructive) { Task { await hotWallet.deleteWallet() } }
                        } message: {
                            Text("There's no recovery phrase and no backup. Whatever is still on this wallet is lost for good.")
                        }
                    if !hotWallet.canDelete {
                        Text(HotWalletWording.deleteWaitsForRotation)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }
            } footer: {
                Text("The cap is \(hotWallet.display.whole(hotWallet.settings.capCeiling)) at most \(hotWallet.settings.coldWallets.isEmpty ? "until you add a savings wallet" : "in this unreviewed build").\(hotWallet.display.isConverted ? " \(HotWalletWording.capFollowsRate(hotWallet.display.main))" : "")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func applyRPC() {
        let value = rpc.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: value), url.scheme == "http" || url.scheme == "https", url.host() != nil else {
            rpcError = "That isn't a network address. It should look like \(Base.publicRPC.absoluteString)."
            return
        }
        rpcError = nil
        hotWallet.setRPC(url)
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
