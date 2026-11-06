// The user's answers as a list they can read back and change: what each one is about, what it says, and when it was given.
// When, and what it was about, stay on this Mac beside the answers, and never go to the server.

import Foundation

/// One thing the user said, as it is now.
public struct AnswerEntry: Identifiable, Sendable, Equatable {
    public enum Said: Sendable, Equatable {
        /// Who a sender is. What was paid for what an exchange account sent is an answer of its own, one for each time it was asked.
        case sender(address: String, SenderAnswer.Kind)
        /// What was paid for what an exchange account sent, for exactly these receipts. `index` is where it is in that account's costs.
        case exchangeCost(sender: String, index: Int, ExchangeCost)
        /// What was paid for one movement, by its cost key.
        case cost(key: String, Money)
        /// An exchange's history, imported.
        case imported([ExchangeWithdrawal])
    }

    public let said: Said
    public let id: String

    init(said: Said, id: String? = nil) {
        self.said = said
        self.id = id ?? Self.id(of: said)
    }

    public static func senderID(_ address: String) -> String { "sender:\(address.lowercased())" }
    public static func costID(_ key: String) -> String { "cost:\(key)" }
    public static let importedID = "imported"
    /// By what it covers, which no other answer about that account does, so it stays the same answer however the others change.
    public static func exchangeCostID(sender: String, asset: String, receipts: [CostReceipt]) -> String {
        "exchange:\(sender.lowercased()):\(asset):" + receipts.map { "\($0.wallet.lowercased())/\($0.legId)" }.sorted().joined(separator: ",")
    }

    private static func id(of said: Said) -> String {
        switch said {
        case .sender(let address, _): senderID(address)
        case .exchangeCost(let sender, _, let cost): exchangeCostID(sender: sender, asset: cost.asset, receipts: cost.receipts)
        case .cost(let key, _): costID(key)
        case .imported: importedID
        }
    }

    /// Whether it's about this sender: who it is, or what was paid for what it sent.
    func isAbout(_ address: String) -> Bool {
        switch said {
        case .sender(let sender, _), .exchangeCost(let sender, _, _): sender == address.lowercased()
        case .cost, .imported: false
        }
    }

    /// The same answer, saying the same thing. Where it sits among an exchange account's costs doesn't count.
    func says(_ other: AnswerEntry) -> Bool {
        switch (said, other.said) {
        case (.exchangeCost(let a, _, let x), .exchangeCost(let b, _, let y)): a == b && x == y
        default: said == other.said
        }
    }
}

/// A cost key, `<wallet>:<movement>`, read back into what it's about. See `costKey` in `src/core/book.ts` and the leg ids in `legs.ts`.
public struct CostSubject: Sendable, Equatable {
    public let wallet: String
    /// The transaction it moved in. nil for ETH that arrived with no transaction showing it.
    public let transaction: String?
    public let asset: String
    /// The block that ETH arrived in, when no transaction shows it.
    public let block: Int?

    public init?(key: String) {
        guard let colon = key.firstIndex(of: ":") else { return nil }
        self.init(wallet: String(key[..<colon]), legId: String(key[key.index(after: colon)...]))
    }

    /// One movement in one wallet, as a receipt names it.
    public init?(wallet: String, legId: String) {
        let parts = legId.split(separator: ":").map(String.init)
        guard parts.count >= 2, WalletAddress.isValid(wallet) else { return nil }
        self.wallet = wallet.lowercased()
        asset = parts[parts.count - 1]
        if parts[0] == "unseen", parts.count >= 3 {
            transaction = nil
            block = Int(parts[1])
        } else {
            transaction = parts[0]
            block = nil
        }
    }

    /// Where it moved, like "in transaction 0x7d1c…9f1e" or "in block 53,500,120".
    public var place: String {
        transaction.map { "in transaction \(Format.shortHash($0))" } ?? block.map { "in block \(Format.block($0))" } ?? ""
    }
}

/// When each answer was given, and what it was about. Kept beside the answers, and only on this Mac.
public struct AnswerDetails: Codable, Sendable, Equatable {
    /// By `AnswerEntry.id`, when what it says now was said.
    public var dates: [String: Date] = [:]
    /// By `AnswerEntry.id`, like "0.002 ETH from Coinbase", as the question said it.
    public var about: [String: String] = [:]

