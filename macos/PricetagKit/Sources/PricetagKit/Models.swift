// What the server sends: see `src/core/api.ts`. Amounts stay decimal strings, because they don't fit in anything
// else, and nothing here does math on them. The server folds; the client only displays.

import Foundation

public enum Mode: String, Codable, Sendable {
    case demo, raw, dataset

    public var label: String {
        switch self {
        case .demo: "Demo data"
        case .raw: "Raw dataset"
        case .dataset: "Pricetag dataset"
        }
    }
}

public enum CostMethod: String, Codable, Sendable, CaseIterable, Identifiable {
    case average, fifo

    public var id: Self { self }
    public var label: String {
        switch self {
        case .average: "Average cost"
        case .fifo: "FIFO"
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
    public let usdMicros: String
    public let source: String
    public let blockNum: Int
}

public struct PositionValues: Codable, Sendable, Equatable {
    public let qty: String
    public let unknownCostQty: String
    public let costUsdMicros: String?
    public let averageCostUsdMicros: String?
    public let valueUsdMicros: String?
    public let realizedUsdMicros: String?
    public let unrealizedUsdMicros: String?
}

public struct Position: Codable, Sendable, Equatable, Identifiable {
    public let asset: String
    public let decimals: Int
    public let note: String?
    public let price: LatestPrice?
    public let values: PositionValues
    public let pnlUsdMicros: String?
    public let shortfallQty: String
    public let legCount: Int

    public var id: String { asset }
    public var isHeld: Bool { isPositive(values.qty) }
    public var hasShortfall: Bool { isPositive(shortfallQty) }
    public var hasUnknownCost: Bool { isPositive(values.unknownCostQty) }
}

public struct Exclusion: Codable, Sendable, Equatable {
    public let asset: String
    public let reason: String
}

public struct SumCoverage: Codable, Sendable, Equatable {
    public let known: Int
    public let missing: Int

    public var nothingKnown: Bool { missing > 0 && known == 0 }
    public var isPartial: Bool { missing > 0 && known > 0 }
}

public struct TotalsCoverage: Codable, Sendable, Equatable {
    public let value: SumCoverage
    public let realized: SumCoverage
    public let unrealized: SumCoverage
}

public struct Totals: Codable, Sendable, Equatable {
    public let valueUsdMicros: String
    public let realizedUsdMicros: String
    public let unrealizedUsdMicros: String
    public let gasUsdMicros: String
    public let pnlUsdMicros: String
    public let excluded: [Exclusion]
    public let unpricedGas: Bool
    public let coverage: TotalsCoverage
}

public enum PnlStatus: String, Codable, Sendable {
    /// `totals.pnlUsdMicros` leaves nothing out.
    case complete
    /// It leaves something out, and `totals.excluded` says what.
    case partial
    /// It has nothing known in it, so it must not be shown as a number.
    case unavailable
}

public struct PnlPoint: Codable, Sendable, Equatable, Identifiable {
    public let blockNum: Int
    public let timestamp: String
    public let txHash: String?
    public let pnlUsdMicros: String
    public let excludedCount: Int

    public var id: String { "\(blockNum):\(txHash ?? "latest")" }
    public var date: Date? { parseTimestamp(timestamp) }
}

public struct Portfolio: Codable, Sendable, Equatable {
    public let address: String
    public let mode: Mode
    public let method: CostMethod
    public let coverage: Coverage
    public let trackedTokens: Int
    public let latest: Head
    public let gasUnknownTxs: [String]
    public let positions: [Position]
    public let totals: Totals
    public let pnlStatus: PnlStatus
    public let points: [PnlPoint]

    /// Nothing moved in the blocks read, which says nothing about what this wallet made or lost.
    public var isEmpty: Bool { positions.isEmpty }
}

public struct ExplanationLeg: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let asset: String
    public let delta: String
    public let decimals: Int
    public let kind: String
    public let priceUsdMicros: String?
    public let priceSource: String?
    public let priceNote: String?
    public let costLabel: String
    public let blockNum: Int
    public let timestamp: String
    public let txHash: String
    public let effect: String
    public let netting: String?

    public var isIncoming: Bool { !delta.hasPrefix("-") }
    public var date: Date? { parseTimestamp(timestamp) }
    public var transactionURL: URL? { URL(string: "https://basescan.org/tx/\(txHash)") }
}

public struct Explanation: Codable, Sendable, Equatable {
    public let title: String
    public let value: String?
    public let lines: [String]
    public let legCount: Int
    public let legs: [ExplanationLeg]
}

public enum TotalMetric: String, Sendable, Hashable, CaseIterable {
    case pnl, value, realized, unrealized, gas
}

public enum AssetMetric: String, Sendable, Hashable, CaseIterable {
    case amount, average, value, realized, unrealized
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
