// What the server sends: see `src/core/api.ts`. Amounts stay decimal strings, because they don't fit in anything
// else, and nothing here does math on them. The server folds; the client only displays.

import Foundation

public enum Mode: String, Codable, Sendable {
    case demo, raw, dataset

    public var label: String {
        switch self {
        case .demo: "Demo data"
        case .raw: "Raw chain data"
        case .dataset: "Pricetag data"
        }
    }
}

public enum CostMethod: String, Codable, Sendable, CaseIterable, Identifiable {
    case average, fifo

    public var id: Self { self }
    public var label: String {
        switch self {
        case .average: "Average"
        case .fifo: "Oldest first"
        }
    }
}

public struct Head: Codable, Sendable, Equatable {
    public let blockNum: Int
    public let timestamp: String

    public var date: Date? { parseTimestamp(timestamp) }
}

public struct Coverage: Codable, Sendable, Equatable {
    public let fromBlock: Int
    public let toBlock: Int
}

public struct LatestPrice: Codable, Sendable, Equatable {
    public let micros: String
    public let source: String
    public let blockNum: Int
}

public struct PositionValues: Codable, Sendable, Equatable {
    public let qty: String
    public let unknownCostQty: String
    public let costMicros: String?
    public let averageCostMicros: String?
    public let valueMicros: String?
    public let realizedMicros: String?
    public let unrealizedMicros: String?
    /// How much of the cost of what's held is an estimate.
    public let estimatedCostMicros: String
    /// How much of what `realizedMicros` comes from is an estimate.
    public let estimatedRealizedMicros: String
}

/// Which of a position's numbers rest on an estimate, so they can look different from exact ones.
public struct Estimates: Codable, Sendable, Equatable {
    public let cost: Bool
    public let value: Bool
    public let realized: Bool
    public let unrealized: Bool
}

/// How a position's activity compares with what the chain says it holds, at the same block.
/// ETH that arrived in a block with no transaction showing it, and the ones that took a token from this wallet there.
public struct UnseenEth: Codable, Sendable, Equatable {
    public let blockNum: Int
    public let amount: String
    public let txHashes: [String]
}

public struct Reconciliation: Codable, Sendable, Equatable {
    public enum Status: String, Codable, Sendable {
        /// They match, to the smallest unit.
        case reconciled
        /// They don't, so the amount and value come from the chain, and PnL is unavailable.
        case incomplete
        /// A read failed or hasn't finished. PnL is unavailable until it works.
        case unchecked
    }

    public let status: Status
    public let blockNum: Int?
    public let computedQty: String?
    public let actualQty: String?
    /// Actual minus computed.
    public let differenceQty: String?
    public let reason: String?
    /// On ETH that doesn't match: the transactions most likely behind it.
    public let unseenEth: [UnseenEth]?
    /// On a balance that couldn't be checked: whether what's shown is still what the chain last said it holds. Without this, its value is only a best estimate.
    public let heldIsCurrent: Bool?
}

public struct Position: Codable, Sendable, Equatable, Identifiable {
    public let asset: String
    public let decimals: Int
    public let note: String?
    public let price: LatestPrice?
    public let values: PositionValues
    public let pnlMicros: String?
    public let shortfallQty: String
    public let legCount: Int
    public let reconciliation: Reconciliation?
    /// No price, in any form, at any block. Often spam. It's listed apart, and can't affect PnL.
    public let noMarket: Bool
    public let estimates: Estimates
    /// Its cost is unknown, and answering a question could change that.
    public let resolvable: Bool

    public var id: String { asset }
    public var isHeld: Bool { isPositive(values.qty) }
    public var hasShortfall: Bool { isPositive(shortfallQty) }
    public var hasUnknownCost: Bool { isPositive(values.unknownCostQty) }

    /// What can be opened for this position, in the holdings table's order.
    public var explainableMetrics: [AssetMetric] {
        AssetMetric.tableOrder.filter { metric in
            switch metric {
            case .amount, .realized: true
            case .average, .value, .unrealized: isHeld
            case .onchain: reconciliation != nil || hasShortfall
            }
        }
    }
    public var isReconciled: Bool { reconciliation?.status == .reconciled }
    public var isIncomplete: Bool { reconciliation?.status == .incomplete }
}

public struct Exclusion: Codable, Sendable, Equatable {
    public let asset: String
    public let reason: String
}

public struct SumCoverage: Codable, Sendable, Equatable {
    public let known: Int
    public let missing: Int

