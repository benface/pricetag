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
    /// What's left to ask, most useful first.
    public let questions: [Question]
    public let meter: Meter
    /// Linked wallets that aren't read yet, so what came from them shows as unresolved for now.
    public let linkedReading: [String]
    /// Linked wallets whose last read failed. It's tried again with each read, and what they sent stays unresolved or out of date until it works.
    public let linkedFailed: [String]
    public let marketChecked: Bool

    /// What the holdings table lists. Tokens with no market go in a group of their own, so real warnings stay noticeable.
    public var listedPositions: [Position] { positions.filter { !$0.noMarket } }
    public var noMarketPositions: [Position] { positions.filter(\.noMarket) }

    /// Nothing moved in the blocks read, which says nothing about what this wallet made or lost.
    /// A balance that couldn't be read doesn't count as nothing.
    public var isEmpty: Bool { positions.isEmpty && unreadAssets.isEmpty }
    public var hasChartableData: Bool { points.contains { $0.pnlMicros != nil } }
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
    /// Its cost or proceeds rest on an estimate.
    public let estimated: Bool
    /// Some of what arrived has a known cost and some doesn't.
    public let partlyUnknown: Bool
    public let blockNum: Int
    public let timestamp: String
    public let txHash: String
    /// What the wallet already held before the first block read, which isn't a transaction.
    public let opening: Bool
    public let effect: String
    public let netting: String?
    /// What this leg was in USD and the rate that converted it, in words. nil when it's in USD.
    public let conversion: String?

    public var isIncoming: Bool { !delta.hasPrefix("-") }
    public var date: Date? { parseTimestamp(timestamp) }
    public var transactionURL: URL? { opening ? nil : URL(string: "https://basescan.org/tx/\(txHash)") }
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
}

/// A number someone clicked, to read what's behind it.
public enum ExplainTarget: Sendable, Hashable {
    case total(TotalMetric)
    case asset(String, AssetMetric)
    case transaction(String)

    var queryItems: [URLQueryItem] {
        switch self {
        case .total(let metric): [URLQueryItem(name: "metric", value: metric.rawValue)]
        case .asset(let asset, let metric): [URLQueryItem(name: "asset", value: asset), URLQueryItem(name: "metric", value: metric.rawValue)]
        case .transaction(let hash): [URLQueryItem(name: "tx", value: hash)]
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

/// The user's answers. They stay on this device, and go along with each request. The server doesn't keep them.
public struct Book: Codable, Sendable, Equatable, Hashable {
    public var senders: [String: SenderAnswer]
    public var costs: [String: Money]
    public var withdrawals: [ExchangeWithdrawal]

    public init(senders: [String: SenderAnswer] = [:], costs: [String: Money] = [:], withdrawals: [ExchangeWithdrawal] = []) {
        self.senders = senders
        self.costs = costs
        self.withdrawals = withdrawals
    }

    /// Saying a sender's yours says the wallet you're looking at is yours too.
    public func answering(_ sender: String, _ answer: SenderAnswer, focus: String?) -> Book {
        var next = self
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

    public var linkedWallets: [String] {
        senders.filter { $0.value.kind == .mine }.keys.sorted()
    }

    public var isEmpty: Bool { senders.isEmpty && costs.isEmpty && withdrawals.isEmpty }
}

extension SenderAnswer: Hashable {}
extension ExchangeWithdrawal: Hashable {}

public enum WalletAddress {
    /// What the server accepts in place of an address, to read its fixtures.
    public static let demo = "demo"

    public static func isValid(_ value: String) -> Bool {
        value.wholeMatch(of: /0x[0-9a-fA-F]{40}/) != nil
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
