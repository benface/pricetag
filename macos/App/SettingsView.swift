import PricetagKit
import SwiftUI

struct SettingsView: View {
    let store: PortfolioStore
    @State private var server = ""
    @State private var serverError: String?

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
                Text("View-only. There are no keys in this app, and it can't send anything.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .frame(width: 480)
        .fixedSize(horizontal: false, vertical: true)
        .onAppear { server = store.serverURL.absoluteString }
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
