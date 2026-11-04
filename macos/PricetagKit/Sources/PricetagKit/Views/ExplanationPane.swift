import SwiftUI

/// What's behind a number: how it's worked out, in the server's words, then its legs, their prices and transactions.
/// Reads again on each new block, unless it's still reading. While it does, the last answer stays up, so nothing flashes.
public struct ExplanationPane: View {
    let target: ExplainTarget
    let store: PortfolioStore
    @State private var loaded: Loaded?
    @State private var failure: String?
    @State private var isLoading = false

    private struct Loaded {
        let target: ExplainTarget
        let explanation: Explanation
    }

    private struct LoadKey: Hashable {
        let target: ExplainTarget
        let method: CostMethod
    }

    public init(target: ExplainTarget, store: PortfolioStore) {
        self.target = target
        self.store = store
    }

    public var body: some View {
        Group {
            if let loaded, loaded.target == target {
                content(loaded.explanation)
            } else if let failure {
                ContentUnavailableView("Couldn't load this", systemImage: "exclamationmark.triangle", description: Text(failure))
            } else {
                ProgressView().controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: LoadKey(target: target, method: store.method)) {
            await load()
        }
        // Not part of the task's id: a new block must not cancel a read, or a slow one would never finish.
        .onChange(of: store.portfolio?.latest.blockNum) {
            if !isLoading { Task { await load() } }
        }
    }

    private func load() async {
        let target = target
        let method = store.method
        isLoading = true
        defer { isLoading = false }
        do {
            let explanation = try await store.explanation(of: target)
            // Something else was picked while this was on its way.
            guard target == self.target, method == store.method else { return }
            loaded = Loaded(target: target, explanation: explanation)
            failure = nil
        } catch is CancellationError {
            return
        } catch {
            if target == self.target, loaded?.target != target {
                loaded = nil
                failure = (error as? FetchError).map(Self.message) ?? "The server didn't answer."
            }
        }
    }

    private static func message(_ error: FetchError) -> String {
        switch error {
        case .unreachable: "Can't reach the server."
        case .ampUnavailable(let message), .noAmpConfigured(let message), .rejected(let message): message
        }
    }

    private func content(_ explanation: Explanation) -> some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(explanation.title).font(.headline)
                    if let value = explanation.value {
                        LiveNumber(value).font(.title2.weight(.semibold))
                    } else {
                        WarningText("Unavailable").font(.title3.weight(.semibold))
                    }
                    ForEach(explanation.lines, id: \.self) { line in
                        Text(line)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    }
                    if !store.feed.isLive, store.portfolio != nil {
                        WarningText("Not updating").font(.callout)
                    }
                }
                .padding(.vertical, 4)
            }
            Section(legsTitle(explanation)) {
                ForEach(explanation.legs) { leg in
                    LegRow(leg: leg)
                }
            }
        }
    }

    private func legsTitle(_ explanation: Explanation) -> String {
        let count = explanation.legCount
        let total = count == 1 ? "1 leg" : "\(Format.block(count)) legs"
        return count > explanation.legs.count ? "\(total), newest \(explanation.legs.count) shown" : total
    }
}

public struct LegRow: View {
    let leg: ExplanationLeg

    public init(leg: ExplanationLeg) {
        self.leg = leg
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
            Text("\(leg.effect).").font(.callout).fixedSize(horizontal: false, vertical: true)
            if let note = leg.priceNote {
                Text(note).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if let netting = leg.netting {
                Text(netting).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 6) {
                if let url = leg.transactionURL {
                    Link(destination: url) {
                        Label("\(Format.shortHash(leg.txHash)) on Basescan", systemImage: "arrow.up.right.square")
                    }
                }
                Spacer(minLength: 0)
                Text("Block \(Format.block(leg.blockNum))").foregroundStyle(.secondary).monospacedDigit()
            }
            .font(.caption)
        }
        .padding(.vertical, 3)
    }

    private var tags: some View {
        // Price and cost stay apart: one is a shared fact with a source, the other is this wallet's.
        HStack(spacing: 4) {
            Tag(leg.kind)
            if let price = leg.priceUsdMicros, let source = leg.priceSource {
                Tag("\(Format.price(price)) · \(source)")
            } else {
                Tag("No price", isWarning: true)
            }
            if leg.isIncoming {
                if leg.costLabel == "unknown" {
                    Tag("Cost unknown", isWarning: true)
                } else {
                    Tag("Cost: \(leg.costLabel)")
                }
            }
        }
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
