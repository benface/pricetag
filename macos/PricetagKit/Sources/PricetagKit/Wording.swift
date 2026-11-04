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
        return "Covers blocks \(Format.block(span.fromBlock)) to \(Format.block(span.toBlock)) (about \(Format.duration(blocks: span.toBlock - span.fromBlock))) and \(portfolio.trackedTokens) tokens plus ETH. What the wallet held before that comes from the chain, at an unknown cost. Tokens off the list aren't counted."
    }

    public static func gasUnknown(_ count: Int) -> String {
        "Gas couldn't be worked out for \(count) \(count == 1 ? "transaction" : "transactions"), so ETH is overstated by that much."
    }

    public static func networkFeeUnknown(_ count: Int) -> String {
        "Couldn't read the network fee of \(count) \(count == 1 ? "transaction" : "transactions") yet, so gas paid is low and ETH's PnL is unavailable until it can."
    }

    /// What the onchain check found, or nil when there's nothing to say.
    public static func check(_ position: Position) -> String? {
        guard let check = position.reconciliation else { return nil }
        switch check.status {
        case .reconciled:
            return "Matches the chain exactly."
        case .unchecked:
            return "Not checked. \(check.reason ?? "") PnL is unavailable until this balance is confirmed."
        case .incomplete:
            guard let computed = check.computedQty, let actual = check.actualQty, let difference = check.differenceQty else { return nil }
            let signed = difference.hasPrefix("-") ? "" : "+"
            return "Worked out \(Format.amount(computed, decimals: position.decimals)), onchain \(Format.amount(actual, decimals: position.decimals)), difference \(signed)\(Format.amount(difference, decimals: position.decimals)) \(position.asset). PnL is unavailable."
        }
    }

    /// What's missing while a dataset catches up to the chain. nil when it isn't behind.
    public static func catchingUp(_ portfolio: Portfolio) -> String? {
        if !portfolio.progress.started {
            return "The Pricetag dataset hasn't reached block \(Format.block(portfolio.coverage.fromBlock)) yet, so there's nothing to show for this wallet so far."
        }
        if portfolio.progress.behindBlocks == 0 { return nil }
        return "The Pricetag dataset has only processed up to block \(Format.block(portfolio.coverage.toBlock)), \(Format.block(portfolio.progress.behindBlocks)) blocks behind the chain. Anything after that isn't in these numbers yet."
    }

    public static let unpricedGas = "Some gas had no price at its block, and isn't in this total."
    public static let demo = "Demo data, not a real wallet. Every case the app has to get right is in here."
    public static let pnlUnavailable = "PnL unavailable"
    public static let nothingToChart = "Everything here depends on an unknown cost or price, so there's no PnL to chart."
}
