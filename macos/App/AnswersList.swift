import PricetagKit
import SwiftUI

/// Everything the user has said about where things came from, newest first. Each one can be changed or taken back, and Edit's Undo
/// works on these changes too. Forgetting all of them is the rare thing, so it comes last.
struct AnswersList: View {
    let store: PortfolioStore
    @State private var isConfirmingForget = false

    var body: some View {
        let all = store.answerEntries
        // What was paid for what an exchange account sent sits under that account, each one with its own date and Remove.
        let entries = all.filter { if case .exchangeCost = $0.said { false } else { true } }
        Section {
            if entries.isEmpty {
                Text("Nothing yet. When the app can't tell what you paid for something, it asks, and what you say is listed here.")
                    .secondaryText()
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(entries) { entry in
                AnswerRow(store: store, entry: entry, costs: costs(of: entry, in: all))
            }
        } header: {
            Text("Your Answers")
        } footer: {
            Text(Build.isForOtherPeople ? "They stay on this Mac. They're only sent to \(AppName.current)'s server to work out your numbers, and it keeps nothing." : "They stay on this Mac. They're only sent to your price service to work out your numbers, and it doesn't keep them.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        Section {
            Button("Forget All My Answers…", role: .destructive) { isConfirmingForget = true }
                .disabled(!store.hasAnswers)
                .confirmationDialog("Forget all your answers?", isPresented: $isConfirmingForget) {
                    Button("Forget All", role: .destructive) { store.setBook(Book(), action: "Forget All Answers") }
                } message: {
                    Text("Every question comes back, and what you said you paid is unknown again until you answer. What your purchases cost stays. Edit > Undo brings your answers back.")
                }
        }
    }

    /// In the order they were given.
    private func costs(of entry: AnswerEntry, in all: [AnswerEntry]) -> [AnswerEntry] {
        guard case .sender(let address, .myExchange) = entry.said else { return [] }
        return all
            .compactMap { cost -> (Int, AnswerEntry)? in
                guard case .exchangeCost(let sender, let index, _) = cost.said, sender == address else { return nil }
                return (index, cost)
            }
            .sorted { $0.0 < $1.0 }
            .map(\.1)
    }
}

private struct AnswerRow: View {
    let store: PortfolioStore
    let entry: AnswerEntry
    /// What was paid for what this exchange account sent.
    var costs: [AnswerEntry] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            line(entry, title: title, help: removeHelp)
            if case .sender(_, .myExchange) = entry.said {
                exchangeCosts
            }
        }
    }

    /// One answer, with what changes it and what takes it back.
    private func line(_ entry: AnswerEntry, title: String, help: String) -> some View {
        LabeledContent {
            HStack(spacing: 6) {
                control(entry)
                Button("Remove Answer", systemImage: "minus.circle", role: .destructive) { store.removeAnswer(entry) }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
                    .help(help)
            }
        } label: {
            Text(title).textSelection(.enabled)
            if let detail = detail(entry) { Text(detail) }
        }
        .help(store.answeredAt(entry).map { "Answered \(Format.time($0))" } ?? "")
        .contextMenu {
            Button("Remove Answer", role: .destructive) { store.removeAnswer(entry) }
        }
    }

    private var removeHelp: String {
        if case .sender(_, .myExchange) = entry.said { return "Takes back this answer and what you paid, so it's asked again" }
        return "Takes this answer back, so it's asked again"
    }

    @ViewBuilder
    private func control(_ entry: AnswerEntry) -> some View {
        switch entry.said {
        case .sender(_, let kind):
            Picker("Answer", selection: Binding(get: { Ownership(kind) }, set: { store.changeAnswer(entry, to: $0.answer.kind) })) {
                ForEach(Ownership.allCases) { Text($0.title).tag($0) }
            }
            .labelsHidden()
            .fixedSize()
        case .cost(_, let money):
            CostField(money: money) { store.changeCost(entry, to: $0) }
        case .exchangeCost(_, _, let cost):
            CostField(money: Money(micros: cost.micros, currency: cost.currency)) { store.changeCost(entry, to: $0) }
        case .imported:
            EmptyView()
        }
    }

    /// What was paid for what came from an exchange account, one answer for each time it was asked, with where that arrived.
    private var exchangeCosts: some View {
        VStack(alignment: .leading, spacing: 8) {
            if costs.isEmpty {
                Text("What you paid isn't said yet, so it's asked next time.")
                    .font(.callout)
                    .secondaryText()
            }
            ForEach(costs) { cost in
                if case .exchangeCost(_, _, let paid) = cost.said {
                    line(cost, title: "Paid for \(store.about(cost) ?? "its \(paid.asset)")", help: "Takes back what you paid for this, so it's asked again. It stays your exchange account.")
                        .font(.callout)
                }
            }
        }
        .padding(.leading, 12)
    }

    /// Where what a cost covers arrived: one place when there's one, or how many transfers.
    private func place(of receipts: [CostReceipt]) -> String? {
        let subjects = receipts.compactMap { CostSubject(wallet: $0.wallet, legId: $0.legId) }
        let places = Set(subjects.map(\.place))
        guard let first = subjects.first else { return nil }
        let place = places.count == 1 ? first.place.prefix(1).uppercased() + first.place.dropFirst() : "\(receipts.count) transfers"
        let wallets = Set(subjects.map(\.wallet))
        guard wallets.count == 1, !isShowing(first.wallet) else { return place }
        return "\(place), in \(name(of: first.wallet) ?? Format.shortHash(first.wallet))"
    }

    private var title: String {
        switch entry.said {
        case .sender(let address, _):
            return name(of: address).map { "\($0) · \(Format.shortHash(address))" } ?? Format.shortHash(address)
        case .exchangeCost(_, _, let cost):
            return cost.asset
        case .cost(let key, _):
            guard let subject = CostSubject(key: key) else { return key }
            let place = subject.place
            let wallet = isShowing(subject.wallet) ? "" : ", in \(name(of: subject.wallet) ?? Format.shortHash(subject.wallet))"
            return "\(subject.asset) \(place)\(wallet)"
        case .imported(let withdrawals):
            return "\(exchangeName(withdrawals.first?.exchange)) history"
        }
    }

    private func detail(_ entry: AnswerEntry) -> String? {
        var parts: [String] = []
        switch entry.said {
        case .imported(let withdrawals):
            parts.append(withdrawals.count == 1 ? "1 withdrawal" : "\(Format.block(withdrawals.count)) withdrawals")
        case .exchangeCost(_, _, let cost):
            if let place = place(of: cost.receipts) { parts.append(place) }
        case .sender, .cost:
            if let about = store.about(entry) { parts.append(about) }
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
            // The field's label already says the currency.
            Text(money.currency.rawValue).secondaryText().accessibilityHidden(true)
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
