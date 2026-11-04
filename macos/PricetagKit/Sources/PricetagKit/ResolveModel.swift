// What the "Who's this?" cards need: which one's up, what each answer would do, and answering it. The server does the math.

import Foundation
import Observation

/// One of the three answers about who a sender is.
public enum Ownership: String, Sendable, CaseIterable, Identifiable {
    case mine, myExchange, someoneElse

    public var id: Self { self }

    public var title: String {
        switch self {
        case .mine: "My wallet"
        case .myExchange: "My exchange account"
        case .someoneElse: "Someone else"
        }
    }

    public var answer: SenderAnswer {
        switch self {
        case .mine: .mine
        case .myExchange: SenderAnswer(kind: .myExchange)
        case .someoneElse: .someoneElse
        }
    }
}

@MainActor
@Observable
public final class ResolveModel {
    private let store: PortfolioStore
    /// This holding's questions come first, because that's what Resolve was clicked on.
    private let firstAsset: String?
    private let noteWriter: (any CostNoteWriter)?

    /// Skipped for now. A skipped question stays open and stays flagged, and comes back next time.
    public private(set) var skipped: Set<String> = []
    /// What each answer to the current question would do, once the server has said.
    public private(set) var previews: [Ownership: BookPreview] = [:]
    /// What the cost being typed would do, once the server has said. Nothing's saved until it's confirmed.
    public private(set) var costPreview: BookPreview?
    /// Asking what they paid, because they said it's their exchange account.
    public private(set) var isAskingCost = false
    public var failure: String?

    public init(store: PortfolioStore, firstAsset: String? = nil, noteWriter: (any CostNoteWriter)? = nil) {
        self.store = store
        self.firstAsset = firstAsset
        self.noteWriter = noteWriter
    }

    public var questions: [Question] {
        let open = (store.portfolio?.questions ?? []).filter { !skipped.contains($0.id) }
        guard let firstAsset else { return open }
        return open.filter { $0.arrivals.contains { $0.asset == firstAsset } } + open.filter { !$0.arrivals.contains { $0.asset == firstAsset } }
    }

    public var current: Question? { questions.first }
    public var meter: Meter? { store.portfolio?.meter }
    public var canUndo: Bool { !store.undoStack.isEmpty }
    /// Every question's answered. Anything skipped doesn't count.
    public var isBalanced: Bool { meter?.isBalanced == true }

    /// The books each answer leads to. "My exchange account" changes nothing until there's a cost, so it isn't one.
    private func candidate(_ ownership: Ownership, for question: Question) -> Book? {
        guard let sender = question.sender else { return nil }
        switch ownership {
        case .mine: return store.book.answering(sender, .mine, focus: store.portfolio?.address)
        case .someoneElse: return store.book.answering(sender, .someoneElse, focus: store.portfolio?.address)
        case .myExchange: return nil
        }
    }

    /// Reads what each answer would do. A wallet that isn't read yet says so, and this asks again until it is.
    public func loadPreviews() async {
        guard let question = current, question.kind == .sender else {
            previews = [:]
            return
        }
        let options = Ownership.allCases.filter { candidate($0, for: question) != nil }
        while !Task.isCancelled, question.id == current?.id {
            guard let answers = try? await store.previews(of: options.compactMap { candidate($0, for: question) }), answers.count == options.count else { return }
            guard !Task.isCancelled, question.id == current?.id else { return }
            previews = Dictionary(uniqueKeysWithValues: zip(options, answers))
            if !answers.contains(where: \.pending) { return }
            try? await Task.sleep(for: .seconds(2))
        }
    }

    public func answer(_ ownership: Ownership) {
        guard let question = current, let sender = question.sender else { return }
        switch ownership {
        case .myExchange:
            // What was entered for this sender before stays, because it covers what had arrived by then.
            let earlier = store.book.senders[sender.lowercased()]
            store.setBook(store.book.answering(sender, earlier?.kind == .myExchange ? earlier! : SenderAnswer(kind: .myExchange), focus: store.portfolio?.address))
            isAskingCost = true
        case .mine, .someoneElse:
            if let book = candidate(ownership, for: question) { store.setBook(book) }
            advance()
        }
    }

