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

    public static let holdTitle = "Compared with holding ETH"
    public static let holdWallet = "This wallet, after network fees"
    public static let holdEth = "If you'd held ETH instead"
    public static let holdPast = "Past results don't predict future ones."

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
    public static func costTag(_ label: String, source: String? = nil) -> String {
        if let source { return label == "inherited" ? "Cost: \(source), from your other wallet" : "Cost: \(source)" }
        return switch label {
        case "paid": "Cost: what you paid"
        case "inherited": "Cost: from your other wallet"
        case "received at market": "Cost: market price when received"
        case "self-reported": "Cost: what you entered"
        case "unknown": "Cost unknown"
        default: "Cost: \(label)"
        }
    }

    /// Where a bought cost comes from. Only the movement that arrived is what the order matches, and not what later moved it.
    public static func costProof(source: String, label: String) -> String {
        label == "inherited"
            ? "\(source), by your other wallet. This transaction only moved it here, so the order isn't for this one. What's shown is this amount's share of what you paid, fees included."
            : "\(source). The order says what you paid, fees included, and matches this transaction exactly."
    }

    /// What a list of movements is called, with how much of it is showing.
    public static func activityTitle(count: Int, shown: Int) -> String {
        count > shown ? "Activity (newest \(shown) of \(Format.block(count)))" : "Activity (\(Format.block(count)))"
    }

    /// How this wallet did next to holding, when the two cover the same money.
    public static func holdDifference(_ micros: String, _ currency: CurrencyCode, estimated: Bool = false) -> String {
        let isLess = micros.hasPrefix("-")
        let about = estimated ? "About " : ""
        guard isLess || isPositive(micros) else { return "\(about)\(estimated ? "the" : "The") same as holding ETH." }
        return "\(about)\(Format.money(isLess ? String(micros.dropFirst()) : micros, currency)) \(isLess ? "less" : "more") than holding ETH."
    }

    /// What keeps the two from being set against each other, or nil when nothing does.
    public static func holdCaveat(_ comparison: HoldComparison, _ currency: CurrencyCode) -> String? {
        if comparison.status == .complete { return nil }
        switch comparison.unavailable {
        case .noCurrentEthPrice: return "Unavailable, because there's no current ETH price to compare with."
        case .leftWithNoKnownValue: return "Unavailable, because something left this wallet with no known value, so what holding ETH would have left can't be worked out."
        case .leftWithNoKnownShare: return "Unavailable, because something left this wallet after an exchange of several tokens at once, so how much of it came from what was put in can't be worked out."
        case .nothingKnownPutIn: return "Unavailable, because nothing put in this wallet has a known value yet."
        case nil: break
        }
        let count = comparison.unknownAmounts
        let amounts = count == 1 ? "1 other amount has no known value, and isn't counted." : "\(Format.block(count)) other amounts have no known value, and aren't counted."
        return [
            "Partial, so the two don't cover the same money. Holding ETH counts the \(Format.money(comparison.putInMicros, currency)) put in with a known value.",
            count > 0 ? amounts : nil,
            comparison.walletLeavesOut ? "This wallet's total leaves some things out." : nil,
        ].compactMap(\.self).joined(separator: " ")
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
        return "Covers about \(Format.duration(ms: BlockTime.msBetween(span.fromBlock, span.toBlock))) of history and \(trackedTokens) tokens plus ETH. \(opening) Other tokens aren't counted."
    }

    /// What the rows no longer say one by one. nil unless every listed balance was checked and matches.
    public static func allBalancesMatch(_ portfolio: Portfolio) -> String? {
        let listed = portfolio.listedPositions
        // A balance that couldn't be read has no row, and hasn't been shown to match anything.
        return !listed.isEmpty && portfolio.unreadAssets.isEmpty && listed.allSatisfy(\.isReconciled) ? "Every balance matches the chain." : nil
    }

    /// What there is instead of a chart, so what's short isn't mistaken for nothing.
    public static func transactionsSoFar(_ count: Int) -> String {
        count == 1 ? "1 transaction so far." : "\(Format.block(count)) transactions so far."
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
        case .incomplete: "Doesn't match"
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

    /// What's missing while a dataset catches up to the chain. nil when it isn't behind, or hasn't started: there are no numbers yet, and the empty state says why.
    public static func catchingUp(_ portfolio: Portfolio) -> String? {
        if !portfolio.progress.started || portfolio.progress.behindBlocks == 0 { return nil }
        let head = portfolio.latest.blockNum
        return behind(ms: BlockTime.msBetween(head - portfolio.progress.behindBlocks, head))
    }

    /// `catchingUp` in a few words.
    public static func shortCatchingUp(_ portfolio: Portfolio) -> String? {
        if !portfolio.progress.started || portfolio.progress.behindBlocks == 0 { return nil }
        let head = portfolio.latest.blockNum
        let ms = BlockTime.msBetween(head - portfolio.progress.behindBlocks, head)
        return ms < 30_000 ? "Less than a minute behind" : "About \(Format.duration(ms: ms)) behind"
    }

    static func behind(ms: Int) -> String {
        // Under half a minute would round to "0 min", which reads as not behind at all.
        "The data is still catching up, \(ms < 30_000 ? "less than a minute" : "about \(Format.duration(ms: ms))") behind the network. Anything newer isn't in these numbers yet."
    }

    public static func stale(lastUpdate: String) -> String {
        "These numbers aren't updating. Last update: \(lastUpdate)."
    }

    /// The technical side of the status badge, for its tooltip.
    public static func feedDetail(_ mode: Mode, block: Int) -> String {
        mode == .demo ? mode.label : "\(mode.label) · block \(Format.block(block))"
    }

    /// What sits right next to a total, so it never appears bare. nil when it's exact and whole.
    public static func headlineCaveat(_ totals: Totals, _ currency: CurrencyCode) -> String? {
        var parts: [String] = []
        if isPositive(totals.unresolvedMicros) { parts.append("\(Format.money(totals.unresolvedMicros, currency)) cost unknown") }
        if isPositive(totals.estimatedMicros) { parts.append("\(Format.money(totals.estimatedMicros, currency)) estimated") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// The same, as a sentence for when there's room to say what it means. nil when it's exact and whole.
    public static func leavesOut(_ totals: Totals, _ currency: CurrencyCode) -> String? {
        var parts: [String] = []
        if isPositive(totals.unresolvedMicros) { parts.append("\(Format.money(totals.unresolvedMicros, currency)) has an unknown cost, so it isn't in the PnL.") }
        if isPositive(totals.estimatedMicros) { parts.append("\(Format.money(totals.estimatedMicros, currency)) is estimated.") }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    /// What answering takes, on the button that starts it.
    public static func answerQuestions(_ count: Int) -> String {
        count == 1 ? "Answer 1 Question" : "Answer \(Format.block(count)) Questions"
    }

    /// Why a value is partial, for its tooltip. Names the holdings, because they may not be on screen. With no cause known, it only says what's sure.
    public static func partialValue(noPrice: [String], unread: [String], unchecked: [String], incompleteHistory: [String]) -> String {
        func list(_ assets: [String]) -> String { assets.joined(separator: ", ") }
        var causes: [String] = []
        if !noPrice.isEmpty { causes.append("\(list(noPrice)) \(noPrice.count == 1 ? "has" : "have") no price right now.") }
        if !unread.isEmpty { causes.append("Couldn't read the balance of \(list(unread)).") }
        if !unchecked.isEmpty { causes.append("Couldn't check the balance of \(list(unchecked)).") }
        if !incompleteHistory.isEmpty { causes.append("Incomplete history for \(list(incompleteHistory)).") }
        return causes.isEmpty ? "This value isn't complete." : causes.joined(separator: " ")
    }

    /// `leavesOut` in a few words. The biggest thing it leaves out, because the rest is a click away.
    public static func shortLeavesOut(_ totals: Totals, _ currency: CurrencyCode) -> String? {
        if isPositive(totals.unresolvedMicros) { return "\(Format.money(totals.unresolvedMicros, currency)) has an unknown cost" }
        if isPositive(totals.estimatedMicros) { return "\(Format.money(totals.estimatedMicros, currency)) is estimated" }
        return nil
    }

    /// What isn't listed with the holdings, and why it doesn't matter to the numbers. nil when there's nothing.
    public static func noMarket(_ portfolio: Portfolio) -> String? {
        let listed = portfolio.noMarketPositions.map(\.asset)
        let total = listed.count + portfolio.unlisted.count
        if total == 0 { return nil }
        let off = portfolio.unlisted.isEmpty ? "" : "\(listed.isEmpty ? "" : ", plus ")\(portfolio.unlisted.count) we don't track"
        return "\(total) \(total == 1 ? "token" : "tokens") with no market: \(listed.joined(separator: ", "))\(off). Often spam, and not counted in any total."
    }

    /// What a wallet signs to prove it's this user's. The server checks the signature against the same words.
    public static func linkMessage(owner: String, address: String) -> String {
        "Patina: \(address.lowercased()) is my wallet, and belongs with \(owner.lowercased()).\n\nThis only links them in my own app. It can't move funds or approve anything."
    }

    public static func linkedFailed(_ count: Int) -> String {
        count == 1 ? "Couldn't read your other wallet, so what came from it may show an unknown cost." : "Couldn't read \(count) of your other wallets, so what came from them may show an unknown cost."
    }

    /// A wallet's history that doesn't add up, or can't be checked, and what that does to what it sent.
    public static func withheld(wallet: String, asset: String) -> String {
        "\(Format.shortHash(wallet))'s \(asset) history can't be confirmed, so what it sent has an unknown cost where it arrived."
    }

    /// A preview's headline, as it would read.
    public static func consequence(_ preview: BookPreview, _ currency: CurrencyCode) -> String {
        if preview.failed { return "Couldn't read that wallet" }
        if preview.pending { return "Reading that wallet…" }
        guard let pnl = preview.pnlMicros else { return "PnL still unavailable" }
        let number = Format.estimate(Format.signedMoney(pnl, currency), isPositive(preview.estimatedMicros))
        return isPositive(preview.unresolvedMicros) ? "\(number) · \(Format.money(preview.unresolvedMicros, currency)) cost unknown" : number
    }

    public static let notStarted = "Numbers appear once the data reaches this wallet."
    public static let unpricedFees = "Some network fees had no price at the time, and aren't in this total."

    /// Balances with no row, because nothing could be read about them. nil when there are none.
    public static func unreadBalances(_ assets: [String]) -> String? {
        assets.isEmpty ? nil : "Couldn't read the \(assets.joined(separator: ", ")) \(assets.count == 1 ? "balance" : "balances")."
    }

    /// The comparison in a few words, for the line that opens the whole of it.
    public static func holdSummary(_ comparison: HoldComparison, _ currency: CurrencyCode) -> String {
        switch comparison.status {
        case .unavailable: return "Not available yet"
        case .partial: return "Not comparable yet"
        case .complete:
            guard let difference = comparison.differenceMicros else { return "Not available yet" }
            return holdDifference(difference, currency, estimated: comparison.walletEstimated || comparison.estimated)
        }
    }

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

    public static let demo = "Demo data, not a real wallet."
    public static let pnlUnavailable = "PnL unavailable"
    public static let unknown = "Unknown"
    public static let nothingToChart = "Everything here depends on an unknown cost or price, so there's no PnL to chart. It isn't zero."
    public static let tooNewToChart = "Not enough history for a chart yet."
    public static let reading = "Reading this wallet. The first read can take a minute."
    public static let readTooSlow = "The server is answering, but this wallet is taking too long to read."
    public static let serverTooSlow = "The server took too long to answer."
    public static let notAnAddress = "That isn't a Base address. It should start with 0x, then 40 letters and numbers."
    public static let addressHasATypo = "That address has a typo in it. Check it, or paste it again."
    public static let addressIsShortened = "That's a shortened address. Paste the whole thing."
    public static let addressWithExtras = "Paste just the address, with nothing around it."
    public static let notASignature = "That isn't a signature. It should start with 0x, then 130 letters and numbers."
    public static let wrongSignature = "That signature isn't from this wallet."
    public static let couldntCheckSignature = "Couldn't check it. Is the server running?"
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

    /// The same, on its own, as in a menu.
    public var title: String {
        label.prefix(1).uppercased() + label.dropFirst()
    }

    public var help: String? {
        switch self {
        case .realized: Wording.realizedHelp
        case .unrealized: Wording.unrealizedHelp
        default: nil
        }
    }
}
