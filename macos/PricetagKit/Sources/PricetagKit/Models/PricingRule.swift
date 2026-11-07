// The dataset versions a server can read a wallet through, and what comparing two of them shows.

import Foundation

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
