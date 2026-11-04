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
            if let approval = bridge.current {
                SiteApprovalView(approval: approval, waitingBehind: bridge.pending.count - 1) { acknowledged in
                    await bridge.approve(approval.id, acknowledged: acknowledged)
                } reject: {
                    bridge.reject(approval.id)
                }
                .id(approval.id)
            }
        }
        .frame(width: 480)
        .onDisappear { bridge.rejectAll() }
    }
}

struct SiteApprovalView: View {
    let approval: SiteApproval
    let waitingBehind: Int
    let approve: (_ acknowledged: Bool) async -> Void
    let reject: () -> Void

    /// So a window that opens under the pointer can't catch a click meant for the page behind it.
    @State private var isArmed = false
    @State private var acknowledged = false
    @State private var isApproving = false

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
                    Text(amount(review.value, usd: review.valueUsdMicros))
                }
                GridRow {
                    Text("Fee, about").foregroundStyle(.secondary)
                    Text(amount(review.feeWei, usd: review.feeUsdMicros))
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
                DisclosureGroup("What it sends to the contract") {
                    longText("0x" + Hex.encode(review.data))
                }
                .font(.callout)
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

    private func amount(_ wei: UInt128, usd: UInt128?) -> String {
        let eth = "\(Format.amount(String(wei), decimals: 18)) ETH"
        return usd.map { "\(eth) (\(HotWalletWording.usd($0)))" } ?? eth
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
