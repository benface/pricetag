import HotWalletKit
import PricetagKit
import SwiftUI

struct SettingsView: View {
    let store: PortfolioStore
    let hotWallet: HotWallet
    @State private var server = ""
    @State private var serverError: String?
    @State private var proving = ""
    @State private var signature = ""
    @State private var linkResult: String?
    @State private var isComparing = false
    @State private var rpc = ""
    @State private var rpcError: String?
    @State private var isConfirmingDelete = false

    var body: some View {
        Form {
            Section {
                Picker("Main currency", selection: Binding(get: { store.currency }, set: { store.setCurrency($0) })) {
                    ForEach(CurrencyCode.allCases) { Text("\($0.rawValue) · \($0.name)").tag($0) }
                }
            } footer: {
                Text("Costs use the exchange rate when each transaction happened, and current values use the current rate. If a rate is missing, the value shows as unavailable.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if store.rules.count > 1 {
                Section {
                    RulePicker(store: store)
                    Button("Compare Side by Side…") { isComparing = true }
                        .disabled(store.address == nil || store.address == WalletAddress.demo)
                } footer: {
                    Text(Wording.rulesHelp)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Section {
                TextField("Server", text: $server, prompt: Text(PortfolioStore.defaultServerURL.absoluteString))
                    .onSubmit(applyServer)
                if let serverError {
                    WarningText(serverError).font(.callout)
                }
            } footer: {
                Text("\(AppName.current) only talks to this server, and the server is the only thing that talks to Amp. Plain HTTP only works for a server on this Mac.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Section {
                LabeledContent("Wallet", value: store.address.map { $0 == WalletAddress.demo ? "Demo wallet" : $0 } ?? "None")
                    .textSelection(.enabled)
                Button("Forget This Wallet") { store.setWallet(nil) }
                    .disabled(store.address == nil)
            } footer: {
                Text("This wallet is only read, and nothing signs for it. The one key in this app is below.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Section("Your Other Wallets") {
                ForEach(store.book.linkedWallets.filter { $0 != store.address }, id: \.self) { wallet in
                    LabeledContent(Format.shortHash(wallet)) {
                        Button("Unlink") {
                            var next = store.book
                            next.senders[wallet] = nil
                            store.setBook(next)
                        }
                    }
                }
                TextField("Wallet to add, 0x…", text: $proving)
                    .font(.body.monospaced())
                    .autocorrectionDisabled()
                if WalletAddress.isValid(proving), store.address.map(WalletAddress.isValid) == true {
                    LabeledContent("Sign this with that wallet") {
                        Text(Wording.linkMessage(owner: store.address ?? "", address: proving)).font(.caption).textSelection(.enabled)
                    }
                    TextField("Signature, 0x…", text: $signature)
                        .font(.body.monospaced())
                        .autocorrectionDisabled()
                    Button("Link It") {
                        Task {
                            do {
                                let linked = try await store.linkProved(proving, signature: signature.trimmingCharacters(in: .whitespacesAndNewlines))
                                linkResult = linked ? "Linked." : "That signature isn't from this wallet."
                                if linked {
                                    proving = ""
                                    signature = ""
                                }
                            } catch {
                                linkResult = "Couldn't check it. Is the server running?"
                            }
                        }
                    }
                    .disabled(signature.isEmpty)
                }
                if let linkResult { Text(linkResult).font(.callout) }
            }
            Section {
                Button("Forget All My Answers", role: .destructive) { store.setBook(Book()) }
                    .disabled(store.book.isEmpty)
            } footer: {
                Text("Your answers about who sent what stay on this Mac. They're only sent to the server above, to work out your numbers, and it doesn't keep them.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            spendingMoney
        }
        .formStyle(.grouped)
        .frame(width: 480)
        .fixedSize(horizontal: false, vertical: true)
        .onAppear {
            server = store.serverURL.absoluteString
            rpc = hotWallet.settings.rpcURL.absoluteString
        }
        .task { await store.refreshRules() }
        .sheet(isPresented: $isComparing) { RuleComparisonSheet(store: store) }
    }

    private var spendingMoney: some View {
        Section {
            LabeledContent("Cap") {
                HStack {
                    Slider(value: Binding(get: { Double(hotWallet.settings.capInDollars) }, set: { hotWallet.setCap(dollars: Int($0)) }), in: 1...Double(hotWallet.settings.capCeiling / Money.dollar), step: 1)
                    Text("$\(hotWallet.settings.capInDollars)")
                        .monospacedDigit()
                        .frame(width: 40, alignment: .trailing)
                }
            }
            Toggle("Sweep realized gains to savings", isOn: Binding(get: { hotWallet.settings.sweepsRealizedGains }, set: { hotWallet.setSweepsRealizedGains($0) }))
            TextField("Network", text: $rpc, prompt: Text(Base.publicRPC.absoluteString))
                .onSubmit(applyRPC)
            if let rpcError {
                WarningText(rpcError).font(.callout)
            }
            if hotWallet.address != nil {
                Button("Delete This Mac's Spending Money…", role: .destructive) { isConfirmingDelete = true }
                    .confirmationDialog("Delete this wallet's key?", isPresented: $isConfirmingDelete) {
                        if hotWallet.settings.sweepDestination != nil {
                            Button("Sweep Everything to Savings First") { Task { await hotWallet.sweepEverything() } }
                        }
                        Button("Delete Forever", role: .destructive) { Task { await hotWallet.deleteWallet() } }
                    } message: {
                        Text("There's no recovery phrase and no backup. Whatever is still on this wallet is lost for good.")
                    }
            }
        } header: {
            Text(HotWalletWording.title)
        } footer: {
            Text("The cap is $\(Int(hotWallet.settings.capCeiling / Money.dollar)) at most \(hotWallet.settings.coldWallets.isEmpty ? "until you add a savings wallet" : "in this unreviewed build"). The network address only reads balances and passes on what this app signed. It can't move anything by itself.")
                .font(.caption)
                .foregroundStyle(.secondary)
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