    /// The sum has an answer, and it leaves something out. With nothing known, the server sends no sum at all.
    public var isPartial: Bool { missing > 0 && known > 0 }
}

public struct TotalsCoverage: Codable, Sendable, Equatable {
    public let value: SumCoverage
    public let realized: SumCoverage
    public let unrealized: SumCoverage
    public let pnl: SumCoverage
}

/// Each sum is nil when nothing in it is known. That isn't $0, and a known $0 stays an answer.
public struct Totals: Codable, Sendable, Equatable {
    public let valueMicros: String?
    public let realizedMicros: String?
    public let unrealizedMicros: String?
    public let gasMicros: String?
    public let pnlMicros: String?
    public let excluded: [Exclusion]
    public let unpricedGas: Bool
    public let coverage: TotalsCoverage
    /// What's held with an unknown cost, at today's price. It's not in any PnL.
    public let unresolvedMicros: String
    /// How much of what these sums are made of is an estimate.
    public let estimatedMicros: String
    public let estimated: TotalEstimates
    /// Assets with no market, which aren't in any of this.
    public let noMarket: [String]
}

public struct TotalEstimates: Codable, Sendable, Equatable {
    public let value: Bool
    public let realized: Bool
    public let unrealized: Bool
}

public enum PnlStatus: String, Codable, Sendable {
    /// `totals.pnlMicros` leaves nothing out.
    case complete
    /// It leaves something out, and `totals.excluded` says what.
    case partial
    /// It has nothing known in it, so there's no number to show.
    case unavailable
}

public struct PnlPoint: Codable, Sendable, Equatable, Identifiable {
    public let blockNum: Int
    public let timestamp: String
    public let txHash: String?
    /// nil when nothing is known at this point, which isn't $0.
    public let pnlMicros: String?
    public let excludedCount: Int
    /// What its transaction did, in words. The last point has no transaction.
    public var summary: String? = nil

    public var id: String { "\(blockNum):\(txHash ?? "latest")" }
    public var date: Date? { parseTimestamp(timestamp) }
}

public struct ReadProgress: Codable, Sendable, Equatable {
    /// False until what's read reaches the wallet's first block.
    public let started: Bool
    /// 0 until it's far enough behind the chain to say so.
    public let behindBlocks: Int
}

/// A token off the allowlist that a wallet holds. Nothing ever calls it, because it has no trusted price and may be malicious.
public struct UnlistedToken: Codable, Sendable, Equatable, Identifiable {
    public let token: String
    public let transfers: Int

    public var id: String { token }
}

/// How a portfolio's money got out of USD. The server converts each amount at the rate when it happened.
public struct PortfolioExchange: Codable, Sendable, Equatable {
    /// Where the rates came from, in words.
    public let source: String
    /// nil when there's no current rate, so nothing held has a current value.
    public let latestRateMicros: String?
    /// Transactions with an amount that had no rate at its block, so that amount is unavailable.
    public let missingRateTxs: [String]
}

/// What a wallet made next to what simply holding ETH would have. The server works it out, like every other number.
public struct HoldComparison: Codable, Sendable, Equatable {
    public enum Status: String, Codable, Sendable {
        /// The two cover the same money, so they can be set against each other.
        case complete
        /// Each is true of what it covers, but they don't cover the same money, so there's no difference to show.
        case partial
        /// What holding would have made can't be worked out.
        case unavailable
    }

    public enum Unavailable: String, Codable, Sendable {
        case noCurrentEthPrice = "no current eth price"
        case nothingKnownPutIn = "nothing known put in"
        case leftWithNoKnownValue = "left with no known value"
        case leftWithNoKnownShare = "left with no known share"
    }

    public let status: Status
    public let unavailable: Unavailable?
    /// The wallet's total PnL after network fees, plus any gain that left with what it sent. nil when nothing in it is known.
    public let walletMicros: String?
    public let walletLeavesOut: Bool
    /// `walletMicros` rests on a market price.
    public let walletEstimated: Bool
    /// nil when it's unavailable. That isn't $0.
    public let holdMicros: String?
    /// Only when complete.
    public let differenceMicros: String?
    /// What's known to have been put in. An amount with no known value isn't in it, and isn't counted as $0.
    public let putInMicros: String
    /// Movements in with no known value. Never counted as $0.
    public let unknownAmounts: Int
    public let estimated: Bool
}

