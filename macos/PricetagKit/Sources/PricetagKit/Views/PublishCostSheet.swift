import SwiftUI

/// Says what publishing a cost gives away before anything's signed, because nothing can take it back.
public struct PublishCostSheet: View {
    let draft: CostNoteDraft
    /// What the rest of the app is showing. A note's always in USD, whatever this is.
    let currency: CurrencyCode
    let publish: (String) async -> Bool
    /// Why it didn't go out, if it was anything but them changing their mind.
    let problem: () -> String?
    /// Read here rather than passed in, so this follows it while it's open.
    let isPublishing: () -> Bool
    @State private var usd: String
    @State private var shownProblem: String?
    @Environment(\.dismiss) private var dismiss

    public init(draft: CostNoteDraft, currency: CurrencyCode, typed: String, publish: @escaping (String) async -> Bool, problem: @escaping () -> String?, isPublishing: @escaping () -> Bool) {
        self.draft = draft
        self.currency = currency
        self.publish = publish
        self.problem = problem
        self.isPublishing = isPublishing
        _usd = State(initialValue: typed)
    }

    private var micros: String? { Format.micros(fromDollars: usd) }

    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Publish This Cost?")
                .font(.title2.bold())
            Notice(.warning, "Anyone can read this, forever. It publicly ties what you paid to this wallet, and it can't be deleted or changed. Saving it on this Mac keeps it private.")
            LabeledContent("Paid for \(Format.amount(draft.units, decimals: draft.decimals)) \(draft.asset), in USD") {
                TextField("$0.00", text: $usd)
                    .textFieldStyle(.roundedBorder)
                    .multilineTextAlignment(.trailing)
                    .frame(width: 140)
                    .disabled(isPublishing())
            }
            if let micros {
                Text("This wallet would publish that it paid \(Format.usd(Format.money(micros, .USD), beside: currency)) in transaction \(Format.shortHash(draft.txHash)).")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text("It's a transaction from this wallet to itself, so it costs a small network fee and moves nothing else. Touch ID or your password confirms it.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let shownProblem {
                WarningText(shownProblem).font(.callout).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                if isPublishing() { ProgressView().controlSize(.small) }
                // Touch ID's own prompt can still say no. Past that, closing this wouldn't stop what's on its way.
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(isPublishing())
                Button("Publish for Everyone") {
                    shownProblem = nil
                    Task {
                        if await publish(usd) {
                            dismiss()
                        } else {
                            shownProblem = problem()
                        }
                    }
                }
                .disabled(micros == nil || isPublishing())
            }
        }
        .padding(20)
        .frame(width: 460)
        .interactiveDismissDisabled(isPublishing())
    }
}
