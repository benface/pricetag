import AppKit
import HotWalletKit
import PricetagKit
import SwiftUI

/// Shows a wallet is the user's, by signing with it wherever it lives. This only ever sees the signature, and what's pasted is only sent on if it looks like one.
struct ProveWalletSheet: View {
    let store: PortfolioStore
    let proof: WalletProof
    @State var signature = ""
    @State var problem: String?
    /// Only while the server's looking at a signature. Backing out stops it, or a good answer would still add the wallet after they'd said no.
    @State private var pending: Task<Void, Never>?
    @Environment(\.dismiss) private var dismiss

    private var trimmed: String { signature.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Prove This Wallet Is Yours")
                    .font(.headline)
                // An unnamed wallet's title is already its address.
                Text(proof.title == Format.shortHash(proof.address) ? proof.title : "\(proof.title) · \(Format.shortHash(proof.address))")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Sign this message with that wallet.")
                    .fixedSize(horizontal: false, vertical: true)
                Text(proof.message)
                    .font(.caption)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                CopyButton(title: "Copy Message", text: proof.message)
                    .controlSize(.small)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Then paste the signature here.")
                // Only what's typed is in a code font: a prompt in one reads as a command.
                TextField("Signature", text: $signature, prompt: Text("0x…"), axis: .vertical)
                    .labelsHidden()
                    .lineLimit(3, reservesSpace: true)
                    .font(signature.isEmpty ? .body : .caption.monospaced())
                    .autocorrectionDisabled()
                    .onChange(of: signature) { problem = nil }
                if let problem {
                    WarningText(problem)
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Text("This is for a wallet in a browser or on a phone. A hardware wallet only signs transfers here, so add one as a savings wallet in \(HotWalletWording.title) instead.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) {
                    pending?.cancel()
                    dismiss()
                }
                .keyboardShortcut(.cancelAction)
                Button("Add to Yours", action: check)
                    .keyboardShortcut(.defaultAction)
                    .disabled(trimmed.isEmpty || pending != nil)
            }
        }
        .padding(20)
        .frame(width: 440)
        // The window can close with this still open.
        .onDisappear { pending?.cancel() }
    }

    private func check() {
        guard WalletAddress.isSignature(trimmed) else {
            problem = Wording.notASignature
            return
        }
        let signature = trimmed
        pending = Task {
            defer { pending = nil }
            do {
                if try await store.linkProved(proof, signature: signature) {
                    dismiss()
                } else {
                    problem = Wording.wrongSignature
                }
            } catch {
                if !Task.isCancelled { problem = Wording.couldntCheckSignature }
            }
        }
    }
}
