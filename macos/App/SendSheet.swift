import HotWalletKit
import KeyVault
import PricetagKit
import SwiftUI

/// Sends from this Mac's spending money. A new address gets asked about here, so there's nothing to untangle later.
struct SendSheet: View {
    @State var model: SendModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Send")
                .font(.title2.bold())
            LabeledContent("Amount") {
                HStack {
                    TextField("Amount", text: $model.amountText, prompt: Text("0.00"))
                        .labelsHidden()
                        .multilineTextAlignment(.trailing)
                    Picker("Token", selection: $model.token) {
                        ForEach(model.tokens) { Text($0.symbol).tag($0) }
                    }
                    .labelsHidden()
                    .fixedSize()
                    Button("Max") { model.useMaximum() }
                        .disabled(model.maximum == 0)
                }
            }
            if let problem = model.amountProblem {
                WarningText(problem.message).font(.callout).fixedSize(horizontal: false, vertical: true)
            } else if let usd = model.usdMicros {
                Text("About \(HotWalletWording.usd(usd))")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            TextField("To", text: $model.addressText, prompt: Text("0x…"))
                .font(.body.monospaced())
                .autocorrectionDisabled()
            recipient
            Text("A send can't be undone. Check the address where you got it. Touch ID or your password confirms it.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let failure = model.failure {
                WarningText(failure).font(.callout).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Send") {
                    Task { if await model.send() { dismiss() } }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!model.canSend)
            }
        }
        .padding(20)
        .frame(width: 460)
    }

    @ViewBuilder
    private var recipient: some View {
        if let address = model.recipient {
            // In groups, because nobody really compares 40 characters in one run.
            Text(AddressText.grouped(address.checksummed))
                .font(.callout.monospaced())
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            if let problem = model.recipientProblem {
                WarningText(problem.message).font(.callout).fixedSize(horizontal: false, vertical: true)
            } else if let known = model.knownAs {
                Label(known.title, systemImage: known == .someoneElse ? "person" : "checkmark.circle")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else if model.asksIfItsYours {
                isThisYours
            }
        } else if !model.addressText.isEmpty {
            WarningText("That isn't a valid address.").font(.callout)
        }
    }

    private var isThisYours: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Is this yours?").fontWeight(.semibold)
            Picker("Is this yours?", selection: $model.ownership) {
                ForEach(Ownership.allCases) { Text($0.title).tag(Ownership?.some($0)) }
            }
            .labelsHidden()
            .pickerStyle(.segmented)
            Text("Saying whose it is keeps your costs right later, and it stays on this Mac. You can leave it for now.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

enum AddressText {
    static func grouped(_ address: String) -> String {
        let digits = Array(address.dropFirst(2))
        let groups = stride(from: 0, to: digits.count, by: 4).map { String(digits[$0..<min($0 + 4, digits.count)]) }
        return "0x " + groups.joined(separator: " ")
    }
}
