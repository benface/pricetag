// What the question cards need: which one's up, what each answer would do, and answering it. The server does the math.

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
    /// What the last import found. It's apart from `failure`, which goes with a card, because an import can answer the card it was made from.
    public private(set) var lastImport: ExchangeImport?
    /// A file waiting for someone to say it's their whole history.
    public private(set) var pendingImport: ExchangeImport?
    public private(set) var importRefusal: String?
    /// From the moment it's asked for until it's on its way or isn't going. It can't be called back in that time.
    public private(set) var isPublishing = false
    /// Whether what each answer would do is waiting for the server to have room. It shows up by itself then.
    public var previewsAreHeldBack: Bool { previewsWaiting > 0 }
    /// The same for what the cost being typed would do.
    public var costPreviewIsHeldBack: Bool { costPreviewsWaiting > 0 }
    private var previewsWaiting = 0
    private var costPreviewsWaiting = 0
    /// When the server said it'd have room again. Nothing here asks before then, whatever gets typed or answered in the meantime.
    private var heldUntil: ContinuousClock.Instant?

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
    /// What's already said to be a wallet can't also be an exchange account, and what's asked is about the wallet it reached.
    public var options: [Ownership] {
        guard let sender = current?.sender, store.book.senders[sender.lowercased()]?.kind == .mine else { return Ownership.allCases }
        return Ownership.allCases.filter { $0 != .myExchange }
    }
    public var meter: Meter? { store.portfolio?.meter }
    public var canUndo: Bool { !store.undoStack.isEmpty }
    /// Every question's answered. Anything skipped doesn't count.
    public var isBalanced: Bool { meter?.isBalanced == true && store.portfolio?.withheld.isEmpty == true }

    /// The wallet an answer is about: the one showing, or with all the user's wallets showing, the one it arrived in.
    private func focus(of question: Question?) -> String? {
        guard let portfolio = store.portfolio else { return nil }
        return portfolio.isAllYours ? question?.wallet : portfolio.address
    }

    /// The books each answer leads to. "My exchange account" changes nothing until there's a cost, so it isn't one.
    private func candidate(_ ownership: Ownership, for question: Question) -> Book? {
        guard let sender = question.sender else { return nil }
        switch ownership {
        case .mine: return store.book.answering(sender, .mine, focus: focus(of: question))
        case .someoneElse: return store.book.answering(sender, .someoneElse, focus: focus(of: question))
        case .myExchange: return nil
        }
    }

    /// What these books would do, once the server has room. `waiting` counts this for as long as it's held back, and what `whileHeld`
    /// clears would be about something else by then. nil when the question's moved on or the server can't say.
    private func previews(of books: [Book], for question: Question, waiting: ReferenceWritableKeyPath<ResolveModel, Int>, whileHeld: () -> Void) async -> [BookPreview]? {
        var isCounted = false
        defer { if isCounted { self[keyPath: waiting] -= 1 } }
        while !Task.isCancelled, question.id == current?.id {
            if let heldUntil, heldUntil > .now {
                if !isCounted {
                    isCounted = true
                    self[keyPath: waiting] += 1
                    whileHeld()
                }
                try? await Task.sleep(until: heldUntil, clock: .continuous)
                continue
            }
            do {
                return try await store.previews(of: books)
            } catch FetchError.rateLimited(_, let retryAfter) {
                heldUntil = .now + .seconds(retryAfter)
            } catch {
                return nil
            }
        }
        return nil
    }

    /// Reads what each answer would do. A wallet that isn't read yet says so, and this asks again until it is.
    public func loadPreviews() async {
        guard let question = current, question.kind == .sender else {
            previews = [:]
            return
        }
        let options = self.options.filter { candidate($0, for: question) != nil }
        while !Task.isCancelled, question.id == current?.id {
            guard let answers = await previews(of: options.compactMap { candidate($0, for: question) }, for: question, waiting: \.previewsWaiting, whileHeld: { previews = [:] }), answers.count == options.count else { return }
            guard !Task.isCancelled, question.id == current?.id else { return }
            previews = Dictionary(uniqueKeysWithValues: zip(options, answers))
            if !answers.contains(where: \.pending) { return }
            try? await Task.sleep(for: .seconds(2))
        }
    }

    public func answer(_ ownership: Ownership) {
        guard let question = current, let sender = question.sender, options.contains(ownership) else { return }
        switch ownership {
        case .myExchange:
            // What was entered for this sender before stays, because it covers what had arrived by then.
            let earlier = store.book.senders[sender.lowercased()]
            store.setBook(store.book.answering(sender, earlier?.kind == .myExchange ? earlier! : SenderAnswer(kind: .myExchange), focus: focus(of: question)), about: about(question))
            isAskingCost = true
        case .mine, .someoneElse:
            if let book = candidate(ownership, for: question) { store.setBook(book, about: about(question)) }
            advance()
        }
    }

    /// The books a typed cost leads to. nil until every amount reads as one.
    private func candidate(costs dollars: [String: String], in currency: CurrencyCode? = nil, for question: Question) -> Book? {
        var micros: [String: Money] = [:]
        for arrival in question.arrivals {
            guard let amount = Format.micros(fromDollars: dollars[arrival.asset] ?? "", in: currency ?? store.currency) else { return nil }
            micros[arrival.asset] = Money(micros: amount, currency: currency ?? store.currency)
        }
        if let sender = question.sender {
            return store.book.enteringExchangeCosts(sender, receipts: question.receipts, amounts: micros, focus: focus(of: question))
        }
        guard let key = question.costKey, let cost = micros.values.first else { return nil }
        return store.book.enteringCost(key, cost)
    }

    /// A typed cost next to what it was worth, to catch a slip. It's only ever a warning: what someone paid is theirs to say.
    public func costWarning(_ dollars: [String: String], for question: Question) -> String? {
        guard question.arrivals.count == 1, let asset = question.arrivals.first?.asset, let value = question.valueMicros, isPositive(value) else { return nil }
        guard let text = dollars[asset], let entered = Format.micros(fromDollars: text, in: store.currency).flatMap({ Decimal(string: $0) }), let worth = Decimal(string: value) else { return nil }
        guard entered > worth * 5 || entered * 5 < worth else { return nil }
        return "That's far from what it was worth when it arrived, about \(Format.money(value, store.currency)). Double-check it."
    }

    /// Reads what this cost would do, so it shows before the answer's final.
    public func previewCost(_ dollars: [String: String]) async {
        guard let question = current, let book = candidate(costs: dollars, for: question) else {
            costPreview = nil
            return
        }
        guard let answer = await previews(of: [book], for: question, waiting: \.costPreviewsWaiting, whileHeld: { costPreview = nil })?.first, !Task.isCancelled, question.id == current?.id else { return }
        costPreview = answer
    }

    /// `dollars` is what was paid for everything that arrived, by asset, as typed. False when something isn't an amount.
    @discardableResult
    public func enterCost(_ dollars: [String: String]) -> Bool {
        guard let question = current, let book = candidate(costs: dollars, for: question) else { return false }
        store.setBook(book, about: about(question))
        advance()
        return true
    }

    /// The note this question could publish, when the wallet it arrived in is one this app can sign for.
    public func noteDraft(for question: Question) -> CostNoteDraft? {
        guard let draft = question.noteDraft, noteWriter?.canWriteNote(from: draft.wallet) == true else { return nil }
        return draft
    }

    /// The note this question could publish from a device, through the web app, when the wallet it arrived in is savings.
    public func deviceNoteDraft(for question: Question) -> CostNoteDraft? {
        guard let draft = question.noteDraft, noteWriter?.canWriteNoteOnDevice(from: draft.wallet) == true else { return nil }
        return draft
    }

    /// Publishes what was paid, and keeps it here too, so the question's answered before the note's been read back. `usd` is as typed,
    /// because a note is always in USD. True once it's on its way.
    public func publish(_ draft: CostNoteDraft, usd: String) async -> Bool {
        guard !isPublishing, let question = current, question.noteDraft == draft, let noteWriter, let micros = Format.micros(fromDollars: usd), let calldata = CostNote.calldata(txHash: draft.txHash, asset: draft.asset, usdMicros: micros) else { return false }
        failure = nil
        guard noteWriter.canWriteNote(from: draft.wallet) else {
            failure = "That wallet can't publish this any more, so nothing was signed."
            return false
        }
        isPublishing = true
        defer { isPublishing = false }
        guard await noteWriter.writeNote(calldata, asset: draft.asset, from: draft.wallet) else {
            failure = noteWriter.noteProblem
            return false
        }
        // Worked out now, because answers can change during the wait, and this shouldn't undo them.
        if let book = candidate(costs: [draft.asset: usd], in: .USD, for: question) { store.setBook(book, about: about(question)) }
        advance()
        return true
    }

    /// They own the account but don't have what they paid, so the price when it arrived will do, as an estimate.
    public func usePriceWhenItArrived() {
        guard let question = current, let sender = question.sender else { return }
        store.setBook(store.book.answering(sender, .someoneElse, focus: focus(of: question)), about: about(question))
        advance()
    }

    public func importCoinbase(csv: String) async -> ExchangeImport? {
        lastImport = nil
        pendingImport = nil
        importRefusal = nil
        do {
            let imported = try await store.readCoinbase(csv: csv)
            failure = nil
            if imported.withdrawals.isEmpty {
                lastImport = imported
            } else if store.book.importStartsLate(imported) {
                importRefusal = Wording.importStartsLate
            } else {
                pendingImport = imported
            }
            return imported
        } catch FetchError.rejected(let message), FetchError.rateLimited(let message, _) {
            failure = message
        } catch {
            failure = "Couldn't read that file. The price service may not be answering."
        }
        return nil
    }

    public func keepImport() {
        guard let imported = pendingImport else { return }
        pendingImport = nil
        // What proves the file partial can have been saved while it waited for an answer.
        guard !store.book.importStartsLate(imported) else {
            importRefusal = Wording.importStartsLate
            return
        }
        store.keepImport(imported)
        lastImport = imported
        advance()
    }

    public func declineImport() {
        pendingImport = nil
        importRefusal = Wording.importNotWhole
    }

    public func skip() {
        guard let question = current else { return }
        skipped.insert(question.id)
        advance()
    }

    public func undo() {
        lastImport = nil
        importRefusal = nil
        store.undo()
        advance()
    }

    /// Back to what was skipped.
    public func revisitSkipped() {
        skipped = []
        advance()
    }

    /// What the question was about, by the answers it can lead to, so the list of answers can say it once the question's gone. A sender asked
    /// about again later is still the one that was answered first, and each cost for what it sent says what that cost covered.
    private func about(_ question: Question) -> [String: String] {
        func amount(_ arrival: Arrival) -> String { "\(Format.amount(arrival.units, decimals: arrival.decimals)) \(arrival.asset)" }
        let arrived = question.arrivals.map(amount).formatted(.list(type: .and))
        guard let sender = question.sender else { return question.costKey.map { [AnswerEntry.costID($0): arrived] } ?? [:] }
        var about: [String: String] = [:]
        if store.about(id: AnswerEntry.senderID(sender)) == nil {
            about[AnswerEntry.senderID(sender)] = question.known.map { "\(arrived) from \($0.name)" } ?? arrived
        }
        for arrival in question.arrivals {
            about[AnswerEntry.exchangeCostID(sender: sender, asset: arrival.asset, receipts: question.receipts.filter { $0.asset == arrival.asset })] = amount(arrival)
        }
        return about
    }

    private func advance() {
        isAskingCost = false
        previews = [:]
        costPreview = nil
    }
}
