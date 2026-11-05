import SwiftUI

/// What's behind a number: how it's worked out, in the server's words, then its legs, their prices and transactions.
public struct ExplanationPane: View {
    let target: ExplainTarget
    let store: PortfolioStore
    /// Opens the questions about an asset, which is what fixes an unknown cost.
    let onResolve: ((String) -> Void)?
    @State private var model: ExplanationModel
    @Environment(\.opensFirstProof) private var opensFirstProof

    public init(target: ExplainTarget, store: PortfolioStore, onResolve: ((String) -> Void)? = nil) {
        self.target = target
        self.store = store
        self.onResolve = onResolve
        _model = State(initialValue: ExplanationModel(fetch: { try await store.explanation(for: $0) }))
    }

    public var body: some View {
        Group {
            if let explanation = model.explanation {
                content(explanation)
            } else if let failure = model.failure {
                ContentUnavailableView("Couldn't load this", systemImage: "exclamationmark.triangle", description: Text(failure))
            } else {
                ProgressView().controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: store.explanationRequest(for: target)) {
            await model.show(store.explanationRequest(for: target))
        }
        .onChange(of: store.portfolio?.latest.blockNum) {
            Task { await model.refresh() }
        }
    }

    /// It has no single number to be missing: its lines are the answer.
    private var isBalanceCheck: Bool {
        if case .asset(_, .onchain) = target { true } else { false }
    }

    /// An asset's number is named by the picker above, which also says which asset it is.
    private var hasMetricPicker: Bool {
        if case .asset(let asset, _) = target { store.portfolio?.positions.contains { $0.asset == asset } == true } else { false }
    }

    /// How many questions answering would fix this asset's unknown costs.
    private func questionCount(for asset: String) -> Int {
        store.portfolio?.questions.count { $0.arrivals.contains { $0.asset == asset } } ?? 0
    }

    private func content(_ explanation: Explanation) -> some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    if !hasMetricPicker {
                        Text(explanation.title).font(.headline).help(Wording.pnlHelp(for: explanation.title) ?? "")
                    }
                    if let value = explanation.value {
                        LiveNumber(value).font(.sheetTitle).help(Wording.pnlHelp(for: explanation.title) ?? "")
                    } else if !isBalanceCheck {
                        WarningText("Unavailable").font(.title3.weight(.semibold))
                    }
                    if let sourceValue = explanation.sourceValue {
                        Text(sourceValue).font(.callout).monospacedDigit().foregroundStyle(.secondary)
                    }
                    ForEach(explanation.lines, id: \.self) { line in
                        Text(line)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                            .help(Wording.pnlHelp(for: line) ?? "")
                    }
                    if store.feed.isStale {
                        WarningText("Not updating").font(.callout)
                    }
                }
                .padding(.vertical, 4)
            }
            Section(Wording.activityTitle(count: explanation.legCount, shown: explanation.legs.count)) {
                let first = explanation.legs.first(where: \.hasTransaction)?.id
                ForEach(explanation.legs) { leg in
                    LegRow(leg: leg, currency: explanation.currency, store: store, questions: questionCount(for: leg.asset), showsProof: opensFirstProof && leg.id == first, onResolve: onResolve)
                }
            }
        }
    }
}

public struct LegRow: View {
    let leg: ExplanationLeg
    let currency: CurrencyCode
    let store: PortfolioStore
    /// Questions whose answers would fix what isn't known about it.
    let questions: Int
    let onResolve: ((String) -> Void)?
    @State private var showsProof = false

    public init(leg: ExplanationLeg, currency: CurrencyCode, store: PortfolioStore, questions: Int = 0, showsProof: Bool = false, onResolve: ((String) -> Void)? = nil) {
        self.leg = leg
        self.currency = currency
        self.store = store
        self.questions = questions
        self.onResolve = onResolve
        _showsProof = State(initialValue: showsProof)
    }

    /// A fee is a cost of doing something, not something the person did, so it reads quieter. Its unknown is a word, not a line, with the reason in its tooltip.
    private var isFee: Bool { leg.kind == "gas" }