public struct Portfolio: Codable, Sendable, Equatable {
    public let address: String
    public let mode: Mode
    public let method: CostMethod
    /// The pricing rule this was read through, or nil when the server has only one.
    public let rule: String?
    /// What every amount in here is in.
    public let currency: CurrencyCode
    /// nil for USD.
    public let exchange: PortfolioExchange?
    public let coverage: Coverage
    public let trackedTokens: Int
    public let latest: Head
    public let progress: ReadProgress
    public let gasUnknownTxs: [String]
    public let outgoingTxs: [String]
    public let unlisted: [UnlistedToken]
    public let l1FeeUnknownTxs: [String]
    /// Assets whose balance before the first block couldn't be read yet.
    public let openingUnread: [String]
    /// Assets with no position because nothing could be read about them, which isn't the same as holding none.
    public let unreadAssets: [String]
    public let positions: [Position]
    public let totals: Totals
    public let pnlStatus: PnlStatus
    public let points: [PnlPoint]
    public let holdComparison: HoldComparison
    /// What's left to ask, most useful first.
    public let questions: [Question]
    public let meter: Meter
    /// Linked wallets that aren't read yet, so what came from them shows as unresolved for now.
    public let linkedReading: [String]
    /// Linked wallets whose last read failed. It's tried again with each read, and what they sent stays unresolved or out of date until it works.
    public let linkedFailed: [String]
    /// Other wallets' history that can't be confirmed, which leaves what they sent here with an unknown cost.
    public let withheld: [WithheldCost]
    /// What became of each purchase in the book, among the wallets read.
    public let purchases: [PurchaseMatch]?
    public let marketChecked: Bool

    /// What the holdings table lists. Tokens with no market go in a group of their own, so real warnings stay noticeable.
    public var listedPositions: [Position] { positions.filter { !$0.noMarket } }
    public var noMarketPositions: [Position] { positions.filter(\.noMarket) }

    /// What a glance lists: what's held, most valuable first. One with no price can't be ranked, so it goes last, and it isn't treated as worth nothing.
    public func largestHoldings(_ limit: Int) -> [Position] {
        func value(_ position: Position) -> Decimal? { position.values.valueMicros.flatMap { Decimal(string: $0) } }
        let sorted = listedPositions.filter(\.isHeld).sorted { a, b in
            switch (value(a), value(b)) {
            case let (a?, b?) where a != b: a > b
            case (_?, nil): true
            case (nil, _?): false
            default: a.asset < b.asset
            }
        }
        return Array(sorted.prefix(limit))
    }

    /// Nothing moved in the blocks read, which says nothing about what this wallet made or lost.
    /// A balance that couldn't be read doesn't count as nothing.
    public var isEmpty: Bool { positions.isEmpty && unreadAssets.isEmpty }
    public var hasChartableData: Bool { points.contains { $0.pnlMicros != nil } }
    /// A line says nothing with a transaction or two, or across a few minutes: it's an empty box with a flat line in it.
    public var isTooNewToChart: Bool {
        let known = points.filter { $0.txHash != nil && $0.pnlMicros != nil }.compactMap(\.date)
        guard known.count >= 3, let first = known.min(), let last = known.max() else { return true }
        return last.timeIntervalSince(first) < 5 * 60
    }
    /// Every point with a transaction behind it, newest first.
    public var transactions: [PnlPoint] { points.filter { $0.txHash != nil }.reversed() }
}

public struct ExplanationLeg: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let asset: String
    public let delta: String
    public let decimals: Int
    public let kind: String
    public let priceMicros: String?
    public let priceSource: String?
    public let priceNote: String?
    public let costLabel: String
    /// Who says what was paid, when it isn't the chain.
    public let costSource: String?
    /// Its cost or proceeds rest on an estimate.
    public let estimated: Bool
    /// Some of what arrived has a known cost and some doesn't.
    public let partlyUnknown: Bool
    public let blockNum: Int
    public let timestamp: String
    public let txHash: String
    /// What the wallet already held before the first block read, which isn't a transaction.
    public let opening: Bool
    /// What it did, in one plain sentence led by its amount in money.
    public let summary: String
    /// What about it isn't known, in words. nil when nothing is.
    public let unknown: String?
    public let effect: String
    public let netting: String?
    /// What this leg was in USD and the rate that converted it, in words. nil when it's in USD.
    public let conversion: String?

    public var isIncoming: Bool { !delta.hasPrefix("-") }
    public var date: Date? { parseTimestamp(timestamp) }
    /// What the wallet already held has no transaction behind it, and neither does ETH that arrived with none to name.
    public var hasTransaction: Bool { !opening && !txHash.isEmpty }
    public var transactionURL: URL? { hasTransaction ? URL(string: "https://basescan.org/tx/\(txHash)") : nil }
}

