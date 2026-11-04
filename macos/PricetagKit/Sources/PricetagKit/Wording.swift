// What the interface calls things, and the sentences the honesty rules depend on. The API keeps its own names, like
// `oracle` and `swap`: this is only what people read. `src/core/wording.ts` says the same, and a test runs both on the same inputs.

import Foundation

public enum Wording {
    public static let methodName = "How cost is worked out"
    public static let methodHelp = "Average spreads what you paid across all you hold. Oldest first counts what you sell as what you got earliest."
    public static let averagePricePaid = "Average price paid"
    public static let networkFees = "Network fees"
    public static let balanceCheck = "Balance check"
    public static let startingBalance = "Starting balance"
    public static let pnlHelp = "PnL is profit and loss: what you've gained or lost so far."
    public static let realizedHelp = "Gain or loss on what you've sold or spent."
    public static let unrealizedHelp = "Gain or loss on what you still hold, at the current price."

    public static let rulesTitle = "Pricing rule"
    public static let rulesHelp = "Prices come from a public recipe anyone can copy and change. Each rule here is one version of it, named by its fingerprint. Switching only changes which one this wallet is read through."

    /// A dataset version's fingerprint, short enough to read and long enough to recognize.
    public static func shortManifestHash(_ hash: String) -> String {
        "\(hash.prefix(12))…\(hash.suffix(4))"
    }

    /// The tooltip for a title or sentence that says PnL, or nothing when it doesn't.
    public static func pnlHelp(for text: String) -> String? {
        text.contains("PnL") ? pnlHelp : nil
    }

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
        coverage(portfolio.coverage, trackedTokens: portfolio.trackedTokens, openingUnread: !portfolio.openingUnread.isEmpty)
    }

    static func coverage(_ span: Coverage, trackedTokens: Int, openingUnread: Bool) -> String {
        let opening = openingUnread
            ? "What the wallet held before that couldn't all be read yet, so some amounts may not be full balances."
            : "What the wallet held before that is included, at an unknown cost."
        return "Covers about \(Format.duration(blocks: span.toBlock - span.fromBlock)) of history and \(trackedTokens) tokens plus ETH. \(opening) Other tokens aren't counted."
    }

    public static func feesUnknown(_ count: Int) -> String {
        "Network fees couldn't be worked out for \(count) \(count == 1 ? "transaction" : "transactions"), so the network fees shown are too low."
    }

    public static func networkFeeUnknown(_ count: Int) -> String {
        "Couldn't read the network fee of \(count) \(count == 1 ? "transaction" : "transactions") yet, so fees paid are too low, and ETH's PnL is unavailable until they're read."
    }

    public static func checkLabel(_ status: Reconciliation.Status) -> String {
        switch status {
        case .reconciled: "Matches"
        case .incomplete: "Incomplete"
        case .unchecked: "Not checked"
        }
    }

    /// What the onchain check found, or nil when there's nothing to say.
    public static func check(_ position: Position) -> String? {
        guard let check = position.reconciliation else { return nil }
        switch check.status {
        case .reconciled:
            return "Matches the actual balance exactly."
        case .unchecked:
            return "Not checked. \(check.reason ?? "") PnL is unavailable until this balance is confirmed."
        case .incomplete:
            guard let computed = check.computedQty, let actual = check.actualQty, let difference = check.differenceQty else { return nil }
            let signed = difference.hasPrefix("-") ? "" : "+"
            return "Worked out \(Format.amount(computed, decimals: position.decimals)), actual \(Format.amount(actual, decimals: position.decimals)), difference \(signed)\(Format.amount(difference, decimals: position.decimals)) \(position.asset). PnL is unavailable.\(check.unseenEth.map { " " + unseenEthCause($0) } ?? "")"
        }
    }

    /// The transactions most likely behind ETH that doesn't match. The rest of a long list are still there, as sales with no known value.
    static func unseenEthCause(_ unseen: [UnseenEth]) -> String {
        let maxNamed = 5
        let named = unseen.prefix(maxNamed).map { item in
            "\(item.txHashes.map(Format.shortHash).joined(separator: ", ")) (+\(Format.amount(item.amount, decimals: 18)) ETH)"
        }
        let more = unseen.count > named.count ? ", and \(unseen.count - named.count) more" : ""
        return "It lines up with what left this wallet in \(named.joined(separator: ", "))\(more): ETH rose by that much in the same block, with no transaction showing it."
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

    /// What's unavailable because of a missing exchange rate. Empty in USD, or with every rate there.
    public static func missingRates(_ portfolio: Portfolio) -> [String] {
        guard let exchange = portfolio.exchange else { return [] }
        let code = portfolio.currency.rawValue
        var lines: [String] = []
        let count = exchange.missingRateTxs.count
        if count > 0 {
            lines.append("\(count == 1 ? "1 transaction has" : "\(Format.block(count)) transactions have") no USD to \(code) rate, so what depends on \(count == 1 ? "it" : "them") is unavailable in \(code).")
        }
        if exchange.latestRateMicros == nil {
            lines.append("There's no current USD to \(code) rate, so what's held has no current value.")
        }
        return lines
    }

    public static let demo = "Demo data, not a real wallet. Every case the app has to get right is in here."
    public static let pnlUnavailable = "PnL unavailable"
    public static let nothingToChart = "Everything here depends on an unknown cost or price, so there's no PnL to chart. It isn't zero."
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
        case .onchain: Wording.balanceCheck.lowercased()
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
