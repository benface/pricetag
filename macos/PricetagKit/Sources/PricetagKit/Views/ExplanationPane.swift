import SwiftUI

/// What's behind a number: how it's worked out, in the server's words, then its legs, their prices and transactions.
public struct ExplanationPane: View {
    let target: ExplainTarget
    let store: PortfolioStore
    @State private var model: ExplanationModel

    public init(target: ExplainTarget, store: PortfolioStore) {
        self.target = target
        self.store = store
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

    private func content(_ explanation: Explanation) -> some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(explanation.title).font(.headline).help(Wording.pnlHelp(for: explanation.title) ?? "")
                    if let value = explanation.value {
                        LiveNumber(value).font(.title2.weight(.semibold))
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
                ForEach(explanation.legs) { leg in
                    LegRow(leg: leg, currency: explanation.currency, store: store)
                }
            }
        }
    }
}

public struct LegRow: View {
    let leg: ExplanationLeg
    let currency: CurrencyCode
    let store: PortfolioStore
    @State private var showsProof = false

    public init(leg: ExplanationLeg, currency: CurrencyCode, store: PortfolioStore) {
        self.leg = leg
        self.currency = currency
        self.store = store
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text("\(Format.signedAmount(leg.delta, decimals: leg.decimals)) \(leg.asset)")
                    .fontWeight(.medium)
                    .monospacedDigit()
                Spacer(minLength: 8)
                if let date = leg.date {
                    Text(Format.time(date)).font(.caption).foregroundStyle(.secondary)
                }
            }
            tags
            Text("\(leg.effect).").font(.callout).fixedSize(horizontal: false, vertical: true).help(Wording.pnlHelp(for: leg.effect) ?? "")
            if let note = leg.priceNote {
                Text(note).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if let netting = leg.netting {
                Text(netting).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if let conversion = leg.conversion {
                Text(conversion).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 6) {
                if let url = leg.transactionURL {
                    Link(destination: url) {
                        Label("\(Format.shortHash(leg.txHash)) on Basescan", systemImage: "arrow.up.right.square")
                    }
                }
                if !leg.opening {
                    Button {
                        showsProof.toggle()
                    } label: {
                        Label("Proof", systemImage: showsProof ? "chevron.down" : "chevron.right")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.tint)
                }
                Spacer(minLength: 0)
                Text("Block \(Format.block(leg.blockNum))").foregroundStyle(.secondary).monospacedDigit()
            }
            .font(.caption)
            if showsProof, let address = store.address {
                ProofPanel(leg: leg.id, address: address, store: store).id("\(address):\(leg.id):\(currency.rawValue):\(store.selectedRule ?? "")")
            }
        }
        .padding(.vertical, 3)
    }

    private var tags: some View {
        // Price and cost stay apart: one is a shared fact with a source, the other is this wallet's.
        // Plain words take more room, so they stack when the inspector is too narrow for one line.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 4) { tagList }
            VStack(alignment: .leading, spacing: 4) { tagList }
        }
    }

    @ViewBuilder
    private var tagList: some View {
        Tag(leg.opening ? Wording.startingBalance : Wording.action(kind: leg.kind, isIncoming: leg.isIncoming))
        if let price = leg.priceMicros, let source = leg.priceSource {
            Button {
                showsProof.toggle()
            } label: {
                Tag("\(Format.price(price, currency)) · \(Wording.priceSource(source))")
            }
            .buttonStyle(.plain)
            .disabled(leg.opening)
            .help(leg.opening ? "" : "See where this price comes from")
        } else {
            Tag("No price", isWarning: true)
        }
        if leg.isIncoming {
            Tag(Wording.costTag(leg.costLabel), isWarning: leg.costLabel == "unknown")
            if leg.partlyUnknown { Tag("Partly unknown", isWarning: true) }
        }
        if leg.estimated { Tag("Estimate") }
    }
}

struct Tag: View {
    let text: String
    let isWarning: Bool

    init(_ text: String, isWarning: Bool = false) {
        self.text = text
        self.isWarning = isWarning
    }

    var body: some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .monospacedDigit()
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .foregroundStyle(isWarning ? Tone.warning.style : AnyShapeStyle(.secondary))
            .background(isWarning ? AnyShapeStyle(Color.orange.opacity(0.16)) : AnyShapeStyle(.quaternary.opacity(0.7)), in: Capsule())
    }
}
