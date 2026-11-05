import HotWalletKit
import KeyVault
import PricetagKit
import SwiftUI

/// Where every approval happens. It's here and not on the page or in the extension, because nothing a site controls can draw in
/// this window or press its buttons. Rejecting is the default, and closing the window rejects too.
struct SiteApprovalWindow: View {
    let bridge: SiteBridge

    var body: some View {
        Group {
            if let failure = bridge.failure {
                SiteFailureView(failure: failure) { bridge.dismissFailure() }
            } else if let approval = bridge.current {
                SiteApprovalView(approval: approval, waitingBehind: bridge.pending.count - 1, usd: bridge.usd) { acknowledged in
                    await bridge.approve(approval.id, acknowledged: acknowledged)
                } reject: {
                    bridge.reject(approval.id)
                }
                .id(approval.id)
            } else if let working = bridge.working {
                SiteWorkingView(work: working)
            }
        }
        .frame(width: 480)
        // Closing it answers what's on show. If that was a failure, what's waiting behind it comes up next, because nobody has seen it yet.
        .onDisappear {
            if bridge.failure != nil {
                bridge.dismissFailure()
            } else {
                bridge.rejectAll()
            }
        }
    }
}

struct SiteApprovalView: View {
    let approval: SiteApproval
    let waitingBehind: Int
    let usd: (UInt128) -> String
    let approve: (_ acknowledged: Bool) async -> Void
    let reject: () -> Void

    /// So a window that opens under the pointer can't catch a click meant for the page behind it.
    @State private var isArmed = false
    @State private var acknowledged = false
    @State private var isApproving = false
    @State private var showsData = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 2) {
                Text(site)
                    .font(.title2.bold())
                    .textSelection(.enabled)
                    .lineLimit(2)
                    .truncationMode(.middle)
                Text(asking)
                    .foregroundStyle(.secondary)
            }
            details
            ForEach(approval.warnings) { warning in
                if warning.isStrong {
                    StrongWarning(text: warning.text)
                } else {
                    Notice(.info, warning.text)
                }
            }
            if approval.needsAcknowledgment {
                Toggle("I understand, and I trust this site", isOn: $acknowledged)
            }
            HStack {
                if waitingBehind > 0 {
                    Text("\(waitingBehind) more waiting")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Reject", action: reject)
                    .keyboardShortcut(.defaultAction)
                Button(approveTitle) {
                    isApproving = true
                    Task {
                        await approve(acknowledged)
                        isApproving = false
                    }
                }
                .disabled(!isArmed || isApproving || (approval.needsAcknowledgment && !acknowledged))
                .help(approval.needsAcknowledgment && !acknowledged ? "Read the warning first" : "")
            }
        }
        .padding(20)
        .onExitCommand(perform: reject)
        .task {
            try? await Task.sleep(for: .seconds(1))
            isArmed = true
        }
    }

    /// Without https://, which is the only scheme a site can have here apart from this Mac's own.
    private var site: String {
        approval.origin.hasPrefix("https://") ? String(approval.origin.dropFirst(8)) : approval.origin
    }

    private var asking: String {
        switch approval.action {
        case .connect: "wants to connect to your \(HotWalletWording.title.lowercased())"
        case .transaction: "wants to send a transaction from your \(HotWalletWording.title.lowercased())"
        case .message: "wants your signature"
        }
    }

    private var approveTitle: String {
        switch approval.action {
        case .connect: "Connect"
        case .transaction: "Approve and Send"
        case .message: "Sign"
        }
    }

    @ViewBuilder
    private var details: some View {
        switch approval.action {
        case .connect:
            Text("It will see this wallet's address and balances, and can ask you to approve things here. It can't move anything without you, and it can't see your savings.")
                .fixedSize(horizontal: false, vertical: true)
        case .transaction(let review):
            transaction(review)
        case .message(let review):
            message(review)
        }
    }

    private func transaction(_ review: TransactionReview) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(review.headline)
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 4) {
                GridRow {
                    Text("Sends").foregroundStyle(.secondary)
                    // To the last digit, because this is what's being approved.
                    Text(amount(Money.text(ofUnits: review.value, decimals: 18), usdMicros: review.valueUsdMicros))
                }
                GridRow {
                    Text("Fee, about").foregroundStyle(.secondary)
                    Text(amount(Format.amount(String(review.feeWei), decimals: 18), usdMicros: review.feeUsdMicros))
                }
                GridRow {
                    Text("To").foregroundStyle(.secondary)
                    Text(review.toName.map { "\($0) (\(review.to.checksummed))" } ?? review.to.checksummed)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                }
            }
            .monospacedDigit()
            if !review.data.isEmpty {
                // Its own button and not a DisclosureGroup, whose focus ring gets cut off at the edge of a window this narrow.
                Button {
                    showsData.toggle()
                } label: {
                    Label("What it sends to the contract", systemImage: showsData ? "chevron.down" : "chevron.right")
                        .font(.callout)
                        .padding(.vertical, 2)
                        .padding(.horizontal, 4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityValue(showsData ? "Showing" : "Hidden")
                if showsData {
                    longText("0x" + Hex.encode(review.data))
                }
            }
        }
    }

    private func message(_ review: MessageReview) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(review.headline)
                .font(.headline)
            if let contract = review.contract {
                Text("For the contract \(contract.checksummed)")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            longText(review.body)
        }
    }

    private func longText(_ text: String) -> some View {
        ScrollView {
            Text(text)
                .font(.caption.monospaced())
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
        }
        .frame(maxHeight: 220)
        .fixedSize(horizontal: false, vertical: true)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func amount(_ text: String, usdMicros: UInt128?) -> String {
        usdMicros.map { "\(text) ETH (\(usd($0)))" } ?? "\(text) ETH"
    }
}

/// Between approving and the transaction going out, which can take a few seconds when the network is busy.
private struct SiteWorkingView: View {
    let work: SiteWork

    var body: some View {
        HStack(spacing: 10) {
            ProgressView().controlSize(.small)
            Text(work.isTransaction ? "Sending for \(work.origin)…" : "Signing for \(work.origin)…")
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(20)
    }
}

/// It's approved, and it didn't happen. The site will say something too, but only this knows why.
private struct SiteFailureView: View {
    let failure: SiteFailure
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 2) {
                Text(failure.isTransaction ? "This Transaction Didn't Go Out" : "This Wasn't Signed")
                    .font(.title2.bold())
                Text(failure.origin)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            Notice(.warning, failure.reason)
                .textSelection(.enabled)
            if failure.isTransaction {
                Text("Nothing was sent, so no money moved.")
            }
            HStack {
                Spacer()
                Button("OK", action: dismiss)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .onExitCommand(perform: dismiss)
    }
}

private struct StrongWarning: View {
    let text: String

    var body: some View {
        Label(text, systemImage: "exclamationmark.octagon.fill")
            .font(.callout.weight(.medium))
            .foregroundStyle(.white)
            .fixedSize(horizontal: false, vertical: true)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.red, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}
