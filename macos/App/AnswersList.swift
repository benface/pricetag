import PricetagKit
import SwiftUI

/// Everything the user has said about where things came from, newest first. Each one can be changed or taken back, and Undo Last Answer
/// works on these changes too. Forgetting all of them is the rare thing, so it comes last.
struct AnswersList: View {
    let store: PortfolioStore
    @State private var isConfirmingForget = false

    var body: some View {
        let entries = store.answerEntries
        Section {
            if entries.isEmpty {
                Text("Nothing yet. When the app can't tell what you paid for something, it asks, and what you say is listed here.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(entries) { entry in
                AnswerRow(store: store, entry: entry)
            }
        } header: {
            Text("Your Answers")
        } footer: {
            Text("They stay on this Mac. They're only sent to your server to work out your numbers, and it doesn't keep them.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        Section {
            Button("Forget All My Answers…", role: .destructive) { isConfirmingForget = true }
                .disabled(!store.hasAnswers)
                .confirmationDialog("Forget all your answers?", isPresented: $isConfirmingForget) {
                    Button("Forget All", role: .destructive) { store.setBook(Book()) }
                } message: {
                    Text("Every question comes back, and what you paid is unknown again until you answer. Undo Last Answer brings them back.")
                }
        }
    }
}

private struct AnswerRow: View {
    let store: PortfolioStore
    let entry: AnswerEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            LabeledContent {
                HStack(spacing: 6) {
                    control
                    Button("Remove Answer", systemImage: "minus.circle", role: .destructive) { store.removeAnswer(entry) }
                        .labelStyle(.iconOnly)
                        .buttonStyle(.borderless)
                        .help("Takes this answer back, so it's asked again")
                }
            } label: {
                Text(title).textSelection(.enabled)
                if let detail { Text(detail) }
            }
            .help(store.answeredAt(entry).map { "Answered \(Format.time($0))" } ?? "")
            if case .sender(_, let answer) = entry.said, answer.kind == .myExchange {
                exchangeCosts(answer.costs ?? [])
            }
        }
        .contextMenu {
            Button("Remove Answer", role: .destructive) { store.removeAnswer(entry) }
        }
    }

    @ViewBuilder
    private var control: some View {
        switch entry.said {
        case .sender(_, let answer):
            Picker("Answer", selection: Binding(get: { Ownership(answer.kind) }, set: { store.changeAnswer(entry, to: $0.answer.kind) })) {
                ForEach(Ownership.allCases) { Text($0.title).tag($0) }
            }
            .labelsHidden()
            .fixedSize()
        case .cost(_, let money):
            CostField(money: money) { store.changeCost(entry, to: $0) }
        case .imported:
            EmptyView()
        }
    }

    /// What was paid for what came from an exchange account, one line for each time it was said.
    private func exchangeCosts(_ costs: [ExchangeCost]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if costs.isEmpty {
                Text("What you paid isn't said yet, so it's asked next time.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            ForEach(Array(costs.enumerated()), id: \.offset) { index, cost in
                LabeledContent("Paid for its \(cost.asset)") {
                    CostField(money: Money(micros: cost.micros, currency: cost.currency)) { store.changeCost(entry, index: index, to: $0) }
                }
                .font(.callout)
            }
        }
        .padding(.leading, 12)
    }

    private var title: String {
        switch entry.said {
        case .sender(let address, _):
            return name(of: address).map { "\($0) · \(Format.shortHash(address))" } ?? Format.shortHash(address)
        case .cost(let key, _):
            guard let subject = CostSubject(key: key) else { return key }
            let place = subject.transaction.map { "in transaction \(Format.shortHash($0))" } ?? subject.block.map { "that arrived in block \(Format.block($0))" } ?? ""
            let wallet = isShowing(subject.wallet) ? "" : ", in \(name(of: subject.wallet) ?? Format.shortHash(subject.wallet))"
            return "\(subject.asset) \(place)\(wallet)"
        case .imported(let withdrawals):
            return "\(exchangeName(withdrawals.first?.exchange)) history"
        }
    }

    private var detail: String? {
        var parts: [String] = []
        if case .imported(let withdrawals) = entry.said {
            parts.append(withdrawals.count == 1 ? "1 withdrawal" : "\(Format.block(withdrawals.count)) withdrawals")
        } else if let about = store.about(entry) {
            parts.append(about)
        }
        if let date = store.answeredAt(entry) { parts.append(date.formatted(.dateTime.month(.abbreviated).day().locale(Locale(identifier: "en_US")))) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func name(of address: String) -> String? {
        if isShowing(address) { return "This wallet" }
        return store.savedWallets.first { $0.address.lowercased() == address }?.name
    }

    /// The demo's answers are about its fixtures' address, which is what the server reads in place of "demo".
    private func isShowing(_ address: String) -> Bool {
        guard let showing = store.address?.lowercased() else { return false }
        return address == showing || (WalletAddress.isDemo(address) && WalletAddress.isDemo(showing))
    }

    private func exchangeName(_ id: String?) -> String {
        guard let id, !id.isEmpty else { return "Exchange" }
        return id.prefix(1).uppercased() + id.dropFirst()
    }
}

/// An amount that was paid, as it was entered, in the currency it was entered in. It changes once it's a real amount and typing's done.
private struct CostField: View {
    let money: Money
    let onChange: (String) -> Void
    @State private var text = ""
    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: 4) {
            TextField("Paid", text: $text, prompt: Text("0.00"))
                .labelsHidden()
                .textFieldStyle(.roundedBorder)
                .multilineTextAlignment(.trailing)
                .monospacedDigit()
                .frame(width: 96)
                .focused($isFocused)
                .onSubmit(commit)
                .onChange(of: isFocused) { _, focused in if !focused { commit() } }
                .accessibilityLabel("What you paid, in \(money.currency.rawValue)")
            Text(money.currency.rawValue).foregroundStyle(.secondary)
        }
        .onAppear { text = Format.typed(money.micros) }
        .onChange(of: money) { text = Format.typed(money.micros) }
    }

    private func commit() {
        guard let micros = Format.micros(fromDollars: text) else {
            text = Format.typed(money.micros)
            return
        }
        if micros != money.micros { onChange(micros) }
    }
}

private extension Ownership {
    init(_ kind: SenderAnswer.Kind) {
        self = switch kind {
        case .mine: .mine
        case .myExchange: .myExchange
        case .someoneElse: .someoneElse
        }
    }
}
