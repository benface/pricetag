import HotWalletKit
import PricetagKit
import SwiftUI

/// Spending Money's address, to receive from another wallet or an exchange. Only this Mac's wallet has one: a savings wallet's
/// address is checked on its device's screen, because a page that could be tampered with could show the wrong one.
struct ReceiveSheet: View {
    let wallet: HotWallet
    let setUp: () -> Void
    @Environment(\.dismiss) private var dismiss

    /// Nil when it can take money. Otherwise why not, because a key that's going away, or may be stolen, shouldn't get any more.
    private var problem: String? {
        if wallet.address == nil { return "Spending Money comes first, so there's somewhere for it to go." }
        if wallet.alarm != nil { return "This wallet's key may be stolen, so don't send anything here." }
        if wallet.isKeyMissing { return HotWalletWording.keyMissing }
        if wallet.rotation != nil { return "This wallet's key is being replaced, so its address is about to change. Wait until that's done." }
        return nil
    }

    var body: some View {
        VStack(spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Text("Receive")
                    .font(.title2.bold())
                Spacer()
                Label(HotWalletWording.label, systemImage: "flask")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let problem {
                Notice(wallet.address == nil ? .info : .warning, problem)
            } else if let address = wallet.address {
                code(address.checksummed)
                VStack(spacing: 2) {
                    ForEach(Format.groupedAddress(address.checksummed), id: \.self) { Text($0) }
                }
                .font(.title3.monospaced())
                .accessibilityElement(children: .combine)
                // A character at a time, as it's checked against what the sender pasted.
                .accessibilityLabel(Text("This wallet's address, ") + Text(Spoken.address(address.checksummed)).speechSpellsOutCharacters())
                Text(HotWalletWording.receiveNote(cap: wallet.capText, hasDestination: wallet.settings.sweepDestination != nil))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                if wallet.address == nil {
                    Button("Set Up Spending Money") {
                        setUp()
                        dismiss()
                    }
                    .keyboardShortcut(.defaultAction)
                } else if problem == nil, let address = wallet.address {
                    CopyButton(title: "Copy Address", text: address.checksummed)
                        .keyboardShortcut(.defaultAction)
                }
            }
        }
        .padding(20)
        .frame(width: 400)
    }

    /// Dark on white in either appearance, which is what a camera reads best.
    private func code(_ text: String) -> some View {
        Group {
            if let image = QRCodeMaker.image(for: text, moduleSize: 16) {
                Image(decorative: image, scale: 1)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
            }
        }
        .frame(width: 184, height: 184)
        .padding(8)
        .background(.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement()
        .accessibilityLabel("QR code of this address")
    }
}
