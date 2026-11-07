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
                SiteApprovalView(approval: approval, waitingBehind: bridge.pending.count - 1, money: bridge.money, gate: ApprovalPrompt(needsAcknowledgment: approval.needsAcknowledgment, needsReview: ApprovalPrompt.needsReview, notBefore: { bridge.nextPromptAt }) { prompt, acknowledged in
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
                    TouchIDFooter(gate: gate, verb: verb, doing: isMessage ? "Signing…" : "Sending…", leaveTitle: "Reject", acknowledges: approval.warnings.filter(\.isStrong).map(\.text).joined(separator: " "), cancelled: "Touch ID was cancelled, so nothing was \(isMessage ? "signed" : "sent").", leave: reject)
                }
                if waitingBehind > 0 {
                    Text("\(waitingBehind) more waiting")
                        .font(.caption)
                        .secondaryText()
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

/// What a request is, the same before and after it's approved. What it says is in `ReviewRows`, with its tests.
private struct SiteRequestSummary<Footer: View>: View {
    let approval: SiteApproval
    let money: (UInt128) -> String
    @ViewBuilder let footer: Footer

    var body: some View {
        switch approval.action {
        case .connect:
            let connect = ReviewRows.connect()
            ConfirmationView(asker: .site(approval.site), hero: connect.hero, rows: connect.rows) {
                footer
            }
        case .transaction(let review):
            ConfirmationView(asker: .site(approval.site), hero: ReviewRows.hero(review), worth: ReviewRows.worth(review, money: money), rows: ReviewRows.rows(review, money: money), warnings: approval.warnings, details: ReviewRows.details(review), data: ReviewRows.data(review)) {
                footer
            }
        case .message(let review):
            ConfirmationView(asker: .site(approval.site), hero: .words(review.title), rows: ReviewRows.rows(review), warnings: approval.warnings, message: ReviewRows.message(review), data: ReviewRows.data(review)) {
                footer
            }
        }
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
                    .secondaryText()
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
