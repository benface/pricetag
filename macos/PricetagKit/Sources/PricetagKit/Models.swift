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
    public let difference: String?

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
    public let rows: [RuleRow]
    /// The newest few that came out differently. `changedTxs` says how many there are.
    public let transactions: [RuleTransaction]
    public let changedTxs: Int
}