    /// The books a typed cost leads to. nil until every amount reads as one.
    private func candidate(costs dollars: [String: String], in currency: CurrencyCode? = nil, for question: Question) -> Book? {
        var micros: [String: Money] = [:]
        for arrival in question.arrivals {
            guard let amount = Format.micros(fromDollars: dollars[arrival.asset] ?? "") else { return nil }
            micros[arrival.asset] = Money(micros: amount, currency: currency ?? store.currency)
        }
        if let sender = question.sender {
            return store.book.enteringExchangeCosts(sender, receipts: question.receipts, amounts: micros, focus: store.portfolio?.address)
        }
        guard let key = question.costKey, let cost = micros.values.first else { return nil }
        return store.book.enteringCost(key, cost)
    }

    /// A typed cost next to what it was worth, to catch a slip. It's only ever a warning: what someone paid is theirs to say.
    public func costWarning(_ dollars: [String: String], for question: Question) -> String? {
        guard question.arrivals.count == 1, let asset = question.arrivals.first?.asset, let value = question.valueMicros, isPositive(value) else { return nil }
        guard let text = dollars[asset], let entered = Format.micros(fromDollars: text).flatMap({ Decimal(string: $0) }), let worth = Decimal(string: value) else { return nil }
        guard entered > worth * 5 || entered * 5 < worth else { return nil }
        return "That's far from what it was worth when it arrived, about \(Format.money(value, store.currency)). Double-check it."
    }

    /// Reads what this cost would do, so it shows before the answer's final.
    public func previewCost(_ dollars: [String: String]) async {
        guard let question = current, let book = candidate(costs: dollars, for: question) else {
            costPreview = nil
            return
        }
        guard let answer = try? await store.previews(of: [book]).first, !Task.isCancelled, question.id == current?.id else { return }
        costPreview = answer
    }

    /// `dollars` is what was paid for everything that arrived, by asset, as typed. False when something isn't an amount.
    @discardableResult
    public func enterCost(_ dollars: [String: String]) -> Bool {
        guard let question = current, let book = candidate(costs: dollars, for: question) else { return false }
        store.setBook(book)
        advance()
        return true
    }

    /// The note this question could publish, when the wallet it arrived in is one this app can sign for.
    public func noteDraft(for question: Question) -> CostNoteDraft? {
        guard let draft = question.noteDraft, noteWriter?.canWriteNote(from: draft.wallet) == true else { return nil }
        return draft
    }

    /// Publishes what was paid, and keeps it here too, so the question's answered before the note's been read back. `usd` is as typed,
    /// because a note is always in USD. True once it's on its way.
    public func publish(_ draft: CostNoteDraft, usd: String) async -> Bool {
        guard let question = current, question.noteDraft == draft, let noteWriter, let micros = Format.micros(fromDollars: usd), let calldata = CostNote.calldata(txHash: draft.txHash, asset: draft.asset, usdMicros: micros) else { return false }
        failure = nil
        guard noteWriter.canWriteNote(from: draft.wallet) else {
            failure = "That wallet can't publish this any more, so nothing was signed."
            return false
        }
        guard await noteWriter.writeNote(calldata, asset: draft.asset, from: draft.wallet) else {
            failure = noteWriter.noteProblem
            return false
        }
        // Worked out now, because answers can change during the wait, and this shouldn't undo them.
        if let book = candidate(costs: [draft.asset: usd], in: .USD, for: question) { store.setBook(book) }
        advance()
        return true
    }

    /// They own the account but don't have what they paid, so the price when it arrived will do, as an estimate.
    public func usePriceWhenItArrived() {
        guard let sender = current?.sender else { return }
        store.setBook(store.book.answering(sender, .someoneElse, focus: store.portfolio?.address))
        advance()
    }

    public func importCoinbase(csv: String) async -> ExchangeImport? {
        do {
            let imported = try await store.importCoinbase(csv: csv)
            failure = imported.skipped > 0 ? "Found \(imported.withdrawals.count) withdrawals. \(imported.skipped) had no usable cost." : nil
            advance()
            return imported
        } catch FetchError.rejected(let message) {
            failure = message
        } catch {
            failure = "Couldn't read that file. Is the server running?"
        }
        return nil
    }

    public func skip() {
        guard let question = current else { return }
        skipped.insert(question.id)
        advance()
    }

    public func undo() {
        store.undo()
        advance()
    }

    /// Back to what was skipped.
    public func revisitSkipped() {
        skipped = []
        advance()
    }

    private func advance() {
        isAskingCost = false
        previews = [:]
        costPreview = nil
    }
}
