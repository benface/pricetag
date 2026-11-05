import HotWalletKit
import KeyVault
import PricetagKit
import SwiftUI

/// Where every approval happens. It's here and not on the page or in the extension, because nothing a site controls can draw in
/// this window or press its buttons. Closing the window rejects.
struct SiteApprovalWindow: View {
    static let title = "Site Request"

    let bridge: SiteBridge

    var body: some View {
        Group {
            if let failure = bridge.failure {
                SiteFailureView(failure: failure) { bridge.dismissFailure() }
            } else if let approval = bridge.current {
                SiteApprovalView(approval: approval, waitingBehind: bridge.pending.count - 1, money: bridge.money, gate: ApprovalPrompt(needsAcknowledgment: approval.needsAcknowledgment, notBefore: { bridge.nextPromptAt }) { prompt, acknowledged in
                    await bridge.approve(approval.id, acknowledged: acknowledged, in: prompt)
                }) {
                    Task { await bridge.approve(approval.id) }
                } reject: {
                    bridge.reject(approval.id)
                }
                .id(approval.id)
            } else if let working = bridge.working {
                SiteProgressView(work: working, money: bridge.money, isDone: false)
            } else if let finished = bridge.finished {
                SiteProgressView(work: finished, money: bridge.money, isDone: true)
            }
        }
        .frame(width: 480)
        .environment(\.isBelowTitleBar, true)
        // Closing it answers what's on show. If that was a failure, what's waiting behind it comes up next, because nobody has seen it yet.
        .onDisappear {
            bridge.dismissFinished()
            if bridge.failure != nil {
                bridge.dismissFailure()
            } else {
                bridge.rejectAll()
            }
        }
    }
}

/// One request, in words a person can check. For anything that can move money, Touch ID asks as soon as it's on show.
struct SiteApprovalView: View {
    /// So a window that opens under the pointer can't catch a click meant for the page behind it.
    static let armingDelay = Duration.seconds(1)

    let approval: SiteApproval
    let waitingBehind: Int
    let money: (UInt128) -> String
    @State var gate: ApprovalPrompt
    /// Connecting only shows an address, so it takes a click and no Touch ID.
    let connect: () -> Void
    let reject: () -> Void