    public init() {}

    /// Only what these answers still say. Undo keeps its own copy from before each change.
    func keeping(_ book: Book) -> AnswerDetails {
        let ids = Set(book.answerEntries.map(\.id))
        var next = self
        next.dates = dates.filter { ids.contains($0.key) }
        next.about = about.filter { ids.contains($0.key) }
        return next
    }

    /// What these say about one answer, and nothing else, put back.
    mutating func restore(_ id: String, from earlier: AnswerDetails) {
        dates[id] = earlier.dates[id]
        about[id] = earlier.about[id]
    }
}

public extension Book {
    /// Everything said here: one entry for each wallet, each time what an exchange account sent was paid for, each movement and the import.
    /// Purchases aren't answers: the provider said those.
    var answerEntries: [AnswerEntry] {
        var entries: [AnswerEntry] = []
        var seen: Set<String> = []
        func add(_ said: AnswerEntry.Said) {
            var entry = AnswerEntry(said: said)
            // Two costs for the very same receipts can't come from asking, but each still needs its own place.
            if seen.contains(entry.id) { entry = AnswerEntry(said: said, id: "\(entry.id)#\(seen.count)") }
            seen.insert(entry.id)
            entries.append(entry)
        }
        for (address, answer) in senders.sorted(by: { $0.key < $1.key }) {
            add(.sender(address: address, answer.kind))
            if answer.kind == .myExchange {
                for (index, cost) in (answer.costs ?? []).enumerated() { add(.exchangeCost(sender: address, index: index, cost)) }
            }
        }
        for (key, money) in costs.sorted(by: { $0.key < $1.key }) { add(.cost(key: key, money)) }
        if !withdrawals.isEmpty { add(.imported(withdrawals)) }
        return entries
    }

    /// Takes one answer back, so its question comes back too. Taking back one cost leaves the account an exchange account, with its other costs.
    func removing(_ entry: AnswerEntry) -> Book {
        var next = self
        switch entry.said {
        case .sender(let address, _):
            next.senders[address] = nil
        case .exchangeCost(let sender, let index, let cost):
            guard var costs = senders[sender]?.costs, costs.indices.contains(index), costs[index] == cost else { return self }
            costs.remove(at: index)
            next.senders[sender] = SenderAnswer(kind: .myExchange, costs: costs.isEmpty ? nil : costs)
        case .cost(let key, _):
            next.costs[key] = nil
        case .imported:
            next.withdrawals = []
        }
        return next
    }

    /// A different answer about who a sender is. It's only about that sender: the wallet that was showing when it was first given keeps its own answer.
    /// What was paid stays with an exchange account, and goes when it's said to be something else.
    func changing(_ sender: String, to kind: SenderAnswer.Kind) -> Book {
        let key = sender.lowercased()
        guard senders[key]?.kind != kind else { return self }
        var next = self
        next.senders[key] = SenderAnswer(kind: kind)
        return next
    }

    /// A different amount for what was paid, in the currency it was given in. It still covers what it covered.
    func changingCost(of entry: AnswerEntry, to micros: String) -> Book {
        var next = self
        switch entry.said {
        case .cost(let key, let money):
            next.costs[key] = Money(micros: micros, currency: money.currency)
        case .exchangeCost(let sender, let index, let cost):
            guard var costs = senders[sender]?.costs, costs.indices.contains(index), costs[index] == cost else { return self }
            costs[index] = ExchangeCost(micros: micros, currency: cost.currency, asset: cost.asset, receipts: cost.receipts)
            next.senders[sender] = SenderAnswer(kind: .myExchange, costs: costs)
        case .sender, .imported:
            return self
        }
        return next
    }
}

public extension Format {
    /// An amount that was entered, as it could be typed again: no symbol or grouping, and cents always.
    static func typed(_ micros: String) -> String {
        let padded = String(repeating: "0", count: max(0, 7 - micros.count)) + micros
        let whole = padded.dropLast(6)
        var fraction = String(padded.suffix(6))
        while fraction.count > 2, fraction.hasSuffix("0") { fraction.removeLast() }
        return "\(whole).\(fraction)"
    }
}
