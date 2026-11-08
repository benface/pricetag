// What the server asks the user, and what they answer, which stays on this device.

import Foundation

/// A public name for an address. It's only evidence: exchanges send everyone's withdrawals from shared addresses.
public struct KnownSender: Codable, Sendable, Equatable {
    public let name: String
    public let kind: String
}

public struct Arrival: Codable, Sendable, Equatable, Identifiable {
    public let asset: String
    public let decimals: Int
    public let units: String

    public var id: String { asset }
}

/// One thing the app can't work out by itself, asked once per address however many transfers it covers.
public struct Question: Codable, Sendable, Equatable, Identifiable {
    public enum Kind: String, Codable, Sendable {
        /// Who is this?
        case sender
        /// There's nobody to ask about, so what did it cost?
        case cost
    }

    public let id: String
    public let kind: Kind
    public let wallet: String
    public let sender: String?
    public let known: KnownSender?
    public let costKey: String?
    /// The transaction a note could answer this about, when it's about all of one token in that transaction, which is what a note says.
    public let noteAbout: String?
    /// They said it's their exchange account, and it still needs a cost.
    public let needsCost: Bool
    public let arrivals: [Arrival]
    /// What an answer about cost would cover. It's kept with the answer, so what arrives later is asked about in turn.
    public let receipts: [CostReceipt]
    public let transfers: Int
    public let firstAt: String
    public let lastAt: String
    /// Facts that might help. Never a preselected answer.
    public let evidence: [String]
    public let valueMicros: String?
}

/// A wallet's asset whose cost couldn't carry over to where it was sent.
public struct WithheldCost: Codable, Sendable, Equatable, Hashable {
    public let wallet: String
    public let asset: String
}

public struct Meter: Codable, Sendable, Equatable {
    public let open: Int
    public let answered: Int
    /// Linked wallets not read yet. What came from them is still unresolved, though nothing's left to ask about it.
    public let waiting: Int

    /// How far through the questions this is, from 0 to 1.
    public var progress: Double {
        let total = open + answered
        return total == 0 ? 1 : Double(answered) / Double(total)
    }

    public var isBalanced: Bool { open == 0 && answered > 0 && waiting == 0 }
}

/// What the headline would say with a different set of answers, before any of them is final.
public struct BookPreview: Codable, Sendable, Equatable {
    public let pnlMicros: String?
    public let pnlStatus: PnlStatus
    public let estimatedMicros: String
    public let unresolvedMicros: String
    public let open: Int
    /// A wallet these answers link hasn't been read yet, so this can't say yet.
    public let pending: Bool
    /// A wallet these answers link couldn't be read.
    public let failed: Bool

    public init(pnlMicros: String?, pnlStatus: PnlStatus, estimatedMicros: String, unresolvedMicros: String, open: Int, pending: Bool, failed: Bool) {
        self.pnlMicros = pnlMicros
        self.pnlStatus = pnlStatus
        self.estimatedMicros = estimatedMicros
        self.unresolvedMicros = unresolvedMicros
        self.open = open
        self.pending = pending
        self.failed = failed
    }
}

/// Part of a withdrawal, oldest first: how much of it, and what that cost.
public struct ExchangeLot: Codable, Sendable, Equatable, Hashable {
    public let units: String
    public let micros: String
    /// A file can't say which came first within it, so only all of it has a cost.
    public var wholeCostOnly: Bool? = nil
    /// When it was bought. Only a part only known as a whole can be without one, when it could be from several moments.
    public var at: String? = nil
}

/// A withdrawal found in an exchange's history, with what it cost.
public struct ExchangeWithdrawal: Codable, Sendable, Equatable {
    public let exchange: String
    public let asset: String
    public let units: String
    public let at: String
    /// What it cost going by the average of what was bought before it.
    public let cost: Money
    public let toAddress: String?
    /// The same going oldest first, in the same currency. Nil when that can't be said, or it was saved before this was worked out.
    public var fifoCostMicros: String? = nil
    /// What `fifoCostMicros` is made of, oldest first. Nil means it was saved before this was kept, so only all of it has that cost.
    public var fifoLots: [ExchangeLot]? = nil
    /// Which file this came from, which is how two lots with one date are known to be one purchase. Nil means it was saved before this was kept.
    public var fileId: String? = nil
}

public struct ExchangeImport: Codable, Sendable, Equatable {
    public let withdrawals: [ExchangeWithdrawal]
    /// Withdrawals with no usable cost: bought in a currency this app doesn't have, in several at once, or with a history it can't follow.
    public let skipped: Int
    /// When each asset first shows up in the file, since what came before that is out of its sight.
    public let firstSeen: [String: String]

    /// Where the file starts: the first date to ask someone about. These all come from one encoder, so they sort as dates.
    public var startsAt: String? { firstSeen.values.min() }

    /// Something in it didn't come through, or nothing did.
    public var needsALook: Bool { withdrawals.isEmpty || skipped > 0 }
}

/// An amount someone entered or imported, in the currency it was in, because that's what it stays true in.
public struct Money: Codable, Sendable, Equatable, Hashable {
    public let micros: String
    public let currency: CurrencyCode

