// The sentences the honesty rules depend on. They say the same thing as the web app.

import Foundation

public enum Wording {
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
        let span = portfolio.coverage
        return "Covers blocks \(Format.block(span.fromBlock)) to \(Format.block(span.toBlock)) (about \(Format.duration(blocks: span.toBlock - span.fromBlock))) and \(portfolio.trackedTokens) tokens plus ETH. Anything earlier or off the list isn't counted, so amounts are what moved in this window, not full balances."
    }

    public static func gasUnknown(_ count: Int) -> String {
        "Gas couldn't be worked out for \(count) \(count == 1 ? "transaction" : "transactions"), so ETH is overstated by that much."
    }

    public static let unpricedGas = "Some gas had no price at its block, and isn't in this total."
    public static let demo = "Demo data, not a real wallet. Every case the app has to get right is in here."
    public static let pnlUnavailable = "PnL unavailable"
}