public struct Explanation: Codable, Sendable, Equatable {
    public let currency: CurrencyCode
    public let title: String
    public let value: String?
    /// The same number in USD, when that isn't what `value` is in.
    public let sourceValue: String?
    public let lines: [String]
    public let legCount: Int
    public let legs: [ExplanationLeg]
}

/// A dataset behind a number. `hash` is nil when it couldn't be read, and it's never guessed.
public struct ProofDataset: Codable, Sendable, Equatable, Identifiable {
    public let title: String
    public let name: String
    public let hash: String?

    public var id: String { name }
}

public struct ProofLink: Codable, Sendable, Equatable, Identifiable {
    public let title: String
    public let url: String

    public var id: String { url }
    public var destination: URL? { URL(string: url) }
}

/// What's behind one row's price, in the server's words.
public struct Proof: Codable, Sendable, Equatable {
    public let blockNum: Int
    public let txHash: String
    public let source: [String]
    public let movements: [String]
    public let links: [ProofLink]
    public let datasets: [ProofDataset]
    /// What checking the block does and doesn't show for this row.
    public let scope: [String]
    /// Why the block can't be checked. nil when it can.
    public let unavailable: String?
}

public enum CheckStatus: String, Codable, Sendable {
    case passed, failed, unchecked
}

public struct ProofCheck: Codable, Sendable, Equatable, Identifiable {
    public let title: String
    public let status: CheckStatus
    public let detail: String

    public var id: String { title }
}

/// The block's commitments recomputed from what Amp stored. `status` is the worst of `checks`.
public struct Verification: Codable, Sendable, Equatable {
    public let blockNum: Int
    public let blockHash: String
    public let status: CheckStatus
    public let summary: String
    public let checks: [ProofCheck]
}

public enum TotalMetric: String, Sendable, Hashable, CaseIterable {
    case pnl, value, realized, unrealized, gas
}

public enum AssetMetric: String, Sendable, Hashable, CaseIterable {
    case amount, average, value, realized, unrealized, onchain

    static let tableOrder: [AssetMetric] = [.onchain, .amount, .average, .value, .realized, .unrealized]
}

/// A number someone clicked, to read what's behind it.
public enum ExplainTarget: Sendable, Hashable {
    case total(TotalMetric)
    case asset(String, AssetMetric)
    case transaction(String)
    case holdComparison

    var queryItems: [URLQueryItem] {
        switch self {
        case .total(let metric): [URLQueryItem(name: "metric", value: metric.rawValue)]
        case .asset(let asset, let metric): [URLQueryItem(name: "asset", value: asset), URLQueryItem(name: "metric", value: metric.rawValue)]
        case .transaction(let hash): [URLQueryItem(name: "tx", value: hash)]
        case .holdComparison: [URLQueryItem(name: "metric", value: "hold")]
        }
    }
}

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

/// A withdrawal found in an exchange's history, with what it cost.
public struct ExchangeWithdrawal: Codable, Sendable, Equatable {
    public let exchange: String
    public let asset: String
    public let units: String
    public let at: String
    public let cost: Money
    public let toAddress: String?
}

public struct ExchangeImport: Codable, Sendable, Equatable {
    public let withdrawals: [ExchangeWithdrawal]
    /// Withdrawals with no usable cost: bought in a currency this app doesn't have, in several at once, or with a history it can't follow.
    public let skipped: Int
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

/// The user's answers. They stay on this device, and go along with each request. The server doesn't keep them.
public struct Book: Codable, Sendable, Equatable, Hashable {
    public var senders: [String: SenderAnswer]
    public var costs: [String: Money]
    public var withdrawals: [ExchangeWithdrawal]
    public var purchases: [Purchase]

    public init(senders: [String: SenderAnswer] = [:], costs: [String: Money] = [:], withdrawals: [ExchangeWithdrawal] = [], purchases: [Purchase] = []) {
        self.senders = senders
        self.costs = costs
        self.withdrawals = withdrawals
        self.purchases = purchases
    }

    /// A book saved before there were purchases has none.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        senders = try container.decode([String: SenderAnswer].self, forKey: .senders)
        costs = try container.decode([String: Money].self, forKey: .costs)
        withdrawals = try container.decode([ExchangeWithdrawal].self, forKey: .withdrawals)
        purchases = try container.decodeIfPresent([Purchase].self, forKey: .purchases) ?? []
    }