    public var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(leg.summary)
                    .font(isFee ? .callout : .body)
                    .fontWeight(isFee ? .regular : .medium)
                    .foregroundStyle(isFee ? .secondary : .primary)
                    .fixedSize(horizontal: false, vertical: true)
                    .help(Wording.pnlHelp(for: leg.effect) ?? "")
                Spacer(minLength: 8)
                if let date = leg.date {
                    Text(Format.time(date)).font(.caption).foregroundStyle(.secondary)
                }
            }
            if isFee {
                // Two lines at most, with Proof at the end of the second.
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Tag("\(Format.signedAmount(leg.delta, decimals: leg.decimals)) \(leg.asset)")
                    if leg.priceMicros == nil {
                        Tag("No price", isWarning: true)
                    }
                    if let unknown = leg.unknown {
                        Tag("Gain unknown", isWarning: true).help(unknown)
                    }
                    Spacer(minLength: 8)
                    proofButton
                }
            } else {
                tags
                if let unknown = leg.unknown {
                    WarningText(unknown).font(.callout).fixedSize(horizontal: false, vertical: true)
                }
                if let note = leg.priceNote {
                    Text(note).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                HStack(spacing: 14) {
                    proofButton
                    if leg.answerable, questions > 0, let onResolve {
                        Button(Wording.answerQuestions(questions)) { onResolve(leg.asset) }
                            .buttonStyle(.plain)
                            .foregroundStyle(.tint)
                            .help("Say where this \(leg.asset) came from, so its cost can be worked out")
                    }
                }
                .font(.caption)
            }
            if showsProof {
                details
            }
        }
        .padding(.vertical, 3)
        .contextMenu {
            if leg.hasTransaction || hasBreakdown {
                Button(showsProof ? "Hide \(proofTitle)" : "Show \(proofTitle)") { showsProof.toggle() }
            }
            if leg.hasTransaction {
                Divider()
                TransactionActions(hash: leg.txHash)
            }
        }
    }

    private var proofTitle: String { leg.hasTransaction ? "Proof" : "Details" }

    private var hasBreakdown: Bool { leg.netting != nil || leg.conversion != nil }

    /// The one way into the block, the hash, the breakdown and where the price comes from.
    @ViewBuilder
    private var proofButton: some View {
        if leg.hasTransaction || hasBreakdown {
            Button {
                showsProof.toggle()
            } label: {
                Label(proofTitle, systemImage: showsProof ? "chevron.down" : "chevron.right")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.tint)
            .font(.caption)
        }
    }

    /// How the sentence was worked out, the transaction, and where its price comes from. Proof stays one click away, since the demo shows it.
    private var details: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(leg.effect).").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            if let netting = leg.netting {
                Text(netting).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            }
            if let conversion = leg.conversion {
                Text(conversion).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            }
            if leg.hasTransaction {
                Text("Block \(Format.block(leg.blockNum)) · \(Format.shortHash(leg.txHash))")
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .help(leg.txHash)
                HStack(spacing: 12) { TransactionActions(hash: leg.txHash) }
                    .font(.caption)
                    .buttonStyle(.plain)
                    .foregroundStyle(.tint)
                if let address = store.address {
                    ProofPanel(leg: leg.id, address: address, store: store, costNote: leg.costSource.map { Wording.costProof(source: $0, label: leg.costLabel) }).id("\(address):\(leg.id):\(currency.rawValue):\(store.selectedRule ?? "")")
                }
            }
        }
        .padding(.top, 2)
    }

    private var tags: some View {
        // Price and cost stay apart: one is a shared fact with a source, the other is this wallet's.
        // Plain words take more room, so they stack when the inspector is too narrow for one line.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { tagList }
            VStack(alignment: .leading, spacing: 3) { tagList }
        }
    }

    @ViewBuilder
    private var tagList: some View {
        Tag("\(Format.signedAmount(leg.delta, decimals: leg.decimals)) \(leg.asset)")
        if let price = leg.priceMicros, let source = leg.priceSource {
            Tag("\(Format.price(price, currency)) · \(Wording.priceSource(source))")
                .help("The price per \(leg.asset) at this block. Proof says where it comes from.")
        } else {
            Tag("No price", isWarning: true)
        }
        // An unknown cost has its own line below, with what fixes it.
        if leg.isIncoming, leg.costLabel != "unknown" {
            Tag(Wording.costTag(leg.costLabel, source: leg.costSource))
        }
        if leg.estimated { Tag("Estimate") }
    }
}

/// A fact about a movement. It's plain text, or a warning's color when it's unknown, because only a price can be clicked.
struct Tag: View {
    let text: String
    let isWarning: Bool

    init(_ text: String, isWarning: Bool = false) {
        self.text = text
        self.isWarning = isWarning
    }

    var body: some View {
        Text(text)
            .font(.caption.weight(.medium))
            .monospacedDigit()
            .lineLimit(1)
            .foregroundStyle(isWarning ? Tone.warning.style : AnyShapeStyle(.secondary))
    }
}

extension EnvironmentValues {
    /// Opens the first transaction's Proof, for a screenshot that can't click.
    @Entry public var opensFirstProof = false
}
