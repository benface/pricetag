// What the interface calls things, and the sentences the honesty rules depend on. The API keeps its own names, like
// `oracle` and `swap`: this is only what people read. `src/core/wording.ts` says the same, and a test runs both on the same inputs.

import Foundation

public enum Wording {
    public static let methodName = "How cost is worked out"
    public static let methodHelp = "Average spreads what you paid across all you hold. Oldest first counts what you sell as what you got earliest."
    public static let averagePricePaid = "Average price paid"
    public static let networkFees = "Network fees"
    public static let realizedHelp = "Gain or loss on what you've sold or spent."
    public static let unrealizedHelp = "Gain or loss on what you still hold, at the current price."

    /// What a leg did, in a word.
    public static func action(kind: String, isIncoming: Bool) -> String {
        switch kind {
        case "gas": "Network fee"
        case "swap": isIncoming ? "Bought" : "Sold"
        default: isIncoming ? "Received" : "Sent"
        }
    }

    public static func priceSource(_ source: String) -> String {
        switch source {
        case "oracle": "market price feed"
        case "swap": "from this exchange"
        case "market": "market price"
        default: source
        }
    }

    /// Where a leg's cost came from.
    public static func costTag(_ label: String) -> String {
        switch label {
        case "paid": "Cost: what you paid"
        case "inherited": "Cost: from your other wallet"
        case "received at market": "Cost: market price when received"
        case "self-reported": "Cost: what you entered"
        case "unknown": "Cost unknown"
        default: "Cost: \(label)"
        }
    }

    /// What a list of movements is called, with how much of it is showing.
    public static func activityTitle(count: Int, shown: Int) -> String {
        count > shown ? "Activity (newest \(shown) of \(Format.block(count)))" : "Activity (\(Format.block(count)))"
    }

    /// What a total leaves out, or nil when it leaves out nothing.
    public static func excluded(_ excluded: [Exclusion]) -> String? {
        if excluded.isEmpty { return nil }
        var reasons: [String] = []
        var assetsByReason: [String: [String]] = [:]
        for item in excluded {
            if assetsByReason[item.reason] == nil { reasons.append(item.reason) }
            assetsByReason[item.reason, default: []].append(item.asset)
        }
        let parts = reasons.map { "\(assetsByReason[$0]!.joined(separator: ", ")) (\($0))" }
        return "Excludes \(parts.joined(separator: "; "))."
    }

    public static func coverage(_ portfolio: Portfolio) -> String {
        coverage(portfolio.coverage, trackedTokens: portfolio.trackedTokens)
    }

    static func coverage(_ span: Coverage, trackedTokens: Int) -> String {
        "Covers about \(Format.duration(blocks: span.toBlock - span.fromBlock)) of history and \(trackedTokens) tokens plus ETH. Anything earlier or on other tokens isn't counted, so amounts are what moved in this time, not full balances."
    }

    public static func feesUnknown(_ count: Int) -> String {
        "Network fees couldn't be worked out for \(count) \(count == 1 ? "transaction" : "transactions"), so the ETH amount is too high by that much."
    }

    /// What's missing while a dataset catches up to the chain. nil when it isn't behind.
    public static func catchingUp(_ portfolio: Portfolio) -> String? {
        if !portfolio.progress.started { return notStarted }
        if portfolio.progress.behindBlocks == 0 { return nil }
        return behind(blocks: portfolio.progress.behindBlocks)
    }

    static func behind(blocks: Int) -> String {
        // Under half a minute would round to "0 min", which reads as not behind at all.
        "The data is still catching up, \(blocks < 15 ? "less than a minute" : "about \(Format.duration(blocks: blocks))") behind the network. Anything newer isn't in these numbers yet."
    }

    public static func stale(lastUpdate: String) -> String {
        "These numbers aren't updating. Last update: \(lastUpdate)."
    }

    /// The technical side of the status badge, for its tooltip.
    public static func feedDetail(_ mode: Mode, block: Int) -> String {
        mode == .demo ? mode.label : "\(mode.label) · block \(Format.block(block))"
    }

    public static let notStarted = "The data hasn't reached this wallet's history yet, so there's nothing to show so far."
    public static let unpricedFees = "Some network fees had no price at the time, and aren't in this total."
    public static let demo = "Demo data, not a real wallet. Every case the app has to get right is in here."
    public static let pnlUnavailable = "PnL unavailable"
    public static let nothingToChart = "Everything here depends on an unknown cost or price, so there's no PnL to chart. It isn't $0."
    public static let reading = "Reading this wallet's history. The first read can take a minute, then only new activity is read."
    public static let notAnAddress = "That isn't a Base address. It should start with 0x, then 40 letters and numbers."
}

extension AssetMetric {
    /// What this number is, for tooltips and VoiceOver.
    public var label: String {
        switch self {
        case .amount: "amount"
        case .average: Wording.averagePricePaid.lowercased()
        case .value: "value"
        case .realized: "realized PnL"
        case .unrealized: "unrealized PnL"
        }
    }

    public var help: String? {
        switch self {
        case .realized: Wording.realizedHelp
        case .unrealized: Wording.unrealizedHelp
        default: nil
        }
    }
}
