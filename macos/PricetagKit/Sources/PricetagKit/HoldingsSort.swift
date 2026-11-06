import Foundation

/// The order the holdings are listed in, by one column. The web app has the same rules in `src/core/holdings.ts`.
/// A row with no number in that column goes last whichever way it's sorted, because it can't be ranked, and it's never treated as zero.
public struct HoldingsSort: SortComparator, Hashable, Sendable, RawRepresentable {
    public enum Column: String, CaseIterable, Sendable {
        case asset, amount, average, price, value, `return`, realized, unrealized
    }

    public var column: Column
    public var order: SortOrder

    /// Numbers start with the largest, and names with A.
    public init(_ column: Column) {
        self.column = column
        order = column == .asset ? .forward : .reverse
    }

    /// Largest first, the same as the menu bar's list.
    public static let largestFirst = HoldingsSort(.value)

    public init?(rawValue: String) {
        let parts = rawValue.split(separator: ":").map(String.init)
        guard parts.count == 2, let column = Column(rawValue: parts[0]), parts[1] == "asc" || parts[1] == "desc" else { return nil }
        self.column = column
        order = parts[1] == "desc" ? .reverse : .forward
    }

    public var rawValue: String { "\(column.rawValue):\(order == .reverse ? "desc" : "asc")" }

    public func compare(_ a: Position, _ b: Position) -> ComparisonResult {
        let flip = { (result: ComparisonResult) in order == .forward ? result : result.reversed }
        if column == .asset { return flip(a.asset.localizedStandardCompare(b.asset)) }
        switch (key(a), key(b)) {
        case let (x?, y?) where x != y: return flip(x < y ? .orderedAscending : .orderedDescending)
        case (_?, nil): return .orderedAscending
        case (nil, _?): return .orderedDescending
        default: return tie(a, b)
        }
    }

    /// What's held first, then by name.
    private func tie(_ a: Position, _ b: Position) -> ComparisonResult {
        if a.isHeld != b.isHeld { return a.isHeld ? .orderedAscending : .orderedDescending }
        return a.asset.localizedStandardCompare(b.asset)
    }

    /// What the column shows as a number, or nil when it shows none: an unknown, no price, or a dash for what isn't held.
    private func key(_ position: Position) -> Decimal? {
        let values = position.values
        let number = { (text: String?) in text.flatMap { Decimal(string: $0) } }
        let held = { (text: String?) in position.isHeld ? number(text) : nil }
        switch column {
        case .asset: return nil
        // As whole tokens, whatever each token's decimals.
        case .amount: return number(values.qty).map { $0 / pow(10, position.decimals) }
        case .price: return number(position.price?.micros)
        case .realized: return number(values.realizedMicros)
        case .average: return held(values.averageCostMicros)
        case .value: return held(values.valueMicros)
        case .return: return held(position.returnBps)
        case .unrealized: return held(values.unrealizedMicros)
        }
    }
}

private extension ComparisonResult {
    var reversed: ComparisonResult {
        switch self {
        case .orderedAscending: .orderedDescending
        case .orderedDescending: .orderedAscending
        case .orderedSame: .orderedSame
        }
    }
}