    public init(micros: String, currency: CurrencyCode) {
        self.micros = micros
        self.currency = currency
    }
}

/// One thing that arrived from a sender, as it was when someone answered for it. Only the server reads what's in it.
public struct CostReceipt: Codable, Sendable, Equatable, Hashable {
    public let wallet: String
    public let legId: String
    public let asset: String
    public let units: String
}

/// What was paid for exactly these receipts. Anything that arrives later isn't covered, so it's asked about in turn.
public struct ExchangeCost: Codable, Sendable, Equatable, Hashable {
    public let micros: String
    public let currency: CurrencyCode
    public let asset: String
    public let receipts: [CostReceipt]
}

public struct SenderAnswer: Codable, Sendable, Equatable {
    public enum Kind: String, Codable, Sendable {
        case mine
        case myExchange = "my-exchange"
        case someoneElse = "someone-else"
    }

    public let kind: Kind
    /// What was paid, and for which receipts.
    public let costs: [ExchangeCost]?

    public init(kind: Kind, costs: [ExchangeCost]? = nil) {
        self.kind = kind
        self.costs = costs
    }

    public static let mine = SenderAnswer(kind: .mine)
    public static let someoneElse = SenderAnswer(kind: .someoneElse)
}

/// Something bought through a provider, as its order says. Only the server decides whether it matches what arrived, and only an exact match counts.
public struct Purchase: Codable, Sendable, Equatable, Hashable {
    public let provider: String
    public let order: String
    public let wallet: String
    public let asset: String
    public let units: String
    public let txHash: String
    public let blockNum: Int?
    /// Everything paid, fees included.
    public let cost: Money
    public let costUsdMicros: String?

    public init(provider: String, order: String, wallet: String, asset: String, units: String, txHash: String, blockNum: Int?, cost: Money, costUsdMicros: String?) {
        self.provider = provider
        self.order = order
        self.wallet = wallet
        self.asset = asset
        self.units = units
        self.txHash = txHash
        self.blockNum = blockNum
        self.cost = cost
        self.costUsdMicros = costUsdMicros
    }
}

/// What became of a purchase, as the server worked it out from what's been read.
public struct PurchaseMatch: Codable, Sendable, Equatable {
    public enum State: String, Codable, Sendable {
        /// It's the cost of what arrived.
        case recorded
        /// Nothing's been seen arriving from its transaction yet.
        case waiting
        /// Something was, and it isn't exactly what the order says, or can't be shown in this currency.
        case unmatched
    }

    public let order: String
    public let state: State
}

/// Which units one sale or send took, as the user's own records named them. US rules only count that if the records named them no
/// later than the date and time of the sale, so it's kept with when they did. Only the server reads what's in it.
public struct UnitChoice: Codable, Sendable, Equatable, Hashable {
    public struct Take: Codable, Sendable, Equatable, Hashable {
        /// A UTC day as `YYYY-MM-DD`, or a moment as `toISOString` writes it.
        public let boughtAt: String
        /// In the token's smallest units.
        public let units: String
    }

    public let wallet: String
    /// The transaction that sold or sent them.
    public let txHash: String
    public let asset: String
    /// When the records named them, as `toISOString` writes it.
    public let recordedAt: String
    public let takes: [Take]

    /// One choice per sale, whatever case its addresses are in.
    var key: String { "\(wallet.lowercased()):\(txHash.lowercased()):\(asset)" }
}

/// What a file of records said, as the server read it.
public struct UnitChoiceImport: Codable, Sendable, Equatable {
    public let choices: [UnitChoice]
    /// Lines that couldn't be read. A record with one of them is left out whole.
    public let skipped: [Int]

    public init(choices: [UnitChoice], skipped: [Int]) {
        self.choices = choices
        self.skipped = skipped
    }

    /// What to tell someone once it's added.
    public var sentence: String {
        let count = choices.count
        let read = count == 0 ? "Nothing in that file could be used." : "Added \(count.formatted()) \(count == 1 ? "sale or send" : "sales and sends")."
        guard !skipped.isEmpty else { return read }
        let shown = skipped.prefix(5).map(String.init).joined(separator: ", ")
        let lines = skipped.count > 5 ? "\(shown) and \((skipped.count - 5).formatted()) more" : shown
        return "\(read) \(skipped.count == 1 ? "Line" : "Lines") \(lines) couldn't be read, so \(skipped.count == 1 ? "its sale or send was" : "their sales and sends were") left out whole."
    }
}

/// The user's answers. They stay on this device, and go along with each request. The server doesn't keep them.
public struct Book: Codable, Sendable, Equatable, Hashable {
    public var senders: [String: SenderAnswer]
    public var costs: [String: Money]
    public var withdrawals: [ExchangeWithdrawal]
    public var purchases: [Purchase]
    /// Units the user's records named for a sale or send. They aren't answers, so undoing an answer never touches them.
    public var unitChoices: [UnitChoice]

    public init(senders: [String: SenderAnswer] = [:], costs: [String: Money] = [:], withdrawals: [ExchangeWithdrawal] = [], purchases: [Purchase] = [], unitChoices: [UnitChoice] = []) {
        self.senders = senders
        self.costs = costs
        self.withdrawals = withdrawals
        self.purchases = purchases
        self.unitChoices = unitChoices
    }

