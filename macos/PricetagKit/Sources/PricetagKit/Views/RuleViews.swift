import SwiftUI

/// The switch, for Settings. Each rule shows its dataset and fingerprint, so what's on is never a matter of trust.
public struct RulePicker: View {
    let store: PortfolioStore

    public init(store: PortfolioStore) {
        self.store = store
    }

    public var body: some View {
        Picker(Wording.rulesTitle, selection: Binding(get: { store.selectedRule ?? store.rules.first?.id ?? "" }, set: { store.setRule($0) })) {
            ForEach(store.rules) { rule in
                VStack(alignment: .leading, spacing: 2) {
                    Text(rule.name)
                    Text(rule.summary).font(.caption).foregroundStyle(.secondary)
                    Text("\(rule.dataset) · \(Wording.shortManifestHash(rule.hash))")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .help(rule.hash)
                }
                .tag(rule.id)
            }
        }
        #if os(macOS)
        .pickerStyle(.radioGroup)
        #else
        .pickerStyle(.inline)
        #endif
    }
}

/// One wallet by both rules, side by side, and why they differ. Each number was read at the same block.
public struct RuleComparisonTable: View {
    let comparison: RuleComparison

    public init(comparison: RuleComparison) {
        self.comparison = comparison
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(comparison.why).fixedSize(horizontal: false, vertical: true)
            Grid(alignment: .trailing, horizontalSpacing: 16, verticalSpacing: 6) {
                GridRow {
                    Text("At block \(Format.block(comparison.blockNum))").gridColumnAlignment(.leading)
                    Text(comparison.a.name)
                    Text(comparison.b.name)
                    Text("Difference")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                Divider()
                ForEach(comparison.rows) { row in
                    line(row.label, format: row.format, a: row.a, b: row.b, difference: row.difference)
                }
                // In the same grid, so the columns line up with the ones above.
                if !comparison.transactions.isEmpty {
                    Text("Transactions that came out differently")
                        .font(.subheadline.weight(.semibold))
                        .gridCellColumns(4)
                        .gridCellAnchor(.leading)
                        .padding(.top, 8)
                    ForEach(comparison.transactions) { tx in
                        line("\(tx.asset) \(tx.label.lowercased()) · \(Format.shortHash(tx.txHash))", format: "money", a: tx.a, b: tx.b, difference: tx.difference)
                    }
                }
            }
            if comparison.changedTxs > comparison.transactions.count {
                Text("The newest \(comparison.transactions.count) of the amounts that changed, across \(comparison.changedTxs) transactions.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .monospacedDigit()
        .textSelection(.enabled)
    }

    private func line(_ label: String, format: String, a: String?, b: String?, difference: String?) -> some View {
        GridRow {
            Text(label).gridColumnAlignment(.leading)
            Text(Format.ruleValue(a, format: format, currency: comparison.currency))
            Text(Format.ruleValue(b, format: format, currency: comparison.currency))
            Text(Format.ruleDifference(difference, format: format, currency: comparison.currency))
        }
    }
}

/// Reads the comparison, and says plainly when it can't.
public struct RuleComparisonSheet: View {
    let store: PortfolioStore
    @Environment(\.dismiss) private var dismiss
    @State private var comparison: RuleComparison?
    @State private var failure: String?
    @State private var isReading = false

    public init(store: PortfolioStore) {
        self.store = store
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Compare pricing rules").font(.title3.weight(.semibold))
            ScrollView {
                Group {
                    if let failure {
                        WarningText(failure)
                    } else if let comparison {
                        RuleComparisonTable(comparison: comparison)
                    } else {
                        Text("Reading this wallet by both rules. The first read of each can take a minute.").foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack {
                Button(isReading ? "Reading both…" : "Compare Again") { Task { await read() } }
                    .disabled(isReading)
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(minWidth: 660, minHeight: 420)
        .task { await read() }
    }

    private func read() async {
        isReading = true
        defer { isReading = false }
        do {
            comparison = try await store.comparison()
            failure = nil
        } catch is CancellationError {
            return
        } catch FetchError.ampUnavailable(let message), FetchError.noAmpConfigured(let message), FetchError.rejected(let message) {
            // Numbers from another moment aren't kept next to a failure.
            comparison = nil
            failure = message
        } catch {
            comparison = nil
            failure = "Can't reach the server."
        }
    }
}
