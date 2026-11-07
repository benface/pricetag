import HotWalletKit
import KeyVault
import PricetagKit
import SwiftUI

/// Taking approvals back, reviewed like any other transaction: what's revoked and from whom, the fee, then Touch ID. The fee is read
/// first, so nothing's asked about before it's known.
struct RevokeSheet: View {
    let wallet: HotWallet
    let revocations: [Revocation]
    /// Whether everything landed, once the sheet's done.
    let onClose: (Bool) -> Void
    /// Only for scenes, which draw what's around Touch ID and never ask.
    var gate: ApprovalPrompt?
    @State private var quote: RevocationQuote?
    @State private var quoteFailed = false
    @Environment(\.dismiss) private var dismiss

    init(wallet: HotWallet, revocations: [Revocation], quote: RevocationQuote? = nil, gate: ApprovalPrompt? = nil, onClose: @escaping (Bool) -> Void = { _ in }) {
        self.wallet = wallet
        self.revocations = revocations
        self.gate = gate
        self.onClose = onClose
        _quote = State(initialValue: quote)
    }

    var body: some View {
        Group {
            if let quote {
                RevokeConfirmation(wallet: wallet, revocations: revocations, quote: quote, gate: gate) { close($0) }
            } else {
                VStack(spacing: 16) {
                    if quoteFailed {
                        Notice(.warning, "Couldn't work out the fee. The network may be busy, or one of these can't be revoked right now.")
                        HStack {
                            Spacer()
                            Button("Cancel") { close(false) }
                                .keyboardShortcut(.cancelAction)
                            Button("Try Again") { Task { await readQuote() } }
                                .keyboardShortcut(.defaultAction)
                        }
                    } else {
                        ProgressView().controlSize(.large)
                        Text("Working out the fee…").secondaryText()
                        Button("Cancel") { close(false) }
                            .keyboardShortcut(.cancelAction)
                    }
                }
                .padding(24)
                .frame(maxWidth: .infinity)
                .task { if quote == nil { await readQuote() } }
            }
        }
        .frame(width: 460)
        .interactiveDismissDisabled(wallet.isWorking)
    }

    private func readQuote() async {
        quoteFailed = false
        quote = await wallet.quoteRevocations(revocations)
        quoteFailed = quote == nil
    }

    private func close(_ landed: Bool) {
        onClose(landed)
        dismiss()
    }
}

private struct RevokeConfirmation: View {
    let wallet: HotWallet
    let revocations: [Revocation]
    let quote: RevocationQuote
    let close: (Bool) -> Void
    @State private var gate: ApprovalPrompt

    init(wallet: HotWallet, revocations: [Revocation], quote: RevocationQuote, gate: ApprovalPrompt?, close: @escaping (Bool) -> Void) {
        self.wallet = wallet
        self.revocations = revocations
        self.quote = quote
        self.close = close
        _gate = State(initialValue: gate ?? ApprovalPrompt(needsReview: ApprovalPrompt.needsReview, notBefore: { wallet.nextPromptAt }) { prompt, _ in
            await wallet.revokeConfirmed(revocations, in: prompt)
        })
    }

    var body: some View {
        ConfirmationView(asker: .spendingMoney, hero: .words(revocations.count == 1 ? "Revoke an Approval" : "Revoke \(revocations.count) Approvals"), worth: worth, rows: rows) {
            if gate.phase == .done {
                ProgressFooter(stage: stage) { close(landing == .landed) }
                    .task(id: landing) {
                        guard landing == .landed else { return }
                        try? await Task.sleep(for: Motion.acknowledged)
                        if !Task.isCancelled { close(true) }
                    }
            } else {
                TouchIDFooter(gate: gate, verb: "revoke", doing: "Revoking…", leaveTitle: hasFailed ? "Close" : "Cancel") { close(false) }
            }
        }
    }

    private var landing: Landing { wallet.landing(of: wallet.lastSubmitted) }

    static func label(_ revocation: Revocation) -> String {
        switch revocation.kind {
        case .token: revocation.label
        case .permit2: "\(revocation.label) via Permit2"
        }
    }

    private var stage: ProgressFooter.Stage {
        switch landing {
        case .onItsWay: .onItsWay
        case .landed: .finished(revocations.count == 1 ? "Revoked" : "All revoked")
        case .didntLand: .didntLand("Some of this didn't go through")
        }
    }

    /// Part of it may have gone by then, and that can't be called back.
    private var hasFailed: Bool {
        if case .stopped(.some) = gate.phase { return true }
        return false
    }

    private var worth: String? {
        quote.transactions == 1 ? "Nothing moves. It only stops these from spending." : "Nothing moves. It's \(quote.transactions) transactions, signed together."
    }

    private var rows: [ConfirmationRow] {
        var rows = revocations.map { revocation in
            ConfirmationRow(label: Self.label(revocation), value: revocation.spender.checksummed, isAddress: true, name: revocation.spenderName)
        }
        rows.append(.networkFee(usdMicros: quote.feeUsdMicros, wei: quote.feeWei, money: wallet.money))
        return rows
    }
}
