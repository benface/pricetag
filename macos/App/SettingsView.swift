import HotWalletKit
import PricetagKit
import SwiftUI

struct SettingsView: View {
    enum Pane: Hashable { case general, spendingMoney, server }

    let store: PortfolioStore
    let hotWallet: HotWallet
    @State var tab: Pane = .general
    @State private var server = ""
    @State private var serverError: String?
    @State private var isComparing = false
    @State private var rpc = ""
    @State private var rpcError: String?
    @State private var isConfirmingDelete = false

    var body: some View {
        TabView(selection: $tab) {
            Tab("General", systemImage: "gearshape", value: Pane.general) { general }
            Tab(HotWalletWording.title, systemImage: "banknote", value: Pane.spendingMoney) { spendingMoney }
            Tab("Server", systemImage: "server.rack", value: Pane.server) { connection }
        }
        .onAppear {
            server = store.serverURL.absoluteString
            rpc = hotWallet.settings.rpcURL.absoluteString
        }
        .task { await store.refreshRules() }
        .sheet(isPresented: $isComparing) { RuleComparisonSheet(store: store) }
        // It read one wallet's numbers once, and replacing a key can change the wallet behind it.
        .onChange(of: store.address) { isComparing = false }
    }

    /// A fixed height that fits any display, with the pane scrolling inside it if it ever needs more.
    private func pane(height: CGFloat, @ViewBuilder content: () -> some View) -> some View {
        Form(content: content)
            .formStyle(.grouped)
            .frame(width: 480, height: height)
    }

    private var general: some View {
        pane(height: store.rules.count > 1 ? 400 : 220) {
            Section {
                Picker("Main currency", selection: Binding(get: { store.currency }, set: { store.setCurrency($0) })) {
                    ForEach(CurrencyCode.allCases) { Text("\($0.rawValue) · \($0.name)").tag($0) }
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
        pane(height: 170) {
            Section {
                TextField("Server", text: $server, prompt: Text(PortfolioStore.defaultServerURL.absoluteString))
                    .onSubmit(applyServer)
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
        pane(height: 320) {
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
