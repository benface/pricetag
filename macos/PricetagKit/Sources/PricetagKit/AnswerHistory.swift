// What the user has said, and the history that can take any of it back. Two kinds of change share that history: an answer, which Undo
// swaps back whole, and a change to one wallet, which the wallet list can also take back by itself, later and out of order.

import Foundation
import Observation

/// What the list and the answers said about one wallet, before a change to it.
public struct WalletListSnapshot: Sendable {
    let address: String
    let answer: SenderAnswer?
    let undoDepth: Int
    /// The answer the change gave, and the undo entry it made, if it made one.
    var changedAnswer: SenderAnswer?
    var undoEntry: UUID?
    let saved: SavedWallet?
    let orderIndex: Int?
    let wasHidden: Bool
    let wasShowing: Bool
}

/// One step Undo can take back: the answers before it, what the Edit menu calls it, and for a change to one wallet, the rest of what it changed.
private struct HistoryEntry {
    /// Kept through Undo and Redo, so the wallet list's own Undo can still find the change it made.
    let id: UUID
    let name: String
    /// Before the step while it's in the undo history, and after it while it's in the redo history.
    var book: Book
    /// When the answers in `book` were given, and what they were about, so Undo and Redo put back each answer's own date.
    var details: AnswerDetails
    var wallet: WalletStep?
}

/// A change to one wallet as the wallet list makes it. Undo puts all of it back, and Redo makes it again.
private struct WalletStep {
    var snapshot: WalletListSnapshot
    let change: () -> Void
    let alsoUndo: (() -> Void)?
}

@MainActor
@Observable
final class AnswerHistory {
    /// What the user has said about where things came from. It stays on this device.
    private(set) var answers: Book
    /// When each answer was given and what it was about, for the list of answers. Never sent anywhere.
    private(set) var details: AnswerDetails
    /// What each answer replaced, newest last, so Undo is always there. Accounts aren't in here, so it can't bring back one that's gone.
    private var history: [HistoryEntry] = []
    /// What Undo took back, newest last, until something else changes.
    private var future: [HistoryEntry] = []
    /// Called whenever `answers` is replaced, after it's saved.
    @ObservationIgnored var onChange: () -> Void = {}
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let now: @Sendable () -> Date

    var undoStack: [Book] { history.map(\.book) }
    /// What each entry of `undoStack` takes back, in a menu's words, as in "Undo Answer".
    var undoNames: [String] { history.map(\.name) }
    var redoStack: [Book] { future.map(\.book) }
    var redoNames: [String] { future.map(\.name) }

    init(defaults: UserDefaults, now: @escaping @Sendable () -> Date) {
        self.defaults = defaults
        self.now = now
        let readAnswers = SetAside.decoded(Book.self, key: StoreKeys.book, in: defaults)
        let answers = readAnswers ?? Book()
        self.answers = answers
        // The next save only keeps details of answers it can see, so with none of them these need keeping too.
        if readAnswers == nil { SetAside.keep(key: StoreKeys.answerDetails, in: defaults) }
        details = (SetAside.decoded(AnswerDetails.self, key: StoreKeys.answerDetails, in: defaults) ?? AnswerDetails()).keeping(answers)
    }

    /// Takes effect right away. Undo goes back to what this replaced, and the Edit menu calls it `action`. Each answer this says something new for is dated now.
    /// `about` is what a question was about, in its own words, by answer. `linked` is the accounts in `next` that aren't answers.
    func set(_ next: Book, linked: [String], about: [String: String], action: String) {
        let nextAnswers = answers(in: next, linked: linked)
        guard nextAnswers != answers else { return }
        let given = answers.answerEntries
        var nextDetails = details
        for entry in nextAnswers.answerEntries where !given.contains(where: { $0.id == entry.id && $0.says(entry) }) { nextDetails.dates[entry.id] = now() }
        nextDetails.about.merge(about) { _, new in new }
        history.append(HistoryEntry(id: UUID(), name: action, book: answers, details: details))
        future = []
        store(nextAnswers, details: nextDetails)
    }

    /// What a provider says, and not an answer, so there's nothing to undo, and undoing an answer doesn't lose it.
    func record(_ purchase: Purchase) {
        let next = answers.recording(purchase)
        guard next != answers else { return }
        for index in history.indices { history[index].book = history[index].book.recording(purchase) }
        for index in future.indices { future[index].book = future[index].book.recording(purchase) }
        store(next)
    }

    /// Makes a change to one wallet as one step in the history, called `name`, and returns `snapshot` with what the change did.
    func recording(_ snapshot: WalletListSnapshot, name: String, alsoUndo: (() -> Void)?, change: @escaping () -> Void) -> WalletListSnapshot {
        var snapshot = snapshot
        let entriesBefore = Set(history.map(\.id))
        let bookBefore = answers
        let detailsBefore = details
        change()
        snapshot.changedAnswer = answers.senders[snapshot.address]
        // An answer the change gave is part of it, so it's this entry and not one of its own.
        history.removeAll { !entriesBefore.contains($0.id) }
        let id = UUID()
        snapshot.undoEntry = id
        history.append(HistoryEntry(id: id, name: name, book: bookBefore, details: detailsBefore, wallet: WalletStep(snapshot: snapshot, change: change, alsoUndo: alsoUndo)))
        future = []
        return snapshot
    }

