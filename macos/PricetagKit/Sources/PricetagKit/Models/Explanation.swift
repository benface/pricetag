// What the server says is behind a number: its explanation, the proof of its price, and the check of its block.

import Foundation

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
    public let blockNum: Int
    public let timestamp: String
    public let txHash: String
    /// What the wallet already held before the first block read, which isn't a transaction.
    public let opening: Bool
    /// What it did, in one plain sentence led by its amount in money.
    public let summary: String
    /// What about it isn't known, in words. nil when nothing is.
    public let unknown: String?
    /// Answering a question about this asset could fix what isn't known.
    public let answerable: Bool
    public let effect: String
    public let netting: String?
    /// What this leg was in USD and the rate that converted it, in words. nil when it's in USD.
    public let conversion: String?
    /// Which of the user's wallets it's in, when several are shown as one.
    public var wallet: String? = nil

    /// A move between two of the user's wallets is the same leg in each, so a list of both tells them apart by wallet.
    public var rowID: String { wallet.map { "\($0):\(id)" } ?? id }

    public var isIncoming: Bool { !delta.hasPrefix("-") }
    public var date: Date? { parseTimestamp(timestamp) }
    /// What the wallet already held has no transaction behind it, and neither does ETH that arrived with none to name.
    public var hasTransaction: Bool { !opening && !txHash.isEmpty }
}

public struct Explanation: Codable, Sendable, Equatable {
    public let currency: CurrencyCode
    public let title: String
    public let value: String?
    /// The same number in USD, when that isn't what `value` is in.
    public let sourceValue: String?
    public let lines: [String]
    /// Each wallet's side of the number, when several are shown as one.
    public var parts: [ExplanationPart]? = nil
    /// Where to read the proof of the current price this number rests on, when that price comes from Chainlink.
    public var priceProof: ExplanationPriceProof? = nil
    public let legCount: Int
    public let legs: [ExplanationLeg]
}

public struct ExplanationPriceProof: Codable, Sendable, Equatable {
    public let asset: String
    /// The price on screen, in USD micros, which its proof has to be about.
    public let price: String
    public let wallet: String

    /// A different one for anything a proof or its result depends on, so neither outlives it.
    func panelID(currency: CurrencyCode, rule: String?) -> String {
        "\(wallet):\(asset):\(price):\(currency.rawValue):\(rule ?? "")"
    }
}

/// One wallet's side of a number shown across several.
public struct ExplanationPart: Codable, Sendable, Equatable, Identifiable {
    public let wallet: String
    public let value: String?
    public let lines: [String]

    public var id: String { wallet }
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

    /// Where the server's proofs link to. Whatever else a server says, this app won't open it.
    static let hosts: Set<String> = ["basescan.org"]

    public var id: String { url }
    public var destination: URL? {
        guard let page = URL(string: url), page.scheme == "https", let host = page.host(), Self.hosts.contains(host) else { return nil }
        return page
    }
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
    /// What a current price's proof describes, which checking it has to name. Only set when it has an update behind it.
    public var revision: String? = nil
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
    case amount, average, price, value, realized, unrealized, `return`, onchain

    static let tableOrder: [AssetMetric] = [.onchain, .amount, .price, .average, .value, .realized, .unrealized, .return]
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
