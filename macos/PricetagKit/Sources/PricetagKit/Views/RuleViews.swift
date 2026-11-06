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
                    Text(rule.summary).font(.caption).secondaryText()
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
            Text(comparison.why).font(.callout).secondaryText().fixedSize(horizontal: false, vertical: true)
            ForEach(comparison.warnings, id: \.self) { WarningText($0).font(.caption).fixedSize(horizontal: false, vertical: true) }
            Grid(alignment: .trailing, horizontalSpacing: 16, verticalSpacing: 6) {
                GridRow {
                    Text("At block \(Format.block(comparison.blockNum))").gridColumnAlignment(.leading)
                    Text(comparison.a.name)
                    Text(comparison.b.name)
                    Text("Difference")
                }
                .font(.caption)
                .secondaryText()
                Divider()
                ForEach(comparison.rows) { row in
                    line(row.label, format: row.format, a: row.a, b: row.b, difference: row.difference, aPartial: row.aPartial, bPartial: row.bPartial, aEstimated: row.aEstimated, bEstimated: row.bEstimated)
                }
                // In the same grid, so the columns line up with the ones above.
                if !comparison.transactions.isEmpty {
                    Text("Transactions that came out differently")
                        .font(.subheadline.weight(.semibold))
                        .gridCellColumns(4)
                        .gridCellAnchor(.leading)
                        .padding(.top, 8)
                    ForEach(comparison.transactions) { tx in
                        line("\(tx.asset) \(tx.label.lowercased()) · \(Format.shortHash(tx.txHash))", format: "money", a: tx.a, b: tx.b, difference: tx.difference, aEstimated: tx.aEstimated, bEstimated: tx.bEstimated)
                    }
                }
            }
            if comparison.changedTxs > comparison.transactions.count {
                Text("The newest \(comparison.transactions.count) of the amounts that changed, across \(comparison.changedTxs) transactions.")
                    .font(.caption)
                    .secondaryText()
            }
        }
        .monospacedDigit()
        .textSelection(.enabled)
    }

    private func line(_ label: String, format: String, a: String?, b: String?, difference: String?, aPartial: Bool = false, bPartial: Bool = false, aEstimated: Bool, bEstimated: Bool) -> some View {
        let shownDifference = Format.ruleDifference(difference, format: format, currency: comparison.currency, isEstimate: aEstimated || bEstimated)
        return GridRow {
            Text(label).gridColumnAlignment(.leading)
            value(a, label: label, rule: comparison.a.name, format: format, isPartial: aPartial, isEstimate: aEstimated)
            value(b, label: label, rule: comparison.b.name, format: format, isPartial: bPartial, isEstimate: bEstimated)
            Text(shownDifference)
                .accessibilityElement(children: .ignore)
                // Its dash means it's unknown, not that there's none. "Same" is a known zero.
                .accessibilityLabel(Spoken.number("\(label), difference", difference == nil ? nil : shownDifference))
        }
    }

    /// Each value says what it is and by which rule, since a column header is a long way off for VoiceOver.
    private func value(_ micros: String?, label: String, rule: String, format: String, isPartial: Bool, isEstimate: Bool) -> some View {
        let text = Format.ruleValue(micros, format: format, currency: comparison.currency, isEstimate: isEstimate)
        return HStack(spacing: 4) {
            if isPartial { Text("partial").font(.caption.weight(.medium)).secondaryText() }
            Text(text)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Spoken.number("\(label), by \(rule)", micros == nil ? nil : text, isPartial: isPartial))
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
                        Text("Reading this wallet by both rules. The first read of each can take a minute.").secondaryText()
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
        #if os(macOS)
        // Done is Return's, so Escape closes it too.
        .onExitCommand { dismiss() }
        #endif
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
        } catch FetchError.ampUnavailable(let message), FetchError.noAmpConfigured(let message), FetchError.rejected(let message), FetchError.rateLimited(let message, _) {
            // Numbers from another moment aren't kept next to a failure.
            comparison = nil
            failure = message
        } catch {
            comparison = nil
            failure = failureMessage(for: error)
        }
    }
}