    /// An order can say more as it goes, like the block its delivery landed in, so a newer read of one takes over.
    public func recording(_ purchase: Purchase) -> Book {
        var next = self
        next.purchases.removeAll { $0.order == purchase.order }
        next.purchases.append(purchase)
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

    public var isEmpty: Bool { senders.isEmpty && costs.isEmpty && withdrawals.isEmpty && purchases.isEmpty }
}

extension SenderAnswer: Hashable {}
extension ExchangeWithdrawal: Hashable {}

public enum WalletAddress {
    /// What the server accepts in place of an address, to read its fixtures.
    public static let demo = "demo"

    /// Whether the server reads this from its fixtures, which it also does for the fixtures' own addresses.
    public static func isDemo(_ value: String) -> Bool {
        [demo, "0x00000000000000000000000000000000000de300", "0x00000000000000000000000000000000000de301"].contains(value.lowercased())
    }

    public static func isValid(_ value: String) -> Bool {
        value.wholeMatch(of: /0x[0-9a-fA-F]{40}/) != nil
    }

    /// The one address in whatever was pasted, which is often more than the address: `base:0x…`, or a link to an explorer's page.
    /// Nil if there's none, or several to choose between. A transaction hash is longer, so it never counts.
    public static func find(in text: String) -> String? {
        pasted(in: text)?.lowercased()
    }

    /// The same, with its case as it was, because mixed case is a checksum that can still be checked.
    public static func pasted(in text: String) -> String? {
        let found = all(in: text)
        return found.count == 1 ? found.first : nil
    }

    /// Every different address in the text, in the order they came. The same one twice only counts once, whatever its case.
    public static func all(in text: String) -> [String] {
        var seen = Set<String>()
        return text.matches(of: /(?:^|[^0-9a-zA-Z])(0x[0-9a-fA-F]{40})(?=$|[^0-9a-zA-Z])/).map { String($0.output.1) }.filter { seen.insert($0.lowercased()).inserted }
    }

    /// Too long to still be on its way to being an address, so there's no point waiting to say so.
    public static func isTooLong(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).count >= 42 && find(in: text) == nil
    }
}

func isPositive(_ units: String) -> Bool {
    !units.hasPrefix("-") && units.contains { $0 != "0" }
}

func parseTimestamp(_ value: String) -> Date? {
    try? Date(value, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))
}

/// A dataset version the server can read a wallet through. Queries are pinned to `hash`, so it's what actually gets read.
public struct PricingRule: Codable, Sendable, Equatable, Hashable, Identifiable {
    public let id: String
    public let name: String
    public let summary: String
    public let dataset: String
    public let hash: String

    public init(id: String, name: String, summary: String, dataset: String, hash: String) {
        self.id = id
        self.name = name
        self.summary = summary
        self.dataset = dataset
        self.hash = hash
    }
}

/// One number by each rule. A nil is unavailable, not zero.
public struct RuleRow: Codable, Sendable, Equatable, Identifiable {
    public let label: String
    /// `signed` or `money` in the wallet's currency, or `usdPrice`, which is always in USD.
    public let format: String
    public let a: String?
    public let b: String?
    /// nil unless both sides are made of the same known amounts, because anything else isn't a difference between rules.
    public let difference: String?
    /// This side's sum leaves something out. `warnings` says what.
    public let aPartial: Bool
    public let bPartial: Bool
    /// This side rests on an estimate, and so does a difference from it. `warnings` says how much.
    public let aEstimated: Bool
    public let bEstimated: Bool

    public var id: String { label }
}

public struct RuleTransaction: Codable, Sendable, Equatable, Identifiable {
    public let txHash: String
    public let blockNum: Int
    public let timestamp: String
    public let asset: String
    public let label: String
    public let a: String?
    public let b: String?
    public let difference: String?
    public let aEstimated: Bool
    public let bEstimated: Bool

    public var id: String { "\(txHash):\(asset):\(label)" }
}

/// What two rules make of one wallet at the same block, so the only difference between them is the rule.
public struct RuleComparison: Codable, Sendable, Equatable {
    public let address: String
    public let currency: CurrencyCode
    public let blockNum: Int
    public let a: PricingRule
    public let b: PricingRule
    public let why: String
    /// What the numbers leave out or can't vouch for, the same as they'd say on the main screen.
    public let warnings: [String]
    public let rows: [RuleRow]
    /// The newest few that came out differently. `changedTxs` says how many there are.
    public let transactions: [RuleTransaction]
    public let changedTxs: Int
}