    /// What Undo took back may have the change in it or not, so Redo can't know what it would bring back.
    func clearRedo() {
        future = []
    }

    /// Whether the change is the last thing done, with nothing undone since. Only then can the wallet list still talk about it, and take it back without costing Redo anything.
    func isLatest(_ snapshot: WalletListSnapshot) -> Bool {
        guard let entry = snapshot.undoEntry else { return false }
        return history.last?.id == entry && future.isEmpty
    }

    /// The answer's side of taking back one change to one wallet. Whatever else has changed since stays changed, and so does anything said about this wallet since.
    func putBack(_ snapshot: WalletListSnapshot) {
        let address = snapshot.address
        let isUnchanged = { (book: Book) in book.senders[address] == snapshot.changedAnswer }
        let before = snapshot.undoEntry.flatMap { entry in history.first { $0.id == entry }?.details }
        if isUnchanged(answers), answers.senders[address] != snapshot.answer {
            var next = answers
            next.senders[address] = snapshot.answer
            // The wallet's answer goes back to what it was, date included, and every other answer keeps its own.
            var nextDetails = details
            if let before {
                for id in Set(([answers, next]).flatMap(\.answerEntries).filter { $0.isAbout(address) }.map(\.id)) { nextDetails.restore(id, from: before) }
            }
            store(next, details: nextDetails)
        }
        // The change's own entry goes with it, wherever it is now.
        var since = snapshot.undoDepth
        if let entry = snapshot.undoEntry, let index = history.firstIndex(where: { $0.id == entry }) {
            history.remove(at: index)
            since = index
        }
        // What was saved for Undo since then has the change in it. Undoing something else mustn't bring it back, or its date.
        for index in history.indices where index >= since && isUnchanged(history[index].book) {
            let ids = history[index].book.answerEntries.filter { $0.isAbout(address) }.map(\.id)
            history[index].book.senders[address] = snapshot.answer
            if let before {
                for id in ids + history[index].book.answerEntries.filter({ $0.isAbout(address) }).map(\.id) { history[index].details.restore(id, from: before) }
            }
        }
    }

    /// `putBack` takes back all of a change to one wallet, as the wallet list's own Undo does.
    func undo(putBack: (WalletListSnapshot) -> Void) {
        guard var entry = history.last else { return }
        let detailsBefore = entry.details
        entry.details = details
        if let wallet = entry.wallet {
            // All of it, as the wallet list's own Undo does: its name, its place in the list, and whether it was showing.
            wallet.alsoUndo?()
            putBack(wallet.snapshot)
        } else {
            history.removeLast()
            let previous = entry.book
            entry.book = answers
            store(previous, details: detailsBefore)
        }
        future.append(entry)
    }

    /// `makeAgain` makes a change to one wallet again, the way it was first made.
    func redo(makeAgain: (_ address: String, _ name: String, _ alsoUndo: (() -> Void)?, _ change: @escaping () -> Void) -> Void) {
        guard let entry = future.popLast() else { return }
        if let wallet = entry.wallet {
            // Making it again clears what's left to redo, which is still there to redo after it.
            let rest = future
            makeAgain(wallet.snapshot.address, entry.name, wallet.alsoUndo, wallet.change)
            future = rest
            // The same change as before, so the wallet list's Undo, which knows it by its first snapshot, still finds it.
            if let last = history.popLast() {
                var step = last.wallet
                step?.snapshot.undoEntry = entry.id
                history.append(HistoryEntry(id: entry.id, name: last.name, book: last.book, details: last.details, wallet: step))
            }
            // The same answer as before too, so it keeps the date it had, not today's.
            var nextDetails = details
            for answer in answers.answerEntries where answer.isAbout(wallet.snapshot.address) { nextDetails.restore(answer.id, from: entry.details) }
            if nextDetails != details {
                details = nextDetails
                saveDetails()
            }
        } else {
            history.append(HistoryEntry(id: entry.id, name: entry.name, book: answers, details: details))
            store(entry.book, details: entry.details)
        }
    }

    /// `details` goes with `next`, or what's there now stays for whatever `next` still says.
    private func store(_ next: Book, details nextDetails: AnswerDetails? = nil) {
        answers = next
        defaults.set(try? JSONEncoder().encode(next), forKey: StoreKeys.book)
        details = (nextDetails ?? details).keeping(next)
        saveDetails()
        onChange()
    }

    private func saveDetails() {
        defaults.set(try? JSONEncoder().encode(details), forKey: StoreKeys.answerDetails)
    }

    /// A book built on the one with accounts in it has them in it, and they aren't answers. What was said about one before it was an account stays.
    /// Purchases aren't answers either, and an order that's finished isn't read again, so only `record` changes them.
    private func answers(in next: Book, linked: [String]) -> Book {
        var kept = next.unlinking(linked)
        kept.purchases = answers.purchases
        for account in linked where next.senders[account]?.kind == .mine { kept.senders[account] = answers.senders[account] }
        return kept
    }
}
