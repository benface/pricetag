import PricetagKit
import SwiftUI

/// Says what this build is, wherever someone could expect a wallet that moves money.
struct WatchOnlyNotice: View {
    var body: some View {
        Label(Wording.watchOnlyNotice, systemImage: "eye")
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .background(.bar)
    }
}

/// What a watch-only build asks when its server wants to know who's asking. The invite goes in the same place a typed one always has,
/// saved for this server alone, and only sent over HTTPS.
struct InvitePrompt: View {
    let store: PortfolioStore
    /// Not Now.
    let decline: () -> Void
    /// After an invite's saved.
    var submitted: () -> Void = {}
    /// Stands in for a server that turned one down, in a test scene.
    var isRefused: Bool?
    @State private var invite = ""

    static var explanation: String {
        "\(AppName.current) reads prices and history from its server, which only answers people it invited. Paste the invite you were sent."
    }
    static let refused = "The server didn't accept that invite. Check that you copied all of it, or ask for a new one."

    private var wasRefused: Bool { isRefused ?? (store.needsInvite && store.invite != nil) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Enter Your Invite")
                .font(.headline)
            Text(Self.explanation)
                .secondaryText()
                .fixedSize(horizontal: false, vertical: true)
            SecureField("Invite", text: $invite)
                .textFieldStyle(.roundedBorder)
                .onSubmit(save)
            if wasRefused {
                WarningText(Self.refused)
                    .font(.callout)
            }
            HStack {
                Spacer()
                Button("Not Now", role: .cancel, action: decline)
                    .keyboardShortcut(.cancelAction)
                Button("Continue", action: save)
                    .keyboardShortcut(.defaultAction)
                    .disabled(invite.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 400)
    }

    private func save() {
        guard !invite.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        store.setInvite(invite)
        submitted()
    }
}
