import HotWalletKit
import PricetagKit
import SwiftUI

struct SettingsView: View {
    let store: PortfolioStore
    let hotWallet: HotWallet
    @State private var server = ""
    @State private var serverError: String?
    @State private var rpc = ""
    @State private var rpcError: String?
    @State private var isConfirmingDelete = false

    var body: some View {
        Form {
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
            spendingMoney
        }
        .formStyle(.grouped)
        .frame(width: 480)
        .fixedSize(horizontal: false, vertical: true)
        .onAppear {
            server = store.serverURL.absoluteString
            rpc = hotWallet.settings.rpcURL.absoluteString
        }
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
            TextField("RPC", text: $rpc, prompt: Text(Base.publicRPC.absoluteString))
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
            Text("The cap is $\(Int(hotWallet.settings.capCeiling / Money.dollar)) at most \(hotWallet.settings.coldWallets.isEmpty ? "until you add a savings wallet" : "in this unreviewed build"). The RPC only reads balances and sends what this app signed, and it can't move anything by itself.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func applyRPC() {
        let value = rpc.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: value), url.scheme == "http" || url.scheme == "https", url.host() != nil else {
            rpcError = "That isn't an RPC address. It should look like \(Base.publicRPC.absoluteString)."
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
