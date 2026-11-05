import SwiftUI

/// Where a row's price comes from, the datasets behind it, and a check of its block that says plainly what it doesn't cover.
struct ProofPanel: View {
    @State private var model: ProofModel
    /// Where its cost comes from, when it isn't the chain. That's on this device, so the server's proof can't say.
    private let costNote: String?

    init(leg: String, address: String, store: PortfolioStore, costNote: String? = nil) {
        self.costNote = costNote
        _model = State(initialValue: ProofModel(
            fetch: { try await store.proof(leg: leg, address: address) },
            verify: { try await store.verification(leg: leg, address: address) }
        ))
    }

    init(model: ProofModel, costNote: String? = nil) {
        self.costNote = costNote
        _model = State(initialValue: model)
    }

    var body: some View {
        Group {
            if let proof = model.proof {
                content(proof)
            } else if let failure = model.failure {
                WarningText(failure)
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .font(.caption)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .task { await model.load() }
    }

    private func content(_ proof: Proof) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            section("Where this price comes from") {
                lines(proof.source)
                lines(proof.movements, style: .secondary)
                ForEach(proof.links) { link in
                    if let destination = link.destination {
                        Link(destination: destination) {
                            Label(link.title, systemImage: "arrow.up.right.square")
                        }
                    }
                }
            }
            if let costNote {
                section("Where its cost comes from") {
                    lines([costNote])
                }
            }
            if !proof.datasets.isEmpty {
                section("The recipe") {
                    ForEach(proof.datasets) { dataset in
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(dataset.title): \(dataset.name)").textSelection(.enabled)
                            if let hash = dataset.hash {
                                // On one line, because wrapping can add a hyphen, which would make it a different hash. Copying gets all of it.
                                Text(hash)
                                    .font(.caption.monospaced())
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                    .textSelection(.enabled)
                                    .help("This dataset's fingerprint: \(hash)")
                            } else {
                                WarningText("Its fingerprint couldn't be read.")
                            }
                        }
                    }
                }
            }
            verifySection(proof)
            if !proof.scope.isEmpty {
                DisclosureGroup("What this does and doesn't show") {
                    lines(proof.scope, style: .secondary)
                }
            }
        }
    }

    @ViewBuilder
    private func verifySection(_ proof: Proof) -> some View {
        if let unavailable = proof.unavailable {
            Text(unavailable).foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Button(model.verification == nil ? "Verify block \(Format.block(proof.blockNum))" : "Verify again") {
                        Task { await model.verify() }
                    }
                    .controlSize(.small)
                    .disabled(model.isVerifying)
                    if model.isVerifying {
                        ProgressView().controlSize(.small)
                        Text("Checking this block…").foregroundStyle(.secondary)
                    }
                }
                if let failure = model.verificationFailure {
                    WarningText(failure)
                }
                if let verification = model.verification {
                    result(verification)
                }
            }
        }
    }

    private func result(_ verification: Verification) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verification.summary)
                .fontWeight(.semibold)
                .foregroundStyle(verification.status == .passed ? Tone.neutral.style : Tone.warning.style)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(verification.checks) { check in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: symbol(for: check.status))
                        .foregroundStyle(check.status == .passed ? Tone.gain.style : Tone.warning.style)
                        .accessibilityLabel(check.status.rawValue)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(check.title).fontWeight(.medium)
                        Text(check.detail).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    }
                }
            }
        }
    }

    private func symbol(for status: CheckStatus) -> String {
        switch status {
        case .passed: "checkmark.circle.fill"
        case .failed: "xmark.octagon.fill"
        case .unchecked: "questionmark.circle.fill"
        }
    }

    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).fontWeight(.semibold)
            content()
        }
    }

    private func lines(_ lines: [String], style: HierarchicalShapeStyle = .primary) -> some View {
        ForEach(lines, id: \.self) { line in
            Text(line).foregroundStyle(style).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
        }
    }
}