    var body: some View {
        SiteRequestSummary(approval: approval, money: money) {
            VStack(spacing: 8) {
                if case .connect = approval.action {
                    ConnectFooter(connect: connect, reject: reject)
                } else {
                    TouchIDFooter(gate: gate, verb: verb, doing: isMessage ? "Signing…" : "Sending…", leaveTitle: "Reject", cancelled: "Touch ID was cancelled, so nothing was \(isMessage ? "signed" : "sent").", leave: reject)
                }
                if waitingBehind > 0 {
                    Text("\(waitingBehind) more waiting")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        // Reject has this shortcut already, once it can take it. This is for when focus is in the text.
        .onExitCommand { if gate.backOut() { reject() } }
    }

    private var isMessage: Bool {
        if case .message = approval.action { true } else { false }
    }

    private var verb: String {
        switch approval.action {
        case .transaction(let review) where review.moved != nil: "send"
        case .message: "sign"
        default: "approve"
        }
    }
}

/// Connecting moves nothing, so it's the one approval with no Touch ID.
private struct ConnectFooter: View {
    let connect: () -> Void
    let reject: () -> Void
    @State private var isArmed = false

    var body: some View {
        HStack {
            Spacer()
            Button("Reject", action: reject)
                .keyboardShortcut(.cancelAction)
            Button("Connect", action: connect)
                .buttonStyle(.borderedProminent)
                .disabled(!isArmed)
        }
        .controlSize(.large)
        .task {
            try? await Task.sleep(for: SiteApprovalView.armingDelay)
            isArmed = true
        }
    }
}

/// What a request is, the same before and after it's approved.
private struct SiteRequestSummary<Footer: View>: View {
    let approval: SiteApproval
    let money: (UInt128) -> String
    @ViewBuilder let footer: Footer

    var body: some View {
        switch approval.action {
        case .connect:
            ConfirmationView(asker: .site(approval.site), hero: .words("Connect to \(HotWalletWording.title)"), rows: [
                ConfirmationRow(label: "It can see", value: "This wallet's address and balances"),
                ConfirmationRow(label: "It can't", value: "Move anything without you, or see your savings"),
            ]) {
                footer
            }
        case .transaction(let review):
            ConfirmationView(asker: .site(approval.site), hero: hero(review), worth: review.preview == nil ? review.moved?.usdMicros.map(money) : nil, rows: rows(review), warnings: approval.warnings, details: details(review), data: review.data.isEmpty ? nil : "0x" + Hex.encode(review.data)) {
                footer
            }
        case .message(let review):
            ConfirmationView(asker: .site(approval.site), hero: .words(review.headline), rows: review.contract.map { [ConfirmationRow(label: "Contract", value: $0.checksummed, isAddress: true)] } ?? [], warnings: approval.warnings, message: review.body) {
                footer
            }
        }
    }

    /// A big number says that's the whole of it, which it isn't when something comes back. The preview's rows say what goes each way.
    private func hero(_ review: TransactionReview) -> ConfirmationHero {
        guard review.preview == nil, let moved = review.moved else { return .words(review.headline) }
        return .amount(moved.text, symbol: moved.symbol)
    }

    /// "You'd" because it's an estimate, and the note under the rows says so too.
    private func previewRows(_ preview: CallPreview) -> [ConfirmationRow] {
        func row(_ label: String, _ asset: CallPreview.Asset) -> ConfirmationRow {
            switch asset {
            case .known(let amount):
                ConfirmationRow(label: label, value: amount.usdMicros.map { "\(amount.text) \(amount.symbol) (\(money($0)))" } ?? "\(amount.text) \(amount.symbol)")
            case .unknown(let contract):
                ConfirmationRow(label: label, value: contract.checksummed, isAddress: true, name: "Unknown token")
            }
        }
        let allowances = preview.allowances.flatMap { allowance in
            var rows = [ConfirmationRow(label: "You'd allow", value: allowance.spender.checksummed, isAddress: true, name: "This address to spend \(allowance.words)")]
            if let contract = allowance.unknownContract {
                rows.append(ConfirmationRow(label: "For", value: contract.checksummed, isAddress: true, name: allowance.isCollection ? "Unknown collection" : "Unknown token"))
            }
            return rows
        }
        // What can leave comes first, so a long list of what's arriving can't push it out of sight.
        let rows = preview.gives.map { row("You'd give", $0) } + allowances + preview.gets.map { row("You'd get", $0) }
        return rows.isEmpty ? [ConfirmationRow(label: "Your balances", value: "No change")] : rows
    }

    private func rows(_ review: TransactionReview) -> [ConfirmationRow] {
        var rows = review.preview.map(previewRows) ?? []
        if let recipient = review.recipient {
            rows.append(ConfirmationRow(label: "To", value: recipient.checksummed, isAddress: true))
        } else if let spender = review.spender {
            rows.append(ConfirmationRow(label: "Spender", value: spender.checksummed, isAddress: true))
        } else {
            rows.append(ConfirmationRow(label: "Contract", value: review.to.checksummed, isAddress: true))
        }
        // A token this app doesn't know is only as good as its contract, so that's never tucked away.
        if review.toName == nil, review.recipient != review.to, review.recipient != nil || review.spender != nil {
            rows.append(ConfirmationRow(label: "Contract", value: review.to.checksummed, isAddress: true))
        }
        if review.alsoSendsEth {
            rows.append(ConfirmationRow(label: "Also sends", value: amount(Money.text(ofUnits: review.value, decimals: 18), usdMicros: review.valueUsdMicros)))
        }
        rows.append(ConfirmationRow(label: "Network fee", value: "About \(review.feeUsdMicros.map(money) ?? "\(Format.amount(String(review.feeWei), decimals: 18)) ETH")"))
        return rows
    }

    /// What's tucked away: the contract of a token this app knows, since the rows say who's on the other end of it.
    private func details(_ review: TransactionReview) -> [ConfirmationRow] {
        guard let name = review.toName, review.recipient != review.to, review.recipient != nil || review.spender != nil else { return [] }
        return [ConfirmationRow(label: name, value: review.to.checksummed, isAddress: true)]
    }

    private func amount(_ text: String, usdMicros: UInt128?) -> String {
        usdMicros.map { "\(text) ETH (\(money($0)))" } ?? "\(text) ETH"
    }
}

/// Between approving and the transaction going out, which can take a few seconds when the network is busy, and a moment after to say it did.
struct SiteProgressView: View {
    let work: SiteWork
    let money: (UInt128) -> String
    let isDone: Bool

    /// This goes away a moment after it's out, before any transaction could have landed, so it never says more than that. The site and Spending Money follow it from there.
    private var stage: ProgressFooter.Stage {
        if work.isTransaction { isDone ? .handedOff : .working("Sending…") } else { isDone ? .finished("Signed") : .working("Signing…") }
    }

    var body: some View {
        SiteRequestSummary(approval: work.approval, money: money) {
            ProgressFooter(stage: stage)
        }
    }
}

/// It's approved, and it didn't happen. The site will say something too, but only this knows why.
struct SiteFailureView: View {
    let failure: SiteFailure
    let dismiss: () -> Void

    @Environment(\.isBelowTitleBar) private var isBelowTitleBar

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "xmark.octagon.fill")
                .font(.system(size: 44))
                .foregroundStyle(Tone.loss.style)
                .accessibilityHidden(true)
            Text(failure.isTransaction ? "This Didn't Go Out" : "This Wasn't Signed")
                .font(.displaySmall)
            Text(failure.site)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            Notice(.warning, failure.reason)
                .textSelection(.enabled)
            if failure.isTransaction {
                Text("Nothing was sent, so no money moved.")
                    .foregroundStyle(.secondary)
            }
            HStack {
                Spacer()
                Button("OK", action: dismiss)
                    .keyboardShortcut(.defaultAction)
                    .controlSize(.large)
            }
        }
        .padding([.horizontal, .bottom], 24)
        .padding(.top, isBelowTitleBar ? 0 : 24)
        .onExitCommand(perform: dismiss)
    }
}
