// The user's answers as a list they can read back and change: what each one is about, what it says, and when it was given.
// When, and what it was about, stay on this Mac beside the answers, and never go to the server.

import CryptoKit
import Foundation

/// One thing the user said, as it is now.
public struct AnswerEntry: Identifiable, Sendable, Equatable {
    public enum Said: Sendable, Equatable {
        /// Who a sender is. An exchange account carries what was paid for what it sent.
        case sender(address: String, SenderAnswer)
        /// What was paid for one movement, by its cost key.
        case cost(key: String, Money)
        /// An exchange's history, imported.
        case imported([ExchangeWithdrawal])
    }

    public let said: Said

    public static func senderID(_ address: String) -> String { "sender:\(address.lowercased())" }
    public static func costID(_ key: String) -> String { "cost:\(key)" }
    public static let importedID = "imported"

    public var id: String {
        switch said {
        case .sender(let address, _): Self.senderID(address)
        case .cost(let key, _): Self.costID(key)
        case .imported: Self.importedID
        }
    }

    /// Changes whenever what it says does, so a date belongs to one version of an answer, and Undo brings back that version's date.
    public var stamp: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let data: Data? = switch said {
        case .sender(_, let answer): try? encoder.encode(answer)
        case .cost(_, let money): try? encoder.encode(money)
        case .imported(let withdrawals): try? encoder.encode(withdrawals)
        }
        let digest = SHA256.hash(data: data ?? Data()).prefix(8).map { String(format: "%02x", $0) }.joined()
        return "\(id)#\(digest)"
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
        let parts = key.split(separator: ":").map(String.init)
        guard parts.count >= 3, WalletAddress.isValid(parts[0]) else { return nil }
        wallet = parts[0]
        asset = parts[parts.count - 1]
        if parts[1] == "unseen" {
            transaction = nil
            block = Int(parts[2])
        } else {
            transaction = parts[1]
            block = nil
        }
    }
}

/// When each version of an answer was given, and what it was about. Kept beside the answers, and only on this Mac.
public struct AnswerDetails: Codable, Sendable, Equatable {
    /// By `AnswerEntry.stamp`.
    public var dates: [String: Date] = [:]
    /// By `AnswerEntry.id`, like "0.002 ETH from Coinbase", as the question said it.
    public var about: [String: String] = [:]

    public init() {}

    /// Only what the answers, or what Undo can bring back, still say.
    func keeping(_ books: [Book]) -> AnswerDetails {
        let entries = books.flatMap(\.answerEntries)
        let stamps = Set(entries.map(\.stamp))
        let ids = Set(entries.map(\.id))
        var next = self
        next.dates = dates.filter { stamps.contains($0.key) }
        next.about = about.filter { ids.contains($0.key) }
        return next
    }
}

public extension Book {
    /// Everything said here, one entry for each wallet, movement and import. Purchases aren't answers: the provider said those.
    var answerEntries: [AnswerEntry] {
        senders.sorted { $0.key < $1.key }.map { AnswerEntry(said: .sender(address: $0.key, $0.value)) }
            + costs.sorted { $0.key < $1.key }.map { AnswerEntry(said: .cost(key: $0.key, $0.value)) }
            + (withdrawals.isEmpty ? [] : [AnswerEntry(said: .imported(withdrawals))])
    }

    /// Takes one answer back, so its question comes back too.
    func removing(_ entry: AnswerEntry) -> Book {
        var next = self
        switch entry.said {
        case .sender(let address, _): next.senders[address] = nil
        case .cost(let key, _): next.costs[key] = nil
        case .imported: next.withdrawals = []
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

    /// A different amount for what was paid. `index` is which of an exchange account's costs, in the order they were given.
    func changingCost(of entry: AnswerEntry, index: Int = 0, to micros: String) -> Book {
        var next = self
        switch entry.said {
        case .cost(let key, let money):
            next.costs[key] = Money(micros: micros, currency: money.currency)
        case .sender(let address, let answer):
            guard answer.kind == .myExchange, var costs = answer.costs, costs.indices.contains(index) else { return self }
            let cost = costs[index]
            costs[index] = ExchangeCost(micros: micros, currency: cost.currency, asset: cost.asset, receipts: cost.receipts)
            next.senders[address] = SenderAnswer(kind: .myExchange, costs: costs)
        case .imported:
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