    /// A book saved before there were purchases, or named units, has none.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        senders = try container.decode([String: SenderAnswer].self, forKey: .senders)
        costs = try container.decode([String: Money].self, forKey: .costs)
        withdrawals = try container.decode([ExchangeWithdrawal].self, forKey: .withdrawals)
        purchases = try container.decodeIfPresent([Purchase].self, forKey: .purchases) ?? []
        unitChoices = try container.decodeIfPresent([UnitChoice].self, forKey: .unitChoices) ?? []
    }

    /// Records added to the book. A newer one for the same sale takes over, since that's the latest word on it.
    public func recordingUnitChoices(_ found: [UnitChoice]) -> Book {
        let again = Set(found.map(\.key))
        var next = self
        next.unitChoices = unitChoices.filter { !again.contains($0.key) } + found
        return next
    }

    /// The book without any records for these wallets.
    public func forgettingUnitChoices(for wallets: [String]) -> Book {
        let mine = Set(wallets.map { $0.lowercased() })
        var next = self
        next.unitChoices = unitChoices.filter { !mine.contains($0.wallet.lowercased()) }
        return next
    }

    /// What an import adds to what earlier ones found. A file that has the same withdrawal again takes over for it, since it's the
    /// latest word on what it cost. Two alike in one file are two withdrawals, so both stay.
    public func importing(_ found: [ExchangeWithdrawal]) -> Book {
        func key(_ withdrawal: ExchangeWithdrawal) -> [String?] { [withdrawal.exchange, withdrawal.asset, withdrawal.units, withdrawal.at, withdrawal.toAddress] }
        let again = Set(found.map(key))
        var next = self
        next.withdrawals = withdrawals.filter { !again.contains(key($0)) } + found
        return next
    }

    /// A withdrawal already imported from before the file starts proves the file isn't the whole history, whatever anyone says about it.
    public func importStartsLate(_ imported: ExchangeImport) -> Bool {
        imported.withdrawals.contains { found in
            guard let start = imported.firstSeen[found.asset] else { return false }
            return withdrawals.contains { $0.asset == found.asset && $0.at < start }
        }
    }

    /// An order can say more as it goes, like the block its delivery landed in, so a newer read of one takes over.
    public func recording(_ purchase: Purchase) -> Book {
        var next = self
        // In its place, because a read that says nothing new mustn't look like a change.
        if let index = next.purchases.firstIndex(where: { $0.order == purchase.order }) {
            next.purchases[index] = purchase
        } else {
            next.purchases.append(purchase)
        }
        return next
    }

    /// Saying a sender's yours says the wallet you're looking at is yours too. Saying someone else sent what arrived from a wallet
    /// that's already yours is about the wallet you're looking at, and yours stays yours.
    public func answering(_ sender: String, _ answer: SenderAnswer, focus: String?) -> Book {
        var next = self
        if answer.kind == .someoneElse, senders[sender.lowercased()]?.kind == .mine, let focus, WalletAddress.isValid(focus), senders[focus.lowercased()]?.kind != .mine {
            next.senders[focus.lowercased()] = answer
            return next
        }
        next.senders[sender.lowercased()] = answer
        if answer.kind == .mine, let focus, WalletAddress.isValid(focus) { next.senders[focus.lowercased()] = .mine }
        return next
    }

    /// Saying what was paid for a sender's open receipts, by asset. It takes over for those receipts, and any others keep their earlier answers.
    public func enteringExchangeCosts(_ sender: String, receipts: [CostReceipt], amounts: [String: Money], focus: String?) -> Book {
        let key = sender.lowercased()
        let earlier = senders[key]?.kind == .myExchange ? (senders[key]?.costs ?? []) : []
        let costs = amounts.sorted { $0.key < $1.key }.map { asset, money in
            ExchangeCost(micros: money.micros, currency: money.currency, asset: asset, receipts: receipts.filter { $0.asset == asset })
        }
        return answering(sender, SenderAnswer(kind: .myExchange, costs: earlier + costs), focus: focus)
    }

    public func enteringCost(_ key: String, _ cost: Money) -> Book {
        var next = self
        next.costs[key] = cost
        return next
    }

    /// Accounts in this wallet are the user's, so nobody's asked. That outranks anything said about them earlier.
    public func linking(_ accounts: [String]) -> Book {
        var next = self
        for account in accounts { next.senders[account.lowercased()] = .mine }
        return next
    }

    public func unlinking(_ accounts: [String]) -> Book {
        var next = self
        for account in accounts where next.senders[account.lowercased()]?.kind == .mine { next.senders[account.lowercased()] = nil }
        return next
    }

    public var linkedWallets: [String] {
        senders.filter { $0.value.kind == .mine }.keys.sorted()
    }

    public var isEmpty: Bool { senders.isEmpty && costs.isEmpty && withdrawals.isEmpty && purchases.isEmpty && unitChoices.isEmpty }
}

extension SenderAnswer: Hashable {}

extension ExchangeWithdrawal: Hashable {}
