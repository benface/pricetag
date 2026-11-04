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
        let opening = portfolio.openingUnread.isEmpty
            ? "What the wallet held before that comes from the chain, at an unknown cost."
            : "What the wallet held before that couldn't all be read yet, so some amounts may not be full balances."
        return "Covers blocks \(Format.block(span.fromBlock)) to \(Format.block(span.toBlock)) (about \(Format.duration(blocks: span.toBlock - span.fromBlock))) and \(portfolio.trackedTokens) tokens plus ETH. \(opening) Tokens off the list aren't counted."
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

    /// What sits right next to a total, so it never appears bare. nil when it's exact and whole.
    public static func headlineCaveat(_ totals: Totals) -> String? {
        var parts: [String] = []
        if isPositive(totals.unresolvedUsdMicros) { parts.append("\(Format.usd(totals.unresolvedUsdMicros)) unresolved") }
        if isPositive(totals.estimatedUsdMicros) { parts.append("\(Format.usd(totals.estimatedUsdMicros)) estimated") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// What isn't listed with the holdings, and why it doesn't matter to the numbers. nil when there's nothing.
    public static func noMarket(_ portfolio: Portfolio) -> String? {
        let listed = portfolio.noMarketPositions.map(\.asset)
        let total = listed.count + portfolio.unlistedTokens
        if total == 0 { return nil }
        let off = portfolio.unlistedTokens == 0 ? "" : "\(listed.isEmpty ? "" : ", plus ")\(portfolio.unlistedTokens) we don't track"
        return "\(total) \(total == 1 ? "token" : "tokens") with no market: \(listed.joined(separator: ", "))\(off). Often spam, and not counted in any total."
    }

    /// What a wallet signs to prove it's this user's. The server checks the signature against the same words.
    public static func linkMessage(owner: String, address: String) -> String {
        "Patina: \(address.lowercased()) is my wallet, and belongs with \(owner.lowercased()).\n\nThis only links them in my own app. It can't move funds or approve anything."
    }

    /// Where a price came from, in plain words.
    public static func priceSource(_ source: String) -> String {
        switch source {
        case "oracle": "price feed"
        case "swap": "swap"
        case "market": "recent trades"
        default: source
        }
    }

    /// Where a cost came from, in plain words.
    public static func costSource(_ label: String) -> String {
        switch label {
        case "paid": "what you paid"
        case "inherited": "from your other wallet"
        case "received at market": "price when it arrived"
        case "self-reported": "what you reported"
        default: label
        }
    }

    public static func kind(_ kind: String) -> String {
        kind == "swap" ? "trade" : kind == "gas" ? "network fee" : kind
    }

    /// A preview's headline, as it would read.
    public static func consequence(_ preview: BookPreview) -> String {
        if preview.pending { return "Reading that wallet…" }
        guard let pnl = preview.pnlUsdMicros else { return "PnL still unavailable" }
        let number = Format.estimate(Format.signedUSD(pnl), isPositive(preview.estimatedUsdMicros))
        return isPositive(preview.unresolvedUsdMicros) ? "\(number) · \(Format.usd(preview.unresolvedUsdMicros)) unresolved" : number
    }

    public static let unpricedGas = "Some gas had no price at its block, and isn't in this total."
    public static let demo = "Demo data, not a real wallet. Every case the app has to get right is in here."
    public static let pnlUnavailable = "PnL unavailable"
    public static let nothingToChart = "Everything here depends on an unknown cost or price, so there's no PnL to chart."
}
