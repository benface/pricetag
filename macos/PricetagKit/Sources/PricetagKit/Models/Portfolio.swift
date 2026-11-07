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

/// See `Method` in `packages/sdk/src/fold.ts`. Newest first and highest cost first are only for a tax report where they're allowed.
public enum CostMethod: String, Codable, Sendable, CaseIterable, Identifiable {
    case average, fifo, lifo, hifo

    /// What the portfolio offers. The others only reward picking what to sell, so they stay in the tax report.
    public static let portfolio: [CostMethod] = [.average, .fifo]

    public var id: Self { self }
    public var label: String {
        switch self {
        case .average: "Average"
        case .fifo: "Oldest first"
        case .lifo: "Newest first"
        case .hifo: "Highest cost first"
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
    /// How much of the cost of what's held is an estimate.
    public let estimatedCostMicros: String
    /// How much of what `realizedMicros` comes from is an estimate.
    public let estimatedRealizedMicros: String
}

/// Which of a position's numbers rest on an estimate, so they can look different from exact ones.
public struct Estimates: Codable, Sendable, Equatable {
    public let cost: Bool
    public let value: Bool
    public let realized: Bool
    public let unrealized: Bool
}

/// ETH that arrived in a block with no transaction showing it, and the ones that took a token from this wallet there.
public struct UnseenEth: Codable, Sendable, Equatable {
    public let blockNum: Int
    public let amount: String
    public let txHashes: [String]
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
    /// How much of what the legs add up to has no transaction behind it, only a balance that rose. A match doesn't confirm this amount.
    public let unrecordedQty: String?
    /// On ETH that doesn't match: the transactions most likely behind it.
    public let unseenEth: [UnseenEth]?
    /// On a balance that couldn't be checked: whether what's shown is still what the chain last said it holds. Without this, its value is only a best estimate.
    public let heldIsCurrent: Bool?
}

public struct Position: Codable, Sendable, Equatable, Identifiable {
    public let asset: String
    public let decimals: Int
    public let note: String?
    public let price: LatestPrice?
    public let values: PositionValues
    public let pnlMicros: String?
    /// Unrealized over the cost of what's held, in basis points. nil when either is unknown, or it cost nothing. Never 0 for unknown.
    public let returnBps: String?
    public let shortfallQty: String
    public let legCount: Int
    public let reconciliation: Reconciliation?
    /// No price, in any form, at any block. Often spam. It's listed apart, and can't affect PnL.
    public let noMarket: Bool
    public let estimates: Estimates
    /// Its cost is unknown, and answering a question could change that.
    public let resolvable: Bool
    /// Each wallet's share, when several are shown as one.
    public var wallets: [PositionPart]? = nil

    public var id: String { asset }
    public var isHeld: Bool { isPositive(values.qty) }
    public var hasShortfall: Bool { isPositive(shortfallQty) }
    public var hasUnknownCost: Bool { isPositive(values.unknownCostQty) }

    /// What can be opened for this position, in the holdings table's order.
    public var explainableMetrics: [AssetMetric] {
        AssetMetric.tableOrder.filter { metric in
            switch metric {
            // A missing price has its reason in the details too.
            case .amount, .realized, .price: true
            case .average, .value, .unrealized, .return: isHeld
            case .onchain: reconciliation != nil || hasShortfall
            }
        }
    }
    public var isReconciled: Bool { reconciliation?.status == .reconciled }
    public var isIncomplete: Bool { reconciliation?.status == .incomplete }
}

/// One wallet's share of a holding shown across several, so an unknown can say where it is.
public struct PositionPart: Codable, Sendable, Equatable, Identifiable {
    public let wallet: String
    public let qty: String
    public let unknownCostQty: String
    public let costMicros: String?
    public let valueMicros: String?
    public let pnlMicros: String?
    public let resolvable: Bool
    public let reconciliation: Reconciliation.Status?

    public var id: String { wallet }
    public var isHeld: Bool { isPositive(qty) }
    public var hasUnknownCost: Bool { isPositive(unknownCostQty) }
}

/// How far one wallet's read has got, when several are shown as one.
public struct CombinedWallet: Codable, Sendable, Equatable {
    public enum State: String, Codable, Sendable {
        case read, reading, failed
        /// In the numbers as it was last read, while it's read again, or because its latest read failed.
        case updating, outdated
    }

    public let address: String
    public let state: State
}

public struct Exclusion: Codable, Sendable, Equatable {
    public let asset: String
    public let reason: String
    /// Which of the user's wallets it's in, when several are shown as one.
    public var wallet: String? = nil
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
    /// What's held with an unknown cost, at today's price. It's not in any PnL.
    public let unresolvedMicros: String
    /// How much of what these sums are made of is an estimate.
    public let estimatedMicros: String
    public let estimated: TotalEstimates
    /// Assets with no market, which aren't in any of this.
    public let noMarket: [String]
}

public struct TotalEstimates: Codable, Sendable, Equatable {
    public let value: Bool
    public let realized: Bool
    public let unrealized: Bool
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
    @ParsedTimestamp public var timestamp: String
    public let txHash: String?
    /// nil when nothing is known at this point, which isn't $0.
    public let pnlMicros: String?
    public let excludedCount: Int
    /// What its transaction did, in words. The last point has no transaction, and nor do the ones that only read prices between transactions.
    public var summary: String? = nil
    /// What was held right after it, at that moment's prices. Only what's known, and nil when nothing is, which isn't $0.
    public var valueMicros: String? = nil
    /// What was held right before it, at the same prices, so a deposit is a jump. nil when it leaves out other things than `valueMicros`.
    public var valueBeforeMicros: String? = nil
    /// What `valueMicros` leaves out.
    public var valueExcludedCount: Int? = nil
    /// Only prices moved since the point before: what's held is the same, and so is what's left out. Otherwise there's nothing to join it to.
    public var valueContinues: Bool? = nil
    /// Prices were read as often as a chart can show all the way from the point before, so what's between them is known and not a guess.
    public var valueRead: Bool? = nil
    /// What moved, apart from network fees. The rest of these are empty or nil on the last point, which has no transaction.
    public var assets: [String] = []
    /// The one address on the other side, or nil when there's none or more than one.
    public var counterparty: String? = nil
    public var amount: TransactionAmount? = nil
    /// nil when nothing was sold.
    public var gain: TransactionGain? = nil
    /// What arrived with a cost nobody can work out yet.
    public var unknownCost: [String] = []
    /// Those an answer could work out, which isn't all of them. nil from a server that doesn't say yet, which deploys apart from the app.
    public var answerableCost: [String]? = nil
    /// Which of the user's wallets its transaction is in, when several are shown as one.
    public var wallets: [String]? = nil
    /// `valueMicros` was worked out for where a chart's range starts, between prices that were read, so it's never from a server.
    var valueEstimated = false

    public var id: String { "\(blockNum):\(txHash ?? "latest")" }
    public var date: Date? { _timestamp.date }
}

extension PnlPoint {
    /// Everything but `valueEstimated`, which never comes from a server.
    private enum CodingKeys: String, CodingKey {
        case blockNum, timestamp, txHash, pnlMicros, excludedCount, summary, valueMicros, valueBeforeMicros, valueExcludedCount, valueContinues, valueRead, assets, counterparty, amount, gain, unknownCost, answerableCost, wallets
    }
}

/// A server's timestamp, with its date worked out once. A chart reads the date of every point each time it draws.
@propertyWrapper
public struct ParsedTimestamp: Codable, Sendable, Equatable {
    public let wrappedValue: String
    let date: Date?

    public init(wrappedValue: String) {
        self.wrappedValue = wrappedValue
        date = parseTimestamp(wrappedValue)
    }

    public init(from decoder: any Decoder) throws {
        try self.init(wrappedValue: decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(wrappedValue)
    }
}

/// What a transaction moved, in the portfolio's currency.
public struct TransactionAmount: Codable, Sendable, Equatable {
    public enum Direction: String, Codable, Sendable {
        /// Something only arrived, or only left.
        case `in`, out
        /// Things went both ways.
        case trade
        /// Only a network fee was paid.
        case fee
    }

    public let direction: Direction
    /// nil when part of it has no price, which isn't $0.
    public let micros: String?

    public init(direction: Direction, micros: String?) {
        self.direction = direction
        self.micros = micros
    }
}

/// The gain or loss a sale in a transaction realized.
public struct TransactionGain: Codable, Sendable, Equatable {
    /// nil when what was sold has an unknown cost or price.
    public let micros: String?
    public let estimated: Bool

    public init(micros: String?, estimated: Bool) {
        self.micros = micros
        self.estimated = estimated
    }
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

/// A token off the allowlist that a wallet holds, with what the chain says about it. It's only for showing: it's in no total, and nothing here ever moves it.
/// Its name and symbol are whatever its contract claims, already cleaned up by the server, so always show them as plain text with the address.
public struct OtherToken: Codable, Sendable, Equatable, Identifiable {
    public enum Kind: String, Codable, Sendable { case token, collectible }
    public enum State: String, Codable, Sendable { case reading, read, unreadable }

    public let token: String
    public let kind: Kind
    public let name: String?
    public let symbol: String?
    /// nil when the contract gave no usable answer, so `balance` is in its smallest unit.
    public let decimals: Int?
    /// nil while it's being read, or when it can't be. Never 0 for that.
    public let balance: String?
    public let state: State
    /// What's wrong with it, in words.
    public let note: String?
    /// Why it's tucked away as possible spam, in words, or nil when it's shown with the rest. It doesn't mean it's worthless.
    public let tucked: String?

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

/// What a wallet made next to what simply holding ETH would have. The server works it out, like every other number.
public struct HoldComparison: Codable, Sendable, Equatable {
    public enum Status: String, Codable, Sendable {
        /// The two cover the same money, so they can be set against each other.
        case complete
        /// Each is true of what it covers, but they don't cover the same money, so there's no difference to show.
        case partial
        /// What holding would have made can't be worked out.
        case unavailable
    }

    public enum Unavailable: String, Codable, Sendable {
        case noCurrentEthPrice = "no current eth price"
        case nothingKnownPutIn = "nothing known put in"
        case leftWithNoKnownValue = "left with no known value"
        case leftWithNoKnownShare = "left with no known share"
    }

    public let status: Status
    public let unavailable: Unavailable?
    /// The wallet's total PnL after network fees, plus any gain that left with what it sent. nil when nothing in it is known.
    public let walletMicros: String?
    public let walletLeavesOut: Bool
    /// `walletMicros` rests on a market price.
    public let walletEstimated: Bool
    /// nil when it's unavailable. That isn't $0.
    public let holdMicros: String?
    /// Only when complete.
    public let differenceMicros: String?
    /// What's known to have been put in. An amount with no known value isn't in it, and isn't counted as $0.
    public let putInMicros: String
    /// Movements in with no known value. Never counted as $0.
    public let unknownAmounts: Int
    public let estimated: Bool
}

/// Something about each of the lists in a reply that can be too long to send every time.
struct LongLists<Value: Codable & Sendable & Equatable>: Codable, Sendable, Equatable {
    var points: Value? = nil
    var outgoingTxs: Value? = nil
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
    public internal(set) var outgoingTxs: [String]
    public let unlisted: [UnlistedToken]
    /// nil in a portfolio saved before these existed.
    public let otherTokens: [OtherToken]?
    public let otherTokensLeftOut: Int?
    public let l1FeeUnknownTxs: [String]
    /// Assets whose balance before the first block couldn't be read yet.
    public let openingUnread: [String]
    /// Assets with no position because nothing could be read about them, which isn't the same as holding none.
    public let unreadAssets: [String]
    public let positions: [Position]
    public let totals: Totals
    public let pnlStatus: PnlStatus
    public internal(set) var points: [PnlPoint]
    public let holdComparison: HoldComparison
    /// What's left to ask, most useful first.
    public let questions: [Question]
    public let meter: Meter
    /// Linked wallets that aren't read yet, so what came from them shows as unresolved for now.
    public internal(set) var linkedReading: [String]
    /// Linked wallets whose last read failed. It's tried again with each read, and what they sent stays unresolved or out of date until it works.
    public internal(set) var linkedFailed: [String]
    /// Other wallets' history that can't be confirmed, which leaves what they sent here with an unknown cost.
    public let withheld: [WithheldCost]
    /// What became of each purchase in the book, among the wallets read.
    public let purchases: [PurchaseMatch]?
    /// Every wallet in it and how far each one's read has got, when it's all of the user's wallets as one.
    public var wallets: [CombinedWallet]? = nil
    /// All Yours' wallets being read again, whose last read is what's in the numbers.
    public var linkedUpdating: [String]? = nil
    /// All Yours' wallets whose latest read failed, whose last good read is what's in the numbers.
    public var linkedOutdated: [String]? = nil
    /// What to tell the server this already has, so a busy wallet's next reply leaves it out.
    var marks: LongLists<String>? = nil
    /// How much of each list the server left out, which `PricetagClient` puts back before anything else sees it.
    var kept: LongLists<Int>? = nil

    /// All of the user's wallets as one, rather than one wallet.
    public var isAllYours: Bool { WalletAddress.isAllYours(address) }

    /// All Yours' wallets whose reads are in the numbers, however old those reads are.
    var walletsInNumbers: [String]? { wallets?.filter { $0.state != .reading && $0.state != .failed }.map(\.address) }

    /// What to show after this answer, given that `last` is on screen. The server keeps the last answer too, but it can run out of room for it.
    /// So when a wallet that's in `last` isn't in this one, `last` stands, whole and at its one block so a move can't count twice, with that wallet updating or outdated.
    func holding(_ last: Portfolio) -> Portfolio {
        guard isAllYours, last.isAllYours, last.method == method, last.currency == currency, last.rule == rule, let asked = wallets, let kept = last.walletsInNumbers else { return self }
        let states = Dictionary(asked.map { ($0.address, $0.state) }, uniquingKeysWith: { first, _ in first })
        guard kept.allSatisfy({ states[$0] != nil }), kept.contains(where: { states[$0] == .reading || states[$0] == .failed }) else { return self }
        let wallets = kept.map { address in
            switch states[address] {
            case .failed, .outdated: CombinedWallet(address: address, state: .outdated)
            case .reading, .updating: CombinedWallet(address: address, state: .updating)
            default: CombinedWallet(address: address, state: .read)
            }
        } + asked.filter { !kept.contains($0.address) }.map { CombinedWallet(address: $0.address, state: $0.state == .failed ? .failed : .reading) }
        let inState = { (state: CombinedWallet.State) in wallets.filter { $0.state == state }.map(\.address) }
        var held = last
        held.wallets = wallets
        held.linkedReading = inState(.reading)
        held.linkedFailed = inState(.failed)
        held.linkedUpdating = inState(.updating)
        held.linkedOutdated = inState(.outdated)
        return held
    }

    /// What the holdings table lists. Tokens with no market go in a group of their own, so real warnings stay noticeable.
    public var listedPositions: [Position] { positions.filter { !$0.noMarket } }
    public var noMarketPositions: [Position] { positions.filter(\.noMarket) }

    /// Other tokens to show with the holdings, and those tucked away as possible spam.
    public var shownOtherTokens: [OtherToken] { (otherTokens ?? []).filter { $0.tucked == nil } }
    public var tuckedOtherTokens: [OtherToken] { (otherTokens ?? []).filter { $0.tucked != nil } }
    /// Whether there's anything to say about other tokens, including how many weren't read.
    public var hasOtherTokens: Bool { !(otherTokens ?? []).isEmpty || (otherTokensLeftOut ?? 0) > 0 }
    /// Nothing here has a price to add up, so there are no numbers to show, and adding up nothing would say $0.
    public var holdsOnlyOtherTokens: Bool { positions.isEmpty && unreadAssets.isEmpty && hasOtherTokens }

    /// What a glance lists: what's held, most valuable first. One with no price can't be ranked, so it goes last, and it isn't treated as worth nothing.
    public func largestHoldings(_ limit: Int) -> [Position] {
        Array(listedPositions.filter(\.isHeld).sorted(using: HoldingsSort.largestFirst).prefix(limit))
    }

    /// Nothing moved in the blocks read, which says nothing about what this wallet made or lost.
    /// A balance that couldn't be read doesn't count as nothing.
    public var isEmpty: Bool { positions.isEmpty && unreadAssets.isEmpty && !hasOtherTokens }
    public var hasChartableData: Bool { hasChartableData(.pnl) }
    public var isTooNewToChart: Bool { isTooNewToChart(.pnl) }

    public func hasChartableData(_ metric: ChartMetric) -> Bool { points.contains { metric.micros($0) != nil } }
    /// A line says nothing with a transaction or two, or across a few minutes: it's an empty box with a flat line in it.
    public func isTooNewToChart(_ metric: ChartMetric) -> Bool {
        let known = points.filter { $0.txHash != nil && metric.micros($0) != nil }.compactMap(\.date)
        guard known.count >= 3, let first = known.min(), let last = known.max() else { return true }
        return last.timeIntervalSince(first) < 5 * 60
    }
    /// There's a chart to show, and not a placeholder.
    public func canChart(_ metric: ChartMetric) -> Bool { hasChartableData(metric) && !isTooNewToChart(metric) }
    /// Every point with a transaction behind it, newest first.
    public var transactions: [PnlPoint] { points.filter { $0.txHash != nil }.reversed() }
}

func isPositive(_ units: String) -> Bool {
    !units.hasPrefix("-") && units.contains { $0 != "0" }
}

func parseTimestamp(_ value: String) -> Date? {
    try? Date(value, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))
}
