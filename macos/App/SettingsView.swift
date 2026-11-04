import PricetagKit
import SwiftUI

struct SettingsView: View {
    let store: PortfolioStore
    @State private var server = ""
    @State private var serverError: String?
    @State private var proving = ""
    @State private var signature = ""
    @State private var linkResult: String?

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
